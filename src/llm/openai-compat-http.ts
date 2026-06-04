import OpenAI from 'openai';
import { LlmEndpointError } from './client.js';

export const OPENAI_LOCAL_BACKEND_API_KEY = 'unused-local-backend';

export function normaliseOpenAiSdkBaseUrl(endpoint: string): string {
  const stripped = stripTrailingSlash(endpoint);
  return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
}

export function normaliseOpenAiCompatFetchBaseUrl(endpoint: string): string {
  const stripped = stripTrailingSlash(endpoint);
  return stripped.endsWith('/v1') ? stripped.slice(0, -3) : stripped;
}

function stripTrailingSlash(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
}

export function resolveOpenAiCompatTimeout(configuredTimeoutMs: number | undefined, defaultTimeoutMs: number): number {
  return configuredTimeoutMs && configuredTimeoutMs > 0 ? configuredTimeoutMs : defaultTimeoutMs;
}

export function assertOpenAiCompatEndpointOrApiKey(
  cfg: { endpoint?: string; apiKey?: string },
  capability: string,
  configLabel: string,
): void {
  if (cfg.endpoint || cfg.apiKey) return;
  throw new LlmEndpointError(
    `openai-compat ${capability} requires either \`endpoint\` (for local backends like ` +
      `llama-server / Ollama / mlx_lm) or \`apiKey\` (for cloud OpenAI-compatible providers). ` +
      `Neither is set in ${configLabel}.`,
  );
}

export function createOpenAiCompatSdkClient(cfg: { endpoint?: string; apiKey?: string }, timeoutMs: number): OpenAI {
  return new OpenAI({
    ...(cfg.endpoint ? { baseURL: normaliseOpenAiSdkBaseUrl(cfg.endpoint) } : {}),
    apiKey: cfg.apiKey ?? OPENAI_LOCAL_BACKEND_API_KEY,
    timeout: timeoutMs,
    // No SDK-level retries: Cartograph's batch callers handle retry and
    // fallback at their own boundary, avoiding multiplied latency/billing.
    maxRetries: 0,
  });
}

export async function probeOpenAiCompatModels(client: OpenAI, timeoutMs: number): Promise<void> {
  await client.models.list({ timeout: Math.min(timeoutMs, 5_000) });
}

export function openAiApiErrorToEndpointError(prefix: string, err: Error & { status?: unknown }): LlmEndpointError {
  const statusLabel =
    typeof err.status === 'number' || typeof err.status === 'string' ? err.status : 'connection error';
  return new LlmEndpointError(
    `${prefix} endpoint returned ${statusLabel}: ${err.message}`,
    typeof err.status === 'number' ? err.status : undefined,
  );
}
