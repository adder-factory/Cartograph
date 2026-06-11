/**
 * Centralised well-known LLM backend endpoints. Imported by the
 * installer / setup-planner / doctor / provider code so we don't
 * have to keep N copies of `'http://localhost:11434'` floating
 * around (which the `hardcoded_url` biomarker correctly flags as
 * a smell when it clusters).
 *
 * These are the BACKEND defaults — the per-port shape each
 * supported backend ships with out of the box. Cartograph's
 * recommended layout (one llama-server per tier on consecutive
 * ports) is built on top of `DEFAULT_LLAMA_SERVER_ENDPOINT` +
 * `+1/+2/+3` per tier; see `recommended-config.ts` for the
 * per-tier-port mapping.
 */

/** Ollama's default HTTP server port. Single endpoint serves every
 *  tier — model swap is handled by Ollama internally. */
export const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434';

/** llama-cpp's `llama-server` default — alias of the embed-tier
 *  endpoint. Kept as the public "single-endpoint" reference name. */
export const LLAMA_SERVER_DEFAULT_ENDPOINT = 'http://localhost:8080';

/** Per-tier llama-server endpoints — cartograph's recommended layout
 *  is one server per tier on consecutive ports. Imported by the
 *  recommended-config builder + the setup-planner so the 4 URLs
 *  live in exactly one place (the `hardcoded_url` biomarker
 *  correctly flags clusters of these). */
export const LLAMA_SERVER_EMBED_ENDPOINT = LLAMA_SERVER_DEFAULT_ENDPOINT;
export const LLAMA_SERVER_SUMMARIZE_ENDPOINT = 'http://localhost:8081';
export const LLAMA_SERVER_ASK_ENDPOINT = 'http://localhost:8082';
export const LLAMA_SERVER_RERANKER_ENDPOINT = 'http://localhost:8083';

/** Apple MLX's `mlx_lm.server` + vLLM default. One model per
 *  process; users wanting per-tier routing run multiple servers on
 *  separate ports + hand-edit the per-tier endpoints. */
export const MLX_DEFAULT_ENDPOINT = 'http://localhost:8000';

/** Cloud OpenAI public API base — used in summaries + the
 *  cloud-openai preset's documentation strings. The OpenAI SDK
 *  defaults to this when `endpoint` is omitted from the config;
 *  exposed here for prose-only references. */
export const CLOUD_OPENAI_PUBLIC_ENDPOINT = 'https://api.openai.com';

/** OpenAI's API-key creation URL — surfaced in the setup-planner
 *  next-steps for users who haven't set OPENAI_API_KEY yet. */
export const CLOUD_OPENAI_KEYS_URL = 'https://platform.openai.com/api-keys';

/** OpenRouter public API base — one Bearer key in front of hundreds
 *  of hosted models behind an OpenAI-compat chat surface. Written into
 *  the cloud-openrouter preset's config explicitly (the OpenAI SDK
 *  has no OpenRouter default); the SDK base-URL normaliser appends
 *  the `/v1` suffix. */
export const CLOUD_OPENROUTER_PUBLIC_ENDPOINT = 'https://openrouter.ai/api';

/** OpenRouter's API-key creation URL — surfaced in the setup-planner
 *  next-steps for users who haven't set OPENROUTER_API_KEY yet. */
export const CLOUD_OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

/** Cloud-openai-compat preset placeholder. The wizard writes this
 *  into the config as a "you must edit this" sentinel; doctor
 *  flags it as unreachable so the user sees an actionable
 *  remediation instead of silent breakage. */
export const OPENAI_COMPAT_PLACEHOLDER_ENDPOINT = 'https://YOUR-PROVIDER.example/v1';
