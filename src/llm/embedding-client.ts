/**
 * Embedding client factory.
 *
 * Only one backend after 2026-05-24c (step 4c of the migration —
 * see `project_llm_pivot_to_llama_server` in auto-memory): HTTP via
 * the official `openai` npm SDK with `baseURL` override. Works
 * against llama-cpp `llama-server`, Ollama, Apple MLX
 * `mlx_lm.server`, LM Studio, vLLM, LocalAI, plus any
 * OpenAI-compatible cloud provider. Codebase symmetry with
 * `@anthropic-ai/sdk` for Claude.
 */

import type { EmbeddingProviderConfig } from './client.js';
import { LlmEndpointError } from './client.js';
import { OpenAiSdkEmbeddingClient } from './openai-sdk-embedding-client.js';
import { LLAMA_SERVER_DEFAULT_ENDPOINT } from '../installer/default-endpoints.js';

/**
 * Common public surface every embedding backend must implement.
 * `OpenAiSdkEmbeddingClient` (HTTP via the official `openai` SDK)
 * implements this interface; the {@link createEmbeddingClient}
 * factory returns it (or a null stub when no config is set).
 */
export interface EmbeddingProvider {
  readonly isConfigured: boolean;
  embed(inputs: string[], opts?: { signal?: AbortSignal }): Promise<Float32Array[]>;
  isReachable(): Promise<boolean>;
  /**
   * The error from the most recent failed `isReachable()` call, or
   * `null` when reachable / not yet probed. Lets callers fold the
   * underlying cause into their own user-facing error message
   * instead of a generic "backend not reachable" line.
   */
  reachabilityError(): string | null;
  listModels(): Promise<string[]>;
}

/**
 * Build the embedding client from config.
 * - `cfg null` → null-provider stub (isConfigured=false, embed rejects).
 * - `cfg.provider === 'openai-compat'` → `OpenAiSdkEmbeddingClient` (HTTP via `openai` SDK).
 * Any other provider value throws a clear `LlmEndpointError`.
 */
export function createEmbeddingClient(cfg: EmbeddingProviderConfig | null): EmbeddingProvider {
  if (!cfg) return new NullEmbeddingClient();
  if (cfg.provider === 'openai-compat') return new OpenAiSdkEmbeddingClient(cfg);
  throw new LlmEndpointError(
    `unsupported embedding provider "${cfg.provider}" — set embeddingLlm.provider to "openai-compat" (HTTP to llama-server / Ollama / mlx_lm / cloud). Also set embeddingLlm.endpoint (e.g. ${LLAMA_SERVER_DEFAULT_ENDPOINT} for llama-server) + embeddingLlm.model.`,
  );
}

/**
 * Null-provider stub returned when no embedding config is supplied.
 * `isConfigured` is false; `embed()` rejects with a clear error.
 */
class NullEmbeddingClient implements EmbeddingProvider {
  readonly isConfigured = false;

  async embed(_inputs: string[]): Promise<Float32Array[]> {
    throw new LlmEndpointError('embedding provider not configured');
  }

  async isReachable(): Promise<boolean> {
    return false;
  }

  reachabilityError(): string | null {
    return 'no embedding provider configured';
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}
