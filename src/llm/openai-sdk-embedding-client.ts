/**
 * OpenAI-compatible HTTP embedding client built on the official
 * `openai` npm SDK with `baseURL` override.
 *
 * Talks to any backend exposing OpenAI's `POST /v1/embeddings`:
 *   - llama-cpp's `llama-server` (`http://localhost:8080`)
 *   - Ollama (`http://localhost:11434`)
 *   - Apple MLX's `mlx_lm.server` (`http://localhost:8000`)
 *   - LM Studio, vLLM, LocalAI, llamafile — same pattern
 *   - OpenAI itself + cloud OpenAI-compat (together.ai, fireworks.ai,
 *     groq) — set `apiKey`, omit `endpoint` for OpenAI.
 *
 * Migration arc 2026-05-24c: replaces the in-process
 * `LocalEmbeddingClient` (Bun.ffi + libcgshim). See
 * `project_llm_pivot_to_llama_server.md` in the auto-memory for the
 * full rationale; tl;dr: Bun.ffi blocks the JS thread for the entire
 * duration of every `llama_decode` call, so the in-process design
 * can't realise the parallelism the codebase pretended to provide.
 * Moving to HTTP gives clean process isolation + leverages each
 * backend's mature continuous-batching scheduler.
 *
 * Why the SDK over hand-rolled `fetch`: codebase symmetry with the
 * `@anthropic-ai/sdk` (already a dep, used for Claude); never debug
 * upstream OpenAI-API quirks ourselves; structured outputs / tool use
 * / streaming all free if/when we need them; cloud-portable for free.
 */

import OpenAI from 'openai';
import type { EmbeddingProviderConfig } from './client.js';
import { LlmEndpointError } from './client.js';
import { scanForLlmBackends } from '../installer/scan-backends.js';
import { buildReachabilityError } from './reachability-helpers.js';
import { logWarn } from '../errors.js';

/** Default per-request timeout. Embeddings normally complete sub-second
 *  locally; 60s gives comfortable headroom for cold-start model loads
 *  on the server side. Override via `cfg.timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Max characters per input before hard-truncate. Mirrors the
 *  in-process cap so callers see no behaviour change at the API
 *  boundary. */
const MAX_INPUT_CHARS = 8000;

/** Inputs per HTTP request. All target backends accept arrays via the
 *  `input: string[]` form; batching trades a few requests for the
 *  per-request HTTP overhead. 64 is the sweet spot empirically —
 *  llama-server's continuous-batching scheduler runs ~16 sequences
 *  in parallel inside one request, so 64 ≈ 4 internal batches. */
const HTTP_BATCH_SIZE = 64;

/** Strip a trailing slash from `baseURL` so callers can pass either
 *  `http://localhost:8080` or `http://localhost:8080/` without
 *  artefacts in the SDK's URL construction. */
function normaliseBaseUrl(endpoint: string): string {
  // The OpenAI SDK appends `/v1/embeddings` itself. We pass the base
  // URL ending in `/v1` per the SDK convention (matches how Ollama,
  // llama-server, mlx_lm document their endpoints).
  const stripped = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
}

/**
 * HTTP embedding client with the same public surface as the deprecated
 * in-process `LocalEmbeddingClient`. Routed via the `embedding-client.ts`
 * factory when `cfg.provider === 'openai-compat'`.
 */
export class OpenAiSdkEmbeddingClient {
  private readonly cfg: EmbeddingProviderConfig;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private lastReachabilityError: string | null = null;

  constructor(cfg: EmbeddingProviderConfig) {
    this.cfg = cfg;
    // `endpoint` is REQUIRED for local-backend configs; cloud OpenAI
    // users can omit it (SDK defaults to api.openai.com) but they
    // must set `apiKey`. Either an endpoint OR an apiKey must be set.
    if (!cfg.endpoint && !cfg.apiKey) {
      throw new LlmEndpointError(
        `openai-compat embedding requires either \`endpoint\` (for local backends like ` +
          `llama-server / Ollama / mlx_lm) or \`apiKey\` (for cloud OpenAI / together.ai / ` +
          `fireworks.ai). Neither is set in embeddingLlm config.`,
      );
    }
    this.timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
    // The SDK requires SOME value for `apiKey`; local backends ignore
    // it but the SDK validates it's non-empty. Use a literal sentinel
    // when the caller didn't set one.
    this.client = new OpenAI({
      ...(cfg.endpoint ? { baseURL: normaliseBaseUrl(cfg.endpoint) } : {}),
      apiKey: cfg.apiKey ?? 'unused-local-backend',
      timeout: this.timeoutMs,
      // No retries by default — cartograph's higher layers (e.g.
      // `embed-pipeline.ts`) already handle batch-level retry via the
      // per-row fallback path. SDK retries would multiply latency on
      // transient backend hiccups.
      maxRetries: 0,
    });
  }

  get isConfigured(): boolean {
    return typeof this.cfg.model === 'string' && this.cfg.model.length > 0;
  }

  /**
   * Embed N texts via the OpenAI-compat `/v1/embeddings` endpoint.
   * Splits into HTTP batches of {@link HTTP_BATCH_SIZE} to balance
   * request count against per-batch latency. Returns one Float32Array
   * per input in input order.
   *
   * Errors from the SDK wrap into `LlmEndpointError` carrying the
   * upstream HTTP status code (so retry / fallback logic can switch
   * on 429 / 5xx without re-parsing).
   */
  async embed(inputs: string[], opts: { signal?: AbortSignal } = {}): Promise<Float32Array[]> {
    if (!this.isConfigured) throw new LlmEndpointError('embedding provider not configured (model field is empty)');
    if (inputs.length === 0) return [];
    if (opts.signal?.aborted) throw new Error('embed aborted');

    const safeInputs = inputs.map((s) => (s.length > MAX_INPUT_CHARS ? s.slice(0, MAX_INPUT_CHARS) : s));
    const out: Float32Array[] = new Array(safeInputs.length);

    for (let i = 0; i < safeInputs.length; i += HTTP_BATCH_SIZE) {
      if (opts.signal?.aborted) throw new Error('embed aborted');
      const batch = safeInputs.slice(i, i + HTTP_BATCH_SIZE);
      const vecs = await this.embedBatch(batch, opts.signal);
      for (let j = 0; j < vecs.length; j++) {
        out[i + j] = vecs[j]!;
      }
    }

    return out;
  }

  /**
   * Lightweight reachability probe — uses the SDK's `models.list()`
   * which hits `GET /v1/models`. Most backends expose this; the
   * SDK's own error becomes our reachability signal.
   *
   * On failure, scans for OTHER OpenAI-compat backends running on
   * common ports (Ollama, llama-server, mlx_lm, LM Studio, LocalAI)
   * and folds their URLs into the error message so users know which
   * alternatives are already available without having to re-Google.
   * The scan adds ~1s to the failure path; the success path is
   * unaffected.
   */
  async isReachable(): Promise<boolean> {
    if (!this.isConfigured) {
      this.lastReachabilityError = 'embedding provider not configured (model field is empty)';
      return false;
    }
    try {
      // models.list returns a paginator; awaiting it performs the request and
      // parses the body — that alone confirms 2xx + reachability.
      await this.client.models.list({ timeout: Math.min(this.timeoutMs, 5_000) });
      this.lastReachabilityError = null;
      return true;
    } catch (err) {
      const baseMsg = err instanceof Error ? err.message : String(err);
      // Scan for what IS running on common ports — surfaces "Ollama
      // is up on 11434, point your config there" guidance instead of
      // the bare "connection refused" the SDK would emit.
      const alternatives = await scanForLlmBackends();
      const endpointLabel = this.cfg.endpoint ?? '(OpenAI default)';
      this.lastReachabilityError = buildReachabilityError({
        endpointLabel,
        baseMsg,
        alternatives,
        configField: 'embeddingLlm.endpoint',
        installHint: '`brew install llama.cpp` then `llama-server -m <GGUF> --port 8080 --embeddings`',
      });
      logWarn('OpenAiSdkEmbeddingClient: endpoint not reachable', {
        baseURL: this.cfg.endpoint ?? '(default)',
        error: baseMsg,
        detectedAlternatives: alternatives.length,
      });
      return false;
    }
  }

  reachabilityError(): string | null {
    return this.lastReachabilityError;
  }

  async listModels(): Promise<string[]> {
    try {
      const out: string[] = [];
      const page = await this.client.models.list();
      for await (const m of page) {
        if (typeof m.id === 'string') out.push(m.id);
      }
      return out.length > 0 ? out : this.cfg.model ? [this.cfg.model] : [];
    } catch {
      // Some backends (older mlx_lm, llamafile) don't expose
      // /v1/models. Fall back to the configured model.
      return this.cfg.model ? [this.cfg.model] : [];
    }
  }

  private async embedBatch(batch: string[], signal: AbortSignal | undefined): Promise<Float32Array[]> {
    try {
      const res = await this.client.embeddings.create(
        {
          model: this.cfg.model,
          input: batch,
          // Force `float` even though the SDK defaults to `base64`
          // for bandwidth perf. Two reasons: (1) some local backends
          // (older mlx_lm, certain llamafile builds) don't support
          // base64 encoding and return float arrays regardless,
          // which the SDK then mis-decodes as bad base64; (2) we run
          // against localhost so bandwidth isn't a concern, and the
          // float-array response shape is what every backend
          // implements natively.
          encoding_format: 'float',
        },
        signal ? { signal } : undefined,
      );
      if (!res.data || res.data.length !== batch.length) {
        throw new LlmEndpointError(
          `embedding endpoint returned ${res.data?.length ?? 'no'} vectors for ${batch.length} inputs`,
        );
      }
      return res.data.map((entry, i) => {
        if (!entry?.embedding) {
          throw new LlmEndpointError(`embedding endpoint returned missing embedding at index ${i}`);
        }
        // The SDK types `embedding` as `number[]`. Convert to
        // Float32Array to match the in-process `LocalEmbeddingClient`
        // surface (so downstream code doesn't branch on backend).
        const arr = entry.embedding as number[];
        const f32 = new Float32Array(arr.length);
        for (let j = 0; j < arr.length; j++) f32[j] = arr[j]!;
        return f32;
      });
    } catch (err) {
      // Surface OpenAI SDK errors with their status code wrapped in
      // our typed error class so the upstream retry / fallback can
      // branch cleanly. The SDK throws `OpenAI.APIError` subclasses
      // (`APIConnectionError`, `RateLimitError`, etc.); they all
      // carry a numeric `status` (or undefined for connection errors).
      if (err instanceof OpenAI.APIError) {
        throw new LlmEndpointError(
          `embedding endpoint returned ${err.status ?? 'connection error'}: ${err.message}`,
          typeof err.status === 'number' ? err.status : undefined,
        );
      }
      if (err instanceof LlmEndpointError) throw err;
      // Other errors (abort, network failure outside the SDK's
      // catch path) get re-thrown verbatim.
      throw err;
    }
  }
}
