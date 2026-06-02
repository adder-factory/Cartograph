/**
 * Unified `cartograph_review` MCP tool — dispatches by `mode` to the
 * existing review-context (diff-driven structural review) and
 * review-neighbors (semantic-lookalike) handlers.
 *
 * Replaces the previously-distinct cartograph_review_context,
 * cartograph_review_neighbors, and cartograph_risk_review tools.
 * Tool-count discipline: 40 → 37 (of the 45-tool registry cap) by
 * collapsing three adjacent review-shaped surfaces under one mode
 * discriminator (same pattern as cartograph_search modes /
 * cartograph_admin actions).
 *
 * The handlers themselves still live in `./review-context.js` and
 * `./review-neighbors.js`; this module is a thin dispatcher.
 *
 * STRUCTURAL CAMPAIGN P4 (Zod migration)
 * --------------------------------------
 * This is a `mode`-discriminator family tool. The schema is a FLAT
 * `z.object` where `mode` is a `z.enum` and EVERY per-mode field is
 * `.optional()` — it intentionally mirrors the previous hand-written
 * JSON `inputSchema` (no field was required there either). It is NOT a
 * strict `z.discriminatedUnion`: per-mode requirements (e.g. `context`
 * needs a `diff`, `neighbors` needs `files`/`symbols`) stay enforced in
 * the sub-handlers exactly as before, so the schema change is shape-
 * compatible and behaviour-preserving.
 *
 * `k` carries a documented bound ("max 50") so it migrates to
 * `.int().min(1).max(50)` — out-of-range `k` is now rejected at the
 * dispatch boundary (locked reject-out-of-range policy). The
 * `kCapNotice` clamp in `review-neighbors.ts` becomes unreachable for
 * Zod-validated calls. The other numeric fields carry no documented
 * bound in their description text, so they stay plain integers (`.min(0)`
 * where the description explicitly says 0 is a valid "disable" value)
 * and the sub-handlers' internal caps continue to apply unchanged.
 */

import { z } from 'zod';
import { projectPathField, batchedSymbols, BATCHED_SYMBOLS_MAX } from './_common-fields.js';
import type { ToolCtx } from './types.js';
import type { ToolResult } from '../tool-types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { handleReviewContext } from './review-context.js';
import { handleReviewNeighbors } from './review-neighbors.js';
import { handleRiskReview } from './risk-review.js';
import { handleAgentAuditReview } from './agent-audit-review.js';

/**
 * A review mode handler. `context` / `neighbors` are P6-converted and
 * return a typed {@link ToolOutcome}; `risk` (out of this wave's scope)
 * still returns a bare {@link ToolResult}. The dispatcher normalises
 * both — a bare `ToolResult` is `ok(...)`-wrapped, a `ToolOutcome`
 * passes through untouched.
 */
type ReviewModeHandler = (
  ctx: ToolCtx,
  args: Record<string, unknown>,
) => Promise<ToolResult | ToolOutcome> | ToolResult | ToolOutcome;

/** Single source of truth for review modes. Schema enum and the
 *  dispatcher both read from these keys — adding a mode requires
 *  one edit here. The `context` mode is the documented default when
 *  `mode` is unset.
 *
 *  Note (2026-05-14): the three mode handlers used to be standalone
 *  MCP tools (`cartograph_review_context`, `_review_neighbors`,
 *  `_risk_review`). They were redundant with `cartograph_review({mode})`
 *  and consumed three slots against the 45-tool registry cap. The TOOL
 *  constants are gone; only the handlers remain (imported here). */
const REVIEW_MODES: Record<string, ReviewModeHandler> = {
  context: handleReviewContext,
  neighbors: handleReviewNeighbors,
  risk: handleRiskReview,
  'agent-audit': handleAgentAuditReview,
};
const REVIEW_MODE_NAMES = ['context', 'neighbors', 'risk', 'agent-audit'] as const;

/**
 * Flat Zod schema for `cartograph_review`. `mode` selects the branch;
 * every per-mode field is optional (matches the legacy JSON schema —
 * the dispatcher and sub-handlers do the per-mode validation).
 */
const reviewSchema = z.object({
  mode: z
    .enum(REVIEW_MODE_NAMES)
    .optional()
    .describe(
      'Pick by input: `context` (default) for a diff, `neighbors` for changed files/symbols, `risk` for a no-input project-wide triage digest, `agent-audit` for the 16 agent-prone biomarkers grouped per-detector.',
    ),
  // ─── mode='context' fields ───
  diff: z.string().optional().describe('(mode=context) Unified-diff text (e.g. `git diff` output).'),
  maxCallersPerSymbol: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('(mode=context) Cap callers shown per affected symbol. Default 5.'),
  maxCalleesPerSymbol: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('(mode=context) Cap callees shown per affected symbol. Default 5.'),
  maxCoChangeWarnings: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('(mode=context) Cap co-change warnings per file. 0 disables. Default 3.'),
  minCoChangeJaccard: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      '(mode=context) Minimum Jaccard similarity for a co-change warning. Default 0.4. OR-gated with an anchor-ratio rule, so a frequent partner can surface below this threshold.',
    ),
  minDiffMagnitude: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      '(mode=context) Suppress co-change warnings when total changed lines (added + removed) is below this. Default 10; 0 disables.',
    ),
  // ─── mode='risk' fields ───
  topN: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('(mode=risk) Rows per lens (biomarkers / hotspots / coverage gaps / dead-code). Default 5.'),
  limit: z.number().int().min(1).optional().describe('(mode=risk) Alias of `topN`; `topN` wins when both are set.'),
  minCentrality: z
    .number()
    .min(0)
    .optional()
    .describe('(mode=risk) Minimum centrality for the hotspot lens. Default 0.'),
  coverageSource: z
    .string()
    .optional()
    .describe('(mode=risk) Restrict the coverage-gap lens to one coverage source label.'),
  // ─── mode='neighbors' fields ───
  files: z.array(z.string()).optional().describe('(mode=neighbors) Changed file paths (relative to project root).'),
  symbols: batchedSymbols
    .optional()
    .describe(
      `(mode=neighbors) Changed symbol names (qualified or simple). Up to ${BATCHED_SYMBOLS_MAX} per call; over-cap is rejected.`,
    ),
  k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('(mode=neighbors) Top-K lookalikes per query symbol. Default 5; max 50 (out-of-range rejected).'),
  dedupeByName: z
    .boolean()
    .optional()
    .describe(
      '(mode=neighbors) When true (default), collapse same-named neighbor clones so only the highest-scoring instance of each name appears in the top-K. Trivial single-literal constants are dropped by a separate filter, not this flag.',
    ),
  // ─── mode='agent-audit' fields ───
  perDetectorLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      '(mode=agent-audit) Max findings per detector. Default 10; max 50. Each of the 16 detectors gets its own section.',
    ),
  minSeverity: z
    .enum(['info', 'warning', 'error'])
    .optional()
    .describe('(mode=agent-audit) Minimum severity to include: `info` (default, all), `warning`, or `error`.'),
  projectPath: projectPathField,
});

type ReviewArgs = z.infer<typeof reviewSchema>;

function inferReviewMode(args: ReviewArgs): (typeof REVIEW_MODE_NAMES)[number] {
  if (args.mode) return args.mode;
  if ((args.files && args.files.length > 0) || (args.symbols && args.symbols.length > 0)) return 'neighbors';
  if (args.diff) return 'context';
  if (args.perDetectorLimit !== undefined || args.minSeverity !== undefined) {
    return 'agent-audit';
  }
  if (
    args.limit !== undefined ||
    args.topN !== undefined ||
    args.minCentrality !== undefined ||
    args.coverageSource !== undefined
  ) {
    return 'risk';
  }
  return 'risk';
}

async function handleReview(ctx: ToolCtx, args: ReviewArgs): Promise<ToolOutcome> {
  const mode = inferReviewMode(args);
  const handler = REVIEW_MODES[mode];
  // `mode` is enum-validated by Zod, so a `handler` miss is unreachable
  // in practice — keep the guard as a defensive fallback for the legacy
  // dispatch path (where `runHandler` may pass an unvalidated value).
  // `review-context.ts` / `review-neighbors.ts` are P6-converted and
  // return a typed `ToolOutcome` directly; `risk-review.ts` is outside
  // this wave's scope and still returns a bare `ToolResult`. Normalise:
  // a `ToolOutcome` (`'ok' in`) passes through, a bare `ToolResult` is
  // `ok(...)`-wrapped — its `isError` envelope survives so the CLI exit
  // code stays correct.
  if (handler) {
    const res = await handler(ctx, args as Record<string, unknown>);
    return 'ok' in res ? res : ok(res);
  }
  const modeNames = REVIEW_MODE_NAMES.map((n) => `'${n}'`).join(', ');
  return err(`cartograph_review: \`mode\` must be one of: ${modeNames}. ` + `Got ${JSON.stringify(mode)}.`);
}

export const REVIEW_TOOL = defineTool({
  name: 'cartograph_review',
  description:
    'Review/triage dispatcher — pick `mode` by input shape.\n\n' +
    "`'context'` (default): pass `diff` → per-hunk affected symbols + callers/callees + impact + co-change warnings. " +
    "`'neighbors'`: pass `files` or `symbols` → top-K lookalikes. " +
    "`'risk'`: no input → top biomarkers + hotspots + coverage gaps + dead-code. " +
    "`'agent-audit'`: no input → the 16 agent-prone biomarkers.",
  schema: reviewSchema,
  handle: handleReview,
});
