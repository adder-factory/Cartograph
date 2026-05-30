/**
 * Co-Change Mining
 *
 * Reads `git log` to discover which files change together, surfacing
 * coupling that static analysis can't see (sibling language extractors
 * that share patterns, tests that assert schema state, config files
 * coupled to the code that reads them, etc.).
 *
 * Storage is a separate `co_changes` table, not the main `edges` graph,
 * because co-change is symmetric and weighted (count of commits where
 * both files changed). Query layer normalizes the count into a Jaccard
 * coefficient at read time using each file's total commit_count.
 *
 * Designed for incremental update: persist `last_mined_head` in
 * project_metadata; on subsequent mines, only enumerate commits since
 * that SHA so sync stays fast even on a large history.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { normalizePath } from '../utils.js';
import { logDebug } from '../errors.js';
import { getCurrentHeadSha, isShaReachable } from '../git-utils.js';

const execFileAsync = promisify(execFile);

/**
 * Skip commits that touch more than this many indexed files. Merge
 * commits and large refactors otherwise produce O(N²) spurious pairs
 * where every file appears coupled to every other.
 */
export const MAX_FILES_PER_COMMIT = 50;

/**
 * Drop pairs with fewer than this many co-changes. Two files that
 * happened to land in the same commit once usually aren't meaningfully
 * coupled; the signal lives in repeated co-occurrence.
 */
export const MIN_COCHANGE_COUNT = 2;

/** Project-metadata key holding the HEAD SHA of the last mined commit. */
export const LAST_MINED_HEAD_KEY = 'last_mined_cochange_head';

/**
 * Timeout (ms) for the co-change `git log` invocation. Larger than the
 * probe timeout because the log walks every commit in range; on a deep
 * history the output can take seconds.
 */
const GIT_LOG_TIMEOUT_MS = 60_000;

/**
 * Output buffer cap for `git log` (200 MB). Sized for full-history
 * scans on large repos — name-only output runs to tens of MB on
 * monorepos, and we'd rather fail loud than truncate silently.
 */
const GIT_LOG_MAX_BUFFER_BYTES = 200 * 1024 * 1024;

interface MinedCoChanges {
  /** Map of "fileA\0fileB" (canonical: fileA < fileB) -> co-change count. */
  pairs: Map<string, number>;
  /** Map of file path -> number of mined commits that touched it. */
  fileCommits: Map<string, number>;
  /** Map of commit SHA -> subject line (Stage 7 #2 — feeds the
   *  commit-intent classifier in the cochange index hook). */
  subjects: Map<string, string>;
  /** HEAD SHA reached by this mining run, or null when no commits were seen. */
  currentHead: string | null;
}

/**
 * Mine git history for co-changes.
 *
 * @param rootDir       Project root.
 * @param indexedFiles  Set of paths we care about (typically: every file
 *                      currently tracked in the index). Files outside this
 *                      set are dropped per-commit so we don't accumulate
 *                      pair counts for files we have no other context for.
 * @param sinceSha      If provided, only mine commits in `<sha>..HEAD`.
 *                      Pass `null` for a full history scan. If the SHA is
 *                      unreachable (force-push, gc), returns
 *                      `needsFullRescan: true` so the caller can clear and
 *                      re-mine from scratch.
 */
/**
 * Verify the previous mining anchor is still reachable. Returns:
 *   'rescan'    — sinceSha gone (force-push, gc); caller should clear and re-mine
 *   'unchanged' — sinceSha === currentHead; nothing new to mine
 *   'continue'  — anchor reachable AND distinct; proceed with incremental mine
 *
 * Stays sync (delegates to `isShaReachable` in git-utils) — this is a
 * sub-millisecond `git cat-file -e` probe; making it async would not
 * meaningfully overlap with churn / issue-history's longer log calls.
 */
function checkSinceShaReachability(
  rootDir: string,
  sinceSha: string,
  currentHead: string,
): 'rescan' | 'unchanged' | 'continue' {
  if (!isShaReachable(rootDir, sinceSha)) {
    logDebug('Co-change: previous head unreachable, full rescan required', { sinceSha });
    return 'rescan';
  }
  return sinceSha === currentHead ? 'unchanged' : 'continue';
}

/**
 * Run `git log -z --name-only --format=CGCMT-<sha>` for the range.
 * Returns the raw NUL-delimited output, or null on shell failure
 * (logged + caller treats as "no new co-changes").
 *
 * Async (post-G9) — Group A's three miner hooks run via `Promise.all`
 * in the registry runner, so the long-pole `git log` subprocesses for
 * churn / cochange / issue-history overlap on the event loop instead of
 * blocking it serially.
 */
async function runCoChangeGitLog(
  rootDir: string,
  sinceSha: string | null,
  currentHead: string,
): Promise<string | null> {
  const range = sinceSha ? [`${sinceSha}..${currentHead}`] : [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      // %H = SHA, %x09 = literal TAB, %s = subject line. Stage 7 #2:
      // capturing the subject lets the cochange hook classify intent
      // per commit (feat / fix / refactor / etc).
      ['log', '--no-merges', '--name-only', '--format=tformat:CGCMT-%H%x09%s', '-z', ...range],
      {
        cwd: rootDir,
        encoding: 'utf-8',
        timeout: GIT_LOG_TIMEOUT_MS,
        maxBuffer: GIT_LOG_MAX_BUFFER_BYTES,
      },
    );
    return stdout;
  } catch (error) {
    logDebug('Co-change: git log failed', { error: String(error) });
    return null;
  }
}

/** Header sentinel: `CGCMT-<40-hex-sha>\t<subject>`. The trailing
 *  subject (post-Stage-7-#2) is captured group 2 — empty string when
 *  the commit had no subject line. Won't collide with real filenames
 *  because no path contains a TAB-separator after `CGCMT-` + 40 hex. */
const COCHANGE_HEADER_RE = /^CGCMT-([0-9a-f]{40})(?:\t(.*))?$/s;

/**
 * Walk the NUL-delimited git-log output, accumulating per-commit
 * file lists into co-change pairs and per-file commit counts.
 * Files outside `indexedFiles` are dropped; commits touching more
 * than `MAX_FILES_PER_COMMIT` are skipped to avoid quadratic-pair
 * blowup on monorepo-wide refactors.
 *
 * git log -z output structure (verified empirically):
 *   CGCMT-<sha>\0\n<file>\0<file>\0CGCMT-<sha>\0\n<file>\0...
 * Each \0 is a record terminator; the \n after the format record is
 * a git-emitted separator before the file list.
 */
function tallyCoChangePairs(
  raw: string,
  indexedFiles: Set<string>,
): { pairs: Map<string, number>; fileCommits: Map<string, number>; subjects: Map<string, string> } {
  const pairs = new Map<string, number>();
  const fileCommits = new Map<string, number>();
  const subjects = new Map<string, string>();
  let currentFiles: string[] = [];
  const flush = (): void => {
    if (currentFiles.length === 0) return;
    const filtered = [...new Set(currentFiles.filter((f) => indexedFiles.has(f)))];
    currentFiles = [];
    if (filtered.length === 0 || filtered.length > MAX_FILES_PER_COMMIT) return;
    for (const f of filtered) {
      fileCommits.set(f, (fileCommits.get(f) ?? 0) + 1);
    }
    filtered.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < filtered.length; i++) {
      for (let j = i + 1; j < filtered.length; j++) {
        const key = `${filtered[i]}\0${filtered[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  };
  for (const rawToken of raw.split('\0')) {
    const token = rawToken.replace(/^\s+/, '');
    if (token.length === 0) continue;
    const headerMatch = COCHANGE_HEADER_RE.exec(token);
    if (headerMatch) {
      flush();
      const sha = headerMatch[1]!;
      const subject = (headerMatch[2] ?? '').trim();
      if (subject.length > 0) subjects.set(sha, subject);
    } else {
      currentFiles.push(normalizePath(token));
    }
  }
  flush();
  return { pairs, fileCommits, subjects };
}

export async function mineCoChanges(
  rootDir: string,
  indexedFiles: Set<string>,
  sinceSha: string | null,
): Promise<MinedCoChanges & { needsFullRescan: boolean }> {
  const empty: MinedCoChanges & { needsFullRescan: boolean } = {
    pairs: new Map(),
    fileCommits: new Map(),
    subjects: new Map(),
    currentHead: null,
    needsFullRescan: false,
  };
  const currentHead = getCurrentHeadSha(rootDir);
  if (!currentHead) return empty;

  if (sinceSha) {
    const status = checkSinceShaReachability(rootDir, sinceSha, currentHead);
    if (status === 'rescan') return { ...empty, currentHead, needsFullRescan: true };
    if (status === 'unchanged') return { ...empty, currentHead };
  }

  const raw = await runCoChangeGitLog(rootDir, sinceSha, currentHead);
  if (raw === null) return { ...empty, currentHead };

  const { pairs, fileCommits, subjects } = tallyCoChangePairs(raw, indexedFiles);
  return { pairs, fileCommits, subjects, currentHead, needsFullRescan: false };
}
