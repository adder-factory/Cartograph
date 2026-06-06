/**
 * Shared LLM failure classifiers.
 *
 * Workers should not each carry their own regex for the same backend
 * failure family. These helpers intentionally classify by observable
 * endpoint message because local OpenAI-compatible backends vary in
 * status codes and error body shapes.
 */

import { LlmEndpointError } from './client.js';

const CONTEXT_WINDOW_ERROR_RE =
  /\b(?:exceeds? the available context size|maximum context length|context window|context size|too many tokens|prompt is too long|requested tokens.*exceed)\b/i;

const INPUT_TOO_LARGE_ERROR_RE =
  /too large to process|exceeds.*batch size|input.*length.*exceeds|context length|physical batch size/i;

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_CONFLICT = 409;
const HTTP_TOO_EARLY = 425;
const HTTP_RATE_LIMITED = 429;
const HTTP_SERVER_ERROR_FLOOR = 500;

export function isContextWindowError(err: unknown): boolean {
  return err instanceof LlmEndpointError && CONTEXT_WINDOW_ERROR_RE.test(err.message);
}

export function isInputTooLargeError(err: unknown): boolean {
  return err instanceof LlmEndpointError && INPUT_TOO_LARGE_ERROR_RE.test(err.message);
}

export function isTransientLlmEndpointError(err: unknown): boolean {
  if (!(err instanceof LlmEndpointError)) return false;
  if (err.status === undefined) return /timeout|timed out|connection|ECONN|socket|fetch failed/i.test(err.message);
  return (
    err.status === HTTP_REQUEST_TIMEOUT ||
    err.status === HTTP_CONFLICT ||
    err.status === HTTP_TOO_EARLY ||
    err.status === HTTP_RATE_LIMITED ||
    err.status >= HTTP_SERVER_ERROR_FLOOR
  );
}

export async function withTransientLlmRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number; onRetry?: (err: LlmEndpointError, attempt: number) => void } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const delayMs = Math.max(0, options.delayMs ?? 250);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof LlmEndpointError) || !isTransientLlmEndpointError(err) || attempt >= attempts) throw err;
      options.onRetry?.(err, attempt);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
