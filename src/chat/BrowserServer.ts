import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from '../utils/logger';
import { ChatPanelV2 } from './ChatPanelV2';

/** Minimal local stand-in for the vscode.Disposable contract. */
export interface Disposable { dispose(): void; }

const HOST = process.env.AETHER_HOST || '127.0.0.1';
const FIXED_PORT = process.env.AETHER_PORT ? parseInt(process.env.AETHER_PORT, 10) : 0;
const PORT_START = 8500;
const PORT_END = 8599;

export class BrowserServer implements Disposable {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private port = 0;
  private panel?: ChatPanelV2;
  private readonly sinks = new Map<string, (envelope: any) => void>();

  constructor(
    private readonly mediaDir: string,
    private readonly dataRoot: string,
    private readonly extensionPath: string,
    private readonly log: Logger,
  ) {}

  async start(panel: ChatPanelV2): Promise<number> {
    this.bindPanel(panel);
    if (this.server?.listening && this.port) return this.port;

    this.server = http.createServer((req, res) => this.handleHttp(req, res).catch(e => {
      this.log.warn(`[browser] request failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      // No same-origin check here on purpose: once AETHER_HOST binds beyond
      // 127.0.0.1 the app is reached through a LAN IP or a tunnel domain,
      // where Origin never equals a static http://HOST:port string anyway.
      // Exposure security is the user's own VPN/tunnel — see README.
      if (new URL(req.url || '/', `http://${HOST}`).pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, ws => this.attachSocket(ws));
    });

    this.port = await this.listenOnAvailablePort();
    this.log.info(`[browser] Aether browser chat listening at http://${HOST}:${this.port}`);
    return this.port;
  }

  get url(): string { return this.port ? `http://${HOST}:${this.port}` : ''; }

  dispose() { this.stop(); }

  stop() {
    try { this.wss?.close(); } catch { /* ignore */ }
    try { this.server?.close(); } catch { /* ignore */ }
    this.sinks.clear();
    this.wss = undefined;
    this.server = undefined;
    this.port = 0;
  }

  private bindPanel(panel: ChatPanelV2) {
    if (this.panel === panel) return;
    for (const id of this.sinks.keys()) this.panel?.removeBrowserSink(id);
    this.panel = panel;
    for (const [id, cb] of this.sinks) panel.addBrowserSink(id, cb);
  }

  private attachSocket(ws: WebSocket) {
    const id = crypto.randomUUID();
    const sink = (envelope: any) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(envelope));
    };
    this.sinks.set(id, sink);
    this.panel?.addBrowserSink(id, sink);
    ws.on('message', data => {
      try {
        const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        const msg = JSON.parse(raw);
        this.panel?.handleBrowserMessage(msg).catch(e =>
          this.log.warn(`[browser] message failed: ${(e as Error).message}`));
      } catch (e) {
        this.log.warn(`[browser] bad message: ${(e as Error).message}`);
      }
    });
    const detach = () => {
      this.sinks.delete(id);
      this.panel?.removeBrowserSink(id);
    };
    ws.on('close', detach);
    ws.on('error', detach);
  }

  private listenOnAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      // AETHER_PORT pins an exact port — the user chose it (e.g. a bookmark,
      // a tunnel config), so fail loud instead of silently drifting to a
      // different one. Without it, scan the default range for a free slot.
      if (FIXED_PORT) {
        const onError = (err: NodeJS.ErrnoException) => {
          this.server?.off('listening', onListening);
          reject(err.code === 'EADDRINUSE'
            ? new Error(`AETHER_PORT=${FIXED_PORT} is already in use`)
            : err);
        };
        const onListening = () => {
          this.server?.off('error', onError);
          resolve(FIXED_PORT);
        };
        this.server?.once('error', onError);
        this.server?.once('listening', onListening);
        this.server?.listen(FIXED_PORT, HOST);
        return;
      }
      const tryPort = (port: number) => {
        if (port > PORT_END) { reject(new Error(`no free browser port in ${PORT_START}-${PORT_END}`)); return; }
        const onError = (err: NodeJS.ErrnoException) => {
          this.server?.off('listening', onListening);
          if (err.code === 'EADDRINUSE' || err.code === 'EACCES') tryPort(port + 1);
          else reject(err);
        };
        const onListening = () => {
          this.server?.off('error', onError);
          resolve(port);
        };
        this.server?.once('error', onError);
        this.server?.once('listening', onListening);
        this.server?.listen(port, HOST);
      };
      tryPort(PORT_START);
    });
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url || '/', `http://${HOST}:${this.port || PORT_START}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'allow': 'GET, HEAD' });
      res.end();
      return;
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = await this.renderBrowserHtml();
      this.send(res, 200, 'text/html; charset=utf-8', Buffer.from(html, 'utf8'), req.method === 'HEAD');
      return;
    }
    if (u.pathname.startsWith('/static/')) {
      await this.serveStatic(req, res, u.pathname.slice('/static/'.length));
      return;
    }
    if (u.pathname === '/api/files') {
      await this.serveFile(req, res, u.searchParams.get('p') || '');
      return;
    }
    this.send(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not found'), req.method === 'HEAD');
  }

  private async renderBrowserHtml(): Promise<string> {
    const htmlPath = path.join(this.mediaDir, 'index.html');
    const html = await fs.readFile(htmlPath, 'utf8');
    const asUri = (rel: string) => {
      const clean = rel.split(path.sep).join('/');
      let url = `/static/${clean}`;
      try {
        const m = fsSync.statSync(path.join(this.mediaDir, rel)).mtimeMs | 0;
        url += `?v=${m}`;
      } catch { /* no cache bust */ }
      return url;
    };
    const csp = [
      `default-src 'self' data: blob:`,
      `style-src 'self' 'unsafe-inline'`,
      `script-src 'self' 'unsafe-inline' blob: https://cdn.jsdelivr.net`,
      `worker-src 'self' blob:`,
      `img-src 'self' http://127.0.0.1:* http://localhost:* https: data: blob:`,
      `font-src 'self' https: data:`,
      `frame-src 'self' data: blob: https://cdn.jsdelivr.net`,
      // 'self' alone doesn't cover ws:/wss: (different scheme from the page)
      // and we can't know the exact host:port ahead of time — it may be a
      // LAN IP or a tunnel domain, not just loopback. Allow any ws(s)
      // destination for the WebSocket connection back to this app.
      `connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:* https://cdn.jsdelivr.net`,
    ].join('; ');
    const bridge = `<script>window.__AURA_BROWSER_PORT__=${JSON.stringify(this.port)};</script>\n  <script src="${asUri('browser-bridge.js')}"></script>\n  <script src="${asUri('app.js')}"></script>`;
    return html
      .replace(/{{CSP}}/g, csp)
      .replace(/{{CSS_FONTS}}/g, asUri('fonts.css'))
      .replace(/{{CSS_BASE}}/g, asUri('app.css'))
      .replace(/{{CSS_THEMES}}/g, asUri('themes.css'))
      .replace(/{{CSS_HIGHLIGHT}}/g, asUri('vendor/highlight.css'))
      .replace(/{{CSS_KATEX}}/g, asUri('vendor/katex.min.css'))
      .replace(/{{JS_DOMPURIFY}}/g, asUri('vendor/dompurify.min.js'))
      .replace(/{{JS_KATEX}}/g, asUri('vendor/katex.min.js'))
      .replace(/<script src="{{JS_APP}}"><\/script>/g, bridge)
      .replace(/{{JS_APP}}/g, asUri('app.js'))
      .replace(/{{VENDOR_BASE}}/g, '/static/vendor/')
      .replace(/{{ICON_URL}}/g, '/static/icon-128.png');
  }

  private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse, rel: string) {
    const clean = decodeURIComponent(rel).replace(/^\/+/, '');
    const base = clean === 'icon-128.png' ? path.join(this.extensionPath, 'media') : this.mediaDir;
    const filePath = path.resolve(base, clean === 'icon-128.png' ? 'icon-128.png' : clean);
    const root = path.resolve(base);
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      this.send(res, 403, 'text/plain; charset=utf-8', Buffer.from('Forbidden'), req.method === 'HEAD');
      return;
    }
    await this.sendDiskFile(req, res, filePath);
  }

  private async serveFile(req: http.IncomingMessage, res: http.ServerResponse, requested: string) {
    const filePath = path.resolve(requested);
    if (!this.isAllowedDataPath(filePath)) {
      this.send(res, 403, 'text/plain; charset=utf-8', Buffer.from('Forbidden'), req.method === 'HEAD');
      return;
    }
    await this.sendDiskFile(req, res, filePath);
  }

  private isAllowedDataPath(filePath: string): boolean {
    const roots = ['chat-artifacts', 'chat-images', 'chat-attachments', 'excalidraw-captures']
      .map(p => path.resolve(this.dataRoot, p));
    return roots.some(root => filePath === root || filePath.startsWith(root + path.sep));
  }

  private async sendDiskFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string) {
    let buf: Buffer;
    try { buf = await fs.readFile(filePath); }
    catch { this.send(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not found'), req.method === 'HEAD'); return; }
    this.send(res, 200, this.mime(filePath), buf, req.method === 'HEAD');
  }

  private send(res: http.ServerResponse, status: number, contentType: string, body: Buffer, headOnly = false) {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    if (headOnly) res.end();
    else res.end(body);
  }

  private mime(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return map[ext] || 'application/octet-stream';
  }
}
