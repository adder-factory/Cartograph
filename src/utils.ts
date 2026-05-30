/**
 * Cartograph Utilities
 *
 * Common utility functions for memory management, concurrency, batching,
 * and security validation.
 *
 * @module utils
 *
 * @example
 * ```typescript
 * import { Mutex, processInBatches, MemoryMonitor, validatePathWithinRoot } from 'cartograph';
 *
 * // Use mutex for concurrent safety
 * const mutex = new Mutex();
 * await mutex.withLock(async () => {
 *   await performCriticalOperation();
 * });
 *
 * // Process items in batches to manage memory
 * const results = await processInBatches(items, 100, async (item) => {
 *   return await processItem(item);
 * });
 *
 * // Monitor memory usage
 * const monitor = new MemoryMonitor(512, (usage) => {
 *   console.warn(`Memory usage exceeded 512MB: ${usage / 1024 / 1024}MB`);
 * });
 * monitor.start();
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Language } from './types.js';

/**
 * Single source of truth for the JavaScript family — TypeScript,
 * JavaScript, and their JSX/TSX variants. Used in resolution +
 * extraction code paths that share resolver semantics across these
 * four languages (e.g. node_modules-aware import resolution, JSX
 * element extraction, named-import reference edges).
 *
 * Replaces five hardcoded `lang === 'typescript' || ... || 'jsx'`
 * disjunctions previously scattered across `resolution/`,
 * `extraction/tree-sitter-decls.ts`. Adding a new JS-family
 * dialect (Bun's `.bts`, etc.) only needs to flip this set.
 */
const JS_FAMILY_LANGUAGES: ReadonlySet<Language> = new Set<Language>(['typescript', 'javascript', 'tsx', 'jsx']);

export function isJsFamily(language: Language | string | undefined): boolean {
  if (!language) return false;
  return JS_FAMILY_LANGUAGES.has(language as Language);
}

/**
 * Strip every `undefined`-valued property from an object literal.
 *
 * Lets callers pass `{ field: maybeUndefined, ... }` to APIs whose
 * fields are declared `?: T` (omit-only) under
 * `exactOptionalPropertyTypes`. Without this, every site that
 * conditionally populates a Node / Edge / option bag would have to
 * use per-field conditional spread — readable for 1-2 fields, noisy
 * for the 6+ optional fields on Node-shaped types.
 *
 * Type result: required fields stay required (no `| undefined` on
 * input means the strip is a no-op for those keys); fields whose
 * value type included `undefined` become `?:` omit-only optional in
 * the returned shape. This matches the target `?: T` contract under
 * `exactOptionalPropertyTypes`.
 */
type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function compact<const T extends object>(o: T): Compact<T> {
  const out: Record<string, unknown> = {};
  // `Object.keys` iterates own enumerable string keys only — guards
  // against inherited getters/methods leaking through if a caller
  // ever passes a class instance instead of an object literal.
  for (const k of Object.keys(o) as Array<keyof T & string>) {
    const v = o[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Compact<T>;
}

// ============================================================
// SECURITY UTILITIES
// ============================================================

/**
 * True iff `child` is `parent` or a descendant of `parent`. Centralises
 * the "starts-with parent + sep, or equals parent" prefix check so the
 * symlink-aware path-validation helper has one canonical containment
 * test. Both arguments must already be absolute (use `path.resolve`
 * first); this helper does no resolution itself.
 */
function pathContainsPath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Like validatePathWithinRoot but also resolves symlinks via fs.realpathSync,
 * so a regular-looking path that is actually a symlink to outside the root
 * is rejected. Returns the resolved real path, or null if the file escapes
 * the root or can't be reached.
 *
 * Costs an extra realpath syscall vs. the lexical-only check, so prefer
 * validatePathWithinRoot for hot paths where symlink TOCTOU isn't relevant.
 */
export function validatePathWithinRootReal(projectRoot: string, filePath: string): string | null {
  const resolved = path.resolve(projectRoot, filePath);
  const normalizedRoot = path.resolve(projectRoot);
  if (!pathContainsPath(normalizedRoot, resolved)) return null;
  try {
    const realPath = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(normalizedRoot);
    return pathContainsPath(realRoot, realPath) ? realPath : null;
  } catch {
    // realpath failures (broken symlink, permissions) — return the lexically-
    // resolved path. The downstream readFileSync will fail naturally and the
    // caller already handles read errors.
    return resolved;
  }
}

/**
 * Best-effort "is `p` an existing regular file?" — swallows every
 * stat error (ENOENT, EACCES, EPERM, broken symlink, etc.) and
 * returns false. Use for the speculative-resolution pattern where
 * the caller probes a path and falls through on miss; for paths
 * that MUST be readable, prefer `fs.readFileSync` directly so its
 * error surfaces.
 *
 * Folded out of duplicated copies in `import-classifier.ts` and
 * `mcp/tools/_coverage-tips.ts` (G10 followup — the
 * `findDuplicateCode` detector fix surfaced both as exact clones).
 */
export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Best-effort UTF-8 file read — returns the contents on success,
 * `null` on any read error (missing / permissions / not a regular
 * file). The caller decides how to treat absent vs unreadable; this
 * helper only flattens "what bytes are in this file" into a single
 * nullable string.
 *
 * Folded out of duplicated copies in `re-export-edges.ts`,
 * `dynamic-import-edges.ts`, and `value-ref-edges.ts` (G10
 * followup — same `findDuplicateCode` fix as `fileExists` above).
 */
export function readFileSafe(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Safely parse JSON with a fallback value.
 * Prevents crashes from corrupted database metadata.
 */
export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Split `items` round-robin across `n` slices. Worker-pool fan-out
 * pattern — both the biomarker per-file pool and the value-ref-edges
 * pool need identical "deal items to N workers card-game style"
 * partitioning so per-slice cost stays balanced when item cost
 * varies across the input.
 */
export function partitionRoundRobin<T>(items: ReadonlyArray<T>, n: number): T[][] {
  const slices: T[][] = Array.from({ length: n }, () => [] as T[]);
  for (let j = 0; j < items.length; j++) {
    slices[j % n]!.push(items[j]!);
  }
  return slices;
}

/**
 * Clamp a numeric value to a range.
 * Used to enforce sane limits on MCP tool inputs.
 *
 * NaN-safe: a non-finite value returns `min` instead of propagating
 * NaN downstream — keeps callers that use `clamp(args.x as number, …)`
 * from leaking NaN when the arg is absent or non-numeric.
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Bytes per binary unit step — 1 KiB / MiB / GiB / TiB each multiply
 *  the previous by this. Named so the byte-formatter's intent is
 *  self-evident rather than a bare `1024` literal. */
const BYTES_PER_UNIT = 1024;

/**
 * Format a byte count as a human-readable size (e.g. `412.8 MB`).
 *
 * Shared by the CLI and MCP `prune-store` handlers so before/after DB
 * sizes render identically on both surfaces. Uses binary (1024-step)
 * units — the convention SQLite page math and `du` both follow — and
 * one decimal place above the `B` tier.
 */
export function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_UNIT) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / BYTES_PER_UNIT;
  let unitIdx = 0;
  while (value >= BYTES_PER_UNIT && unitIdx < units.length - 1) {
    value /= BYTES_PER_UNIT;
    unitIdx += 1;
  }
  return `${value.toFixed(1)} ${units[unitIdx]}`;
}

/**
 * Coerce an unknown MCP tool arg to a finite number, falling back to
 * `fallback` when it is missing, non-numeric, or NaN. Critically,
 * preserves an explicit `0` — unlike `Number(v) || fallback`, which
 * silently substitutes the default and made `dead_code` burn 50 LLM
 * calls when the caller passed `maxCandidates: 0` to mean "skip".
 */
export function numArg(v: unknown, fallback: number): number {
  if (v == null) return fallback; // covers null and undefined
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Clamp a numeric value to an integer range, truncating any
 * fractional part toward zero.
 *
 * Use this — not `clamp` — for any value that becomes a SQLite
 * integer-bound parameter (`LIMIT ?`, `OFFSET ?`, row counts).
 * `clamp` keeps the value's fractional part, so a caller-supplied
 * `limit: 3.7` would reach bun:sqlite as a float and throw
 * `datatype mismatch` — SQLite integer bind slots reject
 * non-integers (verified against bun:sqlite; same behaviour as the
 * pre-migration better-sqlite3 era). `clampInt` floors the magnitude first so a
 * fractional arg degrades to the nearest in-range integer instead
 * of crashing the handler.
 *
 * NaN-safe (inherits `clamp`'s non-finite → `min` behaviour).
 */
export function clampInt(value: number, min: number, max: number): number {
  return clamp(Math.trunc(value), min, max);
}

/**
 * Normalize a file path to use forward slashes.
 * Fixes Windows backslash paths so glob matching works consistently.
 */
export function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/**
 * Strip a leading UTF-8 BOM (U+FEFF) if present.
 */
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Path classification (test / fixture / diagnostic) lives in
 * `path-class.ts` — the single source of truth that replaced the five
 * divergent path-notion regex sets. Re-exported here so the many
 * existing `import { isTestPath } from '../utils.js'` sites keep
 * working; new code should import from `path-class.js` directly.
 */
export { isTestPath, isDiagnosticPath } from './path-class.js';

/**
 * Strip extended-thinking / reasoning blocks emitted by LLMs that surface
 * `<think>...</think>` (or `<thinking>...</thinking>`) inline in their
 * output. Some local servers and chat templates leak these tokens through
 * the assistant message verbatim; without scrubbing them, they end up in
 * persisted symbol summaries and rendered ask answers.
 *
 * Also drops a single trailing unmatched `<think>` (sometimes the closer
 * is truncated when the response is cut off mid-stream) and any leading
 * empty lines left behind.
 */
export function stripReasoningTokens(text: string): string {
  if (!text) return text;
  // Open-tag pattern tolerates attributes:
  //   <think>             — bare
  //   < think >           — whitespace
  //   <think type="cot">  — attribute-bearing (some local-server templates)
  //   <thinking>          — full word variant
  // The `(?:\s[^>]*)?` clause matches a single whitespace followed by any
  // non-`>` content, covering both attribute lists and stray content
  // before the closing `>`.
  const open = '<\\s*think(?:ing)?(?:\\s[^>]*)?>';
  const close = '<\\s*\\/\\s*think(?:ing)?\\s*>';
  // Closed reasoning blocks (handles arbitrary content + nested newlines).
  let out = text.replaceAll(new RegExp(`${open}[\\s\\S]*?${close}`, 'gi'), '');
  // Unclosed trailing opener — drop everything from it onward. Negative
  // lookbehind on a backtick so a literal mention like `<think>` inside
  // backticks (e.g. when summarising the strip-reasoning function itself)
  // doesn't get eaten as CoT.
  out = out.replace(new RegExp(`(?<!\`)${open}[\\s\\S]*$`, 'i'), '');
  // Stray closer with no opener.
  out = out.replaceAll(new RegExp(close, 'gi'), '');
  // Collapse leading blank lines created by the strip.
  out = out.replace(/^[\s\n]+/, '');
  return out;
}

function blankPreservingNewlines(text: string): string {
  return text.replaceAll(/[^\n]/g, ' ');
}

const BLOCK_COMMENT_LANGUAGES = new Set([
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'java',
  'csharp',
  'cpp',
  'c',
  'go',
  'rust',
  'swift',
  'kotlin',
  'dart',
  'scala',
  'php',
]);

const LINE_COMMENT_MARKER: Record<string, RegExp> = {
  javascript: /^[ \t]*\/\//,
  typescript: /^[ \t]*\/\//,
  tsx: /^[ \t]*\/\//,
  jsx: /^[ \t]*\/\//,
  java: /^[ \t]*\/\//,
  csharp: /^[ \t]*\/\//,
  cpp: /^[ \t]*\/\//,
  c: /^[ \t]*\/\//,
  go: /^[ \t]*\/\//,
  rust: /^[ \t]*\/\//,
  swift: /^[ \t]*\/\//,
  kotlin: /^[ \t]*\/\//,
  dart: /^[ \t]*\/\//,
  scala: /^[ \t]*\/\//,
  pascal: /^[ \t]*\/\//,
  python: /^[ \t]*#/,
  ruby: /^[ \t]*#/,
  php: /^[ \t]*(?:\/\/|#)/,
};

/**
 * Comment-start tokens per language for the inline (trailing OR
 * leading) line-comment scan. Mirrors the language set of
 * {@link LINE_COMMENT_MARKER}; kept as plain strings (not anchored
 * regexes) because the inline scan walks the line char-by-char.
 */
const LINE_COMMENT_TOKENS: Record<string, readonly string[]> = {
  javascript: ['//'],
  typescript: ['//'],
  tsx: ['//'],
  jsx: ['//'],
  java: ['//'],
  csharp: ['//'],
  cpp: ['//'],
  c: ['//'],
  go: ['//'],
  rust: ['//'],
  swift: ['//'],
  kotlin: ['//'],
  dart: ['//'],
  scala: ['//'],
  pascal: ['//'],
  python: ['#'],
  ruby: ['#'],
  php: ['//', '#'],
};

/**
 * Blank a single line's line-comment (leading OR trailing), keeping
 * the line's length so 1-indexed line/column offsets are unchanged.
 *
 * String-aware: a comment token inside a `'…'` / `"…"` / `` `…` ``
 * literal is not a comment start. Two guards bias toward
 * UNDER-stripping where a token is ambiguous — an under-strip merely
 * leaves comment noise behind, an over-strip could eat real code:
 *  - `//` immediately preceded by `\` is escaped regex-literal
 *    content (`/foo\/\//`), not a comment.
 *  - `#` immediately followed by `{` or `[` is Ruby/JS interpolation
 *    (`#{…}`) or a PHP 8 attribute (`#[…]`), not a comment.
 */
function stripInlineLineComments(line: string, tokens: readonly string[]): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inStr !== null) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    for (const tok of tokens) {
      if (!line.startsWith(tok, i)) continue;
      if (tok === '//' && line[i - 1] === '\\') continue;
      if (tok === '#' && (line[i + 1] === '{' || line[i + 1] === '[')) continue;
      return line.slice(0, i) + ' '.repeat(line.length - i);
    }
  }
  return line;
}

/**
 * Blank out comments from source so a downstream regex scan doesn't
 * match doc-comment examples or commented-out code. Newline-preserving
 * and length-preserving — 1-indexed line/column offsets stay exact.
 *
 * Block comments (`/* … *\/`, python triple-quote, ruby `=begin`) are
 * always stripped. Line comments: by default BOTH leading and
 * trailing-inline (`code; // note`) are stripped. Pass
 * `stripInlineComments: false` for the legacy leading-only behavior —
 * `algo-hash.ts` needs this so a trailing inline edit on a spec-file
 * code line still counts toward the cache-version hash.
 */
export function stripCommentsForRegex(
  content: string,
  language: string,
  opts: { stripInlineComments?: boolean } = {},
): string {
  const stripInline = opts.stripInlineComments ?? true;
  let out = content;

  if (BLOCK_COMMENT_LANGUAGES.has(language)) {
    out = out.replaceAll(/\/\*[\s\S]*?\*\//g, blankPreservingNewlines);
  }
  if (language === 'python') {
    out = out.replaceAll(/"""[\s\S]*?"""/g, blankPreservingNewlines);
    out = out.replaceAll(/'''[\s\S]*?'''/g, blankPreservingNewlines);
  }
  if (language === 'ruby') {
    out = out.replaceAll(/^=begin\b[\s\S]*?^=end\b[^\n]*/gm, blankPreservingNewlines);
  }

  if (stripInline) {
    const lineTokens = LINE_COMMENT_TOKENS[language];
    if (lineTokens) {
      out = out
        .split('\n')
        .map((line) => stripInlineLineComments(line, lineTokens))
        .join('\n');
    }
  } else {
    const lineMarker = LINE_COMMENT_MARKER[language];
    if (lineMarker) {
      out = out
        .split('\n')
        .map((line) => (lineMarker.test(line) ? blankPreservingNewlines(line) : line))
        .join('\n');
    }
  }

  return out;
}

/**
 * One-pass newline-offset index for converting source offsets to
 * 1-indexed line numbers in O(log n).
 *
 * F#72 (2026-05-28). The natural-looking
 * `content.slice(0, offset).split('\n').length` pattern is
 * Schlemiel-the-painter quadratic when invoked N times per file
 * inside a `pattern.exec(safe)` loop — each call walks the entire
 * prefix string and allocates a fresh split array. The 29 framework-
 * resolver call sites this replaces typically scan 10-100 matches per
 * file; on a 100 KB Go file with 50 route matches the prior pattern
 * did ~250 MB of redundant prefix copying per scan, which got worse
 * as files grew. The precomputed index is one O(n) scan + O(log n)
 * lookups via the binary search below.
 *
 * Semantics match the prior pattern exactly: the line number is
 * `1 + (count of `\n` characters strictly before `offset`)`. An
 * offset of 0 returns 1; an offset that lands on a `\n` byte returns
 * the line that newline TERMINATES (the same answer the prior
 * `slice(0, offset).split('\n').length` returned).
 *
 * The returned closure captures the offset array by reference, so
 * repeat lookups against the same file share one allocation. Build
 * once per file at the top of a resolver's `extractNodes`; do not
 * rebuild per loop iteration.
 */
export function makeLineIndex(content: string): (offset: number) => number {
  const newlines: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0a) newlines.push(i);
  }
  return (offset: number): number => {
    // Binary search for the smallest i such that newlines[i] >= offset.
    // That i is the count of newlines strictly before offset, so the
    // 1-indexed line of offset is i + 1.
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (newlines[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

export function stripCommentLinesForRetry(content: string, language: string): string {
  const marker = LINE_COMMENT_MARKER[language];
  if (!marker) return content;
  return content
    .split('\n')
    .map((line) => (marker.test(line) ? '' : line))
    .join('\n');
}

/**
 * Convert a simple `*` / `?` / `**` glob to a safe regex source string.
 * Hardens against catastrophic backtracking by coalescing runs of `*`.
 */
/**
 * Coalesce a run of `*` characters at position `i` into a single
 * regex fragment: `.*` for `**` (any depth), `[^/]*` for one `*`
 * (segment-bounded). Returns the fragment and the run length so the
 * outer loop can advance past the run.
 */
function compileGlobStarRun(glob: string, i: number): { fragment: string; runLen: number } {
  let runLen = 1;
  while (glob[i + runLen] === '*') runLen++;
  return { fragment: runLen >= 2 ? '.*' : '[^/]*', runLen };
}

const REGEX_METACHARACTERS = /[.+^${}()|[\]\\]/;

/**
 * Convert a simple `*` / `?` / `**` glob to a safe regex source string.
 * Hardens against catastrophic backtracking by coalescing runs of `*`.
 */
export function globToSafeRegex(glob: string): string | null {
  if (glob.length > 1024) return null;
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (!ch) continue;
    if (ch === '*') {
      const run = compileGlobStarRun(glob, i);
      out += run.fragment;
      i += run.runLen - 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (REGEX_METACHARACTERS.test(ch)) {
      out += '\\' + ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Escape every regex metacharacter in `s` so it matches literally when
 * interpolated into a `RegExp`. Use at every site that builds a pattern
 * from a graph-derived name (symbol / field / tool identifier): those
 * legally contain `$` in JS/TS (`obs$`, `$mount`) and JVM synthetics
 * (`$delegate`), and an unescaped `$` is a regex end-anchor that
 * silently breaks the match. Canonical MDN metacharacter set — note it
 * includes `*`, which some older hand-rolled copies omitted.
 */
export function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex matching `name` as a standalone identifier token — the
 * `$`-safe replacement for `new RegExp(\`\\b${name}\\b\`)`. JS `\b` is a
 * word/non-word transition, but `$` is a non-word char, so a trailing
 * `\b` after an identifier ending in `$` (RxJS observables like
 * `data$`) asserts the wrong boundary and never matches
 * `data$.subscribe()`. Identifier-char lookarounds (`[\w$]`) bound the
 * token correctly at both ends, including a leading or trailing `$`.
 *
 * JS-`RegExp` only (uses lookbehind) — NOT RE2-compatible. That's fine:
 * this matches against the user's own indexed source, never the
 * adversarial user-supplied-regex surface (which stays on
 * `compileSafeRegex` in src/regex.ts).
 */
export function identifierBoundaryRegex(name: string, flags = ''): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, flags);
}

/**
 * Split an identifier on camelCase, snake_case, kebab-case, dots,
 * slashes, and backslashes (the last covers PHP-style namespace
 * separators, e.g. `App\Service\UserService`).
 */
export function splitIdentifierTokens(name: string): string[] {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.\/:\\]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Build the value stored in the `name_subwords` FTS column.
 */
export function buildNameSubwords(name: string): string {
  const tokens = splitIdentifierTokens(name);
  return [...new Set([name, ...tokens])].join(' ');
}

// Re-export concurrency / time / memory primitives that used to live
// here. Extracted into ./utils-concurrency.ts so this file holds only
// pure path / string / language predicates. Existing imports from
// '../utils.js' keep working unchanged.
export {
  FileLock,
  Mutex,
  MemoryMonitor,
  processInBatches,
  readFileInChunks,
  debounce,
  throttle,
} from './utils-concurrency.js';
