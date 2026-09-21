/**
 * ChatStreamer — POST /v1/messages to AURA proxy and stream SSE events back.
 *
 * The proxy speaks Anthropic's Messages schema, so every event we emit is
 * exactly what the SDK would yield. We parse text deltas, thinking deltas,
 * and tool_use blocks (assembled across content_block_start/delta/stop).
 *
 * Yields one of:
 *   { type: 'text',     text }                    // incremental text token(s)
 *   { type: 'thinking', text }                    // adaptive reasoning summary
 *   { type: 'tool_use_start', id, name }          // tool call begins
 *   { type: 'tool_use_delta', id, partial }       // input JSON growing
 *   { type: 'tool_use_done',  id, name, input }   // input fully assembled
 *   { type: 'message_done', stopReason, blocks }  // turn finished — assistant blocks
 *   { type: 'error',    error }
 */

import * as http from 'http';

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | string;

/** Anthropic content blocks we round-trip. The streamer only emits these
 *  three kinds; tool_result blocks are produced by the loop, not Claude. */
export type AssistantBlock =
  | { type: 'text';     text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: any };

export type ContentBlock =
  | AssistantBlock
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };

/** Token counts the proxy reports in `message_delta.usage`. Cache fields
 *  are optional — the OpenAI-shaped Renesas backend may omit them. */
export interface UsageDelta {
  inTokens:    number;
  outTokens:   number;
  cacheRead?:  number;
  cacheWrite?: number;
}

export type StreamEvent =
  | { type: 'text';            text: string }
  | { type: 'thinking';        text: string }
  | { type: 'tool_use_start';  id: string; name: string }
  | { type: 'tool_use_delta';  id: string; partial: string }
  | { type: 'tool_use_done';   id: string; name: string; input: any }
  | { type: 'message_done';    stopReason: StopReason; blocks: AssistantBlock[]; usage: UsageDelta }
  | { type: 'error';           error: string }
  /** Raw Anthropic SSE frame, forwarded verbatim. The studio webview
   *  consumes this directly — content_block_*, message_delta, etc. We emit
   *  it ALONGSIDE the higher-level events above so existing consumers keep
   *  working unchanged. */
  | { type: 'sse_raw';         event: string; data: any };

export interface ChatMessage {
  role:    'user' | 'assistant';
  /** Plain string (we wrap it) or an explicit block array. */
  content: string | ContentBlock[];
  /** 0.4.414 — creation-time epoch (ms), carried in-memory so full-history
   *  rewrites (persistSession, delete-turn, compaction) preserve each turn's
   *  ORIGINAL timestamp instead of re-stamping the whole transcript to a
   *  single Date.now(). claude-mem correlates observations to assistant turns
   *  by matching observation epoch into [msg.ts, nextAsst.ts) windows — if all
   *  ts collapse to one value, every window is empty and only the last turn
   *  keeps its memory card. Set at creation; copied on hydrate. */
  ts?: number;
  /** 0.4.216 — set on continuation hints and outer-loop "(continue)"
   *  injections. HistoryPruner skips synthetic user turns when locating
   *  the "real" user ask so the original request isn't dropped in
   *  systemnote-mode. Never sent to the API. */
  synthetic?: boolean;
  /** 0.4.229 — marks a synthetic turn's semantic role. Currently only
   *  'compact': a compact-summary marker persisted into the full history
   *  JSONL so the FE can render the compact card from history and
   *  runtime rebuilds (post delete-turn / delete-message) can slice
   *  from the marker forward without losing the summary. */
  kind?: 'compact' | 'agent-handoff';
  agentHandoffs?: Array<{
    sourceAgentId: string;
    sourceTask: string;
    revision: string;
    text: string;
  }>;
}

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Anthropic-format tool definition. */
export interface ToolDef {
  name:         string;
  description?: string;
  input_schema: any;
}

export interface StreamOpts {
  baseUrl:    string;        // e.g. http://127.0.0.1:8400
  model:      string;        // e.g. claude-opus-4-7
  messages:   ChatMessage[];
  system?:    string;
  tools?:     ToolDef[];
  signal?:    AbortSignal;
  maxTokens?: number;
  /** When set, request adaptive thinking at the selected effort level. */
  thinking?:  { effort: ThinkingEffort };
}

export async function* streamChat(opts: StreamOpts): AsyncGenerator<StreamEvent> {
  // If the caller's signal is ALREADY aborted (user hit Stop while a tool ran
  // in the previous loop iteration, before this request started), the
  // 'abort' listener below would never fire — the event is in the past — and
  // the request would stream to completion. Bail before opening the socket.
  if (opts.signal?.aborted) { yield { type: 'error', error: 'aborted' }; return; }
  const url = new URL('/v1/messages', opts.baseUrl);
  const max_tokens = opts.maxTokens ?? 4096;
  const body = JSON.stringify({
    model:       opts.model,
    max_tokens,
    stream:      true,
    system:      opts.system,
    messages:    opts.messages.map(m => ({
      role:    m.role,
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        // v0.4.259 — strip internal `aura_artifact` blocks; the Anthropic
        // API doesn't understand them and they're purely UI metadata.
        : (m.content as any[]).filter(b => (b as any)?.type !== 'aura_artifact'),
    })),
    ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    ...(opts.thinking ? {
      thinking:      { type: 'adaptive', display: 'summarized' },
      output_config: { effort: opts.thinking.effort },
    } : {}),
  });

  const queue: StreamEvent[] = [];
  let done = false;
  let waker: (() => void) | null = null;
  const wake = () => { const w = waker; waker = null; w?.(); };

  // Per-message state machine. Anthropic sends content blocks in order:
  //   content_block_start { index, content_block: { type, ... } }
  //   content_block_delta { index, delta: { type, ... } }   (repeated)
  //   content_block_stop  { index }
  // For text/thinking we yield deltas live; for tool_use we accumulate the
  // input_json_delta string and parse the finished JSON on stop.
  type BlockState =
    | { kind: 'text';     text: string }
    | { kind: 'thinking'; thinking: string; signature?: string }
    | { kind: 'tool_use'; id: string; name: string; jsonBuf: string };
  const blocks = new Map<number, BlockState>();
  /** Final assistant blocks in order — built up alongside `blocks`. */
  const finalBlocks: AssistantBlock[] = [];
  let stopReason: StopReason = 'end_turn';
  /** Aggregated token usage. message_start carries an "initial" estimate;
   *  message_delta has the authoritative final numbers — we replace, not
   *  add, when the latter arrives. */
  const usage: UsageDelta = { inTokens: 0, outTokens: 0 };

  const req = http.request({
    hostname: url.hostname,
    port:     url.port,
    path:     url.pathname,
    method:   'POST',
    headers: {
      'content-type':       'application/json',
      'accept':             'text/event-stream',
      'anthropic-version':  '2023-06-01',
    },
  }, res => {
    if (res.statusCode && res.statusCode >= 400) {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        queue.push({ type: 'error', error: `HTTP ${res.statusCode}: ${buf.slice(0, 500)}` });
        done = true; wake();
      });
      return;
    }

    let buf = '';
    res.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      // SSE frames are separated by \n\n. Each frame can have multi-line "data: …".
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = frame.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim());
        if (!dataLines.length) continue;
        const payload = dataLines.join('\n');
        if (payload === '[DONE]') {
          // Defensive: most providers send message_stop, not [DONE], but
          // fall through anyway so callers always see a terminal event.
          queue.push({ type: 'message_done', stopReason, blocks: finalBlocks, usage });
          wake();
          continue;
        }

        let evt: any;
        try { evt = JSON.parse(payload); } catch { continue; }

        // Mirror the raw SSE frame to consumers that want it verbatim
        // (the studio webview's chat.chunk pipe). The high-level events
        // below stay intact so this is a pure addition.
        if (evt && typeof evt.type === 'string') {
          queue.push({ type: 'sse_raw', event: evt.type, data: evt });
          wake();
        }

        if (evt.type === 'content_block_start') {
          const cb = evt.content_block || {};
          const i  = evt.index ?? 0;
          if (cb.type === 'text') {
            blocks.set(i, { kind: 'text', text: '' });
          } else if (cb.type === 'thinking') {
            blocks.set(i, { kind: 'thinking', thinking: '' });
          } else if (cb.type === 'tool_use') {
            blocks.set(i, { kind: 'tool_use', id: cb.id, name: cb.name, jsonBuf: '' });
            queue.push({ type: 'tool_use_start', id: cb.id, name: cb.name });
            wake();
          }
        } else if (evt.type === 'content_block_delta') {
          const i = evt.index ?? 0;
          const b = blocks.get(i);
          const d = evt.delta || {};
          if (!b) continue;
          if (b.kind === 'text' && d.type === 'text_delta') {
            b.text += d.text || '';
            queue.push({ type: 'text', text: d.text || '' });
            wake();
          } else if (b.kind === 'thinking' && d.type === 'thinking_delta') {
            b.thinking += d.thinking || '';
            queue.push({ type: 'thinking', text: d.thinking || '' });
            wake();
          } else if (b.kind === 'thinking' && d.type === 'signature_delta') {
            b.signature = (b.signature ?? '') + (d.signature || '');
          } else if (b.kind === 'tool_use' && d.type === 'input_json_delta') {
            b.jsonBuf += d.partial_json || '';
            queue.push({ type: 'tool_use_delta', id: b.id, partial: d.partial_json || '' });
            wake();
          }
        } else if (evt.type === 'content_block_stop') {
          const i = evt.index ?? 0;
          const b = blocks.get(i);
          if (!b) continue;
          if (b.kind === 'text') {
            if (b.text) finalBlocks.push({ type: 'text', text: b.text });
          } else if (b.kind === 'thinking') {
            // Drop empty thinking blocks (no useful round-trip content).
            if (b.thinking) {
              finalBlocks.push({
                type: 'thinking',
                thinking: b.thinking,
                ...(b.signature ? { signature: b.signature } : {}),
              });
            }
          } else if (b.kind === 'tool_use') {
            let parsed: any = {};
            if (b.jsonBuf) {
              try { parsed = JSON.parse(b.jsonBuf); }
              catch { parsed = { _raw: b.jsonBuf }; }
            }
            finalBlocks.push({ type: 'tool_use', id: b.id, name: b.name, input: parsed });
            queue.push({ type: 'tool_use_done', id: b.id, name: b.name, input: parsed });
            wake();
          }
        } else if (evt.type === 'message_start') {
          // Anthropic includes an *initial* usage block here (input_tokens
          // counted before generation). Capture it as our starting point;
          // message_delta will overwrite with the final numbers.
          const u = evt.message?.usage;
          if (u) {
            if (typeof u.input_tokens === 'number')                usage.inTokens   = u.input_tokens;
            if (typeof u.output_tokens === 'number')               usage.outTokens  = u.output_tokens;
            if (typeof u.cache_read_input_tokens === 'number')     usage.cacheRead  = u.cache_read_input_tokens;
            if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWrite = u.cache_creation_input_tokens;
          }
        } else if (evt.type === 'message_delta') {
          // stop_reason arrives in message_delta.delta.stop_reason; usage
          // here is the final/authoritative value (Anthropic) or the only
          // usage (OpenAI-shape proxy emits it once at end).
          const sr = evt.delta?.stop_reason;
          if (typeof sr === 'string') stopReason = sr;
          const u = evt.usage;
          if (u) {
            if (typeof u.input_tokens === 'number')                usage.inTokens   = u.input_tokens;
            if (typeof u.output_tokens === 'number')               usage.outTokens  = u.output_tokens;
            if (typeof u.cache_read_input_tokens === 'number')     usage.cacheRead  = u.cache_read_input_tokens;
            if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWrite = u.cache_creation_input_tokens;
          }
        } else if (evt.type === 'message_stop') {
          queue.push({ type: 'message_done', stopReason, blocks: finalBlocks, usage });
          wake();
        } else if (evt.type === 'error') {
          queue.push({ type: 'error', error: evt.error?.message ?? 'unknown error' });
          wake();
        }
      }
    });
    res.on('end',   () => { done = true; wake(); });
    res.on('error', e => { queue.push({ type: 'error', error: e.message }); done = true; wake(); });
  });

  req.on('error', e => { queue.push({ type: 'error', error: e.message }); done = true; wake(); });
  // Backstop: if the socket closes for any reason without a normal res 'end'
  // (e.g. destroyed mid-stream), make sure the drain loop terminates.
  req.on('close', () => { if (!done) { done = true; wake(); } });
  // On abort, flip done + wake DIRECTLY rather than relying on req.destroy()
  // to surface a req 'error'. When the response is already flowing, Node
  // emits 'aborted'/'close' on the RESPONSE, not 'error' on the request, so
  // the old code could leave the generator hanging on its waker promise
  // forever — the socket died but the for-await never ended, so the UI kept
  // showing "generating" and Stop appeared to do nothing.
  opts.signal?.addEventListener('abort', () => {
    queue.push({ type: 'error', error: 'aborted' });
    done = true;
    try { req.destroy(new Error('aborted')); } catch { /* already gone */ }
    wake();
  }, { once: true });
  req.write(body);
  req.end();

  while (true) {
    while (queue.length) yield queue.shift()!;
    if (done) return;
    await new Promise<void>(r => { waker = r; });
  }
}
