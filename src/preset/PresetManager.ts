/**
 * PresetManager — read/write the host preset (host.yaml).
 *
 * The preset is the SAME file the CLI (./aura.sh) uses, so the extension
 * and CLI stay in sync about model map, port range, MCP wiring and mounts.
 *
 * We use a tiny indent-based YAML reader instead of a library — the file
 * is small and well-structured. We don't try to round-trip arbitrary YAML;
 * "Edit Preset" hands the user the raw text and "Save" writes it verbatim.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { Logger } from '../utils/logger';

/** Hash the docker/proxy build inputs so the image tag stays stable across
 *  extension bumps that only touch FE/prompt code. Compose then sees "no
 *  drift" and skips the recreate/build cycle. Only rebuilds when the actual
 *  container content changes. */
let _cachedProxyHash: string | null = null;
function proxyContentVersion(): string {
  if (_cachedProxyHash) return _cachedProxyHash;
  const root = path.resolve(__dirname, '../../../..', 'docker/proxy');
  const h = crypto.createHash('sha256');
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    let stat: fsSync.Stats;
    try { stat = fsSync.statSync(abs); } catch { return; }
    if (stat.isDirectory()) {
      for (const name of fsSync.readdirSync(abs).sort()) walk(path.join(rel, name));
    } else if (stat.isFile()) {
      h.update(rel).update('\0');
      h.update(fsSync.readFileSync(abs));
    }
  };
  // Bundled claude-cli is a 229 MB vendored blob that never changes between
  // extension bumps; skip it to keep the hash cheap.
  for (const sub of ['Dockerfile', 'requirements.txt', 'entrypoint.sh',
                     'src', 'mcp_servers', 'configs']) walk(sub);
  _cachedProxyHash = h.digest('hex').slice(0, 12);
  return _cachedProxyHash;
}

export interface PresetData {
  /** Preset identity — populated from the `preset:` block when present. */
  preset: {
    name:        string;   // e.g. "linux" | "windows" | "custom"
    description: string;
  };
  proxy: {
    portMode:  'auto' | 'manual';
    port:      number;
    portRange: [number, number];
  };
  models: Record<string, string>;
  /** 0.4.177 — per-model max_tokens ceiling used as the proxy fallback when
   *  a client omits max_tokens. Keys mirror `models` aliases; `default`
   *  covers anything not listed. */
  modelMaxTokens: Record<string, number>;
  /** Renesas Playground HTTP endpoints — moved out of container.yaml in
   *  0.4.2 so the user can swap base URLs without rebuilding the image. */
  endpoints: {
    apiChat?:        string;
    openaiChat?:     string;
    nativeMessages?: string;
    responsesApi?:   string;
  };
  /** First-compatible routing priority per provider family. */
  routing: {
    claude?:        string[];
    gpt?:           string[];
    gptReasoning?:  string[];
  };
  /** Models forced through the /openai/responses path (Path B). */
  responsesApi: {
    models:        string[];
    defaultEffort: string;
  };
  mcp: {
    mineruLocalPath:        string;
    mineruPortMode?:       'auto' | 'manual' | '';
    mineruPort?:            number;
    mineruControlPort?:     number;
    mineruControlHost?:     string;
    mineruHost?:            string;
    mineruPath?:            string;
    mineruSshUser?:         string;
    excalidrawPortMode?:   'auto' | 'manual' | '';
    excalidrawPortRange?:   [number, number];
    excalidrawPort?:        number;
    excalidrawHost?:        string;
  };
  /** Image cache retention. Transport is HTTP-only since 0.4.2. */
  image: {
    ttlHours:  number;
    maxFiles:  number;
    maxMb:     number;
  };
  mounts: {
    home:  boolean;
    data:  boolean;
    extra: string[];
  };
  /** Memory namespace string the extension uses when persisting
   *  observations. The worker derives `observations.project` from the
   *  basename of the cwd we hand it on every Stop hook, so this is the
   *  project tag that ends up in the DB. */
  claudeMem: {
    namespace: string;
    path?: string;
  };
  /** 0.4.197 — chat model dropdown source-of-truth. Frontend fetches via
   *  RPC `config.uiModels`. HistoryPruner reads `context` for the
   *  compact-trigger threshold. Empty when the block is missing (older
   *  host.yaml files), in which case callers fall back to legacy hardcoded
   *  constants for backward compatibility. */
  uiModels: Array<{
    id:         string;
    label:      string;
    family:     string;
    context:    number;
    maxOutput:  number;
    default?:   boolean;
  }>;
}

export class PresetManager extends EventEmitter {
  private data?: PresetData;

  constructor(
    /** Absolute path to host.yaml. */
    public readonly file: string,
    private readonly log: Logger,
  ) { super(); }

  /** 0.4.235 — synchronous cached data accessor. Returns undefined if load()
   *  has never been called. Callers that need guaranteed data should await
   *  load() first; this getter is for sync paths like tool-registration
   *  where a "not yet loaded" state means "feature off for this turn". */
  get cachedData(): PresetData | undefined { return this.data; }

  async load(force = false): Promise<PresetData> {
    if (this.data && !force) return this.data;
    let raw = '';
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch { raw = DEFAULT_PRESET_YAML; }
    this.data = parsePreset(raw);
    return this.data;
  }

  /** Sandbox port chosen by the same hash logic as toComposeEnv() — used
   *  by the chat tool runner to talk to /exec without re-deriving the env.
   *  Returns 0 if the preset hasn't loaded yet or has invalid bounds. */
  async getSandboxPort(): Promise<number> {
    const d = await this.load();
    if (d.proxy.portMode === 'manual') return d.proxy.port + 400;
    return hashUsernameToPort(8800, 8899);
  }

  /** Developer-Mode sandbox port — own band (8900–8999) so it never
   *  collides with the normal sandbox (8800–8899). Same hash logic. */
  async getSandboxDevPort(): Promise<number> {
    const d = await this.load();
    if (d.proxy.portMode === 'manual') return d.proxy.port + 500;
    return hashUsernameToPort(8900, 8999);
  }

  /** Extension-wide memory namespace (host.yaml `claude_mem.namespace`).
   *  Read by ClaudeMemPlugin to scope `observations.project` in the DB. */
  async getClaudeMemNamespace(): Promise<string> {
    const d = await this.load();
    return d.claudeMem?.namespace || 'aether';
  }

  async readRaw(): Promise<string> {
    try { return await fs.readFile(this.file, 'utf8'); }
    catch { return DEFAULT_PRESET_YAML; }
  }

  async writeRaw(text: string) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, text, 'utf8');
    this.data = parsePreset(text);
    this.emit('changed', this.data);
    this.log.info(`[preset] wrote ${this.file}`);
  }

  /**
   * Write a docker-compose.override.yml next to the bundled compose file
   * with extra volume mounts derived from `host.yaml`. Mirrors the
   * generator in `cli/linux/run.sh` so extension and CLI behave the same:
   *   • mounts.home: true   → ${HOME}:${HOME}
   *   • mounts.data: true   → /data:/data
   *   • mounts.extra: [...] → each entry, defaulting `path` → `path:path`
   *   • mcp.mineru_local_path → mounts the MinerU dir at the same host
   *     path so MINERU_VENV_PYTHON resolves to the same venv inside.
   *
   * The override is rewritten on every call so changes to host.yaml take
   * effect on the next `compose up -d`. ContainerLifecycle.dc() picks
   * the file up automatically when present.
   *
   * @param composeDir Directory holding docker-compose.yml; the override
   *                   is written next to it.
   * @returns The list of volume strings actually added (for logging).
   */
  async generateMountOverride(composeDir: string): Promise<string[]> {
    const d = await this.load();
    const home = os.homedir();
    const volumes: string[] = [];

    if (d.mounts.home) volumes.push(`${home}:${home}`);
    if (d.mounts.data) volumes.push(`/data:/data`);
    for (const raw of d.mounts.extra ?? []) {
      const p = raw.trim();
      if (!p) continue;
      volumes.push(p.includes(':') ? p : `${p}:${p}`);
    }
    const readonlyVolume = (v: string) => {
      const parts = v.split(':');
      if (parts.length >= 2) return `${parts[0]}:${parts[1]}:ro`;
      return `${v}:ro`;
    };
    // MinerU LOCAL — mount the source tree at the same host path so the
    // configured MINERU_VENV_PYTHON path resolves identically inside the
    // container. Skip if path is empty (REMOTE-only setup) or doesn't
    // exist on the host (mistyped config — fail loud later, not silent).
    const mineru = d.mcp.mineruLocalPath?.trim();
    if (mineru) {
      try {
        await fs.access(mineru);
        if (!volumes.some(v => v.startsWith(`${mineru}:`))) {
          volumes.push(`${mineru}:${mineru}`);
        }
      } catch {
        this.log.warn(`[preset] mineru_local_path "${mineru}" does not exist on host — skipping mount`);
      }
    }

    const overrideFile = path.join(composeDir, 'docker-compose.override.yml');
    if (!volumes.length) {
      // Nothing to mount — remove any stale override so docker-compose
      // doesn't keep applying yesterday's config.
      try { await fs.unlink(overrideFile); }
      catch { /* file didn't exist — fine */ }
      return [];
    }
    // Service name in the base compose is `proxy`; we extend the same
    // service to add volumes. Quote each path so spaces in $HOME don't
    // break the YAML.
    //
    // Proxy and sandbox-dev keep writable mounts. Normal sandbox sees the same
    // host paths read-only so smoke tests can inspect source without mutating it.
    const lines = ['services:', '  proxy:', '    volumes:'];
    for (const v of volumes) lines.push(`      - "${v}"`);
    lines.push('  sandbox:', '    volumes:');
    for (const v of volumes) lines.push(`      - "${readonlyVolume(v)}"`);
    lines.push('  sandbox-dev:', '    volumes:');
    for (const v of volumes) lines.push(`      - "${v}"`);
    const desired = lines.join('\n') + '\n';
    // Only rewrite when the content actually changes. Otherwise the file's
    // mtime keeps bumping and docker-compose treats every ensure() as a
    // config drift → tears down + recreates the proxy container, which is
    // exactly what was making the chat panel stuck on "connecting…".
    let current = '';
    try { current = await fs.readFile(overrideFile, 'utf8'); }
    catch { /* missing — fall through to write */ }
    if (current === desired) return volumes;
    await fs.writeFile(overrideFile, desired, 'utf8');
    this.log.info(`[preset] wrote ${overrideFile} with ${volumes.length} mount(s)`);
    return volumes;
  }

  /**
   * Translate the preset into the env vars expected by docker-compose.yml.
   * @param extra    Additional env vars to merge (last-wins).
   * @param dataRoot Pass ctx.globalStorageUri.fsPath so RENESAS_IMAGE_OUTPUT_DIR
   *                 falls back to <dataRoot>/renesas-images when the preset leaves it blank.
   */
  async toComposeEnv(
    extra: Record<string, string> = {},
    dataRoot?: string,
  ): Promise<NodeJS.ProcessEnv> {
    const d = await this.load();
    const port = d.proxy.portMode === 'manual'
      ? d.proxy.port
      : hashUsernameToPort(d.proxy.portRange[0], d.proxy.portRange[1]);

    // Sandbox port follows the proxy: same hash, different range (8800–8899).
    const sandboxPort = d.proxy.portMode === 'manual'
      ? d.proxy.port + 400
      : hashUsernameToPort(8800, 8899);

    // Developer-Mode sandbox gets its own band (8900–8999) so both sandboxes
    // can run side by side without a host-port clash.
    const sandboxDevPort = d.proxy.portMode === 'manual'
      ? d.proxy.port + 500
      : hashUsernameToPort(8900, 8999);

    // Image output dir — always /tmp/renesas-images. The previous
    // mount-transport branch was dropped in 0.4.2 (HTTP-only is enough for
    // both remote-SSH and Windows hosts; mount couldn't work on either).
    const imageOutputDir = '/tmp/renesas-images';

    // claude-mem mount: extension's proxy runs as UID 1000 inside the container,
    // so binding the host user's `~/.claude-mem` (typically 0700, owned by some
    // other UID) makes the proxy crash on startup with EACCES on logs/,
    // settings.json, etc. Default to a writable dir under the extension's
    // globalStorage instead — sharing memory with host CLI is a nice-to-have,
    // but a proxy that can't write its own logs is a hard fail.
    // Override via host.yaml `claude_mem.path` or OFFICIAL_AURA_CLAUDE_MEM_HOST
    // when a real shared dir exists.
    const claudeMemHost = d.claudeMem.path?.trim() ||
      process.env.OFFICIAL_AURA_CLAUDE_MEM_HOST ||
      (dataRoot ? path.join(dataRoot, 'claude-mem') : '');

    return {
      ...process.env,
      AURA_USER:         os.userInfo().username || 'default',
      // The proxy image's app user is built at this UID. Match it to the
      // host user so bind-mounted /home, /data, and the MinerU venv stay
      // readable inside the container. CLI does the same in run.sh.
      AURA_UID:          process.env.AURA_UID ?? String(os.userInfo().uid),
      AURA_PRESET_NAME:  d.preset.name || 'default',
      AURA_PORT:         String(port),
      AURA_PROXY_PORT:   String(port),
      AURA_SANDBOX_PORT: String(sandboxPort),
      AURA_SANDBOX_DEV_PORT: String(sandboxDevPort),
      AURA_VERSION:      process.env.AURA_VERSION ?? proxyContentVersion(),
      AURA_MODEL_MAP:    JSON.stringify(d.models),
      AURA_MODEL_MAX_TOKENS: JSON.stringify(d.modelMaxTokens),
      // Endpoints + routing + responses_api — moved out of container.yaml
      // in 0.4.2 so user can change Renesas base URL or routing priority
      // without an image rebuild. JSON shapes mirror host.yaml sections.
      AURA_ENDPOINTS:    JSON.stringify({
        api_chat:        d.endpoints.apiChat        ?? undefined,
        openai_chat:     d.endpoints.openaiChat     ?? undefined,
        native_messages: d.endpoints.nativeMessages ?? undefined,
        responses_api:   d.endpoints.responsesApi   ?? undefined,
      }),
      // Proxy expects nested {provider: {priority: [...]}} shape. Sending
      // bare lists triggers AttributeError on _ROUTING.get(provider).get("priority")
      // → /v1/messages 500 on every chat turn.
      AURA_ROUTING:      JSON.stringify({
        claude:        d.routing.claude        ? { priority: d.routing.claude }        : undefined,
        gpt:           d.routing.gpt           ? { priority: d.routing.gpt }           : undefined,
        gpt_reasoning: d.routing.gptReasoning  ? { priority: d.routing.gptReasoning }  : undefined,
      }),
      AURA_RESPONSES_API: JSON.stringify({
        models:         d.responsesApi.models,
        default_effort: d.responsesApi.defaultEffort,
      }),
      // Sandbox host mounts — by default expose /data and $HOME.
      AURA_HOST_DATA:   process.env.AURA_HOST_DATA ?? '/data',
      AURA_HOST_HOME:   process.env.AURA_HOST_HOME ?? os.homedir(),
      AURA_DEFAULT_CWD: process.env.AURA_DEFAULT_CWD ?? os.homedir(),
      RENESAS_IMAGE_OUTPUT_DIR:        imageOutputDir,
      OFFICIAL_AURA_CLAUDE_MEM_HOST:   claudeMemHost,
      // Image cache retention — HTTP-only transport since 0.4.2.
      AURA_IMAGE_TRANSPORT:           'http',
      AURA_IMAGE_TTL_HOURS:           String(d.image.ttlHours),
      AURA_IMAGE_MAX_FILES:           String(d.image.maxFiles),
      AURA_IMAGE_MAX_MB:              String(d.image.maxMb),
      MINERU_VENV_PYTHON:        d.mcp.mineruLocalPath
        ? path.join(d.mcp.mineruLocalPath, '.venv/bin/python')
        : '',
      MINERU_API_URL:            d.mcp.mineruHost && d.mcp.mineruPort
        ? `http://${d.mcp.mineruHost}:${d.mcp.mineruPort}`
        : '',
      ...PresetManager._buildExcalidrawEnv(d.mcp),
      ...extra,
    };
  }
  static _buildExcalidrawEnv(mcp: PresetData['mcp']): Record<string, string> {
    const mode  = mcp.excalidrawPortMode || 'auto';
    const range = mcp.excalidrawPortRange ?? [3001, 3099];
    let port: number;
    if (mode === 'manual') {
      port = mcp.excalidrawPort ?? 3001;
      // manual: warn but proceed even if port taken by another user
    } else {
      port = hashUsernameToPort(range[0], range[1]);
      // auto: if port is taken by another user, scan forward for a free one
      if (_isPortTakenByOther(port)) {
        let found = false;
        for (let p = range[0]; p <= range[1]; p++) {
          if (!_isPortTakenByOther(p)) { port = p; found = true; break; }
        }
        if (!found) { return {}; } // no free port in range
      }
    }
    let host = mcp.excalidrawHost || '';
    if (!host || host === 'host.docker.internal' || host === 'localhost' || host === '127.0.0.1') {
      host = _resolveHostIp();
    }
    if (!host) { return {}; }
    return {
      EXCALIDRAW_PORT:       String(port),
      EXCALIDRAW_SERVER_URL: `http://${host}:${port}`,
    };
  }
}

/* ───────────────────────── excalidraw env ─────────────────── */

function _resolveHostIp(): string {
  try {
    const out = execSync('ip route get 8.8.8.8', { timeout: 2000 }).toString();
    const m = out.match(/src\s+(\S+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}

/** True if port has a pidfile owned by a DIFFERENT user (or no pidfile but TCP is open). */
function _isPortTakenByOther(port: number): boolean {
  const { existsSync, readFileSync } = require('fs');
  const pidFile = `/tmp/excalidraw-${port}.pid`;
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      process.kill(pid, 0); // alive?
      const uid = process.getuid?.() ?? -1;
      if (uid !== -1) {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const m = status.match(/^Uid:\s+(\d+)/m);
        if (m && parseInt(m[1], 10) === uid) { return false; } // ours
      }
      return true; // alive but owned by someone else
    } catch { /* dead — port is free */ }
  }
  return false; // no pidfile = not taken by another excalidraw user
}

function _hashCwdToPort(cwd: string, start: number, end: number): number {
  const sum = [...cwd].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return start + (sum % (end - start + 1));
}

/* ───────────────────────── parser ────────────────────────── */

export function parsePreset(text: string): PresetData {
  const data: PresetData = {
    preset: { name: '', description: '' },
    proxy:  { portMode: 'auto', port: 8004, portRange: [8100, 8200] },
    models: {},
    modelMaxTokens: {},
    endpoints:    {},
    routing:      {},
    responsesApi: { models: [], defaultEffort: 'low' },
    mcp:    { mineruLocalPath: '' },
    image:  { ttlHours: 24, maxFiles: 200, maxMb: 500 },
    mounts: { home: true, data: true, extra: [] },
    claudeMem: { namespace: 'aether' },
    uiModels: [],
  };

  const lines = text.split('\n');
  type Section = 'preset'|'proxy'|'models'|'model_max_tokens'|'ui_models'|'endpoints'|'routing'|'responses_api'|'mcp'|'image'|'mounts'|'claude_mem';
  let section: Section | null = null;
  // Sub-state used for routing (nested arrays per provider) and mounts.extra.
  let routingSub: 'claude' | 'gpt' | 'gpt_reasoning' | null = null;
  let inExtra = false;
  let inResponsesModels = false;

  const sectionKeys = ['preset', 'proxy', 'models', 'model_max_tokens', 'ui_models', 'endpoints', 'routing', 'responses_api', 'mcp', 'image', 'mounts', 'claude_mem'] as const;
  for (const lineRaw of lines) {
    const line = lineRaw.replace(/\s+#.*$/, '').replace(/^﻿/, '');
    if (!line.trim()) { inExtra = false; inResponsesModels = false; continue; }

    if (/^[A-Za-z_][\w-]*:/.test(line)) {
      const key = line.split(':')[0].trim();
      section = (sectionKeys as readonly string[]).includes(key) ? (key as Section) : null;
      routingSub = null; inExtra = false; inResponsesModels = false;
      continue;
    }
    if (!section) continue;

    const indented = line.match(/^(\s+)(.*)$/);
    if (!indented) continue;
    const indent = indented[1].length;
    const body   = indented[2].trim();

    if (section === 'preset') {
      if      (body.startsWith('name:'))        data.preset.name        = readScalar(body);
      else if (body.startsWith('description:')) data.preset.description = readScalar(body);
    } else if (section === 'proxy') {
      if      (body.startsWith('port_mode:'))    data.proxy.portMode = readScalar(body) === 'manual' ? 'manual' : 'auto';
      else if (body.startsWith('port:'))         data.proxy.port      = parseInt(readScalar(body), 10) || 8004;
      else if (body.startsWith('port_range:')) {
        const arr = body.slice('port_range:'.length).trim();
        const m   = arr.match(/^\[\s*(\d+)\s*,\s*(\d+)\s*]$/);
        if (m) data.proxy.portRange = [+m[1], +m[2]];
      }
    } else if (section === 'models') {
      const m = body.match(/^"([^"]+)"\s*:\s*"([^"]+)"\s*$/) ||
                body.match(/^([A-Za-z0-9_.-]+)\s*:\s*"?([^"#\n]+?)"?\s*$/);
      if (m) data.models[m[1]] = m[2];
    } else if (section === 'model_max_tokens') {
      const m = body.match(/^"([^"]+)"\s*:\s*(\d+)\s*$/) ||
                body.match(/^([A-Za-z0-9_.-]+)\s*:\s*(\d+)\s*$/);
      if (m) data.modelMaxTokens[m[1]] = parseInt(m[2], 10);
    } else if (section === 'ui_models') {
      // Inline flow-style dict per row:
      //   - { id: "claude-opus-4-7", label: "...", family: "claude",
      //       context: 1000000, max_output: 32000, default: true }
      // Only rows starting with `- {` are consumed.
      if (body.startsWith('-') && body.includes('{')) {
        const inner = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'));
        const get = (k: string): string | undefined => {
          const rx = new RegExp(`${k}\\s*:\\s*("([^"]*)"|([^,}]+))`, 'i');
          const mm = inner.match(rx);
          if (!mm) return undefined;
          return (mm[2] ?? mm[3] ?? '').trim();
        };
        const id      = get('id');
        const label   = get('label') || id || '';
        const family  = get('family') || '';
        const context = parseInt(get('context') || '0', 10) || 0;
        const maxOut  = parseInt(get('max_output') || '0', 10) || 0;
        const isDef   = (get('default') || '').toLowerCase() === 'true';
        if (id) {
          data.uiModels.push({ id, label, family, context, maxOutput: maxOut, default: isDef || undefined });
        }
      }
    } else if (section === 'endpoints') {
      if      (body.startsWith('api_chat:'))        data.endpoints.apiChat        = readScalar(body);
      else if (body.startsWith('openai_chat:'))     data.endpoints.openaiChat     = readScalar(body);
      else if (body.startsWith('native_messages:')) data.endpoints.nativeMessages = readScalar(body);
      else if (body.startsWith('responses_api:'))   data.endpoints.responsesApi   = readScalar(body);
    } else if (section === 'routing') {
      // Two indent levels: provider name (2sp), then `priority: [...]` (4sp).
      if (indent <= 2) {
        if      (body.startsWith('claude:'))        routingSub = 'claude';
        else if (body.startsWith('gpt_reasoning:')) routingSub = 'gpt_reasoning';
        else if (body.startsWith('gpt:'))           routingSub = 'gpt';
        else                                        routingSub = null;
      } else if (routingSub && body.startsWith('priority:')) {
        const arr = body.slice('priority:'.length).trim();
        const m = arr.match(/^\[(.*)]$/);
        if (m) {
          const list = m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
          if (routingSub === 'claude')             data.routing.claude       = list;
          else if (routingSub === 'gpt')           data.routing.gpt          = list;
          else if (routingSub === 'gpt_reasoning') data.routing.gptReasoning = list;
        }
      }
    } else if (section === 'responses_api') {
      if (body.startsWith('models:'))          inResponsesModels = true;
      else if (inResponsesModels && body.startsWith('-')) {
        data.responsesApi.models.push(body.slice(1).trim().replace(/^["']|["']$/g, ''));
      } else if (body.startsWith('default_effort:')) {
        inResponsesModels = false;
        data.responsesApi.defaultEffort = readScalar(body);
      }
    } else if (section === 'mcp') {
      if      (body.startsWith('mineru_local_path:'))    data.mcp.mineruLocalPath    = readScalar(body);
      else if (body.startsWith('mineru_port_mode:'))     data.mcp.mineruPortMode     = readScalar(body) as any;
      else if (body.startsWith('mineru_port:'))          data.mcp.mineruPort         = parseInt(readScalar(body), 10) || undefined;
      else if (body.startsWith('mineru_control_port:'))  data.mcp.mineruControlPort  = parseInt(readScalar(body), 10) || undefined;
      else if (body.startsWith('mineru_control_host:'))  data.mcp.mineruControlHost  = readScalar(body);
      else if (body.startsWith('mineru_host:'))          data.mcp.mineruHost         = readScalar(body);
      else if (body.startsWith('mineru_path:'))          data.mcp.mineruPath         = readScalar(body);
      else if (body.startsWith('mineru_ssh_user:'))           data.mcp.mineruSshUser          = readScalar(body);
      else if (body.startsWith('excalidraw_port_mode:'))      data.mcp.excalidrawPortMode     = readScalar(body) as any;
      else if (body.startsWith('excalidraw_port_range:')) {
        const m = readScalar(body).match(/(\d+)[^\d]+(\d+)/);
        if (m) { data.mcp.excalidrawPortRange = [parseInt(m[1], 10), parseInt(m[2], 10)]; }
      }
      else if (body.startsWith('excalidraw_port:'))           data.mcp.excalidrawPort         = parseInt(readScalar(body), 10) || undefined;
      else if (body.startsWith('excalidraw_host:'))           data.mcp.excalidrawHost         = readScalar(body);
    } else if (section === 'image') {
      if      (body.startsWith('ttl_hours:')) data.image.ttlHours = parseInt(readScalar(body), 10) || 24;
      else if (body.startsWith('max_files:')) data.image.maxFiles = parseInt(readScalar(body), 10) || 200;
      else if (body.startsWith('max_mb:'))    data.image.maxMb    = parseInt(readScalar(body), 10) || 500;
    } else if (section === 'mounts') {
      if      (body.startsWith('home:'))  data.mounts.home = readScalar(body) === 'true';
      else if (body.startsWith('data:'))  data.mounts.data = readScalar(body) === 'true';
      else if (body.startsWith('extra:')) inExtra = true;
      else if (inExtra && body.startsWith('-')) data.mounts.extra.push(
        body.slice(1).trim().replace(/^["']|["']$/g, ''),
      );
    } else if (section === 'claude_mem') {
      if (body.startsWith('namespace:')) {
        const v = readScalar(body);
        if (v) data.claudeMem.namespace = v;
      } else if (body.startsWith('path:')) {
        const v = readScalar(body);
        if (v) data.claudeMem.path = v;
      }
    }
  }
  return data;
}

function readScalar(body: string): string {
  const idx = body.indexOf(':');
  if (idx < 0) return '';
  return body.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
}

function hashUsernameToPort(start: number, end: number): number {
  const u = (os.userInfo().username || 'default');
  let h = 0; for (const c of u) h = (h * 31 + c.charCodeAt(0)) % 100003;
  const span = Math.max(1, end - start + 1);
  return start + (h % span);
}

export const DEFAULT_PRESET_YAML = `# host.yaml — Aether host preset.
#
# There is no bundled default model provider — connect one from the chat
# UI's Settings panel (Connect provider), which talks to the proxy's
# /admin/provider endpoint at runtime. Nothing here configures a provider.

# ===== PRESET IDENTITY =====
preset:
  name: default
  description: "Default — \\$HOME + /data mounted"

# ===== PROXY PORT =====
# Only used to derive the (optional) sandbox ports below — the proxy itself
# now runs as a local process and picks its own port automatically.
proxy:
  port_mode: auto       # auto = hash(\\$USER) → port in port_range | manual = use port below
  port: 8004
  port_range: [8100, 8200]

# ===== MODEL MAPPING =====
# Populated live by Settings → Connect provider (POST /admin/provider auto-
# discovers the upstream's model list). No bundled defaults.
models: {}

# ===== THINKING (extended reasoning — Claude only) =====
thinking:
  default_enabled: false
  default_effort:  medium

# ===== IMAGE CACHE (HTTP-only since 0.4.2) =====
image:
  ttl_hours: 24
  max_files: 200
  max_mb:    500

# ===== MCP SERVICES =====
mcp:
  mineru_local_path: ""
  mineru_control_port: 8938
  mineru_control_host: ""

# ===== CONTAINER MOUNTS =====
mounts:
  home: true
  data: true
  extra: []

# ===== CLAUDE-MEM =====
# namespace: project tag for extension chat observations.
# path: optional host directory mounted as /mnt/claude-mem.
# Empty/missing = <globalStorage>/claude-mem.
claude_mem:
  namespace: "aether"
  # path: ""
`;
