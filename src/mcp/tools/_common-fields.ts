/**
 * Shared Zod field schemas reused verbatim across tool definitions.
 *
 * A Zod schema is immutable once built, so a single field instance can
 * safely be a value in many `z.object({ … })` shapes — the generated
 * JSON `inputSchema` inlines it per tool. Centralising the common
 * fields here means one description, one place to edit, and no drift
 * (the `projectPath` field had previously diverged into three
 * hand-maintained copies — a bare const, a `PROJECT_PATH_DESCRIPTION`
 * string + inline `.describe()`, and a fully inline declaration —
 * across ~34 tools).
 */

import { z } from 'zod';

/**
 * The `projectPath` argument every project-scoped tool accepts: an
 * optional path to a *different* `.cartograph/`-initialized project.
 * When omitted, the tool operates on the MCP server's current project.
 */
export const projectPathField = z
  .string()
  .optional()
  .describe(
    'Path to a different project with .cartograph/ initialized. If omitted, uses current project. Use this to query other codebases.',
  );

/**
 * A required free-text field that must contain at least one
 * non-whitespace character (symbol name, task description, git ref,
 * query, …). `.trim()` — a Zod v4 built-in string transform —
 * normalises the value so a whitespace-only input fails `.min(1)`
 * directly; no `.refine(v => v.trim().length > 0, …)` wrapper is
 * needed. Stays a `ZodString`, so callers can still chain `.max()` /
 * `.optional()` / `.describe()`. Replaced five hand-rolled copies of
 * the `.min(1).refine(…)` idiom across the read tools.
 */
export const nonEmptyString = z.string().trim().min(1, { error: 'must be a non-empty string' });

/**
 * Per-call cap on every batched-symbols field. 20 was the
 * historical limit picked by `cartograph_node` and adopted ad-hoc by
 * `cartograph_graph` / `cartograph_role` / `cartograph_biomarkers`
 * (mode='symbol'). Captured here as a single source of truth so a
 * future tune (e.g. dropping to 10 once cross-symbol fan-out gets
 * cheaper) lands in one place.
 */
export const BATCHED_SYMBOLS_MAX = 20;

/**
 * The `symbols: [...]` field every batched-symbols tool accepts:
 * `cartograph_node`, `cartograph_biomarkers` (mode='symbol'),
 * `cartograph_graph` (direction=callers/callees), `cartograph_role`,
 * `cartograph_review` (mode='neighbors'). Locked at the boundary by
 * Zod so per-tool runtime cap checks vanish and over-cap inputs error
 * consistently across every tool:
 *
 *  - `.array(nonEmptyString)` rejects whitespace-only entries that
 *    would otherwise reach the resolver as `''` and silently produce
 *    "symbol not found".
 *  - `.min(1)` rejects `symbols: []`. Empty-array input is almost
 *    certainly a caller bug, not a "find me zero things" intent.
 *  - `.max(BATCHED_SYMBOLS_MAX)` is the hard cap. Used to be enforced
 *    per-tool at the handler boundary (or worse, missing entirely, as
 *    on `cartograph_biomarkers mode='symbol'` pre-2026-05-19 where
 *    items 21+ silently dropped).
 *
 * Stays a `ZodArray`, so callers can chain `.optional()` /
 * `.describe()` to thread their tool-specific copy. Where a tool
 * wants gentler over-cap behavior (slice the input + render a "_N
 * over cap_" footer), it can pre-process the input in the handler
 * AFTER Zod parses, but the schema boundary cap stays hard so
 * callers can never *accidentally* pass 100 symbols and get 20
 * resolved with no warning.
 */
export const batchedSymbols = z
  .array(nonEmptyString)
  .min(1, { error: `symbols must contain at least one entry (or omit the field)` })
  .max(BATCHED_SYMBOLS_MAX, {
    error: `symbols accepts at most ${BATCHED_SYMBOLS_MAX} entries; split into multiple calls for larger batches`,
  });
