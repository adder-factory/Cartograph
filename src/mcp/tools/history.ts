import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import type { ToolResult } from '../tool-types.js';
import {
  getIssuesForNode,
  getSymbolCoChanges,
  getCoChangedFiles,
  getSymbolIssuesCount,
} from '../../db/queries-history.js';
import { textResult } from './shared.js';
import { renderToolResponse } from './_response.js';
import { findSymbol, prependDisambiguationBanner, symbolNotFound } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';

/** Default co-change row cap when caller doesn't pass `limit`. */
const DEFAULT_LIMIT = 20;
/** Hard cap on caller-supplied `limit` so a request can't ask for the whole history. */
const MAX_LIMIT = 100;
/** Default `minCount` floor — pairs sharing one commit are noise on most projects. */
const DEFAULT_MIN_COUNT = 2;
/** Hard cap on caller-supplied `minCount`. Distinct from `MAX_LIMIT` — that's a pagination ceiling, this is a "must share at least N commits" threshold. Equal value today is coincidental. */
const MAX_MIN_COUNT = 100;
/** Cap on the per-row preview SHA list before the "(+N more)" rollup. */
const SHARED_SHA_PREVIEW = 3;
/** Length of an abbreviated git SHA in the human-readable output. */
const SHORT_SHA_LEN = 7;

/**
 * The "result capped" footer — verbatim wording from the legacy
 * `appendMoreHint(…, 'limit')` helper, now routed through the
 * `renderToolResponse` chokepoint so it lands AFTER body truncation.
 */
const MORE_HINT = '> Result capped — pass a higher `limit` to see more.';

/**
 * Build the symbol-level co-change history bullet-list spec.
 * Title `Co-change history for \`${symbol}\``; preamble carries the
 * `ownModifiedCount` + `minCount` framing so the agent reads the
 * threshold/source-volume context before scanning the rows. formatRow
 * delegates to {@link formatCoChangeRowLines} which returns the two-line
 * `[bullet, '  N shared commits: shas]` pair as `string[]` for the
 * spec's multi-line-row discriminant.
 *
 * Footer is the load-bearing "pre-edit check" pointer that captures
 * the tool's intended use ("before you ship") so refactors don't
 * lose the friction guidance. Hoisted via interpolation so the
 * `symbol` value is dynamic per call.
 *
 * Caller (`trySymbolCoChangePath`) short-circuits with `null` on
 * empty rows BEFORE invoking the builder, so `emptyState` is the
 * never-rendered empty string.
 */
export function buildCoChangeHistorySpec(args: {
  symbol: string;
  ownModifiedCount: number;
  minCount: number;
  rows: ReadonlyArray<CoChangeRow>;
}): MarkdownBulletListSpec<CoChangeRow> {
  return {
    title: `Co-change history for \`${args.symbol}\``,
    preamble: [
      `_Source has ${args.ownModifiedCount} modification(s) in tracked history. Showing symbols modified in ≥ ${args.minCount} of the same commits._`,
    ],
    rows: args.rows,
    formatRow: formatCoChangeRowLines,
    emptyState: '',
    footers: [
      `> _Pre-edit check: when you change \`${args.symbol}\`, the symbols listed here have historically also changed. Worth grep-ing before you ship._`,
    ],
  };
}

/**
 * Render the co-change history report — header, rows, closing hint.
 * Extracted so `handleHistory` stays a thin orchestrator.
 */
function renderCoChangeReport(args: {
  symbol: string;
  ownModifiedCount: number;
  minCount: number;
  rows: CoChangeRow[];
}): string {
  return renderMarkdownBulletList(buildCoChangeHistorySpec(args));
}

/**
 * Zod schema for `cartograph_history`. `limit` and `minCount` are
 * `.int().min(1).max(N)` — a zero, negative, over-cap, or non-integer
 * value is REJECTED at the dispatch boundary (the locked
 * reject-out-of-range decision), never silently clamped or floored.
 * The handler therefore drops the old `clampInt` / `clamp` / `numArg`
 * plumbing and the now-impossible `minCountClampNote`.
 */
const historySchema = z.object({
  symbol: z.string().describe('Source symbol name to root the history around.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Max co-changing symbols to return (default ${DEFAULT_LIMIT}). Integer in [1, ${MAX_LIMIT}].`),
  minCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_MIN_COUNT)
    .default(DEFAULT_MIN_COUNT)
    .describe(
      `Min shared commits before a symbol is reported (default ${DEFAULT_MIN_COUNT}; one shared commit is usually noise). ` +
        `Bump for a tighter "always changes together" signal. Integer in [1, ${MAX_MIN_COUNT}].`,
    ),
  projectPath: projectPathField,
});

type HistoryArgs = z.infer<typeof historySchema>;

/** Parsed and validated inputs for `handleHistory`. */
interface HistoryInputs {
  symbol: string;
  cg: ReturnType<ToolCtx['getCartograph']>;
  limit: number;
  minCount: number;
}

/**
 * Extract the typed args for `handleHistory`. Numeric ranges are
 * already enforced by `safeParse` at the dispatch boundary, so this is
 * now a thin shim that only resolves the project handle.
 */
function resolveHistoryInputs(ctx: ToolCtx, args: HistoryArgs): HistoryInputs {
  const cg = ctx.getCartograph(args.projectPath);
  return { symbol: args.symbol, cg, limit: args.limit, minCount: args.minCount };
}

/** Args bundle for both co-change path attempts. Bundled because the
 *  pair walks the same context (cg, symbol, ownModifiedCount, limit,
 *  minCount) and the duplication grew long_parameter_list warnings. */
interface CoChangePathArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  symbol: string;
  ownModifiedCount: number;
  limit: number;
  minCount: number;
}

/**
 * Attempt the symbol-level co-change path. Returns a `ToolResult` when
 * data exists (caller can return it directly), or `null` when the
 * symbol has no qualifying co-changes so the caller should fall back.
 *
 * Symbol-level requires issue-tagged commits attributed hunk-by-hunk
 * via `mineIssueHistory`; it is the strongest signal when available.
 */
function trySymbolCoChangePath(args: CoChangePathArgs & { nodeId: string }): ToolResult | null {
  const { cg, nodeId, symbol, ownModifiedCount, limit, minCount } = args;
  if (ownModifiedCount === 0) return null;
  const symbolCo = getSymbolCoChanges(cg.queries, nodeId, { limit, minCount });
  if (symbolCo.length === 0) return null;

  const body = renderCoChangeReport({
    symbol,
    ownModifiedCount,
    minCount,
    rows: buildCoChangeRows(cg, symbolCo),
  });
  // SQL LIMIT in getSymbolCoChanges — exact-cap row count signals
  // the cap was likely hit. False-positive cost is one extra call.
  // The chokepoint truncates the report body first, then appends the
  // cap footer, so a wide co-change table can't push the hint off-budget.
  return renderToolResponse({
    body,
    footers: [symbolCo.length >= limit ? MORE_HINT : undefined],
  });
}

/**
 * Attempt the file-level co-change fallback path. Returns a `ToolResult`
 * when the file has co-change partners, or an empty-history diagnostic
 * when neither symbol- nor file-level data exists.
 *
 * The cochange miner runs unconditionally on git repos (no `Fixes #N`
 * requirement), so this path works on conventional-commit projects where
 * the issue-history miner finds nothing.
 */
function tryFileLevelPath(args: CoChangePathArgs & { filePath: string; nameAmbiguous: boolean }): ToolResult {
  const { cg, symbol, filePath, ownModifiedCount, limit, minCount, nameAmbiguous } = args;
  const fileCoChanges = getCoChangedFiles(cg.queries, filePath, { limit, minCount });
  const repoIssueCount = getSymbolIssuesCount(cg.queries);

  if (fileCoChanges.length > 0) {
    const body = renderFileLevelFallback({
      symbol,
      filePath,
      ownModifiedCount,
      repoIssueCount,
      minCount,
      rows: fileCoChanges,
      nameAmbiguous,
    });
    return renderToolResponse({
      body,
      footers: [fileCoChanges.length >= limit ? MORE_HINT : undefined],
    });
  }

  // Both symbol- AND file-level returned nothing. Distinguish the
  // "issue-history pass never ran" case from "ran but the repo
  // doesn't tag commits with issues" case.
  return textResult(emptyHistoryMessage({ symbol, filePath, ownModifiedCount, repoIssueCount, minCount }));
}

async function handleHistory(ctx: ToolCtx, args: HistoryArgs): Promise<ToolOutcome> {
  const { symbol, cg, limit, minCount } = resolveHistoryInputs(ctx, args);
  const match = findSymbol(cg, symbol, ctx.refIds);
  // Symbol-not-found is the typed `err(...)` arm — mirrors the
  // coverage POC, so the CLI exit code is 1 for a genuine miss.
  if (!match) return err(symbolNotFound(cg, symbol));

  const ownIssues = getIssuesForNode(cg.queries, match.node.id);
  const ownModifiedCount = ownIssues.filter((i) => i.kind === 'modified').length;

  // Disambiguation note rendering. When N > 1 symbols share the queried
  // name, `findSymbol` returns the picked candidate plus a `match.note`
  // that names the runners-up. For history specifically the user is
  // asking "what's the commit story of THIS thing?" — the picked file's
  // history is what the agent will act on, so the disambiguation MUST
  // be visible BEFORE the timeline (not buried under it as a footer).
  // Otherwise the agent reads a 112-commit hotspot's data when it
  // intended the low-churn lookalike, or vice versa.
  const finalize = (r: ToolResult): ToolResult => prependDisambiguationBanner(r, match.note);

  const sharedArgs = { cg, symbol, ownModifiedCount, limit, minCount };
  const symbolResult = trySymbolCoChangePath({ ...sharedArgs, nodeId: match.node.id });
  if (symbolResult !== null) return ok(finalize(symbolResult));
  // File-level fallback. When the queried name was AMBIGUOUS (findSymbol
  // had >1 exact match and picked one), the file-level answer covers
  // ONLY the picked candidate's file — the other same-named symbols may
  // live in different files with entirely separate co-change history.
  // Flag that so the agent doesn't read the fallback as project-wide.
  return ok(
    finalize(tryFileLevelPath({ ...sharedArgs, filePath: match.node.filePath, nameAmbiguous: match.note.length > 0 })),
  );
}

/**
 * Render the file-level fallback report. Surfaced when symbol-level
 * co-change is empty (no `Fixes #N` commits attributed to the symbol's
 * hunks) but the file-level miner has co-change data — typical on
 * conventional-commit repos.
 */
interface FileLevelFallbackArgs {
  symbol: string;
  filePath: string;
  ownModifiedCount: number;
  repoIssueCount: number;
  minCount: number;
  rows: ReadonlyArray<{ path: string; count: number; jaccard: number; anchorRatio: number }>;
  /** True when the queried name matched >1 symbol and `findSymbol`
   *  picked one — the file-level answer then covers ONLY that pick's
   *  file, not the other same-named candidates' files. */
  nameAmbiguous: boolean;
}

/**
 * Build the file-level co-change fallback bullet-list spec. Title
 * names both the keyed file (the fallback covers ONE file) and the
 * original symbol query so the agent knows what they got vs what
 * they asked for. Preamble carries the dynamically-computed `why`
 * (three cases: no issue-tagged commits in repo / symbol has no
 * issue-tagged modifications / threshold not met) followed by the
 * mechanic explanation, plus optionally a `⚠ ambiguous name` warning
 * when the queried symbol matched >1 candidates and the file-level
 * answer covers only the picked one.
 *
 * formatRow renders each partner-file as
 * `- \`${path}\` — N shared commits (jaccard X.XX, Y% of anchor)`.
 * No "↳ top symbols" subline — the file-level miner discards which
 * commits formed each pair, so any deeper attribution would be
 * misleading noise (see the inline comment that previously guarded
 * the loop, preserved here as a JSDoc note on this builder).
 *
 * Footer: the load-bearing "pre-edit check" pointer + `cartograph_at_range`
 * scope hint, parallel to the symbol-level spec's footer.
 *
 * Caller (`tryFileLevelPath`) only invokes this when
 * `fileCoChanges.length > 0`, so `emptyState` is the never-rendered
 * empty string.
 */
export function buildFileLevelCoChangeSpec(args: FileLevelFallbackArgs): MarkdownBulletListSpec<FileLevelFallbackRow> {
  const why = computeFileLevelFallbackWhy(args);
  const preamble: string[] = [
    `_${why}. Falling back to file-level co-change mined from \`git log --name-only\`. Each row is a file that landed in the same commit as \`${args.filePath}\` ≥ ${args.minCount} times._`,
  ];
  if (args.nameAmbiguous) {
    preamble.push(
      '',
      `> ⚠ \`${args.symbol}\` is an ambiguous name — this file-level fallback covers only \`${args.filePath}\` (the picked candidate). Other symbols sharing the name live in different files; re-query with an \`n_\` UID for one of those to see its history.`,
    );
  }
  return {
    title: `File-level co-change for \`${args.filePath}\` (fallback for \`${args.symbol}\`)`,
    preamble,
    rows: args.rows,
    formatRow: (r) => {
      const jaccard = r.jaccard.toFixed(2);
      const anchorPct = Math.round(r.anchorRatio * 100);
      return `- \`${r.path}\` — ${r.count} shared commit${r.count === 1 ? '' : 's'} (jaccard ${jaccard}, ${anchorPct}% of anchor)`;
    },
    emptyState: '',
    footers: [
      `> _Pre-edit check: when you change \`${args.filePath}\`, the listed files have historically also changed. Use \`cartograph_at_range\` to scope to a specific line range._`,
    ],
  };
}

/** Compute the "why" clause that opens the file-level fallback preamble.
 *  Three cases: repo has no issue-tagged commits at all / mining ran
 *  but this symbol has no issue-tagged modifications / threshold not
 *  met. */
function computeFileLevelFallbackWhy(args: {
  symbol: string;
  repoIssueCount: number;
  ownModifiedCount: number;
  minCount: number;
}): string {
  if (args.repoIssueCount === 0) {
    return 'no issue-tagged (`Fixes #N` / `Closes #N` / `Resolves #N`) commits in this repo, so symbol-level co-change is unavailable';
  }
  if (args.ownModifiedCount === 0) {
    // Mining ran and found issue-tagged commits, but none touched
    // this symbol's hunks. `minCount` is irrelevant here — lowering
    // it can't manufacture rows that don't exist.
    return `\`${args.symbol}\` has no modifications in issue-tagged commits (it may still have changed in untagged commits), so symbol-level co-change is unavailable`;
  }
  return `\`${args.symbol}\` has no symbol-level co-changes ≥ ${args.minCount}`;
}

/** Row shape consumed by {@link buildFileLevelCoChangeSpec}. Matches
 *  the `getCoChangedFiles` return shape; named here so the spec's
 *  parameter type is a single named interface rather than an inline
 *  literal. NOT exported — the test file consumes it structurally
 *  via inline object literals, and external callers reach the rows
 *  through `FileLevelFallbackArgs.rows` (also not exported, but typed
 *  inline so consumers reach it via the spec's
 *  `MarkdownBulletListSpec<...>` shape parameter). */
interface FileLevelFallbackRow {
  path: string;
  count: number;
  jaccard: number;
  anchorRatio: number;
}

function renderFileLevelFallback(args: FileLevelFallbackArgs): string {
  return renderMarkdownBulletList(buildFileLevelCoChangeSpec(args));
}

interface EmptyHistoryArgs {
  symbol: string;
  filePath: string;
  ownModifiedCount: number;
  repoIssueCount: number;
  minCount: number;
}

/** Render the "nothing found anywhere" diagnostic so the caller knows
 *  why — needed because the symptom (empty result) maps to several
 *  causes (miner never ran / convention-commit repo / lonely symbol). */
function emptyHistoryMessage(args: EmptyHistoryArgs): string {
  if (args.repoIssueCount === 0 && args.ownModifiedCount === 0) {
    return `No co-change history found for \`${args.symbol}\`. The repo has 0 issue-tagged commits (\`Fixes #N\` / \`Closes #N\` / \`Resolves #N\`) so symbol-level history is unavailable, AND file-level co-change found no partners for \`${args.filePath}\` at \`minCount: ${args.minCount}\`. Likely a fresh repo, single-author project, or convention-commit history. Try lowering \`minCount\` to 1, or use \`cartograph_review({mode: 'context'})\` for diff-level analysis.`;
  }
  if (args.ownModifiedCount === 0) {
    return `\`${args.symbol}\` has no modifications attributed to issue-tagged commits (this does NOT mean it never changed — it may have changed in commits with no \`Fixes #N\` reference). Either the issue-history pass hasn't run (run \`cartograph_admin({action: 'index', force: true})\` — requires a git repo) OR this symbol has only been touched in untagged commits. File-level fallback for \`${args.filePath}\` is also empty at \`minCount: ${args.minCount}\`.`;
  }
  return `\`${args.symbol}\` was modified in ${args.ownModifiedCount} commit(s), but no other symbol co-changed with it ≥ ${args.minCount} time(s), and file-level co-change for \`${args.filePath}\` is also empty at this threshold. Lower \`minCount\` to widen the net.`;
}

/** One co-change row resolved to a human-readable shape. */
interface CoChangeRow {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  coOccurrences: number;
  shared: string[];
}

/** Resolve node IDs back to names for human-readable output. */
function buildCoChangeRows(
  cg: ReturnType<ToolCtx['getCartograph']>,
  co: Array<{ nodeId: string; coOccurrences: number; sharedCommits: string[] }>,
): CoChangeRow[] {
  const rows: CoChangeRow[] = [];
  for (const c of co) {
    const node = cg.queries.getNodeById(c.nodeId);
    if (!node) continue;
    rows.push({
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
      line: node.startLine,
      coOccurrences: c.coOccurrences,
      shared: c.sharedCommits,
    });
  }
  return rows;
}

/** Format one co-change row as a two-line array (header bullet +
 *  indented shared-SHA preview). Returns `string[]` so the bullet-list
 *  spec's `formatRow` discrimination treats both lines as one row's
 *  rendered output. */
function formatCoChangeRowLines(r: CoChangeRow): string[] {
  const shas = r.shared
    .slice(0, SHARED_SHA_PREVIEW)
    .map((s) => s.slice(0, SHORT_SHA_LEN))
    .join(', ');
  const overflow = r.shared.length - SHARED_SHA_PREVIEW;
  const more = overflow > 0 ? ` (+${overflow} more)` : '';
  return [
    `- **${r.name}** (${r.kind}) — ${r.filePath}:${r.line}`,
    `  ${r.coOccurrences} shared commit${r.coOccurrences === 1 ? '' : 's'}: ${shas}${more}`,
  ];
}

export const HISTORY_TOOL = defineTool({
  name: 'cartograph_history',
  description:
    'Symbol-level co-change — "last N times X changed, what else changed?". Use before editing. ' +
    'Needs issue-tagged commits (`Fixes/Closes/Resolves #N`); falls back to file-level when issues absent.',
  schema: historySchema,
  handle: handleHistory,
});
