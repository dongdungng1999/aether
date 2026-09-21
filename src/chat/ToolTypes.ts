/**
 * ToolTypes — shared shapes for the tool-use plumbing.
 *
 * Why this exists:
 *   ToolRegistry / ToolExecutor used to declare RegistryEntry inline.
 *   Pulled out here so a future built-in tool (or a unit test) can
 *   reference the shape without dragging in MCP/Sandbox client modules.
 *
 * Pattern lifted from poc_aura_v2/extension/src/studio/tools/types.ts —
 * adapted for our MCP+Sandbox routing world. Behaviour unchanged; this is
 * a pure organisational refactor.
 */

import { ToolDef as AnthropicToolDef } from './ChatStreamer';

/** Where a tool actually executes. Sandbox is the only non-MCP route in
 *  MVP. 'ask_user' is a pseudo-tool the executor intercepts to broadcast
 *  a clarify card to the webview and await a user reply (v0.4.162). Add
 *  'builtin' here if/when we port v2's local bash/file-ops. */
export type ToolKind = 'mcp' | 'sandbox' | 'ask_user' | 'spawn_agents' | 'release_agents' | 'agent_transfer' | 'artifact_pin' | 'artifact_update';

/** A tool the model can call, with everything we need to (a) hand it to
 *  /v1/messages and (b) route the resulting tool_use back to the right
 *  executor. ToolRegistry produces these; ToolExecutor consumes them. */
export interface RegistryEntry {
  /** Anthropic-facing tool name we hand to Claude. */
  exposed: string;
  kind:    ToolKind;
  /** MCP only: underlying server slug (e.g. "renesas-image"). */
  server?: string;
  /** MCP only: underlying tool name (e.g. "gpt_generate_image"). */
  rawName?: string;
  /** Anthropic ToolDef sent in /v1/messages. */
  def:     AnthropicToolDef;
}

/** What a tool_use looks like after we've parsed it out of the assistant
 *  turn. ToolExecutor.run() takes one of these. */
export interface ToolCall {
  id:    string;
  name:  string;
  input: Record<string, any>;
}
