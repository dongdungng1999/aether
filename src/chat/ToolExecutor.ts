/**
 * ToolExecutor — run a single tool call and return a content block suitable
 * for a `tool_result` message.
 *
 * For now every tool is dispatched to the proxy MCP layer through ToolRegistry.
 * Phase 5 adds local file-ops and sandbox /exec routing, which will fork
 * here.
 */

import { randomUUID } from 'crypto';
import { Logger } from '../utils/logger';
import { ToolRegistry } from './ToolRegistry';
import { ContentBlock } from './ChatStreamer';
import { SandboxClient, sandboxLanguageOf } from './SandboxClient';

export interface ToolRunResult {
  tool_use_id: string;
  /** When true the loop should bail out / show error to user. */
  isError:     boolean;
  block:       ContentBlock;        // tool_result block to append
  /** Display name for the UI's running/done badge. */
  display:     string;
}

/** 0.4.162 — payload the frontend sends back via chat.clarifyReply.
 *  Either `answers` (map keyed by question text → chosen label(s) with
 *  optional per-question notes) or `skipped=true` if the user dismissed
 *  the card without answering. */
export interface ClarifyReply {
  answers?: Record<string, { selected: string[]; notes?: string }>;
  skipped?: boolean;
}

/** 0.4.162 — callback wired from ChatPanelV2 so the executor can push a
 *  clarify card to the webview without holding a direct broadcast handle. */
export type ClarifyAskCallback = (
  chatId:    string,
  requestId: string,
  questions: any[],
) => void;

/** Immutable scope supplied by the ChatSession that owns a tool call. */
export interface ToolExecutionContext {
  chatId: string;
  /** Sandbox flavour is selected per call so parallel sessions cannot race. */
  developerMode?: boolean;
  /** Optional built-in handlers used by orchestrated agent sessions. */
  spawnAgents?: (input: any) => Promise<any>;
  releaseAgents?: (input: any) => Promise<any>;
  /** Sub-agent hands its final result + pinned artifacts up to its parent. */
  transferAgent?: (input: any) => Promise<any>;
  /** Model-selected deliverables are fetched into session artifact storage. */
  pinArtifact?: (input: any) => Promise<any>;
  /** Update an existing live artifact without creating a new card/id. */
  updateArtifact?: (input: any) => Promise<any>;
  /** Child monitor threads are read-only and cannot interrupt the user. */
  allowAskUser?: boolean;
}

export class ToolExecutor {

  /** 0.4.162 — deferred promises awaiting user reply for ask_user calls. */
  private pendingClarifications = new Map<string, {
    chatId:  string;
    resolve: (r: ClarifyReply) => void;
    reject:  (e: Error) => void;
  }>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly sandbox:  SandboxClient,
    private readonly log:      Logger,
    /** 0.4.162 — invoked by runAskUser to broadcast the clarify card. */
    private readonly onClarifyAsk?: ClarifyAskCallback,
  ) {}

  /** 0.4.162 — webview delivered a user reply for a pending clarify. */
  resolveClarify(requestId: string, reply: ClarifyReply) {
    const pending = this.pendingClarifications.get(requestId);
    if (!pending) {
      this.log.warn(`[tool-exec] clarify reply for unknown requestId=${requestId}`);
      return false;
    }
    this.pendingClarifications.delete(requestId);
    pending.resolve(reply);
    return true;
  }

  /** 0.4.162 — abort every pending clarify. Called from session cancel so
   *  the tool loop returns is_error results and doesn't hang. */
  cancelClarifications(chatId?: string) {
    for (const [id, p] of this.pendingClarifications.entries()) {
      if (chatId && p.chatId !== chatId) continue;
      p.reject(new Error('cancelled'));
      this.pendingClarifications.delete(id);
    }
  }

  cancelAllClarifications() { this.cancelClarifications(); }

  async run(
    call: { id: string; name: string; input: any },
    context: ToolExecutionContext,
  ): Promise<ToolRunResult> {
    const entry = this.registry.resolve(call.name);
    if (!entry) {
      const msg = `Unknown tool '${call.name}'. Available: ${
        this.registry.toolDefs().map(t => t.name).join(', ') || 'none'
      }`;
      this.log.warn(`[tool-exec] ${msg}`);
      return errorResult(call.id, call.name, msg);
    }
    if (entry.kind === 'ask_user') {
      return this.runAskUser(call, context);
    }
    if (entry.kind === 'spawn_agents' || entry.kind === 'release_agents' || entry.kind === 'agent_transfer' || entry.kind === 'artifact_pin' || entry.kind === 'artifact_update') {
      const handler = entry.kind === 'spawn_agents'
        ? context.spawnAgents
        : entry.kind === 'release_agents'
          ? context.releaseAgents
          : entry.kind === 'agent_transfer'
            ? context.transferAgent
            : entry.kind === 'artifact_pin'
              ? context.pinArtifact
              : context.updateArtifact;
      if (!handler) {
        return errorResult(call.id, call.name, `${entry.kind} is unavailable in this context`);
      }
      try {
        const value = await handler({ ...(call.input ?? {}), _toolUseId: call.id });
        return {
          tool_use_id: call.id,
          isError: false,
          display: call.name,
          block: { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(value, null, 2) },
        };
      } catch (e) {
        return errorResult(call.id, call.name, (e as Error).message);
      }
    }
    if (entry.kind === 'sandbox') {
      return this.runSandbox(call, context);
    }
    return this.runMcp(call, entry.server!, entry.rawName!);
  }

  /** 0.4.162 — broadcast a clarify card to the webview and await the
   *  user's structured reply. Result becomes a normal tool_result block
   *  so the model's tool loop resumes without any special-case in
   *  ChatSession. */
  private async runAskUser(
    call: { id: string; name: string; input: any },
    context: ToolExecutionContext,
  ): Promise<ToolRunResult> {
    const chatId = context.chatId;
    if (context.allowAskUser === false || !chatId || !this.onClarifyAsk) {
      return errorResult(call.id, call.name,
        'ask_user is unavailable in this context (missing chat scope or webview bridge)');
    }
    const questions = Array.isArray(call.input?.questions) ? call.input.questions : [];
    if (!questions.length) {
      return errorResult(call.id, call.name,
        'ask_user requires a non-empty `questions` array with 1-4 items');
    }
    const requestId = randomUUID();
    const reply = await new Promise<ClarifyReply>((resolve, reject) => {
      this.pendingClarifications.set(requestId, { chatId, resolve, reject });
      try {
        this.onClarifyAsk!(chatId, requestId, questions);
      } catch (e) {
        this.pendingClarifications.delete(requestId);
        reject(e as Error);
      }
    }).catch((e: Error) => {
      this.log.warn(`[tool-exec] ask_user pending rejected: ${e.message}`);
      return { skipped: true, _cancelled: true } as any as ClarifyReply;
    });

    // Format the tool_result body. Cancelled → surface as is_error so the
    // model backs off from re-asking on the next turn.
    if ((reply as any)._cancelled) {
      return {
        tool_use_id: call.id,
        isError:     true,
        display:     'ask_user',
        block: {
          type: 'tool_result',
          tool_use_id: call.id,
          content:  '(user cancelled — abort this line of work)',
          is_error: true,
        },
      };
    }
    if (reply.skipped) {
      return {
        tool_use_id: call.id,
        isError:     false,
        display:     'ask_user',
        block: {
          type: 'tool_result',
          tool_use_id: call.id,
          content: '(user skipped — proceed with best judgement and state your assumptions)',
        },
      };
    }
    const body = JSON.stringify({ answers: reply.answers || {} }, null, 2);
    return {
      tool_use_id: call.id,
      isError:     false,
      display:     'ask_user',
      block: {
        type: 'tool_result',
        tool_use_id: call.id,
        content: body,
      },
    };
  }

  private async runSandbox(
    call: { id: string; name: string; input: any },
    context: ToolExecutionContext,
  ): Promise<ToolRunResult> {
    const lang = sandboxLanguageOf(call.name);
    if (!lang) return errorResult(call.id, call.name, `unsupported sandbox tool ${call.name}`);
    const args = call.input || {};
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) return errorResult(call.id, call.name, 'sandbox: empty `code` argument');
    // Per-chat artifact dir. The sandbox container creates the dir on
    // first use so we don't have to bootstrap it from the host. The model
    // is told (via system prompt) to drop outputs here so the chat panel
    // can list+preview them. If the model passes its own cwd we honour
    // it — power users may want a specific path. Otherwise we pin to the
    // chat's dir to keep files isolated.
    let cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : undefined;
    if (!cwd && context.chatId) {
      // /tmp/aura-artifacts (not /home/...) — see F10b: /home is the
      // host-mounted user dir, container UID can't write to it.
      cwd = `/tmp/aura-artifacts/${context.chatId}`;
    }
    // 0.4.231 — snapshot artifact dir before exec so we can diff new files
    // after and append their absolute paths to the tool_result text. Without
    // this, `plt.savefig('foo.png')` yields stdout "saved foo.png" (bare
    // filename), which surfaceImages' /tmp/aura-artifacts/<chatId>/<name>
    // regex can't match → image lands at bubble end, not under this tool's
    // card. The paths let surfaceImages fire image.attach with tool_use_id.
    const chatId = context.chatId || '';
    const before = new Set<string>();
    if (chatId) {
      try {
        const items = await this.sandbox.listArtifacts(chatId);
        for (const f of items) before.add(f.name);
      } catch {}
    }
    try {
      const r = await this.sandbox.exec(lang, {
        code,
        cwd,
        timeout: typeof args.timeout === 'number' ? args.timeout : undefined,
      }, !!context.developerMode);
      let text = SandboxClient.formatResult(r);
      if (chatId) {
        try {
          const items = await this.sandbox.listArtifacts(chatId);
          const fresh = items.filter(f => !before.has(f.name));
          if (fresh.length) {
            const lines = fresh.map(f => `/tmp/aura-artifacts/${chatId}/${f.name}`);
            text += `\n--- artifacts ---\n${lines.join('\n')}`;
          }
        } catch {}
      }
      return {
        tool_use_id: call.id,
        // Non-zero exit_code is *output*, not a tool error — keep is_error
        // false so the model can read the failure and try again.
        isError: false,
        display: call.name,
        block: {
          type: 'tool_result',
          tool_use_id: call.id,
          content: text,
        },
      };
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`[tool-exec] ${call.name} threw: ${msg}`);
      return errorResult(call.id, call.name, `sandbox call failed: ${msg}`);
    }
  }

  private async runMcp(
    call: { id: string; name: string; input: any },
    server: any, rawName: string,
  ): Promise<ToolRunResult> {
    const client = this.registry.clientFor(server);
    if (!client) {
      return errorResult(call.id, call.name, `MCP client missing for server '${server}'`);
    }
    try {
      const r = await client.callTool(rawName, call.input ?? {});
      return {
        tool_use_id: call.id,
        isError:     r.isError,
        display:     call.name,
        block: {
          type: 'tool_result',
          tool_use_id: call.id,
          content: r.text,
          ...(r.isError ? { is_error: true } : {}),
        },
      };
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`[tool-exec] ${call.name} threw: ${msg}`);
      return errorResult(call.id, call.name, `MCP call failed: ${msg}`);
    }
  }
}

function errorResult(id: string, display: string, msg: string): ToolRunResult {
  return {
    tool_use_id: id,
    isError:     true,
    display,
    block: {
      type: 'tool_result',
      tool_use_id: id,
      content: msg,
      is_error: true,
    },
  };
}
