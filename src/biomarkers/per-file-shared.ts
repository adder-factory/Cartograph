/**
 * Shared constants + small helpers used by BOTH the in-main per-file
 * analyser (`src/biomarkers/index.ts:analyseSingleFile`) and the
 * worker-thread compute path (`src/biomarkers/per-file-worker.ts`).
 *
 * Extracted to break the circular import that would otherwise form:
 * `index.ts` imports `per-file-pool.ts` (which spawns `per-file-worker.ts`),
 * and the worker can't import back from `index.ts` without the circle.
 *
 * Any value or pure helper that the two paths MUST agree on (otherwise
 * findings drift silently between them) belongs here, NOT inlined into
 * the worker. B22 (2026-05-24) — reviewer caught the worker missing
 * the `MIN_LOC` guard the in-main path uses; the fix is to source the
 * constant from here so it can't drift again.
 */

import type { Node } from '../types.js';

/** Symbol kinds the per-file analyser walks. Skipping import / export /
 *  variable / etc. */
export const ANALYSABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

/** Symbols smaller than this LOC count are skipped — getters,
 *  one-liners, etc. aren't biomarker bait. The in-main path and the
 *  worker path MUST share this constant or the two paths report
 *  different finding counts for the same file. */
export const ANALYSABLE_MIN_LOC = 5;

/** Build the secrets-evaluation payload shared by the in-main and worker
 * per-file paths. Keeping language here prevents comment semantics from
 * silently drifting when one execution path changes independently. */
export function buildSecretsEvaluationInput(
  node: Pick<Node, 'id' | 'name' | 'language' | 'signature' | 'docstring'>,
  body: string,
) {
  return {
    id: node.id,
    name: node.name,
    language: node.language,
    signature: node.signature ?? null,
    docstring: node.docstring ?? null,
    summary: null,
    body,
  };
}

/** Files whose own source contains the secrets-detection keyword
 *  patterns (`api_key`, `password`, `AKIA…`) by necessity, so the
 *  rule would otherwise flag itself. Industry-standard carve-out
 *  shipped by trufflehog / gitleaks / detect-secrets via similar
 *  allowlists.
 *
 *  Two categories live here:
 *   - The rule's own implementation files (`secrets-detector.ts`,
 *     `engine.ts`, `biomarkers/index.ts` — the dispatcher).
 *   - LLM-setup wizard / planner files that MUST spell out env-var
 *     NAMES (`OPENAI_API_KEY`, `apiKey` config fields, etc.) as part
 *     of their setup-guidance output. The values they reference are
 *     identifier strings, not actual secrets.
 *
 *  The in-main `evaluateFileSecretsHandling` and the worker's
 *  equivalent both consult this list — adding a new self-implementing
 *  file means one edit here. */
export const SECRETS_RULE_SELF_PATHS: readonly RegExp[] = [
  /^src\/llm\/secrets-detector\.ts$/,
  /^src\/biomarkers\/engine\.ts$/,
  /^src\/biomarkers\/index\.ts$/,
  /^src\/installer\/llm-setup\.ts$/,
  /^src\/installer\/llm-setup-plan\.ts$/,
];

export function isSecretsRuleSelfPath(relPath: string): boolean {
  return SECRETS_RULE_SELF_PATHS.some((p) => p.test(relPath));
}

/** Build the set of docstrings shared across 2+ constants in the same
 *  file. These are presumed inherited file-block prose (Go extractor
 *  attaches the file-level block comment to every const in a
 *  `const ( ... )` block) rather than constant-specific value claims;
 *  `stale_doc` should skip them. Solo docstrings (count === 1) are kept. */
export function sharedDocstringsAcrossConstants(constants: ReadonlyArray<{ docstring?: string | null }>): Set<string> {
  const counts = new Map<string, number>();
  for (const c of constants) {
    if (!c.docstring) continue;
    counts.set(c.docstring, (counts.get(c.docstring) ?? 0) + 1);
  }
  const shared = new Set<string>();
  for (const [doc, count] of counts) {
    if (count >= 2) shared.add(doc);
  }
  return shared;
}

/** Defensive guard: does the AST bodyNode span a region wildly larger
 *  than what the DB recorded for this symbol? Returns true when the
 *  AST node's end-line exceeds the DB end-line by more than `slack`
 *  (10) lines AND the AST span is more than 2× the DB span.
 *
 *  Both bounds matter:
 *   - Pure `+10` slack would catch large genuine functions whose AST
 *     range legitimately differs from extraction by a handful of lines
 *     (decorators, JSDoc placement, trailing comments).
 *   - Pure `2×` would catch tiny one-line lambdas where any noise
 *     trips the multiplier.
 *
 *  The friction #20 repro had dbLines=15 / astLines≈60+ — clears both
 *  bounds easily. Routine cases with ±3 line drift clear neither. */
export function astBodyNodeRangeMismatch(args: {
  dbStartLine: number;
  dbEndLine: number;
  /** 0-indexed tree-sitter start row. */
  astStartRow: number;
  /** 0-indexed tree-sitter end row. */
  astEndRow: number;
}): boolean {
  const dbLines = Math.max(1, args.dbEndLine - args.dbStartLine + 1);
  const astLines = Math.max(1, args.astEndRow - args.astStartRow + 1);
  if (astLines <= dbLines + 10) return false;
  return astLines > dbLines * 2;
}
