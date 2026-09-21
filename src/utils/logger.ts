/**
 * Logger — writes to the console, plus optionally appends to a log file
 * on disk. Standalone replacement for the old vscode.OutputChannel wrapper;
 * public method names are unchanged so every caller keeps compiling as-is.
 */

import * as fs from 'fs';
import * as path from 'path';

export class Logger {
  private stream?: fs.WriteStream;

  /** @param name   Log line prefix (e.g. the old OutputChannel title).
   *  @param file   Absolute path to append raw log output to. Optional —
   *                without it, Logger only writes to the console. */
  constructor(private readonly name: string, file?: string) {
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.stream = fs.createWriteStream(file, { flags: 'a' });
      } catch (e) {
        console.error(`[${name}] failed to open log file ${file}: ${(e as Error).message}`);
      }
    }
  }

  info (m: string, ...rest: unknown[]) { this.write('INFO',  m, rest); }
  warn (m: string, ...rest: unknown[]) { this.write('WARN',  m, rest); }
  error(m: string, ...rest: unknown[]) { this.write('ERROR', m, rest); }
  debug(m: string, ...rest: unknown[]) { this.write('DEBUG', m, rest); }

  private write(level: string, msg: string, rest: unknown[]) {
    const ts = new Date().toISOString();
    const tail = rest.length ? ' ' + rest.map(safeStringify).join(' ') : '';
    const line = `[${ts}] [${level}] ${msg}${tail}`;
    (level === 'ERROR' || level === 'WARN' ? console.error : console.log)(`[${this.name}] ${line}`);
    this.stream?.write(line + '\n');
  }
  /** No-op standalone — there is no UI panel to reveal. Kept so existing
   *  call sites (`log.show()`) keep compiling unchanged. */
  show() { /* no-op: no OutputChannel to focus in a standalone app */ }
  /** Append raw, unformatted bytes — use for piping subprocess output. */
  raw(text: string) {
    process.stdout.write(text);
    this.stream?.write(text);
  }
}

function safeStringify(x: unknown): string {
  if (x instanceof Error) return `${x.message}\n${x.stack ?? ''}`;
  try   { return typeof x === 'string' ? x : JSON.stringify(x); }
  catch { return String(x); }
}
