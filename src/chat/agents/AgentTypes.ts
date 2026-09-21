import { ChatMessage, ThinkingEffort, UsageDelta } from '../ChatStreamer';

export type AgentStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'error' | 'cancelled' | 'limit_reached' | 'released';

export interface AgentSpec {
  task: string;
  model?: string;
  effort?: ThinkingEffort | 'off';
  maxTurns?: number;
  returnBudgetTokens?: number;
}

export interface AgentNode {
  rootChatId: string;
  agentId: string;
  parentAgentId?: string;
  /** Groups one top-level spawn_agents call and all descendants. */
  runId?: string;
  depth: number;
  task: string;
  model: string;
  effort: ThinkingEffort | 'off';
  maxTurns: number;
  status: AgentStatus;
  /** True after the agent's context was released/dismissed. Kept SEPARATE from
   *  `status` so a released agent still reports its real terminal outcome
   *  (completed / error / limit_reached / cancelled) — release used to
   *  overwrite `status = 'released'`, which turned every failed agent into a
   *  ✓ in the tree once release_agents ran. */
  released?: boolean;
  /** True after this agent result has been delivered to its parent/orchestrator. */
  submitted?: boolean;
  /** True when the BACKEND auto-transferred this agent (the model finished
   *  without calling agent_transfer itself, so the fallback delivered its
   *  result + artifacts up). Distinct from `submitted` — both are true after an
   *  auto-transfer, but this one flags that the model forgot the mandatory
   *  final step and the backend covered for it. Surfaced in the dock so the
   *  miss is visible instead of looking like a silent gap. */
  autoTransferred?: boolean;
  /** True when the backend's context guard fired for this agent: its runtime
   *  crossed ~85% of the model window, so the loop was auto-interrupted and a
   *  synthesize-and-agent_transfer instruction was injected (a graceful early
   *  return — NOT a compaction). Surfaced in the dock + a toast so the user
   *  knows the agent was force-wrapped before it could balloon past the limit. */
  contextGuarded?: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  sequence: number;
  usage: UsageDelta;
  costUsd: number;
  contextMax?: number;
  returnBudgetTokens?: number;
  result?: string;
  error?: string;
  returnState?: 'pending' | 'summarizing' | 'ready' | 'delivered' | 'failed';
  handoffResult?: string;
  handoffTokens?: number;
  handoffBudgetTokens?: number;
  deliveredAt?: number;
  artifacts?: AgentArtifactRef[];
  /** Artifact ids already promoted to the parent via agent_transfer, so
   *  release_agents / manual submit do not promote (and re-render) them again. */
  transferredArtifactIds?: string[];
  messages?: ChatMessage[];
}

export interface AgentArtifactRef {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sourceAgentId: string;
  savedAt: number;
}

export interface AgentResult {
  agentId: string;
  status: AgentStatus;
  result: string;
  usage: UsageDelta;
  costUsd: number;
  error?: string;
  artifacts?: AgentArtifactRef[];
}

export interface AgentLimits {
  maxDepth: number;
  maxAgentsPerTree: number;
  maxChildrenPerSpawn: number;
  maxConcurrent: number;
  defaultMaxTurns: number;
  maxTurns: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxDepth: Number.MAX_SAFE_INTEGER,
  maxAgentsPerTree: Number.MAX_SAFE_INTEGER,
  maxChildrenPerSpawn: Number.MAX_SAFE_INTEGER,
  maxConcurrent: 4,
  defaultMaxTurns: 12,
  maxTurns: 30,
};

export interface AgentEvent {
  type: 'created' | 'status' | 'chunk' | 'tool' | 'usage' | 'completed' | 'released' | 'context_guard';
  rootChatId: string;
  agentId: string;
  parentAgentId?: string;
  sequence: number;
  payload: any;
}
