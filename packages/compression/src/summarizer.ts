import type { CreateSummarizerOptions, Summarizer } from './types.js';

const DEFAULT_MAX_RESPONSE_TOKENS = 300;

type BuildPromptOpts = {
  systemPrompt?: string;
  mode?: 'normal' | 'aggressive';
  preserveTerms?: string[];
};

const BASE_TERMS = [
  'code references', 'file paths', 'function/variable names',
  'URLs', 'API keys', 'error messages', 'numbers', 'technical decisions',
];

function buildPrompt(text: string, maxResponseTokens: number, opts?: BuildPromptOpts): string {
  const prefix = opts?.systemPrompt ? `${opts.systemPrompt}\n\n` : '';
  const isAggressive = opts?.mode === 'aggressive';
  const tokenBudget = isAggressive ? Math.max(1, Math.floor(maxResponseTokens / 2)) : maxResponseTokens;
  const instruction = isAggressive
    ? 'Summarize the following conversation message as terse bullet points.'
    : 'Summarize the following conversation message concisely.';

  const extra = (opts?.preserveTerms ?? []).filter(t => !BASE_TERMS.includes(t));
  const allTerms = extra.length ? [...BASE_TERMS, ...extra] : BASE_TERMS;
  const preserveLine = allTerms.slice(0, -1).join(', ') + ', and ' + allTerms[allTerms.length - 1];

  return `${prefix}${instruction}
Keep the summary under ${tokenBudget} tokens.

Rules:
- Preserve all: ${preserveLine}
- Remove filler, pleasantries, and redundant explanations
- Keep the same technical register — do not simplify terminology
- Output ONLY the summary, no preamble

Text:
${text}`;
}

export function createSummarizer(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: CreateSummarizerOptions,
): Summarizer {
  const maxResponseTokens = options?.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS;
  const opts: BuildPromptOpts = {
    systemPrompt: options?.systemPrompt || undefined,
    mode: options?.mode,
    preserveTerms: options?.preserveTerms,
  };
  return (text: string) => callLlm(buildPrompt(text, maxResponseTokens, opts));
}

export function createEscalatingSummarizer(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: Omit<CreateSummarizerOptions, 'mode'>,
): Summarizer {
  const maxResponseTokens = options?.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS;
  const baseOpts: Omit<BuildPromptOpts, 'mode'> = {
    systemPrompt: options?.systemPrompt || undefined,
    preserveTerms: options?.preserveTerms,
  };

  return async (text: string): Promise<string> => {
    // Level 1: Normal
    try {
      const result = await callLlm(buildPrompt(text, maxResponseTokens, { ...baseOpts, mode: 'normal' }));
      if (typeof result === 'string' && result.length > 0 && result.length < text.length) return result;
    } catch { /* escalate to aggressive */ }

    // Level 2: Aggressive — errors propagate to withFallback (Level 3: deterministic)
    return callLlm(buildPrompt(text, maxResponseTokens, { ...baseOpts, mode: 'aggressive' }));
  };
}
