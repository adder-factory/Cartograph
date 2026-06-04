/** Ollama model ids that match Cartograph's recommended local tiers.
 *  Reranker is intentionally omitted: Ollama does not expose
 *  `/v1/rerank` today. */
export const OLLAMA_RECOMMENDED_MODELS = {
  embed: 'nomic-embed-text',
  summarize: 'qwen2.5-coder:3b',
  ask: 'qwen2.5-coder:7b',
} as const;

/** MLX setup guidance uses Hugging Face-style ids rather than GGUF
 *  paths or Ollama tags. */
export const MLX_RECOMMENDED_MODELS = {
  embed: 'nomic-embed-text',
  summarize: 'qwen2.5-coder-3b',
  ask: 'qwen2.5-coder-7b',
} as const;

/** llama.cpp accepts both `--rerank` and `--reranking`; keep one
 *  spelling so setup guidance does not drift between surfaces. */
export const LLAMA_SERVER_RERANK_FLAG = '--reranking';
