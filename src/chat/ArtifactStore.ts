/**
 * ArtifactStore — id-based storage for sandbox tool_result files.
 *
 * v0.4.259: replaces the multi-path artifact rendering (regex markdown-image,
 * text-scan, image.attach / file.attach for sandbox) with a single source of
 * truth. Backend fetches each sandbox artifact once, saves it under a uuid,
 * appends an `aura_artifact` block to session history, then broadcasts
 * `artifact.attach` carrying that uuid. SSE-live and reload both use the
 * same code path — the frontend renders solely from the uuid + mediaType.
 *
 * Layout:
 *   <dataRoot>/chat-artifacts/<chatId>/<uuid>.<ext>
 *
 * NOT used for: user-attach (paperclip) or MCP /api/images/ — those keep
 * their existing ImageCache pipeline.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger } from '../utils/logger';

export interface SavedArtifact {
  id:        string;   // uuid v4
  name:      string;   // original filename from sandbox
  ext:       string;   // lower-case extension without dot
  mediaType: string;
  localPath: string;   // absolute host path
  size:      number;
  savedAt:   number;   // epoch ms
  updatedAt?: number;  // epoch ms, set after in-place updates
  version?:   number;  // starts at 1, increments on update
  live?:      boolean;
  description?: string;
}

const EXT_MIME: Record<string, string> = {
  // images
  png:  'image/png',
  jpg:  'image/jpeg',  jpeg: 'image/jpeg',
  webp: 'image/webp',  gif:  'image/gif',
  svg:  'image/svg+xml',
  bmp:  'image/bmp',
  // office
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc:  'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls:  'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt:  'application/vnd.ms-powerpoint',
  // documents
  pdf:  'application/pdf',
  csv:  'text/csv',
  tsv:  'text/tab-separated-values',
  txt:  'text/plain',
  md:   'text/markdown',
  json: 'application/json',
  html: 'text/html',
  xml:  'application/xml',
  // archives
  zip:  'application/zip',
  gz:   'application/gzip',
  tar:  'application/x-tar',
};

function mimeFor(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] || 'application/octet-stream';
}

function uuidv4(): string {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ArtifactStore {
  constructor(
    /** <dataRoot>/chat-artifacts */
    private readonly rootDir: string,
    private readonly log: Logger,
  ) {}

  private dirFor(chatId: string, agentId?: string): string {
    // chatId is used verbatim — callers pass session ids that already
    // pass through validation upstream.
    const root = path.join(this.rootDir, chatId);
    if (!agentId) return root;
    if (!/^agt_[0-9a-f]{12}$/i.test(agentId)) throw new Error(`invalid agent id: ${agentId}`);
    return path.join(root, `agent-${agentId}`);
  }

  async saveArtifact(chatId: string, name: string, bytes: Buffer, agentId?: string): Promise<SavedArtifact> {
    if (!chatId) throw new Error('saveArtifact: chatId required');
    if (!name)   throw new Error('saveArtifact: name required');
    const ext = (path.extname(name).replace(/^\./, '') || 'bin').toLowerCase();
    const id  = uuidv4();
    const dir = this.dirFor(chatId, agentId);
    await fs.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, `${id}.${ext}`);
    await fs.writeFile(localPath, bytes);
    this.log.info(`[artifact-store] saved ${localPath} (${bytes.length} bytes, ${name})`);
    return {
      id,
      name,
      ext,
      mediaType: mimeFor(ext),
      localPath,
      size:      bytes.length,
      savedAt:   Date.now(),
    };
  }

  async pathForArtifact(chatId: string, id: string, agentId?: string): Promise<string> {
    if (!UUID_RE.test(id)) throw new Error(`pathForArtifact: invalid id ${id}`);
    const dir = this.dirFor(chatId, agentId);
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const hit = entries.find(e => e.startsWith(id + '.'));
    if (!hit) throw new Error(`pathForArtifact: not found ${chatId}/${id}`);
    const abs = path.resolve(dir, hit);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`pathForArtifact: path escape ${abs}`);
    }
    return abs;
  }

  async readArtifact(chatId: string, id: string, agentId?: string): Promise<Buffer> {
    return fs.readFile(await this.pathForArtifact(chatId, id, agentId));
  }

  async updateArtifact(chatId: string, id: string, bytes: Buffer, agentId?: string): Promise<{ localPath: string; size: number; updatedAt: number }> {
    const localPath = await this.pathForArtifact(chatId, id, agentId);
    await fs.writeFile(localPath, bytes);
    const updatedAt = Date.now();
    this.log.info(`[artifact-store] updated ${localPath} (${bytes.length} bytes)`);
    return { localPath, size: bytes.length, updatedAt };
  }

  async promoteArtifact(
    chatId: string,
    fromAgentId: string,
    artifact: Pick<SavedArtifact, 'id' | 'name'>,
    toAgentId?: string,
  ): Promise<SavedArtifact> {
    const bytes = await this.readArtifact(chatId, artifact.id, fromAgentId);
    return this.saveArtifact(chatId, artifact.name, bytes, toAgentId);
  }

  async purgeAgent(chatId: string, agentId: string): Promise<void> {
    const dir = this.dirFor(chatId, agentId);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
