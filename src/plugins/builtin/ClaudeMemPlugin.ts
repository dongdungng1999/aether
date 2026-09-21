/**
 * ClaudeMemPlugin — bridges extension chat turns to the claude-mem
 * worker running inside the user's aura proxy container.
 *
 * Why this exists:
 *   The proxy container already runs a claude-mem worker (port 37700,
 *   isolated from the host) that owns ~/.claude-mem/claude-mem.db. The
 *   CLI side wires Claude Code's hook system to that worker via
 *   docker-exec. The extension has no hook system — it streams turns
 *   itself — so we replicate the contract here: after every assistant
 *   turn we send the worker a Stop-style payload, pointing it at a
 *   transcript file it can read.
 *
 * Transcript shape:
 *   The worker expects Claude-Code-style JSONL where each line is one
 *   of {type:"user"|"assistant", sessionId, message:{role, content}}.
 *   The extension's own JSONL uses {ts, role, content} — same content
 *   shape, different envelope. We materialize a converted copy under
 *   .claude-mem-transcripts/ next to chat-sessions/ on each fire so the
 *   worker sees a format it understands without touching its source.
 *
 * Routing:
 *   The container entrypoint sets ANTHROPIC_BASE_URL to its local
 *   aura_proxy, so worker → model calls ride on the Renesas JWT, not
 *   api.anthropic.com. This plugin doesn't have to do anything to make
 *   that happen — running the worker inside the container is enough.
 *
 * Failure isolation:
 *   docker / docker-exec failures, missing container, malformed
 *   transcripts — all logged and swallowed. Chat UX must not regress
 *   when memory generation hiccups.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { ChatPlugin, AfterAssistantTurnContext } from '../types';
import { ChatStore, PersistedMessage } from '../../chat/ChatStore';
import { ContainerLifecycle } from '../../container/ContainerLifecycle';
import { Logger } from '../../utils/logger';

export interface ClaudeMemDispatchResult {
  ok: boolean;
  namespace: string;
  error?: string;
}

export interface ClaudeMemPluginDeps {
  lifecycle: ContainerLifecycle;
  /** Where we materialize converted JSONL copies. Defaults to a sibling
   *  of chat-sessions/ inside dataRoot. */
  transcriptDir: string;
  /** Resolver for the host.yaml namespace string (e.g. "aura-ext"). The
   *  worker derives observations.project from the basename of `cwd` we
   *  send, so this string drives DB tagging for every extension chat. */
  getNamespace: () => Promise<string>;
  /** 0.4.104 — hook called once per turn with the dispatch outcome so
   *  ChatPanelV2 can broadcast a `memory.observation` message to the
   *  webview. Fire-and-forget; errors ignored. */
  onResult?: (chatId: string, r: ClaudeMemDispatchResult, stopReason: string, turnId: number) => void;
}

export function createClaudeMemPlugin(deps: ClaudeMemPluginDeps): ChatPlugin {
  return {
    name: 'claude-mem',
    events: ['afterAssistantTurn'],
    async handle(ctx) {
      if (ctx.event !== 'afterAssistantTurn') return;
      await onAfterAssistantTurn(ctx, deps);
    },
  };
}

async function onAfterAssistantTurn(
  ctx: AfterAssistantTurnContext,
  deps: ClaudeMemPluginDeps,
): Promise<void> {
  const namespace = (await deps.getNamespace().catch(() => 'aura-ext')) || 'aura-ext';
  const emit = (r: ClaudeMemDispatchResult) => {
    try { deps.onResult?.(ctx.chatId, r, ctx.stopReason, ctx.turnId); } catch { /* ignore */ }
  };

  const container = await resolveProxyContainer(deps.lifecycle, ctx.log);
  if (!container) {
    emit({ ok: false, namespace, error: 'proxy container not running' });
    return;
  }

  const transcriptPath = await materializeTranscript(ctx, deps.transcriptDir);
  if (!transcriptPath) {
    emit({ ok: false, namespace, error: 'transcript materialize failed' });
    return;
  }

  // 0.4.67 — scope every extension observation under a single namespace
  // so search results don't bleed in/out of unrelated CLI projects. The
  // worker uses basename(cwd) as `observations.project`, so we hand it
  // a virtual path whose last segment is the namespace from host.yaml.
  const payload = JSON.stringify({
    hook_event_name: 'Stop',
    session_id:      ctx.chatId,
    transcript_path: transcriptPath,
    cwd:             `/${namespace}`,
  });

  // 0.4.105 — the CLI hook path (`bun worker-service.cjs hook … summarize`)
  // routes internally to POST /api/sessions/summarize, whose body schema
  // does NOT include `cwd`. That means the worker creates the sdk_sessions
  // row with project='' regardless of our virtual cwd — every extension
  // turn lands under an empty namespace and the memory-card poll can't
  // find its observations. Fix it by explicitly calling /api/sessions/init
  // with project=<namespace> FIRST; the init handler upserts project on
  // the existing row (only when project IS NULL OR ''), so it composes
  // safely with a session that summarize creates.
  await initSessionProject(container, ctx.chatId, namespace, ctx.log);

  const dispatch = await dispatchToWorker(container, payload, ctx.log);

  // 0.4.121 — the worker's /api/sessions/summarize handler calls
  // createSDKSession(contentSessionId, "", ...) which INSERTs a fresh
  // sdk_sessions row with project='' every time (its schema doesn't accept
  // `project`). That row ends up owning the generated summary/observation,
  // so despite our earlier /api/sessions/init(project=aura-ext) call the
  // memory-card query finds project='' and the UI reports 0 observations
  // for aura-ext. Backfill immediately after summarize: UPDATE any row
  // for this content_session_id whose project is empty. Best-effort,
  // errors swallowed. Runs via docker-exec python3 (sqlite3 CLI is not
  // bundled in the proxy image; python3 with the stdlib module is).
  await backfillProjectTag(container, ctx.chatId, namespace, ctx.log);

  emit({ ok: dispatch.ok, namespace, error: dispatch.error });
}

/** Post-summarize sqlite fixup — the worker's summarize handler creates
 *  an sdk_sessions row with project='' every time; we UPDATE that row plus
 *  any observations/summaries hanging off its memory_session_id so the
 *  webview's memory-card query (which filters by project=aura-ext) can
 *  see them. WAL mode makes this safe to run alongside the worker. */
async function backfillProjectTag(
  container: string,
  chatId:    string,
  namespace: string,
  log:       Logger,
): Promise<void> {
  const py = [
    'import sqlite3, sys, os, glob',
    'ns, sid = sys.argv[1], sys.argv[2]',
    'cands = ["/mnt/claude-mem/claude-mem.db"]',
    'cands += glob.glob("/home/*/.claude-mem/claude-mem.db")',
    'cands += glob.glob("/root/.claude-mem/claude-mem.db")',
    'db = next((p for p in cands if os.path.exists(p)), None)',
    'if not db:',
    '    print("no db", file=sys.stderr); sys.exit(2)',
    'con = sqlite3.connect(db, timeout=5)',
    'c = con.cursor()',
    // 0.4.185 — was: SELECT memory_session_id only when the sdk_sessions
    // row's project is NULL or ''. But the init call at /api/sessions/init
    // already stamped the row with project='aura-ext' BEFORE summarize ran,
    // so this filter dropped the row → mids came back empty → summaries
    // written by the worker's summarize handler stayed at project=''
    // forever. The webview then filters `/api/summaries?project=aura-ext`
    // and finds nothing → memcard spins on "Generating…" indefinitely.
    // Fix: pull every memory_session_id for this content_session and let
    // the per-table UPDATEs below skip rows whose project is already good.
    'mids = [r[0] for r in c.execute(',
    '  "SELECT memory_session_id FROM sdk_sessions WHERE content_session_id=?",',
    '  (sid,))]',
    // Only backfill `project`. Do NOT touch platform_source — the table
    // has a UNIQUE(platform_source, content_session_id) index and a
    // separate row with the same content_session_id + platform_source=ns
    // may already exist (from the init call), which would violate it.
    'c.execute(',
    '  "UPDATE sdk_sessions SET project=? WHERE content_session_id=? AND (project IS NULL OR project=\\"\\")",',
    '  (ns, sid))',
    'for m in mids:',
    '    if not m: continue',
    '    c.execute("UPDATE observations SET project=? WHERE memory_session_id=? AND (project IS NULL OR project=\\"\\")", (ns, m))',
    '    c.execute("UPDATE session_summaries SET project=? WHERE memory_session_id=? AND (project IS NULL OR project=\\"\\")", (ns, m))',
    'con.commit()',
    'con.close()',
  ].join('\n');
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (warn?: string) => {
      if (settled) return;
      settled = true;
      if (warn) log.warn(`[claude-mem] backfill-project: ${warn}`);
      resolve();
    };
    const proc = spawn('docker', [
      'exec', '-u', 'root', '-i', container,
      'python3', '-c', py, namespace, chatId,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('error', e => finish(`spawn: ${e.message}`));
    proc.on('close', code => finish(code === 0 ? undefined : `python3 exited ${code}`));
    setTimeout(() => {
      if (!settled) { try { proc.kill('SIGTERM'); } catch { /* ignore */ } finish('backfill timed out'); }
    }, 8_000);
  });
}

/** POST /api/sessions/init inside the container via docker-exec curl so
 *  the worker tags the session's project = <namespace>. Any curl failure
 *  is swallowed — it's a best-effort tag, summarize still fires. */
async function initSessionProject(
  container: string,
  chatId:    string,
  namespace: string,
  log:       Logger,
): Promise<void> {
  const body = JSON.stringify({
    contentSessionId: chatId,
    project:          namespace,
    platformSource:   'aura-ext',
    prompt:           '[aura-ext turn]',
  });
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (warn?: string) => {
      if (settled) return;
      settled = true;
      if (warn) log.warn(`[claude-mem] init-project: ${warn}`);
      resolve();
    };
    const proc = spawn('docker', [
      'exec', '-i', container,
      'sh', '-c', [
        'port=${CLAUDE_MEM_WORKER_PORT:-37700}',
        'exec curl -sS --max-time 5 -X POST -H "Content-Type: application/json" --data-binary @- "http://127.0.0.1:${port}/api/sessions/init"',
      ].join('; '),
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.on('error', e => finish(`curl error: ${e.message}`));
    proc.on('close', code => finish(code === 0 ? undefined : `curl exited ${code}`));
    setTimeout(() => finish('init-project timed out'), 6_000);
    try { proc.stdin.write(body); proc.stdin.end(); }
    catch (e) { finish(`stdin: ${(e as Error).message}`); }
  });
}

async function resolveProxyContainer(
  lifecycle: ContainerLifecycle,
  log: Logger,
): Promise<string> {
  try {
    const containers = await lifecycle.listContainers();
    const own = containers.find(c => c.service === 'proxy' && c.owned);
    return own?.name ?? '';
  } catch (e) {
    log.warn(`[claude-mem] container resolve: ${(e as Error).message}`);
    return '';
  }
}

/** Rewrite the extension's per-chat JSONL files into a single
 *  claude-code-shaped transcript the worker can ingest. We always
 *  overwrite the destination so successive turns see the up-to-date
 *  transcript (worker re-reads the whole file each Stop event). */
async function materializeTranscript(
  ctx: AfterAssistantTurnContext,
  transcriptDir: string,
): Promise<string> {
  try { await fs.mkdir(transcriptDir, { recursive: true }); } catch { /* ignore */ }
  const dst = path.join(transcriptDir, `${ctx.chatId}.jsonl`);

  const msgs: PersistedMessage[] = [];
  for (const file of ctx.transcriptFiles) {
    msgs.push(...(await ChatStore.load(file)));
  }
  if (!msgs.length) return '';

  const lines = msgs.map(m => JSON.stringify(toClaudeCodeShape(m, ctx.chatId)));
  try {
    await fs.writeFile(dst, lines.join('\n') + '\n', 'utf8');
  } catch (e) {
    ctx.log.warn(`[claude-mem] materialize ${dst}: ${(e as Error).message}`);
    return '';
  }
  return dst;
}

/** Translate extension PersistedMessage → claude-code transcript line.
 *  Content shape is preserved verbatim because claude-mem already
 *  accepts both `string` and Anthropic ContentBlock arrays. */
function toClaudeCodeShape(m: PersistedMessage, sessionId: string) {
  return {
    type:      m.role,                              // 'user' | 'assistant'
    sessionId,
    isSidechain: false,
    timestamp:   new Date(m.ts || Date.now()).toISOString(),
    message: {
      role:    m.role,
      content: m.content,
    },
  };
}

async function dispatchToWorker(
  container: string,
  payload: string,
  log: Logger,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false;
    const done = (warn?: string) => {
      if (settled) return;
      settled = true;
      if (warn) log.warn(`[claude-mem] ${warn}`);
      resolve({ ok: !warn, error: warn });
    };

    let proc;
    try {
      // 0.4.102 — event must be one of the router keys the worker knows:
      //   context, session-init, observation, summarize, user-message, file-edit, file-context
      // 'stop' (from Claude Code's Stop hook) is not recognized and the
      // worker replies "Unknown event type: stop, returning no-op". For
      // end-of-turn summarization use 'summarize' — reads sessionId +
      // transcriptPath + lastAssistantMessage from the stdin payload and
      // enqueues a summary observation.
      proc = spawn('docker', [
        'exec', '-i', container,
        'sh', '-c', [
          'export CLAUDE_MEM_WORKER_PORT=${CLAUDE_MEM_WORKER_PORT:-37700}',
          'exec bun /opt/claude-mem/plugin/scripts/worker-service.cjs hook claude-code summarize',
        ].join('; '),
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      done(`spawn docker exec: ${(e as Error).message}`);
      return;
    }

    proc.on('error', e => done(`docker exec error: ${e.message}`));
    proc.on('close', code => {
      if (code !== 0) done(`worker exited with ${code}`);
      else done();
    });

    // Soft watchdog: worker normally responds in <100ms because the
    // call only enqueues. 10s is generous; we don't want long blocks.
    setTimeout(() => {
      if (!settled) {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        done('worker dispatch timed out');
      }
    }, 10_000);

    try {
      proc.stdin.write(payload);
      proc.stdin.end();
    } catch (e) {
      done(`stdin write: ${(e as Error).message}`);
    }
  });
}
