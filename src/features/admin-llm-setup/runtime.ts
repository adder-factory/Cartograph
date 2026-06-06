export type LlmSetupTier = 'embed' | 'chat' | 'ask' | 'reranker';

export type LlmTuneOverrideParseResult =
  | { ok: true; tier: LlmSetupTier; concurrency: number }
  | { ok: false; error: string };

const LLM_SETUP_TIERS = new Set<string>(['embed', 'chat', 'ask', 'reranker']);

export function parseLlmTuneOverride(options: { tier?: string; concurrency?: string }): LlmTuneOverrideParseResult {
  if (!options.tier || !LLM_SETUP_TIERS.has(options.tier)) {
    return { ok: false, error: '--tier must be one of embed, chat, ask, reranker' };
  }

  const concurrency = Number.parseInt(options.concurrency ?? '', 10);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return { ok: false, error: '--concurrency must be a positive integer when --tier is set' };
  }

  return { ok: true, tier: options.tier as LlmSetupTier, concurrency };
}
