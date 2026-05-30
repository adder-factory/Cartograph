/**
 * Single source of truth for the curated GGUF set cartograph recommends.
 * Users run one `llama-server -m <gguf> --port <port>` per tier (or
 * point an Ollama / mlx_lm / LM Studio instance at the same files);
 * cartograph talks to the resulting OpenAI-compat HTTP backends. The
 * installer downloads these into `~/.cartograph/models/` by canonical
 * filename; everything else (config defaults, status surfaces) reads
 * from here.
 *
 * Updating a model:
 *   1. Edit the constant below (filename + URL + size).
 *   2. Re-run `cartograph admin install-models` to download fresh.
 *
 * Why these picks (2026-05-14):
 *   - Qwen2.5-Coder 3B + 7B hybrid: the 3B carries volume work
 *     (summaries, classifier residue, commit-intent fallback,
 *     change-kind, bulk prose); the 7B handles `cartograph_ask` Q&A
 *     where higher reasoning matters. Verified via the bench arc.
 *   - jina-embeddings-v2-base-code: +25 pts recall@1 vs nomic-v1.5
 *     on the paraphrased-query bench at the same VRAM class. Trained
 *     at 8192 ctx so no n_ctx_seq>n_ctx_train warning.
 *   - bge-reranker-v2-m3: current SOTA small reranker; +3-5 pts NDCG
 *     vs bge-reranker-base. ~10ms/pair on Apple Silicon Q4.
 */

import * as path from 'node:path';
import * as os from 'node:os';

/** Filesystem dir cartograph reads / writes recommended GGUFs to.
 *  Override via env var `CARTOGRAPH_MODELS_DIR` for shared mounts. */
export const MODELS_DIR_DEFAULT: string =
  process.env['CARTOGRAPH_MODELS_DIR'] ?? path.join(os.homedir(), '.cartograph', 'models');

export interface RecommendedModel {
  /** Canonical filename under the models dir. Code reads by this name. */
  readonly filename: string;
  /** Direct download URL (HuggingFace `/resolve/main/` shape). */
  readonly hfUrl: string;
  /** Approximate on-disk size in MB. Used by the installer for the
   *  "this download is ~Nm MB" prompt. */
  readonly sizeMb: number;
  /** Short human-readable description shown in status / config UIs. */
  readonly description: string;
}

/** Chat backend for the high-volume work: symbol summaries, classifier
 *  residue, commit-intent fallback, change-kind, cartograph_local_chat.
 *  Mapped to `summarizeLlm` + `localLlm` slots. */
export const RECOMMENDED_CHAT_SUMMARIZE: RecommendedModel = {
  filename: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
  hfUrl:
    'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
  sizeMb: 2000,
  description: 'Qwen2.5-Coder-3B-Instruct — high-volume chat (summaries, classifier residue, bulk prose)',
};

/** Chat backend for higher-stakes Q&A. Mapped to the `askLlm` slot —
 *  fires for `cartograph_ask`. Worth the extra latency on user-facing
 *  flows; the 3B handles everything else. */
export const RECOMMENDED_CHAT_ASK: RecommendedModel = {
  filename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
  hfUrl:
    'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf',
  sizeMb: 4500,
  description: 'Qwen2.5-Coder-7B-Instruct — higher-stakes Q&A (cartograph_ask)',
};

/** Code-tuned embedding model. Replaces nomic-embed-text-v1.5 as the
 *  default after the 2026-05-14 head-to-head bench showed +25 pts
 *  recall@1 at the same VRAM. Native train ctx is 8192 so no
 *  n_ctx_seq>n_ctx_train warning. */
export const RECOMMENDED_EMBED: RecommendedModel = {
  filename: 'jina-embeddings-v2-base-code.Q4_K_M.gguf',
  hfUrl:
    'https://huggingface.co/second-state/jina-embeddings-v2-base-code-GGUF/resolve/main/jina-embeddings-v2-base-code-Q4_K_M.gguf',
  sizeMb: 110,
  description: 'jina-embeddings-v2-base-code — code-tuned 768-dim embedding',
};

/** Cross-encoder reranker. Off by default; opt in via `rerankerLlm`
 *  in config. bge-reranker-v2-m3 is the current SOTA small reranker. */
export const RECOMMENDED_RERANKER: RecommendedModel = {
  filename: 'bge-reranker-v2-m3-Q4_K_M.gguf',
  hfUrl: 'https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q4_K_M.gguf',
  sizeMb: 420,
  description: 'bge-reranker-v2-m3 — cross-encoder rerank for retrieval',
};

/** All four recommended models, in the order the installer should
 *  download them (smallest first so a slow connection produces visible
 *  progress quickly). */
export const RECOMMENDED_MODELS: readonly RecommendedModel[] = [
  RECOMMENDED_EMBED,
  RECOMMENDED_CHAT_SUMMARIZE,
  RECOMMENDED_RERANKER,
  RECOMMENDED_CHAT_ASK,
];

/** Minimal viable model subset: just embed + 3B chat. ~2.1 GB total
 *  vs the full set's ~7 GB. Drops the 7B chat (only `cartograph_ask`
 *  needs it; can be installed later) and the reranker (off by default
 *  in config). Gets a user to a functional install on a slow connection
 *  or constrained disk without a multi-GB wait. */
export const MINIMAL_MODELS: readonly RecommendedModel[] = [RECOMMENDED_EMBED, RECOMMENDED_CHAT_SUMMARIZE];

/** Absolute filesystem path for a recommended model under the models
 *  dir. Pure function — callers can compose with their own dir override. */
export function resolveRecommendedModelPath(model: RecommendedModel, dir: string = MODELS_DIR_DEFAULT): string {
  return path.join(dir, model.filename);
}
