import { randomBytes } from 'crypto';
import { AgentEvent, AgentLimits, AgentNode, AgentResult, AgentSpec, DEFAULT_AGENT_LIMITS } from './AgentTypes';

export type AgentRun = (node: AgentNode) => Promise<AgentResult>;
export type AgentResume = (node: AgentNode) => Promise<AgentResult>;

export class AgentRegistry {
  private readonly nodes = new Map<string, AgentNode>();
  private readonly cancellers = new Map<string, () => void>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private resumeAgent?: AgentResume;

  constructor(
    readonly rootChatId: string,
    private readonly runAgent: AgentRun,
    private readonly emit: (event: AgentEvent) => void,
    readonly limits: AgentLimits = DEFAULT_AGENT_LIMITS,
  ) {}

  setResumer(fn: AgentResume) { this.resumeAgent = fn; }

  snapshot(): AgentNode[] {
    return [...this.nodes.values()].map(n => ({ ...n, messages: undefined }));
  }

  restore(nodes: AgentNode[]) {
    for (const node of nodes) {
      if (!node?.agentId || this.nodes.has(node.agentId)) continue;
      this.nodes.set(node.agentId, { ...node, messages: undefined });
    }
    // Backfill run scopes for older persisted agents. Each root becomes its own
    // run; descendants inherit the nearest root so Submit All can stay scoped.
    for (const node of this.nodes.values()) this.ensureRunId(node);
  }

  private ensureRunId(node: AgentNode): string {
    if (node.runId) return node.runId;
    if (node.parentAgentId) {
      const parent = this.nodes.get(node.parentAgentId);
      node.runId = parent ? this.ensureRunId(parent) : node.agentId;
    } else {
      node.runId = node.agentId;
    }
    return node.runId;
  }

  updatePersisted(agentId: string, status: AgentNode['status'], finishedAt?: number) {
    const node = this.nodes.get(agentId);
    if (!node) return;
    node.status = status;
    if (finishedAt) node.finishedAt = finishedAt;
  }

  get(agentId: string): AgentNode | undefined { return this.nodes.get(agentId); }

  setCanceller(agentId: string, cancel: () => void) { this.cancellers.set(agentId, cancel); }

  cancel(agentId: string): boolean {
    const node = this.nodes.get(agentId);
    if (!node) return false;
    const descendants = [...this.nodes.values()]
      .filter(n => this.isDescendant(n.agentId, agentId))
      .sort((a, b) => b.depth - a.depth);
    for (const child of descendants) this.cancelOne(child.agentId);
    this.cancelOne(agentId);
    return true;
  }

  cancelAll() {
    for (const node of [...this.nodes.values()].sort((a, b) => b.depth - a.depth)) {
      this.cancelOne(node.agentId);
    }
  }

  /** Cancel all running/queued agents then mark the entire tree as released.
   *  Used when the user explicitly dismisses all agent cards from the UI. */
  dismissAll() {
    this.cancelAll();
    const now = Date.now();
    for (const node of [...this.nodes.values()].sort((a, b) => b.depth - a.depth)) {
      if (!node.released) {
        node.released = true;
        node.finishedAt = node.finishedAt || now;
        this.publish(node, 'released', this.resultOf(node));
      }
    }
  }

  /** Cancel a subtree (if running) then mark it as released.
   *  Used when the user dismisses a single agent card from the UI. */
  dismissSubtree(agentId: string): boolean {
    const node = this.nodes.get(agentId);
    if (!node) return false;
    this.cancel(agentId);
    const now = Date.now();
    const subtree = [node, ...[...this.nodes.values()].filter(n => this.isDescendant(n.agentId, agentId))]
      .sort((a, b) => b.depth - a.depth);
    for (const n of subtree) {
      if (!n.released) {
        n.released = true;
        n.finishedAt = n.finishedAt || now;
        this.publish(n, 'released', this.resultOf(n));
      }
    }
    return true;
  }

  /** Resume a cancelled/interrupted subtree rooted at agentId.
   *  Each node in the subtree whose status is cancelled/error is re-queued
   *  using resumeAgent (which hydrates history from disk). Nodes that
   *  already completed are left intact. Returns false if no resumer set. */
  async resumeSubtree(agentId: string): Promise<boolean> {
    return this.resumeSubtreeInternal(agentId, false);
  }

  /** Resume and await completion. Used by Force return so propagation cannot
   *  advance to the parent before this subtree has produced a stable result. */
  async resumeSubtreeAndWait(agentId: string): Promise<boolean> {
    return this.resumeSubtreeInternal(agentId, true);
  }

  /** Force a terminal node to continue after backend-appended child handoffs. */
  async forceResumeAndWait(agentId: string): Promise<boolean> {
    if (!this.resumeAgent) return false;
    const node = this.nodes.get(agentId);
    if (!node || node.released) return false;
    node.status = 'queued';
    node.finishedAt = undefined;
    this.publish(node, 'status', { status: 'queued' });
    await this.runQueued(node, this.resumeAgent);
    return true;
  }

  private async resumeSubtreeInternal(agentId: string, wait: boolean): Promise<boolean> {
    if (!this.resumeAgent) return false;
    const root = this.nodes.get(agentId);
    if (!root) return false;
    if (!['queued', 'running', 'waiting', 'cancelled', 'error'].includes(root.status)) return false;
    root.status = 'queued';
    root.finishedAt = undefined;
    this.publish(root, 'status', { status: 'queued' });
    const run = this.runQueued(root, this.resumeAgent);
    if (wait) await run;
    else run.catch(() => {});
    return true;
  }

  /** Bottom-up resume: for each child that is incomplete, recursively resume
   *  it (using resumeAgent) and wait for it to finish before returning.
   *  Children that are already completed/released are passed through as-is.
   *  Yields the parent's semaphore slot while children run, exactly like
   *  spawn() does, so the concurrency accounting stays balanced.
   *
   *  Called by AgentRunner.resumeFromDisk when it detects an orphaned
   *  spawn_agents tool_use whose children already exist in the registry. */
  async resumeOrCollectChildren(parentAgentId: string, children: AgentNode[]): Promise<AgentResult[]> {
    if (!this.resumeAgent) return children.map(c => this.resultOf(c));

    const incomplete = children.filter(c => !this.isSubtreeCollectable(c));
    if (incomplete.length > 0) {
      // Yield the parent's slot so children can acquire theirs (mirrors spawn())
      const parent = this.nodes.get(parentAgentId);
      const yielded = parent?.status === 'running';
      if (yielded) this.release();
      try {
        await Promise.all(incomplete.map(child => {
          child.status = 'queued';
          child.finishedAt = undefined;
          this.publish(child, 'status', { status: 'queued' });
          return this.runQueued(child, this.resumeAgent);
        }));
      } finally {
        if (yielded) await this.acquire();
      }
    }

    return children.map(c => this.resultOf(c));
  }

  /** Validate and mark an owner's completed subtree as released. The caller
   *  performs durable capture/cleanup before invoking this method. */
  releaseOwned(ownerAgentId: string | undefined, agentIds: string[]): AgentResult[] {
    const unique = [...new Set(agentIds.map(String))];
    if (!unique.length) throw new Error('release_agents requires a non-empty agentIds array');
    const roots = unique.map(id => {
      const node = this.nodes.get(id);
      if (!node) throw new Error(`unknown agent: ${id}`);
      if (node.parentAgentId !== ownerAgentId) throw new Error(`agent '${id}' is not owned by this caller`);
      if (!node.released && !['completed', 'error', 'cancelled', 'limit_reached'].includes(node.status)) {
        throw new Error(`agent '${id}' is still ${node.status}`);
      }
      return node;
    });
    const released: AgentResult[] = [];
    for (const root of roots) {
      const subtree = [root, ...[...this.nodes.values()].filter(n => this.isDescendant(n.agentId, root.agentId))]
        .sort((a, b) => b.depth - a.depth);
      for (const node of subtree) {
        if (!node.released) {
          // Mark released WITHOUT clobbering the real terminal status — a
          // failed agent must keep showing error/limit_reached in the tree.
          node.released = true;
          node.finishedAt = node.finishedAt || Date.now();
          this.publish(node, 'released', this.resultOf(node));
        }
      }
      released.push(this.resultOf(root));
    }
    return released;
  }

  async spawn(parentAgentId: string | undefined, specs: AgentSpec[], defaults: {
    model: string; effort: AgentNode['effort']; availableModels: string[]; returnBudgetTokens?: number;
  }): Promise<AgentResult[]> {
    if (!Array.isArray(specs) || !specs.length) throw new Error('spawn_agents requires a non-empty agents array');
    if (specs.length > this.limits.maxChildrenPerSpawn) {
      throw new Error(`spawn limit: at most ${this.limits.maxChildrenPerSpawn} children per call`);
    }
    const parentDepth = parentAgentId ? this.nodes.get(parentAgentId)?.depth : 0;
    if (parentDepth == null) throw new Error(`unknown parent agent: ${parentAgentId}`);
    const depth = parentDepth + 1;
    if (depth > this.limits.maxDepth) throw new Error(`agent depth limit reached (${this.limits.maxDepth})`);
    if (this.nodes.size + specs.length > this.limits.maxAgentsPerTree) {
      throw new Error(`agent tree limit reached (${this.limits.maxAgentsPerTree})`);
    }
    const allowedModels = new Set(defaults.availableModels);
    // Top-level agents (orchestrator spawns them → no parent) from ONE
    // spawn_agents call share a single runId. Previously each got runId =
    // agentId, so batch-mates split into separate runs: the newest became the
    // "active run" and its siblings — just spawned in the same call — dropped
    // into "older agent runs". A batch id keeps them together at the top.
    const batchRunId = parentAgentId ? undefined : `run_${randomBytes(6).toString('hex')}`;
    const nodes = specs.map(spec => {
      const task = String(spec?.task || '').trim();
      if (!task) throw new Error('every child agent requires a non-empty task');
      const model = String(spec.model || defaults.model);
      if (!allowedModels.has(model)) {
        throw new Error(`model '${model}' is not available; choose one of: ${[...allowedModels].join(', ')}`);
      }
      const maxTurns = Math.min(this.limits.maxTurns, Math.max(1,
        Number(spec.maxTurns || this.limits.defaultMaxTurns)));
      const agentId = `agt_${randomBytes(6).toString('hex')}`;
      const parent = parentAgentId ? this.nodes.get(parentAgentId) : undefined;
      const node: AgentNode = {
        rootChatId: this.rootChatId,
        agentId,
        parentAgentId,
        runId: parent?.runId || batchRunId || agentId,
        depth,
        task,
        model,
        effort: spec.effort || defaults.effort,
        maxTurns,
        status: 'queued',
        createdAt: Date.now(),
        sequence: 0,
        usage: { inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        returnBudgetTokens: Number.isFinite(spec.returnBudgetTokens ?? defaults.returnBudgetTokens)
          ? Math.max(1, Math.floor(Number(spec.returnBudgetTokens ?? defaults.returnBudgetTokens)))
          : undefined,
        returnState: 'pending',
      };
      this.nodes.set(node.agentId, node);
      this.publish(node, 'created', this.publicNode(node));
      return node;
    });
    // A running parent is blocked inside its spawn_agents tool call while the
    // children work. Temporarily yield that scheduler slot; otherwise a full
    // set of parents can each wait on queued children forever. Reacquire before
    // returning so runQueued's final release remains balanced.
    const parent = parentAgentId ? this.nodes.get(parentAgentId) : undefined;
    const yielded = parent?.status === 'running';
    if (yielded) this.release();
    try {
      return await Promise.all(nodes.map(node => this.runQueued(node)));
    } finally {
      // Always restore the parent's accounting slot. Its outer runQueued()
      // owns the matching release even when cancellation happened mid-spawn.
      if (yielded) await this.acquire();
    }
  }

  publish(node: AgentNode, type: AgentEvent['type'], payload: any) {
    node.sequence++;
    this.emit({
      type, rootChatId: this.rootChatId, agentId: node.agentId,
      parentAgentId: node.parentAgentId, sequence: node.sequence, payload,
    });
  }

  private async runQueued(node: AgentNode, runner?: AgentRun | AgentResume): Promise<AgentResult> {
    await this.acquire();
    if (node.status === 'cancelled') {
      this.release();
      return this.resultOf(node);
    }
    node.status = 'running';
    node.startedAt = Date.now();
    this.publish(node, 'status', { status: node.status, startedAt: node.startedAt });
    try {
      const result = await (runner ?? this.runAgent)(node);
      Object.assign(node, result, { finishedAt: Date.now() });
      this.publish(node, 'completed', this.resultOf(node));
      return this.resultOf(node);
    } catch (e) {
      node.status = this.nodes.get(node.agentId)?.status === 'cancelled' ? 'cancelled' : 'error';
      node.error = (e as Error).message;
      node.result = node.result || '';
      node.finishedAt = Date.now();
      this.publish(node, 'completed', this.resultOf(node));
      return this.resultOf(node);
    } finally {
      this.cancellers.delete(node.agentId);
      this.release();
    }
  }

  private async acquire() {
    if (this.active < this.limits.maxConcurrent) { this.active++; return; }
    // A released slot is transferred directly to the oldest waiter. The
    // waiter must not increment active again or the semaphore leaks capacity.
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  private release() {
    const waiter = this.waiters.shift();
    if (waiter) { waiter(); return; }
    this.active = Math.max(0, this.active - 1);
  }

  private cancelOne(agentId: string) {
    const node = this.nodes.get(agentId);
    if (!node) return;
    // Cancel only aborts IN-FLIGHT work. Never downgrade a node that already
    // reached a real outcome (or was released) — doing so used to rewrite a
    // completed/error agent to 'cancelled', which was masked only because the
    // dismiss path immediately overwrote status with 'released'. Now that
    // release is a separate flag, that mask is gone, so guard here.
    if (node.released || ['completed', 'error', 'cancelled', 'limit_reached'].includes(node.status)) return;
    node.status = 'cancelled';
    node.finishedAt = Date.now();
    this.cancellers.get(agentId)?.();
    this.publish(node, 'status', { status: 'cancelled', finishedAt: node.finishedAt });
  }

  private isDescendant(agentId: string, ancestorId: string): boolean {
    let node = this.nodes.get(agentId);
    while (node?.parentAgentId) {
      if (node.parentAgentId === ancestorId) return true;
      node = this.nodes.get(node.parentAgentId);
    }
    return false;
  }

  private isSubtreeCollectable(node: AgentNode): boolean {
    // Preserve the original semantics now that release no longer overwrites
    // status: a node counts as collectable if released, completed, or
    // limit_reached. An error/cancelled node that has NOT been released is
    // still "incomplete" so resume can retry it (unchanged from before, when
    // status !== 'released' meant the same thing).
    const collectable = (n: AgentNode) =>
      n.released || ['completed', 'limit_reached'].includes(n.status);
    if (!collectable(node)) return false;
    const descendants = [...this.nodes.values()].filter(n => this.isDescendant(n.agentId, node.agentId));
    return descendants.every(collectable);
  }

  private resultOf(node: AgentNode): AgentResult {
    return {
      agentId: node.agentId,
      status: node.status,
      result: node.result || '',
      usage: { ...node.usage },
      costUsd: node.costUsd,
      ...(node.error ? { error: node.error } : {}),
      ...(node.artifacts?.length ? { artifacts: node.artifacts.map(a => ({ ...a })) } : {}),
    };
  }

  private publicNode(node: AgentNode) {
    const { messages: _messages, ...publicNode } = node;
    return publicNode;
  }
}
