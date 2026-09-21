import { ChatSession } from '../ChatSession';
import { ChatStore } from '../ChatStore';
import { ToolExecutor } from '../ToolExecutor';
import { ToolRegistry } from '../ToolRegistry';
import { Logger } from '../../utils/logger';
import { AgentNode, AgentResult } from './AgentTypes';
import { AgentRegistry } from './AgentRegistry';
import { contextWindowFor } from '../Pricing';
import { ContentBlock } from '../ChatStreamer';

/** Text-only view of an assistant turn — unlike textOf(), this drops
 *  tool_use markers ("[tool …]") so a turn that ended on a bare tool call
 *  doesn't get returned to the parent as its "result". */
function assistantTextOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content.trim();
  return content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text || '')
    .join(' ')
    .trim();
}

function buildSubAgentPrompt(node: AgentNode, ctxWindow: number): string {
  const ctxK = Math.round(ctxWindow / 1000);
  const spawnGuide = `- Decide whether to call spawn_agents based on your remaining context, task complexity, and whether independent child results will fit back in your context. If continuing in one thread would risk exceeding your context window, delegate the independent subtasks instead of forcing everything into this thread.`;
  return [
    'You are an isolated AURA sub-agent. You inherit the same operating rules, tool protocol, artifact durability rules, style, and project guidance as the orchestrator.',
    `CONTEXT WINDOW: your model has a ${ctxK}k-token context window. Monitor your usage — after heavy tool use your accumulated input tokens can approach this limit. When you estimate you are using more than 70 % of the context window, stop doing new searches and write your final answer immediately.`,
    spawnGuide,
    '- Before spawning sub-agents: estimate whether each child\'s result will fit back in your context. If you have N siblings sharing the same parent, your parent can receive at most ~(parent_context / N) tokens from each of you.',
    ...(node.returnBudgetTokens ? [`- HARD RETURN BUDGET: your final handoff must fit within approximately ${Math.round(node.returnBudgetTokens / 1000)}k tokens. Summarize evidence before returning if needed.`] : []),
    '- Return the complete result your owner needs. Save/generate artifacts normally and include file paths/URLs in your result so the owner can promote them.',
    '- MANDATORY FINAL STEP — agent_transfer. Your task is NOT complete until you call it. It is the ONE channel that carries your result AND your artifacts up to your parent; a file you only pinned (but did not transfer) never reaches your parent. This is NON-NEGOTIABLE regardless of how simple the task was or how small/fast your model is — even a one-file task ends with agent_transfer. Do NOT end your turn with a plain text summary and no agent_transfer; that is the single most common failure.',
    '- EXACT ENDING SEQUENCE, in this order, nothing after: (1) do all task work; (2) pin every user-visible deliverable with aura_artifact_pin; (3) IF you spawned children and release_agents is available, call release_agents once; (4) call agent_transfer EXACTLY ONCE as the ABSOLUTE LAST action — your ENTIRE final synthesis goes INSIDE its `result` argument, and `artifacts` = the ids of the pinned artifacts to hand up (omit to send all you pinned). Do NOT write your synthesis as ordinary assistant text first: a finished-looking text answer ENDS your turn before you ever reach agent_transfer — that premature stop is the single most common failure. If you need to reason before transferring, do it in a thinking block, then call agent_transfer directly.',
    '- PIN IS MANDATORY FOR EVERY FILE YOU PRODUCE. If your task was to create or write a file — code (.py/.js/.ts/...), .md, .json/.csv, HTML/SVG, a chart, a report, ANY file — you MUST call aura_artifact_pin on it once you have created and verified it, even if you also ran it or printed its output. Running a file, printing stdout, or confirming "the file exists" is NOT a substitute for pinning: an unpinned file never reaches your parent and never renders. The only files you may skip are genuinely temporary/scratch files the task did not ask you to deliver.',
    '- SPECIFICALLY: the moment sandbox__run_python (or any sandbox tool) writes a file you were asked to create, your VERY NEXT tool call MUST be aura_artifact_pin for that file. Do this BEFORE anything else — before running it, before printing os.path.exists, before writing your summary. A common mistake is to run the file and report "created + verified" WITHOUT pinning — that file is then LOST. Every file the task named = one aura_artifact_pin call. If you created 2 files, that is 2 pin calls.',
    '- agent_transfer IS TERMINAL AND FINAL. It MUST be the very last action of your entire turn. After you call agent_transfer: DO NOT write any text, DO NOT explain what you did, DO NOT summarize, DO NOT pin, DO NOT call any other tool. Your synthesis text goes INSIDE the `result` argument of agent_transfer — NOT in a separate assistant message before or after it. The backend ENDS your turn the instant agent_transfer runs, so anything you plan to say after it is lost; say it in `result` instead. Calling it mid-work (before you have pinned + synthesized) is also wrong — it is the LAST step, not an early one.',
    '- The backend routes agent_transfer to your direct parent (or the orchestrator if you are a top-level coordinator) and copies the artifact bytes into their scope; your parent receives this as the result of the spawn_agents call that created you, and renders your artifacts there. You do not choose a target.',
    '- THIS APPLIES TO YOU EVEN IF YOU SPAWNED CHILDREN (you are a coordinator). After you spawn_agents, read their results, (optionally) release_agents, and synthesize — you MUST STILL call agent_transfer as your final step to pass your combined result + your children\'s artifacts up to the orchestrator. release_agents does NOT hand anything upward; only agent_transfer does. A coordinator that stops after release_agents has NOT delivered its result.',
    '- spawn_agents returns the child results directly to you. Read those results, verify/synthesize them, perform any remaining tool work, and write/settle your own final answer before cleanup.',
    '- release_agents is ONLY for direct child agents you spawned. Do NOT call release_agents immediately after spawn_agents. It marks owned children released after you have fully consumed their outputs; it does not submit anything upward. If you did not spawn child agents, do not call it.',
    '- Do not ask the user directly; report blockers to your owner (in the result you pass to agent_transfer).',
  ].join('\n');
}

/** Injected as a user turn the moment the context guard fires (~85% of the
 *  window). From here on the backend has already stripped every tool except
 *  the wrap-up ones, so the agent physically cannot keep searching/reading. */
const CONTEXT_GUARD_INJECT =
  '⚠️ CONTEXT LIMIT — AUTO-INTERRUPT BY AURA. You have reached ~85% of your context window, so the backend has STOPPED your work here. Do NOT attempt any more searching, reading, running, or spawning — those tools are no longer available to you. RIGHT NOW, in this turn: synthesize everything you have already gathered into your complete final answer, then call agent_transfer EXACTLY ONCE as your very last action, with your full synthesis inside the `result` argument and your pinned artifact ids in `artifacts`. If a needed deliverable is not pinned yet, call aura_artifact_pin first, then agent_transfer. Return the best result you can from what you already have — a clean partial synthesis handed up now is far better than being cut off mid-work with nothing.';

export interface AgentRunnerDeps {
  baseUrl: () => string;
  sessionsRoot: string;
  projectFolder: string;
  registry: ToolRegistry;
  executor: ToolExecutor;
  log: Logger;
  agents?: AgentRegistry;
  availableModels: () => Promise<string[]>;
  systemExtra?: () => Promise<string | undefined>;
  releaseAgents?: (ownerAgentId: string | undefined, input: any) => Promise<any>;
  transferAgent?: (node: AgentNode, input: any) => Promise<any>;
  pinArtifact?: (node: AgentNode, input: any) => Promise<any>;
  updateArtifact?: (node: AgentNode, input: any) => Promise<any>;
  /** Summarise an agent session's runtime in-place when it nears the context
   *  window, so the agent can keep working (and reach its synthesis +
   *  agent_transfer) instead of dying mid-tool-loop with limit_reached. */
  compactSession?: (session: ChatSession, model: string) => Promise<any>;
}

export class AgentRunner {
  private agents?: AgentRegistry;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.agents = deps.agents;
  }

  setRegistry(agents: AgentRegistry) { this.agents = agents; }

  private get registry(): AgentRegistry {
    if (!this.agents) throw new Error('agent registry is not attached');
    return this.agents;
  }

  /** Build the ChatSession `contextGuard` opt for an agent send: at ~85% of the
   *  window the loop injects a synthesize+agent_transfer instruction and
   *  restricts tools to wrap-up only (graceful early return, NOT a compaction);
   *  onTrigger flags the node + notifies the FE. compactRescue (past ~98%) is a
   *  last resort so the synthesis turn itself can fit. */
  private contextGuardOpt(node: AgentNode, ctxWindow: number, session: ChatSession, store: ChatStore) {
    return {
      thresholdTokens: Math.floor(ctxWindow * 0.85),
      hardTokens:      Math.floor(ctxWindow * 0.98),
      injectText:      CONTEXT_GUARD_INJECT,
      onTrigger: (runtimeTokens: number) => {
        node.contextGuarded = true;
        this.registry.publish(node, 'context_guard', {
          tokens: runtimeTokens,
          max: node.contextMax || ctxWindow,
        });
        store.updateAgentMeta({ contextGuarded: true }).catch(() => {});
      },
      ...(this.deps.compactSession
        ? { compactRescue: () => this.deps.compactSession!(session, node.model) }
        : {}),
    };
  }

  async run(node: AgentNode): Promise<AgentResult> {
    const session = new ChatSession(
      this.deps.baseUrl,
      () => node.model,
      this.deps.registry,
      this.deps.executor,
      this.deps.log,
    );
    const store = new ChatStore(
      this.deps.sessionsRoot, node.rootChatId, this.deps.projectFolder, node.agentId,
    );
    session.setStore(store);
    await store.writeAgentMeta({
      schema: 1,
      rootChatId: node.rootChatId,
      agentId: node.agentId,
      parentAgentId: node.parentAgentId,
      ownerAgentId: node.parentAgentId,
      runId: node.runId,
      depth: node.depth,
      task: node.task,
      model: node.model,
      effort: node.effort,
      createdAt: node.createdAt,
      status: node.status,
      maxTurns: node.maxTurns,
      returnBudgetTokens: node.returnBudgetTokens,
      returnState: node.returnState,
      submitted: node.submitted,
    });
    this.registry.setCanceller(node.agentId, () => session.cancel());
    let result = '';
    const sandboxScope = `${node.rootChatId}.agent-${node.agentId}`;
    this.deps.registry.setAvailableModels(await this.deps.availableModels());
    const parentSystem = await this.deps.systemExtra?.();
    const ctxWindow = contextWindowFor(node.model);
    const agentSystem = [
      parentSystem,
      buildSubAgentPrompt(node, ctxWindow),
    ].filter(Boolean).join('\n\n---\n\n');
    for await (const event of session.send(node.task, [], {
      model: node.model,
      thinking: node.effort === 'off' ? undefined : { effort: node.effort },
      maxIter: node.maxTurns,
      // Grant a one-shot iteration extension if the agent hits its maxTurns
      // while still mid-tool-use, so it can reach synthesis + agent_transfer
      // instead of being cut off with limit_reached.
      graceIters: Math.max(2, Math.ceil(node.maxTurns / 2)),
      // agent_transfer is terminal — end the loop right after it so the model
      // can't emit a stray "All steps completed…" turn reacting to its result.
      stopAfterTools: ['agent_transfer'],
      systemExtra: agentSystem,
      contextGuard: this.contextGuardOpt(node, ctxWindow, session, store),
      toolContext: {
        chatId: sandboxScope,
        allowAskUser: false,
        spawnAgents: async input => ({
          results: await this.registry.spawn(node.agentId, input?.agents || [], {
            model: node.model,
            effort: node.effort,
            availableModels: await this.deps.availableModels(),
            returnBudgetTokens: node.returnBudgetTokens
              ? Math.max(1, Math.floor(node.returnBudgetTokens / Math.max(1, input?.agents?.length || 1)))
              : undefined,
          }),
        }),
        releaseAgents: this.deps.releaseAgents
          ? input => this.deps.releaseAgents!(node.agentId, input)
          : undefined,
        transferAgent: this.deps.transferAgent
          ? input => this.deps.transferAgent!(node, input)
          : undefined,
        pinArtifact: this.deps.pinArtifact
          ? input => this.deps.pinArtifact!(node, input)
          : undefined,
        updateArtifact: this.deps.updateArtifact
          ? input => this.deps.updateArtifact!(node, input)
          : undefined,
      },
    })) {
      if (event.type === 'token' || event.type === 'thinking' || event.type === 'sse_raw') {
        this.registry.publish(node, 'chunk', event);
      } else if (event.type === 'tool-start' || event.type === 'tool-done' || event.type === 'tool-error') {
        this.registry.publish(node, 'tool', event);
      } else if (event.type === 'usage' && event.usage) {
        node.usage = { ...event.usage };
        node.costUsd = event.costUsd || node.costUsd;
        node.contextMax = contextWindowFor(node.model);
        this.registry.publish(node, 'usage', {
          usage: node.usage, costUsd: node.costUsd, contextMax: node.contextMax,
        });
        await store.updateAgentMeta({
          usage: node.usage, costUsd: node.costUsd, contextMax: node.contextMax,
        });
      } else if (event.type === 'cancelled') {
        node.status = 'cancelled';
      } else if (event.type === 'error') {
        node.status = 'error';
        node.error = event.text || 'agent stream failed';
      } else if (event.type === 'cap-reached') {
        node.status = 'limit_reached';
      }
    }
    node.messages = session.messages;
    // Prefer the last assistant turn that has real TEXT. A turn ending on a
    // bare tool_use (e.g. the agent hit the iter/token cap mid-search) yields
    // no text — don't return "[tool …]" as the result.
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg.role !== 'assistant') continue;
      const t = assistantTextOf(msg.content);
      if (t) { result = t; break; }
    }
    // If the agent called agent_transfer, it already staged the synthesized
    // handoff to its parent; prefer that text as the returned result so the
    // parent's spawn_agents tool_result matches exactly what was transferred.
    if (node.handoffResult) result = node.handoffResult;
    if (node.status === 'running') node.status = 'completed';
    // Safety net: agent ended without any synthesized text (hit the cap or
    // errored mid-tool-loop before writing a final answer AND before
    // agent_transfer). Auto-compact (B) is the real fix; this keeps the
    // parent's tool_result meaningful instead of empty/garbage for the edge
    // cases that still slip through.
    if (!result && !node.handoffResult && ['limit_reached', 'error'].includes(node.status)) {
      result = `(agent ended as ${node.status} before writing a final answer; no agent_transfer was called${node.error ? ` — ${node.error}` : ''})`;
    }
    // AUTO-TRANSFER FALLBACK: the agent finished WITHOUT calling agent_transfer.
    // The prompt makes it the mandatory final step, but models frequently skip
    // it (esp. top-level coordinators) — which would silently drop the result +
    // artifacts. Deliver them up anyway via the same handler the tool uses, and
    // append a NOTE so it's visible that the backend (not the model) did it.
    // node.submitted (set by agent_transfer) guards against a double-transfer.
    if (!node.submitted && this.deps.transferAgent
        && ['completed', 'limit_reached'].includes(node.status)) {
      try {
        await this.deps.transferAgent(node, {
          result,
          note: '⚙️ [Auto-transferred by AURA backend — this agent finished without calling agent_transfer itself, so the backend delivered its result and artifacts to the parent automatically.]',
        });
        // transferToParent set node.handoffResult (result + note), remapped
        // node.artifacts to the parent scope, and set node.submitted. Adopt the
        // handoff text so the returned AgentResult matches what was handed up.
        if (node.handoffResult) result = node.handoffResult;
        node.autoTransferred = true;   // model forgot; dock shows the ⚙ badge
        this.deps.log.info(`[agents] auto-transfer ${node.agentId} → parent (model skipped agent_transfer)`);
      } catch (e) {
        this.deps.log.warn(`[agents] auto-transfer ${node.agentId}: ${(e as Error).message}`);
      }
    }
    node.result = result;
    node.contextMax = node.contextMax || contextWindowFor(node.model);
    await store.updateAgentMeta({
      status: node.status,
      finishedAt: Date.now(),
      usage: node.usage,
      costUsd: node.costUsd,
      contextMax: node.contextMax,
      ...(result ? { result } : {}),
      submitted: node.submitted,
      ...(node.autoTransferred ? { autoTransferred: true } : {}),
      ...(node.artifacts?.length ? { artifacts: node.artifacts } : {}),
      ...(node.error ? { error: node.error } : {}),
    });
    return {
      agentId: node.agentId,
      status: node.status,
      result,
      usage: { ...node.usage },
      costUsd: node.costUsd,
      ...(node.error ? { error: node.error } : {}),
      ...(node.artifacts?.length ? { artifacts: node.artifacts } : {}),
    };
  }

  /** Resume an interrupted agent by reloading its persisted conversation,
   *  detecting any orphaned tool_use tail (spawn_agents that never got a
   *  tool_result), patching it with a synthetic error result so the model
   *  can decide how to continue, then running the remainder of the task. */
  async resumeFromDisk(node: AgentNode): Promise<AgentResult> {
    const store = new ChatStore(
      this.deps.sessionsRoot, node.rootChatId, this.deps.projectFolder, node.agentId,
    );
    const session = new ChatSession(
      this.deps.baseUrl,
      () => node.model,
      this.deps.registry,
      this.deps.executor,
      this.deps.log,
    );
    session.setStore(store);

    // Hydrate session from persisted history
    const persisted = await ChatStore.loadAgent(this.deps.sessionsRoot, node.rootChatId, node.agentId);
    const msgs = persisted.filter(m => m.role === 'user' || m.role === 'assistant');
    if (msgs.length) {
      session.hydrate(msgs.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as any, ts: (m as any).ts })));
      session.hydrateRuntime(msgs.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as any, ts: (m as any).ts })));
    }

    // Detect orphaned tool_use tail: last assistant message ends with tool_use
    // blocks but there is no following user tool_result message.
    const sessionMsgs = session.messages;
    const lastAsst = sessionMsgs.length > 0 ? sessionMsgs[sessionMsgs.length - 1] : null;
    const hasPendingToolUse = lastAsst?.role === 'assistant'
      && Array.isArray(lastAsst.content)
      && (lastAsst.content as any[]).some((b: any) => b?.type === 'tool_use');
    const lastIsToolResult = sessionMsgs.length >= 2
      && sessionMsgs[sessionMsgs.length - 1].role === 'user'
      && Array.isArray(sessionMsgs[sessionMsgs.length - 1].content)
      && (sessionMsgs[sessionMsgs.length - 1].content as any[]).some((b: any) => b?.type === 'tool_result');

    if (hasPendingToolUse && !lastIsToolResult) {
      const toolUses = (lastAsst!.content as any[]).filter((b: any) => b?.type === 'tool_use');
      const toolResults = await Promise.all(toolUses.map(async (b: any) => {
        if (b?.name === 'spawn_agents') {
          // Find real child nodes in the registry. snapshot() returns copies, and
          // resuming copies leaves persisted nodes stuck in their old status.
          const existingChildren = (this.agents?.snapshot() ?? [])
            .filter(n => n.parentAgentId === node.agentId)
            .map(n => this.registry.get(n.agentId))
            .filter((n): n is AgentNode => !!n);

          if (existingChildren.length > 0) {
            // Children exist — resume any incomplete ones bottom-up, then
            // collect all their results and return as a real tool_result.
            // This preserves the multi-agent mach rather than re-doing work.
            const results = await this.registry.resumeOrCollectChildren(node.agentId, existingChildren);
            return {
              type: 'tool_result' as const,
              tool_use_id: b.id,
              content: JSON.stringify({ results }),
            };
          }
          // No children registered yet (spawn was interrupted before any child
          // was created) — inject an error so the model re-issues spawn_agents.
        }
        return {
          type: 'tool_result' as const,
          tool_use_id: b.id,
          is_error: true,
          content: 'Session was interrupted before this completed. Please retry.',
        };
      }));
      const patchTs = Date.now();
      const patchMsg = { role: 'user' as const, content: toolResults, ts: patchTs };
      session.messages.push(patchMsg);
      session.runtimeMessages.push(patchMsg);
      const toolRec = { ts: patchTs, role: 'user' as const, content: toolResults };
      await store.append(toolRec).catch(() => {});
      await store.appendRuntime(toolRec).catch(() => {});
    }

    // Now run the remainder — re-use the existing run() body by delegating
    // to a continuation session that already has history loaded.
    this.registry.setCanceller(node.agentId, () => session.cancel());
    let result = '';
    const sandboxScope = `${node.rootChatId}.agent-${node.agentId}`;
    this.deps.registry.setAvailableModels(await this.deps.availableModels());
    const parentSystem = await this.deps.systemExtra?.();
    const agentSystem = [
      parentSystem,
      buildSubAgentPrompt(node, contextWindowFor(node.model)),
    ].filter(Boolean).join('\n\n---\n\n');

    // When we patched a tool_result above, the last runtimeMessage is already
    // a user turn. Calling session.send() would add ANOTHER user turn
    // back-to-back (→ Anthropic 400). Use skipUserTurn to go straight to the
    // inner loop. For plain resumes (no patched tool_result) we still need a
    // synthetic user message to drive the model.
    const toolResultPatched = hasPendingToolUse && !lastIsToolResult;
    const resumeHint = toolResultPatched
      ? ''
      : '(Resumed — continue the task from where it left off)';

    for await (const event of session.send(resumeHint, [], {
      skipUserTurn: toolResultPatched,
      model: node.model,
      thinking: node.effort === 'off' ? undefined : { effort: node.effort },
      maxIter: node.maxTurns,
      graceIters: Math.max(2, Math.ceil(node.maxTurns / 2)),
      stopAfterTools: ['agent_transfer'],
      synthetic: true,
      systemExtra: agentSystem,
      contextGuard: this.contextGuardOpt(node, contextWindowFor(node.model), session, store),
      toolContext: {
        chatId: sandboxScope,
        allowAskUser: false,
        spawnAgents: async input => ({
          results: await this.registry.spawn(node.agentId, input?.agents || [], {
            model: node.model,
            effort: node.effort,
            availableModels: await this.deps.availableModels(),
            returnBudgetTokens: node.returnBudgetTokens
              ? Math.max(1, Math.floor(node.returnBudgetTokens / Math.max(1, input?.agents?.length || 1)))
              : undefined,
          }),
        }),
        releaseAgents: this.deps.releaseAgents
          ? input => this.deps.releaseAgents!(node.agentId, input)
          : undefined,
        transferAgent: this.deps.transferAgent
          ? input => this.deps.transferAgent!(node, input)
          : undefined,
        pinArtifact: this.deps.pinArtifact
          ? input => this.deps.pinArtifact!(node, input)
          : undefined,
        updateArtifact: this.deps.updateArtifact
          ? input => this.deps.updateArtifact!(node, input)
          : undefined,
      },
    })) {
      if (event.type === 'token' || event.type === 'thinking' || event.type === 'sse_raw') {
        this.registry.publish(node, 'chunk', event);
      } else if (event.type === 'tool-start' || event.type === 'tool-done' || event.type === 'tool-error') {
        this.registry.publish(node, 'tool', event);
      } else if (event.type === 'usage' && event.usage) {
        node.usage = { ...event.usage };
        node.costUsd = event.costUsd || node.costUsd;
        node.contextMax = contextWindowFor(node.model);
        this.registry.publish(node, 'usage', {
          usage: node.usage, costUsd: node.costUsd, contextMax: node.contextMax,
        });
        await store.updateAgentMeta({ usage: node.usage, costUsd: node.costUsd, contextMax: node.contextMax });
      } else if (event.type === 'cancelled') {
        node.status = 'cancelled';
      } else if (event.type === 'error') {
        node.status = 'error';
        node.error = event.text || 'agent stream failed';
      } else if (event.type === 'cap-reached') {
        node.status = 'limit_reached';
      }
    }
    node.messages = session.messages;
    // Prefer the last assistant turn that has real TEXT. A turn ending on a
    // bare tool_use (e.g. the agent hit the iter/token cap mid-search) yields
    // no text — don't return "[tool …]" as the result.
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg.role !== 'assistant') continue;
      const t = assistantTextOf(msg.content);
      if (t) { result = t; break; }
    }
    // If the agent called agent_transfer, it already staged the synthesized
    // handoff to its parent; prefer that text as the returned result so the
    // parent's spawn_agents tool_result matches exactly what was transferred.
    if (node.handoffResult) result = node.handoffResult;
    if (node.status === 'running') node.status = 'completed';
    // Safety net: agent ended without any synthesized text (hit the cap or
    // errored mid-tool-loop before writing a final answer AND before
    // agent_transfer). Auto-compact (B) is the real fix; this keeps the
    // parent's tool_result meaningful instead of empty/garbage for the edge
    // cases that still slip through.
    if (!result && !node.handoffResult && ['limit_reached', 'error'].includes(node.status)) {
      result = `(agent ended as ${node.status} before writing a final answer; no agent_transfer was called${node.error ? ` — ${node.error}` : ''})`;
    }
    // AUTO-TRANSFER FALLBACK: the agent finished WITHOUT calling agent_transfer.
    // The prompt makes it the mandatory final step, but models frequently skip
    // it (esp. top-level coordinators) — which would silently drop the result +
    // artifacts. Deliver them up anyway via the same handler the tool uses, and
    // append a NOTE so it's visible that the backend (not the model) did it.
    // node.submitted (set by agent_transfer) guards against a double-transfer.
    if (!node.submitted && this.deps.transferAgent
        && ['completed', 'limit_reached'].includes(node.status)) {
      try {
        await this.deps.transferAgent(node, {
          result,
          note: '⚙️ [Auto-transferred by AURA backend — this agent finished without calling agent_transfer itself, so the backend delivered its result and artifacts to the parent automatically.]',
        });
        // transferToParent set node.handoffResult (result + note), remapped
        // node.artifacts to the parent scope, and set node.submitted. Adopt the
        // handoff text so the returned AgentResult matches what was handed up.
        if (node.handoffResult) result = node.handoffResult;
        node.autoTransferred = true;   // model forgot; dock shows the ⚙ badge
        this.deps.log.info(`[agents] auto-transfer ${node.agentId} → parent (model skipped agent_transfer)`);
      } catch (e) {
        this.deps.log.warn(`[agents] auto-transfer ${node.agentId}: ${(e as Error).message}`);
      }
    }
    node.result = result;
    node.contextMax = node.contextMax || contextWindowFor(node.model);
    await store.updateAgentMeta({
      status: node.status, finishedAt: Date.now(),
      usage: node.usage, costUsd: node.costUsd, contextMax: node.contextMax,
      ...(result ? { result } : {}),
      submitted: node.submitted,
      ...(node.autoTransferred ? { autoTransferred: true } : {}),
      ...(node.artifacts?.length ? { artifacts: node.artifacts } : {}),
      ...(node.error ? { error: node.error } : {}),
    });
    return {
      agentId: node.agentId,
      status: node.status,
      result,
      usage: { ...node.usage },
      costUsd: node.costUsd,
      ...(node.error ? { error: node.error } : {}),
      ...(node.artifacts?.length ? { artifacts: node.artifacts } : {}),
    };
  }

}
