/**
 * Pricing — token-cost reference table + per-turn computeCost().
 *
 * Published list prices, used to show the user a per-turn USD estimate —
 * "this turn cost ~$X at list price" — so they can budget context size
 * before sending. Actual billing depends on whatever provider/plan the
 * user connected; this is a display-only estimate, not a real invoice.
 *
 * Cache pricing applies only to Anthropic models (a custom OpenAI-shaped
 * provider may or may not surface cache_* fields — we fall through to
 * zero when absent).
 *
 * Model IDs match what the proxy / model picker emits; aliases like
 * `claude-opus-4-8` and `claude-opus-4-7` share the same row because their
 * list prices are identical.
 */

export interface PricePerMTok {
  /** USD / 1M input tokens (excluding cache hits). */
  in:          number;
  /** USD / 1M output tokens. */
  out:         number;
  /** USD / 1M tokens when read from prompt cache (Anthropic only). */
  cacheRead?:  number;
  /** USD / 1M tokens when written to prompt cache (Anthropic only). */
  cacheWrite?: number;
}

/** Defaults — keep small + add new rows as the model picker gains entries. */
export const DEFAULT_PRICING: Record<string, PricePerMTok> = {
  // Claude — list prices Anthropic publishes; cache rates are roughly
  // 10× cheaper read / 1.25× write per public docs.
  'claude-opus-4-8':   { in: 5.00, out: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-7':   { in: 5.00, out: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-6':   { in: 5.00, out: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5':  { in: 1.00, out:  5.00, cacheRead: 0.10, cacheWrite: 1.25 },

  // GPT family — Renesas Playground exposes these via the OpenAI-shaped
  // adapter; cache fields don't apply.
  'gpt-5.6-sol':       { in: 1.25, out: 10.00 },
  'gpt-5.6-luna':      { in: 1.25, out: 10.00 },
  'gpt-5.6-terra':     { in: 1.25, out: 10.00 },
  'gpt-5.5':           { in: 1.25, out: 10.00 },
  'gpt-5.4':           { in: 1.25, out: 10.00 },
  'gpt-5.4-mini':      { in: 0.25, out:  2.00 },
  'gpt-5.2':           { in: 0.50, out:  4.00 },
};

/** Resolve a price entry, falling back to sonnet-4-6 if model unknown.
 *  Strip a leading `databricks-` (some Renesas surfaces use it as a
 *  routing prefix) before lookup. */
export function priceFor(model: string): PricePerMTok {
  const norm = model.replace(/^databricks-/, '');
  return DEFAULT_PRICING[norm] ?? DEFAULT_PRICING['claude-sonnet-4-6'];
}

/** Per-turn usage shape — matches what ChatStreamer extracts from the
 *  proxy's `message_delta.usage`. inTokens excludes cache hits. */
export interface TurnUsage {
  inTokens:    number;
  outTokens:   number;
  cacheRead?:  number;
  cacheWrite?: number;
}

/** Compute USD cost for a single turn given Anthropic-shaped usage stats. */
export function computeCost(model: string, usage: TurnUsage): number {
  const p = priceFor(model);
  const m = (toks: number, rate: number) => (toks / 1_000_000) * rate;
  return (
    m(usage.inTokens,            p.in) +
    m(usage.outTokens,           p.out) +
    m(usage.cacheRead  ?? 0,     p.cacheRead  ?? 0) +
    m(usage.cacheWrite ?? 0,     p.cacheWrite ?? 0)
  );
}

/** "$0.00123" → "$0.00" / "$1.23" → "$1.23". Max 4 decimals so a tiny
 *  Haiku turn still shows as nonzero. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01)   return `$${usd.toFixed(4)}`;
  if (usd < 1)      return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Effective context window per model, in tokens. We send messages +
 *  system + tools through this — when the request would exceed the cap
 *  the gateway 400's. (#19 in 0.4.1 — surface a warning before that.)
 *
 *  0.4.197 — verified against vendor docs 2026-07:
 *    • Opus 4.7 / 4.8 and Sonnet 4.6 ship with a 1M window by default.
 *    • Fable 5, Mythos 5, GPT-5.5 / 5.4 also 1M.
 *    • Older Opus 4.6 / Sonnet 4.5 / Haiku 4.5 remain at 200K.
 *  Prior versions hard-capped everything at 200K, which caused compact
 *  auto-trigger to fire ~5× too early on Opus 4.7 (bug parity with the
 *  Claude Code 2.1.111 → 2.1.117 fix). */
export const CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-5':     1_000_000,
  'claude-sonnet-5':   1_000_000,
  'claude-opus-4-8':   1_000_000,
  'claude-opus-4-7':   1_000_000,
  'claude-opus-4-6':   200_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5':  200_000,
  'claude-fable-5':    1_000_000,
  'gpt-5.6-sol':       1_000_000,
  'gpt-5.6-luna':      1_000_000,
  'gpt-5.6-terra':     1_000_000,
  'gpt-5.5':           1_000_000,
  'gpt-5.4':           1_000_000,
  'gpt-5.4-mini':      1_000_000,
  'gpt-5.2':           128_000,
};

/** 0.4.197 — host.yaml `ui_models` overrides. Populated at boot via
 *  setContextWindowOverrides(). Lookup precedence: overrides → static
 *  CONTEXT_WINDOW → 200K default. */
let CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {};
export function setContextWindowOverrides(map: Record<string, number>) {
  CONTEXT_WINDOW_OVERRIDES = map || {};
}
export function contextWindowFor(model: string): number {
  const norm = model.replace(/^databricks-/, '');
  return CONTEXT_WINDOW_OVERRIDES[norm] ?? CONTEXT_WINDOW[norm] ?? 200_000;
}

/** Anthropic hard cap on output tokens per /v1/messages call, per model.
 *  Requesting a max_tokens above the model's ceiling returns a 400 from
 *  the gateway, so we clamp on send.  These are the Claude 4.x extended-
 *  output caps published by Anthropic (Jan 2026). */
export const MAX_OUTPUT_TOKENS: Record<string, number> = {
  'claude-opus-4-8':   32_000,
  'claude-opus-4-7':   32_000,
  'claude-opus-4-6':   32_000,
  'claude-sonnet-4-6': 64_000,
  'claude-sonnet-4-5': 64_000,
  'claude-haiku-4-5':   8_192,
  'claude-fable-5':    64_000,
};
export function maxOutputTokensFor(model: string): number {
  const norm = model.replace(/^databricks-/, '');
  // 16k is the safe fallback for any model whose cap we haven't recorded
  // (still 4× the previous hardcoded 4096, well under any current cap).
  return MAX_OUTPUT_TOKENS[norm] ?? 16_384;
}
