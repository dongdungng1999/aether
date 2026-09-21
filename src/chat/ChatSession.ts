/**
 * ChatSession — owns one conversation: in-memory history + tool-use loop.
 *
 * The send() generator drives a multi-iteration loop:
 *
 *   1. Build /v1/messages request (history + tools).
 *   2. Stream events from ChatStreamer; yield text / thinking / tool deltas
 *      to ChatPanel for the webview.
 *   3. On message_done:
 *        - If stop_reason === 'tool_use', run tools via ToolExecutor,
 *          append assistant block + tool_result user message, loop.
 *        - Otherwise persist and yield 'done'.
 *
 * Persistence: every user/assistant turn is JSONL-appended through ChatStore
 * (full content blocks, including tool_use/tool_result, so old sessions can
 * replay the loop visually). Empty turns are not persisted.
 */

import { randomUUID } from 'crypto';
import {
  streamChat, ChatMessage, ContentBlock, AssistantBlock,
  ThinkingEffort, StopReason, UsageDelta,
} from './ChatStreamer';
import { ChatStore } from './ChatStore';
import { ToolRegistry } from './ToolRegistry';
import { ToolExecutor, ToolExecutionContext } from './ToolExecutor';
import { computeCost, maxOutputTokensFor } from './Pricing';
import { composeSystemPrompt } from './SystemPrompt';
import { approxTokensForMsgs } from './MessageTokens';
import { Logger } from '../utils/logger';

export interface SessionEvent {
  type: 'token' | 'thinking' | 'done' | 'error' | 'cancelled' | 'user' | 'assistant-start'
      | 'asst-persisted'
      | 'tool-start' | 'tool-done' | 'tool-error' | 'iter' | 'usage'
      | 'cap-reached' | 'sse_raw';
  /** asst-persisted only — index of the just-pushed asst message in
   *  session.messages. Lets runStream fire chat.asstTurn per-iter so
   *  the webview's streaming wrap for that iter gets tagged with the
   *  correct persisted turn-id (v0.4.113: previously only the LAST
   *  asst turn got tagged, so any earlier iter's bubble re-rendered
   *  as duplicate on appendMissingTurns). */
  turnId?: number;
  text?:    string;
  /** tool-{start,done,error} only. */
  id?:      string;
  name?:    string;
  /** tool-start only — original tool input for host-side artifact metadata. */
  input?:   any;
  /** tool-done only — short stringified tool result for UI breadcrumb. */
  result?:  string;
  /** tool-done only — full tool result text (untruncated). The webview
   *  doesn't render it — used by host-side image-URL surfacing. */
  resultFull?: string;
  /** iter only — current iteration count (1-based). */
  iter?:    number;
  /** usage only — running totals across this turn's tool-loop iterations. */
  usage?:   UsageDelta;
  /** usage only — accumulated $$ cost across this turn at list price. */
  costUsd?: number;
  /** cap-reached only — the iter cap that was hit. UI shows a banner. */
  cap?:     number;
  /** sse_raw only — Anthropic SSE event name (content_block_start, etc). */
  event?:   string;
  /** sse_raw only — full event JSON the v2 webview replays directly. */
  data?:    any;
}

export interface SendOpts {
  model?:        string;
  thinking?:     { effort: ThinkingEffort };
  /** Soft cap on tool-use rounds in this turn. Default 8 (developer mode 100). */
  maxIter?:      number;
  /** When true: append the developer-mode system addendum that asks the
   *  model to surface a [DONE] marker, raise the iter cap, and let the
   *  user resume via chat.resume. */
  developerMode?: boolean;
  /** System prompt addendum (developer-mode banner instructions, etc). */
  systemExtra?:  string;
  /** 0.4.155 — set when a compact systemnote exists for this chat. Signals
   *  pruneHistory() to cap the "old" tail replayed in requests (the
   *  systemnote already summarises them). Keeps the send payload small
   *  without touching the on-disk history. */
  hasSystemNote?: boolean;
  /** 0.4.158 — token budget for the OLD-turn tail (before the current
   *  ask). Only enforced when hasSystemNote is true. Callers compute
   *  this from the model's context window (e.g. 15% of context_max). */
  oldTokenBudget?: number;
  /** 0.4.163 — mark the injected user turn as synthetic. Model still
   *  sees it in history so it can react to the hint, but persistence
   *  records `synthetic:true` and the webview renders a compact hint
   *  card instead of a full user bubble. Used by the continuation
   *  loop's resume() calls. */
  synthetic?: boolean;
  /** 0.4.189 — structured attachment metadata for this user turn.
   *  Persisted verbatim so reload can render chips even though the
   *  parsed markdown lives in a separate .md file. */
  attachments?: any[];
  /** Immutable scope for every tool call in this session turn. */
  toolContext?: ToolExecutionContext;
  /** When true, skip adding a user turn before running the loop. Use after
   *  manually appending a tool_result user message so we don't create two
   *  consecutive user messages (which the API rejects with 400). */
  skipUserTurn?: boolean;
  /** Context guard: force a graceful early return when the runtime nears the
   *  model window, INSTEAD of compacting-and-continuing (which lets the agent
   *  keep ballooning until it 400s / hits the cap mid-tool with garbage).
   *  Checked at the START of each inner iteration (runtime always ends with a
   *  user turn there — no pending tool_use). On the FIRST crossing of
   *  `thresholdTokens` we (1) inject a stop-and-synthesize instruction into the
   *  trailing user turn, (2) restrict the remaining iterations to wrap-up tools
   *  only (agent_transfer / aura_artifact_pin / release_agents) so the model is
   *  forced to hand up rather than do more work, and (3) fire `onTrigger` so the
   *  runner can flag the node + notify the FE. `compactRescue` is a LAST-RESORT
   *  only, invoked when the runtime is already past `hardTokens` (the synthesis
   *  turn itself wouldn't fit) — the normal path never compacts. */
  contextGuard?: {
    thresholdTokens: number;
    hardTokens: number;
    injectText: string;
    onTrigger: (runtimeTokens: number) => void;
    compactRescue?: () => Promise<any>;
  };
  /** Extra tool-loop iterations granted, ONCE, when the inner loop reaches
   *  `maxIter` while the model is still mid-tool-use (has NOT synthesized /
   *  transferred). Used by agent sessions so a leaf with a low maxTurns
   *  doesn't get cut off mid-task — instead it gets a few more rounds plus a
   *  one-shot nudge (see nearLimitNudge) to wrap up. 0/undefined = hard cap
   *  as before. Applied at most once per send() so it can't loop forever. */
  graceIters?: number;
  /** One-shot synthetic user turn injected when the grace extension kicks in,
   *  telling the model to stop new work and finish now. */
  nearLimitNudge?: string;
  /** Tool names that, once executed, END the send() loop immediately — no
   *  further model turn is requested. Used by agent sessions to make
   *  agent_transfer a true terminal action: the model can't dump a stray
   *  "All steps completed…" turn after it (the prompt says not to, but models
   *  still react to the tool_result). The tool_result is persisted first. */
  stopAfterTools?: string[];
}

const DEFAULT_MAX_ITER     = 20;
const DEV_MODE_MAX_ITER    = 100;
/** v0.4.1 — Outer-loop cap for Developer Mode. Inside the inner tool loop
 *  the model exits on `end_turn`. In Developer Mode we WANT it to keep
 *  going beyond end_turn (e.g. "fix bug → verify → fix next bug" can
 *  spread across many independent tool batches). The outer loop
 *  re-enters the inner loop with a synthetic "(continue)" turn until the
 *  model emits `[DONE]` / `[BLOCKED:...]`, the cap is hit, or the user
 *  cancels. Off in normal mode (cap = 1). */
const OUTER_TURNS_DEV      = 30;
/** Markers the model emits to terminate the outer loop early. Both forms
 *  are accepted so the model can pick whichever fits its prose. */
const DONE_MARKER_RX    = /\[\s*DONE\s*\]\s*$/i;
const BLOCKED_MARKER_RX = /\[\s*BLOCKED:[^\]]*\]\s*$/i;

// Baseline + dev-mode prompt text moved to SystemPrompt.ts. We re-export
// the legacy names so any existing consumer (livespec, tests) keeps
// compiling — both are identical to the SystemPrompt module's tiers.
export { DEFAULT_GLOBAL_PROMPT as DEFAULT_SYSTEM_PROMPT, DEV_MODE_ADDENDUM } from './SystemPrompt';

export class ChatSession {
  readonly id = randomUUID();
  /** Full history — everything ever said in this chat, in order.
   *  Source of truth for UI render + reload. NEVER mutated by compact. */
  readonly messages: ChatMessage[] = [];
  /** 0.4.217 — runtime history: the exact payload we send to the API each
   *  turn. Diverges from `messages` after compact (compact rewrites this
   *  list to a single compact-summary turn + subsequent live turns).
   *  Persisted to <chat>.runtime.jsonl in lock-step with mutations. */
  readonly runtimeMessages: ChatMessage[] = [];
  private abort?: AbortController;
  private store?: ChatStore;

  constructor(
    private readonly baseUrl:  () => string,
    private readonly model:    () => string,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly log:      Logger,
  ) {}

  /** Attach a JSONL-backed store. All future user/assistant turns are
   *  persisted; reset() does NOT clear the file (caller can rotate). */
  setStore(store: ChatStore) { this.store = store; }

  /** Replay a saved transcript into in-memory state. Does NOT re-persist. */
  hydrate(prior: { role: 'user' | 'assistant'; content: string | ContentBlock[]; synthetic?: boolean; kind?: 'compact' | 'agent-handoff'; ts?: number }[]) {
    for (const m of prior) {
      const msg: ChatMessage = { role: m.role, content: m.content };
      if (typeof m.ts === 'number') msg.ts = m.ts;
      if (m.synthetic) msg.synthetic = true;
      if (m.kind) msg.kind = m.kind;
      if ((m as any).agentHandoffs) msg.agentHandoffs = (m as any).agentHandoffs;
      this.messages.push(msg);
    }
  }

  /** 0.4.217 — hydrate the runtime message list (used to build API
   *  payloads). Called after hydrate() with contents of
   *  <chat>.runtime.jsonl. When the runtime file is missing/empty on
   *  first touch, the caller should copy `messages` into `runtimeMessages`
   *  and persist. */
  hydrateRuntime(prior: { role: 'user' | 'assistant'; content: string | ContentBlock[]; synthetic?: boolean; kind?: 'compact' | 'agent-handoff'; ts?: number }[]) {
    for (const m of prior) {
      const msg: ChatMessage = { role: m.role, content: m.content };
      if (typeof m.ts === 'number') msg.ts = m.ts;
      if (m.synthetic) msg.synthetic = true;
      if (m.kind) msg.kind = m.kind;
      if ((m as any).agentHandoffs) msg.agentHandoffs = (m as any).agentHandoffs;
      this.runtimeMessages.push(msg);
    }
  }

  /** 0.4.217 — replace runtime history in-place. Called by compactChat()
   *  after summarising: the new runtime is a single compact-summary turn.
   *  Also writes-through to disk. */
  async replaceRuntime(msgs: ChatMessage[]): Promise<void> {
    this.runtimeMessages.length = 0;
    for (const m of msgs) this.runtimeMessages.push(m);
    if (this.store) {
      const persisted = msgs.map(m => ({
        ts: m.ts ?? Date.now(), role: m.role, content: m.content,
        ...(m.synthetic ? { synthetic: true as const } : {}),
        ...((m as any).kind ? { kind: (m as any).kind } : {}),
        ...((m as any).agentHandoffs ? { agentHandoffs: (m as any).agentHandoffs } : {}),
      }));
      try { await this.store.overwriteRuntime(persisted); }
      catch (e) { this.log.warn(`[chat] overwriteRuntime: ${(e as Error).message}`); }
    }
  }

  /** Delete one user→assistant pair starting at userIndex. Removes any
   *  tool_result turn that immediately follows the assistant turn so the
   *  history doesn't end with an orphaned tool_result. Rewrites the
   *  JSONL file to match. Returns the number of messages removed. */
  async deleteTurnAt(userIndex: number): Promise<number> {
    if (userIndex < 0 || userIndex >= this.messages.length) return 0;
    if (this.messages[userIndex].role !== 'user') return 0;

    // Walk forward and consume the assistant reply + any tool_result turn
    // glued to it. Stop at the next user-text turn.
    let endExclusive = userIndex + 1;
    while (endExclusive < this.messages.length) {
      const m = this.messages[endExclusive];
      if (m.role === 'assistant') { endExclusive++; continue; }
      if (m.role === 'user' && Array.isArray(m.content)
          && m.content.some(b => (b as any)?.type === 'tool_result')) {
        endExclusive++; continue;
      }
      break;
    }
    const removed = endExclusive - userIndex;
    this.messages.splice(userIndex, removed);
    // 0.4.217 — mirror the delete into runtime. Simple pass: rebuild
    // runtime as messages (drops any prior compact-turn — user editing
    // history invalidates the compact anyway).
    // 0.4.229 — rebuild runtime from full history, but if a compact
    // marker exists, slice runtime from the marker forward so the
    // summary survives delete-turn / delete-message.
    this.runtimeMessages.length = 0;
    let compactIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if ((this.messages[i] as any).kind === 'compact') { compactIdx = i; break; }
    }
    const slice = compactIdx >= 0 ? this.messages.slice(compactIdx) : this.messages;
    for (const m of slice) this.runtimeMessages.push(m);

    // Rewrite the JSONL so reload sees the same history. Preserve each
    // message's ORIGINAL ts (0.4.414) — claude-mem correlates observations to
    // assistant turns via [msg.ts, nextAsst.ts) windows, so re-stamping every
    // turn to one Date.now() collapses those windows and drops memory cards.
    // Turns that predate ts tracking fall back to Date.now().
    if (this.store) {
      const persisted = this.messages.map(m => ({
        ts: (m as any).ts ?? Date.now(), role: m.role, content: m.content,
        ...((m as any).synthetic ? { synthetic: true as const } : {}),
        ...((m as any).kind ? { kind: (m as any).kind } : {}),
        ...((m as any).agentHandoffs ? { agentHandoffs: (m as any).agentHandoffs } : {}),
      }));
      try { await this.store.rewrite(persisted); }
      catch (e) { this.log.warn(`[chat] rewrite after deleteTurn: ${(e as Error).message}`); }
      try { await this.store.overwriteRuntime(persisted); }
      catch (e) { this.log.warn(`[chat] overwriteRuntime after deleteTurn: ${(e as Error).message}`); }
    }
    return removed;
  }

  /** Delete a SINGLE message at the given index — does NOT cascade to its
   *  reply or any tool_result turn. Used by the "trash" menu on each
   *  bubble (#13 in 0.4.1). The caller is expected to pass the absolute
   *  index in `messages`. Returns 1 on success, 0 if oob. */
  async deleteMessageAt(absIndex: number): Promise<number> {
    if (absIndex < 0 || absIndex >= this.messages.length) return 0;
    this.messages.splice(absIndex, 1);
    // 0.4.229 — rebuild runtime from full history, but if a compact
    // marker exists, slice runtime from the marker forward so the
    // summary survives delete-turn / delete-message.
    this.runtimeMessages.length = 0;
    let compactIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if ((this.messages[i] as any).kind === 'compact') { compactIdx = i; break; }
    }
    const slice = compactIdx >= 0 ? this.messages.slice(compactIdx) : this.messages;
    for (const m of slice) this.runtimeMessages.push(m);
    if (this.store) {
      const persisted = this.messages.map(m => ({
        ts: (m as any).ts ?? Date.now(), role: m.role, content: m.content,
        ...((m as any).synthetic ? { synthetic: true as const } : {}),
        ...((m as any).kind ? { kind: (m as any).kind } : {}),
        ...((m as any).agentHandoffs ? { agentHandoffs: (m as any).agentHandoffs } : {}),
      }));
      try { await this.store.rewrite(persisted); }
      catch (e) { this.log.warn(`[chat] rewrite after deleteMessage: ${(e as Error).message}`); }
      try { await this.store.overwriteRuntime(persisted); }
      catch (e) { this.log.warn(`[chat] overwriteRuntime after deleteMessage: ${(e as Error).message}`); }
    }
    return 1;
  }

  async *send(
    userText: string,
    images:   ContentBlock[] = [],
    opts:     SendOpts = {},
  ): AsyncGenerator<SessionEvent> {
    if (!opts.skipUserTurn) {
      const hasContent = userText.trim() || images.length;
      if (!hasContent) return;
    }
    this.abort?.abort();
    this.abort = new AbortController();

    if (!opts.skipUserTurn) {
      // Build the user turn. Standard ordering: images first, text last so
      // the model can reference visible attachments in its prompt.
      const blocks: ContentBlock[] = [];
      for (const img of images) blocks.push(img);
      if (userText.trim()) blocks.push({ type: 'text', text: userText });
      const userMsg: ChatMessage = blocks.length === 1 && blocks[0].type === 'text'
        ? { role: 'user', content: userText }
        : { role: 'user', content: blocks };
      if (opts.synthetic) userMsg.synthetic = true;
      // Pin creation-time ts on the in-memory turn so later full-history
      // rewrites preserve it (0.4.414 — see ChatMessage.ts).
      const userTs = Date.now();
      userMsg.ts = userTs;
      this.messages.push(userMsg);
      this.runtimeMessages.push(userMsg);
      // Persist the user turn. Synthetic turns get a compact hint card in the UI.
      const userRec = {
        ts: userTs, role: 'user' as const,
        content: userMsg.content,
        ...(opts.synthetic ? { synthetic: true as const } : {}),
        ...(Array.isArray(opts.attachments) && opts.attachments.length
            ? { attachments: opts.attachments }
            : {}),
      };
      this.store?.append(userRec)
        .catch(e => this.log.warn(`[chat] persist user (full): ${(e as Error).message}`));
      this.store?.appendRuntime(userRec)
        .catch(e => this.log.warn(`[chat] persist user (runtime): ${(e as Error).message}`));
      yield { type: 'user', text: userText };
    }

    await this.registry.ensureLoaded().catch(e =>
      this.log.warn(`[chat] tool registry: ${(e as Error).message}`));

    let maxIter = opts.maxIter
      ?? (opts.developerMode ? DEV_MODE_MAX_ITER : DEFAULT_MAX_ITER);
    // Grace extension: granted at most ONCE when the loop hits the cap while
    // the model is still calling tools (mid-task, not yet synthesized). Lets a
    // low-maxTurns agent finish + transfer instead of being cut off.
    let graceGranted = false;
    // System prompt is pre-assembled by ChatPanelV2 (global → per-model →
    // per-project → chat → devMode) and passed in as opts.systemExtra.
    // Use it verbatim — do NOT re-wrap through composeSystemPrompt(), which
    // would prepend DEFAULT_GLOBAL_PROMPT a second time and duplicate the
    // devMode addendum.
    const systemPrompt = opts.systemExtra ?? composeSystemPrompt({
      model:         opts.model || this.model(),
      developerMode: opts.developerMode,
    });

    // Per-send usage ledger. Accumulates over every tool-loop iteration so
    // the webview footer can show "this turn cost $X / used Y tokens".
    const turnUsage: UsageDelta = { inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0 };
    let turnCost = 0;
    const modelName = opts.model || this.model();

    // Outer loop — only > 1 in Developer Mode. Each outer pass runs a
    // full inner tool loop; between passes a synthetic "(continue)" user
    // turn is pushed so the model has something to react to. Exits when
    // the model emits [DONE] / [BLOCKED:…], the cap is hit, the user
    // cancels, or the inner loop reports a stream-level error.
    const outerCap   = opts.developerMode ? OUTER_TURNS_DEV : 1;
    let lastAsstText = '';   // tail-text from the most recent assistant turn
    // Context guard latch — flips true the first time the runtime crosses the
    // threshold. Once armed it stays armed for the rest of this send() so the
    // tool set stays restricted to wrap-up tools (see availableTools below).
    let ctxGuardArmed = false;
    outer: for (let outer = 1; outer <= outerCap; outer++) {

      // On every outer iteration after the first, inject a synthetic
      // continuation so the model has a real user turn to drive the next
      // inner loop. We persist it to the JSONL with a `synthetic: true`
      // marker so reload doesn't render it as a visible bubble.
      if (outer > 1) {
        const contTs = Date.now();
        const cont: ChatMessage = { role: 'user', content: '(continue)', synthetic: true, ts: contTs };
        this.messages.push(cont);
        this.runtimeMessages.push(cont);
        const contRec = {
          ts: contTs, role: 'user' as const, content: '(continue)',
          synthetic: true as const,
        };
        this.store?.append(contRec)
          .catch(e => this.log.warn(`[chat] persist (continue) full: ${(e as Error).message}`));
        this.store?.appendRuntime(contRec)
          .catch(e => this.log.warn(`[chat] persist (continue) runtime: ${(e as Error).message}`));
      }

    for (let iter = 1; iter <= maxIter; iter++) {
      // User hit Stop during the previous iteration's tool execution (tools
      // don't observe the abort signal, so we catch it here before spending
      // another API request). Without this the loop would start a fresh
      // stream against an already-aborted signal and keep generating.
      if (this.abort?.signal.aborted) { yield { type: 'cancelled' }; return; }

      // Context guard: near the window, force a graceful early return instead
      // of letting the agent keep working until it 400s or hits the cap
      // mid-tool with a garbage result. Fires ONCE. Safe here: the runtime
      // ends with a user turn (initial task, or the previous iter's
      // tool_result), never a pending tool_use — so appending a text block to
      // that user turn keeps the tool_use/tool_result pairing + alternation
      // valid. The tool restriction below (availableTools) does the actual
      // interrupt; this injects the instruction + notifies.
      if (opts.contextGuard && !ctxGuardArmed) {
        const g = opts.contextGuard;
        const rtTokens = approxTokensForMsgs(this.runtimeMessages);
        if (rtTokens > g.thresholdTokens) {
          ctxGuardArmed = true;
          // Only when the runtime is already past the hard ceiling (the
          // synthesis turn itself would overflow) do we compact — last resort,
          // NOT the normal path. Non-fatal on failure.
          if (g.compactRescue && rtTokens > g.hardTokens) {
            try { await g.compactRescue(); }
            catch (e) { this.log.warn(`[chat] context-guard rescue-compact failed: ${(e as Error).message}`); }
          }
          // Inject the stop-and-synthesize instruction. Append to the trailing
          // user turn (keeps a single user turn — two user turns in a row 400).
          const tail = this.runtimeMessages[this.runtimeMessages.length - 1];
          const injectBlock = { type: 'text' as const, text: g.injectText };
          if (tail && tail.role === 'user' && Array.isArray(tail.content)) {
            (tail.content as any[]).push(injectBlock);
          } else if (tail && tail.role === 'user' && typeof tail.content === 'string') {
            tail.content = [{ type: 'text' as const, text: tail.content }, injectBlock];
          } else {
            this.runtimeMessages.push({ role: 'user', content: [injectBlock] });
          }
          try { g.onTrigger(rtTokens); } catch { /* notify is best-effort */ }
          this.log.info(`[chat] context guard fired: runtime ${rtTokens} > ${g.thresholdTokens} — forcing synthesize + agent_transfer`);
        }
      }

      yield { type: 'iter', iter };
      yield { type: 'assistant-start' };

      const finalBlocks: AssistantBlock[] = [];
      let stopReason: StopReason = 'end_turn';
      let iterUsage: UsageDelta = { inTokens: 0, outTokens: 0 };

      try {
        const activeModel = opts.model || this.model();
        // 0.4.245 — strip thinking blocks from OLDER assistant turns before
        // sending. Keep the last assistant turn intact so any pending
        // tool_use signature validation still works.
        // 0.4.247 — an older asst turn that was ONLY thinking (no text /
        // tool_use) becomes empty after strip. Dropping it entirely
        // causes two consecutive user turns → API 400. Replace such
        // turns with a placeholder empty text block so the alternation
        // and message index still line up. Also SKIP stripping when
        // this would make a turn empty AND it sits right before another
        // assistant (rare, but keep safe). Full history (UI replay)
        // untouched — only apiMessages is transformed.
        // iter=1,outer=1 = new user turn: no pending tool_use, safe to strip all thinking.
        // Otherwise keep last asst turn intact for tool_use signature validation.
        let lastAsstIdx = -1;
        if (!(iter === 1 && outer === 1)) {
          for (let i = this.runtimeMessages.length - 1; i >= 0; i--) {
            if (this.runtimeMessages[i].role === 'assistant') { lastAsstIdx = i; break; }
          }
        }
        const apiMessages = this.runtimeMessages.map((m, i) => {
          if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
          if (i === lastAsstIdx) return m;
          const stripped = (m.content as any[]).filter(b => b?.type !== 'thinking');
          if (stripped.length) return { ...m, content: stripped };
          // Was thinking-only. Replace with a minimal placeholder so we
          // don't collapse two adjacent user turns.
          return { ...m, content: [{ type: 'text', text: '(prior segment produced no visible output)' }] };
        });
        const availableTools = this.registry.toolDefs().filter(tool => {
          // Base availability (per-session tool context).
          let ok: boolean;
          if (tool.name === 'spawn_agents') ok = !!opts.toolContext?.spawnAgents;
          else if (tool.name === 'release_agents') ok = !!opts.toolContext?.releaseAgents;
          else if (tool.name === 'aura_artifact_pin') ok = !!opts.toolContext?.pinArtifact;
          else if (tool.name === 'update_artifact') ok = !!opts.toolContext?.updateArtifact;
          else if (tool.name === 'ask_user') ok = opts.toolContext?.allowAskUser === true;
          else ok = true;
          if (!ok) return false;
          // Context guard armed: strip everything except the wrap-up tools so
          // the model is forced to synthesize + hand up instead of doing more
          // work (no more searching, reading, or spawning). Intersected with
          // base availability so a leaf never gains a tool it didn't have.
          if (ctxGuardArmed) {
            return tool.name === 'agent_transfer'
                || tool.name === 'aura_artifact_pin'
                || tool.name === 'release_agents';
          }
          return true;
        });
        for await (const evt of streamChat({
          baseUrl:  this.baseUrl(),
          model:    activeModel,
          messages: apiMessages,
          system:   systemPrompt || undefined,
          tools:    availableTools,
          thinking: opts.thinking,
          // 0.4.174 — request the model's full extended-output cap instead
          // of the 4096 default. Old default cut SVG/long-form output
          // mid-fence, forcing runContinuationLoop to stitch segments — and
          // segment-boundary rendering never joined markdown fences
          // properly. Using the per-model max removes the split for the
          // common case; continuation only fires on genuinely huge turns.
          maxTokens: maxOutputTokensFor(activeModel),
          signal:   this.abort.signal,
        })) {
          if (evt.type === 'sse_raw') {
            // Forward the raw Anthropic SSE frame so the v2 studio webview
            // can drive its block-by-block render off it. Legacy ChatPanel
            // ignores this — it only listens for the higher-level events
            // below — so this is a pure addition.
            yield { type: 'sse_raw', event: evt.event, data: evt.data };
          } else if (evt.type === 'text') {
            yield { type: 'token', text: evt.text };
          } else if (evt.type === 'thinking') {
            yield { type: 'thinking', text: evt.text };
          } else if (evt.type === 'tool_use_start') {
            yield { type: 'tool-start', id: evt.id, name: evt.name };
          } else if (evt.type === 'message_done') {
            finalBlocks.push(...evt.blocks);
            stopReason = evt.stopReason;
            iterUsage  = evt.usage;
            break;
          } else if (evt.type === 'error') {
            // 0.4.236 — streamer surfaces req.destroy(new Error('aborted'))
            // through the queue as {type:'error', error:'aborted'} instead of
            // throwing. When our abort signal is set (user hit Stop or a new
            // send superseded this one), reclassify as cancellation so
            // ChatPanelV2 doesn't paint the red "Stream was cancelled
            // mid-flight" banner (0.4.148 fix only covered the throw path).
            if (this.abort?.signal.aborted) {
              yield { type: 'cancelled' };
              return;
            }
            yield { type: 'error', text: evt.error };
            this.log.warn(`[chat] stream error: ${evt.error}`);
            return;
          }
          // tool_use_delta is informational; the panel doesn't need it
          // unless we want a typing-like animation, which we don't yet.
        }
      } catch (e) {
        // 0.4.148 — distinguish user-triggered cancel from real errors. When
        // the user hits Stop, chat.cancel calls abort(), which surfaces here
        // as an "aborted" throw. Emitting {type:'error'} caused the webview
        // to show the red "Stream was cancelled mid-flight" banner. Emit a
        // dedicated 'cancelled' event so runStream can mark stopReason and
        // skip the plugin fire (which was hanging claude-mem).
        if (this.abort?.signal.aborted) {
          yield { type: 'cancelled' };
          return;
        }
        yield { type: 'error', text: (e as Error).message };
        return;
      }

      // Persist assistant turn with its full block list.
      if (finalBlocks.length) {
        const asstTs = Date.now();
        const asstMsg: ChatMessage = { role: 'assistant', content: finalBlocks, ts: asstTs };
        this.messages.push(asstMsg);
        this.runtimeMessages.push(asstMsg);
        const turnId = this.messages.length - 1;
        const asstRec = {
          ts: asstTs, role: 'assistant' as const, content: finalBlocks,
        };
        try { await this.store?.append(asstRec); }
        catch (e) { this.log.warn(`[chat] persist asst (full): ${(e as Error).message}`); }
        try { await this.store?.appendRuntime(asstRec); }
        catch (e) { this.log.warn(`[chat] persist asst (runtime): ${(e as Error).message}`); }
        yield { type: 'asst-persisted', turnId };
      }

      // Accumulate token + cost ledger and emit it after every iteration so
      // the webview footer ticks live during multi-tool turns.
      turnUsage.inTokens   += iterUsage.inTokens;
      turnUsage.outTokens  += iterUsage.outTokens;
      turnUsage.cacheRead  = (turnUsage.cacheRead  ?? 0) + (iterUsage.cacheRead  ?? 0);
      turnUsage.cacheWrite = (turnUsage.cacheWrite ?? 0) + (iterUsage.cacheWrite ?? 0);
      turnCost += computeCost(modelName, iterUsage);
      yield { type: 'usage', usage: { ...turnUsage }, costUsd: turnCost };

      if (stopReason !== 'tool_use') {
        // Capture the assistant's tail text so the outer loop can decide
        // whether to keep going. We look at the LAST text block (Claude
        // normally puts its closing prose at the end of the turn).
        lastAsstText = '';
        for (let i = finalBlocks.length - 1; i >= 0; i--) {
          const b = finalBlocks[i];
          if (b.type === 'text') { lastAsstText = b.text; break; }
        }
        const tail      = lastAsstText.trimEnd();
        const isDone    = DONE_MARKER_RX.test(tail);
        const isBlocked = BLOCKED_MARKER_RX.test(tail);

        // In Developer Mode, end_turn alone isn't enough — we keep
        // re-prompting with "(continue)" until the model self-terminates
        // with [DONE] or [BLOCKED]. In normal mode, end_turn = done.
        if (!opts.developerMode || isDone || isBlocked) {
          yield { type: 'done' };
          return;
        }
        // Outer loop continues — break out of the inner iter loop and
        // let the outer for-loop inject a (continue) turn for next pass.
        break;
      }

      // Execute every tool_use block in this turn. Dedup identical calls
      // within a single iteration: same fingerprint reuses the first
      // tool_result so the model can't burn the loop firing the same call.
      const calls = finalBlocks.filter(b => b.type === 'tool_use') as Array<{
        type: 'tool_use'; id: string; name: string; input: any;
      }>;
      const seen = new Map<string, { id: string; result: string }>();
      const toolResults: ContentBlock[] = [];
      for (const call of calls) {
        const fp = `${call.name}:${stableStringify(call.input)}`;
        const dup = seen.get(fp);
        if (dup) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: `(duplicate call — reusing result from ${dup.id})`,
          });
          yield { type: 'tool-done', id: call.id, name: call.name, input: call.input, result: '(duplicate)' };
          continue;
        }
        const r = await this.executor.run(call, opts.toolContext ?? {
          chatId: this.id,
          developerMode: !!opts.developerMode,
        });
        toolResults.push(r.block);
        const preview = previewResult(r.block);
        const full = fullResult(r.block);
        seen.set(fp, { id: call.id, result: preview });
        if (r.isError) {
          yield { type: 'tool-error', id: call.id, name: call.name, input: call.input, result: preview, resultFull: full };
        } else {
          yield { type: 'tool-done', id: call.id, name: call.name, input: call.input, result: preview, resultFull: full };
        }
      }

      const toolTs = Date.now();
      const resultMsg: ChatMessage = { role: 'user', content: toolResults, ts: toolTs };
      this.messages.push(resultMsg);
      this.runtimeMessages.push(resultMsg);
      const toolRec = {
        ts: toolTs, role: 'user' as const, content: toolResults,
      };
      await this.store?.append(toolRec)
        .catch(e => this.log.warn(`[chat] persist tool_result (full): ${(e as Error).message}`));
      await this.store?.appendRuntime(toolRec)
        .catch(e => this.log.warn(`[chat] persist tool_result (runtime): ${(e as Error).message}`));

      // Terminal tool: if this iteration ran a stop-after tool (e.g.
      // agent_transfer), END the loop now. The model must not get another turn
      // to react to the tool_result — that's what produced the stray
      // "All steps completed…" dump AFTER agent_transfer. The tool_result is
      // already persisted above; we just don't request a follow-up turn.
      if (opts.stopAfterTools?.length && calls.some(c => opts.stopAfterTools!.includes(c.name))) {
        this.log.info(`[chat] stop-after-tool: ending loop after ${calls.map(c => c.name).join(',')}`);
        yield { type: 'done' };
        return;
      }

      // About to exhaust the loop while the model is STILL calling tools
      // (mid-task). If a grace budget was granted, extend the cap ONCE and nudge
      // the model to finish now, so a low-maxTurns agent can reach its synthesis
      // + agent_transfer instead of being cut off with limit_reached. The nudge
      // is appended as a text block INTO the tool_result user turn we just
      // pushed — a separate user turn would sit back-to-back with it (two
      // consecutive user messages → Anthropic 400).
      if (iter >= maxIter && !graceGranted && opts.graceIters && opts.graceIters > 0) {
        graceGranted = true;
        maxIter += opts.graceIters;
        const nudgeText = opts.nearLimitNudge
          ?? 'You are almost out of tool-use iterations. Stop starting new work now: pin any remaining deliverables, write your final synthesis, then call agent_transfer as your very last action.';
        (resultMsg.content as ContentBlock[]).push({ type: 'text', text: nudgeText });
        this.log.info(`[chat] grace extension: +${opts.graceIters} iters (was at cap ${iter})`);
      }
    }

    // Inner loop hit `maxIter` without a clean stop_reason. In dev mode
    // we DON'T inject (continue) here — that path is for end_turn pauses,
    // not for an exhausted inner loop. Surface the cap and stop so the
    // user can decide.
    yield { type: 'cap-reached', cap: maxIter };
    yield { type: 'done' };
    return;

    } // end outer for-loop

    // Outer loop exhausted in Developer Mode without a [DONE]. Surface a
    // distinct banner so the user knows the model didn't self-terminate.
    yield { type: 'cap-reached', cap: outerCap };
    yield { type: 'done' };
  }

  /** Continue an in-progress task by injecting a synthetic "(continue)"
   *  user turn. Used by developer mode's ▶ Continue button when the model
   *  paused without emitting [DONE]. Yields the same SessionEvent stream
   *  as send().  */
  async *resume(opts: SendOpts = {}, hint = '(continue)'): AsyncGenerator<SessionEvent> {
    yield* this.send(hint, [], opts);
  }

  cancel() { this.abort?.abort(); }

  reset() {
    this.messages.length = 0;
    this.runtimeMessages.length = 0;
    this.cancel();
  }
}

function stableStringify(o: any): string {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']';
  const keys = Object.keys(o).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

function previewResult(block: ContentBlock): string {
  if (block.type !== 'tool_result') return '';
  const c = block.content;
  const s = typeof c === 'string' ? c : JSON.stringify(c);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/** Full untruncated tool_result text — used by host-side image surfacer
 *  and for the webview's tool card body (where we still trim before
 *  display, but want the trim to happen on the receiver side so the
 *  signal is preserved end-to-end). */
function fullResult(block: ContentBlock): string {
  if (block.type !== 'tool_result') return '';
  const c = block.content;
  return typeof c === 'string' ? c : JSON.stringify(c);
}
