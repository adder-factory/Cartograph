/**
 * Per-file churn mining
 *
 * Reads `git log` to compute four signals per indexed file:
 *   - commit_count    (how often the file gets touched)
 *   - first_seen_ts   (when it entered the codebase)
 *   - last_touched_ts (how recently it was modified)
 *   - loc             (line count of the current on-disk content)
 *
 * Combined with PageRank centrality (see ../centrality), these answer
 * "where do bugs hide?" — central files that change often are the
 * highest-expected-value review targets, validated empirically against
 * cartograph's own history (e.g. `src/extraction/tree-sitter.ts`).
 *
 * Storage strategy: scalar columns on `files` (one row already exists
 * per indexed path; adding columns avoids a JOIN on every read).
 *
 * Incremental update: persist `last_mined_churn_head` in
 * project_metadata; on subsequent mines, only enumerate commits in
 * `<sha>..HEAD`. This keeps `sync` fast on long histories. If the
 * stored sha is unreachable (force-push, gc), the caller gets
 * `needsFullRescan: true` and re-mines from scratch after `clearChurn`.
 *
 * Rename note: `git log --name-only` (without `--follow`) reports
 * post-rename paths only. The pre-rename history is therefore not
 * counted toward the new path's `commit_count`. `--follow` would fix
 * this but is documented as O(N) per file and shells out individually,
 * so v1 accepts the under-count and surfaces it in the doc-comment on
 * `commitCount` in types.ts.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { logDebug, errMsg } from '../errors.js';
import { validatePathWithinRootReal } from '../utils.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getCurrentHeadSha, isShaReachable } from '../git-utils.js';

const execFileAsync = promisify(execFile);

/**
 * Skip commits that touch more than this many indexed files. Merge
 * commits and mass refactors otherwise inflate every file's
 * commit_count without any real coupling signal.
 */
export const MAX_FILES_PER_COMMIT = 50;

/** Sentinel for `git log --pretty=tformat:`; cannot collide with a path. */
const COMMIT_HEADER_PREFIX = 'CGCMT-';

/** Project-metadata key holding the HEAD SHA of the last mined commit. */
export const LAST_MINED_CHURN_HEAD_KEY = 'last_mined_churn_head';

/**
 * Churn-mining algorithm version. The hook stamps this onto
 * project_metadata; a stored value other than the current one triggers
 * a one-shot full re-mine on the next `afterSync` so persisted
 * `commit_count` values self-heal after a mining-logic change — no
 * `cartograph index` needed.
 *
 * Derived from a sha256 of this file's source via `computeAlgoHash`
 * (comment-strip + whitespace-normalise, so JSDoc / reformat-only edits
 * don't invalidate). Pre-2026-05-15 this was a hand-bumped string
 * literal ('1' → '2') — switching to a source-derived hash removes the
 * manual bump: editing the mining logic below changes the hash
 * automatically, matching `EXTRACTION_LOGIC_VERSION` / `PAYLOAD_VERSION`
 * / `BIOMARKER_CACHE_KEY`. See `src/algo-hash.ts` for the helper.
 *
 * History (hand-bumped era, kept for archaeology — see git blame):
 *   '1' — pre-2026-04-30 (cap on raw paths; under-counted commit_count
 *         when a commit also touched many non-indexed files).
 *   '2' — 2026-04-30 (cap on indexed paths; matches mineCoChanges).
 */
export const CHURN_ALGO_VERSION = computeAlgoHash(import.meta.url, ['./index']);

/** Project-metadata key holding the algo version of the last mining run. */
export const LAST_MINED_CHURN_ALGO_VERSION_KEY = 'last_mined_churn_algo_version';

/** Hard cap on git output we'll buffer (bytes). Matches cochange. */
const MAX_GIT_BUFFER = 200 * 1024 * 1024;

/** Wall-clock cap on a single git invocation (ms). */
const GIT_TIMEOUT_MS = 60_000;

interface FileChurnDelta {
  path: string;
  /** Commits to add to the existing commit_count. */
  commitCountDelta: number;
  /**
   * Most recent commit timestamp (unix seconds) seen in this delta.
   * Caller takes max() with the existing value.
   */
  lastTouchedTs: number;
  /**
   * Earliest commit timestamp (unix seconds) in this delta. Caller
   * applies `COALESCE(existing, this)` so the first-seen column only
   * gets written once.
   */
  firstSeenTs: number;
}

interface ChurnMineResult {
  deltas: Map<string, FileChurnDelta>;
  /** HEAD SHA reached by this run; null when not in a git repo. */
  currentHead: string | null;
  /**
   * True when the caller's `sinceSha` was unreachable (force-push, gc).
   * Caller should `clearChurn()` and re-mine with `sinceSha=null`.
   */
  needsFullRescan: boolean;
}

/**
 * Read the LOC of a file as currently on disk. Cheap; always fresh.
 *
 * Counts newline-delimited lines: a file with content `"a\nb\n"`
 * reports 2; an empty file reports 0; a file ending without a newline
 * still reports the visible-line count.
 */
export function readFileLoc(rootDir: string, relPath: string): number {
  try {
    const abs = validatePathWithinRootReal(rootDir, relPath);
    if (!abs) return 0;
    const content = fs.readFileSync(abs, 'utf8');
    if (content.length === 0) return 0;
    let lines = 0;
    for (const char of content) if (char === '\n') lines++;
    // Trailing chunk without final newline still counts as a line.
    if (!content.endsWith('\n')) lines++;
    return lines;
  } catch {
    return 0;
  }
}

/**
 * Mine git log for per-file commit metrics.
 *
 * @param rootDir       Project root.
 * @param indexedFiles  Paths we care about (deltas only emitted for
 *                      these). Files outside this set are ignored
 *                      per-commit so churn doesn't accumulate for
 *                      paths the index has no other knowledge of.
 * @param sinceSha      `null` for full scan; otherwise mine only
 *                      `<sha>..HEAD`. Unreachable shas trigger
 *                      `needsFullRescan: true`.
 */
export async function mineChurn(
  rootDir: string,
  indexedFiles: Set<string>,
  sinceSha: string | null,
): Promise<ChurnMineResult> {
  const head = getCurrentHeadSha(rootDir);
  if (!head) return { deltas: new Map(), currentHead: null, needsFullRescan: false };

  if (sinceSha && !isShaReachable(rootDir, sinceSha)) {
    return { deltas: new Map(), currentHead: head, needsFullRescan: true };
  }
  // No-op: nothing has happened since last mine.
  if (sinceSha === head) {
    return { deltas: new Map(), currentHead: head, needsFullRescan: false };
  }

  const raw = await runChurnGitLog(rootDir, sinceSha);
  if (raw === null) {
    return { deltas: new Map(), currentHead: head, needsFullRescan: false };
  }

  const deltas = parseChurnTokens(raw, indexedFiles);
  return { deltas, currentHead: head, needsFullRescan: false };
}

/**
 * Run `git log` with a tformat header before each commit's name-list
 * so the parser can track commit boundaries inside a single
 * NUL-delimited token stream. Returns the raw output, or null if the
 * git invocation failed (timeout, missing repo, oversized buffer).
 *
 * Async (post-G9) so three concurrent miner hooks (churn / cochange /
 * issue-history) can overlap their long-pole `git log` subprocesses
 * via `Promise.all` in the registry's Group A runner. Sync probes
 * (`getCurrentHeadSha` / `isShaReachable`) are still synchronous — they
 * complete in milliseconds and don't dominate wall-clock.
 */
async function runChurnGitLog(rootDir: string, sinceSha: string | null): Promise<string | null> {
  const args = ['log', '--no-merges', '--name-only', `--pretty=tformat:${COMMIT_HEADER_PREFIX}%H|%ct`, '-z'];
  if (sinceSha) args.push(`${sinceSha}..HEAD`);

  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_BUFFER,
    });
    return stdout;
  } catch (err) {
    logDebug(`mineChurn: git log failed: ${errMsg(err)}`);
    return null;
  }
}

/**
 * Flush accumulated paths into deltas, filtering to indexed files.
 */
interface FlushChurnPathsArgs {
  deltas: Map<string, FileChurnDelta>;
  curPaths: string[];
  curTs: number;
  indexedFiles: Set<string>;
}

function flushChurnPaths(args: FlushChurnPathsArgs): void {
  const { deltas, curPaths, curTs, indexedFiles } = args;
  const filtered = curPaths.filter((p) => indexedFiles.has(p));
  if (filtered.length > 0 && filtered.length <= MAX_FILES_PER_COMMIT) {
    for (const p of filtered) {
      accumulateChurnDelta(deltas, p, curTs);
    }
  }
}

/**
 * Normalize a raw token by stripping leading newline (tformat separator).
 */
function normalizeTok(rawTok: string): string {
  return rawTok.startsWith('\n') ? rawTok.slice(1) : rawTok;
}

/**
 * Walk the NUL-delimited git-log token stream and accumulate per-file
 * churn deltas. tformat emits `CGCMT-<sha>|<ts>\0\n<path1>\0<path2>\0…
 * CGCMT-<next>|<ts>\0\n<path1>\0` — each token is either a commit
 * header or a path, and paths arrive with a leading `\n` on the first
 * path of each commit (the tformat record-separator). We linearly
 * switch commit context on every header and accumulate paths until
 * the next one.
 *
 * Filtering: a commit only contributes to deltas when its
 * indexed-file count is in (0, MAX_FILES_PER_COMMIT]. The lower bound
 * skips no-op commits; the upper bound matches the cochange path's
 * doc-commented threshold so `getCoChangedFiles` can't produce a
 * jaccard > 1 when a 60-file lockfile bump dominates the commit.
 */
function parseChurnTokens(raw: string, indexedFiles: Set<string>): Map<string, FileChurnDelta> {
  const deltas = new Map<string, FileChurnDelta>();
  const headerRe = /^CGCMT-([0-9a-f]{40})\|(\d+)$/;

  let curTs = 0;
  let curPaths: string[] = [];
  let curActive = false;

  for (const rawTok of raw.split('\0')) {
    if (rawTok === '') continue;
    const tok = normalizeTok(rawTok);
    if (tok === '') continue;

    const m = headerRe.exec(tok);
    if (m) {
      // Start of new commit
      if (curActive) {
        flushChurnPaths({ deltas, curPaths, curTs, indexedFiles });
        curPaths = [];
      }
      curTs = Number.parseInt(m[2]!, 10);
      curActive = true;
    } else if (curActive) {
      // File path in current commit
      curPaths.push(tok);
    }
    // Tokens before the first header (shouldn't happen) are ignored.
  }

  // Flush final commit
  if (curActive) {
    flushChurnPaths({ deltas, curPaths, curTs, indexedFiles });
  }

  return deltas;
}

/** Append one path's contribution to the running delta map, creating or updating in place. */
function accumulateChurnDelta(deltas: Map<string, FileChurnDelta>, path: string, ts: number): void {
  const cur = deltas.get(path);
  if (cur) {
    cur.commitCountDelta += 1;
    if (ts > cur.lastTouchedTs) cur.lastTouchedTs = ts;
    if (ts < cur.firstSeenTs) cur.firstSeenTs = ts;
  } else {
    deltas.set(path, {
      path,
      commitCountDelta: 1,
      lastTouchedTs: ts,
      firstSeenTs: ts,
    });
  }
}
