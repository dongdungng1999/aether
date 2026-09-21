/**
 * ToolRegistry — discover MCP tools from the proxy and expose them to Claude.
 *
 * Tool name convention sent to Claude: `<server>__<tool>`.
 * Servers are wired up by extending `ENABLED_SERVERS` below.
 *
 * Lookups are cached in-memory for the lifetime of the chat panel. A panel
 * re-open re-builds the registry, so a proxy restart with new tools is
 * picked up at the next chat panel open.
 */

import { Logger } from '../utils/logger';
import { McpClient, McpToolDef } from './McpClient';
import { ToolDef as AnthropicToolDef } from './ChatStreamer';
import { SANDBOX_TOOLS } from './SandboxClient';
import { RegistryEntry } from './ToolTypes';

export type { RegistryEntry, ToolKind } from './ToolTypes';

/** Translate '__' separator from Claude → server/tool tuple. */
const SEP = '__';

/** Replace every char Claude's tool-name regex disallows. */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Servers we surface to Claude in MVP. Each is a path under /mcp/.../mcp.
 *  Names match the proxy mount paths in _mcp_mount.py so the slug → URL
 *  translation is the identity.
 *
 *  `only` (optional) restricts the surfaced tools to a subset of what the
 *  server advertises. Used for claude-mem so the model only sees the
 *  worker-mode 3-tool workflow (search → timeline → get_observations),
 *  not the corpus/server-beta tools that would only confuse it. */
const ENABLED_SERVERS: ReadonlyArray<{ slug: string; only?: string[] }> = [
  // 0.4.267 — visualise MCP: get_visualise_rules + save_visualise. Backend
  // watches save_visualise tool_result and materialises the URL as an
  // aura_artifact so the frontend renders the diagram inline.
  { slug: 'visualise' },
  // { slug: 'renesas-backend-web' },  // disabled — backend no longer allows access
  { slug: 'tavily' },
  { slug: 'duckduckgo' },
  { slug: 'firecrawl' },
  { slug: 'paper-search' },
  { slug: 'arxiv' },
  { slug: 'claude-mem', only: ['search', 'timeline', 'get_observations'] },
  // MinerU lives on the proxy; we expose only the two parse_* tools so the
  // model can extract markdown from PDFs/DOCX/PPTX/XLSX on demand.
  // mineru_info is informational and doesn't need to be in the model's
  // tool surface — keep the picker tight.
  { slug: 'mineru', only: ['parse_document', 'parse_document_url'] },
  { slug: 'excalidraw' },
];

type Enabled = string;

export class ToolRegistry {
  private clients = new Map<Enabled, McpClient>();
  private entries: RegistryEntry[] = [];
  private loaded        = false;
  private builtinsAdded = false;

  constructor(
    /** Proxy base URL (e.g. http://127.0.0.1:8133). */
    private readonly proxyBaseUrl: () => string,
    private readonly log:           Logger,
  ) {}

  setAvailableModels(models: string[]): void {
    const entry = this.entries.find(item => item.exposed === 'spawn_agents');
    const model = (entry?.def.input_schema as any)?.properties?.agents?.items?.properties?.model;
    if (!model) return;
    const allowed = [...new Set(models.filter(Boolean))];
    if (allowed.length) {
      model.enum = allowed;
      model.description = `Choose one active-preset model: ${allowed.join(', ')}.`;
    } else {
      delete model.enum;
      model.description = 'Model configured by the active preset.';
    }
  }

  /** Lazy-load and cache. Caller is expected to invoke once on the first
   *  send. Failures per server are logged but the registry keeps the tools
   *  it did manage to fetch — partial coverage is better than no chat. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    // Built-ins (ask_user + sandbox) are added once; on MCP-retry runs they
    // are already present so we skip the push to avoid duplicates.
    if (!this.builtinsAdded) {
      this.builtinsAdded = true;

    // 0.4.162 — pseudo-tool: model calls this to ask the user a structured
    // set of clarifying questions when the request is genuinely ambiguous.
    // ToolExecutor intercepts entries with kind='ask_user' — instead of
    // dispatching MCP/sandbox, it broadcasts a card to the webview and
    // waits for the user's reply. Registered first so it's stable across
    // MCP-server availability changes.
    this.entries.push({
      exposed: 'ask_user',
      kind:    'ask_user',
      def: {
        name: 'ask_user',
        description:
          'Ask the user 1-4 clarifying questions when their request is genuinely ambiguous. ' +
          'Use ONLY when the ambiguity blocks meaningful progress and cannot be resolved by ' +
          'stating assumptions and proceeding. Do NOT use for trivial requests, greetings, or ' +
          'questions you can answer yourself. Each question must present concrete, mutually-' +
          'exclusive (or explicitly multi-select) options — never open-ended "tell me more" prompts.',
        input_schema: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              minItems: 1,
              maxItems: 4,
              description: '1-4 clarifying questions to present as an interactive card.',
              items: {
                type: 'object',
                properties: {
                  question: {
                    type: 'string',
                    description: 'The full question shown to the user, ending with a "?".',
                  },
                  header: {
                    type: 'string',
                    description: 'Short chip label (max 12 chars) shown as a category tag.',
                  },
                  description: {
                    type: 'string',
                    description: 'Optional 1-line explanation of what the question is asking.',
                  },
                  options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 4,
                    description: '2-4 mutually-exclusive answer choices (unless multiSelect).',
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string', description: 'Short display text (1-5 words).' },
                        description: {
                          type: 'string',
                          description: 'Optional explanation of what picking this option means.',
                        },
                      },
                      required: ['label'],
                    },
                  },
                  multiSelect: {
                    type: 'boolean',
                    description: 'true = allow multiple options; false = single-choice radio.',
                  },
                },
                required: ['question', 'header', 'options', 'multiSelect'],
              },
            },
          },
          required: ['questions'],
        },
      },
    });

    this.entries.push({
      exposed: 'spawn_agents',
      kind: 'spawn_agents',
      def: {
        name: 'spawn_agents',
        description:
          'Delegate independent or specialized work to isolated child agents. Each child has its own context, tools, model and effort, may delegate further within runtime limits, and returns a structured result. Use only when decomposition materially improves quality or latency; give every child a self-contained task and synthesize the returned results yourself.',
        input_schema: {
          type: 'object',
          properties: {
            agents: {
              type: 'array', minItems: 1, maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  task: { type: 'string', description: 'Self-contained child task and expected output.' },
                  model: { type: 'string', description: 'Model alias available in the current preset.' },
                  effort: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
                  maxTurns: { type: 'integer', minimum: 1, maximum: 30 },
                },
                required: ['task'],
              },
            },
          },
          required: ['agents'],
        },
      },
    });

    this.entries.push({
      exposed: 'release_agents',
      kind: 'release_agents',
      def: {
        name: 'release_agents',
        description:
          'Final cleanup only for completed direct child agents after you have consumed their returned results, verified/synthesized them, finished any remaining tool work, and settled your own final answer. This does not submit results to your owner/orchestrator; it only marks owned children released while preserving their transcript/artifacts for history. Never call this immediately after spawn_agents, and do not call more tools or continue task work after release_agents except to return your final answer.',
        input_schema: {
          type: 'object',
          properties: {
            agentIds: {
              type: 'array', minItems: 1, maxItems: 24,
              items: { type: 'string', description: 'Child agent id returned by spawn_agents.' },
            },
          },
          required: ['agentIds'],
        },
      },
    });

    this.entries.push({
      exposed: 'agent_transfer',
      kind: 'agent_transfer',
      def: {
        name: 'agent_transfer',
        description:
          'Submit your final result to your parent agent. Call this EXACTLY ONCE as your last step, after you have finished the task and pinned every deliverable with aura_artifact_pin. Pass `result` (the synthesized text your parent should receive) and `artifacts` (the ids of pinned artifacts to hand up). The backend routes this to your direct parent (or the orchestrator if you are a top-level coordinator) — you do not specify a target. This becomes the result your parent receives for you. Do not call any further tools after agent_transfer.',
        input_schema: {
          type: 'object',
          properties: {
            result: {
              type: 'string',
              description: 'The synthesized final text to hand up to your parent. Defaults to your last assistant message if omitted.',
            },
            artifacts: {
              type: 'array',
              items: { type: 'string', description: 'Artifact id returned by aura_artifact_pin.' },
              description: 'Ids of your pinned artifacts to transfer up. Defaults to all artifacts you pinned if omitted.',
            },
            note: {
              type: 'string',
              description: 'Optional short handoff note for your parent.',
            },
          },
        },
      },
    });

    this.entries.push({
      exposed: 'aura_artifact_pin',
      kind: 'artifact_pin',
      def: {
        name: 'aura_artifact_pin',
        description:
          'Pin an important user-visible file you created into AURA session artifact storage. Use after creating and verifying deliverables such as reports, plans, markdown, JSON/CSV, charts, HTML/SVG, PDFs, Office files, or ZIPs. Do not use for temporary/debug/intermediate files unless the user asked for them. The chat stores only artifact metadata/id; the frontend renders Preview/Save cards from globalStorage.',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative filename in the sandbox artifact cwd, or /tmp/aura-artifacts/<chatId>/<file>, or a safe AURA artifact URL.',
            },
            name: {
              type: 'string',
              description: 'Optional display filename. Defaults to basename(path).',
            },
            description: {
              type: 'string',
              description: 'Optional short human description of what this artifact is.',
            },
            mediaType: {
              type: 'string',
              description: 'Optional MIME type override.',
            },
            live: {
              type: 'boolean',
              description: 'Set true for artifacts that will be updated later; the frontend shows a live badge and polls for updates.',
            },
          },
          required: ['path'],
        },
      },
    });

    this.entries.push({
      exposed: 'update_artifact',
      kind: 'artifact_update',
      def: {
        name: 'update_artifact',
        description:
          'Update an existing AURA artifact by id without creating a new card. Use only for artifacts you previously pinned in this chat, especially live plans, dashboards, reports, or progress files that should refresh in place.',
        input_schema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Artifact id returned by aura_artifact_pin.',
            },
            content: {
              type: 'string',
              description: 'New UTF-8 text content for the artifact.',
            },
            path: {
              type: 'string',
              description: 'Optional source file path to read instead of content. Supports relative sandbox artifact paths, /tmp/aura-artifacts/<chatId>/..., safe AURA URLs, or sandbox /tmp/... paths.',
            },
            description: {
              type: 'string',
              description: 'Optional updated human description.',
            },
          },
          required: ['id'],
        },
      },
    });

    // Sandbox tools are baked-in: the sandbox runs as a sibling container
    // on the same compose network, has no MCP layer, and we know its
    // schema statically. Add them first so they show up before MCP tools
    // in the array (no functional impact, just nicer for debugging).
    for (const def of SANDBOX_TOOLS) {
      this.entries.push({ exposed: def.name, kind: 'sandbox', def });
    }
    } // end builtinsAdded guard

    const base = this.proxyBaseUrl();
    if (!base) { this.loaded = true; return; }

    for (const cfg of ENABLED_SERVERS) {
      const slug = cfg.slug;
      const client = new McpClient(`${base}/mcp/${slug}/mcp`, this.log);
      this.clients.set(slug, client);
      let raws: McpToolDef[] = [];
      try {
        raws = await client.listTools();
      } catch (e) {
        this.log.warn(`[tool-registry] ${slug} list failed: ${(e as Error).message}`);
        continue;
      }
      const allow = cfg.only ? new Set(cfg.only) : null;
      let surfaced = 0;
      for (const raw of raws) {
        if (allow && !allow.has(raw.name)) continue;
        const exposed = safeName(`${slug}${SEP}${raw.name}`);
        this.entries.push({
          exposed, kind: 'mcp', server: slug, rawName: raw.name,
          def: {
            name:         exposed,
            description:  raw.description,
            input_schema: raw.inputSchema,
          },
        });
        surfaced++;
      }
      this.log.info(`[tool-registry] ${slug}: ${surfaced} tool(s)` +
        (allow ? ` (filtered from ${raws.length})` : ''));
    }
    const mcpCount = this.entries.filter(e => e.kind === 'mcp').length;
    if (mcpCount > 0) {
      this.loaded = true;
    } else {
      // Proxy had no MCP tools yet (still starting up) — retry on next send.
      this.log.warn('[tool-registry] zero MCP tools loaded; will retry on next send');
    }
  }

  /** Tool defs to ship with the next /v1/messages call. */
  toolDefs(): AnthropicToolDef[] {
    return this.entries.map(e => e.def);
  }

  /** Map Claude's chosen tool name back to its MCP entry. */
  resolve(exposedName: string): RegistryEntry | undefined {
    return this.entries.find(e => e.exposed === exposedName);
  }

  /** MCP client for the given server (used by ToolExecutor). */
  clientFor(server: Enabled): McpClient | undefined {
    return this.clients.get(server);
  }

  /** Forget cached state — caller invokes on proxy restart so the next
   *  send re-discovers tools. */
  reset() {
    this.clients.clear();
    this.entries      = [];
    this.loaded       = false;
    this.builtinsAdded = false;
  }
}
