/**
 * PluginRegistry — central dispatcher for chat lifecycle events.
 *
 * Designed for a single panel instance: ChatPanelV2 owns one registry,
 * registers built-in plugins during async construction, then calls
 * fire(ctx) from the lifecycle hooks. Plugin failures are isolated —
 * one plugin throwing never affects others or the chat itself.
 */

import { ChatPlugin, PluginContext, PluginEvent } from './types';
import { Logger } from '../utils/logger';

export class PluginRegistry {
  private plugins: ChatPlugin[] = [];

  constructor(private readonly log: Logger) {}

  /** Register a plugin. Duplicate names replace the prior entry so a
   *  reload-friendly call site (e.g. activate()) stays idempotent. */
  register(plugin: ChatPlugin): void {
    const existing = this.plugins.findIndex(p => p.name === plugin.name);
    if (existing >= 0) this.plugins.splice(existing, 1, plugin);
    else               this.plugins.push(plugin);
    this.log.info(`[plugins] registered ${plugin.name} (events: ${plugin.events.join(',')})`);
  }

  unregister(name: string): void {
    this.plugins = this.plugins.filter(p => p.name !== name);
  }

  list(): ReadonlyArray<{ name: string; events: PluginEvent[] }> {
    return this.plugins.map(p => ({ name: p.name, events: [...p.events] }));
  }

  /** Dispatch an event to every registered plugin that opted in.
   *  Fire-and-forget: never throws. */
  async fire(ctx: PluginContext): Promise<void> {
    const matched = this.plugins.filter(p => p.events.includes(ctx.event));
    await Promise.all(matched.map(async p => {
      try {
        await p.handle(ctx);
      } catch (e) {
        this.log.warn(`[plugins] ${p.name} on ${ctx.event} threw: ${(e as Error).message}`);
      }
    }));
  }
}
