# 0001 — Keep llama.cpp as the default local-LLM backend; treat MLX as opt-in

- **Status:** Accepted
- **Date:** 2026-06-18
- **Scope:** Local LLM serving for the four tiers — chat (`summarizeLlm` / `askLlm` / `localLlm` / `classifyLlm`), `embeddingLlm`, and `rerankerLlm`.

## Context

Cartograph ships with a recommended local stack of `llama-server` (llama.cpp)
processes serving GGUF models behind the `openai-compat` provider:

| Tier | Default model (GGUF, Q4_K_M) | Default endpoint |
|------|------------------------------|------------------|
| Embedding | `jina-embeddings-v2-base-code` | `http://localhost:8080` |
| Chat / summarize | `Qwen3-4B-Instruct-2507` | `http://localhost:8081` |
| Ask | `Qwen2.5-Coder-7B-Instruct` | `http://localhost:8082` |
| Reranker | cross-encoder | `http://localhost:8083` |

We evaluated replacing this with [Apple MLX](https://github.com/ml-explore/mlx)
(`mlx_lm.server` and the `mlx-embeddings` ecosystem) to exploit MLX's
hand-tuned Metal kernels on Apple Silicon.

## What we found

**The integration code is already MLX-ready.** The LLM layer talks to backends
through the official `openai` SDK with a `baseURL` override — there are no
llama-server-specific assumptions in the HTTP path. MLX is already a recognized
backend: `MLX_DEFAULT_ENDPOINT = http://localhost:8000`
(`src/installer/default-endpoints.ts`), and the backend-scan / `doctor` probe
already identifies `mlx_lm` by its `Server` header. So pointing a tier at an
MLX server is, at the code level, a config change.

The blockers are not in our code — they are in the model/runtime story, and
they differ sharply per tier:

| Tier | Code effort | Model story | Net effort | Speed payoff |
|------|-------------|-------------|------------|--------------|
| **Chat** | Pure config | 4-bit MLX builds exist (`mlx-community/Qwen3-4B-Instruct-2507-4bit`, `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit`) | Low | ~1.5× faster generation vs raw llama.cpp on these small models — **but** see packaging + prefill caveats |
| **Embedding** | Pure config (`/v1/embeddings` via `mlx-openai-server` / `vllm-mlx`) | ❌ `jina-embeddings-v2-base-code` **cannot run on MLX** — JinaBERT + ALiBi is unsupported by `mlx-embeddings`; no port exists | High | Negligible at ~161M params / single short forward pass |
| **Reranker** | Needs Cohere-shaped `/v1/rerank`; MLX has no turnkey equivalent | `vllm-mlx` ships `/v1/rerank` for BGE/cross-encoders; native `jina-reranker-v3-mlx` is Python-API-only (no HTTP) | Medium | Negligible at this model size |

Two pivots dominate the decision — and neither is per-token speed:

1. **Packaging.** llama.cpp ships as one standalone C++ binary that Cartograph
   already bundles. MLX is a hard Python-runtime dependency (`mlx`, `mlx-lm`,
   `transformers`, `tokenizers`, …) — version-skew risk and the end of
   single-artifact distribution. Independent comparisons single out
   "standalone-binary distribution" as exactly llama.cpp's home turf.
2. **The embedding tier forces a model migration, not a runtime swap.** Our
   code-embedding model has no MLX path. Moving to a Qwen-family code embedder
   (`jina-code-embeddings-1.5b` or `Qwen3-Embedding`) would change the
   embedding vectors and therefore require **re-indexing the whole graph** plus
   a retrieval-quality A/B — a real project, for a tier where MLX's speed
   advantage is small-to-negligible on a single short forward pass.

A secondary caveat: MLX's prefill / long-context throughput is weaker than
llama.cpp + FlashAttention (~50% slower past ~30K tokens), which is the regime
the `askLlm` tier hits when answering over large pasted code context.

## Decision

Keep **llama.cpp / `llama-server` (GGUF) as the shipped default** for all four
tiers. Do **not** bundle MLX or take on a Python runtime dependency.

MLX remains **opt-in and externally managed** (the same posture as Ollama / LM
Studio): a user who runs their own `mlx_lm.server` can repoint the chat tiers
at it with **zero code changes** by editing `.cartograph/config.json`, e.g.:

```json
{
  "llm": {
    "summarizeLlm": {
      "provider": "openai-compat",
      "endpoint": "http://localhost:8000",
      "model": "mlx-community/Qwen3-4B-Instruct-2507-4bit"
    },
    "askLlm": {
      "provider": "openai-compat",
      "endpoint": "http://localhost:8000",
      "model": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit"
    }
  }
}
```

`cartograph backend` will not manage the MLX process (it only spawns/tracks
`llama-server` with absolute GGUF paths + localhost), and `cartograph admin
install-models` will not fetch MLX weights (GGUF only) — both are expected and
acceptable for an externally-managed backend.

## Consequences

- No change to the default install, packaging, or distribution model.
- The chat-tier generation-speed win (~1.5×) is available today to anyone
  willing to run MLX themselves — without Cartograph owning the dependency.
- Embedding and reranker tiers stay on llama.cpp; revisiting them would require
  a model migration + full re-index, justified only by a future all-MLX
  consolidation, not by raw speed.

## If we ever revisit

The lowest-risk experiment is narrow: **chat-tier-only, opt-in, documented —
not bundled.** Before committing to any MLX embedding/reranker path, verify on a
test box (these were "convertible in principle" findings, not validated
conversions): a clean MLX conversion of `jina-code-embeddings-1.5b` with
last-token pooling + instruction prefixes intact, and the current `vllm-mlx`
`/v1/rerank` code path for a BGE-style cross-encoder.
