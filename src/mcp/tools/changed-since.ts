/**
 * `cartograph_changed_since` — list indexed files that have drifted
 * on disk since the index was built (or since a caller-supplied
 * timestamp). Reviewer-suggested 2026-05-03 as the single biggest
 * staleness friction during code review: the existing freshness
 * banner says "11 files changed" but doesn't NAME them, so the
 * reviewer falls back to `Read` on every diffed line to ground-truth
 * the implementation.
 *
 * This tool fills that gap: returns `{ added, modified, deleted }`
 * lists plus a one-line summary, so callers can decide which
 * subsequent cartograph_* responses to trust vs verify by reading
 * source directly.
 *
 * Cheap, pure-read, no schema change. The `added` set requires a
 * filesystem walk (the index doesn't know about un-indexed files);
 * `modified` and `deleted` come from comparing the indexed `files`
 * rows against current `fs.stat`. The walk respects the project's
 * include/exclude config so we don't surface .git/, node_modules/,
 * etc. as "newly added".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { getAllFiles } from '../../db/queries-files.js';
import { isFileStale } from '../../freshness.js';
import { validatePathWithinRootReal } from '../../utils.js';
import { shortSha } from '../../git-utils.js';
import { NON_SOURCE_DIR_NAMES } from '../../path-class.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import type Cartograph from '../../index.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';

/**
 * Bucket labels — exported so the wording-lint test (#32) can pin
 * the user-facing axis terms. The label IS the user-facing wording
 * the renderer composes into the H3 section heading; a label change
 * lands in {@link buildChangedSinceBucketSpec}'s title and surfaces
 * through `bulletListSpecStrings`. Splitting "Modified after
 * threshold" from "Content-changed" was the fix for the audit Group
 * 2 #3 finding: with a `since` threshold the tool measures wall-clock
 * mtime, not SHA drift, so the bucket can't claim "content".
 */
export const CHANGED_SINCE_CONTENT_LABEL = 'Content-changed';
export const CHANGED_SINCE_THRESHOLD_LABEL = 'Modified after threshold (by mtime)';
export const CHANGED_SINCE_ADDED_LABEL = 'Added';
export const CHANGED_SINCE_DELETED_LABEL = 'Deleted';

const MAX_PER_BUCKET = 100;

/**
 * Zod schema for `cartograph_changed_since`. `since` stays a plain
 * optional string — the handler's `parseSinceArg` does the
 * ISO-date-vs-unix-ms discrimination and is intentionally left
 * permissive (it still accepts a raw number for MCP clients that
 * serialise the threshold that way). No numeric range arg here, so
 * there is no clamp to remove.
 */
const changedSinceSchema = z.object({
  since: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Optional threshold: an ISO date string, a unix-millisecond integer (string or number). Omit to compare each file against its indexed mtime+content-hash ('is the index stale?').",
    ),
  projectPath: projectPathField,
});

type ChangedSinceToolArgs = z.infer<typeof changedSinceSchema>;

interface ChangedReport {
  added: string[];
  modified: string[];
  deleted: string[];
  /** True when any bucket hit MAX_PER_BUCKET — so output can show "+N more, capped". */
  modifiedTruncated: boolean;
  deletedTruncated: boolean;
  addedTruncated: boolean;
  /** Indexed-at timestamp the comparison used. */
  thresholdMs: number;
  totalIndexedFiles: number;
}

/**
 * Resolve the optional `since` argument to a unix-ms threshold.
 * Returns `{ thresholdMs }` (null = use per-file isFileStale) or
 * `{ error }` carrying the failure message string for an invalid
 * input — the handler maps that to the typed `err(...)` arm.
 */
/** A JS `Date` can only represent ±8.64e15 ms; a larger `since`
 *  threshold would later crash `new Date(...).toISOString()` with
 *  "Invalid time value". Reject anything beyond it up front. */
const MAX_UNIX_MS = 8_640_000_000_000_000;

function parseSinceArg(sinceArg: unknown): { thresholdMs: number | null } | { error: string } {
  if (sinceArg === undefined) return { thresholdMs: null };
  if (typeof sinceArg === 'number') {
    if (!Number.isFinite(sinceArg) || sinceArg < 0 || sinceArg > MAX_UNIX_MS) {
      return {
        error: `\`since\` must be a unix-ms integer in [0, ${MAX_UNIX_MS}] or an ISO date string; got ${JSON.stringify(sinceArg)}.`,
      };
    }
    return { thresholdMs: sinceArg };
  }
  if (typeof sinceArg === 'string') {
    if (/^\d+$/.test(sinceArg)) {
      const asNum = Number(sinceArg);
      // An over-range numeric string falls through to `Date.parse`,
      // which returns NaN for it → the clean error path below.
      if (!Number.isNaN(asNum) && asNum <= MAX_UNIX_MS) return { thresholdMs: asNum };
    }
    const parsed = Date.parse(sinceArg);
    if (Number.isNaN(parsed) || parsed < 0) {
      return {
        error: `\`since\` must be an ISO date string or a non-negative unix-ms integer; got ${JSON.stringify(sinceArg)}.`,
      };
    }
    return { thresholdMs: parsed };
  }
  return {
    error: `\`since\` must be a string (ISO date or unix-ms integer), or omitted; got ${typeof sinceArg}.`,
  };
}

interface ScanIndexedFilesArgs {
  projectRoot: string;
  indexed: ReturnType<typeof getAllFiles>;
  thresholdMs: number | null;
  report: ChangedReport;
}

/**
 * Walk indexed files, populating the modified/deleted buckets on
 * `report`. Bails when both buckets are saturated to avoid a
 * 50K-file `statSync` storm on an ancient `since`.
 */
function scanIndexedFiles(args: ScanIndexedFilesArgs): void {
  const { projectRoot, indexed, thresholdMs, report } = args;
  for (const file of indexed) {
    if (report.modified.length >= MAX_PER_BUCKET && report.deleted.length >= MAX_PER_BUCKET) {
      report.modifiedTruncated = true;
      report.deletedTruncated = true;
      break;
    }
    const fullPath = validatePathWithinRootReal(projectRoot, file.path);
    if (!fullPath) continue;
    classifyOneIndexedFile({ file, fullPath, projectRoot, thresholdMs, report });
  }
}

interface ClassifyOneFileArgs {
  file: ReturnType<typeof getAllFiles>[number];
  fullPath: string;
  projectRoot: string;
  thresholdMs: number | null;
  report: ChangedReport;
}

interface CheckModifiedArgs {
  thresholdMs: number | null;
  mtimeMs: number;
  projectRoot: string;
  file: ClassifyOneFileArgs['file'];
}

/** "Has the file drifted from its indexed state?" — picks the wall-clock
 *  threshold path (when `thresholdMs` is set) or falls through to the
 *  hash-comparison `isFileStale`. Pulled out of {@link classifyOneIndexedFile}
 *  to keep its conditionals shallow. */
function checkModified(args: CheckModifiedArgs): boolean {
  const { thresholdMs, mtimeMs, projectRoot, file } = args;
  if (thresholdMs === null) return isFileStale(projectRoot, file);
  return mtimeMs > thresholdMs;
}

/** Classify one indexed file's drift state and push it into the
 *  matching `modified` / `deleted` bucket on `report`. Pulled out
 *  of {@link scanIndexedFiles} so the try/catch + isModified branch
 *  doesn't sit 4-deep under the for-loop. */
function classifyOneIndexedFile(args: ClassifyOneFileArgs): void {
  const { file, fullPath, projectRoot, thresholdMs, report } = args;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(fullPath).mtimeMs;
  } catch {
    if (report.deleted.length < MAX_PER_BUCKET) report.deleted.push(file.path);
    else report.deletedTruncated = true;
    return;
  }
  const isModified = checkModified({ thresholdMs, mtimeMs, projectRoot, file });
  if (!isModified) return;
  if (report.modified.length < MAX_PER_BUCKET) report.modified.push(file.path);
  else report.modifiedTruncated = true;
}

interface CollectAddedFilesArgs {
  projectRoot: string;
  indexed: ReturnType<typeof getAllFiles>;
  indexedSet: ReadonlySet<string>;
  report: ChangedReport;
}

/**
 * Walk the project for files NOT in the index — those are "added"
 * candidates. Restricts to extensions already represented in the
 * indexed set so .gitignore / LICENSE / etc. don't surface as drift.
 */
function collectAddedFiles(args: CollectAddedFilesArgs): void {
  const { projectRoot, indexed, indexedSet, report } = args;
  const knownExts = new Set(indexed.map((f) => path.extname(f.path)).filter(Boolean));
  for (const fullPath of walkProjectFiles(projectRoot, MAX_PER_BUCKET * 2)) {
    const rel = path.relative(projectRoot, fullPath).replaceAll('\\', '/');
    if (indexedSet.has(rel)) continue;
    if (knownExts.size > 0 && !knownExts.has(path.extname(rel))) continue;
    if (report.added.length >= MAX_PER_BUCKET) {
      report.addedTruncated = true;
      break;
    }
    report.added.push(rel);
  }
}

async function handleChangedSince(ctx: ToolCtx, args: ChangedSinceToolArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const sinceArg = args.since;

  const parsed = parseSinceArg(sinceArg);
  if ('error' in parsed) return err(parsed.error);
  const { thresholdMs } = parsed;

  const indexed = getAllFiles(cg.queries);
  const report: ChangedReport = {
    added: [],
    modified: [],
    deleted: [],
    modifiedTruncated: false,
    deletedTruncated: false,
    addedTruncated: false,
    thresholdMs: thresholdMs ?? 0,
    totalIndexedFiles: indexed.length,
  };
  const indexedSet = new Set(indexed.map((f) => f.path));

  scanIndexedFiles({ projectRoot: cg.projectRoot, indexed, thresholdMs, report });
  collectAddedFiles({ projectRoot: cg.projectRoot, indexed, indexedSet, report });

  // Surface the indexed-HEAD-vs-current-HEAD relationship so a caller
  // can tell when the apparently-small per-file count is hiding a
  // much larger commit-count drift visible to `cartograph_status`.
  // FRICTION-status-changed_since-semantic-disagreement (2026-05-14):
  // status was reporting "583 files drifted" while changed_since
  // reported "1 modified" on the same tree — the two tools use
  // different definitions of "changed" (git diff vs content_hash) and
  // neither called out the distinction. The freshness header here lets
  // the reader reconcile the numbers without leaving the tool.
  let freshness: ReturnType<Cartograph['stats']['getFreshness']> | null = null;
  try {
    freshness = cg.stats.getFreshness();
  } catch {
    /* best-effort */
  }

  return ok(textResult(formatReport(report, sinceArg, freshness)));
}

/**
 * Bounded recursive walk of `root` that skips obvious non-source
 * directories ({@link NON_SOURCE_DIR_NAMES}). Stops once `cap` files
 * have been yielded so a giant monorepo doesn't make the tool hang.
 */
function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function* walkProjectFiles(root: string, cap: number): Generator<string> {
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && count < cap) {
    const dir = stack.pop()!;
    for (const e of readDirSafe(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !NON_SOURCE_DIR_NAMES.has(e.name)) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      yield full;
      if (++count >= cap) return;
    }
  }
}

function formatSummary(r: ChangedReport, sinceArg: unknown): string {
  if (sinceArg === undefined) {
    return (
      `Comparing on-disk file content-hash against the indexed snapshot ` +
      `(${r.totalIndexedFiles} indexed files). "Content-changed" means the file's ` +
      `current SHA256 differs from \`files.content_hash\` in the index.`
    );
  }
  return `Comparing on-disk file mtime against \`since\` threshold (${new Date(r.thresholdMs).toISOString()}); ${r.totalIndexedFiles} indexed files.`;
}

/** Render the indexed-HEAD-vs-current-HEAD relationship so a reader can
 *  tell when "1 file content-changed" is hiding "N commits ahead" — the
 *  classic disagreement between this tool and `cartograph_status`.
 *  Returns null when there's nothing to surface (non-git project, no
 *  index metadata, or fully in sync with no drift to explain). */
function formatFreshnessHeader(freshness: ReturnType<Cartograph['stats']['getFreshness']> | null): string | null {
  if (!freshness?.indexedSha) return null;
  const sha = shortSha(freshness.indexedSha);
  if (!freshness.isStale) {
    return `**Indexed HEAD:** \`${sha}\` (current HEAD matches — drift below is uncommitted-on-disk only).`;
  }
  let commitsSeg = 'commits landed since index';
  if (freshness.commitsAhead != null && freshness.commitsAhead > 0) {
    commitsSeg = `${freshness.commitsAhead} commit${freshness.commitsAhead === 1 ? '' : 's'} ahead`;
  }
  const fileCountLabel = freshness.filesChanged === 1 ? 'file' : 'files';
  const filesSeg =
    freshness.filesChanged == null ? '' : ` (${freshness.filesChanged} ${fileCountLabel} in \`git diff\`)`;
  return (
    `**Indexed HEAD:** \`${sha}\` — current HEAD is ${commitsSeg}${filesSeg}. ` +
    `The list below is the per-file *content-hash* drift, which can be smaller than the ` +
    `git-diff count (the index already absorbed the committed work on the last sync).`
  );
}

function formatReport(
  r: ChangedReport,
  sinceArg: unknown,
  freshness: ReturnType<Cartograph['stats']['getFreshness']> | null,
): string {
  const summary = formatSummary(r, sinceArg);
  const totalChanged = r.added.length + r.modified.length + r.deleted.length;
  const anyTruncated = r.modifiedTruncated || r.addedTruncated || r.deletedTruncated;
  const headerSuffix = anyTruncated ? ' — capped' : '';
  const noun = sinceArg === undefined ? 'content-changed since index' : 'newer than threshold';
  const lines: string[] = [
    `## Changed since ${sinceArg === undefined ? 'index' : 'threshold'} (${totalChanged} file${totalChanged === 1 ? '' : 's'} ${noun}${headerSuffix})`,
    '',
    summary,
  ];
  // Surface the indexed-HEAD relationship only on the "no threshold"
  // path — when the caller passed an explicit `since`, this tool is
  // doing wall-clock mtime comparison, not content-hash drift, and the
  // git relationship would be misleading.
  if (sinceArg === undefined) {
    const fh = formatFreshnessHeader(freshness);
    if (fh) lines.push(fh);
  }
  lines.push('');
  // Bucket header wording depends on the comparison basis:
  //  - no `since`  → content-hash compare; the bucket is genuine
  //    *content* drift ("the on-disk SHA differs from
  //    `files.content_hash`") so it reads "Content-changed".
  //  - `since` set → wall-clock mtime compare; an mtime newer than the
  //    threshold is NOT a content change (a fresh checkout bumps every
  //    mtime), so the bucket must NOT claim "content". Label it by what
  //    it actually measures. (audit Group 2 #3.)
  const modifiedLabel = sinceArg === undefined ? CHANGED_SINCE_CONTENT_LABEL : CHANGED_SINCE_THRESHOLD_LABEL;
  appendBucket({ lines, label: modifiedLabel, paths: r.modified, truncated: r.modifiedTruncated });
  appendBucket({ lines, label: CHANGED_SINCE_ADDED_LABEL, paths: r.added, truncated: r.addedTruncated });
  appendBucket({ lines, label: CHANGED_SINCE_DELETED_LABEL, paths: r.deleted, truncated: r.deletedTruncated });
  if (totalChanged === 0) {
    lines.push(
      sinceArg === undefined
        ? '> _No drift — every indexed file matches its on-disk content._'
        : '> _No indexed file has an mtime after the threshold._',
    );
  }
  // Cross-reference to `cartograph_status`. Always show it when this
  // tool ran against the index (sinceArg undefined) so the reader sees
  // the pointer next to the count — that's the case where the two
  // tools' numbers can diverge most dramatically. When the caller
  // passed an explicit `since`, they're already in a comparison mode
  // that has nothing to do with the indexed HEAD, so the pointer
  // would be noise.
  if (sinceArg === undefined) {
    lines.push(
      '',
      '_For commit-count drift vs the indexed HEAD (and the ' +
        'severity-bucketed freshness banner), see `cartograph_status`._',
    );
  }
  return lines.join('\n');
}

interface AppendBucketArgs {
  lines: string[];
  label: string;
  paths: readonly string[];
  truncated: boolean;
}

/** Number of paths (20) to enumerate inline before collapsing to a count.
 *  Keeps the output readable when a very old `since` causes every file to
 *  appear as "modified". */
const MAX_INLINE_PATHS = 20;

/**
 * Build the H3 bucket-section spec for one drift list (Content-changed
 * / Modified after threshold / Added / Deleted). Rows are pre-rendered
 * bullet strings (path or "+N more" hint) so the renderer's
 * `formatRow` is the identity passthrough — keeps the truncation hint
 * inline with the bullets (no blank-line gap, byte-parity with the
 * pre-migration `appendBucket` output).
 *
 * Caller (`formatReport`) guards on `paths.length === 0` before
 * calling, so `emptyState` is the never-rendered empty string.
 */
export function buildChangedSinceBucketSpec(args: {
  label: string;
  paths: readonly string[];
  truncated: boolean;
}): MarkdownBulletListSpec<string> {
  const { label, paths, truncated } = args;
  const cap = truncated ? ` (capped at ${MAX_PER_BUCKET}; pass since=<recent> to narrow)` : '';
  const shown = paths.slice(0, MAX_INLINE_PATHS).map((p) => `- \`${p}\``);
  const overflow =
    paths.length > MAX_INLINE_PATHS
      ? [
          `- _… +${paths.length - MAX_INLINE_PATHS} more not shown. Pass a more recent \`since\` (e.g. an ISO date or recent unix-ms) to narrow the list._`,
        ]
      : [];
  return {
    title: `${label} (${paths.length}${cap})`,
    headingLevel: 3,
    rows: [...shown, ...overflow],
    formatRow: (s) => s,
    emptyState: '',
  };
}

function appendBucket(args: AppendBucketArgs): void {
  const { lines, label, paths, truncated } = args;
  if (paths.length === 0) return;
  lines.push(renderMarkdownBulletList(buildChangedSinceBucketSpec({ label, paths, truncated })));
}

export const CHANGED_SINCE_TOOL = defineTool({
  name: 'cartograph_changed_since',
  description:
    'File-level drift since the index was built (or a caller-supplied timestamp) — added/content-changed/deleted buckets. ' +
    'The content-changed bucket means the on-disk SHA differs from the indexed `files.content_hash`. ' +
    'Also renders an **Indexed HEAD:** line showing how many commits the current HEAD is ahead.',
  schema: changedSinceSchema,
  handle: handleChangedSince,
  bypassFreshnessGate: true,
});
