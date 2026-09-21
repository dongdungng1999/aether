import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../utils/logger';
import * as pty from 'node-pty';

type ExecResult = { stdout: string; stderr: string };

export interface TerminalTarget {
  session: string;
  window?: number;
  pane?: number;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const KEY_ALLOW = new Set(['C-c', 'Escape', 'Enter', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Backspace']);

export class TerminalRegistry {
  private ptys = new Map<string, { proc: pty.IPty; target: TerminalTarget; viewerSession?: string; dispose?: () => void; ownsProcess?: boolean; created?: number; cwd?: string; buffer?: string }>();
  /** Hard cap so a reconnect storm can never spawn unbounded tmux viewers. */
  private static readonly MAX_VIEWERS = 8;
  private lastOrphanSweep = 0;

  constructor(private readonly defaultCwd: string, private readonly log: Logger) {
    // Self-heal on activate: a previous crashed/reloaded session may have left
    // orphan aura_view_* tmux sessions behind. Fire-and-forget.
    this.sweepOrphanViewers().catch(() => {});
  }

  /** Kill stale `aura_view_*` tmux sessions not backed by a live viewer.
   *  Throttled to once / 5s so it can be called freely on each open. */
  private async sweepOrphanViewers() {
    const now = Date.now();
    if (now - this.lastOrphanSweep < 5000) return;
    this.lastOrphanSweep = now;
    const r = await this.execTmux(['list-sessions', '-F', '#{session_name}']).catch(() => ({ stdout: '', stderr: '' }));
    const alive = new Set([...this.ptys.values()].map(v => v.viewerSession).filter(Boolean));
    for (const name of r.stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
      if (!/^aura_view_/i.test(name) || alive.has(name)) continue;
      await this.execTmux(['kill-session', '-t', name]).catch(() => {});
      this.log.info(`[terminal] swept orphan viewer ${name}`);
    }
  }

  /** Best-effort teardown of every owned proc + viewer. Call on deactivate. */
  disposeAll() {
    for (const [id, item] of this.ptys) {
      try { item.dispose?.(); } catch {}
      if (item.ownsProcess !== false) { try { item.proc.kill(); } catch {} }
      if (item.viewerSession) this.execTmux(['kill-session', '-t', item.viewerSession]).catch(() => {});
      this.ptys.delete(id);
    }
  }

  private execTmux(args: string[], timeout = 8000): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile('tmux', args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error((stderr || error.message || 'tmux failed').trim()));
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
      child.on('error', reject);
    });
  }

  private assertName(name: string): string {
    const n = String(name || '').trim();
    if (!NAME_RE.test(n)) throw new Error('invalid tmux session name');
    return n;
  }

  private targetString(target: TerminalTarget): string {
    const session = this.assertName(target.session);
    const win = Number.isFinite(Number(target.window)) ? Math.max(0, Math.floor(Number(target.window))) : 0;
    const pane = Number.isFinite(Number(target.pane)) ? Math.max(0, Math.floor(Number(target.pane))) : 0;
    return `${session}:${win}.${pane}`;
  }

  async status() {
    try {
      const r = await this.execTmux(['-V']);
      return { ok: true, version: r.stdout.trim() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async list() {
    const sessionsRaw = await this.execTmux(['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_created}']).catch(() => ({ stdout: '', stderr: '' }));
    const sessions = [] as any[];
    for (const [id, item] of this.ptys.entries()) {
      if (!/^aura-term-/i.test(id)) continue;
      sessions.push({
        name: id,
        attached: 1,
        created: item.created || 0,
        windows: [{ index: 0, name: 'bash', active: true, panes: [{ index: 0, active: true, currentCommand: 'bash', currentPath: item.cwd || this.defaultCwd, title: path.basename(item.cwd || this.defaultCwd) || id, target: item.target }] }],
      });
    }
    for (const line of sessionsRaw.stdout.split('\n').filter(Boolean)) {
      const [name, attached, created] = line.split('\t');
      if (/^aura_view_/i.test(name)) continue;
      const windowsRaw = await this.execTmux(['list-windows', '-t', name, '-F', '#{window_index}\t#{window_name}\t#{window_active}']).catch(() => ({ stdout: '', stderr: '' }));
      const windows = [] as any[];
      for (const wline of windowsRaw.stdout.split('\n').filter(Boolean)) {
        const [index, wname, active] = wline.split('\t');
        const panesRaw = await this.execTmux(['list-panes', '-t', `${name}:${index}`, '-F', '#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}']).catch(() => ({ stdout: '', stderr: '' }));
        const panes = panesRaw.stdout.split('\n').filter(Boolean).map(pline => {
          const [pindex, pactive, cmd, cwd, title] = pline.split('\t');
          return { index: Number(pindex), active: pactive === '1', currentCommand: cmd, currentPath: cwd, title, target: { session: name, window: Number(index), pane: Number(pindex) } };
        });
        windows.push({ index: Number(index), name: wname, active: active === '1', panes });
      }
      sessions.push({ name, attached: Number(attached || 0), created: Number(created || 0), windows });
    }
    return { ok: true, sessions };
  }

  async create(input: { name?: string; cwd?: string; command?: string }) {
    const name = this.assertName(input.name || `aura-term-${Date.now().toString(36)}`);
    let cwd = String(input.cwd || this.defaultCwd || process.cwd());
    try {
      const st = await fs.stat(cwd);
      if (!st.isDirectory()) cwd = this.defaultCwd;
    } catch { cwd = this.defaultCwd; }
    const shell = String(input.command || '/bin/bash').trim();
    const proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 34,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const target = { session: name, window: 0, pane: 0 };
    let buffer = '';
    proc.onData(data => {
      buffer = (buffer + String(data || '')).slice(-200000);
      const item = this.ptys.get(name);
      if (item) item.buffer = buffer;
    });
    proc.onExit(() => {
      this.ptys.delete(name);
      for (const [id, item] of this.ptys.entries()) {
        if (item.target.session === name) this.ptys.delete(id);
      }
    });
    this.ptys.set(name, { proc, target, ownsProcess: true, created: Math.floor(Date.now() / 1000), cwd });
    return { ok: true, target };
  }

  async capture(target: TerminalTarget, lines?: number) {
    const n = Math.max(100, Math.min(100000, Math.floor(Number(lines) || 2000)));
    const r = await this.execTmux(['capture-pane', '-p', '-e', '-J', '-S', `-${n}`, '-t', this.targetString(target)], 10000);
    return { ok: true, data: r.stdout, target, lines: n, ts: Date.now() };
  }

  async input(target: TerminalTarget, text: string, enter = false) {
    const chunks = String(text || '').split('\n');
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i]) await this.execTmux(['send-keys', '-t', this.targetString(target), '--', chunks[i]]);
      if (i < chunks.length - 1) await this.execTmux(['send-keys', '-t', this.targetString(target), 'Enter']);
    }
    if (enter) await this.execTmux(['send-keys', '-t', this.targetString(target), 'Enter']);
    return { ok: true };
  }

  async keys(target: TerminalTarget, keys: string[]) {
    const safe = (Array.isArray(keys) ? keys : []).map(String).filter(k => KEY_ALLOW.has(k));
    if (!safe.length) return { ok: true };
    await this.execTmux(['send-keys', '-t', this.targetString(target), ...safe]);
    return { ok: true };
  }

  async resize(target: TerminalTarget, cols: number, rows: number) {
    const c = Math.max(40, Math.min(300, Math.floor(Number(cols) || 120)));
    const r = Math.max(10, Math.min(120, Math.floor(Number(rows) || 40)));
    await this.execTmux(['resize-pane', '-t', this.targetString(target), '-x', String(c), '-y', String(r)]).catch(() => null);
    return { ok: true, cols: c, rows: r };
  }

  async kill(target: TerminalTarget, scope: 'session' | 'window' | 'pane' = 'pane') {
    const t = this.targetString(target);
    if (scope === 'session' && /^aura-term-/i.test(target.session)) {
      const item = this.ptys.get(target.session);
      try { item?.dispose?.(); } catch {}
      try { item?.proc.kill(); } catch {}
      this.ptys.delete(target.session);
    }
    else if (scope === 'session') await this.execTmux(['kill-session', '-t', target.session]);
    else if (scope === 'window') await this.execTmux(['kill-window', '-t', `${target.session}:${Number(target.window) || 0}`]);
    else await this.execTmux(['kill-pane', '-t', t]);
    return { ok: true };
  }

  async openPty(id: string, target: TerminalTarget, onData: (data: string) => void, onExit: (code?: number) => void, cols = 120, rows = 34) {
    const session = this.assertName(target.session);
    this.closePty(id);
    const c = Math.max(40, Math.min(300, Math.floor(cols || 120)));
    const r = Math.max(10, Math.min(120, Math.floor(rows || 34)));

    if (/^aura-term-/i.test(session)) {
      const item = this.ptys.get(session);
      if (!item) throw new Error('terminal session is not attached');
      item.proc.resize(c, r);
      const disposable = item.proc.onData(onData);
      try { item.proc.resize(c, r); } catch {}
      this.ptys.set(id, { proc: item.proc, target: item.target, dispose: () => disposable.dispose(), ownsProcess: false, created: item.created, cwd: item.cwd, buffer: item.buffer });
      return { ok: true, id, target: item.target };
    }

    // Terminal service stream path: each client gets its own raw tmux attach PTY.
    // Do not share attach processes and do not inject capture-pane text into xterm;
    // xterm must receive only the raw terminal stream for scroll/cursor state to
    // stay aligned like VS Code's terminal.
    await this.sweepOrphanViewers().catch(() => {});
    const proc = pty.spawn('tmux', ['attach-session', '-t', session], {
      name: 'xterm-256color',
      cols: c,
      rows: r,
      cwd: this.defaultCwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const disposable = proc.onData(onData);
    proc.onExit(e => {
      this.ptys.delete(id);
      onExit(e.exitCode);
    });
    this.log.info(`[terminal] stream open id=${id} session=${session}`);
    this.ptys.set(id, { proc, target, dispose: () => { try { disposable.dispose(); } catch {} }, ownsProcess: true, created: Math.floor(Date.now() / 1000) });
    return { ok: true, id, target };
  }

  writePty(id: string, data: string) {
    const item = this.ptys.get(id);
    if (!item) throw new Error('terminal session is not attached');
    item.proc.write(String(data || ''));
    return { ok: true };
  }

  resizePty(id: string, cols: number, rows: number) {
    const item = this.ptys.get(id);
    // A resize for a PTY that isn't attached yet (open RPC still in flight)
    // or already closed is a harmless no-op — don't throw/log a WARN for it.
    if (!item) return { ok: false, pending: true };
    try {
      item.proc.resize(Math.max(40, Math.min(300, Math.floor(cols || 120))), Math.max(10, Math.min(120, Math.floor(rows || 34))));
    } catch { return { ok: false }; }
    return { ok: true };
  }

  closePty(id: string) {
    const item = this.ptys.get(id);
    if (!item) return { ok: true };
    try { item.dispose?.(); } catch {}
    if (item.ownsProcess !== false) {
      try { item.proc.kill(); } catch {}
      if (item.viewerSession) this.execTmux(['kill-session', '-t', item.viewerSession]).catch(() => {});
    }
    this.ptys.delete(id);
    return { ok: true };
  }
}
