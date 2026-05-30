/**
 * Shared `isReachable()` failure-message builder for the 3
 * OpenAI-SDK clients (embedding / chat / reranker). The per-client
 * isReachable methods used to inline the same nested ternary +
 * pluralisation logic, which (a) tripped the complex_conditional
 * biomarker (8 operands in one expression) and (b) was duplicated
 * verbatim across three files. Both issues collapse to one
 * extraction here.
 *
 * Per-tier wording difference (which config field to point at,
 * which install hint to suggest) is injected via the `tierLabel`
 * argument so the body stays uniform.
 */

import { backendLabel, type DetectedBackendKind } from '../installer/scan-backends.js';

export interface BuildReachabilityErrorArgs {
  /** Human-printable endpoint identifier — e.g. `'(OpenAI default)'`
   *  when `cfg.endpoint` is unset, or the URL when set. */
  endpointLabel: string;
  /** Raw error message from the SDK / fetch failure. */
  baseMsg: string;
  /** Scan results from `scanForLlmBackends`. */
  alternatives: ReadonlyArray<{ kind: DetectedBackendKind; endpoint: string }>;
  /** Which config field to redirect to in the "point at one of those"
   *  guidance — e.g. `'embeddingLlm.endpoint'` for the embed tier. */
  configField: string;
  /** Per-tier install hint that surfaces when NO alternatives are
   *  running — e.g. ``'`brew install llama.cpp` then `llama-server -m
   *  <GGUF> --port 8080 --embeddings`'``. Caller owns this string so
   *  the per-tier flags (`--embeddings`, `--rerank`, etc.) stay with
   *  the tier that needs them. */
  installHint: string;
}

export function buildReachabilityError(args: BuildReachabilityErrorArgs): string {
  const { endpointLabel, baseMsg, alternatives, configField, installHint } = args;
  if (alternatives.length === 0) {
    return `${endpointLabel} not reachable (${baseMsg}). No OpenAI-compat backends detected on common ports. Recommended: ${installHint}.`;
  }
  const plural = alternatives.length === 1 ? '' : 's';
  const list = alternatives.map((d) => `${backendLabel(d.kind)} at ${d.endpoint}`).join(', ');
  return `${endpointLabel} not reachable (${baseMsg}). Detected ${alternatives.length} other OpenAI-compat backend${plural} running: ${list}. Point ${configField} at one of those, or start the configured backend.`;
}
