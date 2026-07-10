import { isTransientLlmEndpointError } from '../../src/llm/retry-policy.js';

/**
 * Return the exact environmental failure detail that may skip a semantic
 * eval case. Contract/configuration failures deliberately return null so the
 * runner throws and the evaluation fails instead of hiding a regression.
 */
export function semanticEvalSkipDetail(error: unknown): string | null {
  return isTransientLlmEndpointError(error) ? error.message : null;
}
