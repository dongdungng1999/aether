/**
 * AttachmentParser — turn a host-side file path into Markdown the model
 * can read inline.
 *
 * Three routes:
 *   1. UTF-8 text / source code  → read as-is (current behaviour).
 *   2. PDF / DOCX / PPTX / XLSX  → MinerU MCP `parse_document` returns
 *      a Markdown extraction; we feed that to the model verbatim with a
 *      header so the model knows where it came from.
 *   3. Anything else             → reject with a friendly error.
 *
 * The MinerU MCP server is mounted on the proxy at /mcp/mineru/mcp; we
 * reuse the same McpClient that ToolRegistry already drives so session
 * setup is shared.
 *
 * Pattern lifted from poc_aura_v2/extension/src/studio/AttachmentParser.ts
 * minus the venv-shelling-out fallback (we always have the proxy
 * available, so no PATH lookup needed).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { McpClient } from './McpClient';
import { Logger } from '../utils/logger';

/** Result handed back to ChatPanel.onReadFile. `markdown` is what gets
 *  inlined into the prompt; `mineru` is just a flag the webview can show
 *  in the attachment chip ("📄 parsed via MinerU"). */
export interface ParsedAttachment {
  /** Path the user attached, echoed back so the webview can match it. */
  path:     string;
  /** Final Markdown the model will see in the prompt. For text files this
   *  is the raw content; for parsed docs it's MinerU's extraction. */
  markdown: string;
  /** Images extracted by MinerU that are referenced from markdown. */
  images?: Array<{ name: string; mediaType: string; data: string }>;
  /** Bytes inspected (raw file size for text, post-parse char count for
   *  parsed docs). Used by ChatPanel to enforce the 256 KB cap. */
  size:     number;
  /** True when MinerU did the work — webview shows a different chip. */
  mineru:   boolean;
  /** 0.4.189 — when the caller passes chatId + attachmentsRoot, the parser
   *  writes the markdown out to `<attachmentsRoot>/<chatId>/<hash>.md` and
   *  echoes that path back. sendMessage inlines a short reference line
   *  pointing here instead of dumping the full markdown into the prompt,
   *  so the model spends tokens only on the head of the doc unless it
   *  chooses to `cat`/`grep` more. Absent when no chatId was passed. */
  resultPath?: string;
}

/** 0.4.189 — hooks the parser exposes so ChatPanelV2 can drive on-disk
 *  cache placement without teaching AttachmentParser about ChatPanel's
 *  paths module. Callers who don't want caching just omit these. */
export interface ParseOptions {
  chatId?: string;
  /** Root dir, e.g. `<dataRoot>/chat-attachments`. Per-chat subdir is
   *  created lazily as `<attachmentsRoot>/<chatId>/`. */
  attachmentsRoot?: string;
  /** Stable id used to name the .md/.meta.json files. When absent we mint
   *  a random one — but ChatPanelV2 always has a hash by the time it
   *  reaches AttachmentParser, so pass it through for the chip to match. */
  hash?: string;
  /** Progress callback fired at each state transition. AttachmentParser
   *  never blocks on this — errors thrown from the callback are swallowed. */
  onProgress?: (evt: { state: 'queued' | 'parsing' | 'done' | 'error'; percent?: number; error?: string; label?: string }) => void;
  /** MinerU backend to use. Defaults to 'hybrid-engine'. */
  backend?: 'hybrid-engine' | 'pipeline';
}

/** Extensions we route through MinerU. Anything else falls back to UTF-8
 *  read, which works for source code, JSON, Markdown, plain prose, etc. */
const MINERU_EXTS = new Set([
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls',
]);

/** Soft cap on the markdown we inline. PDFs can blow up to several MB
 *  of markdown; truncating here protects the prompt budget. The user
 *  sees the truncation note + the file is still in the model's view. */
const MAX_MARKDOWN_CHARS = 200_000;

export class AttachmentParser {
  private mineruClient?: McpClient;

  constructor(
    private readonly proxyBaseUrl: () => string,
    private readonly log:           Logger,
    /** Host-side directory that maps into the proxy container at the
     *  matching `containerStagingDir`. We copy attachments here so MinerU
     *  (running in-container) can actually open them — the user's source
     *  paths are not bind-mounted, only the claude-mem dir is. */
    private readonly hostStagingDir:      string,
    private readonly containerStagingDir: string,
    /** 0.4.200 — resolves to "host:port" of the real MinerU service (read
     *  from host.yaml mcp.mineru_host/port). Optional — when absent the
     *  parse label falls back to a generic form. */
    private readonly mineruEndpoint?:     () => Promise<string>,
  ) {}

  private getMineruClient(): McpClient | null {
    const base = this.proxyBaseUrl();
    if (!base) return null;
    if (!this.mineruClient) {
      this.mineruClient = new McpClient(`${base}/mcp/mineru/mcp`, this.log);
    }
    return this.mineruClient;
  }

  /** Decide whether `filePath` needs MinerU and route accordingly. */
  async parse(filePath: string, maxBytes: number, opts: ParseOptions = {}): Promise<ParsedAttachment> {
    const ext = path.extname(filePath).toLowerCase();
    const emit = (evt: Parameters<NonNullable<ParseOptions['onProgress']>>[0]) => {
      try { opts.onProgress?.(evt); } catch { /* swallow */ }
    };
    emit({ state: 'queued', label: 'Queued…' });
    let parsed: ParsedAttachment;
    try {
      if (MINERU_EXTS.has(ext)) {
        parsed = await this.parseWithMineru(filePath, ext, emit, opts.backend ?? 'pipeline');
      } else {
        emit({ state: 'parsing', label: 'Reading file…' });
        const stat = await fs.stat(filePath);
        if (stat.size > maxBytes) {
          throw new Error(`File too large (${stat.size} > ${maxBytes} bytes)`);
        }
        const text = await fs.readFile(filePath, 'utf8');
        parsed = { path: filePath, markdown: text, size: stat.size, mineru: false };
      }
    } catch (e) {
      emit({ state: 'error', error: (e as Error).message });
      throw e;
    }
    // Optional on-disk cache — only when the caller passed chatId + root.
    if (opts.chatId && opts.attachmentsRoot && opts.hash) {
      try {
        emit({ state: 'parsing', label: 'Writing markdown cache…' });
        const chatDir = path.join(opts.attachmentsRoot, opts.chatId);
        await fs.mkdir(chatDir, { recursive: true });
        const mdPath = path.join(chatDir, `${opts.hash}.md`);
        await fs.writeFile(mdPath, parsed.markdown, 'utf8');
        const meta = {
          hash:         opts.hash,
          originalName: path.basename(filePath),
          mimeType:     '',   // ChatPanel fills this in when it writes its own meta view
          sizeBytes:    parsed.size,
          parsedAt:     new Date().toISOString(),
          resultPath:   mdPath,
          mineru:       parsed.mineru,
        };
        await fs.writeFile(path.join(chatDir, `${opts.hash}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
        parsed.resultPath = mdPath;
      } catch (e) {
        this.log.warn(`[attach] cache write failed for ${opts.hash}: ${(e as Error).message}`);
      }
    }
    emit({ state: 'done' });
    return parsed;
  }

  private async parseWithMineru(
    filePath: string,
    ext: string,
    emit: (evt: { state: 'queued' | 'parsing' | 'done' | 'error'; percent?: number; error?: string; label?: string }) => void,
    backend: 'hybrid-engine' | 'pipeline' = 'pipeline',
  ): Promise<ParsedAttachment> {
    const client = this.getMineruClient();
    if (!client) {
      throw new Error('Aether proxy is not ready — MinerU is unreachable. Try again once the proxy is up.');
    }
    // Verify the file exists locally before we hand it off — MinerU
    // returns an opaque error otherwise.
    try { await fs.access(filePath); }
    catch { throw new Error(`File not found: ${filePath}`); }

    // Stage the file into a directory the proxy container can see. The
    // host's source path almost certainly isn't bind-mounted into the
    // proxy, so we copy to <hostStagingDir>/<uuid><ext> and pass the
    // matching <containerStagingDir>/<uuid><ext> path to MinerU.
    await fs.mkdir(this.hostStagingDir, { recursive: true });
    const fname = randomUUID() + ext;
    const stagedHost      = path.join(this.hostStagingDir,      fname);
    const stagedContainer = path.join(this.containerStagingDir, fname)
                              .replace(/\\/g, '/'); // posix-style for container
    // 0.4.195 — surface the pipeline stages on the chip so the user can
    // see WHERE a slow attach is stuck (proxy container vs remote MinerU
    // service vs local disk write).
    emit({ state: 'parsing', label: 'Staging to proxy…' });
    try { await fs.copyFile(filePath, stagedHost); }
    catch (e) { throw new Error(`Stage failed: ${(e as Error).message}`); }

    let mineruHost = '';
    if (this.mineruEndpoint) {
      try { mineruHost = await this.mineruEndpoint(); }
      catch { /* fall back below */ }
    }
    this.log.info(`[attach] mineru parse_document ${filePath} → ${stagedContainer}`);
    const baseLabel = mineruHost ? `Parsing on MinerU (${mineruHost})` : 'Parsing on MinerU';
    emit({ state: 'parsing', label: `${baseLabel}…` });
    // 0.4.199 — MinerU's parse_document is a single blocking call with no
    // native progress stream, so the chip would sit on "Parsing on
    // MinerU…" for the whole run and look frozen (Image #58). Emit an
    // elapsed-time heartbeat every 2s so the user can see the parse is
    // still alive and how long it has been running.
    const parseStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const secs = Math.max(1, Math.round((Date.now() - parseStartedAt) / 1000));
      emit({ state: 'parsing', label: `${baseLabel} · ${secs}s elapsed…` });
    }, 2000);
    let r;
    try {
      // Large manuals can legitimately take several minutes on the remote
      // hybrid engine. Keep a deadline so dead servers don't block forever,
      // but make it long enough for long PDFs.
      const TIMEOUT_MS = 15 * 60_000;
      r = await Promise.race<{ text: string; isError: boolean }>([
        client.callTool('parse_document', {
          file_path:      stagedContainer,
          backend,
          parse_method:   'auto',
          formula_enable: true,
          table_enable:   true,
          return_images:  true,
        }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`MinerU timed out after ${Math.round(TIMEOUT_MS/60_000)}min — check the mineru-server`)), TIMEOUT_MS)),
      ]);
    } finally {
      clearInterval(heartbeat);
      // Best-effort cleanup — leaving stale staging copies would slowly
      // pollute the claude-mem mount. fs.rm(force) silently ignores ENOENT.
      try { await fs.rm(stagedHost, { force: true }); }
      catch (e) { this.log.warn(`[attach] stage cleanup: ${(e as Error).message}`); }
    }
    if (r.isError) {
      throw new Error(`MinerU parse failed: ${r.text.slice(0, 200)}`);
    }
    let markdown = r.text || '';
    let images: Array<{ name: string; mediaType: string; data: string }> = [];
    // MinerU's structured output wraps the markdown in JSON, with the
    // shape varying between LOCAL and REMOTE mode:
    //   LOCAL : { status, mode, file, markdown: "...", content_list: [...] }
    //   REMOTE: { result: "..." }                 (FastMCP outputSchema)
    // Try both unwrappings; fall through to raw text on parse failure.
    try {
      const parsed = JSON.parse(markdown);
      if (parsed) {
        if (typeof parsed.markdown === 'string') markdown = parsed.markdown;
        else if (typeof parsed.result === 'string') markdown = parsed.result;
        if (Array.isArray(parsed.images)) {
          images = parsed.images.map((img: any) => {
            const name = String(img?.name || 'image.png');
            const ext = path.extname(name).toLowerCase();
            const mediaType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
            return { name, mediaType, data: String(img?.base64 || img?.data || '') };
          }).filter((img: any) => img.data);
        }
      }
    } catch { /* not JSON — use as-is */ }

    // Hard cap so a 500-page PDF doesn't single-handedly blow the prompt
    // budget. The model still gets the head + a truncation marker.
    let truncated = false;
    if (markdown.length > MAX_MARKDOWN_CHARS) {
      markdown = markdown.slice(0, MAX_MARKDOWN_CHARS) +
        `\n\n[…truncated ${markdown.length - MAX_MARKDOWN_CHARS} chars]`;
      truncated = true;
    }
    const header = `[Parsed from ${path.basename(filePath)} via MinerU` +
      (truncated ? ' — truncated]' : ']') + `\n\n`;
    return {
      path:     filePath,
      markdown: header + markdown,
      images,
      size:     markdown.length,
      mineru:   true,
    };
  }
}
