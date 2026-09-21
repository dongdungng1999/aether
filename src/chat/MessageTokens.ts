/**
 * MessageTokens — approximate per-message token counting.
 *
 * Anthropic doesn't expose a client-side tokenizer, so we use the standard
 * chars/4 heuristic (their published rule of thumb — good enough within
 * ~15% for English/Vietnamese prose; images count separately). This is
 * the ONE place that estimates message weight so compact / pruneHistory /
 * ledger all agree on the same numbers.
 */
import { ChatMessage, ContentBlock } from './ChatStreamer';

export function approxTokensStr(s: string): number {
  return Math.ceil((s || '').length / 4);
}

/** Approximate the token cost of Anthropic tool definitions. Tool schemas are
 *  sent with every request, so context-pressure estimates need to include them
 *  alongside system prompt and runtime messages. */
export function approxTokensForTools(defs: any[] | undefined | null): number {
  if (!Array.isArray(defs) || defs.length === 0) return 0;
  let n = 0;
  for (const d of defs) {
    n += approxTokensStr(String(d?.name || ''));
    n += approxTokensStr(String(d?.description || ''));
    n += approxTokensStr(JSON.stringify(d?.input_schema || {}));
    n += 20; // structural overhead per tool entry
  }
  return n;
}

/** Approximate the tokens contributed by ONE message when it's sent to
 *  the model. Sums every block type; images count as a flat 250 (rough
 *  average — actual varies by dimensions but the model doesn't tell us). */
export function approxTokensForMsg(m: ChatMessage): number {
  if (typeof m.content === 'string') return approxTokensStr(m.content);
  let n = 0;
  for (const b of m.content as ContentBlock[]) {
    const t = (b as any)?.type;
    if (t === 'text')             n += approxTokensStr((b as any).text || '');
    else if (t === 'thinking')    n += approxTokensStr((b as any).thinking || '');
    else if (t === 'tool_use')    n += approxTokensStr(JSON.stringify((b as any).input || {}));
    else if (t === 'tool_result') {
      const c = (b as any).content;
      n += approxTokensStr(typeof c === 'string' ? c : JSON.stringify(c || ''));
    }
    else if (t === 'image')       n += 250;
  }
  return n;
}

/** Sum of approxTokensForMsg across a slice. */
export function approxTokensForMsgs(msgs: ChatMessage[]): number {
  let n = 0;
  for (const m of msgs) n += approxTokensForMsg(m);
  return n;
}
