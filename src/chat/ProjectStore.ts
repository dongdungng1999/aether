/**
 * ProjectStore — thin index over <dataRoot>/chat-projects/projects.json.
 *
 * One project = a name + an id + (optionally) a system-prompt hint and a
 * list of session ids that belong to it. Sessions remain JSONL files in
 * <dataRoot>/chat-sessions/ (where ChatStore writes them); the project
 * file just records "this session_id belongs to project X".
 *
 * The "Quick Chat" project is implicit — sessions with no project are
 * shown in a separate "(no project)" group on the sidebar.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface Project {
  id:        string;
  name:      string;
  /** Optional system-prompt prefix the model gets every turn. */
  systemPrompt?: string;
  createdAt: number;
}

export interface ProjectIndex {
  projects: Project[];
  /** session_id → project_id mapping. Sessions with no entry are unfiled. */
  sessions: Record<string, string>;
}

export class ProjectStore {
  private file: string;
  private cache?: ProjectIndex;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, 'chat-projects', 'projects.json');
  }

  private async load(): Promise<ProjectIndex> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const obj = JSON.parse(raw) as ProjectIndex;
      this.cache = {
        projects: Array.isArray(obj.projects) ? obj.projects : [],
        sessions: obj.sessions && typeof obj.sessions === 'object' ? obj.sessions : {},
      };
    } catch {
      this.cache = { projects: [], sessions: {} };
    }
    return this.cache;
  }

  private async save() {
    if (!this.cache) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  async listProjects(): Promise<Project[]> {
    const idx = await this.load();
    return [...idx.projects].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProject(name: string, systemPrompt?: string): Promise<Project> {
    const idx = await this.load();
    const p: Project = {
      id: randomUUID(),
      name: name.trim() || 'Untitled',
      systemPrompt: systemPrompt?.trim() || undefined,
      createdAt: Date.now(),
    };
    idx.projects.push(p);
    await this.save();
    return p;
  }

  /** Update fields on an existing project (name and/or systemPrompt). */
  async updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'systemPrompt'>>): Promise<Project | undefined> {
    const idx = await this.load();
    const p   = idx.projects.find(x => x.id === id);
    if (!p) return undefined;
    if (patch.name !== undefined)         p.name         = patch.name.trim() || p.name;
    if (patch.systemPrompt !== undefined) p.systemPrompt = patch.systemPrompt.trim() || undefined;
    await this.save();
    return p;
  }

  async deleteProject(id: string): Promise<void> {
    const idx = await this.load();
    idx.projects = idx.projects.filter(p => p.id !== id);
    // Detach all sessions from the deleted project (they survive as unfiled).
    for (const [sid, pid] of Object.entries(idx.sessions)) {
      if (pid === id) delete idx.sessions[sid];
    }
    await this.save();
  }

  /** Lookup by id (returns undefined if removed). */
  async getProject(id: string): Promise<Project | undefined> {
    const idx = await this.load();
    return idx.projects.find(p => p.id === id);
  }

  /** Assign a session to a project. Pass empty string to detach. */
  async assignSession(sessionId: string, projectId: string): Promise<void> {
    const idx = await this.load();
    if (!projectId) delete idx.sessions[sessionId];
    else idx.sessions[sessionId] = projectId;
    await this.save();
  }

  async sessionProject(sessionId: string): Promise<string | undefined> {
    const idx = await this.load();
    return idx.sessions[sessionId];
  }

  async sessionsByProject(): Promise<Record<string, string[]>> {
    const idx = await this.load();
    const out: Record<string, string[]> = {};
    for (const [sid, pid] of Object.entries(idx.sessions)) {
      (out[pid] ||= []).push(sid);
    }
    return out;
  }

  /** Reverse lookup: given a session id, return the human-readable
   *  project name ('' if unfiled). Returns '' on errors so the caller
   *  can fall back to the orphan folder. */
  async projectNameForSession(sessionId: string): Promise<string> {
    try {
      const idx = await this.load();
      const pid = idx.sessions[sessionId];
      if (!pid) return '';
      const proj = idx.projects.find(p => p.id === pid);
      return proj?.name ?? '';
    } catch {
      return '';
    }
  }

  /** Bulk variant — single pass over the index. */
  async sessionToProjectName(): Promise<Record<string, string>> {
    const idx = await this.load();
    const nameById: Record<string, string> = {};
    for (const p of idx.projects) nameById[p.id] = p.name;
    const out: Record<string, string> = {};
    for (const [sid, pid] of Object.entries(idx.sessions)) {
      const name = nameById[pid];
      if (name) out[sid] = name;
    }
    return out;
  }
}
