/**
 * McpClient — minimal streamable-HTTP MCP JSON-RPC client.
 *
 * The proxy mounts each MCP server at /mcp/<name>/mcp using FastMCP's
 * streamable_http transport. We:
 *   1. POST initialize → grab Mcp-Session-Id from response headers
 *   2. POST notifications/initialized
 *   3. POST tools/list
 *   4. POST tools/call (per tool invocation)
 *
 * The transport returns SSE event-streams for tool/call but we always read
 * the full body and pull out the single JSON-RPC `result` object. Larger
 * tools (image generation) that take ~30-60s rely on this — we can't
 * stream tool output back to the chat UI mid-call yet.
 */

import * as http from 'http';
import { Logger } from '../utils/logger';

interface RawHttpResp {
  status:  number;
  headers: http.IncomingHttpHeaders;
  body:    string;
}

export interface McpToolDef {
  name:         string;
  description?: string;
  /** JSON Schema. */
  inputSchema:  any;
}

export class McpClient {
  /** session id assigned by the server on first initialize call. */
  private sessionId = '';

  constructor(
    /** e.g. http://127.0.0.1:8133/mcp/renesas-image/mcp */
    private readonly endpoint: string,
    private readonly log:      Logger,
  ) {}

  /** First call: initialize → notifications/initialized. Subsequent calls
   *  reuse the cached session id; no-op when already initialized.
   *
   *  Some FastMCP servers run in stateless mode and don't issue an
   *  Mcp-Session-Id header; their handshake is still meaningful. We treat
   *  a successful initialize result as enough to proceed and only fail
   *  when the body itself reports an error. */
  private initialized = false;
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const init = await this.rawPost({
      jsonrpc: '2.0',
      id:      1,
      method:  'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities:    {},
        clientInfo:      { name: 'aura-extension', version: '0.4.0' },
      },
    });
    const obj = parseJsonRpc(init.body);
    if (obj.error) {
      throw new Error(`MCP initialize error: ${obj.error.message}`);
    }
    if (!obj.result) {
      throw new Error(`MCP initialize empty response: ${init.body.slice(0, 300)}`);
    }
    const sid = init.headers['mcp-session-id'];
    if (typeof sid === 'string' && sid) this.sessionId = sid;
    this.initialized = true;
    // Best-effort initialized notification — server doesn't reply meaningfully.
    await this.rawPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, true);
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.ensureInitialized();
    const r = await this.rawPost({
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    const obj = parseJsonRpc(r.body);
    if (obj.error) throw new Error(`MCP tools/list failed: ${obj.error.message}`);
    const tools = (obj.result?.tools ?? []) as Array<any>;
    return tools.map(t => ({
      name:         t.name,
      description:  t.description,
      inputSchema:  t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, any>): Promise<{
    text: string; isError: boolean;
  }> {
    await this.ensureInitialized();
    const r = await this.rawPost({
      jsonrpc: '2.0', id: 100 + Math.floor(Math.random() * 9999),
      method:  'tools/call',
      params:  { name, arguments: args },
    });
    const obj = parseJsonRpc(r.body);
    if (obj.error) {
      return { text: `MCP error: ${obj.error.message}`, isError: true };
    }
    const content = (obj.result?.content ?? []) as Array<any>;
    // FastMCP returns [{type:"text", text:"..."}]; we concatenate all text
    // blocks since some tools fan out structured content alongside.
    const text = content.map(c => {
      if (c.type === 'text') return String(c.text ?? '');
      if (c.type === 'image') return `[image ${c.mimeType ?? ''}]`;
      return JSON.stringify(c);
    }).join('\n');
    const isError = !!obj.result?.isError;
    return { text: text || '(empty tool result)', isError };
  }

  private rawPost(body: any, fireAndForget = false): Promise<RawHttpResp> {
    const url = new URL(this.endpoint);
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'accept':       'application/json, text/event-stream',
      };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      const req = http.request({
        hostname: url.hostname,
        port:     url.port,
        path:     url.pathname,
        method:   'POST',
        headers,
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve({
          status:  res.statusCode || 0,
          headers: res.headers,
          body:    Buffer.concat(chunks).toString('utf8'),
        }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
      if (fireAndForget) {
        // Resolve early — caller doesn't need the body.
        req.on('finish', () => resolve({ status: 0, headers: {}, body: '' }));
      }
    });
  }
}

/** Parse the body of a streamable-HTTP MCP response. The transport sends
 *  one or more SSE frames "event: message\ndata: {...}\n\n" — we pluck the
 *  first `data:` line that parses as the matching JSON-RPC envelope. */
function parseJsonRpc(body: string): any {
  // Plain JSON body (some servers / tests).
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  // SSE framed: scan for "data: ..." JSON, picking the *last* one with a
  // result/error key (keepalive frames carry no result).
  let last: any = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const txt = line.slice(5).trim();
    if (!txt || txt === '[DONE]') continue;
    try {
      const obj = JSON.parse(txt);
      if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
    } catch { /* ignore */ }
  }
  return last ?? {};
}
