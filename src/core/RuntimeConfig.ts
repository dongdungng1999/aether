/**
 * RuntimeConfig — small local JSON settings file for the few things that
 * used to live in host.yaml / the VS Code sidebar and now live in the
 * chat UI's own Settings panel instead (there is no sidebar standalone).
 *
 * Currently just the MinerU server URL (Settings → MinerU server URL).
 * Model provider connectivity is NOT stored here — that's runtime state
 * inside the proxy process, set via POST /admin/provider.
 */

import * as fs from 'fs/promises';

export interface RuntimeConfigData {
  mineruUrl: string;
}

const DEFAULTS: RuntimeConfigData = { mineruUrl: '' };

export class RuntimeConfig {
  constructor(private readonly file: string) {}

  async load(): Promise<RuntimeConfigData> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return { ...DEFAULTS, ...raw };
    } catch {
      return { ...DEFAULTS };
    }
  }

  async save(data: RuntimeConfigData): Promise<void> {
    await fs.mkdir(require('path').dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2), 'utf8');
  }
}
