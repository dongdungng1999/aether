/**
 * ImageCache — fetch images from the proxy's /api/images endpoint and keep
 * them in globalStorage so chat can render them inline + offer download.
 *
 * Why cache instead of relying on the URL?
 *   • The proxy purges old files (TTL + LRU) so links die.
 *   • Restoring an old session needs the bytes locally — proxy may not
 *     even be running.
 *   • Webview <img> can use vscode-resource:// URIs we control, no CSP
 *     gymnastics for arbitrary http://127.0.0.1:port URLs.
 *
 * Layout:
 *   <dataRoot>/chat-images/<sessionId>/<basename>
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import { Logger } from '../utils/logger';

export interface CachedImage {
  /** Filename inside the cache dir (preserves original extension). */
  filename: string;
  /** Absolute path on the host — what the webview will load. */
  localPath: string;
  /** MIME for <img> source / VSCode showSaveDialog filter. */
  mediaType: string;
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png',  webp: 'image/webp', gif: 'image/gif',
};

export class ImageCache {
  constructor(
    /** <dataRoot>/chat-images */
    private readonly rootDir: string,
    private readonly log:     Logger,
  ) {}

  private async fetchBytes(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      http.get(url, res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  /** Download `url` (a /api/images/<file>?token=… link from the MCP) into
   *  <rootDir>/<sessionId>/<basename>, returning a CachedImage record.
   *  Idempotent: an already-cached file is returned without re-fetching. */
  async fetchAndCache(url: string, sessionId: string): Promise<CachedImage> {
    const u = new URL(url);
    const filename = path.basename(u.pathname);
    if (!filename) throw new Error(`unable to derive filename from ${url}`);

    const dir = path.join(this.rootDir, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, filename);

    try {
      await fs.access(localPath);
      this.log.info(`[image-cache] hit ${localPath}`);
    } catch {
      const bytes = await this.fetchBytes(url);
      await fs.writeFile(localPath, bytes);
      this.log.info(`[image-cache] saved ${localPath} (${bytes.length} bytes)`);
    }

    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return { filename, localPath, mediaType: EXT_MIME[ext] || 'application/octet-stream' };
  }

  /** Cache-only lookup — returns a CachedImage if `<rootDir>/<sessionId>/<filename>`
   *  already exists, otherwise null. Used on chat reload to re-broadcast
   *  images without needing the proxy (which may not be ready yet). */
  async lookupCached(filename: string, sessionId: string): Promise<CachedImage | null> {
    if (!filename) return null;
    const localPath = path.join(this.rootDir, sessionId, filename);
    try { await fs.access(localPath); } catch { return null; }
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return { filename, localPath, mediaType: EXT_MIME[ext] || 'application/octet-stream' };
  }

  /** Persist a fetched buffer to the chat-images cache. Idempotent. Used
   *  for sandbox artifacts retrieved over HTTP (#F10b in 0.4.2). */
  async cacheBytes(filename: string, bytes: Buffer, sessionId: string): Promise<CachedImage> {
    if (!filename) throw new Error('cacheBytes: filename required');
    const dir = path.join(this.rootDir, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, filename);
    try {
      const stat = await fs.stat(localPath);
      if (stat.size !== bytes.length) await fs.writeFile(localPath, bytes);
    } catch {
      await fs.writeFile(localPath, bytes);
      this.log.info(`[image-cache] cached sandbox artifact ${localPath} (${bytes.length} bytes)`);
    }
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return { filename, localPath, mediaType: EXT_MIME[ext] || 'application/octet-stream' };
  }

  /** Copy a host-mounted artifact (e.g. ${HOME}/aura-artifacts/foo.png)
   *  into the chat-images cache and return a CachedImage. Idempotent. */
  async cacheLocalFile(absPath: string, sessionId: string): Promise<CachedImage> {
    const filename = path.basename(absPath);
    if (!filename) throw new Error(`unable to derive filename from ${absPath}`);
    const dir = path.join(this.rootDir, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, filename);
    try {
      await fs.access(localPath);
    } catch {
      const bytes = await fs.readFile(absPath);
      await fs.writeFile(localPath, bytes);
      this.log.info(`[image-cache] copied ${absPath} → ${localPath} (${bytes.length} bytes)`);
    }
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return { filename, localPath, mediaType: EXT_MIME[ext] || 'application/octet-stream' };
  }

}

/** Pull every /api/images/<file> URL out of an arbitrary text blob. The
 *  MCP renders these on a line by themselves, so a global regex captures
 *  them without needing to parse the whole tool result. */
export function extractImageUrls(text: string, baseUrl: string): string[] {
  // Match the proxy's prefix exactly so we don't pick up unrelated http URLs.
  const escaped = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}/api/images/[\\w.-]+(?:\\?token=[a-f0-9]+)?`, 'g');
  return Array.from(new Set(text.match(re) || []));
}

/** Proxy-port-agnostic filename extractor used at reload time. Matches any
 *  http://host:port/api/images/<filename>(?token=…) — we only care about the
 *  filename because the cache key is sessionId+filename. Independent from
 *  the proxy lifecycle so reload can re-broadcast cached images even before
 *  the proxy container is back up (#F10a regression hunt). */
export function extractImageFilenames(text: string): string[] {
  const re = /\/api\/images\/([\w.-]+)(?:\?[^\s)\]>"']*)?/g;
  const set = new Set<string>();
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) set.add(m[1]);
  }
  return Array.from(set);
}

/** Pull every /home/aura-artifacts/<file> path out of a text blob. These
 *  appear in sandbox tool results when the model follows the
 *  "save artifacts here" instruction. We translate /home/... back to the
 *  host ${HOME}/... since the sandbox bind-mounts $HOME → /home.
 *  Returns absolute host paths; caller still needs to verify the file
 *  exists before broadcasting. */
const ARTIFACT_RE = /\/home\/aura-artifacts\/[\w./-]+\.(?:png|jpg|jpeg|webp|gif|svg)/gi;
export function extractArtifactPaths(text: string, hostHome: string): string[] {
  const matches = text.match(ARTIFACT_RE) || [];
  const set = new Set<string>();
  for (const m of matches) {
    // /home/aura-artifacts/foo.png  →  <hostHome>/aura-artifacts/foo.png
    set.add(m.replace(/^\/home/, hostHome.replace(/\/$/, '')));
  }
  return Array.from(set);
}

/** Pull /tmp/aura-artifacts/<chatId>/<file> paths from a text blob. These
 *  live INSIDE the sandbox container (no host bind-mount); the caller
 *  must fetch them via SandboxClient.fetchArtifact(). Returns the raw
 *  filename only — the chatId is the same as the active session, so the
 *  caller already has it. (#F10b in 0.4.2) */
const SANDBOX_ARTIFACT_RE = /\/tmp\/aura-artifacts\/[\w.-]{1,64}\/([\w.-]+\.(?:png|jpg|jpeg|webp|gif|svg|pdf|docx|xlsx|pptx|csv|json|txt|md))/gi;
export function extractSandboxArtifactNames(text: string): string[] {
  const set = new Set<string>();
  const re = new RegExp(SANDBOX_ARTIFACT_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) set.add(m[1]);
  }
  return Array.from(set);
}
