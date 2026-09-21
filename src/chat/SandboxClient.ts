/**
 * SandboxClient — POST /exec to the AURA sandbox container.
 *
 * The sandbox runs as a sibling container (same compose network); it
 * speaks plain HTTP, NOT MCP. We hardcode three tools that map onto its
 * `language` field: run_bash, run_python, run_node.
 *
 * Failure surface:
 *   - HTTP error or invalid JSON → tool_result with is_error=true.
 *   - Non-zero exit_code → still returned to the model; we don't flag it
 *     as a tool error because non-zero exits are normal output the model
 *     needs to see (compile failure, test failure, etc).
 */

import * as http from 'http';
import { Logger } from '../utils/logger';
import { ToolDef } from './ChatStreamer';
import { SandboxContainerManager } from '../sandbox/SandboxContainerManager';

export const SANDBOX_TOOLS: ToolDef[] = [
  {
    name: 'sandbox__run_bash',
    description:
      'Run a bash command inside the AURA sandbox container. ' +
      'Has /data and $HOME mounted — use absolute paths. Default timeout 30s, max 300s. ' +
      'Returns stdout, stderr, exit_code and duration_ms.',
    input_schema: {
      type: 'object',
      properties: {
        code:    { type: 'string',  description: 'bash -lc <code>' },
        cwd:     { type: 'string',  description: 'Absolute working directory (optional)' },
        timeout: { type: 'integer', description: 'Seconds, max 300', minimum: 1, maximum: 300 },
      },
      required: ['code'],
    },
  },
  {
    name: 'sandbox__run_python',
    description:
      'Run a Python 3 script inside the AURA sandbox. ' +
      'numpy/pandas/matplotlib/scipy/sklearn/pillow/plotly are pre-installed. ' +
      'Use absolute paths to /data or $HOME for inputs/outputs.',
    input_schema: {
      type: 'object',
      properties: {
        code:    { type: 'string',  description: 'python -u -c <code>' },
        cwd:     { type: 'string',  description: 'Absolute working directory (optional)' },
        timeout: { type: 'integer', description: 'Seconds, max 300', minimum: 1, maximum: 300 },
      },
      required: ['code'],
    },
  },
  {
    name: 'sandbox__run_node',
    description: 'Run a Node.js 22 script inside the AURA sandbox.',
    input_schema: {
      type: 'object',
      properties: {
        code:    { type: 'string',  description: 'node -e <code>' },
        cwd:     { type: 'string',  description: 'Absolute working directory (optional)' },
        timeout: { type: 'integer', description: 'Seconds, max 300', minimum: 1, maximum: 300 },
      },
      required: ['code'],
    },
  },
];

export interface ExecResult {
  stdout:      string;
  stderr:      string;
  exit_code:   number;
  duration_ms: number;
}

export class SandboxClient {
  /** Developer-Mode routing. When true, exec/listArtifacts/fetchArtifact
   *  target the `sandbox-dev` container (root, host-writable) instead of the
   *  normal per-user sandbox. ChatPanelV2 flips this per turn from the chat's
   *  developerMode flag before dispatching tool calls. */
  private devMode = false;

  constructor(
    /** Function so we always read the live NORMAL sandbox port (PresetManager
     *  may refresh it after the user edits host.yaml). */
    private readonly port:    () => Promise<number>,
    /** Lifecycle manager for the normal sandbox — used to auto-start the
     *  container on first use. Optional so unit tests can mock. */
    private readonly sandbox: SandboxContainerManager | null,
    private readonly log:     Logger,
    /** Developer-Mode sandbox port fn + manager. Optional — when absent,
     *  developer mode falls back to the normal sandbox. */
    private readonly devPort?:    () => Promise<number>,
    private readonly sandboxDev?: SandboxContainerManager | null,
  ) {}

  /** Route subsequent calls to the dev sandbox (true) or normal (false). */
  setDevMode(on: boolean) { this.devMode = !!on; }

  /** Pick the (manager, portFn, label) for the currently-selected flavour.
   *  Falls back to the normal sandbox if dev mode is on but no dev wiring
   *  was provided (keeps unit tests + partial setups working). */
  private targetFor(developerMode: boolean): { mgr: SandboxContainerManager | null; portFn: () => Promise<number>; label: string } {
    if (developerMode && this.devPort) {
      return { mgr: this.sandboxDev ?? null, portFn: this.devPort, label: 'sandbox-dev' };
    }
    return { mgr: this.sandbox, portFn: this.port, label: 'sandbox' };
  }

  async exec(language: 'bash' | 'python' | 'node', body: {
    code: string; cwd?: string; timeout?: number;
  }, developerMode = this.devMode): Promise<ExecResult> {
    const { mgr, portFn, label } = this.targetFor(developerMode);
    // First-call bring-up: if the manager exists but the container isn't
    // ready, start it. Failures here surface as a clear error rather than
    // ECONNREFUSED, so the user can act on it.
    if (mgr && !mgr.isReady()) {
      try {
        this.log.info(`[sandbox-client] ${label} container not ready — calling ensure()`);
        await mgr.ensure();
      } catch (e) {
        const where = label === 'sandbox-dev' ? 'Sandbox (Developer)' : 'Sandbox';
        throw new Error(
          `${label} container is not running — install it via Sidebar → ${where} → Install ` +
          `(error: ${(e as Error).message})`);
      }
    }
    const port = await portFn();
    if (!port) throw new Error(`${label} port not yet known — proxy not running?`);
    const payload = JSON.stringify({
      language,
      code:    body.code,
      cwd:     body.cwd,
      timeout: body.timeout,
    });
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path:     '/exec',
        method:   'POST',
        headers: {
          'content-type':   'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => {
          const buf = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`sandbox HTTP ${res.statusCode}: ${buf.slice(0, 300)}`));
          }
          try {
            const obj = JSON.parse(buf);
            resolve(obj);
          } catch (e) {
            reject(new Error(`sandbox non-JSON: ${buf.slice(0, 300)}`));
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /** List files in /tmp/aura-artifacts/<chatId>/. Returns [] if dir empty
   *  or sandbox unreachable. (#F10b in 0.4.2) */
  async listArtifacts(chatId: string): Promise<Array<{ name: string; size: number; mtime: number }>> {
    const port = await this.targetFor(this.devMode).portFn();
    if (!port) return [];
    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: `/artifacts/${encodeURIComponent(chatId)}`,
        method: 'GET',
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve([]);
          try {
            const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(obj.files || []);
          } catch { resolve([]); }
        });
        res.on('error', () => resolve([]));
      });
      req.on('error', () => resolve([]));
      req.end();
    });
  }

  /** Fetch raw bytes of a single artifact. Throws on 404 / network error. */
  async fetchArtifact(chatId: string, name: string): Promise<Buffer> {
    const port = await this.targetFor(this.devMode).portFn();
    if (!port) throw new Error('sandbox port unknown');
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: `/artifacts/${encodeURIComponent(chatId)}/${name.split('/').map(part => encodeURIComponent(part)).join('/')}`,
        method: 'GET',
      }, res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`sandbox artifact HTTP ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** Read an arbitrary file path from inside the sandbox container. */
  async readFile(filePath: string): Promise<Buffer> {
    const code = [
      'import base64, pathlib',
      `p = pathlib.Path(${JSON.stringify(filePath)})`,
      'print(base64.b64encode(p.read_bytes()).decode("ascii"), end="")',
    ].join('\n');
    const r = await this.exec('python', { code, timeout: 30 });
    if (r.exit_code !== 0) throw new Error((r.stderr || 'sandbox file read failed').slice(0, 300));
    return Buffer.from(String(r.stdout || ''), 'base64');
  }

  /** Format an ExecResult into the text body the model sees. */
  static formatResult(r: ExecResult): string {
    const out: string[] = [];
    out.push(`exit_code: ${r.exit_code}  (${r.duration_ms} ms)`);
    if (r.stdout) out.push('--- stdout ---', truncate(r.stdout, 8000));
    if (r.stderr) out.push('--- stderr ---', truncate(r.stderr, 4000));
    if (!r.stdout && !r.stderr) out.push('(no output)');
    return out.join('\n');
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…(truncated ${s.length - max} chars)`;
}

/** Map sandbox__run_<lang> → language. */
export function sandboxLanguageOf(toolName: string): 'bash' | 'python' | 'node' | null {
  if (toolName === 'sandbox__run_bash')   return 'bash';
  if (toolName === 'sandbox__run_python') return 'python';
  if (toolName === 'sandbox__run_node')   return 'node';
  return null;
}
