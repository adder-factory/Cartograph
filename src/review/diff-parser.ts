/**
 * Unified Diff Parser
 *
 * Minimal parser for the subset of unified-diff syntax git emits:
 * file headers (`diff --git a/x b/y`), index lines, mode lines, and
 * hunk headers (`@@ -OLD,COUNT +NEW,COUNT @@`). Body lines are not
 * retained verbatim — callers only need file + hunk metadata to map
 * changes back to symbols via line-range overlap — but the parser
 * does *count* the `+`/`-` body lines per hunk so callers can size a
 * diff by lines actually changed rather than by hunk span (which
 * includes unchanged context lines).
 *
 * Pure module: no DB or filesystem access. Safe to test in isolation.
 */

import { parseStrictUnsignedDecimalInteger } from '../strict-numeric.js';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface Hunk {
  /** Old file: starting line number (1-indexed). 0 if file was added. */
  oldStart: number;
  /** Number of lines from the old file in this hunk (the old-side span,
   *  context lines included). */
  oldCount: number;
  /** New file: starting line number (1-indexed). 0 if file was deleted. */
  newStart: number;
  /** Number of lines in the new file (the new-side span, context
   *  included). */
  newCount: number;
  /** Body lines prefixed `+` in this hunk — lines actually added.
   *  Excludes context (` `) lines and the `\ No newline` marker. */
  addedLines: number;
  /** Body lines prefixed `-` in this hunk — lines actually removed. */
  removedLines: number;
}

export interface DiffFile {
  /**
   * File path as it appears in the new tree (or the old tree for deletions).
   * Always normalized to forward slashes; the leading `a/` or `b/` prefix
   * git emits is stripped.
   */
  path: string;
  /** Pre-rename path (only set when status === 'renamed'). */
  oldPath?: string;
  status: FileStatus;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Matches both unquoted (`diff --git a/x b/y`) and C-style-quoted
// (`diff --git "a/x with space" "b/y"`) git diff headers. The capture
// groups always include the `a/` / `b/` prefix or the surrounding
// quotes; both are stripped via `unquote` before use.
const DIFF_HEADER_RE = /^diff --git (?:"a\/(.+)"|a\/(\S+)) (?:"b\/(.+)"|b\/(\S+))$/;

/** Default `count` field when a hunk header omits it (single-line change). */
const DEFAULT_HUNK_COUNT = 1;

/**
 * Strip git's C-style quoting on paths with special characters
 * (e.g. `"path with spaces.ts"` → `path with spaces.ts`).
 */
function unquote(p: string | null): string | null {
  if (!p) return p;
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

/**
 * Resolve the canonical path for a diff entry. Deletions use the old
 * path, everything else uses the new path; falls back to the rename
 * partner, then to `'?'` if every source is null.
 */
interface PickPathArgs {
  isDeletion: boolean;
  oldPath: string | null;
  newPath: string | null;
  renamedFrom: string | null;
  renamedTo: string | null;
}

function pickPath(args: PickPathArgs): string {
  const { isDeletion, oldPath, newPath, renamedFrom, renamedTo } = args;
  if (isDeletion) return unquote(oldPath) ?? renamedFrom ?? '?';
  return unquote(newPath) ?? renamedTo ?? '?';
}

/**
 * Parse a unified diff into a flat list of files with hunk metadata.
 *
 * Tolerates extra noise lines (binary file markers, similarity index
 * lines, etc.) by skipping anything that doesn't match a known prefix.
 */
export function parseDiff(text: string): DiffFile[] {
  return new DiffParser().parse(text);
}

/** Mutable state for the diff-parser state machine. */
interface DiffParserState {
  files: DiffFile[];
  current: DiffFile | null;
  /** The hunk most recently opened — body `+`/`-` lines are tallied
   *  onto it until the next hunk header or file header arrives. */
  currentHunk: Hunk | null;
  oldPath: string | null;
  newPath: string | null;
  isAddition: boolean;
  isDeletion: boolean;
  isRename: boolean;
  renamedFrom: string | null;
  renamedTo: string | null;
}

function dpMakeState(): DiffParserState {
  return {
    files: [],
    current: null,
    currentHunk: null,
    oldPath: null,
    newPath: null,
    isAddition: false,
    isDeletion: false,
    isRename: false,
    renamedFrom: null,
    renamedTo: null,
  };
}

function dpStartNewFileBlock(st: DiffParserState, headerMatch: RegExpExecArray): void {
  st.oldPath = headerMatch[1] ?? headerMatch[2] ?? null;
  st.newPath = headerMatch[3] ?? headerMatch[4] ?? null;
  st.isAddition = false;
  st.isDeletion = false;
  st.isRename = false;
  st.renamedFrom = null;
  st.renamedTo = null;
}

/** new-file / deleted-file / rename-from / rename-to lines. Returns true when consumed. */
function dpTryHandleModeOrRenameLine(st: DiffParserState, line: string): boolean {
  if (line.startsWith('new file mode')) {
    st.isAddition = true;
    return true;
  }
  if (line.startsWith('deleted file mode')) {
    st.isDeletion = true;
    return true;
  }
  if (line.startsWith('rename from ')) {
    st.isRename = true;
    st.renamedFrom = line.substring('rename from '.length).trim();
    return true;
  }
  if (line.startsWith('rename to ')) {
    st.renamedTo = line.substring('rename to '.length).trim();
    return true;
  }
  return false;
}

/** `--- /dev/null` and `+++ /dev/null` sentinels mean add / delete. Returns true when consumed. */
function dpTryHandleDevNullLine(st: DiffParserState, line: string): boolean {
  if (line.startsWith('--- ')) {
    if (line.substring(4).trim() === '/dev/null') st.isAddition = true;
    return true;
  }
  if (line.startsWith('+++ ')) {
    if (line.substring(4).trim() === '/dev/null') st.isDeletion = true;
    return true;
  }
  return false;
}

/** Translate rename/add/delete flags into a FileStatus (or the fallback). */
function dpDeriveStatus<F extends FileStatus | null>(st: DiffParserState, fallback: F): FileStatus | F {
  if (st.isRename) return 'renamed';
  if (st.isAddition) return 'added';
  if (st.isDeletion) return 'deleted';
  return fallback;
}

/** First hunk after a header finalises the header into `current` and pushes the hunk metadata. */
function dpAppendHunk(st: DiffParserState, hunkMatch: RegExpExecArray): void {
  if (!st.current) {
    const status = dpDeriveStatus(st, 'modified');
    const p = pickPath({
      isDeletion: st.isDeletion,
      oldPath: st.oldPath,
      newPath: st.newPath,
      renamedFrom: st.renamedFrom,
      renamedTo: st.renamedTo,
    });
    st.current = { path: p, status, hunks: [] };
    if (status === 'renamed' && st.renamedFrom) st.current.oldPath = st.renamedFrom;
    st.isAddition = false;
    st.isDeletion = false;
    st.isRename = false;
  }
  const [, oldStartRaw, oldCountRaw, newStartRaw, newCountRaw] = hunkMatch;
  const hunk: Hunk = {
    oldStart: parseStrictUnsignedDecimalInteger(oldStartRaw ?? '0') ?? 0,
    oldCount: oldCountRaw === undefined ? DEFAULT_HUNK_COUNT : (parseStrictUnsignedDecimalInteger(oldCountRaw) ?? 0),
    newStart: parseStrictUnsignedDecimalInteger(newStartRaw ?? '0') ?? 0,
    newCount: newCountRaw === undefined ? DEFAULT_HUNK_COUNT : (parseStrictUnsignedDecimalInteger(newCountRaw) ?? 0),
    addedLines: 0,
    removedLines: 0,
  };
  st.current.hunks.push(hunk);
  st.currentHunk = hunk;
}

/**
 * Tally a hunk body line onto the open hunk. `+`/`-` prefixed lines
 * count toward added/removed; context (` `) and the `\ No newline`
 * marker do not. Returns true when the line was a body line that
 * belongs to the current hunk (consumed); false otherwise.
 */
function dpTryCountHunkBodyLine(st: DiffParserState, line: string): boolean {
  if (!st.currentHunk) return false;
  // The `\ No newline at end of file` marker is metadata, not a change.
  if (line.startsWith('\\')) return true;
  if (line.startsWith('+')) {
    st.currentHunk.addedLines++;
    return true;
  }
  if (line.startsWith('-')) {
    st.currentHunk.removedLines++;
    return true;
  }
  // A leading space is a context line; an empty string is a
  // context line whose single space git trimmed at EOL.
  if (line.startsWith(' ') || line === '') return true;
  return false;
}

function dpFlushCurrent(st: DiffParserState): void {
  if (!st.current) return;
  st.files.push(st.current);
  st.current = null;
}

/** Emit a file entry for a header that produced no hunks (pure rename, mode change, or empty add/delete). */
function dpFlushHunkless(st: DiffParserState): void {
  if (st.current !== null) return;
  const status = dpDeriveStatus(st, null);
  if (status === null) return;
  const p = pickPath({
    isDeletion: st.isDeletion,
    oldPath: st.oldPath,
    newPath: st.newPath,
    renamedFrom: st.renamedFrom,
    renamedTo: st.renamedTo,
  });
  const f: DiffFile = { path: p, status, hunks: [] };
  if (status === 'renamed' && st.renamedFrom) f.oldPath = st.renamedFrom;
  st.files.push(f);
}

function dpProcessLine(st: DiffParserState, line: string): void {
  const headerMatch = DIFF_HEADER_RE.exec(line);
  if (headerMatch) {
    dpFlushCurrent(st);
    dpFlushHunkless(st);
    dpStartNewFileBlock(st, headerMatch);
    st.currentHunk = null;
    return;
  }
  // Mode / rename / dev-null header lines are only emitted BEFORE the
  // first hunk, so `currentHunk` is null here and these checks can't
  // swallow a hunk body `+`/`-` line.
  if (dpTryHandleModeOrRenameLine(st, line)) return;
  if (dpTryHandleDevNullLine(st, line)) return;
  const hunkMatch = HUNK_RE.exec(line);
  if (hunkMatch) {
    dpAppendHunk(st, hunkMatch);
    return;
  }
  // Anything else inside an open hunk is a body line — tally `+`/`-`.
  dpTryCountHunkBodyLine(st, line);
}

/**
 * State machine driver for {@link parseDiff}. All mutable state lives in
 * a plain `DiffParserState` bundle threaded through module-scope free
 * functions — the class is a thin coordinator kept only to match the
 * existing `new DiffParser().parse(text)` call site.
 */
class DiffParser {
  parse(text: string): DiffFile[] {
    const st = dpMakeState();
    for (const line of text.split('\n')) dpProcessLine(st, line);
    dpFlushCurrent(st);
    dpFlushHunkless(st);
    return st.files;
  }
}

/**
 * Convert a DiffFile + the file's symbol nodes (with start/end line
 * ranges) into the subset of symbols whose lines overlap any hunk.
 *
 * For added/deleted files there are no meaningful pre-existing symbols
 * to intersect — caller should treat the entire file as affected.
 */
export function symbolsTouchedByHunks<T extends { startLine: number; endLine: number }>(
  hunks: Hunk[],
  symbols: T[],
): T[] {
  if (hunks.length === 0 || symbols.length === 0) return [];
  const out: T[] = [];
  for (const s of symbols) {
    for (const h of hunks) {
      // Overlap is checked against the new-file line range. A hunk that
      // adds 5 lines starting at newStart=10 occupies lines [10, 14].
      const hunkEnd = h.newStart + Math.max(h.newCount - 1, 0);
      if (s.startLine <= hunkEnd && s.endLine >= h.newStart) {
        out.push(s);
        break;
      }
    }
  }
  return out;
}
