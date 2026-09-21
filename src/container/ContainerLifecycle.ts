/**
 * ContainerLifecycle — high-level operations on the proxy AND sandbox
 * services defined in docker-compose.yml.
 *
 * Image vs container — these are different concepts:
 *   • IMAGE     = the build artifact (`docker images …`).
 *   • CONTAINER = a running instance of an image (`docker ps`).
 *   The UI reflects this: separate Build / Install / Stop / Remove buttons,
 *   and a "Purge" that does down + rmi.
 *
 * The same docker-compose.yml is shared with the CLI (./aura.sh) so the
 * extension and CLI build the SAME images.
 */

import { spawn, exec as execCb } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as path from 'path';
import { existsSync } from 'fs';
import { Logger } from '../utils/logger';
import { PresetManager } from '../preset/PresetManager';

const exec = promisify(execCb);

export type Service = 'proxy' | 'sandbox' | 'sandbox-dev';

/** Container-side health endpoint per service. */
const HEALTH_PATH: Record<Service, string> = {
  proxy:          '/v1/models',
  sandbox:        '/health',
  'sandbox-dev':  '/health',
};

/** Container-side port the service listens on (mapped to host with -p). */
const CONTAINER_PORT: Record<Service, number> = {
  proxy:          8000,
  sandbox:        8765,
  'sandbox-dev':  8765,
};

export interface ContainerInfo {
  id:      string;
  name:    string;
  image:   string;
  ports:   number[];     // host ports mapped to the service's container port
  status:  string;
  service: Service | 'other';
  /** True when the container name matches `official-aura-{svc}-{user}` —
   *  i.e. THIS extension owns it. CLI's `aura-proxy-…` containers are
   *  service='proxy' but owned=false. */
  owned:   boolean;
}

export interface ImageInfo {
  id:        string;
  repo:      string;
  tag:       string;
  size:      string;
  service:   Service | 'other';
}

export class ContainerLifecycle {
  constructor(
    private readonly composeFile: string,
    private readonly preset:      PresetManager,
    private readonly log:         Logger,
    /** ctx.globalStorageUri.fsPath — used as fallback for RENESAS_IMAGE_OUTPUT_DIR. */
    private readonly dataRoot?:   string,
  ) {}

  /** Directory holding docker-compose.yml — used by callers that need to
   *  drop a docker-compose.override.yml next to it (e.g. mount injection). */
  composeDir(): string { return path.dirname(this.composeFile); }

  /* ── builds + ups ──────────────────────────────────── */
  async buildImage(svc: Service, extra: Record<string, string> = {}): Promise<void> {
    this.log.info(`[container] build ${svc}`);
    await this.dc(['build', svc], await this.preset.toComposeEnv(extra, this.dataRoot));
  }

  async installContainer(svc: Service, extra: Record<string, string> = {}, forceRecreate = false): Promise<{ port: number }> {
    const env = await this.preset.toComposeEnv(extra, this.dataRoot);
    const port = svc === 'proxy'
      ? parseInt(String(env.AURA_PROXY_PORT       ?? '0'), 10) || 0
      : svc === 'sandbox-dev'
      ? parseInt(String(env.AURA_SANDBOX_DEV_PORT ?? '0'), 10) || 0
      : parseInt(String(env.AURA_SANDBOX_PORT     ?? '0'), 10) || 0;
    this.log.info(`[container] up ${svc} → :${port}${forceRecreate ? ' (--force-recreate)' : ''}`);
    await this.dc(forceRecreate ? ['up', '-d', '--force-recreate', svc] : ['up', '-d', svc], env);

    // Belt-and-suspenders: compose can exit 0 even when the container died on
    // start (e.g. immediate crash before healthcheck kicks in). Verify the
    // container actually exists and is in a state docker considers "Up".
    // Without this the UI cheerfully says "installed" while `docker ps` is
    // empty — which is exactly the bug the user reported.
    const containers = await this.listContainers();
    const own = containers.find(c => c.service === svc && c.owned);
    if (!own) {
      throw new Error(`compose finished but no ${svc} container appeared — ` +
                      `check Output → official-aura for build/start errors`);
    }
    if (!/up/i.test(own.status)) {
      throw new Error(`${svc} container ${own.name} is in state "${own.status}" ` +
                      `— check logs (\`docker logs ${own.name}\`)`);
    }
    return { port: own.ports[0] ?? port };
  }

  /* ── stops / removes ───────────────────────────────── */

  /** Stop/remove by container name (not compose service) to avoid cross-service collisions. */
  async stopContainer(svc: Service): Promise<void> {
    const containers = await this.listContainers();
    const owned = containers.filter(c => c.service === svc && c.owned);
    if (!owned.length) { this.log.info(`[container] stop ${svc}: no owned containers`); return; }
    for (const c of owned) {
      this.log.info(`[container] stop ${c.name}`);
      try { await exec(`docker stop ${c.name}`); this.log.raw(`Stopped ${c.name}\n`); }
      catch (e) { this.log.warn(`[container] stop ${c.name}: ${(e as Error).message}`); }
    }
  }

  async removeContainer(svc: Service): Promise<void> {
    const containers = await this.listContainers();
    const owned = containers.filter(c => c.service === svc && c.owned);
    if (!owned.length) { this.log.info(`[container] rm ${svc}: no owned containers`); return; }
    for (const c of owned) {
      this.log.info(`[container] rm -f ${c.name}`);
      try { await exec(`docker rm -f ${c.name}`); this.log.raw(`Removed ${c.name}\n`); }
      catch (e) { this.log.warn(`[container] rm ${c.name}: ${(e as Error).message}`); }
    }
  }

  /**
   * Remove EVERY image owned by this service — all tagged versions
   * (`official-aura-{svc}` + `official-aura-{svc}-{user}`, any tag) AND any
   * dangling layers their last build left behind. We collect image IDs first
   * and `rmi -f` by ID, so a single image with multiple tags is fully gone
   * (rmi-by-tag only untags). The whole disk footprint of the service is
   * reclaimed in one click.
   */
  async removeImage(svc: Service): Promise<void> {
    const user    = (require('os').userInfo().username || 'default') as string;
    const project = `official-aura-${user}`;
    this.log.info(`[container] rmi ${svc} (all tags + dangling, project=${project})`);

    const ids = new Set<string>();
    const collect = async (cmd: string) => {
      try {
        const r = await exec(cmd);
        for (const id of r.stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
          ids.add(id);
        }
      } catch (e) {
        this.log.warn(`[container] rmi list failed (${cmd}): ${(e as Error).message}`);
      }
    };

    // Tagged images for this service — the user-suffixed repo and the bare
    // repo, across every tag. Use the exact user-suffixed repo (no trailing
    // "-*" wildcard) so removing `sandbox` does NOT also match the separate
    // `sandbox-dev` repo (official-aura-sandbox-dev-… starts with the sandbox
    // prefix). rmi is by resolved ID below, so exact-repo is sufficient.
    await collect(`docker images -q --filter "reference=${this.ownedPrefix(svc)}"`);
    await collect(`docker images -q --filter "reference=official-aura-${svc}"`);

    // Dangling layers left over from previous builds of THIS extension's
    // compose project + service. Project label scopes the filter to this OS
    // user's stack so we never touch the CLI's images or another user's.
    await collect(
      `docker images -q --filter "dangling=true" ` +
      `--filter "label=com.docker.compose.project=${project}" ` +
      `--filter "label=com.docker.compose.service=${svc}"`,
    );

    if (!ids.size) { this.log.info(`[container] rmi ${svc}: no images`); return; }

    for (const id of ids) {
      try {
        const r = await exec(`docker rmi -f ${id}`);
        if (r.stdout) this.log.raw(r.stdout);
      } catch (e) {
        this.log.warn(`[container] rmi ${id} failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Down (stop + rm) + rmi + prune build cache for the given service.
   * Clean slate — removes every artifact this service left on disk.
   * Build cache is the surprise heavyweight: a proxy rebuild can leave
   * hundreds of MB of BuildKit layers that survive a plain `rmi`.
   */
  async purge(svc: Service): Promise<void> {
    this.log.info(`[container] purge ${svc}`);
    await this.removeContainer(svc);
    await this.removeImage(svc);
    // BuildKit cache scoped to this extension's compose project + service.
    // Project label keeps this from touching the CLI's build cache or
    // another OS user's; service label keeps proxy/sandbox prunes separate.
    const user    = (require('os').userInfo().username || 'default') as string;
    const project = `official-aura-${user}`;
    try {
      // `docker builder prune --filter` rejects more than one `label=` value
      // ("filters expect only one value"). Scope by project label only — that
      // already isolates this extension's stack from CLI's. Per-service
      // filtering would be nice but build cache rarely benefits from that
      // granularity in practice.
      const r = await exec(
        `docker builder prune -f ` +
        `--filter "label=com.docker.compose.project=${project}"`,
      );
      if (r.stdout) this.log.raw(r.stdout);
    } catch (e) {
      this.log.warn(`[container] builder prune ${svc} failed: ${(e as Error).message}`);
    }
  }

  /* ── inspection ────────────────────────────────────── */

  /** Prefix that owned containers share. Both proxy and sandbox include
   *  the OS username; the port suffix varies per preset so we match by prefix only. */
  private ownedPrefix(svc: Service): string {
    const user = (require('os').userInfo().username || 'default') as string;
    return `official-aura-${svc}-${user}`;
    // e.g. "official-aura-proxy-dungnguyen-8133"
    //      "official-aura-sandbox-dungnguyen-8829"
    // Both start with this prefix; port suffix is ignored in ownership check.
  }

  async listContainers(): Promise<ContainerInfo[]> {
    let out = '';
    try {
      const r = await exec('docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"');
      out = r.stdout;
    } catch (e) {
      this.log.warn(`[container] docker ps failed: ${(e as Error).message}`);
      return [];
    }
    const proxyOwned   = this.ownedPrefix('proxy');
    const sandboxOwned = this.ownedPrefix('sandbox');
    const sandboxDevOwned = this.ownedPrefix('sandbox-dev');
    const rows: ContainerInfo[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [id, name, image, status, portsRaw] = line.split('|');

      // Service classification — broader than "owned" so the picker can
      // surface CLI's containers too. The aura_svcs stack's `svcs-proxy-…`
      // is an AURA-shaped proxy (same /v1/models health) but its name/image
      // lack the "aura" token, so it's matched explicitly here — the Connect
      // picker needs it while the AI portal is under maintenance. sandbox-dev
      // must be checked BEFORE sandbox: its name (…-sandbox-dev-…) also matches
      // the sandbox regex, so order disambiguates. Both share the sandbox
      // image, so the image regex alone can't tell them apart — name is the
      // discriminator.
      const service: Service | 'other' =
        /aura.*proxy/i.test(name) || /aura-proxy/i.test(image)
          || /svcs-proxy/i.test(name) || /svcs-proxy/i.test(image) ? 'proxy'
      : /aura.*sandbox-dev/i.test(name) ? 'sandbox-dev'
      : /aura.*sandbox/i.test(name) || /aura-sandbox/i.test(image) ? 'sandbox'
      : 'other';

      // Normal case: name starts with the owned prefix.
      // Fallback: Compose v5 sometimes generates a hash-prefixed name like
      // "abc123_official-aura-proxy-<user>-…" when cwd drifts between runs.
      // We still claim ownership so stop/remove can clean them up.
      const owned =
        service === 'proxy'       ? (name.startsWith(proxyOwned)      || name.includes(`_${proxyOwned}`))
      : service === 'sandbox-dev' ? (name.startsWith(sandboxDevOwned) || name.includes(`_${sandboxDevOwned}`))
      : service === 'sandbox'     ? (name.startsWith(sandboxOwned)    || name.includes(`_${sandboxOwned}`))
      : false;

      const wantPort = service === 'other' ? -1 : CONTAINER_PORT[service];
      const ports: number[] = [];
      for (const m of portsRaw.matchAll(/:(\d+)->(\d+)\/tcp/g)) {
        const cp = parseInt(m[2], 10);
        if (cp === wantPort || wantPort === -1) ports.push(parseInt(m[1], 10));
      }
      rows.push({ id, name, image, ports, status, service, owned });
    }
    return rows;
  }

  async listImages(): Promise<ImageInfo[]> {
    let out = '';
    try {
      const r = await exec('docker images --format "{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}"');
      out = r.stdout;
    } catch (e) {
      this.log.warn(`[container] docker images failed: ${(e as Error).message}`);
      return [];
    }
    const proxyOwned      = this.ownedPrefix('proxy');
    const sandboxOwned    = this.ownedPrefix('sandbox');
    const sandboxDevOwned = this.ownedPrefix('sandbox-dev');
    const rows: ImageInfo[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [id, repo, tag, size] = line.split('|');
      const isProxy      = repo.startsWith(proxyOwned)      || repo === 'official-aura-proxy';
      // sandbox-dev must be checked BEFORE sandbox: its repo
      // (official-aura-sandbox-dev-…) also matches the sandbox prefix.
      const isSandboxDev = repo.startsWith(sandboxDevOwned) || repo === 'official-aura-sandbox-dev';
      const isSandbox    = repo.startsWith(sandboxOwned)    || repo === 'official-aura-sandbox';
      const service: Service | 'other' =
          isProxy ? 'proxy' : isSandboxDev ? 'sandbox-dev' : isSandbox ? 'sandbox' : 'other';
      rows.push({ id, repo, tag, size, service });
    }
    return rows;
  }

  /** Probe whether the given host port answers the service's health endpoint. */
  probePort(svc: Service, port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise(resolve => {
      const req = http.get(
        { host: '127.0.0.1', port, path: HEALTH_PATH[svc], timeout: timeoutMs },
        res => { res.resume(); resolve((res.statusCode ?? 500) < 500); },
      );
      req.on('error',   () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  private dc(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
      // Pick up an optional docker-compose.override.yml sitting next to the
      // base file. Generated by ProxyContainerManager from host.yaml's
      // mounts:/mcp.mineru_local_path block (mirrors what cli/linux/run.sh
      // does for the CLI proxy). Compose merges automatically; we just
      // pass `-f base -f override`.
      const composeArgs = ['compose', '-f', this.composeFile];
      const overrideFile = path.join(path.dirname(this.composeFile), 'docker-compose.override.yml');
      if (existsSync(overrideFile)) composeArgs.push('-f', overrideFile);
      composeArgs.push(...args);

      this.log.info(`$ docker ${composeArgs.join(' ')}`);
      this.log.show();   // make sure user can see what's happening
      const child = spawn('docker', composeArgs, {
        env, stdio: ['ignore', 'pipe', 'pipe'],
        // Must match the working_dir Docker Compose uses to compute its
        // internal config hash. Without an explicit cwd the child inherits
        // the VS Code workspace folder, which varies per window — Compose v5
        // sees a different hash each time and creates a NEW container with a
        // generated-name prefix (e.g. "abc123_<container_name>") instead of
        // re-using / replacing the existing one. That breaks the
        // listContainers() startsWith ownership check.
        cwd: path.dirname(this.composeFile),
      });
      child.stdout?.on('data', (d: Buffer) => this.log.raw(d.toString()));
      child.stderr?.on('data', (d: Buffer) => this.log.raw(d.toString()));
      child.on('exit',  code => code === 0
        ? resolve()
        : reject(new Error(`docker compose ${args.join(' ')} → exit ${code}`)));
      child.on('error', reject);
    });
  }
}
