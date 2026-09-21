/**
 * ProxyProcessManager — runs the model-routing/MCP-tool proxy
 * (`proxy/src/aether_proxy`) as a plain local Python process, not a Docker
 * container. Replaces the old AURA `ProxyContainerManager` + `ProxyRefs`
 * (docker-compose lifecycle + cross-window refcounting) — a standalone app
 * has exactly one server process, so there's nothing to refcount.
 *
 * Same public shape the old container manager had (baseUrl/isReady/ensure/
 * getPort/forceKill/adopt, plus 'ready' events) so ChatPanelV2/ToolRegistry/
 * ChatSession/AttachmentParser — which only ever called that surface —
 * needed zero changes beyond the import.
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { EnvFileManager, ENV_KEY_WHITELIST } from '../auth/EnvFileManager';
import { pickAvailablePort } from '../utils/portUtils';

const PORT_START = 8600;
const PORT_END   = 8700;
const HOST       = '127.0.0.1';

export class ProxyProcessManager extends EventEmitter {
  private child?: ChildProcess;
  private port = 0;
  private ready = false;
  private mineruUrl = '';
  private starting?: Promise<number>;

  constructor(
    private readonly repoRoot: string,
    private readonly log: Logger,
    private readonly env: EnvFileManager,
  ) { super(); }

  baseUrl(): string { return this.port ? `http://${HOST}:${this.port}` : ''; }
  getPort(): number { return this.port; }
  isReady(): boolean { return this.ready; }

  /** Called from RuntimeConfig whenever the MinerU URL setting changes, so
   *  the next (re)start passes it through as MINERU_API_URL. */
  setMineruUrl(url: string) { this.mineruUrl = url || ''; }

  /** Start the proxy if it isn't running; idempotent. `force` restarts even
   *  if already running (used after a settings change that needs a fresh
   *  process, e.g. MinerU URL). Resolves to the port once healthy. */
  async ensure(force = false): Promise<number> {
    if (this.ready && !force) return this.port;
    if (this.starting && !force) return this.starting;
    if (force) await this.stop();
    this.starting = this.start();
    try { return await this.starting; }
    finally { this.starting = undefined; }
  }

  async restart(): Promise<number> { return this.ensure(true); }

  private async start(): Promise<number> {
    const port = await pickAvailablePort(PORT_START, PORT_END);
    const proxyDir = path.join(this.repoRoot, 'proxy');
    const pythonBin = process.env.AETHER_PYTHON || 'python3';
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    env.PYTHONPATH = path.join(proxyDir, 'src') + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : '');
    env.PROXY_PORT = String(port);
    env.PROXY_HOST = HOST;
    // Whitelisted MCP tool credentials only — no provider/JWT env vars.
    // Model provider connectivity is entirely runtime, via POST
    // /admin/provider (see host.setProvider in ChatPanelV2).
    const keys = this.env.getKeys();
    for (const k of ENV_KEY_WHITELIST) if (keys[k]) env[k] = keys[k];
    if (this.mineruUrl) env.MINERU_API_URL = this.mineruUrl;

    this.log.info(`[proxy] starting: ${pythonBin} -m aether_proxy (port ${port})`);
    const child = spawn(pythonBin, ['-m', 'aether_proxy'], { cwd: proxyDir, env });
    this.child = child;
    this.port = port;
    this.ready = false;

    child.stdout?.on('data', d => this.log.info(`[proxy] ${String(d).trim()}`));
    child.stderr?.on('data', d => this.log.warn(`[proxy] ${String(d).trim()}`));
    child.on('exit', (code, signal) => {
      this.log.warn(`[proxy] exited (code=${code} signal=${signal})`);
      if (this.child === child) { this.child = undefined; this.ready = false; this.port = 0; }
    });
    child.on('error', e => this.log.error(`[proxy] spawn failed: ${(e as Error).message}`));

    await this.waitUntilHealthy(port);
    this.ready = true;
    this.emit('ready', port);
    return port;
  }

  private async waitUntilHealthy(port: number, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://${HOST}:${port}/admin/provider`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) return;
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`proxy did not become healthy within ${timeoutMs}ms`);
  }

  stop() {
    if (!this.child) return;
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    this.child = undefined;
    this.ready = false;
    this.port = 0;
  }

  forceKill(_hard: boolean) {
    if (!this.child) return;
    try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
    this.child = undefined;
    this.ready = false;
    this.port = 0;
  }

  /** No other process to adopt in a standalone deployment (there's exactly
   *  one server, and it always owns its own proxy child). Kept only so the
   *  (dead, VS-Code-panel-only-gated) host.connect RPC still compiles. */
  async adopt(port: number): Promise<void> {
    this.port = port;
    this.ready = true;
    this.emit('ready', port);
  }
}
