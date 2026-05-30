/**
 * ChangeOracle — the single entry point for "is this file changed?".
 *
 * Cartograph computes file-change facts via several distinct mechanisms:
 *
 *  - `gitDiff` — `git diff --name-status <ref>` + `ls-files --others`
 *    (working tree vs the ref, including untracked).
 *  - `contentDrift` — re-hash every tracked file and compare against
 *    `files.content_hash` in the index. Catches what git misses: a
 *    committed file that was rewritten by a formatter after indexing,
 *    a partial sync that left the row stale, a watcher event that got
 *    dropped.
 *  - `healFlagged` — `files.needs_reextract = 1`. On-disk content is
 *    unchanged but the extractor's emit-set rotated and the row needs
 *    to be re-walked (e.g. `EXTRACTION_LOGIC_VERSION` self-heal).
 *  - `vanished` — tracked files whose path no longer exists on disk.
 *
 * Each mechanism is a primitive that lives in its own module
 * (`git-utils`, `freshness`, `queries-files`). Before this module they
 * were called directly from several tools, and the result was silent
 * disagreement: status would tell the user "run sync to refresh"
 * referencing one facet, sync would consult a different facet, and the
 * user-visible diagnosis would never converge. The ChangeOracle wraps
 * all four facets in a single typed snapshot so tools STATE which
 * facets they care about and the answers are commensurable.
 *
 * Cost model: tools pay only for facets they request. `gitDiff` is one
 * subprocess; `contentDrift` and `vanished` walk the indexed file list
 * once, with one `stat` per row (mtime fast-path makes the hash check
 * skippable on quiescent trees); `healFlagged` is one indexed SQL
 * query. Callers that need multiple facets pay the union once.
 *
 * See `__tests__/change-oracle.test.ts` for the cross-tool invariants
 * — those are the contract that keeps this module honest as new tools
 * are added.
 */
import { listChangedFilesSince } from '../git-utils.js';
import { findVanishedFiles, getStaleFiles } from '../freshness.js';
import { getAllFiles, getFilesNeedingReextract } from '../db/queries-files.js';
import type { QueryBuilder } from '../db/queries.js';

/** The four discrete change signals cartograph tracks per file. Each one
 *  has a precise definition documented on the corresponding field of
 *  {@link ChangeSnapshot} — DO NOT compute "changed" any other way in
 *  a new tool; route through this module so the answer is consistent
 *  with what status, sync, and changed_since report. */
export type ChangeFacet = 'gitDiff' | 'contentDrift' | 'healFlagged' | 'vanished';

/** All four facets — convenience for "give me everything." */
export const ALL_FACETS: ReadonlySet<ChangeFacet> = new Set<ChangeFacet>([
  'gitDiff',
  'contentDrift',
  'healFlagged',
  'vanished',
]);

/** Typed snapshot of "what's changed" along the four facets. Tools
 *  should always state which facets they want explicitly — don't
 *  assume the union is what they need. */
export interface ChangeSnapshot {
  /**
   * Working-tree files git considers changed vs the requested ref
   * (HEAD by default). Includes untracked. `null` when git is
   * unavailable or the repo is invalid — callers should treat that as
   * "git-side change detection unavailable, fall back to other facets."
   */
  gitDiff: { ref: string; paths: ReadonlySet<string> } | null;

  /**
   * Tracked files whose current on-disk SHA differs from
   * `files.content_hash` in the index. mtime-then-hash, so a quiescent
   * tree costs one `stat` per file.
   *
   * **What this catches that gitDiff doesn't**: a file that was
   * committed BEFORE indexing then re-written (formatter / auto-save)
   * AFTER indexing — git status reads clean, the indexed hash lags
   * disk. The status banner that recommends `admin sync` is driven by
   * this facet; before #7's fix, sync's git fast-path also missed it,
   * leading to a "run sync / sync says 0 scanned / status still
   * flagged" loop.
   */
  contentDrift: ReadonlySet<string>;

  /**
   * Files flagged by `files.needs_reextract = 1`. On-disk content is
   * unchanged but the extractor's emit-set rotated (e.g.
   * `EXTRACTION_LOGIC_VERSION` self-heal) and the row needs a re-walk.
   * Sync's git fast-path already unions this set; surfacing it here
   * lets other tools (status drift banner, future PR-review tooling)
   * see the same "needs re-extract" signal that sync acts on.
   */
  healFlagged: ReadonlySet<string>;

  /**
   * Indexed files whose path no longer exists on disk. Covers both
   * git-deleted and untracked-then-removed (e.g. a scratch file that
   * was indexed once and then `rm`'d — git never tracked it, so git
   * diff doesn't report it). Implemented by the shared
   * `findVanishedFiles` primitive in `freshness.ts` so this Oracle
   * facet and the extraction-side `eoFindVanishedFiles` answer the
   * exact same question — divergence is impossible by construction.
   */
  vanished: ReadonlySet<string>;
}

/** Query shape — caller declares which facets it cares about and the
 *  `gitDiff` reference if applicable. */
export interface ChangeOracleQuery {
  /**
   * Compute only the named facets. Each one has its own O(N-files)
   * cost class, so a tool that only needs `contentDrift` should not
   * request `vanished` just in case.
   */
  facets: ReadonlySet<ChangeFacet>;

  /**
   * Git ref to diff the working tree against. Default 'HEAD'.
   * Ignored when `facets` doesn't include `gitDiff`.
   */
  gitRef?: string;
}

/** Compute a ChangeSnapshot along the requested facets. */
export function whatChanged(rootDir: string, queries: QueryBuilder, query: ChangeOracleQuery): ChangeSnapshot {
  const facets = query.facets;
  // `contentDrift` and `vanished` both walk the indexed file list; if
  // either is requested fetch the list ONCE and share it. `gitDiff` and
  // `healFlagged` don't need the row list at all.
  const needsRowList = facets.has('contentDrift') || facets.has('vanished');
  const allIndexedFiles = needsRowList ? getAllFiles(queries) : [];

  let gitDiff: ChangeSnapshot['gitDiff'] = null;
  if (facets.has('gitDiff')) {
    const ref = query.gitRef ?? 'HEAD';
    const list = listChangedFilesSince(rootDir, ref);
    gitDiff = list !== null ? { ref, paths: new Set(list) } : null;
  }

  const contentDrift: ReadonlySet<string> = facets.has('contentDrift')
    ? new Set(getStaleFiles(rootDir, allIndexedFiles))
    : EMPTY_SET;

  const healFlagged: ReadonlySet<string> = facets.has('healFlagged')
    ? new Set(getFilesNeedingReextract(queries))
    : EMPTY_SET;

  const vanished: ReadonlySet<string> = facets.has('vanished')
    ? new Set(findVanishedFiles(rootDir, allIndexedFiles))
    : EMPTY_SET;

  return { gitDiff, contentDrift, healFlagged, vanished };
}

/** Union over the requested facets — typical "give me every file that
 *  might need re-extraction" pattern. `null` `gitDiff` (git unavailable)
 *  contributes nothing, never throws. */
export function changedFileUnion(snap: ChangeSnapshot, facets: ReadonlySet<ChangeFacet>): Set<string> {
  const out = new Set<string>();
  if (facets.has('gitDiff') && snap.gitDiff) {
    for (const p of snap.gitDiff.paths) out.add(p);
  }
  if (facets.has('contentDrift')) for (const p of snap.contentDrift) out.add(p);
  if (facets.has('healFlagged')) for (const p of snap.healFlagged) out.add(p);
  if (facets.has('vanished')) for (const p of snap.vanished) out.add(p);
  return out;
}

/** Stable empty set shared by every "facet not requested" slot — avoids
 *  allocating a fresh `new Set()` per call. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();
