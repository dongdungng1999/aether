/**
 * SandboxContainerManager — minimal lifecycle wrapper around the sandbox
 * service in docker-compose.yml.
 *
 * Unlike ProxyContainerManager there's no cross-window refcounting: the
 * sandbox is per-OS-user, every VS Code window of that user adopts the
 * same container if it's already up.
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/logger';
import { ContainerLifecycle, Service } from '../container/ContainerLifecycle';
import { PresetManager } from '../preset/PresetManager';

/** Which sandbox flavour this manager drives — the normal per-user sandbox
 *  or the Developer-Mode (`sandbox-dev`) container that runs as root with
 *  host mounts. Both share the same image; only the container + port differ. */
export type SandboxKind = Extract<Service, 'sandbox' | 'sandbox-dev'>;

export class SandboxContainerManager extends EventEmitter {
  private port  = 0;
  private ready = false;

  constructor(
    private readonly lifecycle: ContainerLifecycle,
    private readonly log:       Logger,
    /** Defaults to the normal sandbox; pass 'sandbox-dev' for Developer Mode. */
    private readonly kind:      SandboxKind = 'sandbox',
    private readonly preset?:   PresetManager,
  ) { super(); }

  getPort(): number  { return this.port; }
  isReady(): boolean { return this.ready; }
  baseUrl(): string  { return `http://127.0.0.1:${this.port}`; }
  getKind(): SandboxKind { return this.kind; }

  async ensure(force = false): Promise<{ port: number; adopted: boolean }> {
    // Adopt if a sandbox container of THIS flavour is already running.
    const containers = await this.lifecycle.listContainers();
    const hit = containers.find(c => c.service === this.kind && c.owned && c.ports.length);
    const running = hit && await this.lifecycle.probePort(this.kind, hit.ports[0]);
    if (!force && running) {
      this.port  = hit!.ports[0];
      this.ready = true;
      this.emit('ready', this.port);
      return { port: this.port, adopted: true };
    }

    // Force reinstall: recreate even if healthy. Dump the procedure to Output.
    if (force && running) {
      this.log.raw(
        `\n── Force reinstall ${this.kind} ──────────────────────\n` +
        `${this.kind} đang chạy trên :${hit!.ports[0]}. Quy trình:\n` +
        `  1. stop container hiện tại\n` +
        `  2. docker compose up -d --force-recreate (recreate, KHÔNG rebuild image)\n\n`,
      );
      this.log.show();
      await this.lifecycle.stopContainer(this.kind);
    }

    if (this.preset) {
      try {
        await this.preset.generateMountOverride(this.lifecycle.composeDir());
      } catch (e) {
        this.log.warn(`[${this.kind}] generateMountOverride failed: ${(e as Error).message}`);
      }
    }
    const { port } = await this.lifecycle.installContainer(this.kind, {}, force);
    this.port  = port;
    this.ready = true;
    this.emit('ready', this.port);
    return { port, adopted: false };
  }

  async stop(): Promise<void> {
    await this.lifecycle.stopContainer(this.kind);
    this.ready = false;
  }

  async forceKill(): Promise<void> {
    await this.lifecycle.removeContainer(this.kind);
    this.ready = false;
  }
}
