/**
 * Shared builder for an llm config block that points every tier at
 * a single openai-compat endpoint (e.g. one Ollama on :11434 serving
 * every model on demand). Extracted from `llm-setup.ts` +
 * `llm-setup-plan.ts` (the interactive wizard + the agent-friendly
 * planner each had a byte-identical copy).
 */

import type { CartographConfig } from '../types.js';

export interface SingleEndpointModels {
  embed: string;
  summarize: string;
  ask: string;
  reranker?: string;
}

export function buildSingleEndpointConfig(
  endpoint: string,
  models: SingleEndpointModels,
): NonNullable<CartographConfig['llm']> {
  const cfg: NonNullable<CartographConfig['llm']> = {
    summarizeLlm: { provider: 'openai-compat', endpoint, model: models.summarize },
    localLlm: { provider: 'openai-compat', endpoint, model: models.summarize },
    askLlm: { provider: 'openai-compat', endpoint, model: models.ask },
    embeddingLlm: { provider: 'openai-compat', endpoint, model: models.embed },
  };
  if (models.reranker) {
    cfg.rerankerLlm = { provider: 'openai-compat', endpoint, model: models.reranker };
  }
  return cfg;
}
