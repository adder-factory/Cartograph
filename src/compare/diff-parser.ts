/**
 * parseUnifiedDiff — extract per-file line ranges from a unified diff.
 *
 * Designed for `git diff` output; handles both the `diff --git a/… b/…`
 * header form and the simpler `+++ b/…` form. Extracts the NEW-side
 * ranges only (post-image) since that's what the indexed tree has.
 *
 * Intentionally minimal: no perfect-diff support, just the common
 * patterns produced by `git diff`. Malformed hunk headers are skipped
 * silently — callers check whether any ranges were produced.
 */

import { parseStrictUnsignedDecimalInteger } from '../strict-numeric.js';

/** A single contiguous line range extracted from a unified diff hunk. */
export interface DiffRange {
  /** Repo-relative path (leading `b/` stripped). */
  file: string;
  /** First line of the hunk in the post-image (1-indexed, inclusive). */
  startLine: number;
  /** Last line of the hunk in the post-image (1-indexed, inclusive). */
  endLine: number;
}

/** Matches `diff --git a/<oldPath> b/<newPath>` */
const DIFF_GIT_HEADER = /^diff --git a\/.+ b\/(.+)$/;
/** Matches `+++ b/<newPath>` or `+++ <newPath>` (bare diff --no-prefix) */
const PLUS_PLUS_HEADER = /^\+\+\+ (?:b\/)?(.+)$/;
/** Matches `@@ -<old>,<len> +<new>[,<len>] @@` — `<len>` is optional (defaults to 1) */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Count well-formed `@@ … @@` hunk headers in a raw diff string,
 * regardless of whether a file header precedes them.
 *
 * Diagnostic-only helper: lets a caller distinguish "the input had
 * hunk lines but no file header" (so {@link parseUnifiedDiff} dropped
 * them) from "the input had no hunk lines at all". It does NOT affect
 * parsing — a headerless diff still correctly yields zero ranges.
 */
export function countHunkHeaders(diff: string): number {
  let count = 0;
  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('@@') && HUNK_HEADER.test(rawLine)) count++;
  }
  return count;
}

/**
 * Parse a unified diff string into per-file line ranges suitable for
 * bulk `cartograph_at_range` queries. Uses post-image (new side) ranges
 * only. Pure-deletion hunks (`+<newLen>` = 0) and deleted files
 * (`+++ /dev/null`) are skipped.
 */
export function parseUnifiedDiff(diff: string): DiffRange[] {
  const ranges: DiffRange[] = [];
  let currentFile: string | null = null;

  for (const rawLine of diff.split('\n')) {
    const line = rawLine;

    // --- file header: `diff --git a/… b/…` ---
    const gitPath = parseGitDiffPath(line);
    if (gitPath) {
      currentFile = gitPath;
      continue;
    }

    // --- file header: `+++ b/…` (also resets currentFile for patches without diff --git) ---
    if (line.startsWith('+++ ')) {
      currentFile = parsePlusPlusPath(line, currentFile);
      continue;
    }

    // --- hunk header: `@@ -x,y +x,y @@ …` ---
    if (line.startsWith('@@') && currentFile !== null) {
      const range = parseHunkRange(line, currentFile);
      if (range) ranges.push(range);
    }
  }

  return ranges;
}

function parseGitDiffPath(line: string): string | null {
  const gitMatch = DIFF_GIT_HEADER.exec(line);
  return gitMatch ? gitMatch[1]!.trim() : null;
}

function parsePlusPlusPath(line: string, currentFile: string | null): string | null {
  const plusMatch = PLUS_PLUS_HEADER.exec(line);
  if (!plusMatch) return currentFile;
  const newPath = plusMatch[1]!.trim();
  return newPath === '/dev/null' ? null : newPath;
}

function parseHunkRange(line: string, currentFile: string): DiffRange | null {
  const hunkMatch = HUNK_HEADER.exec(line);
  if (!hunkMatch) return null;
  const newStartRaw = hunkMatch[1];
  if (newStartRaw === undefined) return null;
  const newStart = parseStrictUnsignedDecimalInteger(newStartRaw);
  if (newStart === null) return null;
  // newLen is absent when exactly one line; defaults to 1 per the unified diff spec
  const newLen = hunkMatch[2] === undefined ? 1 : (parseStrictUnsignedDecimalInteger(hunkMatch[2]) ?? 0);
  if (newLen === 0) return null;
  return { file: currentFile, startLine: newStart, endLine: newStart + newLen - 1 };
}
