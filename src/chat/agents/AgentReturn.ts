import { approxTokensStr } from '../MessageTokens';
import { maxOutputTokensFor } from '../Pricing';

const SAFETY_FRACTION = 0.10;
const OUTPUT_FRACTION = 0.10;

export interface ReturnBudgetInput {
  contextMax: number;
  runtimeTokens: number;
  fixedOverheadTokens?: number;
  remainingSiblings: number;
  model: string;
  upstreamBudgetTokens?: number;
}

export function returnBudget(input: ReturnBudgetInput): number {
  const outputReserve = Math.max(maxOutputTokensFor(input.model), Math.floor(input.contextMax * OUTPUT_FRACTION));
  const safetyReserve = Math.floor(input.contextMax * SAFETY_FRACTION);
  const available = Math.max(0,
    input.contextMax - input.runtimeTokens - (input.fixedOverheadTokens || 0) - outputReserve - safetyReserve);
  const shared = Math.floor(available / Math.max(1, input.remainingSiblings));
  return Math.max(0, Math.min(shared, input.upstreamBudgetTokens ?? Number.MAX_SAFE_INTEGER));
}

export function needsReturnSummary(text: string, budgetTokens: number): boolean {
  return budgetTokens > 0 && approxTokensStr(text) > budgetTokens;
}

export function splitForSummary(text: string, chunkTokens: number): string[] {
  const maxChars = Math.max(4000, chunkTokens * 4);
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n\n', end), text.lastIndexOf('\n', end));
      if (boundary > start + Math.floor(maxChars * 0.6)) end = boundary;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function buildReturnSummaryPrompt(task: string, text: string, budgetTokens: number): string {
  return [
    `Compress this sub-agent result so the complete output fits within ${budgetTokens} tokens.`,
    `Original task: ${task}`,
    'Preserve conclusions, quantitative results, benchmarks, model/paper/version names, URLs and citations, uncertainty, errors, blockers, and artifact/file paths.',
    'Remove duplicated search snippets, logs, narration, and repeated evidence. Return only the compressed handoff; do not add a preamble.',
    '',
    text,
  ].join('\n');
}
