/**
 * Issue → symbol attribution from git history
 *
 * Mines commits whose subject or body matches `Fixes #N` /
 * `Closes #N` / `Resolves #N` and attributes their hunks to the
 * symbols they touched. Result is stored in the `symbol_issues`
 * table and surfaced via `cartograph_node` so an agent inspecting
 * `runInstaller` sees "modified by issues #37, #68, #69" inline.
 *
 * Why hunk-level, not file-level: spike data (see `spike_issues.js`
 * + `spike_issues_hunk.js`) showed that file-level produced ~40
 * symbols/issue, mostly noise — every issue touches files with
 * many irrelevant symbols. Hunk-level is ~9 symbols/issue with
 * 78% noise reduction, AND uniquely enables the multi-issue-symbol
 * query (e.g. "loadGrammarsForLanguages was modified by every
 * language-add issue") which file-level cannot answer because the
 * intersection at file granularity is trivially huge.
 *
 * Convention: only `(Fixes|Closes|Resolves) #N` commits are mined.
 * Generic commit messages without an issue ref are ignored — keeps
 * signal-to-noise high.
 *
 * Known v1 limitations:
 *   - `Fixes #1, #2` only captures #1. The regex requires a verb
 *     prefix per match; `, #2` has no verb so it's skipped. Authors
 *     who care should write `Fixes #1, fixes #2`. Acceptable noise
 *     for v1; revisit if real projects show many comma-list misses.
 *   - Quoted issue references in commit bodies (e.g. "this reverts the
 *     'Fixes #99' commit from last week") produce false positives.
 *     Detection would require message-block parsing; out of scope for v1.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logDebug, errMsg } from '../errors.js';
import { parseCommitDiff } from './parse-diff.js';
import { getCurrentHeadSha, isShaReachable } from '../git-utils.js';

const execFileAsync = promisify(execFile);

/**
 * Concurrency cap for per-commit `git show` subprocesses in
 * {@link mineIssueHistory}. A repo with hundreds of `Fixes #N`
 * commits would otherwise spawn hundreds of git processes in
 * parallel — file-descriptor exhaustion and OS process-table
 * pressure outweigh the parallelism win past ~8. Empirical sweet
 * spot on the cartograph repo (M-series, 100 issue commits): 8
 * matches the test-runner default and stays well clear of the
 * ulimit default.
 */
const PARSE_DIFF_CONCURRENCY = 8;

/** Project-metadata key holding the HEAD SHA at the last successful mine. */
export const LAST_MINED_ISSUES_HEAD_KEY = 'last_mined_issues_head';

/**
 * Skip commits touching more than this many files. Squashed merges
 * and mass refactors otherwise produce many false-positive
 * attributions where every symbol in the commit gets credited to
 * the issue.
 */
const MAX_FILES_PER_COMMIT = 50;

/**
 * Match `fix #N` / `fixes #N` / `closes #N` / `resolves #N` (and
 * past-tense variants), case-insensitive, allowing `:` or `-`
 * between verb and `#`. Captures the issue number.
 */
export const ISSUE_REGEX = /\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s*[:-]?\s*#(\d+)/gi;

const MAX_GIT_BUFFER = 200 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

interface IssueCommit {
  sha: string;
  /** Distinct issue numbers referenced, in source order. */
  issues: number[];
}

type AttributionKind = 'modified' | 'added' | 'removed';

interface IssueAttribution {
  nodeId: string;
  issueNumber: number;
  commitSha: string;
  kind: AttributionKind;
}

interface IssueMineResult {
  attributions: IssueAttribution[];
  /** HEAD SHA reached by this run. null when not in a git repo. */
  currentHead: string | null;
  /** Caller's `sinceSha` was unreachable — caller clears + re-mines from scratch. */
  needsFullRescan: boolean;
  /** Debug-only counter: (file, name) lookups that didn't resolve. */
  unresolvedCount: number;
}

/** Resolver supplied by the caller: (file, name) → node_id | null. */
type SymbolResolver = (filePath: string, symbolName: string) => string | null;

/**
 * Find commits whose message references at least one issue. Returns
 * `[]` when not in a git repo or git fails (logged via logDebug;
 * never throws to the caller).
 *
 * Format: `git log --no-merges -z --pretty=format:CGCMT-%H%n%s%n%b%n` —
 * each commit terminated by a NUL. The body line lets us match
 * trailers like `Fixes #N` that aren't in the subject.
 */
export async function mineIssueCommits(rootDir: string, sinceSha: string | null): Promise<IssueCommit[]> {
  const args = ['log', '--no-merges', '-z', '--pretty=format:CGCMT-%H%n%s%n%b'];
  if (sinceSha) args.push(`${sinceSha}..HEAD`);

  let raw: string;
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_BUFFER,
    });
    raw = stdout;
  } catch (err) {
    logDebug(`mineIssueCommits: git log failed: ${errMsg(err)}`);
    return [];
  }

  const commits: IssueCommit[] = [];
  const blocks = raw.split('\0');
  const headerRe = /^CGCMT-([0-9a-f]{40})$/;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const m = headerRe.exec(lines[0] ?? '');
    if (!m) continue;
    const sha = m[1]!;
    const messageBody = lines.slice(1).join('\n');
    const issues = new Set<number>();
    let match: RegExpExecArray | null;
    ISSUE_REGEX.lastIndex = 0;
    while ((match = ISSUE_REGEX.exec(messageBody)) !== null) {
      const n = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(n) && n > 0) issues.add(n);
    }
    if (issues.size > 0) commits.push({ sha, issues: [...issues] });
  }
  return commits;
}

/**
 * Mine issue→symbol attributions.
 *
 * @param rootDir         Project root.
 * @param resolveSymbol   (filePath, name) → nodeId | null. Closure
 *                        over the current index. Names that don't
 *                        resolve are dropped (counted as unresolved
 *                        for diagnostics).
 * @param sinceSha        null = full mine; otherwise `<sha>..HEAD`.
 *                        Unreachable shas trigger needsFullRescan.
 */
export async function mineIssueHistory(
  rootDir: string,
  resolveSymbol: SymbolResolver,
  sinceSha: string | null,
): Promise<IssueMineResult> {
  const empty: IssueMineResult = {
    attributions: [],
    currentHead: null,
    needsFullRescan: false,
    unresolvedCount: 0,
  };

  const head = getCurrentHeadSha(rootDir);
  if (!head) return empty;

  if (sinceSha && !isShaReachable(rootDir, sinceSha)) {
    return { attributions: [], currentHead: head, needsFullRescan: true, unresolvedCount: 0 };
  }
  if (sinceSha === head) {
    return { attributions: [], currentHead: head, needsFullRescan: false, unresolvedCount: 0 };
  }

  const commits = await mineIssueCommits(rootDir, sinceSha);
  const ctx: MineCtx = {
    rootDir,
    resolveSymbol,
    attributions: [],
    counters: { unresolved: 0 },
  };

  // Per-commit `git show` subprocesses fan out via a small async
  // pool: each worker pulls the next commit off the queue and
  // processes it. PARSE_DIFF_CONCURRENCY caps total in-flight git
  // processes — the order of `processOneIssueCommit` writes into
  // `ctx.attributions` is non-deterministic across runs as a result,
  // but `emitFileAttributions` already produces a stable per-commit
  // order, and the downstream `applyIssueAttributions` writer is
  // commutative on the `symbol_issues` row set.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARSE_DIFF_CONCURRENCY, commits.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= commits.length) return;
        await processOneIssueCommit(ctx, commits[i]!);
      }
    }),
  );

  return {
    attributions: ctx.attributions,
    currentHead: head,
    needsFullRescan: false,
    unresolvedCount: ctx.counters.unresolved,
  };
}

/** Per-mine context — bundles long params for the per-commit / per-file helpers. */
interface MineCtx {
  rootDir: string;
  resolveSymbol: SymbolResolver;
  attributions: IssueAttribution[];
  counters: { unresolved: number };
}

/**
 * Process one issue-tagged commit: parse its diff, drop squashed mass
 * refactors, and emit per-symbol attributions. Mutates `ctx.attributions`
 * and `ctx.counters.unresolved` in place.
 */
async function processOneIssueCommit(ctx: MineCtx, c: { sha: string; issues: number[] }): Promise<void> {
  let perFile: Awaited<ReturnType<typeof parseCommitDiff>>;
  try {
    perFile = await parseCommitDiff(ctx.rootDir, c.sha);
  } catch (err) {
    logDebug(`parseCommitDiff failed for ${c.sha}: ${errMsg(err)}`);
    return;
  }
  if (perFile.size > MAX_FILES_PER_COMMIT) {
    // Squashed mass-refactor — the issue ref is real but the per-symbol
    // attribution would be all noise. Skip the whole commit.
    return;
  }
  for (const [filePath, sets] of perFile) {
    emitFileAttributions({ ctx, c, filePath, sets });
  }
}

interface EmitFileAttributionsArgs {
  ctx: MineCtx;
  c: { sha: string; issues: number[] };
  filePath: string;
  sets: { modCtx: Iterable<string>; added: Iterable<string>; removed: Iterable<string> };
}

/** Emit issue attributions for one (file, change-set) pair in stable order. */
function emitFileAttributions(args: EmitFileAttributionsArgs): void {
  const { ctx, c, filePath, sets } = args;
  const emit = (name: string, kind: AttributionKind): void => {
    const nodeId = ctx.resolveSymbol(filePath, name);
    if (!nodeId) {
      ctx.counters.unresolved += 1;
      return;
    }
    for (const issue of c.issues) {
      ctx.attributions.push({ nodeId, issueNumber: issue, commitSha: c.sha, kind });
    }
  };
  // Order: modified first, then added, then removed. Stable for tests.
  for (const name of sets.modCtx) emit(name, 'modified');
  for (const name of sets.added) emit(name, 'added');
  for (const name of sets.removed) emit(name, 'removed');
}
