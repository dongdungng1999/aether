/**
 * exec — thin spawn wrapper with promise + timeout support.
 */

import { spawn, SpawnOptions } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code:   number | null;
}

export function run(cmd: string, args: string[], opts: SpawnOptions & { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child  = spawn(cmd, args, opts);
    let   stdout = '';
    let   stderr = '';

    child.stdout?.on('data', d => (stdout += d.toString()));
    child.stderr?.on('data', d => (stderr += d.toString()));
    child.once('error', reject);
    child.once('close', code => resolve({ stdout, stderr, code }));

    if (opts.timeoutMs) {
      setTimeout(() => child.kill('SIGKILL'),
                 opts.timeoutMs).unref();
    }
  });
}
