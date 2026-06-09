/**
 * `renderToolResponse` — the single response-envelope chokepoint
 * (structural campaign P5).
 *
 * THE PROBLEM
 * -----------
 * Every MCP tool handler hand-assembles its output tail: it truncates
 * the body, appends "more results" / "limit capped" footers, appends a
 * freshness hint, and formats its empty-result message. Because each
 * handler does this individually they drift:
 *
 *   - some forget `truncateOutput` entirely (a wide table then blows
 *     the 15 KB budget);
 *   - some call `appendMoreHint` BEFORE `truncateOutput`, so a wide
 *     body pushes the footer past the budget and `truncateOutput`
 *     silently chops it off (the audit-4 biomarkers bug);
 *   - some place a freshness hint before truncation, same hazard;
 *   - empty-result messages each re-implement the
 *     `freshnessHintForEmptyResult` concatenation by hand.
 *
 * THE FIX
 * -------
 * One function owns the output tail. The handler declares INTENT — a
 * structured {@link ToolResponseSpec} — and the chokepoint applies the
 * cross-cutting concerns in the one correct order:
 *
 *   1. truncate the BODY (line-boundary cut) to a budget that already
 *      reserves room for the footers;
 *   2. append footers AFTER truncation, so a wide body can never push
 *      a footer off the budget;
 *   3. append the freshness hint (empty-result form, or the per-result
 *      stale-files note) last.
 *
 * A handler that goes through this chokepoint *cannot* get the order
 * wrong, because it never sees the order at all.
 *
 * WHY THIS API SHAPE
 * ------------------
 * The catalogue of real handler tails (biomarkers / find / context /
 * explore / files / history / dead-code / hotspots / role / callers)
 * shows four recurring tail elements: a body, zero-or-more footers
 * (`appendMoreHint`, the `limitClampNote`, `appendCallIdFooter`'s
 * marker, etc.), an optional freshness signal, and a distinct
 * empty-result branch. The spec mirrors exactly those four:
 *
 *   { body, footers?, freshness?, empty? }
 *
 * `footers` is a plain `string[]` rather than a typed union because
 * the footer TEXT is genuinely tool-specific (the call-id marker, the
 * "pass a higher limit" hint, the limit-clamp note) — what is NOT
 * tool-specific, and what handlers kept getting wrong, is WHERE the
 * footer lands relative to truncation. The chokepoint owns the
 * placement; the handler still owns the wording.
 *
 * `freshness` accepts either a `Cartograph` (compute the per-result
 * stale-files note / empty-result hint here) or a pre-rendered string
 * (for handlers that already hold a hint and just want correct
 * placement). The `empty` branch is a nested spec so an empty result
 * still gets a freshness hint with the same ordering guarantees.
 *
 * RELATION TO P6 (typed `Result<Ok, Err>` handler returns)
 * --------------------------------------------------------
 * This module takes a *spec*, not a `Result`. P6 shipped the typed
 * `ToolOutcome` whose Ok arm carries a pre-rendered `ToolResult` (the
 * output of `renderToolResponse` or `textResult`) — NOT a raw
 * `ToolResponseSpec`. A handler builds its success output with
 * `renderToolResponse(spec)` and hands the result to `ok(...)`; the
 * `defineTool` adapter maps the outcome. See `_outcome.ts` §WHY THIS
 * SHAPE for why the Ok arm is a rendered `ToolResult`, not a spec.
 */

import type Cartograph from '../../index.js';
import type { ToolResult } from '../tool-types.js';
import type { Node } from '../../types.js';
import {
  MAX_OUTPUT_LENGTH,
  appendStaleFilesNote,
  freshnessHintForEmptyResult,
  textResult,
  truncateOutput,
} from './shared.js';

/**
 * Freshness intent. Either:
 *   - a `Cartograph` — the chokepoint computes the signal itself
 *     (`freshnessHintForEmptyResult` for an empty result, or the
 *     per-result `appendStaleFilesNote` when `nodes` is supplied);
 *   - a pre-rendered string — the handler already holds the hint and
 *     just wants it placed after truncation + footers;
 *   - omitted — no freshness signal.
 */
export type FreshnessSpec = { cg: Cartograph; nodes?: ReadonlyArray<Node> } | { text: string };

/** The empty-result branch — its own little body + freshness pair. */
interface EmptyResultSpec {
  /** The "nothing found" message. Never truncated — empty messages
   *  are short by construction. */
  message: string;
  /** Optional freshness signal appended after the message. A bare
   *  `{ cg }` here resolves to {@link freshnessHintForEmptyResult}. */
  freshness?: FreshnessSpec;
}

/**
 * Structured declaration of a tool's output tail. The handler fills
 * this in; {@link renderToolResponse} turns it into a {@link ToolResult}.
 *
 * NOTE — intentionally NOT a `ToolResult`: this is a pure data spec
 * with no envelope and no `isError`. Errors stay on the
 * `errorResult` path; this type only ever produces a success result.
 * That keeps the future P6 adapter (`Result<ToolResponseSpec, …>`)
 * a one-liner per arm.
 */
export interface ToolResponseSpec {
  /**
   * The main payload. Truncated at a line boundary to a budget that
   * already reserves room for `footers`. Ignored when the result is
   * empty (see `empty`) — pass `empty` instead of an empty `body`.
   */
  body: string;
  /**
   * Footer lines appended AFTER truncation, in order, each separated
   * from the body and from each other by a blank line. Empty / blank
   * entries are dropped. Because they land after truncation a wide
   * `body` can never push a footer off the budget — this is the
   * audit-4 biomarkers bug, fixed structurally.
   */
  footers?: ReadonlyArray<string | undefined | null>;
  /**
   * Per-result freshness signal for a NON-empty result — typically a
   * `{ cg, nodes }` pair resolving to the stale-files note. Placed
   * after the footers.
   */
  freshness?: FreshnessSpec;
  /**
   * When set, the result is EMPTY: `body` / `footers` / `freshness`
   * are ignored and the empty-result branch is rendered instead. A
   * handler computes this when its row set came back empty.
   */
  empty?: EmptyResultSpec;
  /**
   * Per-tool output budget override. Defaults to
   * {@link MAX_OUTPUT_LENGTH} (15 KB). Local-chat and similar
   * bulk-prose tools pass a higher cap.
   */
  maxLength?: number;
}

/** Blank-line joiner for body ⇄ footer ⇄ footer. */
const FOOTER_SEP = '\n\n';

/**
 * Resolve a {@link FreshnessSpec} to the text to append. The
 * `appendStaleFilesNote` / `freshnessHintForEmptyResult` helpers
 * already return a string that starts with its own `\n\n`, so the
 * returned value is appended verbatim (no extra separator).
 *
 * `forEmptyResult` selects the empty-result hint vs the per-result
 * stale-files note when the spec is the `{ cg }` form.
 */
function resolveFreshness(spec: FreshnessSpec | undefined, body: string, forEmptyResult: boolean): string {
  if (!spec) return '';
  if ('text' in spec) return spec.text;
  if (forEmptyResult) {
    // Empty-result branch: the per-node stale check is meaningless
    // (there are no result nodes), so always use the index-freshness
    // hint regardless of whether `nodes` was supplied.
    return freshnessHintForEmptyResult(spec.cg);
  }
  // Non-empty branch: `appendStaleFilesNote` consumes the body so it
  // can no-op when there are zero nodes; we strip its echo of `body`
  // back off and keep only the appended note.
  const nodes = spec.nodes ? [...spec.nodes] : [];
  const withNote = appendStaleFilesNote(spec.cg, body, nodes);
  return withNote.length > body.length ? withNote.slice(body.length) : '';
}

/**
 * Render a {@link ToolResponseSpec} into a {@link ToolResult}, owning
 * the entire output tail.
 *
 * Order of operations (the part handlers kept getting wrong):
 *
 *   1. compute the footer block + freshness text;
 *   2. truncate the BODY to `maxLength` minus the measured length of
 *      the footer block + freshness — so the footers always fit;
 *   3. concatenate body ⇄ footers ⇄ freshness.
 *
 * The footer block is measured, not estimated: if the footers alone
 * already exceed the budget (pathological — a 15 KB call-id marker
 * would be a bug elsewhere) the body collapses to empty rather than
 * the footers being silently chopped. Footers are load-bearing
 * (they tell the agent to paginate); a chopped body is recoverable,
 * a chopped footer is a silent correctness loss.
 */
export function renderToolResponse(spec: ToolResponseSpec): ToolResult {
  const maxLength = spec.maxLength ?? MAX_OUTPUT_LENGTH;

  // ---- empty-result branch -------------------------------------------------
  if (spec.empty) {
    const e = spec.empty;
    // Empty messages are short by construction — no truncation. The
    // freshness hint already carries its own leading `\n\n`.
    return textResult(e.message + resolveFreshness(e.freshness, e.message, true));
  }

  // ---- non-empty branch ----------------------------------------------------
  // Footer block: drop blank entries, join each with a blank line.
  const footerLines = (spec.footers ?? []).map((f) => (f ?? '').trim()).filter((f) => f.length > 0);
  const footerBlock = footerLines.length > 0 ? FOOTER_SEP + footerLines.join(FOOTER_SEP) : '';

  // Truncate the body to the budget MINUS the footer block, so the
  // footers survive. The freshness note is resolved against the
  // *truncated* body (the stale-files probe keys off result nodes,
  // not body text, so this is purely about placement) and also
  // subtracted from the budget on a second pass when present.
  const bodyBudget = Math.max(0, maxLength - footerBlock.length);
  let truncatedBody = truncateOutput(spec.body, bodyBudget);

  // Freshness text is computed once; it does not depend on body
  // length, so re-tightening the budget for it is a single extra
  // truncate pass only when a freshness note is actually present.
  const freshnessText = resolveFreshness(spec.freshness, truncatedBody, false);
  if (freshnessText.length > 0) {
    const tighter = Math.max(0, maxLength - footerBlock.length - freshnessText.length);
    if (truncatedBody.length > tighter) {
      truncatedBody = truncateOutput(spec.body, tighter);
    }
  }

  return textResult(truncatedBody + footerBlock + freshnessText);
}
