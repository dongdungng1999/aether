/**
 * claudeMem — resolve the host-side directory the aura proxy container
 * binds to /mnt/claude-mem.
 *
 * Extension memory is intentionally isolated from the CLI/SVCS stores by
 * default. New installs use a real directory under VS Code globalStorage:
 *   <dataRoot>/claude-mem
 *
 * host.yaml may explicitly set claude_mem.path to mount a different persistent
 * store. Do not point multiple active workers at the same SQLite DB unless that
 * sharing is intentional.
 *
 * Container UID match:
 *   Always chmod 0777 the target so the proxy can write regardless of which
 *   UID owns it on disk. Logs / settings.json get written there at boot.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger';

export const HOME_CLAUDE_MEM = path.join(os.homedir(), '.claude-mem');

/**
 * Ensure the extension-owned claude-mem directory exists.
 * Returns the host path to mount into the extension proxy container.
 *
 * Idempotent: safe to call on every container install.
 */
export async function ensureClaudeMemDir(
  dataRoot: string,
  log: Logger,
  explicitPath?: string,
): Promise<string> {
  const dir = explicitPath?.trim() || path.join(dataRoot, 'claude-mem');

  let lstat: import('fs').Stats | null = null;
  let stat: import('fs').Stats | null = null;
  try { lstat = await fs.lstat(dir); } catch { /* missing */ }
  if (lstat) {
    try { stat = await fs.stat(dir); } catch { /* broken symlink */ }
  }

  if (!lstat) {
    await fs.mkdir(dir, { recursive: true });
    log.info(`[claude-mem] created extension store ${dir}`);
  } else if (lstat.isSymbolicLink()) {
    const target = await fs.readlink(dir).catch(() => 'unknown');
    log.warn(`[claude-mem] ${dir} is a symlink to ${target}; reusing it, but new installs use an isolated extension store`);
  } else if (stat?.isDirectory()) {
    log.info(`[claude-mem] reusing extension store ${dir}`);
  } else {
    log.warn(`[claude-mem] ${dir} exists but is not a directory or symlink — proxy will fail to mount`);
  }

  try {
    await fs.chmod(dir, 0o777);
  } catch (e) {
    log.warn(`[claude-mem] chmod ${dir} failed: ${(e as Error).message}`);
  }

  try {
    const chmodIfExists = async (p: string, mode: number) => {
      try { await fs.chmod(p, mode); } catch { /* absent — ok */ }
    };
    await chmodIfExists(path.join(dir, 'settings.json'), 0o666);
    await chmodIfExists(path.join(dir, 'logs'), 0o777);
    await chmodIfExists(path.join(dir, 'claude-mem.db'), 0o666);
    await chmodIfExists(path.join(dir, 'claude-mem.db-wal'), 0o666);
    await chmodIfExists(path.join(dir, 'claude-mem.db-shm'), 0o666);
    await chmodIfExists(path.join(dir, 'chroma'), 0o777);
    await chmodIfExists(path.join(dir, 'observer-sessions'), 0o777);
    await chmodIfExists(path.join(dir, 'backups'), 0o777);
    await chmodIfExists(path.join(dir, 'corpora'), 0o777);
    try {
      const logsDir = path.join(dir, 'logs');
      const entries = await fs.readdir(logsDir);
      for (const name of entries) {
        if (name.endsWith('.log'))
          await chmodIfExists(path.join(logsDir, name), 0o666);
      }
    } catch { /* logs dir absent — ok */ }
    const unlinkIfExists = async (p: string) => {
      try { await fs.unlink(p); } catch { /* absent — ok */ }
    };
    await unlinkIfExists(path.join(dir, '.claude-mem', 'worker.pid'));
    await unlinkIfExists(path.join(dir, '.claude-mem', 'supervisor.json'));
    await unlinkIfExists(path.join(dir, 'supervisor.json'));
  } catch (e) {
    log.warn(`[claude-mem] loosen perms failed: ${(e as Error).message}`);
  }

  return dir;
}
