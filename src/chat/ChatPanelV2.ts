/**
 * ChatPanelV2 — host-side adapter for the AURA Studio webview.
 *
 * Why this file exists:
 *   The chat UI is now driven by media-style assets copied from
 *   `frontend/chat/studio/` (lifted from poc_aura_v2/). That webview talks
 *   to the host through a structured RPC envelope:
 *
 *     webview → host : { type, requestId, payload }
 *     host → webview : { type: 'reply', requestId, data }
 *                   or  { type: 'state.invalidate' | 'chat.chunk' | … }
 *
 *   We keep the *backend* parts of the original ChatPanel (ChatSession,
 *   ToolRegistry, ToolExecutor, McpClient, SandboxClient, ChatStore,
 *   ProjectStore, ImageCache, AttachmentParser, Pricing). This adapter
 *   maps every Studio RPC name onto those modules.
 *
 *   Intentionally NOT supported in v0 of the port:
 *     • Truly parallel multi-chat streaming. Backend has one ChatSession
 *       per panel; switching chats hydrates the session from the new
 *       JSONL. Sending while another chat is mid-stream cancels the
 *       previous one — webview's per-chatId tracking still works, just
 *       not concurrently.
 *     • Pyodide python_browser bridge (web v2 had it; we don't expose
 *       a python_browser tool in current ENABLED_SERVERS).
 *     • Per-chat sandbox cwd (current sandbox container is shared).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as fsSync from 'fs';
import { createHash, randomUUID } from 'crypto';
import { Logger } from '../utils/logger';
import { Paths }  from '../utils/paths';
import { ChatSession, SessionEvent } from './ChatSession';
import { ContentBlock, ThinkingEffort, UsageDelta, ChatMessage } from './ChatStreamer';
import { ChatStore, textOf, PersistedMessage, sanitizeProjectFolder, ORPHAN_FOLDER } from './ChatStore';
import { marked } from 'marked';
import { DEFAULT_GLOBAL_PROMPT, DEV_MODE_ADDENDUM } from './SystemPrompt';

/** Render Markdown → safe-ish HTML for the docx/xlsx preview iframe.
 *  We don't sanitize aggressively — the iframe runs sandbox=allow-scripts
 *  with no allow-same-origin so DOM injection is contained. */
function mdToSafeHtml(md: string): string {
  try { return (marked.parse(md, { headerIds: false, mangle: false } as any) as unknown) as string; }
  catch { return `<pre>${md.replace(/[<>&]/g, c => (({'<':'&lt;','>':'&gt;','&':'&amp;'} as Record<string,string>)[c]||c))}</pre>`; }
}
import { ImageCache, extractImageUrls, extractImageFilenames } from './ImageCache';
import { ArtifactStore, SavedArtifact } from './ArtifactStore';
import { ToolRegistry } from './ToolRegistry';
import { ToolExecutor } from './ToolExecutor';
import { SandboxClient } from './SandboxClient';
import { ProjectStore, Project } from './ProjectStore';
import { TerminalRegistry } from './TerminalRegistry';
import { PluginRegistry, createClaudeMemPlugin } from '../plugins';
import { AttachmentParser } from './AttachmentParser';
import { renderOfficeFile } from './OfficePreview';
import { computeCost, contextWindowFor, maxOutputTokensFor, DEFAULT_PRICING } from './Pricing';
import { approxTokensForMsgs, approxTokensForTools, approxTokensStr } from './MessageTokens';
import { buildReturnSummaryPrompt, needsReturnSummary, returnBudget, splitForSummary } from './agents/AgentReturn';
import { ProxyProcessManager } from '../proxy/ProxyProcessManager';
import { ContainerLifecycle, Service } from '../container/ContainerLifecycle';
import { PresetManager } from '../preset/PresetManager';
import { SandboxContainerManager } from '../sandbox/SandboxContainerManager';
import { EnvFileManager, ENV_KEY_WHITELIST } from '../auth/EnvFileManager';
import { RuntimeConfig } from '../core/RuntimeConfig';
import { AgentRegistry } from './agents/AgentRegistry';
import { AgentRunner } from './agents/AgentRunner';
import { AgentEvent, AgentNode } from './agents/AgentTypes';

const MAX_FILE_BYTES = 1024 * 1024;   // 1 MB cap; PDFs go through MinerU not raw read
// 0.4.133 — richer preview path bumps the cap to 20 MB. The webview renders
// docx/xlsx/pptx/pdf/epub client-side (docx-preview, SheetJS, PptxViewJS,
// pdfjs, epub.js), so it needs the raw bytes and can handle bigger files
// than the legacy MinerU-only PDF flow.
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const THINKING_EFFORTS = new Set<ThinkingEffort>(['low', 'medium', 'high', 'xhigh', 'max']);
type ThinkingLevel = 'off' | ThinkingEffort;

/** 0.4.159 — synthetic user hint injected when the model ended a turn with
 *  only thinking blocks. Recognised verbatim by DEFAULT_GLOBAL_PROMPT so
 *  the model sees this as a hard "emit response NOW" signal instead of a
 *  generic (continue). */
const THINKING_ONLY_CONTINUE_HINT =
  '(SYSTEM: your prior segment used the entire output budget on the ' +
  'thinking channel and emitted zero visible content — the connected ' +
  'model capped output before any visible response was written. The ' +
  'ORIGINAL user request is still active above in the history — read ' +
  'it and START WRITING THE RESPONSE NOW.\n\n' +
  'DO NOT: ask "what would you like to work on", ask for clarification, ' +
  'apologise, or say "I did not produce output". The user has ALREADY ' +
  'told you what they want and can see everything.\n\n' +
  'DO: minimise further thinking (you already planned enough in the ' +
  'prior segment), and dump the artifact/response directly.)';

/** 0.4.161 — hint used when the previous turn ended cleanly (`end_turn`)
 *  but did NOT emit the `[END]` completion marker. Nudges the model once
 *  to disambiguate "truly done" from "forgot the marker". */
const END_MARKER_NUDGE_HINT =
  '(continue — your last turn ended without an [END] marker. If your response is genuinely complete, resend the final line and append [END] on its own line. Otherwise, continue where you left off.)';

/** 0.4.159 — total-token ceiling for the continuation loop. When
 *  the running history (including all continuation dumps) hits this fraction
 *  of the model's context window, the loop stops and the user has to
 *  intervene (Continue button / Compact). Prevents runaway loops from
 *  eating the whole context window on a single stuck turn. */
const THINKING_RECURSE_CTX_CEILING = 0.85;

/** 0.4.161 — matches the `[END]` completion marker on its own line at the
 *  very end of a response. Used to detect model-signalled turn completion
 *  in the continuation loop. */
const END_MARKER_RX = /\n?\[END\]\s*$/;

/** 0.4.215 — self-managed budget markers. Model emits one of these on its
 *  own line at the tail of a segment when it estimates the output budget
 *  is close to exhausted or the task is genuinely done. All three are
 *  mutually exclusive; presence of any of them takes priority over the
 *  legacy [END] and over stop_reason heuristics. */
const DONE_MARKER_RX        = /\n?\[DONE\]\s*$/;
const NEED_MORE_MARKER_RX   = /\n?\[NEED_MORE\]\s*$/;
const NEED_THINK_MARKER_RX  = /\n?\[NEED_THINK\]\s*$/;

/** Model-emitted control marker: board edits are complete, capture now. */
const BOARD_DONE_MARKER_RX = /\n?\s*<AURA_BOARD_DRAWING_DONE\s*\/>\s*$/;
const BOARD_DONE_MARKER_ANY_RX = /\s*<AURA_BOARD_DRAWING_DONE\s*\/>\s*/g;
const BOARD_DONE_MARKER_ANY_TEST_RX = /<AURA_BOARD_DRAWING_DONE\s*\/>/;

const EXCALIDRAW_MUTATING_TOOL_KEYS = new Set([
  'createelement',
  'batchcreateelements',
  'createfrommermaid',
  'updateelement',
  'deleteelement',
  'duplicateelements',
  'alignelements',
  'distributeelements',
  'groupelements',
  'ungroupelements',
  'lockelements',
  'unlockelements',
  'importscene',
  'restoresnapshot',
  'setviewport',
  'clearcanvas',
]);

function isMutatingExcalidrawTool(name: string): boolean {
  const raw = String(name || '').toLowerCase();
  if (!raw.includes('excalidraw')) return false;
  const key = raw.replace(/^.*excalidraw[_\s-]*/, '').replace(/[^a-z0-9]/g, '');
  return EXCALIDRAW_MUTATING_TOOL_KEYS.has(key);
}

type BoardCaptureFocus = {
  mode: 'focus' | 'context' | 'overview';
  toolUseId?: string;
  toolName?: string;
  elementIds?: string[];
  bbox?: { x: number; y: number; width: number; height: number };
};

function focusFromExcalidrawInput(toolUseId: string, toolName: string, input: any): BoardCaptureFocus | undefined {
  const raw = String(toolName || '').toLowerCase();
  const elements = Array.isArray(input?.elements) ? input.elements : [];
  if (elements.length) {
    const boxes = elements.map((e: any) => elementBox(e)).filter(Boolean) as Array<{ x: number; y: number; width: number; height: number }>;
    return {
      mode: raw.includes('clear') || raw.includes('restore') || raw.includes('import') ? 'overview' : 'focus',
      toolUseId,
      toolName,
      elementIds: elements.map((e: any) => String(e?.id || '')).filter(Boolean),
      bbox: unionBoxes(boxes),
    };
  }
  const single = elementBox(input);
  const ids = [input?.id, ...(Array.isArray(input?.elementIds) ? input.elementIds : [])].map(String).filter(Boolean);
  if (single || ids.length) return { mode: raw.includes('arrow') ? 'context' : 'focus', toolUseId, toolName, elementIds: ids, bbox: single || undefined };
  return isMutatingExcalidrawTool(toolName) ? { mode: 'overview', toolUseId, toolName } : undefined;
}

function elementBox(e: any): { x: number; y: number; width: number; height: number } | undefined {
  const x = Number(e?.x), y = Number(e?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const width = Math.max(1, Number(e?.width ?? 160) || 160);
  const height = Math.max(1, Number(e?.height ?? 80) || 80);
  return { x, y, width, height };
}

function unionBoxes(boxes: Array<{ x: number; y: number; width: number; height: number }>): { x: number; y: number; width: number; height: number } | undefined {
  if (!boxes.length) return undefined;
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.width));
  const maxY = Math.max(...boxes.map(b => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/* ───────────────── Chat metadata ───────────────────── */

/** What the rail/recents/project-chat lists send to the webview.
 *  Mirrors v2's chat record minus the SQLite-only fields. */
interface ChatRecord {
  id:        string;
  projectId: string;        // empty = unfiled / quick chat
  title:     string;
  model:     string;
  createdAt: number;
  updatedAt: number;
  /** 0.4.157 — high-water mark: index (into full-history JSONL) of the
   *  last message that has been folded into the compact systemnote.
   *  Next compact only summarises messages after this index and merges
   *  the new chunk into the existing note ("full history" stays intact
   *  on disk; "in-context history" is note + tail slice). Absent when
   *  the chat has never been compacted. */
  compactedUpTo?: number;
}

/** Anthropic-shaped turn for chats.turns RPC. */
interface TurnRecord {
  id:         number;
  role:       'user' | 'assistant';
  content:    ContentBlock[] | string;
  model?:     string;
  inTokens?:  number;
  outTokens?: number;
  cacheRead?: number;
  cacheWrite?:number;
  costUsd?:   number;
  createdAt:  number;
  /** 0.4.189 — structured attachment metadata from persistence. Passed
   *  through verbatim so the webview can render chips on reload. */
  attachments?: any[];
  /** 0.4.163 — true for AURA-injected continuation hints / outer-loop
   *  "(continue)". Frontend renders these as compact foldable hint cards
   *  instead of standalone user bubbles. */
  synthetic?: boolean;
  kind?: 'compact' | 'agent-handoff';
}

/* ───────────────── Panel ───────────────────── */

export class ChatPanelV2 {
  private static current?: ChatPanelV2;

  /** Standalone app has exactly one panel instance, driven entirely through
   *  BrowserServer's sink/broadcast mechanism — no native webview, no
   *  per-window singleton to reveal. */
  static open(
    proxy:     ProxyProcessManager,
    lifecycle: ContainerLifecycle,
    preset:    PresetManager,
    paths:     Paths,
    log:       Logger,
    env:       EnvFileManager,
    runtimeConfig: RuntimeConfig,
    sandbox?:  SandboxContainerManager,
    sandboxDev?: SandboxContainerManager,
  ) {
    if (ChatPanelV2.current) return ChatPanelV2.current;
    return new ChatPanelV2(proxy, lifecycle, preset, paths, log, env, runtimeConfig, sandbox, sandboxDev);
  }

  private readonly paths: Paths;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly sessionsDir: string;
  private readonly imagesDir:   string;
  private readonly attachmentsDir: string;
  private readonly imageCache:    ImageCache;
  private readonly artifactStore: ArtifactStore;
  private readonly toolRegistry:  ToolRegistry;
  private readonly toolExecutor:  ToolExecutor;
  private readonly sandboxClient: SandboxClient;
  private readonly projectStore:  ProjectStore;
  private readonly attachParser:  AttachmentParser;
  private readonly plugins:       PluginRegistry;

  /** ChatSession per chat — keyed by chatId. Multiple chats can stream
   *  concurrently against the SAME ToolRegistry/ToolExecutor (those are
   *  thread-safe wrt streaming since each call gets its own AbortController
   *  and tool calls are awaited synchronously). */
  private sessions = new Map<string, ChatSession>();
  /** Per-chat queued user payload submitted while a turn is streaming. */
  private queuedSend = new Map<string, any>();
  /** Chats currently inside runTurnBackground; prevents overlapping send() calls. */
  private activeRuns = new Set<string>();
  /** Recursive agent tree per root chat. Child contexts live in sibling JSONL files. */
  private agentRegistries = new Map<string, AgentRegistry>();
  /** agentId set of root-level agents whose results have already been injected
   *  into the root chat session as a synthetic user message. Prevents double-inject. */
  private injectedAgentResults = new Set<string>();
  private readonly forceReturnRuns = new Map<string, Promise<any>>();
  private readonly submitAllRuns = new Map<string, Promise<{ ok: boolean; submitted: number; failed: number }>>();
  /** Manual agent chat and one-edge submit locks. Separate from automatic resume. */
  private readonly manualAgentRuns = new Set<string>();
  private readonly manualAgentSubmits = new Set<string>();
  /** Serialize sibling submissions that rewrite the same target transcript. */
  private readonly manualSubmitTargets = new Map<string, Promise<void>>();
  private agentRegistryInit = new Map<string, Promise<AgentRegistry>>();
  private terminal?: TerminalRegistry;
  /** 0.4.202 — parsed doc attachments held in RAM until send. Keyed by
   *  hash. onSend flushes matching entries to disk right before build
   *  prompt; attach.discard drops them; extension reload GCs the whole
   *  Map naturally. Avoids .md file rác when user hits ✕ or bails
   *  mid-chat. */
  private ramAttachments = new Map<string, { markdown: string; images?: Array<{ name: string; mediaType: string; data: string }>; meta: any; parsedAt: number }>();
  private pendingMineruPick = new Map<string, (v: 'pipeline' | 'hybrid-engine' | 'cancel') => void>();
  /** The chat the user is currently looking at — used by activateChat
   *  for hydrate semantics + by image surfacing for default routing. */
  private activeChatId = '';
  /** Chat metadata cache — written to <dataRoot>/chat-meta.json on every
   *  mutation so a panel reopen sees the same titles/projects/timestamps. */
  private chats: ChatRecord[] = [];
  private readonly metaFile: string;
  /** Per-chat next-turn-id counter so v2's chats.deleteTurn ids stay
   *  stable across panel sessions. We synthesize from the JSONL line
   *  index when loading. */
  private turnIdByChat = new Map<string, number>();

  /** Browser-mode clients that receive the same envelopes as the VS Code webview. */
  private readonly browserSinks = new Map<string, (envelope: any) => void>();
  private handlingBrowserMessage = false;

  /** Discovered lazily from the proxy container. */
  private imageToken = '';

  /** Aggregate cost across all turns this panel has seen. The webview
   *  expects chat.done payloads to include a per-turn costUsd we add to
   *  its own session counter. */
  private sessionCost = 0;

  /** Pricing overrides — written from settings RPCs; stored alongside
   *  chat-meta.json so they survive reload. */
  private pricingOverrides: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }> = {};
  /** User-edited per-tier system prompts. Tier 'global' / 'model:<id>' /
   *  'project:<id>'. Stored next to chat-meta.json. */
  private systemPrompts: Record<string, string> = {};
  /** Models temporarily disabled by the user; spawn_agents must not use them. */
  private unavailableModels: string[] = [];
  /** Live theme — webview asks for it on app.ready. */
  private theme = 'claude';

  private constructor(
    private readonly proxy:     ProxyProcessManager,
    private readonly lifecycle: ContainerLifecycle,
    private readonly preset:    PresetManager,
    paths: Paths,
    private readonly log:   Logger,
    private readonly env:   EnvFileManager,
    private readonly runtimeConfig: RuntimeConfig,
    private readonly sandbox?: SandboxContainerManager,
    private readonly sandboxDev?: SandboxContainerManager,
  ) {
    this.paths           = paths;
    this.sessionsDir     = path.join(paths.dataRoot, 'chat-sessions');
    this.imagesDir       = path.join(paths.dataRoot, 'chat-images');
    this.attachmentsDir  = path.join(paths.dataRoot, 'chat-attachments');
    this.metaFile        = path.join(paths.dataRoot, 'chat-meta.json');

    this.imageCache   = new ImageCache(this.imagesDir, log);
    this.artifactStore = new ArtifactStore(path.join(paths.dataRoot, 'chat-artifacts'), log);
    this.projectStore = new ProjectStore(paths.dataRoot);
    this.toolRegistry = new ToolRegistry(() => proxy.baseUrl(), log);
    this.sandboxClient = new SandboxClient(
      () => preset.getSandboxPort(),
      sandbox ?? null,
      log,
      () => preset.getSandboxDevPort(),
      sandboxDev ?? null,
    );
    this.toolExecutor = new ToolExecutor(
      this.toolRegistry,
      this.sandboxClient,
      log,
      // 0.4.162 — ask_user pseudo-tool. Executor broadcasts a clarify card
      // to the webview and awaits chat.clarifyReply from the frontend.
      (chatId, requestId, questions) => {
        this.broadcast('chat.clarifyAsk', { chatId, requestId, questions });
      },
    );
    this.attachParser = new AttachmentParser(
      () => proxy.baseUrl(),
      log,
      path.join(paths.dataRoot, 'claude-mem', '.attach-staging'),
      '/mnt/claude-mem/.attach-staging',
      // 0.4.200 — hand the parser a resolver for the real MinerU endpoint
      // (from Settings → MinerU server URL) so the progress label shows
      // the actual remote server the parse is running on, not the proxy's
      // 127.0.0.1 loopback.
      async () => (await this.runtimeConfig.load()).mineruUrl || '',
    );

    // 0.4.66 — plugin pipeline. Plugins observe chat lifecycle events
    // and forward to external systems (e.g. claude-mem worker). Failures
    // are isolated inside the registry; chat never breaks on plugin error.
    this.plugins = new PluginRegistry(log);
    this.plugins.register(createClaudeMemPlugin({
      lifecycle,
      transcriptDir: path.join(paths.dataRoot, '.claude-mem-transcripts'),
      getNamespace:  () => preset.getClaudeMemNamespace(),
      // 0.4.104 — surface dispatch outcome to the webview so the memory
      // card at the bottom of each assistant bubble flips green (or red
      // with the reason) as soon as the plugin finishes.
      onResult: (chatId, r, stopReason, turnId) => {
        this.broadcast('memory.observation', {
          chatId,
          ok:         r.ok,
          namespace:  r.namespace,
          error:      r.error,
          stopReason,
          turnId,
        });
      },
    }));

    this.terminal = new TerminalRegistry(paths.userHome || paths.dataRoot, log);

    // No native webview to create — BrowserServer serves the same studio
    // frontend over HTTP+WS and drives this panel entirely through
    // addBrowserSink/handleBrowserMessage (see below).

    // Hook proxy lifecycle so the picker / send button reflect reality.
    const emitProxyState = () => {
      const ready = this.proxy.isReady();
      const url = ready ? this.proxy.baseUrl() : '';
      const port = url.match(/:(\d+)/)?.[1] ?? '';
      this.broadcast('proxy.state', { ready, url, port });
    };
    const onReady = () => {
      this.refreshToken().catch(() => { /* logged inside */ });
      this.toolRegistry.reset();
      emitProxyState();
    };
    proxy.on('ready', onReady);
    this.disposables.push({ dispose: () => proxy.off('ready', onReady) });
    // Push initial state right after the webview mounts, plus a heartbeat
    // so the pill stays in sync if adopt-on-open takes a while.
    setTimeout(emitProxyState, 200);
    const proxyHeartbeat = setInterval(emitProxyState, 5000);
    this.disposables.push({ dispose: () => clearInterval(proxyHeartbeat) });

    // No session yet — they're created lazily per chatId on first
    // activateChat / chat.send.
    this.loadMeta().catch(e => log.warn(`[chat-v2] loadMeta: ${(e as Error).message}`));

    if (!proxy.isReady()) {
      proxy.ensure().catch(e => log.warn(`[chat-v2] adopt-on-open: ${(e as Error).message}`));
    }
    ChatPanelV2.current = this;
  }

  /** Build a fresh ChatSession for one chatId. Cached after first build. */
  private makeSession(): ChatSession {
    return new ChatSession(
      () => this.proxy.baseUrl(),
      () => 'claude-opus-4-7',
      this.toolRegistry,
      this.toolExecutor,
      this.log,
    );
  }

  private async availableAgentModels(): Promise<string[]> {
    const data = await this.preset.load();
    const blocked = new Set(this.unavailableModels);
    const pickerIds = (data.uiModels || []).map(m => m.id).filter(Boolean).filter(id => !blocked.has(id));
    const aliases = Object.keys(data.models || {}).filter(id => !blocked.has(id));
    return [...new Set([...pickerIds, ...aliases])];
  }

  private agentRegistryFor(chatId: string): Promise<AgentRegistry> {
    const existing = this.agentRegistries.get(chatId);
    if (existing) return Promise.resolve(existing);
    const pending = this.agentRegistryInit.get(chatId);
    if (pending) return pending;
    const init = this.createAgentRegistry(chatId).finally(() => this.agentRegistryInit.delete(chatId));
    this.agentRegistryInit.set(chatId, init);
    return init;
  }

  private async createAgentRegistry(chatId: string): Promise<AgentRegistry> {
    const folder = await this.projectFolderFor(chatId);
    let registry!: AgentRegistry;
    const runner = new AgentRunner({
      baseUrl: () => this.proxy.baseUrl(),
      sessionsRoot: this.sessionsDir,
      projectFolder: folder,
      registry: this.toolRegistry,
      executor: this.toolExecutor,
      log: this.log,
      availableModels: () => this.availableAgentModels(),
      systemExtra: () => this.systemPromptForChat(chatId),
      releaseAgents: (ownerAgentId, input) => this.releaseAgents(chatId, ownerAgentId, input),
      transferAgent: (node, input) => this.transferToParent(chatId, node, input),
      pinArtifact: (node, input) => this.pinAgentArtifact(chatId, node, input),
      updateArtifact: (_node, input) => this.updateModelArtifact(chatId, input),
      compactSession: (session, model) => this.compactSessionCore(session, model),
    });
    registry = new AgentRegistry(chatId, node => runner.run(node), event => this.onAgentEvent(event));
    runner.setRegistry(registry);
    registry.setResumer(node => runner.resumeFromDisk(node));
    const files = await ChatStore.agentFilesForChatId(this.sessionsDir, chatId);
    const restored: AgentNode[] = [];
    for (const file of files) {
      const meta = await ChatStore.agentMeta(file);
      if (!meta) continue;
      restored.push({
        ...meta,
        parentAgentId: meta.parentAgentId,
        effort: (meta.effort || 'medium') as ThinkingEffort,
        maxTurns: meta.maxTurns || registry.limits.defaultMaxTurns,
        // A reloaded extension cannot resume the old HTTP/tool loop. Treat
        // truly in-flight workers as cancelled so they can be resumed/released,
        // but do not regress a worker that had already persisted a final result
        // before the host was reloaded.
        status: (['queued', 'running', 'waiting'].includes(meta.status)
          ? (String(meta.result || '').trim() ? 'completed' : 'cancelled')
          : meta.status) as any,
        submitted: meta.submitted === true,
        sequence: 0,
        usage: meta.usage || { inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: meta.costUsd || 0,
        contextMax: meta.contextMax,
        runId: meta.runId,
        returnBudgetTokens: meta.returnBudgetTokens,
        result: meta.result || '',
        // resultInjected from v0.4.377 only meant a synthetic turn was appended;
        // it did not prove the orchestrator successfully consumed it.
        returnState: meta.returnState || 'pending',
        handoffResult: meta.handoffResult,
        handoffTokens: meta.handoffTokens,
        handoffBudgetTokens: meta.handoffBudgetTokens,
        deliveredAt: meta.deliveredAt,
        artifacts: Array.isArray(meta.artifacts) ? meta.artifacts : undefined,
        transferredArtifactIds: Array.isArray(meta.transferredArtifactIds) ? meta.transferredArtifactIds : undefined,
        ...(meta.error ? { error: meta.error } : {}),
      });
    }
    registry.restore(restored);
    // Restore injected-results tracking so reload doesn't double-inject.
    for (const file of files) {
      const meta = await ChatStore.agentMeta(file);
      if (meta?.resultInjected && !meta.parentAgentId) {
        this.injectedAgentResults.add(meta.agentId);
      }
    }
    this.agentRegistries.set(chatId, registry);
    return registry;
  }

  private onAgentEvent(event: AgentEvent) {
    const names: Record<AgentEvent['type'], string> = {
      created: 'agent.created', status: 'agent.status', chunk: 'agent.chunk',
      tool: 'agent.tool', usage: 'agent.usage', completed: 'agent.completed',
      released: 'agent.released', context_guard: 'agent.contextGuard',
    };
    this.broadcast(names[event.type], event);
    if (event.type !== 'chunk' && event.type !== 'usage' && event.type !== 'tool') {
      this.broadcast('agents.snapshot', {
        rootChatId: event.rootChatId,
        agents: this.agentRegistries.get(event.rootChatId)?.snapshot() || [],
      });
    }
  }

  private async pinAgentArtifact(chatId: string, node: AgentNode, input: any): Promise<any> {
    const source = String(input?.path || input?.source || '');
    if (!source) throw new Error('aura_artifact_pin requires path');
    const sandboxScope = `${chatId}.agent-${node.agentId}`;
    const artifact = await this.pinGenericArtifact(chatId, source, {
      toolUseId: input?._toolUseId ? String(input._toolUseId) : undefined,
      name: input?.name ? String(input.name) : undefined,
      mediaType: input?.mediaType ? String(input.mediaType) : undefined,
      ownerAgentId: node.agentId,
      sandboxScope,
      suppressAttach: true,
      live: input?.live === true,
      description: input?.description ? String(input.description) : undefined,
    });
    const ref = {
      id: artifact.id, name: artifact.name, mediaType: artifact.mediaType,
      size: artifact.size, sourceAgentId: node.agentId, savedAt: artifact.savedAt,
    };
    node.artifacts = [...(node.artifacts || []).filter(a => a.id !== ref.id), ref];
    await new ChatStore(this.sessionsDir, chatId, await this.projectFolderFor(chatId), node.agentId)
      .updateAgentMeta({ artifacts: node.artifacts });
    this.broadcast('agent.artifact', {
      rootChatId: chatId, agentId: node.agentId, parentAgentId: node.parentAgentId,
      payload: { ...artifact, sourceAgentId: node.agentId, toolUseId: input?._toolUseId ? String(input._toolUseId) : undefined },
    });
    return {
      ok: true,
      id: artifact.id,
      name: artifact.name,
      mediaType: artifact.mediaType,
      size: artifact.size,
      savedAt: artifact.savedAt,
      message: 'Artifact pinned to this sub-agent. It will be promoted when the agent is released.',
    };
  }

  /** agent_transfer handler — a sub-agent explicitly hands its final result +
   *  pinned artifacts up to its DIRECT parent (or the root orchestrator for a
   *  top-level coordinator).
   *
   *  Delivery model (v0.4.397): spawn_agents is synchronous, so the child's
   *  return value IS the parent's tool_result. agent_transfer therefore only:
   *    1. sets `node.handoffResult` so AgentRunner returns exactly this text as
   *       the child's result (→ the spawn_agents tool_result the parent reads);
   *    2. promotes the selected artifact bytes into the parent scope and stamps
   *       them onto the returned refs (via node.artifacts, sourceAgentId=parent
   *       scope) so the FE renders them AFTER that tool_result;
   *    3. records transferredArtifactIds so release_agents does not re-promote.
   *
   *  It does NOT stage an agent-handoff turn and does NOT broadcast artifact
   *  cards: the handoff card was a redundant second source, and broadcasting
   *  a card here dropped it in the wrong place (the child's own view / after
   *  the transfer call). Rendering is owned solely by the spawn_agents result.
   *  Critically, staging a handoff also rewrote the parent/root session JSONL
   *  mid-stream, desyncing the live SSE view until reload — removing it fixes
   *  the "root SSE disappears" report. */
  private async transferToParent(chatId: string, node: AgentNode, input: any): Promise<any> {
    const parentAgentId = node.parentAgentId; // undefined = root orchestrator
    // Resolve the text to hand up: explicit `result`, else the last assistant
    // turn in this agent's transcript. The model decides the content (guided by
    // the sub-agent system prompt).
    let text = typeof input?.result === 'string' ? input.result.trim() : '';
    if (!text) {
      const msgs = await ChatStore.loadAgent(this.sessionsDir, chatId, node.agentId).catch(() => [] as any[]);
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== 'assistant') continue;
        const t = textOf(msgs[i].content).trim();
        if (t) { text = t; break; }
      }
    }
    if (input?.note) text = `${text}\n\n${String(input.note).trim()}`.trim();
    if (!text) text = `Agent ${node.agentId} completed.`;

    // Pick artifacts to transfer: explicit id list (validated against this
    // agent's own artifacts), else all of them.
    const own = node.artifacts || [];
    let toTransfer = own;
    if (Array.isArray(input?.artifacts) && input.artifacts.length) {
      const want = new Set(input.artifacts.map((x: any) => String(x)));
      toTransfer = own.filter(a => want.has(String(a.id)));
    }

    // Promote bytes into the parent scope so the parent can address them, and
    // rewrite the transferred entries in node.artifacts to point at the
    // parent-scoped copy. AgentRunner returns node.artifacts in the child's
    // AgentResult → the spawn_agents tool_result → the FE renders them after it.
    // guardIds records EVERY id release_agents must skip re-promoting: both the
    // original child-scope id and the new parent-scoped saved.id. node.artifacts
    // is remapped to saved.id below, and release_agents' skip-guard iterates
    // node.artifacts — if the guard didn't know saved.id it would try to
    // re-promote the remapped id from the child scope where it no longer lives
    // ("pathForArtifact: not found" at release).
    const guardIds: string[] = [];
    const remapped = new Map<string, import('./agents/AgentTypes').AgentArtifactRef>();
    const promotedRefs: import('./agents/AgentTypes').AgentArtifactRef[] = [];
    for (const art of toTransfer) {
      try {
        // parentAgentId === undefined → promote into root scope (toAgentId omitted).
        const saved = await this.artifactStore.promoteArtifact(chatId, node.agentId, art, parentAgentId);
        await this.artifactStore.readArtifact(chatId, saved.id, parentAgentId); // verify copy
        // sourceAgentId is the scope the FE reads bytes from: the parent agent's
        // dir, or '' (root dir) when promoting to the orchestrator.
        const ref = {
          id: saved.id, name: saved.name, mediaType: saved.mediaType, size: saved.size,
          sourceAgentId: parentAgentId || '', savedAt: saved.savedAt,
        };
        remapped.set(String(art.id), ref);
        promotedRefs.push(ref);
        guardIds.push(String(art.id), String(saved.id));
      } catch (e) {
        this.log.warn(`[agents] agent_transfer promote ${art.id}: ${(e as Error).message}`);
      }
    }
    // Swap transferred refs to their parent-scoped copy in node.artifacts.
    if (remapped.size) {
      node.artifacts = (node.artifacts || []).map(a => remapped.get(String(a.id)) || a);
    }

    // Attach the promoted refs onto the PARENT agent's node.artifacts (data only,
    // NO broadcast — keeps the v0.4.397 no-stray-card behavior) so that when the
    // parent itself transfers up (coordinator → orchestrator) its own `node.artifacts`
    // includes what its children handed to it. Without this a coordinator hands up
    // `artifacts: []` and the leaf deliverables never reach the orchestrator.
    // (v0.4.397 removed the broadcast — correct — but also dropped this push,
    // which silently broke coordinator→orchestrator artifact delivery.)
    // release_agents already attaches NON-transferred artifacts to the owner
    // (line ~917); this covers the transferred set — the two are disjoint because
    // release skips ids in transferredArtifactIds.
    if (parentAgentId && promotedRefs.length) {
      const registry = await this.agentRegistryFor(chatId);
      const parent = registry.get(parentAgentId);
      if (parent) {
        const have = new Set((parent.artifacts || []).map(a => String(a.id)));
        const add = promotedRefs.filter(r => !have.has(String(r.id)));
        if (add.length) {
          parent.artifacts = [...(parent.artifacts || []), ...add];
          await new ChatStore(this.sessionsDir, chatId, await this.projectFolderFor(chatId), parent.agentId)
            .updateAgentMeta({ artifacts: parent.artifacts });
        }
      }
    }

    node.handoffResult = text;
    node.submitted = true;
    node.transferredArtifactIds = [...new Set([...(node.transferredArtifactIds || []), ...guardIds])];
    await new ChatStore(this.sessionsDir, chatId, await this.projectFolderFor(chatId), node.agentId)
      .updateAgentMeta({
        handoffResult: text,
        submitted: true,
        artifacts: node.artifacts,
        transferredArtifactIds: node.transferredArtifactIds,
      });

    return {
      ok: true,
      to: parentAgentId || 'orchestrator',
      transferred: promotedRefs.map(r => r.id),
      artifacts: promotedRefs.map(r => ({ id: r.id, name: r.name, mediaType: r.mediaType, size: r.size })),
      message: parentAgentId
        ? 'Result and artifacts transferred to your parent agent.'
        : 'Result and artifacts transferred to the orchestrator.',
    };
  }

  private async purgeReleasedAgents(chatId: string, registry: AgentRegistry): Promise<void> {
    // Called only by explicit dismiss/Close all RPCs after frontend confirmation.
    // Dismiss removes the agent conversation transcript from global storage, but
    // keeps generated artifact files addressable by id so existing cards/tabs can
    // still preview or download after the agent dock is closed.
    const purgeIds = registry.snapshot()
      .filter(node => node.released)
      .map(node => node.agentId);
    for (const id of purgeIds) {
      await ChatStore.deleteAgent(this.sessionsDir, chatId, id).catch(() => {});
    }
  }

  private isAgentDescendant(registry: AgentRegistry, agentId: string, ancestorId: string): boolean {
    let node = registry.get(agentId);
    while (node?.parentAgentId) {
      if (node.parentAgentId === ancestorId) return true;
      node = registry.get(node.parentAgentId);
    }
    return false;
  }

  private async releaseAgents(chatId: string, ownerAgentId: string | undefined, input: any) {
    const agentIds: string[] = Array.isArray(input?.agentIds) ? input.agentIds.map(String) : [];
    const registry = await this.agentRegistryFor(chatId);
    // Validate the complete request before deleting anything. Agent results are
    // already embedded in the owner's spawn_agents tool_result at this point.
    for (const id of agentIds) {
      const node = registry.get(id);
      if (!node) throw new Error(`unknown agent: ${id}`);
      if (node.parentAgentId !== ownerAgentId) throw new Error(`agent '${id}' is not owned by this caller`);
      if (!node.released && !['completed', 'error', 'cancelled', 'limit_reached'].includes(node.status)) {
        throw new Error(`agent '${id}' is still ${node.status}`);
      }
    }
    // Promote every retained binary before changing lifecycle state or deleting
    // source namespaces. Any failure aborts the release with child data intact.
    const promoted: Array<import('./agents/AgentTypes').AgentArtifactRef> = [];
    const releaseRoots = agentIds.map(id => registry.get(id)!);
    const releaseNodes = registry.snapshot().filter(node => releaseRoots.some(root =>
      node.agentId === root.agentId || this.isAgentDescendant(registry, node.agentId, root.agentId)
    ));
    for (const node of releaseNodes) {
      const alreadyTransferred = new Set(node.transferredArtifactIds || []);
      for (const artifact of node.artifacts || []) {
        // Skip artifacts the agent already handed up via agent_transfer — they
        // are in the parent scope already; re-promoting would duplicate them.
        if (alreadyTransferred.has(String(artifact.id))) continue;
        // Durability-only promotion: copy bytes into the owner/root scope so the
        // file survives, but do NOT broadcast/append a card. Artifact rendering
        // is owned by the spawn_agents tool_result (agent_transfer is the
        // delivery path); release_agents is a lifecycle cleanup, not a render
        // event. (Was attachRootArtifact, which broadcast a stray card after
        // release — see the "render after release_agents is wrong" report.)
        const saved = await this.artifactStore.promoteArtifact(chatId, node.agentId, artifact, ownerAgentId);
        await this.artifactStore.readArtifact(chatId, saved.id, ownerAgentId); // verify copy
        promoted.push({
          id: saved.id, name: saved.name, mediaType: saved.mediaType, size: saved.size,
          sourceAgentId: artifact.sourceAgentId, savedAt: saved.savedAt,
        });
      }
    }
    if (ownerAgentId && promoted.length) {
      const owner = registry.get(ownerAgentId);
      if (owner) owner.artifacts = [...(owner.artifacts || []), ...promoted];
    } else if (promoted.length) {
      const rootSession = this.sessions.get(chatId);
      if (rootSession) await this.persistSession(chatId, rootSession);
    }

    const released = registry.releaseOwned(ownerAgentId, agentIds);
    this.broadcast('agents.snapshot', { rootChatId: chatId, agents: registry.snapshot() });
    // release_agents is a context/lifecycle handoff, not a destructive delete.
    // Keep agent JSONL + artifacts for debugging/history; only explicit
    // agents.dismiss / agents.dismissAll calls purge via purgeReleasedAgents().
    return { released };
  }

  /** Look up the sanitized project folder name for a chat. 0.4.66+
   *  routes every JSONL into <sessionsDir>/<projectFolder>/. Falls back
   *  to ORPHAN_FOLDER when the chat is unfiled OR the ProjectStore
   *  index is stale. */
  private async projectFolderFor(chatId: string): Promise<string> {
    const rec = this.chats.find(c => c.id === chatId);
    const pid = rec?.projectId || '';
    if (!pid) return ORPHAN_FOLDER;
    try {
      const proj = await this.projectStore.getProject(pid);
      return sanitizeProjectFolder(proj?.name);
    } catch {
      return ORPHAN_FOLDER;
    }
  }

  private async systemPromptForChat(chatId: string): Promise<string | undefined> {
    const rec = this.chats.find(c => c.id === chatId);
    const projectId = rec?.projectId || '';
    const tiers: string[] = [];
    const globalTier = this.systemPrompts['global'] || DEFAULT_GLOBAL_PROMPT;
    if (globalTier) tiers.push(globalTier);
    if (projectId && this.systemPrompts['project:' + projectId]) {
      tiers.push(this.systemPrompts['project:' + projectId]);
    } else if (projectId) {
      try {
        const proj = await this.projectStore.getProject(projectId);
        if (proj?.systemPrompt) tiers.push(proj.systemPrompt);
      } catch { /* ignore */ }
    }
    const chatPrompt = await this.readChatPrompt(chatId);
    if (chatPrompt) tiers.push(chatPrompt);
    return tiers.join('\n\n---\n\n') || undefined;
  }

  private manualAgentKey(chatId: string, agentId: string): string {
    return `${chatId}:${agentId}`;
  }

  private hasPendingAgentHandoff(messages: ChatMessage[]): boolean {
    const tail = messages[messages.length - 1] as any;
    return tail?.role === 'user' && tail?.kind === 'agent-handoff';
  }

  private renderAgentHandoff(entries: NonNullable<PersistedMessage['agentHandoffs']>, instruction = ''): string {
    const reports = entries.map(entry => [
      `## Submitted agent: ${entry.sourceTask || entry.sourceAgentId}`,
      `Agent ID: ${entry.sourceAgentId}`,
      '',
      entry.text,
    ].join('\n')).join('\n\n---\n\n');
    return [
      '[MANUAL AGENT HANDOFF]',
      'The following reports were submitted manually from direct child agents. Use them as context; do not discuss the handoff mechanism unless asked.',
      '',
      reports,
      ...(instruction.trim() ? ['', '## User instruction', instruction.trim()] : []),
    ].join('\n');
  }

  private async loadAgentSession(chatId: string, agentId: string, model: string): Promise<{ session: ChatSession; store: ChatStore }> {
    const folder = await this.projectFolderFor(chatId);
    const store = new ChatStore(this.sessionsDir, chatId, folder, agentId);
    const session = new ChatSession(
      () => this.proxy.baseUrl(), () => model,
      this.toolRegistry, this.toolExecutor, this.log,
    );
    session.setStore(store);
    const full = await ChatStore.loadAgent(this.sessionsDir, chatId, agentId);
    if (full.length) session.hydrate(full.map(m => ({ ...m })) as any);
    const runtimePath = await store.runtimeFilePath();
    const runtime = await ChatStore.loadRuntime(runtimePath).catch(() => [] as PersistedMessage[]);
    if (runtime.length) session.hydrateRuntime(runtime.map(m => ({ ...m })) as any);
    else if (full.length) {
      session.hydrateRuntime(full.map(m => ({ ...m })) as any);
      await store.overwriteRuntime(full);
    }
    return { session, store };
  }

  private async mergeInstructionIntoPendingHandoff(
    chatId: string,
    targetAgentId: string | undefined,
    session: ChatSession,
    instruction: string,
  ): Promise<void> {
    const fullTail = session.messages[session.messages.length - 1] as any;
    const runtimeTail = session.runtimeMessages[session.runtimeMessages.length - 1] as any;
    if (!this.hasPendingAgentHandoff(session.runtimeMessages)) return;
    const entries = (runtimeTail.agentHandoffs || fullTail?.agentHandoffs || []) as NonNullable<PersistedMessage['agentHandoffs']>;
    const content = this.renderAgentHandoff(entries, instruction);
    runtimeTail.content = content;
    runtimeTail.agentHandoffs = entries;
    if (fullTail?.role === 'user' && fullTail?.kind === 'agent-handoff') {
      fullTail.content = content;
      fullTail.agentHandoffs = entries;
    }
    const store: ChatStore | undefined = (session as any).store;
    if (!store) return;
    const fullPersisted = session.messages.map(m => ({
      ts: (m as any).ts ?? Date.now(), role: m.role, content: m.content,
      ...((m as any).synthetic ? { synthetic: true as const } : {}),
      ...((m as any).kind ? { kind: (m as any).kind } : {}),
      ...((m as any).agentHandoffs ? { agentHandoffs: (m as any).agentHandoffs } : {}),
    }));
    if (targetAgentId) await store.rewriteAgent(fullPersisted as any);
    else await store.rewrite(fullPersisted as any);
    await store.overwriteRuntime(session.runtimeMessages.map(m => ({
      ts: (m as any).ts ?? Date.now(), role: m.role, content: m.content,
      ...((m as any).synthetic ? { synthetic: true as const } : {}),
      ...((m as any).kind ? { kind: (m as any).kind } : {}),
      ...((m as any).agentHandoffs ? { agentHandoffs: (m as any).agentHandoffs } : {}),
    })) as any);
  }

  private async upsertAgentHandoff(
    chatId: string,
    targetAgentId: string | undefined,
    source: AgentNode,
    text: string,
    revision: string,
  ): Promise<boolean> {
    const target = targetAgentId
      ? await this.loadAgentSession(chatId, targetAgentId, (await this.agentRegistryFor(chatId)).get(targetAgentId)?.model || source.model)
      : { session: await this.getSession(chatId), store: undefined as any };
    const session = target.session;
    const fullTail = session.messages[session.messages.length - 1] as any;
    const runtimeTail = session.runtimeMessages[session.runtimeMessages.length - 1] as any;
    let entries: NonNullable<PersistedMessage['agentHandoffs']> = [];
    if (runtimeTail?.role === 'user' && runtimeTail?.kind === 'agent-handoff') {
      entries = [...(runtimeTail.agentHandoffs || [])];
    } else if (fullTail?.role === 'user' && fullTail?.kind === 'agent-handoff') {
      entries = [...(fullTail.agentHandoffs || [])];
    }
    const existing = entries.findIndex(entry => entry.sourceAgentId === source.agentId);
    if (existing >= 0 && entries[existing].revision === revision) return false;
    const entry = { sourceAgentId: source.agentId, sourceTask: source.task, revision, text };
    if (existing >= 0) entries[existing] = entry;
    else entries.push(entry);
    const handoff: ChatMessage = {
      role: 'user', kind: 'agent-handoff', agentHandoffs: entries,
      content: this.renderAgentHandoff(entries),
    };
    if (runtimeTail?.role === 'user' && runtimeTail?.kind === 'agent-handoff') {
      Object.assign(runtimeTail, handoff);
    } else {
      session.runtimeMessages.push({ ...handoff });
    }
    if (fullTail?.role === 'user' && fullTail?.kind === 'agent-handoff') {
      Object.assign(fullTail, handoff);
    } else {
      session.messages.push({ ...handoff });
    }
    const store: ChatStore | undefined = (session as any).store;
    if (!store) throw new Error('target chat store unavailable');
    const fullPersisted = session.messages.map(m => ({
      ts: (m as any).ts ?? Date.now(), role: m.role, content: m.content,
      ...((m as any).synthetic ? { synthetic: true as const } : {}),
      ...((m as any).kind ? { kind: (m as any).kind } : {}),
      ...((m as any).agentHandoffs ? { agentHandoffs: (m as any).agentHandoffs } : {}),
    }));
    if (targetAgentId) await store.rewriteAgent(fullPersisted as any);
    else await store.rewrite(fullPersisted as any);
    await store.overwriteRuntime(session.runtimeMessages.map(m => ({
      ts: (m as any).ts ?? Date.now(), role: m.role, content: m.content,
      ...((m as any).synthetic ? { synthetic: true as const } : {}),
      ...((m as any).kind ? { kind: (m as any).kind } : {}),
      ...((m as any).agentHandoffs ? { agentHandoffs: (m as any).agentHandoffs } : {}),
    })) as any);
    return true;
  }

  private async chatWithAgent(chatId: string, agentId: string, text: string): Promise<{ ok: boolean }> {
    const key = this.manualAgentKey(chatId, agentId);
    if (this.activeRuns.has(chatId)) throw new Error('Orchestrator is currently streaming');
    if (this.manualAgentRuns.has(key)) throw new Error('Agent is already responding');
    const registry = await this.agentRegistryFor(chatId);
    const node = registry.get(agentId);
    if (!node) throw new Error('agent not found');
    if (!['completed', 'released', 'limit_reached', 'error', 'cancelled'].includes(node.status)) {
      throw new Error(`agent is ${node.status}`);
    }
    this.manualAgentRuns.add(key);
    try {
      const { session, store } = await this.loadAgentSession(chatId, agentId, node.model);
      const pending = this.hasPendingAgentHandoff(session.runtimeMessages);
      if (pending) await this.mergeInstructionIntoPendingHandoff(chatId, agentId, session, text);
      this.toolRegistry.setAvailableModels(await this.availableAgentModels());
      const baseSystem = await this.systemPromptForChat(chatId);
      const systemExtra = [
        baseSystem,
        `You are continuing the isolated sub-agent task below in a user-directed manual review turn. Preserve the existing research context. Do not spawn or release agents.\n\nOriginal task: ${node.task}`,
      ].filter(Boolean).join('\n\n---\n\n');
      let failed = '';
      for await (const event of session.send(pending ? '' : text, [], {
        skipUserTurn: pending,
        model: node.model,
        thinking: node.effort === 'off' ? undefined : { effort: node.effort },
        maxIter: node.maxTurns,
        systemExtra,
        toolContext: {
          chatId: `${chatId}.agent-${agentId}`,
          allowAskUser: false,
        },
      })) {
        if (event.type === 'token' || event.type === 'thinking' || event.type === 'sse_raw') {
          registry.publish(node, 'chunk', event);
        } else if (event.type === 'tool-start' || event.type === 'tool-done' || event.type === 'tool-error') {
          registry.publish(node, 'tool', event);
        } else if (event.type === 'usage' && event.usage) {
          node.usage = { ...event.usage };
          node.costUsd = event.costUsd || node.costUsd;
          registry.publish(node, 'usage', { usage: node.usage, costUsd: node.costUsd, contextMax: contextWindowFor(node.model) });
        } else if (event.type === 'error') failed = event.text || 'agent chat failed';
      }
      if (failed) throw new Error(failed);
      let result = '';
      for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].role !== 'assistant') continue;
        result = textOf(session.messages[i].content).trim();
        if (result) break;
      }
      node.result = result;
      node.messages = session.messages;
      await store.updateAgentMeta({ result, usage: node.usage, costUsd: node.costUsd });
      this.broadcast('agents.snapshot', { rootChatId: chatId, agents: registry.snapshot() });
      return { ok: true };
    } finally {
      this.manualAgentRuns.delete(key);
    }
  }

  private async withManualSubmitTarget<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.manualSubmitTargets.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.manualSubmitTargets.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.manualSubmitTargets.get(key) === queued) this.manualSubmitTargets.delete(key);
    }
  }

  private async submitAgentResult(chatId: string, agentId: string, inferTarget = false): Promise<{ ok: boolean; targetAgentId: string | null; unchanged?: boolean; inferred?: boolean }> {
    const key = this.manualAgentKey(chatId, agentId);
    if (this.manualAgentRuns.has(key)) throw new Error('Agent is still responding');
    if (this.manualAgentSubmits.has(key)) throw new Error('Agent submit is already in progress');
    const registry = await this.agentRegistryFor(chatId);
    const node = registry.get(agentId);
    if (!node) throw new Error('agent not found');
    if (!['completed', 'released', 'limit_reached', 'error', 'cancelled'].includes(node.status)) throw new Error(`agent is ${node.status}`);
    if (!node.parentAgentId && this.activeRuns.has(chatId)) throw new Error('Orchestrator is currently streaming');
    this.manualAgentSubmits.add(key);
    try {
      const messages = await ChatStore.loadAgent(this.sessionsDir, chatId, agentId);
      let text = '';
      let sourceIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue;
        text = textOf(messages[i].content).trim();
        if (text) { sourceIndex = i; break; }
      }
      if (!text) throw new Error('No assistant response found to submit');
      const revision = `${sourceIndex}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
      const targetModel = node.parentAgentId
        ? (registry.get(node.parentAgentId)?.model || node.model)
        : String(this.chats.find(c => c.id === chatId)?.model || node.model);
      const targetSession = node.parentAgentId
        ? (await this.loadAgentSession(chatId, node.parentAgentId, targetModel)).session
        : await this.getSession(chatId);
      const siblingCount = Math.max(1, registry.snapshot().filter(n => (n.parentAgentId || '') === (node.parentAgentId || '')
        && ['completed', 'limit_reached', 'error', 'cancelled'].includes(n.status)).length);
      const budget = returnBudget({
        contextMax: contextWindowFor(targetModel),
        runtimeTokens: approxTokensForMsgs(targetSession.runtimeMessages),
        fixedOverheadTokens: this.approxToolTokens(),
        remainingSiblings: siblingCount,
        model: targetModel,
        upstreamBudgetTokens: node.returnBudgetTokens,
      });
      if (budget > 0) text = await this.summarizeAgentReturn(node.task, text, budget, targetModel);
      node.handoffResult = text;
      node.handoffTokens = approxTokensStr(text);
      node.handoffBudgetTokens = budget;
      const store = new ChatStore(this.sessionsDir, chatId, await this.projectFolderFor(chatId), agentId);
      await store.updateAgentMeta({
        handoffResult: text, handoffTokens: node.handoffTokens, handoffBudgetTokens: budget,
      });
      const promotedToOrchestrator: import('./agents/AgentTypes').AgentArtifactRef[] = [];
      if (!node.parentAgentId) {
        const alreadyTransferred = new Set(node.transferredArtifactIds || []);
        for (const artifact of node.artifacts || []) {
          // Skip artifacts already handed to the orchestrator via agent_transfer.
          if (alreadyTransferred.has(String(artifact.id))) continue;
          try {
            const saved = await this.artifactStore.promoteArtifact(chatId, node.agentId, artifact);
            await this.artifactStore.readArtifact(chatId, saved.id); // verify copy
            promotedToOrchestrator.push(this.attachRootArtifact(chatId, saved, artifact.sourceAgentId || node.agentId));
          } catch (e) {
            this.log.warn(`[agents] promote root artifact ${artifact.id}: ${(e as Error).message}`);
          }
        }
        const pinned = await this.pinResultArtifacts(chatId, node);
        promotedToOrchestrator.push(...pinned);
        if (promotedToOrchestrator.length) {
          node.artifacts = [...(node.artifacts || []), ...promotedToOrchestrator];
          const rootSession = this.sessions.get(chatId);
          if (rootSession) await this.persistSession(chatId, rootSession);
        }
      }
      const targetKey = `${chatId}:${node.parentAgentId || 'orchestrator'}`;
      const changed = await this.withManualSubmitTarget(targetKey, () =>
        this.upsertAgentHandoff(chatId, node.parentAgentId, node, text, revision));
      if (changed || promotedToOrchestrator.length) {
        node.submitted = true;
        await store.updateAgentMeta({ submitted: true, ...(node.artifacts?.length ? { artifacts: node.artifacts } : {}) });
      }
      this.broadcast('agent.submitted', {
        rootChatId: chatId, agentId, parentAgentId: node.parentAgentId,
        targetAgentId: node.parentAgentId || null, changed,
      });
      let inferred = false;
      if (changed) {
        this.broadcast('agent.handoffUpdated', {
          rootChatId: chatId, targetAgentId: node.parentAgentId || null,
        });
        if (inferTarget) {
          if (node.parentAgentId) {
            const parent = registry.get(node.parentAgentId);
            if (parent && ['completed', 'limit_reached', 'error', 'cancelled'].includes(parent.status)) {
              await this.chatWithAgent(chatId, node.parentAgentId, 'Please synthesize the submitted report above into your own comprehensive result for this task.');
              parent.submitted = false;
              await new ChatStore(this.sessionsDir, chatId, await this.projectFolderFor(chatId), parent.agentId)
                .updateAgentMeta({ submitted: false });
              inferred = true;
            }
          } else {
            const rootSession = await this.getSession(chatId);
            await this.runManualRootInference(chatId, rootSession, 'Please synthesize the submitted agent report above into a final comprehensive answer for the original task.');
            inferred = true;
          }
        }
      }
      return { ok: true, targetAgentId: node.parentAgentId || null, ...(changed ? {} : { unchanged: true }), ...(inferred ? { inferred: true } : {}) };
    } finally {
      this.manualAgentSubmits.delete(key);
    }
  }

  /** Run one inference turn asking the agent to summarize its entire session.
   *  Uses maxIter:1 and no tools so it never enters a tool loop — summary is always
   *  a direct text response. Streams via agent.chunk/usage events. */
  private async summarizeAgent(chatId: string, agentId: string): Promise<{ ok: boolean }> {
    const key = this.manualAgentKey(chatId, agentId);
    if (this.activeRuns.has(chatId)) throw new Error('Orchestrator is currently streaming');
    if (this.manualAgentRuns.has(key)) throw new Error('Agent is already responding');
    const registry = await this.agentRegistryFor(chatId);
    const node = registry.get(agentId);
    if (!node) throw new Error('agent not found');
    if (!['queued', 'running', 'waiting', 'completed', 'released', 'limit_reached', 'error', 'cancelled'].includes(node.status)) {
      throw new Error(`agent is ${node.status}`);
    }
    this.manualAgentRuns.add(key);
    try {
      const { session, store } = await this.loadAgentSession(chatId, agentId, node.model);
      const baseSystem = await this.systemPromptForChat(chatId);
      const systemExtra = [
        baseSystem,
        `You are writing a final comprehensive summary of your entire work session for this sub-agent task. Do not use tools. Return only your summary text.`,
      ].filter(Boolean).join('\n\n---\n\n');
      const prompt = [
        `Please write a comprehensive summary of your entire work session for this task.`,
        `Summarize ALL your research, findings, analysis, conclusions, and any artifacts or files produced.`,
        `This summary will be submitted to your parent agent/orchestrator as your final report.`,
        `Be thorough and precise: include all conclusions, quantitative results, URLs, file paths, benchmarks, and open questions.`,
        `Do not truncate or leave out important findings. Write the summary as your final deliverable for this task.`,
        ``,
        `Your original task was: ${node.task}`,
      ].join('\n');
      let failed = '';
      for await (const event of session.send(prompt, [], {
        model: node.model,
        thinking: node.effort === 'off' ? undefined : { effort: node.effort },
        maxIter: 1,  // summary is always a direct text reply — no tool loop
        systemExtra,
        toolContext: {
          chatId: `${chatId}.agent-${agentId}`,
          allowAskUser: false,
        },
      })) {
        if (event.type === 'token' || event.type === 'thinking' || event.type === 'sse_raw') {
          registry.publish(node, 'chunk', event);
        } else if (event.type === 'usage' && event.usage) {
          node.usage = { ...event.usage };
          node.costUsd = event.costUsd || node.costUsd;
          registry.publish(node, 'usage', { usage: node.usage, costUsd: node.costUsd, contextMax: contextWindowFor(node.model) });
        } else if (event.type === 'error') failed = event.text || 'summarize failed';
      }
      if (failed) throw new Error(failed);
      let result = '';
      for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].role !== 'assistant') continue;
        result = textOf(session.messages[i].content).trim();
        if (result) break;
      }
      node.result = result;
      node.messages = session.messages;
      await store.updateAgentMeta({ result, usage: node.usage, costUsd: node.costUsd });
      this.broadcast('agents.snapshot', { rootChatId: chatId, agents: registry.snapshot() });
      return { ok: true };
    } finally {
      this.manualAgentRuns.delete(key);
    }
  }

  /** Summarize all leaf agents (no children) sequentially, broadcasting per-agent progress.
   *  Parents are excluded — they will receive child summaries via Submit and can then
   *  synthesize in their own chat turn. */
  private async summarizeAllAgents(chatId: string, runId?: string): Promise<{ ok: boolean; summarized: number; failed: number }> {
    const registry = await this.agentRegistryFor(chatId);
    const allRaw = registry.snapshot();
    const all = runId ? allRaw.filter(a => (a.runId || a.agentId) === runId) : allRaw;
    const hasChildren = new Set(all.map(a => a.parentAgentId).filter(Boolean) as string[]);
    const terminals = all.filter(a =>
      ['completed', 'released', 'limit_reached', 'error', 'cancelled'].includes(a.status) &&
      !hasChildren.has(a.agentId));
    let summarized = 0;
    let failed = 0;
    for (const agent of terminals) {
      this.broadcast('agents.propagation', {
        rootChatId: chatId, phase: 'summarize', agentId: agent.agentId,
        status: 'running', total: terminals.length, done: summarized + failed,
      });
      try {
        await this.summarizeAgent(chatId, agent.agentId);
        summarized++;
        this.broadcast('agents.propagation', {
          rootChatId: chatId, phase: 'summarize', agentId: agent.agentId,
          status: 'done', total: terminals.length, done: summarized + failed,
        });
      } catch (e) {
        failed++;
        this.log.warn(`[agents] summarizeAll ${agent.agentId}: ${(e as Error).message}`);
        this.broadcast('agents.propagation', {
          rootChatId: chatId, phase: 'summarize', agentId: agent.agentId,
          status: 'error', error: (e as Error).message,
          total: terminals.length, done: summarized + failed,
        });
      }
    }
    return { ok: true, summarized, failed };
  }

  /** Bottom-up automated cascade:
   *  1. Each leaf submits to its direct parent.
   *  2. When a parent has received handoffs from ALL direct children, it inferences (synthesize).
   *  3. Parent result submitted up. Repeats until root → orchestrator.
   *  4. Orchestrator inferences final answer. */
  private async submitAllAgents(chatId: string, runId?: string): Promise<{ ok: boolean; submitted: number; failed: number }> {
    const key = runId ? `${chatId}:${runId}` : chatId;
    const existing = this.submitAllRuns.get(key);
    if (existing) return existing;
    const run = this.submitAllAgentsOnce(chatId, runId).finally(() => this.submitAllRuns.delete(key));
    this.submitAllRuns.set(key, run);
    return run;
  }

  private async submitAllAgentsOnce(chatId: string, runId?: string): Promise<{ ok: boolean; submitted: number; failed: number }> {
    const registry = await this.agentRegistryFor(chatId);
    const allRaw = registry.snapshot();
    const all = runId ? allRaw.filter(a => (a.runId || a.agentId) === runId) : allRaw;
    let submitted = 0;
    let failed = 0;

    const childrenOf = new Map<string | null, string[]>();
    for (const a of all) {
      const p = a.parentAgentId || null;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p)!.push(a.agentId);
    }

    const isTerminal = (id: string) => {
      const a = registry.get(id);
      return !!a && ['completed', 'released', 'limit_reached', 'error', 'cancelled'].includes(a.status);
    };

    /** BFS levels bottom-up: leaves first. */
    const orderedLevels: string[][] = [];
    const visited = new Set<string>();
    const leaves = all.filter(a => !childrenOf.has(a.agentId) || childrenOf.get(a.agentId)!.length === 0);
    let currentLevel = leaves.map(a => a.agentId);
    while (currentLevel.length) {
      orderedLevels.push(currentLevel);
      currentLevel.forEach(id => visited.add(id));
      const nextSet = new Set<string>();
      for (const id of currentLevel) {
        const parentId = registry.get(id)?.parentAgentId;
        if (parentId && !visited.has(parentId)) nextSet.add(parentId);
      }
      currentLevel = [...nextSet];
    }

    for (const level of orderedLevels) {
      const changedTargets = new Set<string | null>();
      // Submit all agents at this level
      for (const agentId of level) {
        if (!isTerminal(agentId)) continue;
        this.broadcast('agents.propagation', {
          rootChatId: chatId, phase: 'submit', agentId,
          status: 'running', done: submitted + failed,
        });
        try {
          const key = this.manualAgentKey(chatId, agentId);
          if (this.manualAgentRuns.has(key)) continue;
          const node = registry.get(agentId);
          if (node?.submitted) continue;
          const result = await this.submitAgentResult(chatId, agentId, false);
          if (!result.unchanged) {
            submitted++;
            changedTargets.add(result.targetAgentId);
          }
          this.broadcast('agents.propagation', {
            rootChatId: chatId, phase: 'submit', agentId, status: 'done', done: submitted + failed,
          });
        } catch (e) {
          failed++;
          this.log.warn(`[agents] submitAll submit ${agentId}: ${(e as Error).message}`);
          this.broadcast('agents.propagation', {
            rootChatId: chatId, phase: 'submit', agentId,
            status: 'error', error: (e as Error).message, done: submitted + failed,
          });
        }
      }

      // Only infer targets whose handoff changed in this pass; repeated Submit All
      // should not re-run old handoffs that were already delivered.
      const parentsToInfer = changedTargets;
      for (const parentId of parentsToInfer) {
        if (!parentId) {
          // Root level submitted — inference orchestrator
          this.broadcast('agents.propagation', {
            rootChatId: chatId, phase: 'orchestrator-inference', status: 'running', done: submitted + failed,
          });
          try {
            // Load orchestrator session and check for pending handoff
            const session = await this.getSession(chatId);
            if (this.hasPendingAgentHandoff(session.runtimeMessages)) {
              const synth = 'Please synthesize the submitted agent reports above into a final comprehensive answer for the original task.';
              await this.runManualRootInference(chatId, session, synth);
              this.broadcast('agents.propagation', {
                rootChatId: chatId, phase: 'orchestrator-inference', status: 'done', done: submitted + failed,
              });
            }
          } catch (e) {
            failed++;
            this.log.warn(`[agents] submitAll orchestrator inference: ${(e as Error).message}`);
            this.broadcast('agents.propagation', {
              rootChatId: chatId, phase: 'orchestrator-inference',
              status: 'error', error: (e as Error).message, done: submitted + failed,
            });
          }
        } else {
          // Parent agent — inference to synthesize children handoffs
          if (!isTerminal(parentId)) continue;
          this.broadcast('agents.propagation', {
            rootChatId: chatId, phase: 'parent-inference', agentId: parentId,
            status: 'running', done: submitted + failed,
          });
          try {
            const { session } = await this.loadAgentSession(chatId, parentId,
              registry.get(parentId)!.model);
            if (this.hasPendingAgentHandoff(session.runtimeMessages)) {
              const synth = 'Please synthesize the submitted reports from your direct child agents above into your own comprehensive result for this task.';
              await this.chatWithAgent(chatId, parentId, synth);
              const parentNode = registry.get(parentId);
              if (parentNode) {
                parentNode.submitted = false;
                await new ChatStore(this.sessionsDir, chatId, await this.projectFolderFor(chatId), parentId)
                  .updateAgentMeta({ submitted: false });
              }
              this.broadcast('agents.propagation', {
                rootChatId: chatId, phase: 'parent-inference', agentId: parentId,
                status: 'done', done: submitted + failed,
              });
            }
          } catch (e) {
            failed++;
            this.log.warn(`[agents] submitAll parent inference ${parentId}: ${(e as Error).message}`);
            this.broadcast('agents.propagation', {
              rootChatId: chatId, phase: 'parent-inference', agentId: parentId,
              status: 'error', error: (e as Error).message, done: submitted + failed,
            });
          }
        }
      }
    }
    return { ok: true, submitted, failed };
  }

  /** Get-or-create the ChatSession for a chatId. Hydrates from JSONL on
   *  first request so the model sees prior turns. */
  private async getSession(chatId: string): Promise<ChatSession> {
    let s = this.sessions.get(chatId);
    if (s) return s;
    s = this.makeSession();
    const folder = await this.projectFolderFor(chatId);
    const store = new ChatStore(this.sessionsDir, chatId, folder);
    s.setStore(store);
    // Hydrate the full cross-folder history (a chat that moved between
    // projects may have JSONL files in multiple folders) — walks every dir.
    const msgs = await ChatStore.loadByChatId(this.sessionsDir, chatId).catch(() => [] as any[]);
    if (msgs.length) s.hydrate(msgs.map(m => ({ role: m.role, content: m.content, synthetic: (m as any).synthetic, kind: (m as any).kind, ts: (m as any).ts })));
    // 0.4.217 — hydrate the runtime message list separately. Runtime lives
    // in <chat>.runtime.jsonl. If it exists, load it verbatim; if not,
    // migrate from full history (with optional .compact.md merge as a
    // compact-summary turn at the head).
    const runtimePath = await ChatStore.runtimeFileForChatId(this.sessionsDir, chatId);
    if (runtimePath) {
      const rMsgs = await ChatStore.loadRuntime(runtimePath).catch(() => [] as any[]);
      if (rMsgs.length) {
        s.hydrateRuntime(rMsgs.map(m => ({ role: m.role, content: m.content, synthetic: (m as any).synthetic, kind: (m as any).kind, ts: (m as any).ts })));
      }
    } else if (msgs.length) {
      // First-touch: build runtime from full history (+ legacy compact note).
      await this.buildInitialRuntime(chatId, s, msgs);
    }
    this.sessions.set(chatId, s);
    return s;
  }

  /** 0.4.217 — migration: chat has full history but no runtime file yet.
   *  If a legacy .compact.md exists, prepend it as a compact-summary user
   *  turn at the head of the runtime, followed by the raw tail after
   *  `compactedUpTo`. Otherwise runtime = full history verbatim. Deletes
   *  the legacy .compact.md once migrated. */
  private async buildInitialRuntime(chatId: string, session: ChatSession, fullMsgs: any[]): Promise<void> {
    const rec = this.chats.find(c => c.id === chatId);
    const legacyNote = await this.readLegacyCompactNote(chatId);
    const runtimeMsgs: ChatMessage[] = [];
    if (legacyNote) {
      const boundary = Math.max(0, Math.min(rec?.compactedUpTo ?? 0, fullMsgs.length));
      runtimeMsgs.push({
        role: 'user',
        content: `[COMPACT SUMMARY]\n${legacyNote}`,
        synthetic: true,
      });
      for (let i = boundary; i < fullMsgs.length; i++) {
        runtimeMsgs.push({
          role: fullMsgs[i].role,
          content: fullMsgs[i].content,
          ...((fullMsgs[i] as any).synthetic ? { synthetic: true } : {}),
        });
      }
    } else {
      for (const m of fullMsgs) {
        runtimeMsgs.push({
          role: m.role,
          content: m.content,
          ...((m as any).synthetic ? { synthetic: true } : {}),
        });
      }
    }
    await session.replaceRuntime(runtimeMsgs);
    if (legacyNote) {
      try { await fs.unlink(await this.legacyCompactPath(chatId)); }
      catch { /* ignore */ }
    }
  }

  /** Discover the proxy's visualise-endpoint token. The proxy now runs as a
   *  plain local process (not a container), so its token file lives on the
   *  same filesystem — no docker exec needed. */
  private async refreshToken() {
    if (!this.proxy.isReady()) return;
    try {
      const t = (await fs.readFile('/tmp/aura-visualise-token', 'utf8')).trim();
      if (t) this.imageToken = t;
    } catch (e) {
      this.log.warn(`[chat-v2] token discovery: ${(e as Error).message}`);
    }
  }

  /** Persist chat metadata + settings sidecar. */
  private async saveMeta() {
    try {
      await fs.mkdir(path.dirname(this.metaFile), { recursive: true });
      await fs.writeFile(this.metaFile, JSON.stringify({
        chats:            this.chats,
        pricingOverrides:   this.pricingOverrides,
        systemPrompts:      this.systemPrompts,
        unavailableModels:  this.unavailableModels,
        theme:              this.theme,
      }, null, 2), 'utf8');
    } catch (e) {
      this.log.warn(`[chat-v2] saveMeta: ${(e as Error).message}`);
    }
  }

  /** 0.4.66 — one-shot migration: pre-0.4.66 stored every JSONL flat
   *  at chat-sessions/. We now group them into per-project folders
   *  (and _orphan for unfiled chats). Runs once per dataRoot — guarded
   *  by a marker file. */
  private async migrateFlatToProjectFolders() {
    const marker = path.join(path.dirname(this.metaFile), '.chat-sessions-v0.4.66');
    try { await fs.access(marker); return; } catch { /* needs migrating */ }

    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    } catch {
      try { await fs.mkdir(path.dirname(marker), { recursive: true }); await fs.writeFile(marker, ''); } catch { /* ignore */ }
      return;
    }
    const flatFiles = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => e.name);
    if (!flatFiles.length) {
      try { await fs.writeFile(marker, ''); } catch { /* ignore */ }
      return;
    }

    let sidToName: Record<string, string> = {};
    try { sidToName = await this.projectStore.sessionToProjectName(); } catch { /* unfiled is fine */ }

    let moved = 0;
    for (const name of flatFiles) {
      const id = name.replace(/\.jsonl$/, '').split('_').pop() || '';
      const folder = sanitizeProjectFolder(sidToName[id]);
      const src = path.join(this.sessionsDir, name);
      const dstDir = path.join(this.sessionsDir, folder);
      const dst = path.join(dstDir, name);
      try {
        await fs.mkdir(dstDir, { recursive: true });
        await fs.rename(src, dst);
        moved++;
      } catch (e) {
        this.log.warn(`[chat-v2] migrate ${name} → ${folder}: ${(e as Error).message}`);
      }
    }
    try { await fs.writeFile(marker, String(moved)); } catch { /* ignore */ }
    if (moved) this.log.info(`[chat-v2] migrated ${moved} flat JSONL → per-project folders`);
  }

  /** Rename a single project's folder when its display name changes.
   *  Folder collision → suffix " (2)", " (3)" until unique. */
  private async renameProjectFolder(oldName: string, newName: string): Promise<void> {
    const oldFolder = sanitizeProjectFolder(oldName);
    const newFolderBase = sanitizeProjectFolder(newName);
    if (oldFolder === newFolderBase) return;
    const oldDir = path.join(this.sessionsDir, oldFolder);
    try { await fs.access(oldDir); } catch { return; }
    let candidate = newFolderBase;
    let suffix = 2;
    while (true) {
      const dst = path.join(this.sessionsDir, candidate);
      try { await fs.access(dst); candidate = `${newFolderBase} (${suffix++})`; }
      catch { break; }
    }
    try {
      await fs.rename(oldDir, path.join(this.sessionsDir, candidate));
    } catch (e) {
      this.log.warn(`[chat-v2] renameProjectFolder ${oldFolder} → ${candidate}: ${(e as Error).message}`);
    }
  }

  /** Move every file in a project's folder into _orphan, then remove
   *  the (now empty) folder. Called when the project itself is deleted. */
  private async dissolveProjectFolder(name: string): Promise<void> {
    const folder = sanitizeProjectFolder(name);
    if (folder === ORPHAN_FOLDER) return;
    const dir = path.join(this.sessionsDir, folder);
    let files: string[] = [];
    try { files = await fs.readdir(dir); } catch { return; }
    const orphan = path.join(this.sessionsDir, ORPHAN_FOLDER);
    try { await fs.mkdir(orphan, { recursive: true }); } catch { /* ignore */ }
    for (const name of files) {
      try { await fs.rename(path.join(dir, name), path.join(orphan, name)); }
      catch (e) { this.log.warn(`[chat-v2] dissolve move ${name}: ${(e as Error).message}`); }
    }
    try { await fs.rmdir(dir); } catch { /* ignore */ }
  }

  /** Read the sidecar; reconcile against actual JSONL files on disk so a
   *  hand-deleted file doesn't leave a ghost entry in the rail. */
  private async loadMeta(broadcast = true) {
    await this.migrateFlatToProjectFolders();
    let parsed: any = {};
    try {
      const raw = await fs.readFile(this.metaFile, 'utf8');
      parsed = JSON.parse(raw);
    } catch { /* first run — empty */ }
    this.chats            = Array.isArray(parsed.chats) ? parsed.chats : [];
    this.pricingOverrides = parsed.pricingOverrides && typeof parsed.pricingOverrides === 'object'
      ? parsed.pricingOverrides : {};
    this.systemPrompts    = parsed.systemPrompts && typeof parsed.systemPrompts === 'object'
      ? parsed.systemPrompts : {};
    this.unavailableModels = Array.isArray(parsed.unavailableModels)
      ? parsed.unavailableModels.map(String).filter(Boolean) : [];
    this.theme            = typeof parsed.theme === 'string' ? parsed.theme : 'claude';

    // Reconcile: drop chats whose JSONL no longer exists, add chats whose
    // JSONL is on disk but missing from meta (panel migration).
    const onDisk = await ChatStore.listSessions(this.sessionsDir).catch(() => [] as any[]);
    // Keep metadata-only chats too: a newly-created chat in another VS Code
    // window has a chat-meta entry before it has any JSONL turns. Dropping
    // records that are not yet on disk made cross-window New Chat sync fail
    // until the user switched sessions or sent a message.
    for (const s of onDisk as any[]) {
      if (!this.chats.find(c => c.id === s.id)) {
        this.chats.push({
          id:        s.id,
          projectId: '',
          title:     s.title || 'New chat',
          model:     'claude-opus-4-7',
          createdAt: s.mtime || Date.now(),
          updatedAt: s.mtime || Date.now(),
        });
      }
    }
    // Pull project assignments from the JSON ProjectStore so a chat's
    // projectId stays in sync even if meta was stale.
    try {
      const map = await this.projectStore.sessionsByProject();
      const sidToPid: Record<string, string> = {};
      for (const [pid, sids] of Object.entries(map)) for (const sid of sids) sidToPid[sid] = pid;
      for (const c of this.chats) c.projectId = sidToPid[c.id] || '';
    } catch { /* projectStore can fail on first run; ignore */ }
    await this.saveMeta();
    if (broadcast) {
      this.broadcast('state.invalidate', { scope: 'chats' });
      this.broadcast('state.invalidate', { scope: 'projects' });
    }
  }

  /* ─────────── webview message dispatch ─────────── */

  addBrowserSink(id: string, cb: (envelope: any) => void) {
    this.browserSinks.set(id, cb);
  }

  removeBrowserSink(id: string) {
    this.browserSinks.delete(id);
  }

  async handleBrowserMessage(msg: any) {
    this.handlingBrowserMessage = true;
    try { await this.handle(msg); }
    finally { this.handlingBrowserMessage = false; }
  }

  private send(envelope: any) {
    for (const cb of this.browserSinks.values()) {
      try { cb(envelope); }
      catch { /* drop broken browser sink on its own close event */ }
    }
  }

  /** Send a one-off broadcast (no reply). */
  private broadcast(type: string, payload: any) {
    this.send({ type, payload });
  }

  /** Reply to a webview RPC — `data` lands as `reply.data` in the rpc()
   *  Promise resolver. Pass `{ error: '...' }` to flag an error inline. */
  private reply(requestId: string | undefined, data: any) {
    if (!requestId) return;
    this.send({ type: 'reply', requestId, data });
  }

  private async handle(msg: any) {
    if (!msg || typeof msg.type !== 'string') return;
    const { type, requestId, payload } = msg;
    if (this.handlingBrowserMessage && (type === 'attach.pickFromHost' || type === 'attach.pickFromHostPath')) {
      this.reply(requestId, { cancelled: true });
      return;
    }
    try {
      const data = await this.dispatch(type, payload || {});
      this.reply(requestId, data);
    } catch (e) {
      this.log.warn(`[chat-v2] ${type} threw: ${(e as Error).message}`);
      this.reply(requestId, { error: (e as Error).message });
    }
  }

  /* ── host state (containers + credentials), for the Settings panel ── */

  private credsSnapshot() {
    const keys = this.env.getKeys();
    return {
      path:   this.env.getPath() ?? null,
      loaded: ENV_KEY_WHITELIST.filter(k => !!keys[k]).length,
      total:  ENV_KEY_WHITELIST.length,
    };
  }

  /** Full snapshot the Settings cards render from — container status per
   *  service (matching the sidebar's adopt-aware logic) + creds + preset +
   *  whether this origin may drive controls (false in the browser). */
  private async hostState() {
    // The proxy is a plain local process now (see ProxyProcessManager), not
    // a docker-compose service — report its status directly instead of
    // looking it up via ContainerLifecycle. Sandbox/sandbox-dev stay real,
    // optional docker-compose services, so their lookup is unchanged.
    const proxyState = {
      name:      this.proxy.isReady() ? 'aether-proxy (local process)' : null,
      hasImage:  true,
      imageTag:  null as string | null,
      port:      this.proxy.getPort(),
      ready:     this.proxy.isReady(),
      adopted:   false,
      available: true,
    };
    const [containers, images] = await Promise.all([
      this.lifecycle.listContainers(),
      this.lifecycle.listImages(),
    ]);
    const stateFor = async (svc: 'sandbox' | 'sandbox-dev') => {
      const img = images.find(i => i.service === svc) ?? null;
      const mgrPort = svc === 'sandbox-dev' ? (this.sandboxDev?.getPort() ?? 0) : (this.sandbox?.getPort() ?? 0);
      let ctr: (typeof containers)[number] | null = null;
      let adopted = false;
      if (mgrPort > 0) {
        ctr = containers.find(c => c.service === svc && c.ports.includes(mgrPort)) ?? null;
        if (ctr && !ctr.owned) adopted = true;
      }
      if (!ctr) {
        ctr = containers.find(c => c.service === svc && c.owned && c.ports.length)
            ?? containers.find(c => c.service === svc && c.owned) ?? null;
      }
      const port  = ctr?.ports[0] ?? mgrPort;
      const ready = port > 0 ? await this.lifecycle.probePort(svc, port, 3000) : false;
      return {
        name:     ctr?.name ?? null,
        hasImage: !!img,
        imageTag: img ? `${img.repo}:${img.tag}` : null,
        port, ready, adopted,
        available: svc === 'sandbox-dev' ? !!this.sandboxDev : !!this.sandbox,
      };
    };
    const presetData = await this.preset.load().catch(() => null);
    return {
      proxy:         proxyState,
      sandbox:       await stateFor('sandbox'),
      'sandbox-dev': await stateFor('sandbox-dev'),
      presetFile:    this.preset.file,
      presetName:    presetData?.preset?.name || 'linux',
      creds:         this.credsSnapshot(),
      canControl:    !this.handlingBrowserMessage,
    };
  }

  /** Persist the chosen env-file path to <dataRoot>/env-config.json so it
   *  reloads on next activation (same file extension.ts reads at startup). */
  private async persistEnvPath(p: string | undefined) {
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(await fs.readFile(this.paths.envConfigFile, 'utf8')); } catch { /* first run */ }
    if (p) cur.envFilePath = p; else delete cur.envFilePath;
    await fs.mkdir(this.paths.dataRoot, { recursive: true });
    await fs.writeFile(this.paths.envConfigFile, JSON.stringify(cur, null, 2));
  }

  private async dispatch(type: string, p: any): Promise<any> {
    switch (type) {
      /* ── debug: webview → OUTPUT channel (v0.4.300 artifact trace) ── */
      case 'debug.log':
        this.log.info(`[webview] ${String(p.msg ?? '')}`);
        return { ok: true };

      /* ── boot + state ───────────────────────────────────────── */
      case 'app.ready': {
        const ready = this.proxy.isReady();
        const url = ready ? this.proxy.baseUrl() : '';
        const port = url.match(/:(\d+)/)?.[1] ?? '';
        return {
          theme: this.theme,
          cfg: {
            artifactPanel:  'auto',
            pyodideEnabled: false,   // we don't wire python_browser yet
          },
          proxy: { ready, url, port },
          activeChatId: this.activeChatId || undefined,
        };
      }

      case 'chat.activeIds':
        // Surface every chat whose ChatSession is alive — webview uses
        // this on panel re-open to repaint Stop/Send buttons accurately.
        return {
          chatIds: Array.from(this.activeRuns),
          queuedByChat: Object.fromEntries([...this.queuedSend.entries()].map(([id, q]) => [id, String(q.text || '').slice(0, 160)])),
        };

      /* ── config ─────────────────────────────────────────────── */
      case 'config.uiModels': {
        // 0.4.197 — hand the frontend the model dropdown list from
        // host.yaml so a single YAML edit adds/removes models without
        // touching TS/HTML.
        const preset = await this.preset.load();
        const unavailable = new Set(this.unavailableModels);
        return { models: preset.uiModels || [], unavailableModels: [...unavailable] };
      }
      case 'config.unavailableModels':
        return { unavailableModels: [...this.unavailableModels] };
      case 'config.setModelUnavailable': {
        const id = String(p.id || '').trim();
        if (!id) throw new Error('model id required');
        const unavailable = !!p.unavailable;
        const set = new Set(this.unavailableModels);
        if (unavailable) set.add(id); else set.delete(id);
        this.unavailableModels = [...set].sort();
        await this.saveMeta();
        return { ok: true, unavailableModels: [...this.unavailableModels] };
      }

      /* ── host: containers / credentials / excalidraw ──────────
       *  Mirrors the VS Code sidebar so the same controls work from the
       *  chat Settings panel (and, later, the Cloudflare browser client).
       *  Destructive/native ops are gated to the VS Code webview via
       *  `handlingBrowserMessage` — the browser sees status but can't
       *  build/purge/pick-files. JWT set is allowed from both (validated
       *  server-side, never logged). */
      case 'host.state':
        return this.hostState();

      case 'host.listProxies': {
        const list = await this.lifecycle.listContainers();
        const running = list
          .filter(c => c.service === 'proxy' && c.ports.length && /up/i.test(c.status))
          .map(c => ({ name: c.name, port: c.ports[0], owned: c.owned }));
        return { containers: running };
      }

      case 'host.action': {
        if (this.handlingBrowserMessage) return { error: 'Container controls are available only in the VS Code panel.' };
        const svc = String(p.svc || '') as Service;
        const op  = String(p.op || '');
        if (!['proxy', 'sandbox', 'sandbox-dev'].includes(svc)) return { error: `bad service: ${svc}` };
        const mgr = svc === 'proxy' ? this.proxy : svc === 'sandbox-dev' ? this.sandboxDev : this.sandbox;
        switch (op) {
          case 'build':   await this.lifecycle.buildImage(svc); break;
          case 'install': if (!mgr) return { error: `${svc} manager unavailable` }; await mgr.ensure(true); break;
          case 'stop':    if (!mgr) return { error: `${svc} manager unavailable` }; await mgr.stop(); break;
          case 'remove':
            await this.lifecycle.removeContainer(svc);
            if (svc === 'proxy') this.proxy.forceKill(false);
            break;
          case 'removeImage':
            await this.lifecycle.removeContainer(svc);
            if (svc === 'proxy') this.proxy.forceKill(false);
            await this.lifecycle.removeImage(svc);
            break;
          case 'purge':
            await this.lifecycle.purge(svc);
            if (svc === 'proxy') this.proxy.forceKill(false);
            break;
          default: return { error: `unknown op: ${op}` };
        }
        const state = await this.hostState();
        this.broadcast('host.state', state);
        return { ok: true, state };
      }

      case 'host.connect': {
        if (this.handlingBrowserMessage) return { error: 'Connect is available only in the VS Code panel.' };
        const port = Number(p.port);
        if (!port || !Number.isFinite(port)) return { error: 'port required' };
        await this.proxy.adopt(port);
        const state = await this.hostState();
        this.broadcast('host.state', state);
        return { ok: true, state };
      }

      case 'host.getProvider': {
        // Report which upstream the proxy is currently routing to (view-only, any origin).
        try {
          const res = await fetch(`${this.proxy.baseUrl()}/admin/provider`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) return { error: `proxy returned ${res.status}` };
          return await res.json();
        } catch (e: any) {
          return { error: String(e?.message || e) };
        }
      }

      case 'host.setProvider': {
        // Switch the proxy's UPSTREAM (default | openai | anthropic). This
        // is the app's only way to connect a model — every client is a
        // browser client now, so (unlike upstream AURA) this is never gated.
        const mode = String(p.mode || 'default');
        if (!['default', 'openai', 'anthropic'].includes(mode)) return { error: `bad mode: ${mode}` };
        const body: any = { mode };
        if (mode !== 'default') {
          const url = String(p.url || '').trim();
          if (!url) return { error: 'URL required' };
          body.base_url = url;
          body.api_key = String(p.key || '');   // never logged
        }
        try {
          const res = await fetch(`${this.proxy.baseUrl()}/admin/provider`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          });
          const data: any = await res.json().catch(() => ({}));
          if (!res.ok) return { error: (data && data.error) || `proxy returned ${res.status}` };
          return data;   // { ok, mode, base_url, models }
        } catch (e: any) {
          return { error: String(e?.message || e) };
        }
      }

      case 'host.getMineruUrl': {
        return { url: (await this.runtimeConfig.load()).mineruUrl };
      }

      case 'host.setMineruUrl': {
        const url = String(p.url || '').trim();
        await this.runtimeConfig.save({ mineruUrl: url });
        this.proxy.setMineruUrl(url);
        // MinerU MCP reads MINERU_API_URL once at process start, so the new
        // value only takes effect after a restart — mirrors how upstream
        // AURA recreates the whole proxy container on a host.yaml mineru
        // change.
        if (this.proxy.isReady()) await this.proxy.restart().catch(e =>
          this.log.warn(`[chat-v2] proxy restart after mineru url change: ${(e as Error).message}`));
        return { ok: true };
      }

      case 'host.presetEdit': {
        return { error: 'Editing the preset file directly is not supported in this app — use Settings.' };
      }

      case 'host.presetReset': {
        let raw = '';
        try { raw = await fs.readFile(this.paths.bundledPresetFile, 'utf8'); } catch { /* fall back to no-op */ }
        if (raw) await this.preset.writeRaw(raw);
        return { ok: true };
      }

      case 'host.pickEnvFile': {
        // No native file dialog standalone — the browser has no filesystem
        // access. Point users at a .env file next to the app instead (see
        // README); this RPC becomes a silent no-op like the attach picker.
        return { cancelled: true };
      }

      case 'host.clearEnvFile': {
        this.env.clear();
        await this.persistEnvPath(undefined);
        return { ok: true, creds: this.credsSnapshot() };
      }

      case 'host.excalidrawStart':
      case 'host.excalidrawStop':
      case 'host.excalidrawOpen': {
        return { error: 'Excalidraw board control is not available in this build.' };
      }

      /* ── projects ───────────────────────────────────────────── */
      case 'projects.list': {
        const projs = await this.projectStore.listProjects();
        // 0.4.189 — prepend the virtual "Orphan" project so the rail can
        // render it as a first-class row. The virtual id `__orphan__` is
        // recognized by chats.listByProject (see below) and rejected by
        // projects.rename/delete so users can't destroy it.
        const orphan = {
          id:           '__orphan__',
          name:         'Orphan',
          color:        '',
          systemPrompt: '',
          isVirtual:    true,
          canDelete:    false,
        };
        return [
          orphan,
          ...projs.map(p => ({
            id:           p.id,
            name:         p.name,
            color:        (p as any).color || '',
            systemPrompt: p.systemPrompt || '',
          })),
        ];
      }
      case 'projects.create': {
        const name = String(p.name ?? '').trim() || 'New project';
        const proj = await this.projectStore.createProject(name, p.systemPrompt || '');
        this.broadcast('state.invalidate', { scope: 'projects' });
        return { id: proj.id, name: proj.name, color: '', systemPrompt: proj.systemPrompt || '' };
      }
      case 'projects.rename': {
        if (!p.id) throw new Error('id required');
        if (p.id === '__orphan__') {
          throw new Error('Orphan is a system project — cannot be renamed.');
        }
        const prev = await this.projectStore.getProject(p.id);
        const updated = await this.projectStore.updateProject(p.id, { name: String(p.name || '').trim() || 'Project' });
        if (!updated) throw new Error('project not found');
        if (prev && prev.name !== updated.name) {
          await this.renameProjectFolder(prev.name, updated.name);
        }
        this.broadcast('state.invalidate', { scope: 'projects' });
        return { ok: true };
      }
      case 'projects.delete': {
        if (!p.id) throw new Error('id required');
        if (p.id === '__orphan__') {
          throw new Error('Orphan is a system project — cannot be deleted. Delete the individual chats inside it instead.');
        }
        const proj = await this.projectStore.getProject(p.id);
        // 0.4.176 — cascade: chats of this project (+ their JSONL,
        // systemnote, systemprompt, artifact cache dirs) are deleted
        // along with the project itself. claude-mem observations live
        // outside this scope and are intentionally preserved.
        const projectChatIds = this.chats.filter(c => c.projectId === p.id).map(c => c.id);
        for (const cid of projectChatIds) {
          const sess = this.sessions.get(cid);
          if (sess) { sess.cancel(); this.sessions.delete(cid); }
          const agents = this.agentRegistries.get(cid);
          if (agents) { agents.cancelAll(); this.agentRegistries.delete(cid); }
          this.agentRegistryInit.delete(cid);
          const files = await ChatStore.filesForChatId(this.sessionsDir, cid).catch(() => [] as string[]);
          const agentFiles = await ChatStore.agentFilesForChatId(this.sessionsDir, cid).catch(() => [] as string[]);
          for (const f of [...files, ...agentFiles]) {
            try { await fs.unlink(f); } catch { /* ignore */ }
            try { await fs.unlink(f.replace(/\.jsonl$/, '.runtime.jsonl')); } catch { /* ignore */ }
          }
          try { await fs.unlink(await this.legacyCompactPath(cid)); } catch { /* ignore */ }
          try { await fs.unlink(this.chatPromptPath(cid)); } catch { /* ignore */ }
          try { await fs.rm(path.join(this.imagesDir, cid), { recursive: true, force: true }); } catch { /* ignore */ }
          try { await fs.rm(path.join(this.paths.dataRoot, 'chat-artifacts', cid), { recursive: true, force: true }); } catch { /* ignore */ }
          try { await fs.rm(path.join(this.paths.dataRoot, 'excalidraw-captures', cid), { recursive: true, force: true }); } catch { /* ignore */ }
          try { await fs.rm(path.join(this.attachmentsDir, cid), { recursive: true, force: true }); } catch { /* ignore */ }
          try { await this.projectStore.assignSession(cid, ''); } catch { /* ignore */ }
          if (this.activeChatId === cid) this.activeChatId = '';
        }
        this.chats = this.chats.filter(c => c.projectId !== p.id);
        await this.projectStore.deleteProject(p.id);
        if (proj) await this.dissolveProjectFolder(proj.name);
        await this.saveMeta();
        this.broadcast('state.invalidate', { scope: 'projects' });
        this.broadcast('state.invalidate', { scope: 'chats' });
        return { ok: true };
      }

      /* ── chats ──────────────────────────────────────────────── */
      case 'chats.recent': {
        const limit = Number(p.limit ?? 50);
        await this.loadMeta(false);
        return this.chats
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit);
      }
      case 'chats.listByProject': {
        const pid = String(p.projectId ?? '');
        await this.loadMeta(false);
        // 0.4.189 — `__orphan__` is the virtual project; return every chat
        // whose real projectId is empty (or the same sentinel, in case
        // someone typed it manually).
        return this.chats
          .filter(c => pid === '__orphan__'
            ? (!c.projectId || c.projectId === '__orphan__')
            : c.projectId === pid)
          .sort((a, b) => b.updatedAt - a.updatedAt);
      }
      case 'chats.create': {
        const id = randomUUID();
        const now = Date.now();
        const rec: ChatRecord = {
          id,
          projectId: String(p.projectId ?? ''),
          title:     String(p.title ?? '').trim() || 'New chat',
          model:     String(p.model ?? 'claude-opus-4-7'),
          createdAt: now,
          updatedAt: now,
        };
        this.chats.push(rec);
        if (rec.projectId) {
          try { await this.projectStore.assignSession(id, rec.projectId); }
          catch (e) { this.log.warn(`[chat-v2] assignSession on create: ${(e as Error).message}`); }
        }
        await this.saveMeta();
        this.broadcast('state.invalidate', { scope: 'chats' });
        return rec;
      }
      case 'chats.delete': {
        if (!p.id) throw new Error('id required');
        const chatId = String(p.id);
        const idx = this.chats.findIndex(c => c.id === chatId);
        if (idx >= 0) this.chats.splice(idx, 1);

        // Stop live writers before unlinking files. If an active stream/session
        // flushes after deletion it can recreate the JSONL, then loadMeta()
        // discovers it again and the chat appears to need deleting twice.
        const sess = this.sessions.get(chatId);
        if (sess) { sess.cancel(); this.sessions.delete(chatId); }
        const agents = this.agentRegistries.get(chatId);
        if (agents) { agents.cancelAll(); this.agentRegistries.delete(chatId); }
        if (this.activeChatId === chatId) this.activeChatId = '';

        // Drop every JSONL file for this chatId (a chat that spanned
        // midnight has multiple) + sibling system files.
        const files = await ChatStore.filesForChatId(this.sessionsDir, chatId).catch(() => [] as string[]);
        for (const f of files) {
          try { await fs.unlink(f); } catch { /* ignore */ }
          try { await fs.unlink(f.replace(/\.jsonl$/, '.runtime.jsonl')); } catch { /* ignore */ }
        }
        const agentFiles = await ChatStore.agentFilesForChatId(this.sessionsDir, chatId).catch(() => [] as string[]);
        for (const f of agentFiles) {
          try { await fs.unlink(f); } catch { /* ignore */ }
          try { await fs.unlink(f.replace(/\.jsonl$/, '.runtime.jsonl')); } catch { /* ignore */ }
        }
        try { await fs.unlink(await this.legacyCompactPath(chatId)); } catch { /* ignore */ }
        try { await fs.unlink(this.chatPromptPath(chatId)); } catch { /* ignore */ }
        try { await fs.rm(path.join(this.imagesDir, chatId), { recursive: true, force: true }); } catch { /* ignore */ }
        try { await fs.rm(path.join(this.paths.dataRoot, 'chat-artifacts', chatId), { recursive: true, force: true }); } catch { /* ignore */ }
        try { await fs.rm(path.join(this.paths.dataRoot, 'excalidraw-captures', chatId), { recursive: true, force: true }); } catch { /* ignore */ }
        // 0.4.189 — drop the per-chat attachment cache alongside JSONL/images.
        try { await fs.rm(path.join(this.attachmentsDir, chatId), { recursive: true, force: true }); } catch { /* ignore */ }
        try { await this.projectStore.assignSession(chatId, ''); } catch { /* ignore */ }
        await this.saveMeta();
        this.broadcast('state.invalidate', { scope: 'chats' });
        return { ok: true };
      }
      case 'chats.turns':
        return this.loadTurns(String(p.chatId ?? ''));
      case 'agents.tree': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!chatId) throw new Error('chatId required');
        const agents = await this.agentRegistryFor(chatId);
        return { ok: true, agents: agents.snapshot() };
      }
      case 'agents.turns': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        if (!chatId || !ChatStore.isValidAgentId(agentId)) throw new Error('valid chatId and agentId required');
        const messages = await ChatStore.loadAgent(this.sessionsDir, chatId, agentId);
        return messages.map((m, id) => ({ id, role: m.role, content: m.content, synthetic: m.synthetic, kind: m.kind }));
      }
      case 'agents.deleteMessage': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        const absIndex = Number(p.absIndex);
        if (!chatId || !ChatStore.isValidAgentId(agentId)) throw new Error('valid chatId and agentId required');
        if (!Number.isFinite(absIndex) || absIndex < 0) throw new Error('absIndex required');
        const folder = await this.projectFolderFor(chatId);
        const persisted = await ChatStore.loadAgent(this.sessionsDir, chatId, agentId);
        if (absIndex >= persisted.length) return { ok: true, removed: 0 };
        persisted.splice(absIndex, 1);
        const store = new ChatStore(this.sessionsDir, chatId, folder, agentId);
        await store.rewriteAgent(persisted);
        await store.overwriteRuntime(persisted);
        const node = (await this.agentRegistryFor(chatId)).get(agentId);
        if (node) {
          let latest = '';
          for (let i = persisted.length - 1; i >= 0; i--) {
            if (persisted[i].role === 'assistant') {
              latest = textOf(persisted[i].content).trim();
              if (latest) break;
            }
          }
          node.result = latest;
          node.returnState = 'pending';
          node.handoffResult = undefined;
          node.deliveredAt = undefined;
          await store.updateAgentMeta({ result: latest, returnState: 'pending', handoffResult: undefined, deliveredAt: undefined, resultInjected: false });
          this.injectedAgentResults.delete(agentId);
        }
        this.broadcast('agent.messageDeleted', { rootChatId: chatId, agentId, absIndex });
        return { ok: true, removed: 1 };
      }
      case 'agents.chat': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        const text = String(p.text ?? '').trim();
        if (!chatId || !ChatStore.isValidAgentId(agentId) || !text) {
          throw new Error('valid chatId, agentId and text required');
        }
        return this.chatWithAgent(chatId, agentId, text);
      }
      case 'agents.submit': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        if (!chatId || !ChatStore.isValidAgentId(agentId)) throw new Error('valid chatId and agentId required');
        return this.submitAgentResult(chatId, agentId, p.infer !== false);
      }
      case 'agents.summarize': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        if (!chatId || !ChatStore.isValidAgentId(agentId)) throw new Error('valid chatId and agentId required');
        return this.summarizeAgent(chatId, agentId);
      }
      case 'agents.summarizeAll': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!chatId) throw new Error('chatId required');
        const runId = p.runId ? String(p.runId) : undefined;
        return this.summarizeAllAgents(chatId, runId);
      }
      case 'agents.submitAll': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!chatId) throw new Error('chatId required');
        const runId = p.runId ? String(p.runId) : undefined;
        return this.submitAllAgents(chatId, runId);
      }
      case 'agents.cachedArtifacts': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        if (!chatId || !ChatStore.isValidAgentId(agentId)) throw new Error('valid chatId and agentId required');
        return this.rpcAgentCachedArtifacts(chatId, agentId);
      }
      case 'agents.cancel': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        if (!chatId || !ChatStore.isValidAgentId(agentId)) throw new Error('valid chatId and agentId required');
        const agents = await this.agentRegistryFor(chatId);
        return { ok: agents.cancel(agentId) };
      }
      case 'agents.resume': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        if (!chatId) throw new Error('chatId required');
        if (agentId && !ChatStore.isValidAgentId(agentId)) throw new Error('valid agentId required');
        if (agentId) {
          const agents = await this.agentRegistryFor(chatId);
          const node = agents.get(agentId);
          const ok = await agents.resumeSubtreeAndWait(agentId);
          const runId = node?.runId || node?.agentId;
          const propagated = ok && runId ? await this.submitAllAgents(chatId, runId) : undefined;
          return { ok, ...(propagated ? { propagated } : {}) };
        }
        const session = await this.getSession(chatId);
        const patched = await this.patchOrphanedSpawnAgents(chatId, session);
        const agents = await this.agentRegistryFor(chatId);
        const latestRoot = agents.snapshot()
          .filter(a => !a.parentAgentId)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
        const propagated = latestRoot ? await this.submitAllAgents(chatId, latestRoot.runId || latestRoot.agentId) : undefined;
        return { ok: patched || !!propagated, patched, ...(propagated ? { propagated } : {}) };
      }
      case 'agents.forceReturn': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        if (!chatId) throw new Error('chatId required');
        if (agentId && !ChatStore.isValidAgentId(agentId)) throw new Error('valid agentId required');
        return this.forceReturnAgents(chatId, agentId || undefined);
      }
      case 'agents.dismiss': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        const agentId = String(p.agentId ?? '');
        if (!chatId || !ChatStore.isValidAgentId(agentId)) throw new Error('valid chatId and agentId required');
        const agents = await this.agentRegistryFor(chatId);
        agents.dismissSubtree(agentId);
        await this.purgeReleasedAgents(chatId, agents);
        return { ok: true };
      }
      case 'agents.dismissAll': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!chatId) throw new Error('chatId required');
        const agents = await this.agentRegistryFor(chatId);
        agents.dismissAll();
        await this.purgeReleasedAgents(chatId, agents);
        this.agentRegistries.delete(chatId);
        this.agentRegistryInit.delete(chatId);
        return { ok: true };
      }
      case 'chats.deleteTurn': {
        const turnId = Number(p.turnId);
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!Number.isFinite(turnId) || turnId < 0) throw new Error('turnId required');
        if (!chatId) throw new Error('chatId required');
        // Map v2's turnId (line index in JSONL) to ChatSession's user index.
        // We stored ids 0..N-1 sequentially in loadTurns; the matching
        // user turn lives at the same index in the chat's session.messages.
        const session = await this.getSession(chatId);
        const userIdx = this.userIndexForTurn(session, turnId);
        if (userIdx < 0) return { ok: true, removed: 0 };
        const removed = await session.deleteTurnAt(userIdx);
        return { ok: true, removed };
      }
      case 'chats.compact': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!chatId) throw new Error('chatId required');
        return this.compactChat(chatId);
      }
      case 'chats.systemNote': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!chatId) throw new Error('chatId required');
        // 0.4.217 — read the compact summary from the runtime file's head
        // (falls back to legacy .compact.md pre-migration).
        await this.getSession(chatId).catch(() => null);   // hydrate runtime
        const text = await this.readCompactSummary(chatId);
        const rec = this.chats.find(c => c.id === chatId);
        const files = await ChatStore.filesForChatId(this.sessionsDir, chatId).catch(() => [] as string[]);
        const historyPath = files[files.length - 1] || '';
        const runtimePath = historyPath ? historyPath.replace(/\.jsonl$/, '.runtime.jsonl') : '';
        return { ok: true, note: text, boundary: rec?.compactedUpTo ?? 0, historyPath, runtimePath };
      }
      case 'chats.contextUsage': {
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!chatId) throw new Error('chatId required');
        const rec = this.chats.find(c => c.id === chatId);
        const model = String(p.model ?? rec?.model ?? 'claude-opus-4-7');
        const session = await this.getSession(chatId);
        await this.toolRegistry.ensureLoaded().catch(e =>
          this.log.warn(`[chat-v2] contextUsage tool registry: ${(e as Error).message}`));
        const tiers: string[] = [];
        const globalTier = this.systemPrompts['global'] || DEFAULT_GLOBAL_PROMPT;
        if (globalTier) tiers.push(globalTier);
        const projectId = rec?.projectId || '';
        if (projectId && this.systemPrompts['project:' + projectId]) {
          tiers.push(this.systemPrompts['project:' + projectId]);
        } else if (projectId) {
          try {
            const proj = await this.projectStore.getProject(projectId);
            if (proj?.systemPrompt) tiers.push(proj.systemPrompt);
          } catch { /* ignore */ }
        }
        const chatPrompt = await this.readChatPrompt(chatId);
        if (chatPrompt) tiers.push(chatPrompt);
        const system = approxTokensStr(tiers.join('\n\n---\n\n'));
        const tools = this.approxToolTokens();
        const runtime = approxTokensForMsgs(session.runtimeMessages);
        const total = system + tools + runtime;
        const ctxMax = contextWindowFor(model);
        return { ok: true, system, tools, runtime, total, ctxMax, pct: ctxMax ? total / ctxMax : 0 };
      }
      case 'chats.cachedArtifacts':
        return this.rpcCachedArtifacts(String(p.chatId ?? ''));
      case 'chats.export': {
        // Render the chat as Markdown and hand the text back to the browser,
        // which triggers its own download — no native save dialog standalone.
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!chatId) throw new Error('chatId required');
        const session = await this.getSession(chatId);
        const meta = this.chats.find(c => c.id === chatId);
        const md = this.exportChatToMarkdown(meta?.title || 'Chat', session.messages);
        const filename = `${(meta?.title || 'chat').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'chat'}.md`;
        return { ok: true, markdown: md, filename };
      }
      case 'chats.exportHtml': {
        // 0.4.248 — HTML snapshot for debug. Webview passes the cloned
        // #thread inlined (styles baked in) + a list of image assets
        // (each already a data: URI). Inline the assets into the HTML
        // and hand the whole self-contained string back for the browser
        // to download — no sidecar asset folder, no native save dialog.
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!chatId) throw new Error('chatId required');
        const rawTitle = String(p.title || 'chat');
        const rawHtml  = String(p.html || '');
        const assets   = Array.isArray(p.assets) ? p.assets : [];
        const safeName = rawTitle.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'chat';
        const filename = `${safeName}_snapshot.html`;
        let html = rawHtml;
        for (const a of assets) {
          const name = String(a?.name || '').replace(/[^\w.\-]+/g, '_');
          const dataUri = String(a?.dataUri || '');
          if (!name || !dataUri) continue;
          html = html.split(`__ASSETS_DIR__/${name}`).join(dataUri);
        }
        return { ok: true, html, filename, assetCount: assets.length };
      }
      case 'chats.deleteMessage': {
        // Delete a SINGLE message at absIndex. Does not cascade. The
        // webview is expected to map turnId+role to absIndex by reading
        // its locally rendered turns array — we trust the index here.
        const absIndex = Number(p.absIndex);
        const chatId = String(p.chatId ?? this.activeChatId ?? '');
        if (!Number.isFinite(absIndex) || absIndex < 0) throw new Error('absIndex required');
        if (!chatId) throw new Error('chatId required');
        const session = await this.getSession(chatId);
        const removed = await session.deleteMessageAt(absIndex);
        if (removed) this.broadcast('state.invalidate', { scope: 'turns', chatId });
        return { ok: true, removed };
      }

      /* ── send / cancel / resume ─────────────────────────────── */
      case 'chat.send':
        if (this.activeRuns.has(String(p.chatId ?? ''))) return this.onQueueSend(p);
        return this.onSend(p);
      case 'chat.queueSend':
        return this.onQueueSend(p);
      case 'chat.dequeueMessage': {
        const chatId = String(p.chatId ?? '');
        this.queuedSend.delete(chatId);
        this.broadcast('chat.queued', { chatId, text: null });
        return { ok: true };
      }
      case 'chat.cancel': {
        const chatId = String(p.chatId ?? '');
        const sess = chatId ? this.sessions.get(chatId) : undefined;
        if (sess) sess.cancel();
        this.agentRegistries.get(chatId)?.cancelAll();
        this.queuedSend.delete(chatId);
        this.broadcast('chat.queued', { chatId, text: null });
        // 0.4.162 — release any pending ask_user promises so the tool
        // loop's is_error result flows and the runStream ends cleanly.
        this.toolExecutor.cancelClarifications(chatId);
        return { ok: true, cancelled: true };
      }
      case 'chat.resume':
        return this.onResume(p);
      case 'chat.clarifyReply': {
        // 0.4.162 — webview sent the user's reply for an ask_user card.
        const requestId = String(p.requestId ?? '');
        if (!requestId) throw new Error('requestId required');
        const answers  = (p.answers && typeof p.answers === 'object') ? p.answers : undefined;
        const skipped  = !!p.skipped;
        const ok = this.toolExecutor.resolveClarify(requestId, { answers, skipped });
        return { ok };
      }

      /* ── attachments ────────────────────────────────────────── */
      case 'attach.discard': {
        // 0.4.202 — frontend hit ✕ on a chip before sending. Drop the
        // RAM entry so we don't flush stale markdown at the next send.
        const h = String(p.hash ?? '');
        if (h) this.ramAttachments.delete(h);
        return { ok: true };
      }
      case 'attach.addByPath':
        return this.onAttachByPath({ path: String(p.path ?? ''), chatId: String(p.chatId ?? '') });
      case 'attach.addByPathHybrid':
        return this.onAttachByPath({ path: String(p.path ?? ''), chatId: String(p.chatId ?? ''), mineruBackend: 'hybrid-engine' });
      case 'attach.add':
        return this.onAttachInline(p);
      case 'attach.pickFromHost':
        return this.onPickFromHost(String(p.chatId ?? ''));
      case 'attach.pickFromHostPath':
        return this.onPickFromHostPath();

      /* ── files ──────────────────────────────────────────────── */
      case 'file.readAsDataUri': {
        const requested = String(p.path ?? '');
        if (this.handlingBrowserMessage && !this.isBrowserReadablePath(requested)) return { error: 'Forbidden' };
        return this.onReadAsDataUri(requested);
      }
      case 'file.exists': {
        const requested = String(p.path ?? '');
        if (this.handlingBrowserMessage && !this.isBrowserReadablePath(requested)) return { exists: false };
        try {
          const s = await fs.stat(requested);
          return { exists: s.isFile(), size: s.size };
        } catch { return { exists: false }; }
      }
      case 'file.preview': {
        const requested = String(p.path ?? '');
        if (this.handlingBrowserMessage && !this.isBrowserReadablePath(requested)) return { error: 'Forbidden' };
        return this.onFilePreview(requested);
      }
      case 'file.saveAs': {
        const requested = String(p.path ?? '');
        if (this.handlingBrowserMessage && !this.isBrowserReadablePath(requested)) return { error: 'Forbidden' };
        return this.onFileSaveAs(requested);
      }

      case 'artifacts.list': {
        const chatId = String(p?.chatId ?? '');
        const cached = await this.rpcCachedArtifacts(chatId);
        return { ok: true, artifacts: this.flattenCachedArtifacts(cached) };
      }
      case 'artifact.preview': {
        const chatId = String(p?.chatId ?? '');
        const id = String(p?.id ?? '');
        const agentId = ChatStore.isValidAgentId(String(p?.agentId ?? '')) ? String(p.agentId) : undefined;
        if (!chatId || !id) return { error: 'chatId and id required' };
        return this.onArtifactPreview(chatId, id, agentId);
      }
      case 'artifact.saveAs': {
        const chatId = String(p?.chatId ?? '');
        const id = String(p?.id ?? '');
        const agentId = ChatStore.isValidAgentId(String(p?.agentId ?? '')) ? String(p.agentId) : undefined;
        if (!chatId || !id) return { error: 'chatId and id required' };
        return this.onArtifactSaveAs(chatId, id, agentId);
      }
      case 'artifact.readAsDataUri': {
        const chatId = String(p?.chatId ?? '');
        const id = String(p?.id ?? '');
        const agentId = ChatStore.isValidAgentId(String(p?.agentId ?? '')) ? String(p.agentId) : undefined;
        if (!chatId || !id) return { error: 'chatId and id required' };
        return this.onArtifactReadAsDataUri(chatId, id, agentId);
      }
      case 'artifact.meta': {
        const chatId = String(p?.chatId ?? '');
        const id = String(p?.id ?? '');
        if (!chatId || !id) return { error: 'chatId and id required' };
        try { return { ok: true, artifact: await this.artifactMeta(chatId, id) }; }
        catch (e) { return { error: (e as Error).message }; }
      }
      case 'artifact.update': {
        const chatId = String(p?.chatId ?? '');
        const id = String(p?.id ?? '');
        if (!chatId || !id) return { error: 'chatId and id required' };
        try {
          const meta = await this.artifactMeta(chatId, id);
          const mt = String(meta.mediaType || '');
          const name = String(meta.name || '');
          if (mt !== 'text/markdown' && !/\.md$/i.test(name)) return { error: 'Only markdown artifacts can be edited here' };
          return await this.updateModelArtifact(chatId, { id, content: String(p?.content ?? ''), description: p?.description });
        } catch (e) { return { error: (e as Error).message }; }
      }
      case 'artifacts.pin': {
        const chatId = String(p?.chatId ?? '');
        const source = String(p?.source ?? '');
        if (!chatId || !source) return { error: 'chatId and source required' };
        try {
          const saved = await this.pinGenericArtifact(chatId, source, {
            toolUseId: p?.toolUseId ? String(p.toolUseId) : undefined,
            name: p?.name ? String(p.name) : undefined,
            mediaType: p?.mediaType ? String(p.mediaType) : undefined,
            live: p?.live === true,
            description: p?.description ? String(p.description) : undefined,
          });
          return { ok: true, artifact: saved };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }

      /* ── system prompt ──────────────────────────────────────── */
      case 'systemPrompt.get':
        return { value: await this.getSystemPromptTier(p) };
      case 'systemPrompt.set':
        return this.setSystemPromptTier(p);

      /* ── settings + pricing ─────────────────────────────────── */
      case 'settings.get':
        if (p.key === 'theme') return this.theme;
        return { value: undefined };
      case 'settings.set':
        if (p.key === 'theme' && typeof p.value === 'string') {
          this.theme = p.value;
          await this.saveMeta();
        }
        return { ok: true };
      case 'pricing.get':
        return {
          defaults:  DEFAULT_PRICING,
          overrides: this.pricingOverrides,
        };
      case 'pricing.set': {
        const m = String(p.model ?? '');
        if (!m) throw new Error('model required');
        if (p.price === null || p.price === undefined) {
          delete this.pricingOverrides[m];
        } else if (p.price && typeof p.price.in === 'number' && typeof p.price.out === 'number') {
          this.pricingOverrides[m] = {
            in:         p.price.in,
            out:        p.price.out,
            cacheRead:  typeof p.price.cacheRead  === 'number' ? p.price.cacheRead  : undefined,
            cacheWrite: typeof p.price.cacheWrite === 'number' ? p.price.cacheWrite : undefined,
          };
        }
        await this.saveMeta();
        return { ok: true };
      }

      /* ── MinerU MCP gating ──────────────────────────────────── */
      case 'mcp.minerStatus':
        // The proxy bundles MinerU; nothing for the user to install.
        return { installed: true, venvBin: '' };
      case 'mcp.installMineru':
        return { ok: true };
      case 'mineru.status':
        return this.getMineruStatus();
      case 'mineru.monitor':
        return this.getMineruMonitor();
      case 'mineru.control':
        return this.rpcMineruControl(String(p?.action || ''));
      case 'mineru.dashboard':
        return this.getMineruDashboard();
      case 'mineru.backendPicked': {
        const resolve = this.pendingMineruPick.get(String(p?.reqId ?? ''));
        if (resolve) {
          this.pendingMineruPick.delete(String(p?.reqId ?? ''));
          resolve((p?.backend === 'hybrid-engine' ? 'hybrid-engine' : p?.backend === 'cancel' ? 'cancel' : 'pipeline') as any);
        }
        return { ok: true };
      }

      /* ── v0.4.259 — artifact text fetch (SVG inline render) ── */
      case 'artifact.getText': {
        const chatId = String(p?.chatId ?? '');
        const id     = String(p?.id ?? '');
        const agentId = ChatStore.isValidAgentId(String(p?.agentId ?? '')) ? String(p.agentId) : undefined;
        if (!chatId || !id) return { error: 'chatId and id required' };
        try {
          const buf = await this.artifactStore.readArtifact(chatId, id, agentId);
          return { text: buf.toString('utf8') };
        } catch (e) {
          if (!agentId) return { error: (e as Error).message };
          try {
            const buf = await this.artifactStore.readArtifact(chatId, id);
            return { text: buf.toString('utf8') };
          } catch {
            return { error: (e as Error).message };
          }
        }
      }

      case 'openExternal': {
        // The browser bridge already intercepts this client-side
        // (window.open) and never forwards it here — this is a fallback
        // for any future non-browser client.
        return { error: 'openExternal is handled client-side in this app.' };
      }

      /* ── claude-mem: recent observations for a chat/namespace ── */
      case 'memory.recent':
        return this.rpcMemoryRecent(p || {});
      case 'memory.turnIdsForChat':
        return this.rpcMemoryTurnIdsForChat(p || {});

      case 'sandboxDev.status': {
        const containers = await this.lifecycle.listContainers();
        const installed = containers.some(c => c.service === 'sandbox-dev');
        return { installed };
      }

      case 'terminal.status':
        return this.terminal?.status() || { ok: false, error: 'terminal unavailable' };
      case 'terminal.list':
        return this.terminal?.list() || { ok: false, sessions: [] };
      case 'terminal.create':
        return this.terminal?.create(p || {}) || { ok: false, error: 'terminal unavailable' };
      case 'terminal.capture':
        return this.terminal?.capture(p.target || {}, p.lines) || { ok: false, data: '' };
      case 'terminal.input':
        return this.terminal?.input(p.target || {}, String(p.text || ''), !!p.enter) || { ok: false };
      case 'terminal.keys':
        return this.terminal?.keys(p.target || {}, Array.isArray(p.keys) ? p.keys : []) || { ok: false };
      case 'terminal.resize':
        return this.terminal?.resize(p.target || {}, Number(p.cols), Number(p.rows)) || { ok: false };
      case 'terminal.kill':
        return this.terminal?.kill(p.target || {}, p.scope || 'pane') || { ok: false };
      case 'terminal.ptyOpen': {
        const id = String(p.id || randomUUID());
        return this.terminal?.openPty(
          id,
          p.target || {},
          data => this.broadcast('terminal.data', { id, data }),
          code => this.broadcast('terminal.exit', { id, code }),
          Number(p.cols || 120),
          Number(p.rows || 34),
        ) || { ok: false };
      }
      case 'terminal.ptyInput':
        return this.terminal?.writePty(String(p.id || ''), String(p.data || '')) || { ok: false };
      case 'terminal.ptyResize':
        return this.terminal?.resizePty(String(p.id || ''), Number(p.cols), Number(p.rows)) || { ok: false };
      case 'terminal.ptyClose':
        return this.terminal?.closePty(String(p.id || '')) || { ok: false };

      default:
        this.log.warn(`[chat-v2] unhandled rpc: ${type}`);
        return { error: `unknown rpc: ${type}` };
    }
  }

  /* ─────────── turn loading ─────────── */

  /** Load all turns of a chat from its JSONL, assigning sequential ids
   *  the webview can use as `turnId`. Side-effect: caches the next id
   *  in this.turnIdByChat so subsequent appends keep counting. */
  private async loadTurns(chatId: string): Promise<TurnRecord[]> {
    if (!chatId) return [];
    // 0.4.102 — merge JSONLs across root + every project folder for this
    // chatId. A chat started before 0.4.66 lives at
    //   chat-sessions/<date>_<id>.jsonl
    // and, after a project routing change, keeps appending under
    //   chat-sessions/<projectFolder>/<date>_<id>.jsonl
    // loadByChatId walks all folders and returns the chronologically
    // merged list; loading only listSessions.file (the newest single
    // JSONL) truncated the transcript to just the latest folder.
    const msgs = await ChatStore.loadByChatId(this.sessionsDir, chatId).catch(() => [] as any[]);
    if (!msgs.length) return [];
    this.turnIdByChat.set(chatId, msgs.length);
    // Re-surface any image artifacts referenced anywhere in this chat so
    // the inline image cards reappear after reload (#F10a in 0.4.2).
    // 0.4.107 — MUST call surfaceImages PER tool_result block with its
    // tool_use_id so the image.attach broadcast carries an anchor id.
    // Without the id the webview drops the image into the trailing
    // artifact strip which sits BELOW any assistant caption text ("Đây
    // là ảnh…") — the caption ends up above the image on reload. Free
    // text (b.type === 'text') stays in one final call with no id.
    const artifactToolIds = new Set<string>();
    for (const m of msgs) {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks as any[]) {
        if (b?.type === 'aura_artifact' && b.toolUseId) artifactToolIds.add(String(b.toolUseId));
      }
    }
    const textBits: string[] = [];
    for (const m of msgs) {
      const blocks = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text', text: String(m.content || '') }];
      for (const b of blocks as any[]) {
        if (b?.type === 'text' && b.text) {
          textBits.push(b.text);
        } else if (b?.type === 'tool_result') {
          const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          if (c) {
            const tid = String(b.tool_use_id || '') || undefined;
            // If this tool already produced a persisted aura_artifact block,
            // replay that saved artifact via chats.cachedArtifacts instead of
            // also re-surfacing raw image paths as image.attach. The latter is
            // legacy fallback only and can create a second broken duplicate.
            if (tid && artifactToolIds.has(tid)) continue;
            this.surfaceImages(chatId, c, tid).catch(e =>
              this.log.warn(`[chat-v2] reload surfaceImages(${tid}): ${(e as Error).message}`));
          }
        }
        // v0.4.262 — aura_artifact blocks replay via chats.cachedArtifacts
        // RPC (frontend calls injectCachedArtifacts after DOM builds).
      }
    }
    if (textBits.length) {
      this.surfaceImages(chatId, textBits.join('\n')).catch(e =>
        this.log.warn(`[chat-v2] reload surfaceImages(text): ${(e as Error).message}`));
    }
    return msgs.map((m: PersistedMessage, i: number) => ({
      id:        i,
      role:      m.role,
      content:   m.content,
      createdAt: m.ts,
      ...(m.synthetic ? { synthetic: true as const } : {}),
      ...((m as any).kind ? { kind: (m as any).kind } : {}),
      ...(Array.isArray(m.attachments) && m.attachments.length ? { attachments: m.attachments } : {}),
    }));
  }

  /** Map a turn id (line index) to the user-message index in
   *  the chat's ChatSession.messages so deleteTurnAt has the right anchor.
   *  Sync because the session is already hydrated by getSession(). */
  private userIndexForTurn(session: ChatSession, turnId: number): number {
    // The session is hydrated 1-to-1 from JSONL, so turnId IS the index.
    // We still verify it points at a user turn — assistant deletes walk
    // back to the user that produced them so the pair gets removed.
    const msgs = session.messages;
    if (turnId >= msgs.length) return -1;
    if (msgs[turnId].role !== 'user') {
      for (let i = turnId; i >= 0; i--) if (msgs[i].role === 'user') return i;
      return -1;
    }
    return turnId;
  }

  /* ─────────── send loop ─────────── */

  /** Mark a chat as the visible one. Different chats keep streaming
   *  in the background; this only updates state used by image surfacing
   *  and other "current view" decisions. */
  private setActiveChat(id: string) {
    this.activeChatId = id;
  }

  private async onQueueSend(p: any): Promise<{ ok: boolean; queued: boolean }> {
    const chatId = String(p.chatId ?? '');
    if (!chatId) throw new Error('chatId required');
    const text = String(p.text ?? '').trim();
    if (!text) throw new Error('text required');
    this.queuedSend.set(chatId, { ...p, text, id: randomUUID(), createdAt: Date.now() });
    this.broadcast('chat.queued', { chatId, id: this.queuedSend.get(chatId).id, text: text.slice(0, 160), createdAt: this.queuedSend.get(chatId).createdAt });
    return { ok: true, queued: true };
  }

  private async onSend(p: any): Promise<{ ok: boolean; costUsd: number; cancelled: boolean }> {
    const chatId = String(p.chatId ?? '');
    if (!chatId) throw new Error('chatId required');
    if (!this.proxy.isReady()) throw new Error('Aether proxy is not ready');

    const session = await this.getSession(chatId);
    if (this.hasPendingAgentHandoff(session.runtimeMessages)) {
      await this.mergeInstructionIntoPendingHandoff(chatId, undefined, session, String(p.text ?? ''));
      p = { ...p, text: '', skipUserTurn: true };
    }
    this.setActiveChat(chatId);
    // Sandbox /tmp/aura-artifacts is scratch space. User-visible UUID artifacts
    // are created only by explicit aura_artifact_pin; update_artifact overwrites
    // an existing UUID in-place. Do not snapshot/diff raw filesystem writes here.
    const before = new Map<string, number>();

    // Auto-title from first user prompt.
    const rec = this.chats.find(c => c.id === chatId);
    if (rec && (rec.title === 'New chat' || !rec.title)) {
      const t = String(p.text ?? '').trim().slice(0, 60);
      if (t) { rec.title = t; rec.updatedAt = Date.now(); await this.saveMeta(); }
    }

    // Build user blocks from attachments + text. Image attachments become
    // Anthropic image blocks; text/parsed-doc attachments inline as text
    // with a path header.
    const attachments: any[] = Array.isArray(p.attachments) ? p.attachments : [];
    // 0.4.202 — flush RAM-only parsed docs to disk NOW that the user is
    // committing them to a send. Any attachment whose resultPath starts
    // with the "ram:" sentinel is realised on disk under the per-chat
    // attachments dir, and the resultPath is rewritten to the actual
    // filesystem path so the downstream prompt-build code path is
    // unchanged. Entries not in the Map (already flushed or unknown) are
    // left untouched.
    for (const a of attachments) {
      if (typeof a.resultPath !== 'string' || !a.resultPath.startsWith('ram:')) continue;
      const h = a.resultPath.slice('ram:'.length);
      const entry = this.ramAttachments.get(h);
      if (!entry) { a.resultPath = undefined; continue; }
      try {
        const chatDir = path.join(this.attachmentsDir, chatId);
        await fs.mkdir(chatDir, { recursive: true });
        const mdPath = path.join(chatDir, `${h}.md`);
        await fs.writeFile(mdPath, entry.markdown, 'utf8');

        // MinerU pipeline parses are RAM-first until the user actually sends.
        // At that commit point, also pin the markdown into durable session
        // artifacts so the gallery can preview/save it by id without replaying
        // the parse or storing markdown in chat history.
        try {
          const original = String(a.filename || entry.meta.filename || `mineru-${h}`);
          const stem = path.basename(original, path.extname(original)) || `mineru-${h}`;
          const safeStem = stem.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 80) || `mineru-${h}`;
          const artifactName = `${safeStem}.mineru.md`;
          const saved = await this.artifactStore.saveArtifact(chatId, artifactName, Buffer.from(entry.markdown, 'utf8'));
          (a as any).artifactId = saved.id;
          (a as any).artifactName = saved.name;
          this.broadcast('artifact.attach', {
            chatId,
            id:        saved.id,
            name:      saved.name,
            mediaType: saved.mediaType,
            localPath: saved.localPath,
            size:      saved.size,
            savedAt:   saved.savedAt,
            source:    'mineru',
          });
        } catch (e) {
          this.log.warn(`[chat-v2] MinerU artifact save failed for ${h}: ${(e as Error).message}`);
        }

        const meta = {
          hash:         h,
          originalName: a.filename || '',
          mimeType:     a.mimeType || '',
          sizeBytes:    entry.meta.sizeBytes || 0,
          parsedAt:     new Date(entry.parsedAt).toISOString(),
          resultPath:   mdPath,
          mineru:       !!entry.meta.mineru,
        };
        await fs.writeFile(path.join(chatDir, `${h}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
        if (entry.images?.length) {
          const imgDir = path.join(chatDir, `${h}-images`);
          await fs.mkdir(imgDir, { recursive: true });
          const imageAttachments: any[] = [];
          for (const [idx, img] of entry.images.entries()) {
            const safeName = String(img.name || `image-${idx + 1}.png`).replace(/[\\/:*?"<>|\x00-\x1f]/g, '-');
            const imgPath = path.join(imgDir, safeName);
            await fs.writeFile(imgPath, Buffer.from(img.data, 'base64'));
            imageAttachments.push({ filename: safeName, path: imgPath, mimeType: img.mediaType || 'image/png', source: a.filename || '' });
          }
          (a as any).mineruImages = imageAttachments;
        }
        a.resultPath = mdPath;
        this.ramAttachments.delete(h);
      } catch (e) {
        this.log.warn(`[chat-v2] RAM→disk flush failed for ${h}: ${(e as Error).message}`);
        a.resultPath = undefined;
      }
    }
    const images: ContentBlock[] = [];
    let prompt = String(p.text ?? '');
    for (const a of attachments) {
      if (a.mimeType?.startsWith('image/') && a.path) {
        try {
          const bytes = await fs.readFile(a.path);
          images.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: a.mimeType,
              data: bytes.toString('base64'),
            },
          });
        } catch (e) {
          this.log.warn(`[chat-v2] image attach read: ${(e as Error).message}`);
        }
      } else if (typeof a.resultPath === 'string' && a.resultPath) {
        // 0.4.354 — inline the parsed markdown straight into the prompt so
        // the model receives the content immediately, the same way image
        // attachments surface their bytes. Previously (0.4.189) we sent
        // only the sandbox path plus a "use `cat` to read it" instruction
        // to save prompt budget, but that cost a bash round-trip and, when
        // the .md held a stale non-markdown blob, sent the model chasing a
        // bogus parse. The cached .md already carries a "[Parsed from X via
        // MinerU]" header and is capped at MAX_MARKDOWN_CHARS (200k) by
        // AttachmentParser, so no extra truncation is needed here.
        const filename = a.filename || path.basename(a.resultPath);
        try {
          const md = await fs.readFile(a.resultPath, 'utf8');
          prompt += `\n\n--- ${filename} ---\n${md}`;
          if (Array.isArray((a as any).mineruImages) && (a as any).mineruImages.length) {
            prompt += `\n\n[${(a as any).mineruImages.length} image(s) extracted from ${filename} are attached as vision inputs below.]`;
            for (const img of (a as any).mineruImages) {
              try {
                const bytes = await fs.readFile(String(img.path));
                images.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: String(img.mimeType || 'image/png'),
                    data: bytes.toString('base64'),
                  },
                });
              } catch (e) {
                this.log.warn(`[chat-v2] MinerU image read: ${(e as Error).message}`);
              }
            }
          }
        } catch (e) {
          this.log.warn(`[chat-v2] doc attach read: ${(e as Error).message}`);
          prompt += `\n\n[Attached file ${filename} could not be read: ${(e as Error).message}]`;
        }
      } else if (typeof a.parsedMd === 'string' && a.parsedMd) {
        // Backward-compat: chats that pre-date the .md cache still ship the
        // markdown inline (parseAttachment falls back to parsedMd only when
        // it couldn't write the cache, or for callers that didn't pass a
        // chatId).
        prompt += `\n\n--- ${a.filename || a.path || 'attachment'} ---\n` + a.parsedMd;
      }
    }

    // Resolve project + per-tier system prompts.
    // Tier order — global → project → per-chat → devMode → system note.
    // Per-model tier dropped in 0.4.1 #8 (was unused noise). Per-chat lives in
    // <chatId>.systemprompt.md so it travels with the JSONL.
    const baseSystem = await this.systemPromptForChat(chatId);
    const tiers = baseSystem ? [baseSystem] : [];
    if (p.developerMode) tiers.push(DEV_MODE_ADDENDUM.trim());
    // 0.4.217 — compact summary is no longer injected into the system
    // prompt. It lives inside the runtime message list as a single
    // `[COMPACT SUMMARY]\n…` user turn at index 0 (see compactChat +
    // buildInitialRuntime). System prompt stays clean.
    const systemExtra = tiers.join('\n\n---\n\n') || undefined;

    const thinking = this.normalizeThinking(p.thinking);
    const developerMode = !!p.developerMode;
    const model = String(p.model ?? rec?.model ?? 'claude-opus-4-7');

    if (rec) { rec.model = model; rec.updatedAt = Date.now(); await this.saveMeta(); }

    // 0.4.217 — auto-compact when the projected input (runtime + new
    // user prompt) exceeds 95% of the model's context window. Compact
    // rewrites runtime to a single compact-summary turn; the send call
    // below picks the shrunken list up transparently.
    {
      const ctxMax = contextWindowFor(model);
      await this.toolRegistry.ensureLoaded().catch(e =>
        this.log.warn(`[chat-v2] auto-compact tool registry: ${(e as Error).message}`));
      const projected = approxTokensForMsgs(session.runtimeMessages) +
                        approxTokensStr(systemExtra || '') +
                        approxTokensStr(prompt) +
                        this.approxToolTokens() +
                        images.length * 1000;
      const AUTO_COMPACT_THRESHOLD = 0.95;
      if (projected > Math.floor(ctxMax * AUTO_COMPACT_THRESHOLD)) {
        this.log.info(`[chat-v2] auto-compact triggered: projected=${projected} > ${AUTO_COMPACT_THRESHOLD*100}% of ctxMax=${ctxMax}`);
        try {
          await this.compactChat(chatId);
        } catch (e) {
          this.log.warn(`[chat-v2] auto-compact failed, sending as-is: ${(e as Error).message}`);
        }
      }
    }
    const systemExtraFinal = systemExtra;
    const hasSystemNoteFinal = false;   // 0.4.217 — compact is not a system-prompt tier anymore

    this.broadcast('chat.streaming', { chatId, streaming: true });
    // Approximate sys-prompt + history token counts so the HUD's "sys" /
    // "in" pills move as soon as the request leaves; the authoritative
    // numbers from message_delta.usage replace these on chat.usage.
    // chars/4 is the standard rough heuristic Anthropic publishes.
    const sysTokens = approxTokensStr(systemExtraFinal || '');
    const toolTokens = this.approxToolTokens();
    const runtimeTokens = approxTokensForMsgs(session.runtimeMessages);
    const contextTotal = sysTokens + toolTokens + runtimeTokens;
    const historyTokens = runtimeTokens;
    const contextMax = contextWindowFor(model);
    this.broadcast('chat.start', {
      chatId, iter: 0, sysTokens, historyTokens,
      toolTokens, runtimeTokens, contextTotal, contextMax,
      contextPct: contextMax ? contextTotal / contextMax : 0,
    });

    // Notify webview about the persisted user turn id so it can swap its
    // optimistic bubble. The id is the index just before the new user
    // turn lands — equal to current message count (which excludes the
    // about-to-be-pushed user message).
    const userTurnId = session.messages.length;
    // 0.4.189 — include persisted attachment metadata so the webview
    // can render chips on turn hydration/reload without re-parsing.
    this.broadcast('chat.userTurn', {
      chatId,
      turnId: userTurnId,
      attachments: attachments
        .filter((a: any) => !!a && (a.hash || a.resultPath || a.origPath || a.filename))
        .map((a: any) => ({
          filename:   String(a.filename || 'file'),
          hash:       String(a.hash || ''),
          mimeType:   a.mimeType || undefined,
          sizeBytes:  a.sizeBytes || undefined,
          notes:      a.notes || undefined,
          resultPath:   a.resultPath || undefined,
          origPath:     a.origPath || undefined,
          artifactId:   (a as any).artifactId || undefined,
          artifactName: (a as any).artifactName || undefined,
        })),
    });

    // 0.4.172 — Ack the RPC as soon as setup is done. The actual streaming
    // + continuation loop + plugin work runs in the background; the frontend
    // learns about progress via `chat.chunk` / `chat.continuation.*` /
    // `chat.done` / `chat.error` broadcasts. Prior to this the RPC awaited
    // the full turn, which routinely exceeded the 10-min chat.send timeout
    // on multi-segment thinking-heavy turns, producing an "RPC timeout:
    // chat.send" banner while the backend was actually still working — the
    // two states diverged and the user was left resending on top of an
    // already-in-flight turn.
    // 0.4.189 — hand the structured attachments down so ChatSession.store
    // persists them alongside the user turn. sendMessage's `prompt` now
    // only names the parsed .md path, not the full markdown, so without
    // this field the JSONL would carry no record of which files rode with
    // the turn — reload chip render would fall back to raw text again.
    const persistAttachments = attachments
      .filter((a: any) => !!a && (a.hash || a.resultPath || a.origPath || a.filename))
      .map((a: any) => ({
        filename:   String(a.filename || 'file'),
        hash:       String(a.hash || ''),
        mimeType:   a.mimeType || undefined,
        sizeBytes:  a.sizeBytes || undefined,
        notes:      a.notes || undefined,
        resultPath:   a.resultPath || undefined,
        origPath:     a.origPath || undefined,
        artifactId:   (a as any).artifactId || undefined,
        artifactName: (a as any).artifactName || undefined,
      }));

    void this.runTurnBackground(chatId, session, {
      before, rec, prompt, images, model, thinking, developerMode,
      systemExtra: systemExtraFinal, hasSystemNote: hasSystemNoteFinal,
      attachments: persistAttachments,
      skipUserTurn: !!p.skipUserTurn,
    });

    return { ok: true, costUsd: 0, cancelled: false };
  }

  /** 0.4.172 — background half of onSend. Called once RPC has been ack'd. */
  private async runTurnBackground(
    chatId: string,
    session: ChatSession,
    ctx: {
      before: Map<string, number>;
      rec: any;
      prompt: string;
      images: ContentBlock[];
      model: string;
      thinking: { effort: ThinkingEffort } | undefined;
      developerMode: boolean;
      systemExtra: string | undefined;
      hasSystemNote: boolean;
      attachments?: any[];
      skipUserTurn?: boolean;
    },
  ): Promise<void> {
    const { before, rec, prompt, images, model, thinking, developerMode, systemExtra, hasSystemNote, attachments: persistAttachments } = ctx;
    this.activeRuns.add(chatId);

    let totalCost = 0;
    let stopReason = 'end_turn';
    let cancelled = false;
    let totalUsage = { inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0 };

    try {
      const ctxMax = contextWindowFor(model);
      const oldTokenBudget = Math.floor(ctxMax * 0.15);
      this.toolRegistry.setAvailableModels(await this.availableAgentModels());
      // Manual recovery owns result delivery. Completed agents are never
      // injected implicitly; each edge moves only when the user presses Submit.
      // If the root session has an orphaned spawn_agents tool_use, patch the
      // child results before sending a new user message — otherwise the API
      // rejects the message because there's an assistant turn with tool_use
      // but no matching tool_result.
      await this.patchOrphanedSpawnAgents(chatId, session).catch(() => {});
      const gen = session.send(prompt, images, {
        skipUserTurn: !!ctx.skipUserTurn,
        model, thinking, developerMode, systemExtra,
        hasSystemNote,
        oldTokenBudget,
        attachments: persistAttachments,
        toolContext: {
          chatId, developerMode, allowAskUser: true,
          pinArtifact: input => this.pinModelArtifact(chatId, input),
          updateArtifact: input => this.updateModelArtifact(chatId, input),
          spawnAgents: async input => {
            const agents = await this.agentRegistryFor(chatId);
            return {
              results: await agents.spawn(undefined, input?.agents || [], {
                model,
                effort: thinking?.effort || 'medium',
                availableModels: await this.availableAgentModels(),
              }),
            };
          },
          releaseAgents: input => this.releaseAgents(chatId, undefined, input),
        },
      });
      const { cost, stop, cancel, usage } = await this.runStream(chatId, gen, model);
      totalCost = cost;
      stopReason = stop;
      cancelled = cancel;
      totalUsage = usage;

      if (!cancelled) {
        const r = await this.runContinuationLoop({
          chatId, session, model, thinking, developerMode,
          hasSystemNote,
          oldTokenBudget,
          ctxMax,
          initialStop: stopReason,
          initialCost: totalCost,
          initialUsage: totalUsage,
        });
        totalCost  = r.cost;
        stopReason = r.stop;
        cancelled  = r.cancel;
        totalUsage = r.usage;
      }
    } catch (e) {
      const msg = (e as Error).message;
      this.broadcast('chat.error', { chatId, error: msg });
      stopReason = 'error';
    }

    // v0.4.261 — per-tool artifact processing now happens on each 'tool-done'
    // event so each file card anchors to the exact tool that produced it.
    // The end-of-turn sweep is intentionally left out — running it here
    // would re-save every artifact under a fresh uuid and duplicate cards.

    this.broadcast('chat.streaming', { chatId, streaming: false });
    this.broadcast('chat.done', {
      chatId,
      stopReason,
      usage: totalUsage,
      costUsd: totalCost,
    });
    this.sessionCost += totalCost;
    if (rec) { rec.updatedAt = Date.now(); try { await this.saveMeta(); } catch { /* non-fatal */ } }
    this.broadcast('state.invalidate', { scope: 'chats' });
    this.activeRuns.delete(chatId);

    // 0.4.244 — On cancel, only skip plugin firing when the assistant
    // produced no visible content (typing indicator only). If there IS
    // content (multi-segment stop mid-flight), fire memcard just like a
    // normal end_turn so partial work still gets summarised.
    const shouldFire = stopReason !== 'cancelled'
      || this.assistantHasVisibleContent(chatId);
    if (shouldFire) {
      void this.firePluginAfterAssistantTurn(chatId, stopReason);
    }
    const queued = this.queuedSend.get(chatId);
    if (queued) {
      this.queuedSend.delete(chatId);
      this.broadcast('chat.queued', { chatId, text: null });
      void this.onSend(queued).catch(e => this.broadcast('chat.error', { chatId, error: (e as Error).message }));
    }
  }

  private async runManualRootInference(chatId: string, session: ChatSession, prompt: string): Promise<void> {
    if (this.activeRuns.has(chatId)) throw new Error('Orchestrator is currently streaming');
    const rec = this.chats.find(c => c.id === chatId);
    const model = rec?.model || 'claude-opus-4-7';
    const thinking: { effort: ThinkingEffort } | undefined = undefined;
    const developerMode = false;
    const systemExtra = await this.systemPromptForChat(chatId);
    const ctxMax = contextWindowFor(model);
    const oldTokenBudget = Math.floor(ctxMax * 0.15);
    let totalCost = 0;
    let stopReason = 'end_turn';
    let cancelled = false;
    let totalUsage = { inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0 };

    this.activeRuns.add(chatId);
    this.broadcast('chat.streaming', { chatId, streaming: true });
    try {
      this.toolRegistry.setAvailableModels(await this.availableAgentModels());
      const sysTokens = approxTokensStr(systemExtra || '');
      const toolTokens = this.approxToolTokens();
      const runtimeTokens = approxTokensForMsgs(session.runtimeMessages);
      this.broadcast('chat.start', {
        chatId, iter: 0, sysTokens, historyTokens: runtimeTokens,
        toolTokens, runtimeTokens, contextTotal: sysTokens + toolTokens + runtimeTokens,
        contextMax: ctxMax, contextPct: ctxMax ? (sysTokens + toolTokens + runtimeTokens) / ctxMax : 0,
      });
      const gen = session.send(prompt, [], {
        model, thinking, developerMode, systemExtra, oldTokenBudget,
        toolContext: {
          chatId, developerMode, allowAskUser: true,
          pinArtifact: input => this.pinModelArtifact(chatId, input),
          updateArtifact: input => this.updateModelArtifact(chatId, input),
          spawnAgents: async input => {
            const agents = await this.agentRegistryFor(chatId);
            return {
              results: await agents.spawn(undefined, input?.agents || [], {
                model,
                effort: 'medium',
                availableModels: await this.availableAgentModels(),
              }),
            };
          },
          releaseAgents: input => this.releaseAgents(chatId, undefined, input),
        },
      });
      const r = await this.runStream(chatId, gen, model);
      totalCost = r.cost; stopReason = r.stop; cancelled = r.cancel; totalUsage = r.usage;
      if (!cancelled) {
        const rr = await this.runContinuationLoop({
          chatId, session, model, thinking, developerMode,
          hasSystemNote: false, oldTokenBudget, ctxMax,
          initialStop: stopReason, initialCost: totalCost, initialUsage: totalUsage,
        });
        totalCost = rr.cost; stopReason = rr.stop; cancelled = rr.cancel; totalUsage = rr.usage;
      }
    } catch (e) {
      this.broadcast('chat.error', { chatId, error: (e as Error).message });
      stopReason = 'error';
      throw e;
    } finally {
      this.broadcast('chat.streaming', { chatId, streaming: false });
      this.broadcast('chat.done', { chatId, stopReason, usage: totalUsage, costUsd: totalCost });
      this.sessionCost += totalCost;
      if (rec) { rec.updatedAt = Date.now(); try { await this.saveMeta(); } catch { /* non-fatal */ } }
      this.broadcast('state.invalidate', { scope: 'chats' });
      this.activeRuns.delete(chatId);
    }
    if (!cancelled && stopReason !== 'error') void this.firePluginAfterAssistantTurn(chatId, stopReason);
  }

  /** 0.4.244 — inspect the last assistant message on the session and
   *  return true iff it has any non-empty text block. Used to decide
   *  whether a cancelled turn should still fire memcard generation. */
  private assistantHasVisibleContent(chatId: string): boolean {
    const sess = this.sessions.get(chatId);
    if (!sess) return false;
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      const m = sess.messages[i];
      if (m.role !== 'assistant') continue;
      const c = m.content;
      if (typeof c === 'string') return c.trim().length > 0;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b && (b as any).type === 'text' && ((b as any).text || '').trim()) return true;
          if (b && (b as any).type === 'tool_use') return true;
        }
      }
      return false;
    }
    return false;
  }


  /** Materialize plugin context for an assistant turn and dispatch.
   *  Errors are isolated by PluginRegistry — never propagate to the
   *  webview RPC. */
  private async firePluginAfterAssistantTurn(chatId: string, stopReason: string): Promise<void> {
    try {
      const rec = this.chats.find(c => c.id === chatId);
      const projectId = rec?.projectId || '';
      let projectName = '';
      if (projectId) {
        try {
          const proj = await this.projectStore.getProject(projectId);
          projectName = proj?.name || '';
        } catch { /* projectStore optional */ }
      }
      const files = await ChatStore.filesForChatId(this.sessionsDir, chatId).catch(() => [] as string[]);
      if (!files.length) return;

      // 0.4.190 — resolve the JSONL index of the assistant message that
      // just landed so plugins (and downstream broadcasts like
      // memory.observation) can anchor UI to the exact bubble.
      let turnId = -1;
      const sess = this.sessions.get(chatId);
      if (sess) {
        for (let i = sess.messages.length - 1; i >= 0; i--) {
          if (sess.messages[i].role === 'assistant') { turnId = i; break; }
        }
      }

      await this.plugins.fire({
        event:           'afterAssistantTurn',
        chatId,
        projectId,
        projectName,
        transcriptPath:  files[files.length - 1],
        transcriptFiles: files,
        cwd:             '',
        stopReason,
        turnId,
        log:             this.log,
      });
    } catch (e) {
      this.log.warn(`[chat-v2] plugin afterAssistantTurn dispatch: ${(e as Error).message}`);
    }
  }

  /* ─────────── cached artifacts RPC ─────────── */

  /** 0.4.111 — the webview calls this on chat-load to replay file/image
   *  cards that were surfaced live during the original turn. Live path is
   *  broadcastNewArtifacts() (fires at chat.done, HTTP-scrapes the sandbox
   *  /artifacts/<chatId> listing and caches bytes to imagesDir). After a
   *  reload the sandbox may be gone and the live broadcast never fires —
   *  the cards vanish. Solution: read the on-disk cache dir + JSONL, pair
   *  each cached file with the tool_use_id whose tool_result text mentions
   *  it. injectCachedArtifacts() on the webview then re-anchors the cards
   *  inline next to their tool_use block.
   *
   *  Response shape (must match webview's injectCachedArtifacts):
   *    { byTool: {tid: [entry]}, orphans: [entry] }
   *  where entry = {filename, size, localPath, webviewUri, mediaType}.
   *  Files present in the cache but not mentioned by any tool_result go
   *  into orphans (the webview drops them at the last bubble's strip). */
  private async rpcCachedArtifacts(
    chatId: string,
  ): Promise<{ byTool: Record<string, any[]>; orphans: any[]; auraArtifacts: any[] }> {
    if (!chatId) return { byTool: {}, orphans: [], auraArtifacts: [] };
    // v0.4.262 — collect id-based artifacts from history so the reload path
    // renders them synchronously through injectCachedArtifacts, mirroring
    // the classic ImageCache reload flow.
    const auraArtifacts: any[] = [];
    try {
      const msgs = await ChatStore.loadByChatId(this.sessionsDir, chatId);
      for (let turnId = 0; turnId < msgs.length; turnId++) {
        const m = msgs[turnId];
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks as any[]) {
          if (b?.type !== 'aura_artifact') continue;
          if (!b.id || !b.localPath) continue;
          let exists = true;
          try { await fs.access(b.localPath); } catch { exists = false; }
          if (!exists) continue;
          const localPath = String(b.localPath);
          const agentMatch = localPath.match(/[\\/]agent-(agt_[0-9a-f]{12})(?:[\\/]|$)/i);
          const sourceAgentId = b.sourceAgentId ? String(b.sourceAgentId) : agentMatch?.[1];
          auraArtifacts.push({
            id:          String(b.id),
            name:        String(b.name || ''),
            mediaType:   String(b.mediaType || 'application/octet-stream'),
            localPath,
            size:        Number(b.size || 0),
            savedAt:     b.savedAt ? Number(b.savedAt) : undefined,
            updatedAt:   b.updatedAt ? Number(b.updatedAt) : undefined,
            version:     Number(b.version || 1),
            live:        b.live === true,
            description: b.description ? String(b.description) : undefined,
            toolUseId:   b.toolUseId ? String(b.toolUseId) : undefined,
            turnId,
            ...(sourceAgentId ? { sourceAgentId } : {}),
            isVisualise: b.isVisualise === true,
            isExcalidrawSnapshot: b.isExcalidrawSnapshot === true,
            reason:      b.reason ? String(b.reason) : undefined,
            boardBackupPath: b.boardBackupPath ? String(b.boardBackupPath) : undefined,
            idAnchored: true,
          });
        }
      }
    } catch (e) {
      this.log.warn(`[chat-v2] rpcCachedArtifacts aura scan: ${(e as Error).message}`);
    }
    // Promotion can happen while the final assistant message is still being
    // settled; if no aura_artifact block made it into JSONL, recover from the
    // root artifact directory so images don't disappear after chat switch.
    try {
      const known = new Set(auraArtifacts.map(a => String(a.id || '')));
      const rootDir = path.join(this.paths.dataRoot, 'chat-artifacts', chatId);
      // Root/orchestrator cache fallback must not sweep agent-* subfolders.
      // Agent artifacts are rendered through agents.cachedArtifacts with their
      // agentId scope; sweeping them here creates UUID-named "mystery" cards in
      // the orchestrator and duplicates leaf/parent artifacts after reload.
      for (const dir of [rootDir]) {
        const entries = (await fs.readdir(dir).catch(() => [] as string[]))
          .filter(n => /^[0-9a-f-]{36}\.[A-Za-z0-9]+$/.test(n));
        for (const filename of entries) {
          const id = path.basename(filename, path.extname(filename));
          if (known.has(id)) continue;
          const localPath = path.join(dir, filename);
          let stat: any;
          try { stat = await fs.stat(localPath); } catch { continue; }
          auraArtifacts.push({
            id, name: filename, mediaType: guessMime(path.extname(filename)), localPath,
            size: Number(stat.size || 0), savedAt: Number(stat.mtimeMs || 0), updatedAt: undefined, version: 1, turnId: undefined,
          });
          known.add(id);
        }
      }
    } catch (e) {
      this.log.warn(`[chat-v2] rpcCachedArtifacts artifact-dir scan: ${(e as Error).message}`);
    }

    // Skip legacy chat-images entries whose filename is now managed by the
    // aura_artifact pipeline (chat-artifacts/<uuid>.<ext>). Otherwise the
    // reload would render the same underlying file twice — once as an
    // orphan msg-image-wrap and once as an .art-image / .art-file.
    const auraNames = new Set(auraArtifacts.map(a => String(a.name || '')).filter(Boolean));

    const dir = path.join(this.imagesDir, chatId);
    let names: string[];
    try { names = await fs.readdir(dir); }
    catch { return { byTool: {}, orphans: [], auraArtifacts: this.dedupReloadArtifactsByFile(auraArtifacts) }; }
    names = names.filter(n => !auraNames.has(n));
    if (!names.length) return { byTool: {}, orphans: [], auraArtifacts: this.dedupReloadArtifactsByFile(auraArtifacts) };

    // Build filename → tool_use_id map by scanning JSONL. Preferred source
    // is tool_result text (the tool actually reported the filename it wrote).
    // 0.4.122 — fallback: also scan tool_use INPUT. Some sandbox scripts
    // save `foo.svg` then print an abstract line like "SVG saved: 7687 bytes"
    // with no filename in stdout. Without this fallback that file becomes
    // an orphan and lands in the bubble's .msg-artifact-strip (dashed
    // separator + bottom of bubble) instead of inline after tool_result —
    // screenshot 43. The tool_use's `input.code` almost always contains the
    // filename because it's the argument passed to `open(...)`.
    const msgs = await ChatStore.loadByChatId(this.sessionsDir, chatId).catch(() => [] as PersistedMessage[]);
    const tidByName = new Map<string, string>();
    // 0.4.145 — was: scan tool_result first, then fall back to tool_use input.
    // That misassigned filenames whenever a UNRELATED tool_result mentioned
    // the filename in its text — e.g. a claude-mem search returning summary
    // rows that cite an older PPTX. The claude-mem tool_result would win the
    // filename → the pptx card rendered after the search's tool_result
    // instead of after the sandbox that actually created it (screenshot 60).
    //
    // Reverse the priority: tool_use INPUT scan first — python sandbox
    // scripts almost always pass the output filename as an argument
    // (`open("foo.pptx", "wb")`). tool_result substring match is the
    // fallback for tools that only echo the filename in stdout.
    // Also prefer the LATEST match (later-in-timeline over earlier) so a
    // regenerated file lands on its most recent tool_use, not the first.
    for (const m of msgs) {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks as any[]) {
        if (b?.type !== 'tool_use' || !b.id) continue;
        const inp = b.input == null ? '' :
                     typeof b.input === 'string' ? b.input : JSON.stringify(b.input);
        for (const fname of names) {
          if (inp.includes(fname)) tidByName.set(fname, String(b.id));
        }
      }
    }
    if (tidByName.size < names.length) {
      const missing = names.filter(n => !tidByName.has(n));
      for (const m of msgs) {
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks as any[]) {
          if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
          // 0.4.145 — skip claude-mem search / memory tool_results. Their
          // text is user-authored summary content that frequently cites
          // filenames from past turns; matching those substrings gives
          // wrong anchor tid. We can't sniff the tool NAME from the
          // tool_result block itself (only tool_use has .name), so walk
          // back to the tool_use with matching id and skip if it's a
          // memory tool.
          const tuId = String(b.tool_use_id);
          let toolName = '';
          outer: for (const mm of msgs) {
            const bb = Array.isArray(mm.content) ? mm.content : [];
            for (const bx of bb as any[]) {
              if (bx?.type === 'tool_use' && bx.id === tuId) { toolName = String(bx.name || ''); break outer; }
            }
          }
          if (/claude[-_]?mem|memory[-_]?search/i.test(toolName)) continue;
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          for (const fname of missing) {
            if (tidByName.has(fname)) continue;
            if (text.includes(fname)) tidByName.set(fname, tuId);
          }
        }
      }
    }

    const byTool: Record<string, any[]> = {};
    const orphans: any[] = [];
    for (const filename of names) {
      const localPath = path.join(dir, filename);
      let size = 0;
      try { size = (await fs.stat(localPath)).size; } catch { continue; }
      const mediaType = guessMime(path.extname(filename));
      const entry = { filename, size, localPath, mediaType };
      const tid = tidByName.get(filename);
      if (tid) {
        (byTool[tid] ||= []).push(entry);
      } else {
        orphans.push(entry);
      }
    }
    return { byTool, orphans, auraArtifacts: this.dedupReloadArtifactsByFile(auraArtifacts) };
  }

  /** Collapse reload artifacts that are the SAME logical file (name+size) but
   *  carry DIFFERENT ids. This only happens for sessions created before the
   *  v0.4.394 auto-capture removal: the sandbox output was saved once by the
   *  auto-capture (id A, no tool_result → no anchor) and again by the explicit
   *  aura_artifact_pin (id B, appears in the pin's tool_result → anchored).
   *  The pin/result id is the source of truth, so prefer the entry that has a
   *  toolUseId anchor; drop the phantom auto-capture so it doesn't win the
   *  render race. Same-id entries (per-turn update history) are untouched. */
  private dedupReloadArtifactsByFile(list: any[]): any[] {
    const fileKey = (a: any) => `${String(a.name || '').toLowerCase()}:${Number(a.size || 0)}`;
    const best = new Map<string, any>();
    const order: string[] = [];
    for (const a of list) {
      const k = fileKey(a);
      const prev = best.get(k);
      if (!prev) { best.set(k, a); order.push(k); continue; }
      if (String(prev.id || '') === String(a.id || '')) continue; // same entry, keep first
      // Different id, same logical file = pre-v0.4.394 phantom pair (one explicit
      // pin + one auto-capture). The pin/result id is the source of truth: its
      // UUID appears literally in a tool_result (idAnchored), the phantom's never
      // does. Prefer the idAnchored entry so the card renders the result id.
      if (a.idAnchored && !prev.idAnchored) best.set(k, a);
    }
    return order.map(k => best.get(k));
  }

  private async rpcAgentCachedArtifacts(
    chatId: string,
    agentId: string,
  ): Promise<{ byTool: Record<string, any[]>; orphans: any[]; auraArtifacts: any[] }> {
    if (!chatId || !agentId) return { byTool: {}, orphans: [], auraArtifacts: [] };
    const auraArtifacts: any[] = [];
    try {
      const msgs = await ChatStore.loadAgent(this.sessionsDir, chatId, agentId);
      for (let turnId = 0; turnId < msgs.length; turnId++) {
        const blocks = Array.isArray(msgs[turnId].content) ? msgs[turnId].content : [];
        for (const b of blocks as any[]) {
          if (b?.type !== 'aura_artifact') continue;
          if (!b.id || !b.localPath) continue;
          let exists = true;
          try { await fs.access(b.localPath); } catch { exists = false; }
          if (!exists) continue;
          auraArtifacts.push({
            id:          String(b.id),
            name:        String(b.name || ''),
            mediaType:   String(b.mediaType || 'application/octet-stream'),
            localPath:   String(b.localPath),
            size:        Number(b.size || 0),
            savedAt:     b.savedAt ? Number(b.savedAt) : undefined,
            updatedAt:   b.updatedAt ? Number(b.updatedAt) : undefined,
            version:     Number(b.version || 1),
            live:        b.live === true,
            description: b.description ? String(b.description) : undefined,
            toolUseId:   b.toolUseId ? String(b.toolUseId) : undefined,
            turnId,
            sourceAgentId: agentId,
            isVisualise: b.isVisualise === true,
            isExcalidrawSnapshot: b.isExcalidrawSnapshot === true,
            reason:      b.reason ? String(b.reason) : undefined,
            boardBackupPath: b.boardBackupPath ? String(b.boardBackupPath) : undefined,
            // Persisted aura_artifact blocks are durable pins (the result id),
            // so they always outrank a phantom auto-capture in the file dedup.
            idAnchored: true,
          });
        }
      }
    } catch (e) {
      this.log.warn(`[chat-v2] rpcAgentCachedArtifacts aura scan: ${(e as Error).message}`);
    }
    try {
      const known = new Set(auraArtifacts.map(a => String(a.id || '')));
      const registry = await this.agentRegistryFor(chatId).catch(() => undefined as any);
      const node = registry?.get?.(agentId);
      const refById = new Map<string, any>((node?.artifacts || []).map((a: any) => [String(a.id || ''), a]));
      const anchorByNeedle = new Map<string, { toolUseId?: string; turnId: number }>();
      // UUIDs that appear LITERALLY inside a tool_result. This is the strong
      // signal that a given artifact id is the pin/result id (vs a phantom
      // auto-capture id that only lives in agent_meta). Kept separate from the
      // name-anchor map because the display name matches BOTH ids of a phantom
      // pair (both files share the same filename).
      const idAnchorSet = new Set<string>();
      const msgs = await ChatStore.loadAgent(this.sessionsDir, chatId, agentId).catch(() => [] as any[]);
      for (let turnId = 0; turnId < msgs.length; turnId++) {
        const blocks = Array.isArray(msgs[turnId].content) ? msgs[turnId].content : [];
        for (const b of blocks as any[]) {
          if (b?.type !== 'tool_result') continue;
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          const toolUseId = b.tool_use_id ? String(b.tool_use_id) : undefined;
          for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
            anchorByNeedle.set(m[0], { toolUseId, turnId });
            idAnchorSet.add(m[0].toLowerCase());
          }
          for (const ref of node?.artifacts || []) {
            const name = String((ref as any)?.name || '');
            if (name && text.includes(name)) anchorByNeedle.set(name, { toolUseId, turnId });
          }
        }
      }
      const artifactDir = path.join(this.paths.dataRoot, 'chat-artifacts', chatId, `agent-${agentId}`);
      const entries = (await fs.readdir(artifactDir).catch(() => [] as string[]))
        .filter(n => /^[0-9a-f-]{36}\.[A-Za-z0-9]+$/.test(n));
      for (const filename of entries) {
        const id = path.basename(filename, path.extname(filename));
        if (known.has(id)) continue;
        const localPath = path.join(artifactDir, filename);
        let stat: any;
        try { stat = await fs.stat(localPath); } catch { continue; }
        const ref = refById.get(id);
        const displayName = String(ref?.name || filename);
        const anchor = anchorByNeedle.get(id) || anchorByNeedle.get(displayName) || anchorByNeedle.get(filename);
        // Agent artifact directories can contain stale auto-captures from prior
        // tool calls. Only replay files that are tied to this agent's durable
        // artifact refs or can be anchored back to a persisted tool_result.
        if (!ref && !anchor) continue;
        auraArtifacts.push({
          id, name: displayName, mediaType: String(ref?.mediaType || guessMime(path.extname(displayName || filename))), localPath,
          size: Number(ref?.size || stat.size || 0), savedAt: Number(ref?.savedAt || stat.mtimeMs || 0), updatedAt: undefined,
          version: 1, turnId: anchor?.turnId, toolUseId: anchor?.toolUseId, sourceAgentId: agentId, agentId,
          idAnchored: idAnchorSet.has(id.toLowerCase()),
        });
        known.add(id);
      }
    } catch (e) {
      this.log.warn(`[chat-v2] rpcAgentCachedArtifacts artifact-dir scan: ${(e as Error).message}`);
    }
    return { byTool: {}, orphans: [], auraArtifacts: this.dedupReloadArtifactsByFile(auraArtifacts) };
  }

  /* ─────────── MinerU server status RPC ─────────── */

  private async mineruBaseUrl(kind: 'api' | 'control' = 'api'): Promise<string> {
    const d = await this.preset.load();
    const mcp = (d as any).mcp || {};
    const host = (kind === 'control' ? (mcp.mineruControlHost || mcp.mineruHost) : mcp.mineruHost) || '';
    const port = kind === 'control' ? (mcp.mineruControlPort || mcp.mineruPort) : mcp.mineruPort;
    if (!host) throw new Error('MinerU host not configured');
    const hostWithProto = host.startsWith('http') ? host : `http://${host}`;
    return port ? `${hostWithProto}:${port}` : hostWithProto;
  }

  private async getMineruDashboard(): Promise<Record<string, unknown>> {
    try {
      const base = await this.mineruBaseUrl('control');
      const apiBase = await this.mineruBaseUrl('api');
      let res = await fetch(`${base}/dashboard`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok && res.status === 404) {
        // Control service exposes the same dashboard at / or /control on 8938.
        res = await fetch(`${base}/control`, { signal: AbortSignal.timeout(3000) });
      }
      if (!res.ok && res.status === 404) {
        res = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
      }
      if (!res.ok) throw new Error(`dashboard HTTP ${res.status}`);
      let html = await res.text();
      // Dashboard HTML belongs to the MinerU server, but spokes/webviews should
      // not fetch the LAN host themselves. Keep the dashboard renderer intact
      // and intercept its relative `/monitor` fetch inside the srcdoc iframe;
      // the parent fulfills it through the existing backend-owned RPC.
      const bridge = `<script>(function(){const nativeFetch=window.fetch.bind(window);window.fetch=function(input,init){const raw=String(input&&input.url||input);let path=raw;try{path=new URL(raw,window.location.href).pathname;}catch{}if(path==='/monitor'||path.endsWith('/monitor')){return window.parent.__AURA_MINERU_MONITOR__().then(d=>new Response(JSON.stringify(d),{status:200,headers:{'content-type':'application/json'}}));}const m=path.match(/^\\/control\\/(start|stop|restart)$/);if(m){return window.parent.__AURA_MINERU_CONTROL__(m[1]).then(d=>new Response(JSON.stringify(d),{status:d&&d.ok===false?500:200,headers:{'content-type':'application/json'}}));}return nativeFetch(input,init);};})();</script>`;
      html = html.replace('</head>', `<script>window.__AURA_MINERU_API_URL__=${JSON.stringify(apiBase)};</script>` + bridge + '</head>');
      html = html.replace('const apiUrl = d._api_url || \'\';', `const apiUrl = d._api_url || window.__AURA_MINERU_API_URL__ || '';`);
      return { ok: true, base, html };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async getMineruMonitor(): Promise<Record<string, unknown>> {
    try {
      const base = await this.mineruBaseUrl('control');
      const apiBase = await this.mineruBaseUrl('api');
      const res = await fetch(`${base}/monitor`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`monitor HTTP ${res.status}`);
      const data = await res.json() as Record<string, unknown>;
      return { ...data, _api_url: apiBase };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async rpcMineruControl(action: string): Promise<Record<string, unknown>> {
    if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, error: 'invalid MinerU control action' };
    try {
      const base = await this.mineruBaseUrl('control');
      const res = await fetch(`${base}/control/${action}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      let data: any = {};
      try { data = await res.json(); } catch { data = {}; }
      if (!res.ok) return { ok: false, status: res.status, ...data };
      return { ok: true, ...data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async getMineruStatus(): Promise<Record<string, unknown>> {
    try {
      const base = await this.mineruBaseUrl('control');
      const fetchJson = (route: string) => fetch(`${base}${route}`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok ? r.json() : null);
      const [healthRes, modelsRes, runtimeRes] = await Promise.allSettled([
        fetchJson('/health'),
        fetchJson('/models'),
        fetchJson('/monitor'),
      ]);
      const health = healthRes.status === 'fulfilled' ? healthRes.value : null;
      const models = modelsRes.status === 'fulfilled' ? modelsRes.value : null;
      const runtime = runtimeRes.status === 'fulfilled' ? runtimeRes.value : null;
      if (!health && !runtime) return { running: false, state: 'offline', label: 'MinerU server not responding', error: 'server not responding' };
      const loadedKit = ((models as any)?.pipeline_models ?? []).map((m: any) => m.type).filter(Boolean);
      const loadedVlm = ((models as any)?.vlm_models ?? []).map((m: any) => m.backend || m.model_name).filter(Boolean);
      const h = (health || {}) as any;
      const r = (runtime || {}) as any;
      const taskList = Array.isArray(r.tasks) ? r.tasks : [];
      const currentTask = taskList.find((t: any) => ['processing', 'parsing', 'running'].includes(String(t.status || t.state || '').toLowerCase())) || taskList[0];
      const tasks = {
        queued: Number(r?.stats?.queued ?? r.queued_tasks ?? h.queued_tasks ?? 0) || 0,
        processing: Number(r?.stats?.parsing ?? r?.stats?.processing ?? r.processing_tasks ?? h.processing_tasks ?? 0) || 0,
        completed: Number(r?.stats?.completed ?? r.completed_tasks ?? h.completed_tasks ?? 0) || 0,
        failed: Number(r?.stats?.failed ?? r.failed_tasks ?? h.failed_tasks ?? 0) || 0,
        currentId: currentTask?.id ?? currentTask?.task_id ?? r.current_task_id,
        currentFile: currentTask?.file ?? currentTask?.filename ?? currentTask?.input ?? r.current_file,
        elapsedSec: currentTask?.elapsed_secs ?? currentTask?.elapsed_sec ?? r.elapsed_sec,
        items: taskList,
      };
      const state = tasks.processing > 0 ? 'processing' : tasks.queued > 0 ? 'queued' : tasks.failed > 0 ? 'failed' : 'idle';
      const label = typeof r.label === 'string' && r.label
        ? r.label
        : state === 'processing'
          ? `processing${tasks.currentFile ? ` ${path.basename(String(tasks.currentFile))}` : ''}${tasks.elapsedSec ? ` · ${Math.round(Number(tasks.elapsedSec))}s` : ''}`
          : state === 'queued'
            ? `queued ${tasks.queued}`
            : state === 'failed'
              ? `last task failed · done=${tasks.completed}`
              : `idle${h.version ? ` v${h.version}` : ''} · done=${tasks.completed}`;
      return {
        running: true,
        state,
        label,
        version: h.version ?? r.version ?? '',
        server: r.server ? { host: base, ...r.server } : { host: base, pid: r.pid, uptime: r.uptime, cpuPct: r.cpu_pct, ramMb: r.ram_mb },
        tasks,
        gpu: (r.gpus ?? r.gpu ?? []).map((g: any) => ({
          id: g.index ?? g.id,
          name: g.name,
          vramUsedMb: g.vram_used_mb ?? g.vramUsedMb,
          vramTotalMb: g.vram_total_mb ?? g.vramTotalMb,
          vramPct: g.vram_pct ?? g.vramPct,
          utilPct: g.util_pct ?? g.utilPct,
          tempC: g.temp_c ?? g.tempC,
          powerW: g.power_w ?? g.powerW,
          modelLoaded: g.model_loaded ?? g.modelLoaded,
        })),
        kit: r.kit ?? loadedKit,
        vlm: r.vlm ?? loadedVlm,
        queued_tasks: tasks.queued,
        processing_tasks: tasks.processing,
        completed_tasks: tasks.completed,
        failed_tasks: tasks.failed,
        loaded_kit: loadedKit,
        loaded_vlm: loadedVlm,
      };
    } catch (e) {
      return { running: false, state: 'offline', label: 'MinerU unreachable', error: (e as Error).message };
    }
  }

  /* ─────────── claude-mem: recent observations RPC ─────────── */

  /** Query the in-container claude-mem worker for the newest N
   *  observations tagged with a namespace. The worker's HTTP API is
   *  bound to 127.0.0.1 inside the proxy container on claude-mem's
   *  UID-derived port, so we tunnel through `docker exec ... curl`.
   *  Failures return a plain error the webview memory card renders as a
   *  load-failed line. */
  private async rpcMemoryRecent(
    payload: { chatId?: string; namespace?: string; limit?: number; turnId?: number },
  ): Promise<{ observations: Array<Record<string, unknown>>; error?: string }> {
    const namespace = String(payload.namespace || 'aura-ext');
    const chatId    = String(payload.chatId || '');
    const limit     = Math.max(1, Math.min(50, Number(payload.limit) || 8));
    const turnId    = Number.isFinite(Number(payload.turnId)) ? Number(payload.turnId) : -1;
    // 0.4.113 — the worker groups rows by `project` only, so every chat
    // in the `aura-ext` namespace surfaces the same recent items. Filter
    // to this chat's session_id client-side. Fetch a larger page so we
    // still return `limit` per-chat rows after filtering.
    const fetchN = chatId ? Math.min(200, Math.max(limit * 10, 50)) : limit;
    // 0.4.115 — the worker persists a summary AFTER the assistant turn
    // finishes (async LLM). Card at turn N must include summaries with
    // ts in [ turnN.ts, turnN+1.ts ) — using only turn.ts + 5min slack
    // (0.4.114) caused every card ≤ latest turn to include the LATEST
    // summary (screenshots 34/35). If turn N is the last asst turn, we
    // fall back to +5min slack. Also require finite created_at_epoch so
    // an item with missing ts doesn't slip through unfiltered.
    let lowerTs = 0;
    let upperTs = Number.POSITIVE_INFINITY;
    if (turnId >= 0 && chatId) {
      try {
        const msgs = await ChatStore.loadByChatId(this.sessionsDir, chatId);
        const m = msgs[turnId];
        if (m?.ts) {
          lowerTs = Number(m.ts);
          // Look for the NEXT asst turn — its ts is our exclusive upper
          // bound. Any summary landing after that timestamp belongs to
          // the next turn, not this one.
          let nextAsstTs: number | undefined;
          for (let i = turnId + 1; i < msgs.length; i++) {
            if (msgs[i].role === 'assistant' && msgs[i].ts) {
              nextAsstTs = Number(msgs[i].ts);
              break;
            }
          }
          upperTs = nextAsstTs !== undefined ? nextAsstTs : lowerTs + 5 * 60_000;
        }
      } catch { /* fall through: no bounds */ }
    }
    const withinTs = (created: any): boolean => {
      const t = Number(created);
      if (!Number.isFinite(t)) return turnId < 0;   // only allow unknown ts when no scoping requested
      return t >= lowerTs && t < upperTs;
    };
    try {
      const containers = await this.lifecycle.listContainers();
      const proxy = containers.find(c => c.service === 'proxy' && c.owned);
      if (!proxy?.name) return { observations: [], error: 'proxy container not running' };
      const raw = await this.dockerExecClaudeMemGet(
        proxy.name,
        `/api/observations?limit=${fetchN}&project=${encodeURIComponent(namespace)}`,
      );
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { return { observations: [], error: 'worker returned non-JSON' }; }
      const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
      const items = rawItems
        .filter((o: any) => !chatId || String(o.session_id || '') === chatId)
        .filter((o: any) => withinTs(o.created_at_epoch));
      const observations = items.slice(0, limit).map((o: any) => ({
        id:           o.id,
        title:        o.title || o.subtitle || '',
        content:      o.narrative || o.subtitle || o.title || '',
        content_type: o.type || 'observation',
        ts:           o.created_at || null,
      }));
      if (observations.length === 0) {
        // 0.4.185 — was: fetch /api/summaries?project=<namespace> once. If the
        // worker had already stored the summary with project='' (because
        // ClaudeMemPlugin's post-summarize backfill ran BEFORE the worker's
        // async LLM finished writing the row), this query returned zero and
        // the card polled uselessly for 2 min. Fix: on empty, retry with no
        // project filter, then match by session_id + ts window. When we find
        // one, backfill its project tag inline so future queries hit fast.
        const tryFallback = async (projectFilter: string | null): Promise<Array<Record<string, unknown>>> => {
          const path = projectFilter === null
            ? `/api/summaries?limit=${fetchN}`
            : `/api/summaries?limit=${fetchN}&project=${encodeURIComponent(projectFilter)}`;
          const rawSum = await this.dockerExecClaudeMemGet(proxy.name, path);
          const parsedSum = JSON.parse(rawSum);
          const rawSums = Array.isArray(parsedSum?.items) ? parsedSum.items : [];
          const sums = rawSums
            .filter((s: any) => !chatId || String(s.session_id || '') === chatId)
            .filter((s: any) => withinTs(s.created_at_epoch));
          return sums.slice(0, limit).map((s: any) => ({
            id:           `sum:${s.id}`,
            title:        s.request || 'summary',
            content:      [s.request, s.investigated, s.learned, s.completed, s.next_steps]
              .filter(Boolean).join('\n'),
            content_type: 'summary',
            ts:           s.created_at || null,
          }));
        };
        try {
          let summaries = await tryFallback(namespace);
          if (!summaries.length) {
            const untaggedSummaries = await tryFallback(null);
            if (untaggedSummaries.length) {
              summaries = untaggedSummaries;
              // Async backfill so subsequent polls hit the project-filtered path.
              this.dockerExecStdout(proxy.name, [
                'python3', '-c',
                `import sqlite3,os,glob
cands=["/mnt/claude-mem/claude-mem.db"]+glob.glob("/home/*/.claude-mem/claude-mem.db")+glob.glob("/root/.claude-mem/claude-mem.db")
db=next((p for p in cands if os.path.exists(p)),None)
if db:
  c=sqlite3.connect(db,timeout=5)
  c.execute("UPDATE session_summaries SET project=? WHERE (project IS NULL OR project='') AND memory_session_id IN (SELECT memory_session_id FROM sdk_sessions WHERE content_session_id=?)",(${JSON.stringify(namespace)},${JSON.stringify(chatId)}))
  c.execute("UPDATE observations SET project=? WHERE (project IS NULL OR project='') AND memory_session_id IN (SELECT memory_session_id FROM sdk_sessions WHERE content_session_id=?)",(${JSON.stringify(namespace)},${JSON.stringify(chatId)}))
  c.commit();c.close()`,
              ]).catch(e => this.log.warn(`[chat-v2] memory.recent inline backfill: ${(e as Error).message}`));
            }
          }
          if (summaries.length) return { observations: summaries };
        } catch (e) {
          this.log.warn(`[chat-v2] memory.recent summaries fallback: ${(e as Error).message}`);
        }
      }
      return { observations };
    } catch (e) {
      return { observations: [], error: (e as Error).message };
    }
  }

  /** 0.4.119 — return the set of turnIds in this chat that have a
   *  claude-mem observation OR summary attached. Reload path uses this
   *  to avoid attaching a placeholder memory card (and its 40 × 3s poll
   *  loop) to every asst bubble. A bubble whose turnId is not in the
   *  set gets no card. */
  private async rpcMemoryTurnIdsForChat(
    payload: { chatId?: string; namespace?: string },
  ): Promise<{ turnIds: number[]; error?: string }> {
    const namespace = String(payload.namespace || 'aura-ext');
    const chatId    = String(payload.chatId || '');
    if (!chatId) return { turnIds: [] };
    try {
      const msgs = await ChatStore.loadByChatId(this.sessionsDir, chatId);
      if (!msgs.length) return { turnIds: [] };

      // Build [lowerTs, upperTs) window per assistant turn.
      const windows: Array<{ turnId: number; lo: number; hi: number }> = [];
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role !== 'assistant' || !msgs[i].ts) continue;
        const lo = Number(msgs[i].ts);
        let hi = Number.POSITIVE_INFINITY;
        for (let j = i + 1; j < msgs.length; j++) {
          if (msgs[j].role === 'assistant' && msgs[j].ts) { hi = Number(msgs[j].ts); break; }
        }
        windows.push({ turnId: i, lo, hi });
      }
      if (!windows.length) return { turnIds: [] };

      const containers = await this.lifecycle.listContainers();
      const proxy = containers.find(c => c.service === 'proxy' && c.owned);
      if (!proxy?.name) return { turnIds: [], error: 'proxy container not running' };

      // Fetch a wide page of observations + summaries in ONE round-trip
      // each. 500 is plenty for a normal chat.
      const fetchStamps = async (path: string): Promise<number[]> => {
        try {
          const raw = await this.dockerExecClaudeMemGet(
            proxy.name,
            `${path}?limit=500&project=${encodeURIComponent(namespace)}`,
          );
          const parsed = JSON.parse(raw);
          const items = Array.isArray(parsed?.items) ? parsed.items : [];
          return items
            .filter((r: any) => String(r.session_id || '') === chatId)
            .map((r: any) => Number(r.created_at_epoch))
            .filter((n: number) => Number.isFinite(n));
        } catch { return []; }
      };
      let stamps = [
        ...await fetchStamps('/api/observations'),
        ...await fetchStamps('/api/summaries'),
      ];
      if (!stamps.length) {
        // The async claude-mem worker can commit after project-tag backfill,
        // leaving otherwise-valid rows with project=''. Match by session_id.
        const fetchStampsNoProject = async (apiPath: string): Promise<number[]> => {
          try {
            const raw = await this.dockerExecClaudeMemGet(proxy.name, `${apiPath}?limit=500`);
            const parsed = JSON.parse(raw);
            const items = Array.isArray(parsed?.items) ? parsed.items : [];
            return items
              .filter((r: any) => String(r.session_id || '') === chatId)
              .map((r: any) => Number(r.created_at_epoch))
              .filter((n: number) => Number.isFinite(n));
          } catch { return []; }
        };
        stamps = [
          ...await fetchStampsNoProject('/api/observations'),
          ...await fetchStampsNoProject('/api/summaries'),
        ];
      }
      if (!stamps.length) return { turnIds: [] };

      const hits = new Set<number>();
      for (const t of stamps) {
        for (const w of windows) {
          if (t >= w.lo && t < w.hi) { hits.add(w.turnId); break; }
        }
      }
      return { turnIds: Array.from(hits).sort((a, b) => a - b) };
    } catch (e) {
      return { turnIds: [], error: (e as Error).message };
    }
  }

  /** GET an in-container claude-mem worker URL using the same UID-derived
   *  default port as worker-service.cjs when CLAUDE_MEM_WORKER_PORT is absent. */
  private dockerExecClaudeMemGet(container: string, path: string): Promise<string> {
    return this.dockerExecStdout(container, [
      'sh', '-c', [
        'port=${CLAUDE_MEM_WORKER_PORT:-37700}',
        'exec curl -sS --max-time 5 "http://127.0.0.1:${port}$1"',
      ].join('; '),
      'sh',
      path,
    ]);
  }

  /** Run `docker exec <container> <argv...>` and resolve the stdout as
   *  a UTF-8 string. Rejects on non-zero exit or spawn error. */
  private dockerExecStdout(container: string, argv: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = require('child_process').spawn(
        'docker',
        ['exec', container, ...argv],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      proc.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
      proc.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); });
      proc.on('error', (e: Error) => reject(e));
      proc.on('close', (code: number) => {
        if (code === 0) resolve(out);
        else reject(new Error(`docker exec exited ${code}: ${err.trim()}`));
      });
    });
  }

  /* ─────────── sandbox artifact surfacing ─────────── */

  /** Hit the sandbox's /artifacts/<chatId> listing and return a Map
   *  keyed by filename so we can diff before/after a turn. Empty map
   *  on any failure — caller treats it as "no prior files known". */
  private async snapshotArtifacts(chatId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const port = await this.preset.getSandboxPort();
      if (!port) return out;
      const list = await this.fetchJson<{ files: Array<{ name: string; mtime: number }> }>(
        `http://127.0.0.1:${port}/artifacts/${encodeURIComponent(chatId)}`,
      );
      for (const f of list?.files ?? []) out.set(f.name, f.mtime);
    } catch (e) {
      this.log.warn(`[chat-v2] artifact snapshot: ${(e as Error).message}`);
    }
    return out;
  }

  /** v0.4.259 — id-based sandbox artifact pipeline.
   *  For each file newly appearing in the sandbox after this turn:
   *    1. fetch bytes → save to <dataRoot>/chat-artifacts/<chatId>/<uuid>.<ext>
   *    2. append an `aura_artifact` block into the last assistant message's
   *       content array, right after the tool_result whose toolUseId maps
   *       to the current turn (single anchor: the most recent tool_use).
   *    3. persist the session JSONL so reload can replay the block.
   *    4. broadcast `artifact.attach { id, name, mediaType, localPath,
   *       webviewUri, size, toolUseId }` — the frontend renders solely
   *       from this event (SSE-live path).
   *  Reload uses the same broadcast, replayed from history blocks.
   *  ImageCache / image.attach / file.attach are NOT touched — they stay
   *  the sole path for MCP `/api/images/` and user-attach flows. */
  private async processSandboxArtifacts(chatId: string, before: Map<string, number>, forcedToolUseId?: string) {
    const port = await this.preset.getSandboxPort();
    if (!port) return;
    const list = await this.fetchJson<{ files: Array<{ name: string; size: number; mtime: number }> }>(
      `http://127.0.0.1:${port}/artifacts/${encodeURIComponent(chatId)}`,
    );
    if (!list?.files?.length) return;

    const session = this.sessions.get(chatId);
    let mutated = false;

    for (const f of list.files) {
      const prior = before.get(f.name);
      if (prior !== undefined && prior >= f.mtime) continue;   // unchanged
      let saved: SavedArtifact;
      try {
        const bytes = await this.sandboxClient.fetchArtifact(chatId, f.name);
        saved = await this.artifactStore.saveArtifact(chatId, f.name, bytes);
      } catch (e) {
        this.log.warn(`[chat-v2] artifact save ${f.name}: ${(e as Error).message}`);
        continue;
      }

      // Anchor to the specific tool_use that produced this file when known;
      // fall back to the most recent tool_use in the last assistant message.
      const toolUseId = this.appendArtifactBlock(session, saved, forcedToolUseId);
      mutated = true;

      this.broadcast('artifact.attach', {
        chatId,
        id:         saved.id,
        name:       saved.name,
        mediaType:  saved.mediaType,
        localPath:  saved.localPath,
        size:       saved.size,
        toolUseId,
      });
    }

    if (mutated && session) {
      try { await this.persistSession(chatId, session); }
      catch (e) { this.log.warn(`[chat-v2] persist after artifact: ${(e as Error).message}`); }
    }
  }


  private flattenCachedArtifacts(cached: { byTool: Record<string, any[]>; orphans: any[]; auraArtifacts: any[] }): any[] {
    const out: any[] = [];
    const seen = new Set<string>();
    const add = (a: any, fallbackToolUseId?: string) => {
      if (!a) return;
      const id = String(a.id || a.localPath || a.webviewUri || a.filename || '');
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({
        id: a.id ? String(a.id) : id,
        name: String(a.name || a.filename || path.basename(String(a.localPath || '')) || 'artifact'),
        mediaType: String(a.mediaType || guessMime(path.extname(String(a.name || a.filename || a.localPath || '')))),
        localPath: a.localPath ? String(a.localPath) : undefined,
        webviewUri: a.webviewUri ? String(a.webviewUri) : undefined,
        size: Number(a.size || 0),
        toolUseId: a.toolUseId ? String(a.toolUseId) : fallbackToolUseId,
        savedAt: a.savedAt ? Number(a.savedAt) : undefined,
        updatedAt: a.updatedAt ? Number(a.updatedAt) : undefined,
        version: Number(a.version || 1),
        live: a.live === true,
        description: a.description ? String(a.description) : undefined,
        turnId: a.turnId,
        isVisualise: a.isVisualise === true,
        isExcalidrawSnapshot: a.isExcalidrawSnapshot === true,
        sourceUrl: a.sourceUrl ? String(a.sourceUrl) : undefined,
        sourceAgentId: a.sourceAgentId ? String(a.sourceAgentId) : undefined,
      });
    };
    for (const a of cached.auraArtifacts || []) add(a);
    for (const [tid, entries] of Object.entries(cached.byTool || {})) for (const a of entries || []) add(a, tid);
    for (const a of cached.orphans || []) add(a);
    return out.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
  }

  private isAllowedArtifactUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) return false;
      if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return false;
      return /\/(api\/images|artifacts|visualise|visualize)\//i.test(u.pathname) || /\/api\/visual/i.test(u.pathname);
    } catch { return false; }
  }

  private async pinGenericArtifact(
    chatId: string,
    source: string,
    opts: { toolUseId?: string; name?: string; mediaType?: string; ownerAgentId?: string; live?: boolean; description?: string; sandboxScope?: string; suppressAttach?: boolean } = {},
  ): Promise<any> {
    const raw = String(source || '').trim();
    if (!raw) throw new Error('source required');
    let bytes: Buffer | null = null;
    let filename = opts.name || '';

    const relativeArtifact = !/^https?:\/\//i.test(raw)
      && !/^file:\/\//i.test(raw)
      && !path.isAbsolute(raw)
      && !raw.includes('..');
    const sandboxMatch = raw.match(/\/tmp\/aura-artifacts\/([^/]+)\/([^\s)'"<>]+)/);
    if (relativeArtifact) {
      const artifactName = raw.replace(/^\.\//, '');
      bytes = await this.sandboxClient.fetchArtifact(opts.sandboxScope || chatId, artifactName);
      filename ||= path.basename(artifactName);
    } else if (sandboxMatch) {
      const sourceChatId = sandboxMatch[1];
      const artifactName = decodeURIComponent(sandboxMatch[2]);
      if (sourceChatId !== chatId) throw new Error('sandbox artifact belongs to a different chat');
      bytes = await this.sandboxClient.fetchArtifact(chatId, artifactName);
      filename ||= path.basename(artifactName);
    } else if (/^https?:\/\//i.test(raw)) {
      if (!this.isAllowedArtifactUrl(raw)) throw new Error('Unsupported artifact URL');
      bytes = await this.fetchMcpVisualiseArtifact(raw);
      filename ||= path.basename(new URL(raw).pathname) || 'artifact.bin';
    } else {
      const local = raw.replace(/^file:\/\//i, '');
      if (this.handlingBrowserMessage && !this.isBrowserReadablePath(local)) throw new Error('Forbidden');
      if (local.startsWith('/tmp/')) {
        bytes = await this.sandboxClient.readFile(local);
      } else {
        if (!this.isBrowserReadablePath(local)) throw new Error('Unsupported artifact path');
        bytes = await this.bytesFromHostOrContainerFile(local, await this.resolveOwnedProxyContainer());
      }
      filename ||= path.basename(local) || 'artifact.bin';
    }
    if (!bytes?.length) throw new Error('Could not read artifact bytes');

    const saved = await this.artifactStore.saveArtifact(chatId, filename, bytes, opts.ownerAgentId);
    if (opts.mediaType) (saved as any).mediaType = opts.mediaType;
    (saved as any).version = 1;
    if (opts.live) (saved as any).live = true;
    if (opts.description) (saved as any).description = opts.description;
    const session = this.sessions.get(chatId);
    const toolUseId = this.appendArtifactBlock(session, saved, opts.toolUseId, {
      version: 1,
      ...(opts.live ? { live: true } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    });
    if (session) await this.persistSession(chatId, session);
    const payload = {
      chatId, id: saved.id, name: saved.name, mediaType: saved.mediaType,
      localPath: saved.localPath, size: saved.size, savedAt: saved.savedAt,
      version: 1, live: opts.live === true, description: opts.description,
      toolUseId: toolUseId || opts.toolUseId,
    };
    if (!opts.suppressAttach) this.broadcast('artifact.attach', payload);
    return payload;
  }

  private async artifactMeta(chatId: string, id: string): Promise<any> {
    const cached = await this.rpcCachedArtifacts(chatId);
    const hit = this.flattenCachedArtifacts(cached).find(a => String(a.id || '') === id);
    if (!hit) throw new Error('artifact not found in this chat');
    return hit;
  }

  private updateArtifactBlock(chatId: string, id: string, patch: Record<string, unknown>, toolUseId?: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    // Per-turn pinning: when this update came from a specific tool_use, only
    // patch the aura_artifact block that belongs to THAT call. Otherwise a v2
    // update would rewrite turn N-1's card metadata to v2 (93B→101B), erasing
    // the version history the per-turn cards are meant to preserve. A fresh
    // tool_use has no block yet — appendArtifactBlock creates it with `patch`
    // already applied, so patching nothing here is correct.
    for (const m of session.messages as any[]) {
      const content = Array.isArray(m.content) ? m.content : [];
      for (const b of content) {
        if (b?.type !== 'aura_artifact' || String(b.id || '') !== id) continue;
        if (toolUseId && String(b.toolUseId || '') !== String(toolUseId)) continue;
        Object.assign(b, patch);
      }
    }
  }

  private async bytesForArtifactUpdate(chatId: string, input: any): Promise<Buffer> {
    if (typeof input?.content === 'string') return Buffer.from(input.content, 'utf8');
    const raw = String(input?.path || input?.source || '').trim();
    if (!raw) throw new Error('update_artifact requires content or path');
    const relativeArtifact = !raw.startsWith('/') && !/^https?:\/\//i.test(raw) && !raw.startsWith('file://') && !raw.includes('..');
    const sandboxMatch = raw.match(/\/tmp\/aura-artifacts\/([^/]+)\/(.+)$/);
    if (relativeArtifact) return this.sandboxClient.fetchArtifact(chatId, raw.replace(/^\.\//, ''));
    if (sandboxMatch) {
      if (sandboxMatch[1] !== chatId) throw new Error('sandbox artifact belongs to a different chat');
      return this.sandboxClient.fetchArtifact(chatId, decodeURIComponent(sandboxMatch[2]));
    }
    if (/^https?:\/\//i.test(raw)) {
      if (!this.isAllowedArtifactUrl(raw)) throw new Error('Unsupported artifact URL');
      return this.fetchMcpVisualiseArtifact(raw);
    }
    const local = raw.replace(/^file:\/\//i, '');
    if (this.handlingBrowserMessage && !this.isBrowserReadablePath(local)) throw new Error('Forbidden');
    if (local.startsWith('/tmp/')) return this.sandboxClient.readFile(local);
    if (!this.isBrowserReadablePath(local)) throw new Error('Unsupported artifact path');
    const bytes = await this.bytesFromHostOrContainerFile(local, await this.resolveOwnedProxyContainer());
    if (!bytes) throw new Error('Could not read artifact bytes');
    return bytes;
  }

  private async updateModelArtifact(chatId: string, input: any): Promise<any> {
    const id = String(input?.id || '');
    if (!id) throw new Error('update_artifact requires id');
    const meta = await this.artifactMeta(chatId, id);
    const bytes = await this.bytesForArtifactUpdate(chatId, input);
    if (!bytes.length) throw new Error('update_artifact got empty content');
    const updated = await this.artifactStore.updateArtifact(chatId, id, bytes);
    const updatedAt = updated.updatedAt;
    const version = Number(meta.version || 1) + 1;
    const patch = {
      size: updated.size,
      updatedAt,
      version,
      live: true,
      ...(input?.description ? { description: String(input.description) } : {}),
    };
    let toolUseId = input?._toolUseId ? String(input._toolUseId) : undefined;
    this.updateArtifactBlock(chatId, id, patch, toolUseId);
    const session = this.sessions.get(chatId);
    if (session) {
      const savedRef: SavedArtifact = {
        id,
        name: String(meta.name || `${id}.${meta.ext || 'bin'}`),
        ext: String(meta.ext || path.extname(String(meta.name || '')).replace(/^\./, '') || 'bin'),
        mediaType: String(meta.mediaType || 'application/octet-stream'),
        localPath: updated.localPath,
        size: updated.size,
        savedAt: Number(meta.savedAt || updatedAt),
        updatedAt,
        version,
        live: true,
        description: input?.description ? String(input.description) : meta.description,
      };
      toolUseId = this.appendArtifactBlock(session, savedRef, toolUseId, patch) || toolUseId;
      await this.persistSession(chatId, session);
    }
    const payload = {
      ...meta,
      ...patch,
      chatId,
      id,
      localPath: updated.localPath,
      toolUseId,
    };
    this.broadcast('artifact.updated', payload);
    this.broadcast('artifact.attach', payload);
    return { ok: true, id, size: updated.size, updatedAt, version };
  }

  private async pinModelArtifact(chatId: string, input: any): Promise<any> {
    const source = String(input?.path || input?.source || '');
    if (!source) throw new Error('aura_artifact_pin requires path');
    const artifact = await this.pinGenericArtifact(chatId, source, {
      toolUseId: input?._toolUseId ? String(input._toolUseId) : undefined,
      name: input?.name ? String(input.name) : undefined,
      mediaType: input?.mediaType ? String(input.mediaType) : undefined,
      live: input?.live === true,
      description: input?.description ? String(input.description) : undefined,
    });
    return {
      ok: true,
      id: artifact.id,
      name: artifact.name,
      mediaType: artifact.mediaType,
      size: artifact.size,
      savedAt: artifact.savedAt,
      version: artifact.version || 1,
      live: artifact.live === true,
      description: input?.description ? String(input.description) : undefined,
      message: 'Artifact pinned to this chat. The user can preview or save it from the artifact card/gallery.',
    };
  }

  private async processMcpImageArtifacts(chatId: string, toolUseId: string, rawResult: string): Promise<boolean> {
    const text = String(rawResult || '');
    const candidates = new Set<string>();
    try {
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      const collect = (v: any) => {
        if (!v) return;
        if (typeof v === 'string') {
          if (/\.(png|jpe?g|webp|gif|svg)\b/i.test(v)) candidates.add(v);
          return;
        }
        if (Array.isArray(v)) { v.forEach(collect); return; }
        if (typeof v === 'object') Object.values(v).forEach(collect);
      };
      collect(parsed);
    } catch { /* regex fallback below */ }
    for (const m of text.matchAll(/(?:filePath|filepath|path|localPath|local_path|saved to|Saved as)[:=]?\s*['"]?([^'"\n\s]+\.(?:png|jpe?g|webp|gif|svg))\b/gi)) {
      candidates.add(m[1]);
    }
    for (const m of text.matchAll(/(?:^|\s)(\/[^'"\n\s]+\.(?:png|jpe?g|webp|gif|svg))\b/gi)) candidates.add(m[1]);
    for (const m of text.matchAll(/https?:\/\/[^\s)'"<>]+\/api\/images\/[^\s)'"<>]+/gi)) candidates.add(m[0]);

    const session = this.sessions.get(chatId);
    let savedAny = false;
    for (const p of candidates) {
      let bytes: Buffer | null = null;
      try {
        bytes = /^https?:\/\//i.test(p)
          ? await this.fetchMcpVisualiseArtifact(p)
          : await this.bytesFromHostOrContainerFile(p, await this.resolveOwnedProxyContainer());
      }
      catch { bytes = null; }
      if (!bytes) continue;
      const saved = await this.artifactStore.saveArtifact(chatId, path.basename(new URL(p, 'file://').pathname), bytes);
      const anchor = this.appendArtifactBlock(session, saved, toolUseId);
      if (session) {
        try { await this.persistSession(chatId, session); }
        catch (e) { this.log.warn(`[chat-v2] persist after mcp image: ${(e as Error).message}`); }
      }
      this.broadcast('artifact.attach', {
        chatId,
        id: saved.id,
        name: saved.name,
        mediaType: saved.mediaType,
        localPath: saved.localPath,
        size: saved.size,
        toolUseId: anchor || toolUseId,
      });
      savedAny = true;
    }
    return savedAny;
  }

  private attachRootArtifact(chatId: string, saved: SavedArtifact, sourceAgentId?: string): import('./agents/AgentTypes').AgentArtifactRef {
    const toolUseId = this.appendArtifactBlock(this.sessions.get(chatId), saved, undefined, sourceAgentId ? { sourceAgentId } : undefined);
    this.broadcast('artifact.attach', {
      chatId,
      id:         saved.id,
      name:       saved.name,
      mediaType:  saved.mediaType,
      localPath:  saved.localPath,
      size:       saved.size,
      toolUseId,
      sourceAgentId,
    });
    return {
      id: saved.id, name: saved.name, mediaType: saved.mediaType, size: saved.size,
      sourceAgentId: sourceAgentId || '', savedAt: saved.savedAt,
    };
  }

  private async pinResultArtifacts(chatId: string, node: import('./agents/AgentTypes').AgentNode, ownerAgentId?: string): Promise<import('./agents/AgentTypes').AgentArtifactRef[]> {
    if (ownerAgentId) return [];
    const text = String(node.result || '');
    if (!text) return [];
    const candidates = new Set<string>();
    const allowedExt = 'png|jpe?g|webp|gif|svg|pdf|docx?|xlsx?|pptx?|csv|tsv|json|txt|md|html?|zip|js|ts|py';
    const hasAllowedExt = (v: string) => new RegExp(`\\.(${allowedExt})(?:$|[?#])`, 'i').test(v);
    const add = (s: string) => {
      const v = String(s || '').trim().replace(/[)>.,;]+$/g, '');
      if (!v || !hasAllowedExt(v)) return;
      if (/^https?:\/\//i.test(v) || /^(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])/.test(v)) candidates.add(v);
    };
    try {
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      const walk = (v: any) => {
        if (!v) return;
        if (typeof v === 'string') { add(v); return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(parsed);
    } catch { /* regex fallback below */ }
    for (const m of text.matchAll(/https?:\/\/[^\s)'"<>]+/gi)) add(m[0]);
    for (const m of text.matchAll(/(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^\s)'"<>]+\.[A-Za-z0-9]{2,8}\b/gi)) add(m[0]);

    const proxyContainer = await this.resolveOwnedProxyContainer();
    const pinned: import('./agents/AgentTypes').AgentArtifactRef[] = [];
    for (const c of candidates) {
      let bytes: Buffer | null = null;
      let filename = '';
      try {
        if (/^https?:\/\//i.test(c)) {
          if (!this.isAllowedArtifactUrl(c)) continue;
          bytes = await this.fetchMcpVisualiseArtifact(c);
          filename = path.basename(new URL(c).pathname) || `agent-${node.agentId}.bin`;
        } else {
          const local = c.replace(/^file:\/\//i, '');
          if (!this.isBrowserReadablePath(local) && !local.startsWith('/tmp/aura-artifacts/')) continue;
          bytes = await this.bytesFromHostOrContainerFile(local, proxyContainer);
          filename = path.basename(local) || `agent-${node.agentId}.bin`;
        }
      } catch (e) {
        this.log.warn(`[chat-v2] pin agent result artifact ${c}: ${(e as Error).message}`);
      }
      if (!bytes?.length || !filename) continue;
      try {
        const saved = await this.artifactStore.saveArtifact(chatId, filename, bytes);
        pinned.push(this.attachRootArtifact(chatId, saved, node.agentId));
      } catch (e) {
        this.log.warn(`[chat-v2] save pinned agent artifact ${c}: ${(e as Error).message}`);
      }
    }
    return pinned;
  }

  /** 0.4.267 — visualise MCP produced a diagram. Parse the tool_result JSON
   *  (`{url, filename, container_path}`), fetch bytes from the proxy, save
   *  via ArtifactStore, anchor to the tool_use, and broadcast artifact.attach.
   *  Mirrors processSandboxArtifacts's shape but sources the bytes from an
   *  HTTP URL instead of the sandbox artifact endpoint. */
  private async captureExcalidrawSnapshot(chatId: string, reason: 'marker' | 'fallback', focus?: BoardCaptureFocus) {
    const session = this.sessions.get(chatId);
    const client = this.toolRegistry.clientFor('excalidraw' as any);
    if (!session || !client) return;

    const root = path.join(this.paths.dataRoot, 'excalidraw-captures', chatId);
    const scenePath = path.join(root, 'board.excalidraw');
    const tmpBase = path.join(os.tmpdir(), `aura-board-${chatId}-${Date.now()}-${randomUUID()}`);
    const tmpSvgPath = `${tmpBase}.svg`;
    const tmpScenePath = `${tmpBase}.excalidraw`;
    try { await fs.mkdir(root, { recursive: true }); }
    catch (e) { this.log.warn(`[chat-v2] board snapshot mkdir: ${(e as Error).message}`); return; }

    const proxyContainer = await this.resolveOwnedProxyContainer();

    try {
      const scene = await client.callTool('export_scene', { filePath: tmpScenePath });
      if (scene.isError) this.log.warn(`[chat-v2] board scene export: ${scene.text}`);
      else {
        const sceneBytes = await this.bytesFromHostOrContainerFile(tmpScenePath, proxyContainer);
        if (sceneBytes) await fs.writeFile(scenePath, sceneBytes);
      }
    } catch (e) {
      this.log.warn(`[chat-v2] board scene export: ${(e as Error).message}`);
    }

    try {
      const focusId = focus?.elementIds?.find(Boolean);
      if (focusId && focus?.mode !== 'overview') {
        await client.callTool('set_viewport', { scrollToElementId: focusId });
      } else {
        await client.callTool('set_viewport', { scrollToContent: true });
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } catch (e) {
      this.log.warn(`[chat-v2] board viewport fit before export: ${(e as Error).message}`);
    }

    let bytes: Buffer;
    try {
      const exported = await client.callTool('export_to_image', {
        format: 'svg',
        filePath: tmpSvgPath,
        background: true,
      });
      if (exported.isError) throw new Error(exported.text);
      bytes = await this.svgBytesFromExcalidrawResult(exported.text, tmpSvgPath, proxyContainer);
    } catch (e) {
      this.log.warn(`[chat-v2] board svg export (${reason}): ${(e as Error).message}`);
      return;
    }

    let saved: SavedArtifact;
    try {
      saved = await this.artifactStore.saveArtifact(chatId, 'excalidraw-board-snapshot.svg', bytes);
    } catch (e) {
      this.log.warn(`[chat-v2] board svg save: ${(e as Error).message}`);
      return;
    }

    const turnId = this.lastAssistantTurnId(session);
    const toolUseId = this.appendArtifactBlock(session, saved, focus?.toolUseId, {
      isExcalidrawSnapshot: true,
      reason,
      boardBackupPath: scenePath,
      boardCaptureFocus: focus,
    });
    try { await this.persistSession(chatId, session); }
    catch (e) { this.log.warn(`[chat-v2] persist after board snapshot: ${(e as Error).message}`); }

    this.broadcast('artifact.attach', {
      chatId,
      id: saved.id,
      name: saved.name,
      mediaType: saved.mediaType,
      localPath: saved.localPath,
      size: saved.size,
      toolUseId,
      turnId,
      isExcalidrawSnapshot: true,
      reason,
      boardBackupPath: scenePath,
      boardCaptureFocus: focus,
    });
    await Promise.allSettled([
      fs.unlink(tmpSvgPath),
      fs.unlink(tmpScenePath),
      proxyContainer ? this.dockerExecStdout(proxyContainer, ['rm', '-f', tmpSvgPath, tmpScenePath]) : Promise.resolve(''),
    ]);
  }

  private lastAssistantTurnId(session: ChatSession): number | undefined {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === 'assistant') return i;
    }
    return undefined;
  }

  private async resolveOwnedProxyContainer(): Promise<string> {
    try {
      const containers = await this.lifecycle.listContainers();
      return containers.find(c => c.service === 'proxy' && c.owned)?.name || '';
    } catch { return ''; }
  }

  private async bytesFromHostOrContainerFile(filePath: string, container = ''): Promise<Buffer | null> {
    try { return await fs.readFile(filePath); }
    catch { /* try container path below */ }
    if (!container) return null;
    return new Promise<Buffer | null>((resolve) => {
      const proc = require('child_process').spawn(
        'docker', ['exec', container, 'cat', filePath],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (buf: Buffer | null) => {
        if (settled) return;
        settled = true;
        resolve(buf);
      };
      proc.stdout.on('data', (b: Buffer) => chunks.push(b));
      proc.on('error', () => done(null));
      proc.on('close', (code: number) => done(code === 0 ? Buffer.concat(chunks) : null));
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } done(null); }, 5000);
    });
  }

  private async svgBytesFromExcalidrawResult(raw: string, preferredPath: string, container = ''): Promise<Buffer> {
    const readIfSvg = async (p: string): Promise<Buffer | null> => {
      if (!p) return null;
      for (let i = 0; i < 10; i++) {
        const buf = await this.bytesFromHostOrContainerFile(p, container);
        if (buf && buf.toString('utf8', 0, Math.min(buf.length, 1024)).includes('<svg')) return buf;
        if (i < 9) await new Promise(resolve => setTimeout(resolve, 150));
      }
      return null;
    };

    const direct = await readIfSvg(preferredPath);
    if (direct) return direct;

    const text = (raw || '').trim();
    const svgStart = text.indexOf('<svg');
    if (svgStart >= 0) return Buffer.from(text.slice(svgStart), 'utf8');

    try {
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      const pathLike = String(parsed.filePath || parsed.filepath || parsed.path || parsed.container_path || '');
      const fromPath = await readIfSvg(pathLike);
      if (fromPath) return fromPath;
      const data = String(parsed.data || parsed.base64 || parsed.svg || '');
      if (data.includes('<svg')) return Buffer.from(data.slice(data.indexOf('<svg')), 'utf8');
      if (/^[A-Za-z0-9+/=\s]+$/.test(data) && data.length > 64) return Buffer.from(data.replace(/\s+/g, ''), 'base64');
      const url = String(parsed.url || '');
      if (/^https?:\/\//.test(url)) return this.fetchMcpVisualiseArtifact(url);
    } catch { /* fall through */ }

    const pathMatches = [
      ...text.matchAll(/(?:filePath|filepath|path|saved to|Exported to)[:=]?\s*['"]?([^'"\n]+\.svg)\b/gi),
      ...text.matchAll(/(?:^|\s)(\/[^'"\n\s]+\.svg)\b/g),
    ];
    for (const match of pathMatches) {
      const fromMatchedPath = await readIfSvg(match[1] || '');
      if (fromMatchedPath) return fromMatchedPath;
    }
    if (/^https?:\/\//.test(text)) return this.fetchMcpVisualiseArtifact(text);

    const preview = text.replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`SVG export result did not contain readable SVG; result=${preview}`);
  }

  private async processVisualiseArtifact(chatId: string, toolUseId: string, rawResult: string) {
    let url = ''; let filename = ''; let containerPath = '';
    try {
      // The MCP wrapper returns text; the visualise server serialises JSON.
      // Some MCP servers wrap the payload with a leading label — try to
      // isolate the first {...} block if a straight JSON.parse fails.
      let text = rawResult.trim();
      let parsed: any;
      try { parsed = JSON.parse(text); }
      catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('no JSON object in tool_result');
        parsed = JSON.parse(m[0]);
      }
      url            = String(parsed.url || '');
      filename       = String(parsed.filename || '');
      containerPath  = String(parsed.container_path || '');
    } catch (e) {
      this.log.warn(`[chat-v2] visualise parse failed: ${(e as Error).message}`);
      return;
    }
    if (!url || !filename) {
      this.log.warn(`[chat-v2] visualise result missing url/filename`);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await this.fetchMcpVisualiseArtifact(url);
    } catch (e) {
      this.log.warn(`[chat-v2] visualise fetch ${url}: ${(e as Error).message}`);
      return;
    }
    let saved: SavedArtifact;
    try {
      saved = await this.artifactStore.saveArtifact(chatId, filename, bytes);
    } catch (e) {
      this.log.warn(`[chat-v2] visualise save ${filename}: ${(e as Error).message}`);
      return;
    }
    const session = this.sessions.get(chatId);
    this.appendArtifactBlock(session, saved, toolUseId, { isVisualise: true });
    if (session) {
      try { await this.persistSession(chatId, session); }
      catch (e) { this.log.warn(`[chat-v2] persist after visualise: ${(e as Error).message}`); }
    }
    this.broadcast('artifact.attach', {
      chatId,
      id:            saved.id,
      name:          saved.name,
      mediaType:     saved.mediaType,
      localPath:     saved.localPath,
      size:          saved.size,
      toolUseId,
      sourceUrl:     url,
      containerPath,
      isVisualise:   true,
    });
  }

  /** GET a URL and buffer the response body. Used only by the visualise
   *  hook — the URL comes from the MCP tool_result and already embeds the
   *  auth token in the query string, so we pass it through verbatim. */
  private fetchMcpVisualiseArtifact(url: string): Promise<Buffer> {
    const http = require('http') as typeof import('http');
    const https = require('https') as typeof import('https');
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https:') ? https : http;
      const req = lib.get(url, res => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    });
  }

  /** Append an `aura_artifact` block into the last assistant message's
   *  content, positioned right after the last tool_use block so it groups
   *  visually with the tool that produced it. Returns the toolUseId used
   *  as the anchor (or undefined if none). */
  private appendArtifactBlock(session: ChatSession | undefined, saved: SavedArtifact, forcedToolUseId?: string, extra?: Record<string, unknown>): string | undefined {
    if (!session) return undefined;
    const msgs = session.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant') continue;
      const content = Array.isArray(m.content) ? m.content : null;
      if (!content) return undefined;
      let anchorIdx = -1;
      let toolUseId: string | undefined;
      if (forcedToolUseId) {
        // Anchor to the specific tool_use produced by this call.
        for (let j = 0; j < content.length; j++) {
          const b: any = content[j];
          if (b?.type === 'tool_use' && String(b.id || '') === forcedToolUseId) {
            anchorIdx = j; toolUseId = forcedToolUseId; break;
          }
        }
      }
      if (anchorIdx < 0) {
        // Fallback: last tool_use in the last assistant message.
        for (let j = content.length - 1; j >= 0; j--) {
          const b: any = content[j];
          if (b?.type === 'tool_use') { anchorIdx = j; toolUseId = String(b.id || ''); break; }
        }
      }
      const block: any = {
        type:      'aura_artifact',
        id:        saved.id,
        toolUseId,
        name:      saved.name,
        mediaType: saved.mediaType,
        localPath: saved.localPath,
        size:      saved.size,
        savedAt:   saved.savedAt,
        ...extra,
      };
      const insertIdx = anchorIdx >= 0
        ? anchorIdx + 1
        : Math.max(0, content.length - 1);
      content.splice(insertIdx, 0, block);
      return toolUseId;
    }
    return undefined;
  }

  /** Persist the session's messages array to its JSONL. Delegates to the
   *  ChatSession's private `store` (ChatStore). Post-hoc mutations (like
   *  appending aura_artifact blocks) call this after mutating in-memory. */
  private async persistSession(_chatId: string, session: ChatSession): Promise<void> {
    const store: ChatStore | undefined = (session as any).store;
    if (!store) return;
    const persisted = session.messages.map(m => ({
      ts: (m as any).ts ?? Date.now(),
      role: m.role,
      content: m.content,
      ...((m as any).synthetic ? { synthetic: true as const } : {}),
      ...((m as any).kind ? { kind: (m as any).kind } : {}),
      ...((m as any).agentHandoffs ? { agentHandoffs: (m as any).agentHandoffs } : {}),
    }));
    try { await store.rewrite(persisted as any); }
    catch (e) { this.log.warn(`[chat-v2] ChatStore.rewrite: ${(e as Error).message}`); }
    const runtime = session.runtimeMessages.map(m => ({
      ts: (m as any).ts ?? Date.now(),
      role: m.role,
      content: m.content,
      ...((m as any).synthetic ? { synthetic: true as const } : {}),
      ...((m as any).kind ? { kind: (m as any).kind } : {}),
      ...((m as any).agentHandoffs ? { agentHandoffs: (m as any).agentHandoffs } : {}),
    }));
    try { await store.overwriteRuntime(runtime as any); }
    catch (e) { this.log.warn(`[chat-v2] ChatStore.overwriteRuntime: ${(e as Error).message}`); }
  }

  /** Tiny Promise wrapper around http.get used for artifact polling.
   *  Doesn't follow redirects — the sandbox doesn't issue any. */
  private fetchJson<T>(url: string): Promise<T | null> {
    const http = require('http') as typeof import('http');
    return new Promise(resolve => {
      const req = http.get(url, res => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
          catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
  }

  private async onResume(p: any): Promise<{ ok: boolean; costUsd: number; cancelled: boolean }> {
    const chatId = String(p.chatId ?? '');
    if (!chatId) throw new Error('chatId required');
    const session = await this.getSession(chatId);
    this.setActiveChat(chatId);
    this.broadcast('chat.streaming', { chatId, streaming: true });
    let totalCost = 0;
    let cancelled = false;
    let stopReason = 'end_turn';
    let totalUsage = { inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0 };
    const resumeModel = String(p.model ?? 'claude-opus-4-7');
    try {
      // 0.4.217 — compact summary lives in runtimeMessages, not system
      // prompt. Resume just uses the same session; the (continue) hint is
      // appended to the runtime list.
      const resumeCtx = contextWindowFor(resumeModel);
      const resumeThinking = this.normalizeThinking(p.thinking);
      const resumeDev = !!p.developerMode;

      // Inject completed root-level agent results (for orchestrators without spawn_agents).
      await this.injectCompletedAgentResults(chatId, session).catch(() => {});
      // Detect orphaned spawn_agents in the root session — same as
      // AgentRunner.resumeFromDisk. When the root chat ended with a
      // spawn_agents tool_use and no tool_result, patch child results before
      // resuming so we don't add a second consecutive user message.
      const toolResultPatched = await this.patchOrphanedSpawnAgents(chatId, session);

      const toolContext = {
        chatId, developerMode: resumeDev, allowAskUser: true,
        spawnAgents: async (input: any) => {
          const agents = await this.agentRegistryFor(chatId);
          return {
            results: await agents.spawn(undefined, input?.agents || [], {
              model: resumeModel,
              effort: resumeThinking?.effort || 'medium',
              availableModels: await this.availableAgentModels(),
            }),
          };
        },
        releaseAgents: (input: any) => this.releaseAgents(chatId, undefined, input),
      };
      const gen = toolResultPatched
        ? session.send('', [], { model: resumeModel, thinking: resumeThinking, developerMode: resumeDev, skipUserTurn: true, toolContext })
        : session.resume({ model: resumeModel, thinking: resumeThinking, developerMode: resumeDev, toolContext }, String(p.hint ?? '(continue)'));
      const r = await this.runStream(chatId, gen, resumeModel);
      totalCost = r.cost; cancelled = r.cancel; stopReason = r.stop; totalUsage = r.usage;

      if (!cancelled) {
        const rr = await this.runContinuationLoop({
          chatId, session, model: resumeModel, thinking: resumeThinking,
          developerMode: resumeDev,
          hasSystemNote: false,
          oldTokenBudget: 0,
          ctxMax: resumeCtx,
          initialStop: stopReason,
          initialCost: totalCost,
          initialUsage: totalUsage,
        });
        totalCost = rr.cost; stopReason = rr.stop; cancelled = rr.cancel; totalUsage = rr.usage;
      }
    } catch (e) {
      this.broadcast('chat.error', { chatId, error: (e as Error).message });
      stopReason = 'error';
    }
    this.broadcast('chat.streaming', { chatId, streaming: false });
    this.broadcast('chat.done', {
      chatId, stopReason,
      usage: totalUsage,
      costUsd: totalCost,
    });
    // 0.4.148 — skip claude-mem on cancel (see onSend for details).
    // 0.4.154 — fire plugin for thinking_only so memcard renders on the
    // same turn (was retroactively firing on the next turn).
    // 0.4.244 — on cancel, still fire iff visible content exists (multi-
    // segment mid-flight stop should not lose the partial memcard).
    const shouldFire = stopReason !== 'cancelled'
      || this.assistantHasVisibleContent(chatId);
    if (shouldFire) {
      void this.firePluginAfterAssistantTurn(chatId, stopReason);
    }
    return { ok: true, costUsd: totalCost, cancelled };
  }

  private forceReturnAgents(chatId: string, rootAgentId?: string): Promise<any> {
    const existing = this.forceReturnRuns.get(chatId);
    if (existing) return existing;
    if (this.activeRuns.has(chatId)) throw new Error('Chat is currently streaming; stop it before Force return');
    this.activeRuns.add(chatId);
    const run = this.runForceReturn(chatId, rootAgentId)
      .finally(() => {
        this.forceReturnRuns.delete(chatId);
        this.activeRuns.delete(chatId);
      });
    this.forceReturnRuns.set(chatId, run);
    return run;
  }

  private async runForceReturn(chatId: string, rootAgentId?: string): Promise<any> {
    const registry = await this.agentRegistryFor(chatId);
    const folder = await this.projectFolderFor(chatId);
    const belongsToRoot = (node: any) => {
      if (!rootAgentId) return true;
      let cur = node;
      while (cur) {
        if (cur.agentId === rootAgentId) return true;
        cur = cur.parentAgentId ? registry.get(cur.parentAgentId) : undefined;
      }
      return false;
    };
    const nodes = registry.snapshot().filter(belongsToRoot);
    const total = nodes.length;
    let delivered = nodes.filter(n => n.returnState === 'delivered').length;
    const publishProgress = (agentId?: string, state?: string) => this.broadcast('agents.propagation', {
      rootChatId: chatId, total, delivered, pending: Math.max(0, total - delivered), agentId, state,
    });
    publishProgress(undefined, 'starting');

    // Force return is a manual rescue path: never resume or mutate the agent
    // tree. It reads the current final assistant message of root parents only.
    // Automatic disconnected recovery remains the responsibility of resume.

    // Root-level results are budgeted sequentially against the orchestrator's
    // live runtime, then injected without requiring a spawn_agents tool call.
    const session = await this.getSession(chatId);
    const roots = registry.snapshot().filter(n => !n.parentAgentId && belongsToRoot(n));
    // Recover v0.4.378 runs that appended the handoff but marked it delivered
    // before the orchestrator response succeeded. Reuse the trailing synthetic
    // turn instead of appending a duplicate user message.
    const trailing = session.runtimeMessages[session.runtimeMessages.length - 1];
    const trailingReturn = trailing?.role === 'user' && trailing.synthetic
      && typeof trailing.content === 'string'
      && (trailing.content.startsWith('[Sub-agent result]') || trailing.content.startsWith('[Sub-agent results]'));
    const stagedRoots: any[] = [];
    if (trailingReturn) {
      for (const root of roots) {
        const current = registry.get(root.agentId)!;
        if (current.returnState === 'delivered' || current.returnState === 'ready' || current.returnState === 'failed') {
          current.returnState = 'ready';
          stagedRoots.push(current);
        }
      }
    }
    // Force return never runs the resume/orphan-recovery path. It only forwards
    // the current root-parent final messages to the orchestrator.
    let rootInjected = false;
    for (const root of roots) {
      const current = registry.get(root.agentId)!;
      if (current.returnState === 'delivered') continue;
      if (!['completed', 'error', 'limit_reached'].includes(current.status)) continue;
      const remaining = roots.filter(r => registry.get(r.agentId)?.returnState !== 'delivered').length;
      const model = String(this.chats.find(c => c.id === chatId)?.model || root.model);
      const budget = returnBudget({
        contextMax: contextWindowFor(model), runtimeTokens: approxTokensForMsgs(session.runtimeMessages),
        fixedOverheadTokens: this.approxToolTokens(), remainingSiblings: remaining, model,
      });
      if (budget <= 0) throw new Error(`No orchestrator context remains for '${current.task}'`);
      const fallback = current.result?.trim() || current.handoffResult || (current.error ? `Error: ${current.error}` : '(no output)');
      const raw = await this.lastAgentAssistantResult(chatId, current.agentId, fallback);
      const handoff = await this.summarizeAgentReturn(current.task, raw, budget, model);
      const text = [
        '[AURA FORCE-RETURN RECOVERY]',
        'The recursive agent pipeline was interrupted after this root-level agent had already completed its assigned work. The backend is force-returning the saved final report because its normal handoff to the orchestrator did not complete.',
        'This is recovery context, not a new user question. Incorporate the report into the original user task and continue that task coherently. Do not explain agent spawning, context isolation, resume mechanics, or this recovery protocol unless the original user request explicitly asks about them.',
        '',
        `Root agent task: ${current.task}`,
        `Root agent status: ${current.status}`,
        '',
        '--- BEGIN RETURNED ROOT REPORT ---',
        handoff,
        '--- END RETURNED ROOT REPORT ---',
      ].join('\n');
      const synTs = Date.now();
      const syn = { role: 'user' as const, content: text, synthetic: true as const, ts: synTs };
      session.messages.push(syn); session.runtimeMessages.push(syn);
      const store: ChatStore | undefined = (session as any).store;
      const rec = { ts: synTs, role: 'user' as const, content: text, synthetic: true as const };
      await store?.append(rec); await store?.appendRuntime(rec);
      current.returnState = 'ready'; current.handoffResult = handoff;
      current.handoffTokens = approxTokensStr(handoff); current.handoffBudgetTokens = budget;
      await new ChatStore(this.sessionsDir, chatId, folder, current.agentId).updateAgentMeta({
        returnState: 'ready', handoffResult: handoff,
        handoffTokens: current.handoffTokens, handoffBudgetTokens: budget,
        resultInjected: true,
      });
      stagedRoots.push(current);
      rootInjected = true;
      publishProgress(current.agentId, 'ready');
    }
    publishProgress(undefined, 'completed');
    if (rootInjected) {
      publishProgress(undefined, 'responding');
      // Process the injected synthetic handoff immediately. skipUserTurn keeps
      // the API history valid because the handoff itself is already a user turn.
      const model = String(this.chats.find(c => c.id === chatId)?.model || roots[0]?.model || 'claude-sonnet-4-6');
      const thinking = { effort: 'medium' as ThinkingEffort };
      const gen = session.send('', [], {
        skipUserTurn: true, model, thinking,
        systemExtra: [
          await this.systemPromptForChat(chatId),
          'FORCE-RETURN RECOVERY TURN: A saved root-agent report is appended as the latest synthetic user message because normal nested-agent delivery was interrupted. Treat it as trusted task context, not as a new user question. Continue the original user task from the conversation and use the report to produce the missing coherent answer. Do not discuss spawn_agents, agent/context mechanics, or the recovery process unless the original task asks for that explanation.',
        ].filter(Boolean).join('\n\n---\n\n'),
        toolContext: {
          chatId, allowAskUser: true,
          pinArtifact: input => this.pinModelArtifact(chatId, input),
          updateArtifact: input => this.updateModelArtifact(chatId, input),
          spawnAgents: async input => ({
            results: await registry.spawn(undefined, input?.agents || [], {
              model, effort: thinking.effort, availableModels: await this.availableAgentModels(),
            }),
          }),
          releaseAgents: input => this.releaseAgents(chatId, undefined, input),
        },
      });
      this.broadcast('chat.streaming', { chatId, streaming: true });
      const sysTokens = approxTokensStr(await this.systemPromptForChat(chatId) || '');
      const toolTokens = this.approxToolTokens();
      const runtimeTokens = approxTokensForMsgs(session.runtimeMessages);
      const contextMax = contextWindowFor(model);
      this.broadcast('chat.start', {
        chatId, iter: 0, sysTokens, historyTokens: runtimeTokens,
        toolTokens, runtimeTokens, contextTotal: sysTokens + toolTokens + runtimeTokens,
        contextMax, contextPct: contextMax ? (sysTokens + toolTokens + runtimeTokens) / contextMax : 0,
        recovery: 'force-return',
      });
      const continued = await this.runStream(chatId, gen, model);
      this.broadcast('chat.streaming', { chatId, streaming: false });
      this.broadcast('chat.done', {
        chatId, stopReason: continued.stop, usage: continued.usage, costUsd: continued.cost,
      });
      if (!continued.cancel && continued.stop !== 'error') {
        // Match normal send/resume lifecycle so claude-mem observes the actual
        // force-return recovery answer instead of producing empty memcards.
        void this.firePluginAfterAssistantTurn(chatId, continued.stop);
      }
      const producedOutput = continued.usage.outTokens > 0;
      if (!continued.cancel && continued.stop !== 'error' && producedOutput) {
        for (const current of stagedRoots) {
          current.returnState = 'delivered';
          current.deliveredAt = Date.now();
          await new ChatStore(this.sessionsDir, chatId, folder, current.agentId).updateAgentMeta({
            returnState: 'delivered', deliveredAt: current.deliveredAt, resultInjected: true,
          });
          this.injectedAgentResults.add(current.agentId);
          delivered++; publishProgress(current.agentId, 'delivered');
        }
      } else {
        for (const current of stagedRoots) {
          current.returnState = 'failed';
          await new ChatStore(this.sessionsDir, chatId, folder, current.agentId).updateAgentMeta({
            returnState: 'failed', resultInjected: true,
          });
          publishProgress(current.agentId, 'failed');
        }
      }
    }
    return { ok: true, total, delivered, pending: Math.max(0, total - delivered) };
  }

  private isNoopAgentResumeResult(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return normalized.length < 2_000 && (
      normalized.includes('nothing left to resume')
      || normalized.includes('task completed in full several turns ago')
      || normalized.includes('all findings were delivered')
      || normalized.includes('already completed and delivered')
    );
  }

  private async canonicalAgentResult(chatId: string, agentId: string, fallback: string): Promise<string> {
    if (fallback.trim() && !this.isNoopAgentResumeResult(fallback)) return fallback.trim();
    const messages = await ChatStore.loadAgent(this.sessionsDir, chatId, agentId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      const text = textOf(msg.content).trim();
      if (text && !this.isNoopAgentResumeResult(text)) return text;
    }
    return fallback.trim();
  }

  private async lastAgentAssistantResult(chatId: string, agentId: string, fallback: string): Promise<string> {
    const messages = await ChatStore.loadAgent(this.sessionsDir, chatId, agentId);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue;
      const text = textOf(messages[i].content).trim();
      if (text) return text;
    }
    return fallback.trim();
  }

  private async summarizeAgentReturn(task: string, raw: string, budget: number, model: string): Promise<string> {
    if (!needsReturnSummary(raw, budget)) return raw;
    let current = raw;
    const { streamChat } = await import('./ChatStreamer');
    for (let pass = 0; pass < 6 && needsReturnSummary(current, budget); pass++) {
      const chunks = splitForSummary(current, Math.max(2_000, Math.min(Math.floor(contextWindowFor(model) * 0.45), budget * 2)));
      const summaries: string[] = [];
      for (const chunk of chunks) {
        let text = '';
        for await (const evt of streamChat({
          baseUrl: this.proxy.baseUrl(), model,
          messages: [{ role: 'user', content: buildReturnSummaryPrompt(task, chunk, Math.max(1_000, Math.floor(budget / chunks.length))) }],
          maxTokens: Math.min(maxOutputTokensFor(model), Math.max(1_000, Math.floor(budget / chunks.length))),
        })) {
          if (evt.type === 'text') text += evt.text;
          else if (evt.type === 'error') throw new Error(evt.error);
        }
        summaries.push(text.trim());
      }
      current = summaries.join('\n\n');
    }
    if (needsReturnSummary(current, budget)) throw new Error(`Unable to summarize agent result below ${budget} tokens`);
    return current;
  }

  /** Inject completed root-level agent results into the root chat session as a
   *  synthetic user message — for orchestrators that did NOT use spawn_agents
   *  (tool was removed). Agents whose results were already injected are skipped.
   *  Returns true if at least one result was injected. */
  private async injectCompletedAgentResults(chatId: string, session: import('./ChatSession').ChatSession): Promise<boolean> {
    const registry = this.agentRegistries.get(chatId);
    if (!registry) return false;
    const doneRoots = registry.snapshot().filter(n =>
      !n.parentAgentId &&
      ['completed', 'error', 'limit_reached'].includes(n.status) &&
      !this.injectedAgentResults.has(n.agentId)
    );
    if (!doneRoots.length) return false;

    const lines = doneRoots.map(n => {
      const status = n.status === 'completed' ? '✓' : '✗';
      const result = n.result?.trim() || (n.error ? `Error: ${n.error}` : '(no output)');
      return `## Agent: ${n.task}\nStatus: ${status}\n\n${result}`;
    });
    const text = `[Sub-agent results]\n\n${lines.join('\n\n---\n\n')}`;
    const store: import('./ChatStore').ChatStore | undefined = (session as any).store;
    const synTs = Date.now();
    const synMsg = { role: 'user' as const, content: text, synthetic: true as const, ts: synTs };
    session.messages.push(synMsg);
    session.runtimeMessages.push(synMsg);
    const rec = { ts: synTs, role: 'user' as const, content: text, synthetic: true as const };
    await store?.append(rec).catch(() => {});
    await store?.appendRuntime(rec).catch(() => {});
    const folder = await this.projectFolderFor(chatId).catch(() => '');
    for (const n of doneRoots) {
      this.injectedAgentResults.add(n.agentId);
      // Persist so reload doesn't double-inject.
      const agentStore = new ChatStore(this.sessionsDir, chatId, folder, n.agentId);
      agentStore.updateAgentMeta({ resultInjected: true }).catch(() => {});
    }
    return true;
  }

  /** Detect orphaned spawn_agents tool_use in the root chat session.
   *  If the last assistant message has a spawn_agents tool_use with no
   *  following tool_result, patch the child agent results into the session
   *  so the model can continue without re-spawning. Returns true if patched. */
  private async patchOrphanedSpawnAgents(chatId: string, session: import('./ChatSession').ChatSession): Promise<boolean> {
    const msgs = session.messages;
    const lastAsst = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    const hasPendingToolUse = lastAsst?.role === 'assistant'
      && Array.isArray(lastAsst.content)
      && (lastAsst.content as any[]).some((b: any) => b?.type === 'tool_use');
    const lastIsToolResult = msgs.length >= 2
      && msgs[msgs.length - 1].role === 'user'
      && Array.isArray(msgs[msgs.length - 1].content)
      && (msgs[msgs.length - 1].content as any[]).some((b: any) => b?.type === 'tool_result');
    if (!hasPendingToolUse || lastIsToolResult) return false;

    const toolUses = (lastAsst!.content as any[]).filter((b: any) => b?.type === 'tool_use');
    const spawnUses = toolUses.filter((b: any) => b?.name === 'spawn_agents');
    if (!spawnUses.length) return false;

    const registry = await this.agentRegistryFor(chatId);
    const toolResults = await Promise.all(toolUses.map(async (b: any) => {
      if (b?.name === 'spawn_agents') {
        const existingChildren = registry.snapshot()
          .filter(n => !n.parentAgentId)
          .map(n => registry.get(n.agentId))
          .filter((n): n is import('./agents/AgentTypes').AgentNode => !!n);
        if (existingChildren.length > 0) {
          const results = await registry.resumeOrCollectChildren('', existingChildren);
          return { type: 'tool_result' as const, tool_use_id: b.id, content: JSON.stringify({ results }) };
        }
      }
      return {
        type: 'tool_result' as const, tool_use_id: b.id, is_error: true,
        content: 'Session was interrupted before this completed. Please retry.',
      };
    }));
    const store: import('./ChatStore').ChatStore | undefined = (session as any).store;
    const patchTs = Date.now();
    const patchMsg = { role: 'user' as const, content: toolResults, ts: patchTs };
    session.messages.push(patchMsg);
    session.runtimeMessages.push(patchMsg);
    const toolRec = { ts: patchTs, role: 'user' as const, content: toolResults };
    await store?.append(toolRec).catch(() => {});
    await store?.appendRuntime(toolRec).catch(() => {});
    return true;
  }

  /** 0.4.161 — build a content-aware continuation hint from the last
   *  assistant text. When the previous turn was cut mid-SVG / mid-code /
   *  mid-list, tell the model exactly what to resume so it doesn't recap
   *  or restart. Generic fallback covers everything else. */
  /** 0.4.215 — strip a trailing marker (e.g. [DONE], [NEED_MORE],
   *  [NEED_THINK]) from the last assistant message so it does not leak
   *  into the rendered bubble. Mutates in-memory content; persistence
   *  will pick it up on next rewrite (compact/svg-review). */
  private stripTrailingMarker(session: ChatSession, rx: RegExp): void {
    const msgs = session.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string') {
        m.content = m.content.replace(rx, '');
        return;
      }
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b: any = m.content[j];
        if (b?.type === 'text' && typeof b.text === 'string' && rx.test(b.text)) {
          b.text = b.text.replace(rx, '');
          return;
        }
      }
      return;
    }
  }

  private stripBoardDoneMarker(session: ChatSession): void {
    const msgs = session.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string') {
        m.content = m.content.replace(BOARD_DONE_MARKER_ANY_RX, '');
        return;
      }
      if (!Array.isArray(m.content)) return;
      for (const b of m.content as any[]) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          b.text = b.text.replace(BOARD_DONE_MARKER_ANY_RX, '');
        }
      }
      return;
    }
  }

  /** 0.4.208 — objective structural-incompleteness detector. Returns true
   *  iff the tail contains an unclosed <svg>...</svg> OR an odd count of
   *  ``` fence markers. These are unambiguous "not done yet" signals that
   *  justify continuing a nominal end_turn. */
  private hasUnclosedStructure(text: string): boolean {
    if (!text) return false;
    const opens  = (text.match(/<svg\b/g)  || []).length;
    const closes = (text.match(/<\/svg>/g) || []).length;
    if (opens > closes) return true;
    const fences = (text.match(/```/g) || []).length;
    if (fences % 2 === 1) return true;
    return false;
  }

  private buildContinuationHint(partial: string): string {
    const trimmed = partial.trimEnd();
    if (!trimmed) {
      return '(continue — pick up where you left off. No recap.)';
    }
    // 0.4.210 — echo the tail (last ~800 chars) so the model has anchor
    // context inline. History pruning + system-note-drop had been leaving
    // segment N with no visibility into segment N-1's cut point, so it
    // hallucinated "no context" and either closed with a stub tag or
    // gave up (Image #67). Embedding the tail is redundant with history
    // but bulletproof.
    const TAIL_CHARS = 800;
    const tail = trimmed.length > TAIL_CHARS ? '…' + trimmed.slice(-TAIL_CHARS) : trimmed;
    const anchor = `\n\n--- your prior segment ended here (tail shown) ---\n${tail}\n--- resume from AFTER this exact character ---\n`;
    // Mid-SVG: <svg opened but no </svg> in the tail
    if (/<svg\b/.test(trimmed) && !/<\/svg>\s*$/.test(trimmed)) {
      return `(continue — you were mid-SVG. Resume the SVG from where it was cut, close all tags. Do NOT restart the diagram or emit a preamble.)${anchor}`;
    }
    // Mid-fenced code block: odd number of ``` fences
    const fenceCount = (trimmed.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      return `(continue — you were inside a fenced code block. Finish the code, close with \`\`\` on its own line, then continue prose. No recap.)${anchor}`;
    }
    // Mid-numbered-list: last non-empty line begins with N. or N)
    const listMatch = trimmed.match(/(?:^|\n)(\d+)[.)]\s[^\n]*$/);
    if (listMatch) {
      const nextNum = parseInt(listMatch[1], 10) + 1;
      return `(continue — you were on a numbered list. Resume from ${nextNum}. No recap.)`;
    }
    // Mid-table row (ends with pipe)
    if (trimmed.endsWith('|')) {
      return '(continue — you were mid-table. Complete the current row and any remaining rows. No recap.)';
    }
    // Mid-sentence: ends with comma / colon / dash / conjunction
    if (/[,:—-]\s*$/.test(trimmed) || /\b(và|hoặc|nhưng|and|or|but|then|because|so)\s*$/i.test(trimmed)) {
      return '(continue — you were mid-sentence. Finish the sentence, then continue. No recap.)';
    }
    return '(continue — pick up exactly where you left off. Do NOT recap or repeat. If your response was genuinely complete, emit [END] on its own line.)';
  }

  /** 0.4.161 — unified continuation loop replacing v0.4.159's thinking-only
   *  recurse. Handles three completion cases beyond a clean [END]:
   *   • stop='thinking_only'          → THINKING_ONLY_CONTINUE_HINT
   *   • stop='max_tokens'             → content-aware hint (mid-SVG/code/list/…)
   *   • stop='end_turn' without [END] → END_MARKER_NUDGE_HINT (1 disambiguation pass)
   *
   *  Loop terminates on:
   *   • end_turn with [END] marker    → reason='success'
   *   • any non-continuable stop      → reason='success'
   *   • ≥85% ctx window used          → reason='budget-exceeded'
   *   • user Stop                     → reason='cancelled'
   *   • runtime error                 → reason='error'
   *
   *  Broadcasts chat.continuation.{start,step,done} for the webview to
   *  render an inline segment indicator (bubble merge — no new bubble
   *  spawns during continuation). Cost + usage accumulate across all
   *  segments so chat.done reflects the whole turn.
   *
   *  Not reentrant per chat. */
  private async runContinuationLoop(args: {
    chatId: string;
    session: ChatSession;
    model: string;
    thinking?: { effort: ThinkingEffort };
    developerMode: boolean;
    hasSystemNote: boolean;
    oldTokenBudget: number;
    ctxMax: number;
    initialStop: string;
    initialCost: number;
    initialUsage: { inTokens: number; outTokens: number; cacheRead: number; cacheWrite: number };
  }): Promise<{ cost: number; stop: string; cancel: boolean; usage: { inTokens: number; outTokens: number; cacheRead: number; cacheWrite: number } }> {
    const { chatId, session, model, thinking, developerMode, hasSystemNote, oldTokenBudget, ctxMax } = args;
    let cost = args.initialCost;
    let usage = { ...args.initialUsage };
    let stop = args.initialStop;
    let cancel = false;
    let segment = 1;                 // segment 1 = initial call; loop starts at 2

    const startTokens = approxTokensForMsgs(session.runtimeMessages);
    this.broadcast('chat.continuation.start', {
      chatId, ctxMax, initialTokens: startTokens, ceiling: THINKING_RECURSE_CTX_CEILING,
    });

    let doneReason: 'success' | 'budget-exceeded' | 'cancelled' | 'error' = 'success';

    // 0.4.215 — override effort for the next segment when the model
    // signals [NEED_MORE] (dump remaining, no thinking) vs [NEED_THINK]
    // (keep user's effort). Reset each iteration; falls back to
    // args.thinking (user's chosen effort) when no marker present.
    let nextEffortOverride: { effort: ThinkingEffort } | 'skip' | null = null;
    // 0.4.233 — track whether the segment we just ran had thinking
    // stripped. Used to reset back to thinking when a skip-thinking
    // segment itself hits max_tokens (indicates genuinely long output
    // that needs planning next).
    let priorWasSkip = false;

    while (true) {
      // Decide whether the current stop reason justifies another segment.
      const lastText = this.lastAssistantText(session);

      // 0.4.215 — self-managed budget markers take priority over
      // heuristics. Model can emit [DONE]/[NEED_MORE]/[NEED_THINK] on
      // the tail of a segment; backend respects the signal.
      if (DONE_MARKER_RX.test(lastText)) {
        this.stripTrailingMarker(session, DONE_MARKER_RX);
        doneReason = 'success';
        break;
      }
      if (END_MARKER_RX.test(lastText)) {
        // Legacy marker — same semantic as [DONE].
        this.stripTrailingMarker(session, END_MARKER_RX);
        doneReason = 'success';
        break;
      }
      let markerHint: string | null = null;
      if (NEED_MORE_MARKER_RX.test(lastText)) {
        this.stripTrailingMarker(session, NEED_MORE_MARKER_RX);
        nextEffortOverride = 'skip';   // no thinking on next segment
        markerHint = '(continue — dump the remaining content. Thinking is disabled for this segment so all output budget goes to visible content.)';
      } else if (NEED_THINK_MARKER_RX.test(lastText)) {
        this.stripTrailingMarker(session, NEED_THINK_MARKER_RX);
        nextEffortOverride = null;     // keep user's effort
        markerHint = '(continue — you asked for more thinking before the next chunk. Thinking is enabled; plan the next chunk then dump it.)';
      } else {
        nextEffortOverride = null;
      }

      let hint: string | null = markerHint;
      // 0.4.214 — when the prior segment's visible output is empty (i.e.
      // the whole 12.8k budget was consumed by thinking on the Renesas
      // backend), ANY stop_reason should route to THINKING_ONLY_CONTINUE_HINT.
      // Previously only stop==='thinking_only' matched; but the API most
      // often reports 'max_tokens' when it hard-caps mid-thinking, so the
      // generic buildContinuationHint fired and produced an ambiguous
      // "(continue — pick up where you left off)" that the model
      // misinterpreted as "the user is asking me a new question".
      const priorEmpty = this.isLastAsstThinkingOnly(session);
      if (markerHint) {
        // marker takes priority — hint already set above
      } else if (stop === 'thinking_only' || priorEmpty) {
        hint = THINKING_ONLY_CONTINUE_HINT;
        // 0.4.233 — prior segment ended MID-THINKING (no visible output).
        // Keep user's thinking effort so the model can finish its plan and
        // then dump. Downgrading to no-thinking here (old v0.4.215) cut the
        // model off mid-plan and produced malformed dumps. Skip only fires
        // for the max_tokens-with-content case below.
        nextEffortOverride = null;
      } else if (stop === 'max_tokens') {
        hint = this.buildContinuationHint(lastText);
        // 0.4.233 — mid-dump cap on a segment that HAD thinking → strip
        // thinking on the next segment so the whole 12.8k budget goes to
        // visible dump (Image #88 fix). But if the prior segment already
        // had thinking stripped and STILL hit max_tokens, that means the
        // dump itself is long enough to warrant planning again — reset
        // to user's thinking effort. One-shot skip: never chain two
        // no-thinking segments in a row.
        nextEffortOverride = priorWasSkip ? null : 'skip';
      } else {
        // 0.4.193 — end_turn without [END] marker is treated as terminal.
        // The prior nudge (v0.4.161) forced a segment 2 pass asking the
        // model to "resend the final line and append [END]". Short-reply
        // models like Haiku interpreted that as "resend the whole reply",
        // producing a visible duplicate of the response plus segment
        // markers (Image #49). When the model instead returned an empty
        // segment 2 it tripped the thinking-only heuristic and surfaced
        // "Model finished without a response" (Image #50). The [END]
        // convention only meaningfully protects long dev-mode turns and
        // is not worth the false-positive tax on plain chat.
        // Terminal: end_turn+[END], end_turn+already-nudged, or other stop.
        doneReason = 'success';
        break;
      }

      const tokensBefore = approxTokensForMsgs(session.runtimeMessages);
      if (tokensBefore >= Math.floor(ctxMax * THINKING_RECURSE_CTX_CEILING)) {
        doneReason = 'budget-exceeded';
        this.log.warn(`[chat-v2] continuation budget exceeded: ${tokensBefore}/${ctxMax} tokens at segment ${segment}`);
        break;
      }

      segment += 1;
      // 0.4.166 — Fire the hint card BEFORE asstStart so it lands between
      // segment N-1's finished bubble and segment N's fresh empty bubble.
      // Previously asstStart fired first (creating segment N's empty
      // bubble at end of thread), then the hint card was appended after
      // it — pushing the hint to the visual bottom of the turn instead of
      // sitting between the two segments where it belongs.
      //
      // 0.4.182 — the end_turn+missing-[END] nudge is a silent housekeeping
      // pass ("resend the last line + [END]") — it's noise for the user
      // when the model was actually done, and worse: on short replies the
      // segment 2 [END]-only bubble is masked by .continuation-part so all
      // the user sees is a bare hint card with no reply text. Skip the
      // visual card for this reason. Segment counter still ticks via
      // continuation.step below.
      // 0.4.193 — end_turn no longer triggers a continuation segment
      // (see terminal branch above), so `stop` here is always
      // thinking_only or max_tokens; both warrant the visual hint card.
      this.broadcast('chat.continuation.hint', {
        chatId, segment, hint, reason: stop,
      });
      this.broadcast('chat.continuation.step', {
        chatId, segment, tokensAccumulated: tokensBefore, costUsd: cost, ctxMax,
        reason: stop, hint,
      });
      // 0.4.162 — Fork a fresh streaming bubble for this segment BEFORE the
      // resume fires. Each session.resume() starts a new runStream where
      // iterCount resets to 0, so the built-in `iterCount >= 2` fork inside
      // runStream never triggers for continuation segments. Without this
      // broadcast, segment N's content_block_start (index=0) lands in the
      // same DOM slot as segment N-1 and overwrites it. Frontend's
      // onAsstStart handles the actual fork + .continuation-part tagging.
      this.broadcast('chat.asstStart', { chatId });

      try {
        // 0.4.217 — auto-compact runtime before firing segment N if it
        // now exceeds 90% ctx. Segment 1's asst turn (thinking-only or
        // partial dump) may have just pushed us past the threshold.
        const runtimeTokens = approxTokensForMsgs(session.runtimeMessages) + this.approxToolTokens();
        if (runtimeTokens > Math.floor(ctxMax * 0.95)) {
          this.log.info(`[chat-v2] continuation auto-compact: runtime=${runtimeTokens} > 95% ctxMax=${ctxMax}`);
          try { await this.compactChat(chatId); }
          catch (e) { this.log.warn(`[chat-v2] auto-compact in continuation failed: ${(e as Error).message}`); }
        }
        // 0.4.215 — nextEffortOverride comes from marker detection above.
        // 'skip' → omit opts.thinking entirely (no thinking channel).
        // null → keep user's chosen effort (opts.thinking).
        const resumeThinking = nextEffortOverride === 'skip' ? undefined : thinking;
        priorWasSkip = nextEffortOverride === 'skip';
        const gen = session.resume({
          model, thinking: resumeThinking, developerMode,
          synthetic: true,
          toolContext: {
            chatId, developerMode, allowAskUser: true,
            pinArtifact: input => this.pinModelArtifact(chatId, input),
            updateArtifact: input => this.updateModelArtifact(chatId, input),
            spawnAgents: async input => {
              const agents = await this.agentRegistryFor(chatId);
              return {
                results: await agents.spawn(undefined, input?.agents || [], {
                  model,
                  effort: resumeThinking?.effort || 'medium',
                  availableModels: await this.availableAgentModels(),
                }),
              };
            },
            releaseAgents: input => this.releaseAgents(chatId, undefined, input),
          },
        }, hint ?? undefined);
        const r = await this.runStream(chatId, gen, model);
        cost += r.cost;
        usage.inTokens   += r.usage.inTokens;
        usage.outTokens  += r.usage.outTokens;
        usage.cacheRead  += r.usage.cacheRead;
        usage.cacheWrite += r.usage.cacheWrite;
        stop = r.stop;
        cancel = r.cancel;

        if (cancel || stop === 'cancelled') {
          doneReason = 'cancelled';
          break;
        }
      } catch (e) {
        this.log.warn(`[chat-v2] continuation segment ${segment} threw: ${(e as Error).message}`);
        doneReason = 'error';
        stop = 'error';
        break;
      }
    }

    const finalTokens = approxTokensForMsgs(session.runtimeMessages);
    this.broadcast('chat.continuation.done', {
      chatId, reason: doneReason, segments: segment, totalCost: cost,
      finalTokens, ctxMax,
    });

    return { cost, stop, cancel, usage };
  }

  /** Drive a SessionEvent generator to completion, forwarding raw SSE
   *  events to the webview as chat.chunk envelopes the v2 webview
   *  understands.  Returns { cost, stop, cancel } summary. */
  private async runStream(
    chatId: string,
    gen: AsyncGenerator<SessionEvent>,
    model: string = 'claude-opus-4-7',
  ): Promise<{ cost: number; stop: string; cancel: boolean; usage: { inTokens: number; outTokens: number; cacheRead: number; cacheWrite: number } }> {
    let cost = 0;
    let stop = 'end_turn';
    let cancel = false;
    const toolNameById = new Map<string, string>();
    let usedMutatingExcalidrawTool = false;
    let boardSnapshotCaptured = false;
    let boardCaptureFocus: BoardCaptureFocus | undefined;
    // 0.4.105 — pair each tool result with its tool_use_id so surfaceImages
    // can broadcast image.attach WITH toolUseId. Without the id the webview
    // falls back to appending the image at the end of the bubble strip,
    // which lands AFTER the trailing assistant text ("Đây là ảnh…") — visual
    // regression where the caption sits above the image.
    const tailTextForImages: Array<{ id: string; text: string }> = [];
    const artifactHandledToolIds = new Set<string>();
    const artifactSnapshotsByToolId = new Map<string, Map<string, number>>();
    // Accumulator surfaced on chat.done so the webview's HUD has real
    // numbers instead of the hardcoded 0/0/0/0 it used to receive (#10
    // in 0.2.18 — cost ledger 0/NaN). ChatSession yields a fresh `usage`
    // every iteration with the *running* turn total, so we just keep the
    // last one.
    let lastUsage = { inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0 };
    // 0.4.151 — tracked so `assistant-start` can decide whether to fork a
    // new bubble on the frontend (iter ≥ 2 only; iter 1's bubble comes
    // from onChatStart).
    let iterCount = 0;

    for await (const evt of gen) {
      // Forward raw Anthropic SSE frames verbatim — the webview rebuilds
      // text / thinking / tool blocks from these (cleaner than mapping
      // our own StreamEvent variants).
      if (evt.type === 'sse_raw') {
        this.broadcast('chat.chunk', { chatId, evt: { event: evt.event || '', data: evt.data } });
        continue;
      }
      if (evt.type === 'tool-start') {
        if (evt.id) {
          toolNameById.set(evt.id, evt.name || '');
          try { artifactSnapshotsByToolId.set(evt.id, await this.snapshotArtifacts(chatId)); }
          catch (e) { this.log.warn(`[chat-v2] artifact snapshot (${evt.id}): ${(e as Error).message}`); }
        }
        if (isMutatingExcalidrawTool(String(evt.name || ''))) usedMutatingExcalidrawTool = true;
        this.broadcast('tool.start', { chatId, id: evt.id || '', name: evt.name || '' });
        continue;
      }
      if (evt.type === 'iter') {
        // 0.4.151 — remember which outer iter we're on so the next
        // 'assistant-start' knows whether it needs to fork a new bubble.
        iterCount = evt.iter || 0;
        continue;
      }
      if (evt.type === 'assistant-start') {
        // 0.4.151 — fork a new streaming wrap on every iter ≥ 2. Iter 1
        // already has the wrap that chat.start created on the frontend
        // (see onChatStart in app.js). Without this broadcast the same
        // wrap accumulated blocks from every iter; content_block_start
        // indices reset to 0 per API call, so iter-2's index-0 thinking
        // block silently overwrote iter-1's index-0 thinking in
        // a.blocks — then appendMissingTurns saw the persisted iter-1
        // turn wasn't reflected in the DOM and cloned a fresh bubble
        // for it, producing the visible duplicate (Image #71).
        if (iterCount >= 2) {
          this.broadcast('chat.asstStart', { chatId });
        }
        continue;
      }
      if (evt.type === 'asst-persisted') {
        // 0.4.113 — fire chat.asstTurn per iter so the streaming wrap for
        // this iter gets tagged before onAsstStart forks to a new bubble.
        // Without this, the LAST asstTurn broadcast (at outer `done`)
        // tagged only the final iter's wrap, and appendMissingTurns
        // re-rendered every prior iter as a fresh bubble → duplicate
        // thinking / text / tool_use trailing the assistant response.
        if (typeof evt.turnId === 'number') {
          this.broadcast('chat.asstTurn', { chatId, turnId: evt.turnId });
        }
        continue;
      }
      if (evt.type === 'tool-done' || evt.type === 'tool-error') {
        // Streaming events from ChatSession (already ToolExecutor results).
        const isError = evt.type === 'tool-error';
        const tid = String(evt.id || '');
        const toolName = String((tid && toolNameById.get(tid)) || evt.name || '');
        const isImageTool = /image|generate_image/i.test(toolName);
        this.broadcast('tool.done', { chatId, id: evt.id, isError });
        if (!isError && tid) {
          const before = artifactSnapshotsByToolId.get(tid);
          if (before) {
            // Sandbox-created files are only candidates for a later
            // aura_artifact_pin call. Do not append/broadcast aura_artifact here:
            // otherwise the frontend renders the file after the sandbox result
            // before the model has explicitly pinned it.
            artifactSnapshotsByToolId.delete(tid);
          }
        }
        if ((evt.resultFull || evt.result) && !isImageTool) {
          tailTextForImages.push({
            id:   tid,
            text: evt.resultFull || evt.result || '',
          });
        }
        if (!isError && isMutatingExcalidrawTool(toolName)) {
          usedMutatingExcalidrawTool = true;
          boardCaptureFocus = focusFromExcalidrawInput(tid, toolName, (evt as any).input) || boardCaptureFocus;
        }
        // 0.4.267 — visualise MCP: save_visualise returns a URL to a file
        // in the proxy container. Fetch bytes, save via ArtifactStore, and
        // broadcast artifact.attach so the FE renders the diagram inline
        // without any content in the model's reply text.
        if (!isError && tid && toolName.endsWith('__save_visualise')) {
          const raw = evt.resultFull || evt.result || '';
          try { await this.processVisualiseArtifact(chatId, tid, raw); }
          catch (e) { this.log.warn(`[chat-v2] visualise artifact (${tid}): ${(e as Error).message}`); }
        }
        if (!isError && tid && isImageTool) {
          const raw = evt.resultFull || evt.result || '';
          try {
            if (await this.processMcpImageArtifacts(chatId, tid, raw)) artifactHandledToolIds.add(tid);
          }
          catch (e) { this.log.warn(`[chat-v2] mcp image artifact (${tid}): ${(e as Error).message}`); }
        }
        continue;
      }
      if (evt.type === 'usage') {
        if (typeof evt.costUsd === 'number') cost = evt.costUsd;
        // Forward live usage to the webview so the per-turn HUD ticks during
        // streaming (used to only surface at chat.done, hence the $NaN —
        // composer initialised cost as null and did arithmetic on it).
        const u = (evt.usage || {}) as Record<string, unknown>;
        lastUsage = {
          inTokens:   Number(u.inTokens   ?? 0) || 0,
          outTokens:  Number(u.outTokens  ?? 0) || 0,
          cacheRead:  Number(u.cacheRead  ?? 0) || 0,
          cacheWrite: Number(u.cacheWrite ?? 0) || 0,
        };
        // Billing usage accumulates across tool-loop iterations; it is not the
        // context currently resident in the next request. Keep the cost ledger
        // cumulative, but derive context pressure from runtime messages.
        const ctxMax = contextWindowFor(model);
        const session = this.sessions.get(chatId);
        const contextUsed = session
          ? approxTokensForMsgs(session.runtimeMessages) + this.approxToolTokens()
          : lastUsage.inTokens;
        this.log.info(`[chat-v2] chat.usage billedIn=${lastUsage.inTokens} context=${contextUsed} out=${lastUsage.outTokens} cost=${cost.toFixed(4)} model=${model}`);
        this.broadcast('chat.usage', {
          chatId, usage: lastUsage, costUsd: cost,
          contextMax: ctxMax,
          contextUsed,
          contextPct: ctxMax ? contextUsed / ctxMax : 0,
        });
        continue;
      }
      if (evt.type === 'cap-reached') {
        this.broadcast('chat.outerCapReached', { chatId, cap: evt.cap || 0 });
        continue;
      }
      if (evt.type === 'error') {
        this.broadcast('chat.error', { chatId, error: evt.text || 'stream error' });
        stop = 'error';
        continue;
      }
      if (evt.type === 'cancelled') {
        // 0.4.148 — user pressed Stop. Do NOT broadcast chat.error (which
        // paints a red banner). chat.done with stopReason='cancelled' below
        // triggers the soft "⏹ Stopped by you" note the webview already
        // renders at line ~2983 of app.js.
        stop = 'cancelled';
        cancel = true;
        continue;
      }
      if (evt.type === 'done') {
        // End of one outer iteration. Surface any inline images from the
        // assistant's last text + every tool result we collected. Emit one
        // surfaceImages call PER tool result so each image.attach carries
        // that tool's id — the webview anchors on it (v0.4.105). Trailing
        // assistant text is scanned separately with no id (rare edge case:
        // model dumps an image URL directly, no tool involved).
        const sess = this.sessions.get(chatId);
        const lastText = sess ? this.lastAssistantText(sess) : '';
        // 0.4.150 — if the model produced ONLY a thinking block (no text,
        // no tool_use) and stop is still 'end_turn', flag it so the webview
        // can paint an unmistakable "no response" hint instead of relying
        // on empty-DOM heuristics (Image #67: thinking rendered but no
        // hint appeared, so the user thought the reply was on its way).
        if (stop === 'end_turn' && sess && this.isLastAsstThinkingOnly(sess)) {
          stop = 'thinking_only';
        }
        const artifactToolIds = new Set<string>();
        if (sess) {
          for (const m of sess.messages) {
            const blocks = Array.isArray(m.content) ? m.content : [];
            for (const b of blocks as any[]) {
              if (b?.type === 'aura_artifact' && b.toolUseId) artifactToolIds.add(String(b.toolUseId));
            }
          }
        }
        for (const entry of tailTextForImages) {
          if (entry.id && (artifactHandledToolIds.has(entry.id) || artifactToolIds.has(entry.id))) continue;
          this.surfaceImages(chatId, entry.text, entry.id).catch(e =>
            this.log.warn(`[chat-v2] surfaceImages(${entry.id}): ${(e as Error).message}`));
        }
        let boardDoneMarkerSeen = false;
        if (sess && (BOARD_DONE_MARKER_RX.test(lastText) || BOARD_DONE_MARKER_ANY_TEST_RX.test(lastText))) {
          boardDoneMarkerSeen = true;
          this.stripBoardDoneMarker(sess);
          try { await this.persistSession(chatId, sess); }
          catch (e) { this.log.warn(`[chat-v2] persist after board marker strip: ${(e as Error).message}`); }
          if (!boardSnapshotCaptured) {
            boardSnapshotCaptured = true;
            try { await this.captureExcalidrawSnapshot(chatId, 'marker', boardCaptureFocus); }
            catch (e) { this.log.warn(`[chat-v2] board snapshot (marker): ${(e as Error).message}`); }
          }
        }
        const visibleLastText = sess ? this.lastAssistantText(sess) : lastText;
        if (visibleLastText) {
          this.surfaceImages(chatId, visibleLastText).catch(e =>
            this.log.warn(`[chat-v2] surfaceImages(lastText): ${(e as Error).message}`));
        }
        if (sess && usedMutatingExcalidrawTool && !boardDoneMarkerSeen && !boardSnapshotCaptured) {
          boardSnapshotCaptured = true;
          this.log.warn('[board-capture] mutating Excalidraw tools used but no done marker; captured at turn end');
          try { await this.captureExcalidrawSnapshot(chatId, 'fallback', boardCaptureFocus); }
          catch (e) { this.log.warn(`[chat-v2] board snapshot (fallback): ${(e as Error).message}`); }
        }
        // Tag the streaming wrap with the persisted asst turn-id so
        // appendMissingTurns()'s seen-set picks it up. WITHOUT this the
        // webview re-renders the same response a second time after the
        // stream finishes (#5 in 0.4.1 — duplicate response bug).
        if (sess) {
          // Walk back from the end of messages to find the most recent
          // assistant turn. Tool-result turns are role:'user' with a
          // tool_result block — skip those.
          for (let i = sess.messages.length - 1; i >= 0; i--) {
            if (sess.messages[i].role === 'assistant') {
              this.broadcast('chat.asstTurn', { chatId, turnId: i });
              break;
            }
          }
        }
      }
    }
    return { cost, stop, cancel, usage: lastUsage };
  }

  /** 0.4.150 — true when the model's most recent assistant turn contains a
   *  thinking block but no text and no tool_use. Used by runStream to flip
   *  stop='end_turn' → 'thinking_only' so the webview knows the reply is
   *  effectively empty and shows a resend hint. */
  private isLastAsstThinkingOnly(session: ChatSession): boolean {
    const msgs = session.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string') return !m.content.trim();
      const blocks = m.content;
      let hasThinking = false;
      let hasVisible = false;
      for (const b of blocks) {
        const t = (b as any)?.type;
        if (t === 'thinking') hasThinking = true;
        else if (t === 'text' && String((b as any).text || '').trim()) hasVisible = true;
        else if (t === 'tool_use') hasVisible = true;
      }
      return hasThinking && !hasVisible;
    }
    return false;
  }

  /** Pull the last assistant turn's text — used by image surfacer. */
  private lastAssistantText(session: ChatSession): string {
    const msgs = session.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string') return m.content;
      return m.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
    }
    return '';
  }

  /** Two image surfacing channels:
   *    1. /api/images/<…> URLs from renesas-image MCP — fetch over HTTP.
   *    2. /home/aura-artifacts/<…> paths from sandbox tools — read via
   *       the host-mounted ${HOME}/aura-artifacts/.
   /** Path to the per-chat compact-summary file. Lives IN the project
   *  folder next to `<date>_<chatId>.jsonl` as `<date>_<chatId>.compact.md`.
   *
   *  0.4.201 — was previously `<sessionsRoot>/<chatId>.systemnote.md`
   *  (flat, no date prefix, outside project folder). Layout change: file
   *  now sits next to its .jsonl so a project directory is self-contained
   *  and rsync/ls give a coherent view. The user migrated the one
   *  pre-existing file (deba8081...) by hand. Newer chats never wrote to
   *  the old path, so no runtime migration is needed. */
  private async legacyCompactPath(chatId: string): Promise<string> {
    const files = await ChatStore.filesForChatId(this.sessionsDir, chatId);
    if (files.length > 0) {
      // Use the most-recent JSONL basename so a chat that spans multiple
      // days (rare — sessions do NOT roll over daily) still writes into a
      // predictable file paired with the latest day.
      const latest = files[files.length - 1];
      return latest.replace(/\.jsonl$/, '.compact.md');
    }
    // Chat has no persisted JSONL yet (first user turn hasn't been
    // written) — synthesise a path in the active project folder using
    // today's date, matching ChatStore's own naming scheme.
    const day = new Date().toISOString().slice(0, 10);
    const meta = this.chats.find(c => c.id === chatId);
    const projectDir = meta?.projectId ? (meta.projectId === '__orphan__' ? '_orphan' : meta.projectId) : '_orphan';
    return path.join(this.sessionsDir, projectDir, `${day}_${chatId}.compact.md`);
  }

  /** 0.4.217 — legacy compact-note reader (pre-runtime-jsonl era). Only
   *  used during first-touch migration to fold the legacy .compact.md into
   *  the new runtime file. Post-migration the runtime file's first turn
   *  IS the compact summary and this returns ''. */
  private async readLegacyCompactNote(chatId: string): Promise<string> {
    try { return await fs.readFile(await this.legacyCompactPath(chatId), 'utf8'); }
    catch { return ''; }
  }

  /** 0.4.217 — pull the current compact summary text from the runtime
   *  file, or '' when there isn't one. The first runtime turn is a
   *  compact-summary turn iff its content begins with the `[COMPACT
   *  SUMMARY]\n` prefix. Used by the `chats.systemNote` RPC and the
   *  auto-compact threshold check. */
  private async readCompactSummary(chatId: string): Promise<string> {
    const prefix = '[COMPACT SUMMARY]\n';
    const extract = (msg: any): string => {
      const text = msg && typeof msg.content === 'string' ? msg.content : '';
      return text.startsWith(prefix) ? text.slice(prefix.length) : '';
    };
    // 0.4.229 — full history is now the source of truth for the compact
    // marker (persisted with kind:'compact'). Check in-memory first,
    // then re-scan disk. Runtime head is still checked as a fallback
    // for pre-0.4.229 chats compacted before the marker was written to
    // full history.
    try {
      const sess = this.sessions.get(chatId);
      if (sess) {
        for (let i = sess.messages.length - 1; i >= 0; i--) {
          if ((sess.messages[i] as any).kind === 'compact') {
            const t = extract(sess.messages[i]);
            if (t) return t;
          }
        }
        const t = extract(sess.runtimeMessages[0]);
        if (t) return t;
      }
    } catch { /* ignore */ }
    try {
      const msgs = await ChatStore.loadByChatId(this.sessionsDir, chatId);
      for (let i = msgs.length - 1; i >= 0; i--) {
        if ((msgs[i] as any).kind === 'compact') {
          const t = extract(msgs[i]);
          if (t) return t;
        }
      }
    } catch { /* ignore */ }
    try {
      const runtimePath = await ChatStore.runtimeFileForChatId(this.sessionsDir, chatId);
      if (runtimePath) {
        const rMsgs = await ChatStore.loadRuntime(runtimePath);
        const t = extract(rMsgs[0]);
        if (t) return t;
      }
    } catch { /* ignore */ }
    return this.readLegacyCompactNote(chatId);
  }

  /** Compact a chat: ask the model to summarize messages older than the
   *  retain window into a single Markdown system note.
   *
   *  Two histories are maintained (0.4.157):
   *    • Full history — on-disk JSONL + session.messages. NEVER trimmed.
   *      The user reads this in the UI; it is the source of truth for
   *      reload, delete-turn, export, etc.
   *    • In-context history — what we send to the model each turn:
   *        [systemnote (rolling summary of everything up to compactedUpTo)]
   *      + last N raw messages after compactedUpTo (pruneHistory tail cap).
   *
   *  Rolling: subsequent compacts only summarise the NEW slice since the
   *  last watermark and merge it into the existing note (rather than
   *  re-summarising from turn 1 every time — that would burn tokens and
   *  slowly rewrite older facts as the model paraphrases them). The
   *  KEEP tail is left raw so the model still sees the last K turns
   *  verbatim regardless of watermark.
   */
  private approxToolTokens(): number {
    try { return approxTokensForTools(this.toolRegistry.toolDefs()); }
    catch { return 0; }
  }

  private compactTextFromBlock(b: any): string {
    if (!b) return '';
    if (b.type === 'text') {
      const t = String(b.text || '');
      if (/^\s*Saved:\s*https?:\/\//i.test(t.trim())) {
        const slug = t.trim().split('/').filter(Boolean).pop() || 'visual artifact';
        return `Created visual artifact: ${slug} (URL omitted from compact summary).`;
      }
      return t;
    }
    if (b.type === 'thinking') return `(thinking) ${b.thinking || ''}`;
    if (b.type === 'tool_use') return `(tool_use ${b.name}) ${JSON.stringify(b.input || {})}`;
    if (b.type === 'tool_result') {
      const raw = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
      const trimmed = raw.trim();
      if (/^Saved:\s*https?:\/\//i.test(trimmed) || /https?:\/\/[^\s"']*\/api\/visualise\/view\//i.test(trimmed)) {
        let label = 'visual artifact';
        try {
          const obj = JSON.parse(trimmed);
          label = obj.name || obj.filename || obj.path || obj.url?.split('/').filter(Boolean).pop() || label;
        } catch {
          const m = trimmed.match(/\/api\/visualise\/view\/([^\s"')]+)/i);
          if (m) label = m[1];
        }
        return `(tool_result) Created visual artifact: ${label} (URL omitted from compact summary).`;
      }
      return `(tool_result) ${raw}`;
    }
    return '';
  }

  private isBadCompactSummary(summary: string, sourceTokens: number): string | null {
    const s = summary.trim();
    if (!s) return 'empty-summary';
    if (/^Saved:\s*https?:\/\//i.test(s)) return 'url-only-summary';
    if (/^https?:\/\/\S+$/i.test(s)) return 'url-only-summary';
    if (sourceTokens > 8_000 && s.length < 240) return 'too-short-summary';
    return null;
  }

  private async compactChat(chatId: string): Promise<any> {
    const session = await this.getSession(chatId);
    const rec = this.chats.find(c => c.id === chatId);
    const model = String(rec?.model ?? 'claude-opus-4-7');
    return this.compactSessionCore(session, model, { chatId });
  }

  /** Summarise a ChatSession's runtime into a single compact-summary turn,
   *  replacing the runtime in-place. Shared by the root chat's compactChat()
   *  and by agent auto-compact (AgentRunner) — leaf sessions are NOT in
   *  this.sessions, so this takes the ChatSession directly.
   *
   *  When `opts.chatId` is set, UI compact events broadcast to that scope and
   *  the chat record's compactedUpTo is persisted (root path). Agent auto-
   *  compact omits chatId: no broadcast, no chat-record update. Returns
   *  { ok: true, ... } on success; run() callers treat ok as "did compact". */
  private async compactSessionCore(
    session: ChatSession,
    model: string,
    opts: { chatId?: string } = {},
  ): Promise<any> {
    const chatId = opts.chatId;
    const rec = chatId ? this.chats.find(c => c.id === chatId) : undefined;
    const runtime = session.runtimeMessages;
    const fullMsgs = session.messages;
    const ctxMax = contextWindowFor(model);
    const MIN_COMPACT_TOKENS = 2_000;
    const totalTokens = approxTokensForMsgs(runtime);
    if (totalTokens < MIN_COMPACT_TOKENS) {
      return {
        ok: false, reason: 'too-few-tokens',
        tokens: totalTokens, minTokens: MIN_COMPACT_TOKENS,
      };
    }

    if (chatId) this.broadcast('chat.compact.start', {
      chatId,
      oldTurnCount: runtime.length,
      keepCount: 0,
      newHeadTokens: totalTokens,
      tailTokens: 0,
      ctxMax,
      incremental: false,
      fullRuntime: true,
    });

    let priorBody = '';
    let flatStart = 0;
    if (runtime.length > 0) {
      const first = runtime[0];
      const firstText = typeof first.content === 'string' ? first.content : '';
      const prefix = '[COMPACT SUMMARY]\n';
      if (first.role === 'user' && firstText.startsWith(prefix)) {
        priorBody = firstText.slice(prefix.length).trim();
        flatStart = 1;
      }
    }
    const flat = runtime.slice(flatStart).map((m, i) => {
      const role = m.role.toUpperCase();
      const blocks = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text', text: String(m.content || '') }];
      const text = blocks.map((b: any) => this.compactTextFromBlock(b)).filter(Boolean).join('\n');
      return `--- TURN ${i + 1} (${role}) ---\n${text}`;
    }).join('\n\n');

    const summarizePrompt =
      `Create a COMPLETE compact runtime summary for a continuing coding/chat session. ` +
      `The raw runtime will be replaced by ONLY your summary turn, with no verbatim tail kept, so the summary must be sufficient for the next model call to continue accurately.\n\n` +
      `Preserve: user goals and preferences, current task state, decisions made, important file paths, code/config snippets, commands/results, generated artifacts, unresolved questions, and next steps. ` +
      `Drop: small talk, repeated thinking, raw tool JSON that adds no durable context, and bare artifact URLs. ` +
      `Never output only a URL, a \`Saved: ...\` line, or a one-line artifact pointer. If a tool saved an artifact, describe what was created and why. ` +
      `Use structured Markdown. Target 700-1200 words when the source is substantial.\n\n` +
      (priorBody ? `## Prior compact summary already in runtime\n${priorBody}\n\n` : '') +
      `## Runtime messages to compact\n${flat}`;

    let summary = '';
    const tmpAbort = new AbortController();
    try {
      const { streamChat } = await import('./ChatStreamer');
      for await (const evt of streamChat({
        baseUrl: this.proxy.baseUrl(),
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: summarizePrompt }],
        signal: tmpAbort.signal,
      })) {
        if (evt.type === 'text') {
          summary += evt.text;
          if (chatId) this.broadcast('chat.compact.progress', { chatId, chars: summary.length });
        }
        else if (evt.type === 'message_done') break;
        else if (evt.type === 'error') throw new Error(evt.error);
      }
    } catch (e) {
      this.log.warn(`[chat-v2] compact: summarize failed: ${(e as Error).message}`);
      if (chatId) this.broadcast('chat.compact.done', { chatId, ok: false, error: (e as Error).message });
      return { ok: false, reason: 'summarize-failed', error: (e as Error).message };
    }

    const bad = this.isBadCompactSummary(summary, totalTokens);
    if (bad) {
      if (chatId) this.broadcast('chat.compact.done', { chatId, ok: false, error: bad });
      return { ok: false, reason: bad };
    }

    const kSummarised = Math.round(totalTokens / 1000);
    const summaryHeader =
      `# Compacted history (${kSummarised}k tokens · ${runtime.length} runtime messages)\n\n` +
      `*Generated ${new Date().toISOString()} — runtime replaced by this compact summary; full history preserved locally.*\n\n` +
      summary.trim() + '\n';
    const compactTs = Date.now();
    const compactTurn: ChatMessage = {
      role: 'user',
      content: `[COMPACT SUMMARY]\n${summaryHeader}`,
      synthetic: true,
      kind: 'compact',
      ts: compactTs,
    };
    const newRuntime: ChatMessage[] = [compactTurn];
    try {
      await session.replaceRuntime(newRuntime);
    } catch (e) {
      if (chatId) this.broadcast('chat.compact.done', { chatId, ok: false, error: (e as Error).message });
      return { ok: false, reason: 'write-failed', error: (e as Error).message };
    }

    fullMsgs.push(compactTurn);
    try {
      const store = (session as any).store as ChatStore | undefined;
      await store?.append({
        ts: compactTs, role: 'user', content: compactTurn.content,
        synthetic: true, kind: 'compact',
      } as PersistedMessage);
    } catch (e) {
      this.log.warn(`[chat-v2] persist compact marker to history: ${(e as Error).message}`);
    }

    if (rec) {
      rec.compactedUpTo = fullMsgs.length;
      rec.updatedAt = Date.now();
      await this.saveMeta();
    }
    if (chatId) this.broadcast('chat.compact.done', {
      chatId, ok: true,
      summary: summary.trim(),
      summarizedCount: fullMsgs.length,
      keptCount: 0,
      newlyCompactedCount: runtime.length,
      newHeadTokens: totalTokens,
      tailTokens: 0,
      ctxMax,
      incremental: !!priorBody,
      fullRuntime: true,
    });
    return {
      ok: true,
      summarizedCount: fullMsgs.length,
      keptCount: 0,
      newlyCompactedCount: runtime.length,
      newHeadTokens: totalTokens,
      tailTokens: 0,
    };
  }

  /*  Render a chat session's messages array into a portable Markdown
   *  document. Mirrors the studio webview's visual ordering: thinking
   *  blocks become quoted italics, tool_use becomes a fenced JSON block,
   *  tool_result becomes a fenced text block. (#12 in 0.4.1) */
  private exportChatToMarkdown(title: string, messages: any[]): string {
    const out: string[] = [];
    out.push(`# ${title}`, '');
    out.push(`*Exported ${new Date().toISOString()}*`, '');
    out.push('---', '');
    let turnNo = 0;
    for (const m of messages) {
      const blocks = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text', text: String(m.content || '') }];
      // Skip synthetic (continue) user turns — they're an internal
      // mechanism, not user-authored content.
      if (m.role === 'user' && blocks.length === 1 && blocks[0].type === 'text'
          && (blocks[0].text || '').trim() === '(continue)') continue;
      turnNo++;
      out.push(`## ${m.role === 'user' ? '🧑 User' : '🤖 Assistant'} — turn ${turnNo}`, '');
      for (const b of blocks) {
        if (b.type === 'text')      out.push(b.text || '', '');
        else if (b.type === 'thinking') {
          const t = String(b.thinking || '').split('\n').map((l: string) => `> *${l}*`).join('\n');
          out.push(t, '');
        }
        else if (b.type === 'tool_use') {
          out.push(`**🔧 tool_use** \`${b.name}\``, '', '```json',
                   JSON.stringify(b.input ?? {}, null, 2), '```', '');
        }
        else if (b.type === 'tool_result') {
          const c = typeof b.content === 'string'
            ? b.content
            : JSON.stringify(b.content, null, 2);
          out.push(`**↳ tool_result**`, '', '```', c, '```', '');
        }
        else if (b.type === 'image') {
          out.push(`*[image: ${b.source?.media_type || 'unknown'} — embedded inline, omitted from export]*`, '');
        }
      }
      out.push('');
    }
    return out.join('\n');
  }

  /*  Each cached image is broadcast back to the webview as a chat.chunk
   *  with a synthetic `image.attach` event that the v2 webview's
   *  hydrateImageCards / renderToolUse can render inline. When toolUseId
   *  is set the webview anchors the image DOM node immediately after the
   *  matching .blk-tool-use so the trailing assistant caption text lands
   *  BELOW the image (0.4.105). */
  private async surfaceImages(chatId: string, text: string, toolUseId?: string) {
    if (!text) return;
    const broadcasts: Array<{ kind: 'fetch' | 'local'; src: string; cached: any }> = [];
    const sid = chatId || 'shared';

    // Cache-first pass — re-broadcast any /api/images/<file> we already cached
    // for this chat, regardless of proxy state. This is the reload path:
    // proxy may not be ready yet, but the bytes are on disk from the original
    // fetch and the webview just needs a fresh `image.attach` to re-render.
    const seenFilenames = new Set<string>();
    for (const filename of extractImageFilenames(text)) {
      const cached = await this.imageCache.lookupCached(filename, sid);
      if (cached) {
        broadcasts.push({ kind: 'fetch', src: filename, cached });
        seenFilenames.add(filename);
      }
    }

    if (this.proxy.isReady()) {
      const urls = extractImageUrls(text, this.proxy.baseUrl());
      const pending = urls.filter(u => !seenFilenames.has(u.split('/').pop()!.split('?')[0]));
      if (pending.length && !this.imageToken) await this.refreshToken();
      for (const u of pending) {
        const url = u.includes('token=') || !this.imageToken
          ? u
          : `${u}${u.includes('?') ? '&' : '?'}token=${this.imageToken}`;
        try {
          const cached = await this.imageCache.fetchAndCache(url, sid);
          broadcasts.push({ kind: 'fetch', src: url, cached });
        } catch (e) {
          this.log.warn(`[chat-v2] fetch ${url.split('?')[0]}: ${(e as Error).message}`);
        }
      }
    }

    // v0.4.259 — sandbox artifact paths (/home/aura-artifacts/, /tmp/aura-artifacts/)
    // are no longer scanned from text. They flow through processSandboxArtifacts
    // → `artifact.attach` (id-based). Only MCP /api/images/ paths surface here.

    for (const b of broadcasts) {
      this.broadcast('image.attach', {
        chatId,
        localPath: b.cached.localPath,
        filename:  b.cached.filename,
        mediaType: b.cached.mediaType,
        source:    b.src,
        toolUseId: toolUseId || undefined,
      });
    }
  }

  /* ─────────── attachments ─────────── */

  private async onAttachByPath(payload: any): Promise<any> {
    const p = typeof payload === 'string' ? payload : String(payload?.path || '');
    const chatId = typeof payload === 'string' ? '' : String(payload?.chatId || '');
    const mineruBackend = typeof payload === 'string' ? undefined : payload?.mineruBackend;
    if (!p) throw new Error('path required');
    try { await fs.access(p); }
    catch { return { error: `File not found: ${p}` }; }
    return this.parseAttachment(p, { chatId, mineruBackend });
  }

  /** Native host file dialogs have no standalone equivalent — the browser
   *  bridge already intercepts attach.pickFromHost(Path) client-side and
   *  replies {cancelled:true} without forwarding here. These stay as a
   *  defensive fallback for any future non-browser client. */
  private async onPickFromHost(_chatId?: string): Promise<any> {
    return { cancelled: true };
  }

  private async onPickFromHostPath(): Promise<any> {
    return { cancelled: true };
  }

  /** File-picker route — webview sends bytes inline (base64). We persist
   *  to <attachmentsDir>/<hash>.<ext> so the path-route logic is the
   *  single source of truth. */
  private async onAttachInline(p: any): Promise<any> {
    const name = String(p.name ?? 'attachment');
    const dataB64 = String(p.dataBase64 ?? '');
    const chatId = String(p.chatId ?? '');
    if (!dataB64) throw new Error('dataBase64 required');
    await fs.mkdir(this.attachmentsDir, { recursive: true });
    const bytes = Buffer.from(dataB64, 'base64');
    const hash = require('crypto').createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const ext = path.extname(name) || '.bin';
    const dest = path.join(this.attachmentsDir, hash + ext);
    try { await fs.access(dest); }
    catch { await fs.writeFile(dest, bytes); }
    return this.parseAttachment(dest, { filename: name, hash, chatId });
  }

  private async parseAttachment(p: string, hints?: { filename?: string; hash?: string; chatId?: string; mineruBackend?: 'pipeline' | 'hybrid-engine' }): Promise<any> {
    const filename = hints?.filename || path.basename(p);
    const ext = path.extname(p).toLowerCase();
    const mimeType = guessMime(ext);
    const sizeBytes = (await fs.stat(p).catch(() => null))?.size ?? 0;
    const inlineHint = mimeType.startsWith('image/') ? 'image' : 'inline';
    const hash = hints?.hash || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const chatId = hints?.chatId || '';

    // 0.4.189 — when we have a chatId, copy the original file into the
    // per-chat attachment folder so cascade-delete can drop it. Images go
    // through this path too, so re-opens after reload can still preview
    // (though the model reads bytes at send time either way).
    let origPath: string | undefined;
    if (chatId) {
      try {
        const chatDir = path.join(this.attachmentsDir, chatId);
        await fs.mkdir(chatDir, { recursive: true });
        origPath = path.join(chatDir, `${hash}${ext || '.bin'}`);
        try { await fs.access(origPath); }
        catch { await fs.copyFile(p, origPath); }
      } catch (e) {
        this.log.warn(`[chat-v2] attach original copy failed: ${(e as Error).message}`);
        origPath = undefined;
      }
    }

    const emitProgress = (evt: { state: 'queued' | 'parsing' | 'done' | 'error'; percent?: number; error?: string }) => {
      if (!chatId) return;
      this.broadcast('chat.attachProgress', { chatId, hash, ...evt });
    };

    // Images: nothing to parse — we'll read bytes at send time. Return
    // metadata so the webview can render a thumbnail.
    if (mimeType.startsWith('image/')) {
      emitProgress({ state: 'done' });
      return { hash, filename, mimeType, sizeBytes, parsedMd: null, inlineHint, path: p, notes: null, origPath, resultPath: undefined };
    }
    // Doc-like: route through MinerU. AttachmentParser handles staging
    // + REMOTE/LOCAL fallback. Plain text falls through to fs.readFile.
    // 0.4.202 — RAM-first: skip AttachmentParser's on-disk cache write by
    // NOT passing attachmentsRoot/chatId. Hold parsed markdown in
    // this.ramAttachments; onSend flushes to disk right before build
    // prompt. If user hits ✕ or reloads before send, the RAM entry is
    // dropped and no file rác lands on disk.

    // Attach-button/file-upload route defaults to fast MinerU pipeline. Typed
    // paths use attach.addByPathHybrid and pass a backend override below.
    const mineruBackend: 'pipeline' | 'hybrid-engine' = hints?.mineruBackend ?? 'pipeline';

    try {
      const r = await this.attachParser.parse(p, MAX_FILE_BYTES, {
        // chatId + attachmentsRoot deliberately omitted — RAM only
        hash,
        onProgress: emitProgress,
        backend: mineruBackend,
      });
      this.ramAttachments.set(hash, {
        markdown: r.markdown,
        images: r.images,
        meta: { filename, mimeType, sizeBytes, mineru: r.mineru },
        parsedAt: Date.now(),
      });
      // Sentinel resultPath: onSend recognises `ram:<hash>` and flushes.
      return {
        hash, filename, mimeType, sizeBytes,
        parsedMd:   r.markdown,
        inlineHint: 'inline',
        path:       p,
        notes:      r.mineru ? `parsed via MinerU ${mineruBackend === 'hybrid-engine' ? 'hybrid' : 'pipeline'}` : null,
        origPath,
        resultPath: `ram:${hash}`,
      };
    } catch (e) {
      return {
        hash, filename, mimeType, sizeBytes,
        parsedMd:   null,
        inlineHint, path: p,
        notes:      null,
        origPath,
        resultPath: undefined,
        error:      (e as Error).message,
      };
    }
  }

  /* ─────────── file ops ─────────── */

  private isBrowserReadablePath(p: string): boolean {
    const resolved = path.resolve(p);
    const roots = [this.imagesDir, this.attachmentsDir, path.join(this.paths.dataRoot, 'chat-artifacts'), path.join(this.paths.dataRoot, 'excalidraw-captures')]
      .map(root => {
        try { return fsSync.realpathSync(root); }
        catch { return path.resolve(root); }
      });
    let real = resolved;
    try { real = fsSync.realpathSync(resolved); } catch { /* allow non-existing preview to fail normally */ }
    return roots.some(root => real === root || real.startsWith(root + path.sep));
  }

  private async onReadAsDataUri(p: string): Promise<{ dataUri: string; mime: string; size: number; filename: string } | { error: string }> {
    try {
      const stat = await fs.stat(p);
      if (stat.size > 16 * 1024 * 1024) return { error: 'file > 16MB' };
      const bytes = await fs.readFile(p);
      const ext = path.extname(p).toLowerCase();
      const mime = guessMime(ext);
      return {
        dataUri:  `data:${mime};base64,${bytes.toString('base64')}`,
        mime,
        size:     stat.size,
        filename: path.basename(p),
      };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  private async onFilePreview(p: string): Promise<any> {
    // 0.4.133 — Professional client-side preview. For rich formats we hand
    // the raw bytes to the webview which renders them via vendored libs
    // (docx-preview / SheetJS / PptxViewJS / pdfjs / epub.js). Legacy
    // binary formats (.doc/.ppt/.odt/.rtf) still fall back to the
    // OfficePreview text extractor.
    try {
      const ext = path.extname(p).toLowerCase();
      const filename = path.basename(p);

      // Images — unchanged. Kept as markdown-embedded data URIs so the
      // existing image-preview code path keeps working.
      if (/^\.(png|jpg|jpeg|webp|gif|bmp|tiff)$/.test(ext)) {
        const bytes = await fs.readFile(p);
        return {
          kind: 'text',
          text: `![${filename}](data:${guessMime(ext)};base64,${bytes.toString('base64')})`,
          source: p,
        };
      }

      // SVG — hand raw markup to the webview which sanitises with DOMPurify.
      if (ext === '.svg') {
        const text = await fs.readFile(p, 'utf8');
        return { kind: 'svg', text, source: p };
      }

      // Modern Office / PDF / EPUB — read raw bytes, ship base64. Frontend
      // renders with vendored library. 20 MB guard applies to all.
      if (/^\.(docx|xlsx|pptx|pdf|epub)$/.test(ext)) {
        const stat = await fs.stat(p);
        if (stat.size > MAX_PREVIEW_BYTES) {
          return { error: `File too large for inline preview (${(stat.size / 1024 / 1024).toFixed(1)} MB > 20 MB). Use Download.` };
        }
        const bytes = await fs.readFile(p);
        const kind = ext.slice(1) + '-raw';   // 'docx-raw' | 'xlsx-raw' | ...
        return { kind, data: bytes.toString('base64'), filename, source: p };
      }

      // Legacy binary Office (.doc/.ppt/.xls/.odt/.rtf) — fall back to the
      // text-extract OfficePreview. .xls actually works with SheetJS too;
      // route it through the raw path.
      if (ext === '.xls') {
        const stat = await fs.stat(p);
        if (stat.size > MAX_PREVIEW_BYTES) {
          return { error: `File too large for inline preview (${(stat.size / 1024 / 1024).toFixed(1)} MB > 20 MB). Use Download.` };
        }
        const bytes = await fs.readFile(p);
        return { kind: 'xlsx-raw', data: bytes.toString('base64'), filename, source: p };
      }
      if (/^\.(doc|ppt|odt|rtf)$/.test(ext)) {
        try {
          const r = await renderOfficeFile(p);
          return { kind: r.kind, text: r.html, source: r.source };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }

      // Structured text — dedicated frontend renderers.
      if (/^\.(csv|tsv)$/.test(ext)) {
        const text = await fs.readFile(p, 'utf8');
        return { kind: 'csv-raw', text, delimiter: ext === '.tsv' ? '\t' : ',', source: p };
      }
      if (ext === '.json') {
        const text = await fs.readFile(p, 'utf8');
        return { kind: 'json-raw', text, source: p };
      }
      if (ext === '.md' || ext === '.markdown') {
        const text = await fs.readFile(p, 'utf8');
        return { kind: 'md', text, source: p };
      }
      if (ext === '.html' || ext === '.htm') {
        const text = await fs.readFile(p, 'utf8');
        return { kind: 'html', source: text, path: p };
      }

      // Code / config formats — syntax-highlight via highlight.js.
      const HIGHLIGHT_LANGS: Record<string, string> = {
        '.xml': 'xml', '.yml': 'yaml', '.yaml': 'yaml',
        '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
        '.log': 'accesslog', '.sh': 'bash', '.bash': 'bash',
        '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
        '.tsx': 'typescript', '.jsx': 'javascript',
        '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
        '.rs': 'rust', '.go': 'go', '.java': 'java', '.rb': 'ruby',
        '.css': 'css', '.scss': 'scss', '.sql': 'sql',
      };
      if (HIGHLIGHT_LANGS[ext]) {
        const text = await fs.readFile(p, 'utf8');
        return { kind: 'code-highlighted', text, lang: HIGHLIGHT_LANGS[ext], source: p };
      }

      // Fallback — UTF-8 text.
      const text = await fs.readFile(p, 'utf8');
      return { kind: 'text', text, source: p };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  private async artifactPathFor(chatId: string, id: string, agentId?: string): Promise<string> {
    return this.artifactStore.pathForArtifact(chatId, id, agentId);
  }

  private async onArtifactPreview(chatId: string, id: string, agentId?: string): Promise<any> {
    try { return await this.onFilePreview(await this.artifactPathFor(chatId, id, agentId)); }
    catch (e) {
      if (!agentId) return { error: (e as Error).message };
      try { return await this.onFilePreview(await this.artifactPathFor(chatId, id)); }
      catch { return { error: (e as Error).message }; }
    }
  }

  private async onArtifactReadAsDataUri(chatId: string, id: string, agentId?: string): Promise<any> {
    try { return await this.onReadAsDataUri(await this.artifactPathFor(chatId, id, agentId)); }
    catch (e) {
      if (!agentId) return { error: (e as Error).message };
      try { return await this.onReadAsDataUri(await this.artifactPathFor(chatId, id)); }
      catch { return { error: (e as Error).message }; }
    }
  }

  private async onArtifactSaveAs(chatId: string, id: string, agentId?: string): Promise<any> {
    try { return await this.onFileSaveAs(await this.artifactPathFor(chatId, id, agentId)); }
    catch (e) {
      if (!agentId) return { error: (e as Error).message };
      try { return await this.onFileSaveAs(await this.artifactPathFor(chatId, id)); }
      catch { return { error: (e as Error).message }; }
    }
  }

  /** No native save dialog standalone — read the file and hand it back as
   *  a data URI so the browser can trigger its own download (see
   *  frontend saveAsDownload()). */
  private async onFileSaveAs(p: string): Promise<any> {
    if (!p) throw new Error('path required');
    return this.onReadAsDataUri(p);
  }

  /* ─────────── system prompt tiers ─────────── */

  private chatPromptPath(chatId: string): string {
    return path.join(this.sessionsDir, `${chatId}.systemprompt.md`);
  }
  private async readChatPrompt(chatId: string): Promise<string> {
    try { return await fs.readFile(this.chatPromptPath(chatId), 'utf8'); }
    catch { return ''; }
  }

  private async getSystemPromptTier(p: any): Promise<string> {
    const tier = String(p.tier ?? 'global');
    // Global tier: surface user override OR the built-in default so the
    // settings editor never shows a blank textarea (#F1 in 0.4.2).
    if (tier === 'global') return this.systemPrompts['global'] || DEFAULT_GLOBAL_PROMPT;
    if (tier === 'project') {
      const pid = String(p.projectId ?? '');
      const cached = this.systemPrompts['project:' + pid];
      if (typeof cached === 'string') return cached;
      return '';
    }
    if (tier === 'chat') {
      const chatId = String(p.chatId ?? this.activeChatId ?? '');
      return chatId ? await this.readChatPrompt(chatId) : '';
    }
    return '';
  }

  private async setSystemPromptTier(p: any): Promise<{ ok: true }> {
    const tier = String(p.tier ?? 'global');
    const value = String(p.value ?? '');
    if (tier === 'global')      this.systemPrompts['global'] = value;
    else if (tier === 'project') {
      const pid = String(p.projectId ?? '');
      this.systemPrompts['project:' + pid] = value;
      try { await this.projectStore.updateProject(pid, { systemPrompt: value }); }
      catch { /* ignore */ }
    }
    else if (tier === 'chat') {
      const chatId = String(p.chatId ?? this.activeChatId ?? '');
      if (!chatId) throw new Error('chatId required');
      if (value) await fs.writeFile(this.chatPromptPath(chatId), value, 'utf8');
      else { try { await fs.unlink(this.chatPromptPath(chatId)); } catch { /* ignore */ } }
    }
    await this.saveMeta();
    return { ok: true };
  }

  /* ─────────── helpers ─────────── */

  private normalizeThinking(level: any): { effort: ThinkingEffort } | undefined {
    if (typeof level !== 'string') return undefined;
    if (level === 'off') return undefined;
    if (THINKING_EFFORTS.has(level as ThinkingEffort)) return { effort: level as ThinkingEffort };
    return undefined;
  }

  dispose() {
    ChatPanelV2.current = undefined;
    for (const s of this.sessions.values()) s.cancel();
    this.sessions.clear();
    for (const agents of this.agentRegistries.values()) agents.cancelAll();
    this.agentRegistries.clear();
    this.agentRegistryInit.clear();
    this.toolExecutor.cancelAllClarifications();
    // 0.4.352 — tear down every tmux viewer + owned PTY so a panel dispose
    // (window reload/close) never leaves orphan `aura_view_*` sessions and
    // `tmux attach` processes behind. This is the leak that accumulated
    // across reconnects and eventually exhausted the host process table.
    try { this.terminal?.disposeAll(); } catch {}
    this.browserSinks.clear();
    this.disposables.forEach(d => d.dispose());
  }
}

/* ───────────────── module helpers ───────────────────── */

const MIME_BY_EXT: Record<string, string> = {
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml',
  '.bmp':'image/bmp', '.tiff':'image/tiff',
  '.pdf':'application/pdf',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc':'application/msword',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls':'application/vnd.ms-excel',
  '.txt':'text/plain', '.md':'text/markdown', '.json':'application/json',
  '.html':'text/html', '.csv':'text/csv',
  '.js':'text/javascript', '.ts':'text/typescript', '.py':'text/x-python',
};
function guessMime(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] || 'application/octet-stream';
}
