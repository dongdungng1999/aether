/**
 * Paths — central path resolver for Official AURA.
 *
 * Layout in .vsix (read-only, REPLACED on every version upgrade):
 *   <extRoot>/docker/docker-compose.yml
 *   <extRoot>/docker/sandbox/...
 *   <extRoot>/configs/host.yaml               (preset shipped as default)
 *
 * Writable user data (in ctx.globalStorageUri, SURVIVES upgrades):
 *   <dataRoot>/credentials                    (mirror of RENESAS_API_KEY)
 *   <dataRoot>/env-config.json                (UI state)
 *   <dataRoot>/host.yaml                      (user-edited preset)
 *   <dataRoot>/proxy-refs.json                (multi-window refcount)
 *   <dataRoot>/renesas-images/                (image generation output, default)
 *   <dataRoot>/workspace/                     (sandbox /workspace mount)
 *   <dataRoot>/proxy.log
 *
 * On Linux/Remote SSH, activation prefers /data/<user>/aura-storage when
 * writable so multiple VS Code workspace windows share the same chat history.
 */

import * as path from 'path';
import * as os   from 'os';

export type Platform = 'linux-x64' | 'win32-x64' | 'darwin-arm64' | 'darwin-x64';

export class Paths {
  constructor(
    private readonly extRoot: string,
    /** Persistent user data root — survives version upgrades. */
    private readonly _dataRoot?: string,
  ) {}

  get platform(): Platform {
    const p = process.platform, a = process.arch;
    if (p === 'linux'  && a === 'x64')   return 'linux-x64';
    if (p === 'win32'  && a === 'x64')   return 'win32-x64';
    if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
    if (p === 'darwin' && a === 'x64')   return 'darwin-x64';
    throw new Error(`Unsupported platform: ${p}-${a}`);
  }

  /* ── Read-only assets shipped in the .vsix ──────────────────────── */
  get extensionRoot(): string  { return this.extRoot; }
  get dockerDir():     string  { return path.join(this.extRoot, 'docker'); }
  get composeFile():   string  { return path.join(this.dockerDir, 'docker-compose.yml'); }
  /** Default preset bundled with the extension — copied to <dataRoot> on first run. */
  get bundledPresetFile(): string { return path.join(this.extRoot, 'configs', 'host.yaml'); }

  /** Build contexts — both bundled inside the .vsix under docker/. */
  get proxyBuildContext():   string { return path.join(this.dockerDir, 'proxy'); }
  get sandboxBuildContext(): string { return path.join(this.dockerDir, 'sandbox'); }

  /* ── Writable per-user data (ctx.globalStorageUri) ──────────────── */
  get dataRoot():        string { return this._dataRoot ?? path.join(this.extRoot, 'data'); }
  get legacyDataRoot():  string { return path.join(this.extRoot, 'data'); }

  get credentialsFile(): string { return path.join(this.dataRoot, 'credentials'); }
  get envConfigFile():   string { return path.join(this.dataRoot, 'env-config.json'); }
  get presetFile():      string { return path.join(this.dataRoot, 'host.yaml'); }
  get logFile():         string { return path.join(this.dataRoot, 'proxy.log'); }
  get workspaceDir():    string { return path.join(this.dataRoot, 'workspace'); }

  get userHome(): string { return os.homedir(); }
}
