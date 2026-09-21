/**
 * EnvFileManager — parse the user's `.env` file and expose its keys.
 *
 * Replaces the `env-file` portion of the old McpRegistry. The extension
 * no longer installs MCPs on the host (the proxy container does), so all
 * we need from a credentials file is:
 *
 *   • a list of recognised keys → values
 *   • a fast lookup for the JWT (used by AuthManager / status bar)
 *
 * The .env format is the same one `aura.sh` already understands.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import { Logger } from '../utils/logger';

/** Whitelist of keys we recognise. We never forward unknown env vars to the
 *  proxy process — security: keeps stray host secrets out of MCP tools.
 *  Model provider credentials are NOT here — those are runtime state set
 *  via Settings → Connect provider (POST /admin/provider), never a file. */
export const ENV_KEY_WHITELIST: ReadonlyArray<string> = [
  'TAVILY_API_KEY',
  'FIRECRAWL_API_KEY',
  'JIRA_URL',
  'JIRA_PERSONAL_TOKEN',
  'CONFLUENCE_URL',
  'CONFLUENCE_PERSONAL_TOKEN',
  'GITLAB_API_URL',
  'GITLAB_PERSONAL_ACCESS_TOKEN',
  'PAPER_SEARCH_MCP_UNPAYWALL_EMAIL',
];

export type EnvKeyMap = Record<string, string>;

export class EnvFileManager extends EventEmitter {
  private keys: EnvKeyMap = {};
  private filePath?: string;

  constructor(private readonly log: Logger) { super(); }

  getPath():  string | undefined { return this.filePath; }
  getKeys():  EnvKeyMap          { return { ...this.keys }; }
  has(name: string): boolean      { return !!this.keys[name]; }
  get(name: string): string | undefined { return this.keys[name]; }

  /** Parse and cache an .env file. Emits 'changed'.
   *  @param silent - true for opportunistic/default-path attempts where a
   *  missing file is expected (e.g. fresh install, no .env configured yet)
   *  and shouldn't be logged as an error. */
  async load(filePath: string, silent = false): Promise<{ loaded: number; skipped: number }> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if (!silent) this.log.error(`[env] cannot read ${filePath}`, e);
      throw new Error(`Cannot read file: ${(e as Error).message}`);
    }

    const next: EnvKeyMap = {};
    let loaded = 0, skipped = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^([A-Z0-9_]+)\s*=\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!v || v.startsWith('your-')) { skipped++; continue; }
      if (!ENV_KEY_WHITELIST.includes(k)) continue;
      next[k] = v;
      loaded++;
    }

    this.keys     = next;
    this.filePath = filePath;
    this.log.info(`[env] loaded ${loaded} key(s) from ${filePath}`);
    this.emit('changed');
    return { loaded, skipped };
  }

  clear() {
    this.keys = {};
    this.filePath = undefined;
    this.emit('changed');
  }
}
