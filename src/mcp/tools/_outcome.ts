/**
 * `ToolOutcome` — the typed `Result<Ok, Err>` a `defineTool` handler
 * returns (structural campaign P6).
 *
 * THE PROBLEM
 * -----------
 * A handler used to return a `ToolResult` and pick, BY HAND, whether
 * to build it with `errorResult(...)` (`isError: true` → CLI exit 1)
 * or `textResult(...)` / `renderToolResponse(...)` (`isError: false`
 * → exit 0). Because the choice is a free-form convention, handlers
 * drift: the audit found a "symbol not found" miss exiting 1 from
 * `cartograph_biomarkers` but 0 from `cartograph_coverage`. Nothing in
 * the type system said "this branch is an error."
 *
 * THE FIX
 * -------
 * "This is an error" becomes a TYPE. A P6 handler returns a
 * {@link ToolOutcome} — a two-arm discriminated union:
 *
 *   - `ok(value)`  — success; `value` is the already-rendered
 *     `ToolResult` (works uniformly for response-envelope tools that
 *     call `renderToolResponse(spec)` AND for the bare-`textResult`
 *     tools like `playbook` / `status`);
 *   - `err(message)` — failure; carries just the message string.
 *
 * THE GUARANTEE
 * -------------
 * `errorResult` is NOT exported to handlers any more — the only place
 * it is called is the `defineTool` wrapper (see `_define-tool.ts`),
 * which maps `err(msg)` → `errorResult(msg)`. A P6 handler that wants
 * to signal an error has exactly one way to do it: return the `err`
 * arm. It is therefore physically impossible for a converted handler
 * to emit an `isError: true` result through any path other than the
 * typed error arm — exit-code consistency is compiler-enforced, not
 * convention-enforced.
 *
 * WHY THIS SHAPE
 * --------------
 * The success arm carries a fully-rendered `ToolResult`, not a
 * `ToolResponseSpec`. Two reasons:
 *
 *   1. Uniformity. Roughly half the tools go through the P5
 *      `renderToolResponse(spec)` chokepoint; the other half (playbook,
 *      status, the family-tool sub-modes) return a bare `textResult`.
 *      A `ToolResult` success arm fits both with no fake-spec wrapping
 *      — the handler calls whichever renderer it already uses and
 *      hands the result to `ok(...)`.
 *   2. The success arm is genuinely an "already-correct" payload —
 *      `renderToolResponse` / `textResult` produce an `isError`-free
 *      envelope by construction. The outcome layer's only job is the
 *      error/success DISCRIMINATION, not re-rendering. Keeping the Ok
 *      payload pre-rendered keeps the adapter a one-liner per arm.
 *
 * The error arm carries a bare `string`, not a structured `ToolError`
 * object. The dispatch adapter's sole consumer of the error is
 * `errorResult(message)`, which takes a string. A structured error
 * type would be speculative until a caller needs the structure; the
 * P6 wave can widen the arm to `string | ToolError` later without
 * breaking any `err('...')` call site.
 */

import type { ToolResult } from '../tool-types.js';

/**
 * The typed result a `defineTool` handler returns. A two-arm
 * discriminated union over the `ok` boolean tag:
 *
 *   - `{ ok: true; value }`  — success; `value` is a rendered
 *     `ToolResult` (from `renderToolResponse` or `textResult`).
 *   - `{ ok: false; error }` — failure; `error` is the message that
 *     the dispatch adapter feeds to `errorResult`.
 *
 * A handler signature becomes `Promise<ToolOutcome>` (or the sync
 * `ToolOutcome` for handlers that never await).
 */
export type ToolOutcome =
  | { readonly ok: true; readonly value: ToolResult }
  | { readonly ok: false; readonly error: string };

/**
 * Construct the success arm. Pass the already-rendered `ToolResult`
 * — typically `renderToolResponse(spec)` for an envelope tool or
 * `textResult(body)` for a bare-text tool.
 */
export function ok(value: ToolResult): ToolOutcome {
  return { ok: true, value };
}

/**
 * Construct the error arm. Pass the human/agent-facing message; the
 * dispatch adapter wraps it via `errorResult` (which prefixes
 * `Error: ` and sets `isError: true`). Do NOT pre-prefix the message
 * with `Error:` — the adapter owns that.
 */
export function err(error: string): ToolOutcome {
  return { ok: false, error };
}

/**
 * Adapt a {@link ToolOutcome} to a `ToolResult`. The success arm
 * passes through; the error arm is rendered via `toError` — the ONE
 * place a P6 handler's error becomes an `isError: true` envelope.
 *
 * `toError` is injected (rather than importing `errorResult` here) so
 * this module stays dependency-light — `_define-tool.ts` imports
 * `errorResult` from the dispatch-only `_error-result.ts` and passes
 * that reference straight in.
 */
export function outcomeToResult(outcome: ToolOutcome, toError: (message: string) => ToolResult): ToolResult {
  return outcome.ok ? outcome.value : toError(outcome.error);
}
