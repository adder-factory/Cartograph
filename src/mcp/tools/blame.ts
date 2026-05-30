import { z } from 'zod';
import { projectPathField, nonEmptyString } from './_common-fields.js';
import { textResult } from './shared.js';
import { renderToolResponse } from './_response.js';
import { resolveSymbolToNode, symbolNotFound } from './symbol-resolver.js';
import { getNodesByCommits } from '../../db/queries-history.js';
import { getLineRangeHistory, getFileFollowEarliestTs, fileWasEverRenamed, type CommitMeta } from '../../git-utils.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';

/**
 * Default cap on the per-commit "co-touched symbols" preview. The
 * tool already cuts off the full commit list at `limit`; this is a
 * second axis — for each surfaced commit, how many other symbols to
 * name. Cheap to bump if the agent wants the full set, but the
 * default 6 keeps the output skimmable.
 */
const DEFAULT_PER_COMMIT_PEERS = 6;
const MAX_PER_COMMIT_PEERS = 50;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface BlameRow {
  commit: CommitMeta;
  /** Other symbols touched in the same commit. Sourced opportunistically
   *  from `symbol_issues` — only present for issue-tagged commits, since
   *  that's the only signal the issue-history miner tracks. */
  coTouched: Array<{ name: string; kind: string; filePath: string }>;
  coTouchedTotal: number;
}

interface BlameAuthor {
  name: string;
  commits: number;
}

interface BlameResult {
  symbolName: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** Number of commits actually fetched (capped at limit+2 to anchor
   *  earliest + most-recent). The label says "≥N" when fetchedCommits
   *  equals the cap so the agent doesn't read it as a hard total. */
  fetchedCommits: number;
  /** True when `fetchedCommits` equals the fetch cap (= the timeline
   *  may be longer than reported). Drives the "≥N" label. */
  truncated: boolean;
  /** Earliest-known commit that touched the line range. Often the
   *  introduction, but can be later if the file's current path was
   *  renamed since (--follow is off — line ranges don't survive
   *  renames). */
  earliest: BlameRow | null;
  /** Most recent commit that touched the line range. */
  mostRecent: BlameRow | null;
  /** Newest-first commit timeline (capped by `limit`). */
  commits: BlameRow[];
  /** Author rollup over ALL fetched commits, not just `commits` —
   *  ensures `earliest` / `mostRecent` authors aren't silently
   *  dropped from the section when they fall outside the top-`limit`
   *  surfacing window. */
  authors: BlameAuthor[];
  /** Non-null when the rename-aware `git log --follow` reveals history
   *  older than the line-range timeline's earliest commit, indicating
   *  the timeline was truncated at a rename. Contains the warning
   *  text to append verbatim. */
  renameWarning: string | null;
  /** Non-empty when the `symbol` arg had no exact name/id match and was
   *  resolved by FTS fuzzy fallback to an unrelated node — so the agent
   *  knows the blamed line range belongs to a guessed symbol, not the
   *  one it asked for. Empty string on an exact resolution. */
  fuzzyBanner: string;
}

/**
 * Zod schema for `cartograph_blame`.
 *
 * `limit` is `.int().min(1).max(50)` and `perCommitPeers` is
 * `.int().min(0).max(50)`: an out-of-range or non-integer value is now
 * REJECTED at the dispatch boundary (the locked reject-out-of-range
 * decision) rather than silently clamped — so the handler drops the
 * old `clamp(numArg(...))` pass entirely.
 */
const blameSchema = z.object({
  symbol: nonEmptyString.describe('Symbol name (function, method, class, etc.) to blame.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(
      `Newest-first cap on the surfaced commit timeline (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Earliest + most-recent are always shown separately.`,
    ),
  perCommitPeers: z
    .number()
    .int()
    .min(0)
    .max(MAX_PER_COMMIT_PEERS)
    .default(DEFAULT_PER_COMMIT_PEERS)
    .describe(
      `Per commit, how many co-touched symbols to name (default ${DEFAULT_PER_COMMIT_PEERS}, max ${MAX_PER_COMMIT_PEERS}; 0 disables). Only issue-tagged commits carry peers.`,
    ),
  projectPath: projectPathField,
});

type BlameToolArgs = z.infer<typeof blameSchema>;

/**
 * Fetch git blame history for a symbol's line range, with error handling.
 * Returns empty array if the file is untracked or has no history.
 */
function fetchBlameHistory(
  cg: any,
  node: { filePath: string; startLine: number; endLine: number },
  fetchCap: number,
): CommitMeta[] {
  return getLineRangeHistory({
    rootDir: cg.projectRoot,
    relPath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    limit: fetchCap,
  });
}

/** Arguments for {@link enrichBlameRowsWithPeers}. */
interface EnrichBlameRowsWithPeersArgs {
  history: CommitMeta[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cg: any;
  nodeId: string;
  perCommitPeers: number;
}

/**
 * Enrich blame history with peer symbols touched in the same commits.
 * Returns both the peer map and the fully constructed blame rows.
 */
function enrichBlameRowsWithPeers({ history, cg, nodeId, perCommitPeers }: EnrichBlameRowsWithPeersArgs): {
  peersByCommit: Map<string, Array<{ id: string; name: string; kind: string; filePath: string }>>;
  allRows: BlameRow[];
} {
  const allShas = history.map((c) => c.sha);
  const peersByCommit =
    perCommitPeers > 0
      ? getNodesByCommits(cg.queries, allShas, nodeId)
      : new Map<string, Array<{ id: string; name: string; kind: string; filePath: string }>>();

  const allRows: BlameRow[] = history.map((meta) => {
    const peers = peersByCommit.get(meta.sha) ?? [];
    return { commit: meta, coTouched: peers.slice(0, perCommitPeers), coTouchedTotal: peers.length };
  });

  return { peersByCommit, allRows };
}

function buildAuthorRollup(commits: ReadonlyArray<BlameRow>): BlameAuthor[] {
  const counts = new Map<string, number>();
  for (const c of commits) {
    counts.set(c.commit.author, (counts.get(c.commit.author) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, n]) => ({ name, commits: n }))
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

/**
 * Detect whether the line-range timeline was truncated at a file rename.
 *
 * Two conditions must BOTH be true to emit a warning:
 *   1. The file was actually renamed at some point in its history
 *      (`fileWasEverRenamed` — checks for more than one distinct path in
 *      `git log --follow --name-only`).
 *   2. The rename predates the symbol's `-L` timeline, i.e. `--follow`
 *      reaches further back in time than the earliest commit that touched
 *      the line range.
 *
 * Requiring condition (1) prevents false positives for the overwhelmingly
 * common case: a function added to a file *after* the file's creation commit.
 * In that scenario, --follow's oldest timestamp (= file creation) is earlier
 * than the symbol's -L oldest timestamp (= when the function was introduced),
 * tripping the timestamp test — but no rename ever happened, so the timeline
 * is NOT actually truncated.
 *
 * Edge-case reasoning:
 *   - Function added after file creation, file never renamed:
 *     condition (1) is false → no warn.
 *   - File renamed before the symbol's timeline earliest commit:
 *     condition (1) true, condition (2) true → warn.
 *   - File renamed after the symbol's timeline earliest commit (rename is
 *     within the visible timeline, so -L is not cut short):
 *     condition (2) is false → no warn.
 *   - git unavailable / timeout: `fileWasEverRenamed` returns false →
 *     no warn (fail-safe; don't break blame for a secondary signal).
 */
function detectRenameWarning(rootDir: string, relPath: string, timelineEarliestIso: string | null): string | null {
  if (!timelineEarliestIso) return null;
  // Guard (1): only proceed when the file actually has a rename in its history.
  if (!fileWasEverRenamed(rootDir, relPath)) return null;
  // Guard (2): only warn when the rename predates the symbol's -L timeline.
  const followEarliestIso = getFileFollowEarliestTs(rootDir, relPath);
  if (!followEarliestIso) return null;
  // Compare as ISO strings — lexicographic order matches chronological
  // order for ISO 8601 with consistent timezone formatting.
  if (followEarliestIso < timelineEarliestIso) {
    return (
      `> ⚠ Timeline truncated at file rename. The file shown here is the most recent name; ` +
      `earlier history under a different filename is not surfaced (line-range follow does NOT cross renames). ` +
      `Run \`git log --follow ${relPath}\` to see the full file history.`
    );
  }
  return null;
}

/** Render the BlameResult body — extracted to keep `handleBlame` short. */
function buildBlameResult(args: {
  node: { name: string; qualifiedName: string; filePath: string; startLine: number; endLine: number };
  history: ReadonlyArray<CommitMeta>;
  allRows: BlameRow[];
  limit: number;
  fetchCap: number;
  renameWarning: string | null;
  fuzzyBanner: string;
}): BlameResult {
  const { node, history, allRows, limit, fetchCap, renameWarning, fuzzyBanner } = args;
  return {
    symbolName: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    fetchedCommits: history.length,
    truncated: history.length >= fetchCap,
    earliest: allRows.at(-1) ?? null,
    mostRecent: allRows[0] ?? null,
    commits: allRows.slice(0, limit),
    authors: buildAuthorRollup(allRows),
    renameWarning,
    fuzzyBanner,
  };
}

async function handleBlame(ctx: ToolCtx, args: BlameToolArgs): Promise<ToolOutcome> {
  // `symbol` (non-empty), `limit` (integer in [1, 50]) and
  // `perCommitPeers` (integer in [0, 50]) were validated at the
  // dispatch boundary by `safeParse` — no defensive clamp pass needed.
  const { symbol, limit, perCommitPeers } = args;

  const cg = ctx.getCartograph(args.projectPath);
  // `resolveSymbolToNode` flags whether resolution was an exact name/id
  // hit or an approximate FTS guess. Blame previously used `findSymbol`,
  // whose fuzzy "did you mean" note blame never rendered — so a query
  // that fuzzy-resolved to an unrelated node (e.g. `runIndex` →
  // an `import` node) was blamed silently, with no signal that the
  // L-range belongs to a guessed symbol (friction #20, audit group 2 #7).
  const resolved = resolveSymbolToNode(cg, symbol, ctx.refIds);
  if (!resolved) return ok(textResult(symbolNotFound(cg, symbol)));

  const node = resolved.node;
  // Fetch limit+2 so we always have anchors for "earliest" and
  // "most recent" even when the agent's `limit` is small.
  const fetchCap = limit + 2;
  const history = fetchBlameHistory(cg, node, fetchCap);
  if (history.length === 0) {
    return ok(
      textResult(
        `No commit history for \`${symbol}\` (\`${node.filePath}\` L${node.startLine}–${node.endLine}). Either this isn't a git repo, the file is untracked, or the line range hasn't been touched in any tracked commit.`,
      ),
    );
  }

  // Build rows for ALL fetched commits so the rollup sees every author.
  const { allRows } = enrichBlameRowsWithPeers({ history, cg, nodeId: node.id, perCommitPeers });

  // Secondary rename-detection pass: compare the timeline's earliest
  // ISO timestamp against the rename-aware git log --follow history.
  // If --follow goes further back, the line-range log was truncated
  // at a rename — surface a warning. Silently no-ops on git failure.
  const timelineEarliestIso = history.at(-1)?.dateIso ?? null;
  const renameWarning = detectRenameWarning(cg.projectRoot, node.filePath, timelineEarliestIso);

  return ok(
    renderToolResponse({
      body: renderBlame(
        buildBlameResult({ node, history, allRows, limit, fetchCap, renameWarning, fuzzyBanner: resolved.fuzzyBanner }),
      ),
    }),
  );
}

function fmtRow(row: BlameRow): string[] {
  const lines: string[] = [];
  const date = row.commit.dateIso.slice(0, 10);
  lines.push(`- \`${row.commit.shortSha}\` ${date} — ${row.commit.author}`);
  lines.push(`    ${row.commit.subject}`);
  if (row.coTouched.length > 0) {
    const peers = row.coTouched.map((p) => `\`${p.name}\` (${p.kind})`).join(', ');
    const extra = row.coTouchedTotal - row.coTouched.length;
    const more = extra > 0 ? ` (+${extra} more)` : '';
    lines.push(`    co-touched (issue-tagged commit): ${peers}${more}`);
  }
  return lines;
}

/**
 * Build the `### Earliest known` section spec — single-row H3 bullet
 * list anchoring the oldest commit that touched the symbol's line
 * range. Wording lives on the spec so the wording-lint walks it.
 * Caller (`renderBlame`) only invokes the renderer when `r.earliest`
 * is non-null, so `emptyState` is the never-rendered empty string.
 */
export function buildBlameEarliestSpec(row: BlameRow): MarkdownBulletListSpec<BlameRow> {
  return {
    title: 'Earliest known',
    headingLevel: 3,
    rows: [row],
    formatRow: fmtRow,
    emptyState: '',
  };
}

/**
 * Build the `### Most recent` section spec — single-row H3 bullet
 * list pinning the most recent commit that touched the line range.
 * Only emitted when distinct from {@link buildBlameEarliestSpec} (the
 * caller in `renderBlame` enforces that), so `emptyState` is unused.
 */
export function buildBlameMostRecentSpec(row: BlameRow): MarkdownBulletListSpec<BlameRow> {
  return {
    title: 'Most recent',
    headingLevel: 3,
    rows: [row],
    formatRow: fmtRow,
    emptyState: '',
  };
}

/**
 * Build the `### Recent activity` section spec — newest-first
 * timeline of the surfaced commits (already capped to `limit` by the
 * caller). Title interpolates the actual row count so the user knows
 * what "top N" means in their query's context.
 */
export function buildBlameRecentActivitySpec(rows: ReadonlyArray<BlameRow>): MarkdownBulletListSpec<BlameRow> {
  return {
    title: `Recent activity (newest first, top ${rows.length})`,
    headingLevel: 3,
    rows,
    formatRow: fmtRow,
    emptyState: '',
  };
}

/**
 * Build the `### Authors` section spec — per-author commit rollup
 * across ALL fetched commits (not just the `limit`-capped timeline)
 * so the earliest + most-recent authors aren't silently dropped when
 * they fall outside the top window. Title interpolates the fetched
 * count so the reader can reconcile it against the commit count.
 */
export function buildBlameAuthorsSpec(
  authors: ReadonlyArray<BlameAuthor>,
  fetchedCommits: number,
): MarkdownBulletListSpec<BlameAuthor> {
  return {
    title: `Authors (across ${fetchedCommits} fetched commit(s))`,
    headingLevel: 3,
    rows: authors,
    formatRow: (a) => {
      const commitWord = a.commits === 1 ? 'commit' : 'commits';
      return `- **${a.name}** — ${a.commits} ${commitWord}`;
    },
    emptyState: '',
  };
}

function renderBlame(r: BlameResult): string {
  const lines: string[] = [];
  lines.push(`## Blame for \`${r.symbolName}\``);
  lines.push('');
  // Fuzzy-fallback banner — surfaced directly under the title so the
  // agent sees, before reading the L-range timeline, that the blamed
  // symbol was a guess (matches the fuzzy note `cartograph_history`
  // surfaces; friction #20).
  if (r.fuzzyBanner) {
    lines.push(r.fuzzyBanner);
    lines.push('');
  }
  const countLabel = r.truncated ? `≥${r.fetchedCommits}` : `${r.fetchedCommits}`;
  // Only render "(showing top N)" when N is actually a truncation of the
  // fetched timeline. When `limit` ≥ fetchedCommits, every commit is shown
  // and "(showing top 1)" reads as if more were omitted — surfaced as a
  // friction nit by the bug-hunt sweep. Truncated is computed from
  // history vs fetchCap (= limit+2) so the "≥N" label still fires for
  // genuinely capped timelines.
  const showingSuffix = r.commits.length < r.fetchedCommits ? ` (showing top ${r.commits.length})` : '';
  lines.push(
    `_${r.qualifiedName} — ${r.filePath} L${r.startLine}–${r.endLine} — ${countLabel} commit(s) touched this range${showingSuffix}._`,
  );
  lines.push('');
  if (r.earliest) {
    lines.push(renderMarkdownBulletList(buildBlameEarliestSpec(r.earliest)));
  }
  const mostRecentIsDifferent = r.mostRecent && (!r.earliest || r.mostRecent.commit.sha !== r.earliest.commit.sha);
  if (mostRecentIsDifferent) {
    lines.push(renderMarkdownBulletList(buildBlameMostRecentSpec(r.mostRecent!)));
  }
  if (r.commits.length > 0) {
    lines.push(renderMarkdownBulletList(buildBlameRecentActivitySpec(r.commits)));
  }
  if (r.authors.length > 0) {
    lines.push(renderMarkdownBulletList(buildBlameAuthorsSpec(r.authors, r.fetchedCommits)));
  }
  if (r.renameWarning) {
    lines.push(r.renameWarning);
  }
  return lines.join('\n');
}

export const BLAME_TOOL = defineTool({
  name: 'cartograph_blame',
  description:
    "Symbol-level git blame — who/when/why timeline for one symbol's line range (`git log -L`). " +
    'Returns commit list + author rollup + co-touched symbols. ' +
    'Line-range follow does NOT survive renames — truncates at the rename with a warning.',
  schema: blameSchema,
  handle: handleBlame,
});
