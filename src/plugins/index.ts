/**
 * Plugin module entrypoint.
 *
 * Caller wires up the registry once during async construction:
 *
 *   const plugins = new PluginRegistry(log);
 *   plugins.register(createClaudeMemPlugin({...}));
 *   // …later, on lifecycle:
 *   await plugins.fire({ event: 'afterAssistantTurn', ... });
 */

export { PluginRegistry } from './PluginRegistry';
export type { ChatPlugin, PluginEvent, PluginContext, AfterAssistantTurnContext } from './types';
export { createClaudeMemPlugin } from './builtin/ClaudeMemPlugin';
