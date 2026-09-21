/**
 * Plugin types — minimal contract for extension-side chat plugins.
 *
 * A plugin is a small object that subscribes to lifecycle events fired
 * by ChatPanelV2. Today the only consumer is ClaudeMemPlugin which
 * forwards finished turns to the in-container claude-mem worker, but
 * the shape is intentionally generic so future plugins (extra MCP
 * surfaces, telemetry collectors, custom summarizers) can plug in
 * without touching ChatPanelV2 / ChatSession source.
 */

import { Logger } from '../utils/logger';

/** Lifecycle events. Add new strings as needed; plugins opt in by name. */
export type PluginEvent =
  /** Fired once after the panel finished its async constructor. */
  | 'panelReady'
  /** Fired after every assistant turn finalised (regardless of stop reason). */
  | 'afterAssistantTurn'
  /** Fired when a chat is deleted from the panel. */
  | 'chatDeleted';

export interface AfterAssistantTurnContext {
  event: 'afterAssistantTurn';
  chatId: string;
  projectId: string;
  projectName: string;            // resolved display name; '' for unfiled
  transcriptPath: string;         // newest JSONL file for this chat
  transcriptFiles: string[];      // all JSONL files for this chat (multi-day)
  cwd: string;                    // current vscode workspace root or ''
  stopReason: string;
  /** 0.4.190 — index of the assistant message in JSONL that this fire
   *  corresponds to. Lets downstream broadcasts (e.g. memory.observation)
   *  anchor the memory card to the exact bubble whose text produced the
   *  summary — otherwise the card lands on whatever bubble happens to
   *  be last at broadcast time, which is wrong when a send produced
   *  multiple asst turns via tool iterations. -1 if unresolvable. */
  turnId: number;
  log: Logger;
}

export interface PanelReadyContext {
  event: 'panelReady';
  log: Logger;
}

export interface ChatDeletedContext {
  event: 'chatDeleted';
  chatId: string;
  log: Logger;
}

export type PluginContext =
  | AfterAssistantTurnContext
  | PanelReadyContext
  | ChatDeletedContext;

export interface ChatPlugin {
  /** Stable identifier, used for log lines + de-dup on register. */
  name: string;
  /** Events this plugin reacts to. Filter is applied before handle(). */
  events: PluginEvent[];
  /** Best-effort, fire-and-forget. Errors are logged and swallowed by
   *  the registry so a misbehaving plugin can never break chat. */
  handle(ctx: PluginContext): Promise<void> | void;
}
