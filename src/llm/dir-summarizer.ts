/**
 * Directory-level summaries.
 *
 * Aggregates symbol-level summaries (PR #111) within a directory into
 * one paragraph that answers "what does this module do?". Lets the AI
 * assistant get module-level context in a single MCP call instead of
 * crawling all the symbols.
 *
 * Granularity: directory containing source files. We skip the project
 * root and skip dirs whose only contents are subdirectories — the
 * unit of meaning is the leaf module.
 *
 * Prompt-injection note: the synthesis prompt embeds LLM-generated
 * symbol summaries verbatim. A malicious repo whose source bodies
 * coerced an "ignore previous instructions" line into a summary
 * could corrupt the directory paragraph. Accepted risk: all data
 * here originates from the user's own codebase. Don't forward
 * directory_summaries text to untrusted external systems without
 * sanitisation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { type LlmClient, LlmEndpointError } from './client.js';
import { hashSummaryGroupContent } from './summary-hash.js';
import type { QueryBuilder } from '../db/queries.js';
import {
  getSummarisedSymbolsByDir,
  getDirectorySummary,
  upsertDirectorySummary,
  getDirToolExportConstantCount,
} from '../db/queries-directory-summaries.js';
import { logDebug, logWarn } from '../errors.js';
import { compact } from '../utils.js';

/** Min number of summarised symbols before a dir is worth a paragraph. */
const MIN_SYMBOLS_PER_DIR = 3;

/** Cap how many symbol summaries we feed per dir prompt — beyond ~30
 *  the marginal signal flattens and the prompt grows linearly. */
const MAX_SYMBOLS_IN_PROMPT = 30;

/** Output cap for the synth call. Tight: this is meant to be skimmed. */
const MAX_SUMMARY_CHARS = 600;

/** Cap the project-identity anchor block fed into the dir-summary
 *  prompt. ~80 lines / ~4 KB of grounding text is enough to convey
 *  "what this project IS" without dominating the symbol-roll-up
 *  budget. Files larger than the cap are truncated at line boundaries. */
const MAX_ANCHOR_LINES = 80;
const MAX_ANCHOR_CHARS = 4000;

const DEFAULT_CONCURRENCY = 1; // Synthesis is large per call; serial is fine.

interface DirSummarizerOptions {
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

interface DirSummarizerResult {
  candidates: number;
  generated: number;
  cacheHits: number;
  errors: number;
  durationMs: number;
}

export interface DirGroupItem {
  name: string;
  kind: string;
  summary: string;
  /** Posix-normalised file path the symbol lives in. Used by
   *  structural-pattern detection to count per-file symbol density
   *  and to surface representative filenames in the deterministic
   *  paragraph (e.g. the top-3 handler modules in an MCP tool dir). */
  filePath: string;
}

interface DirGroup {
  dir: string;
  items: DirGroupItem[];
}

/**
 * Group symbol summaries by directory. Source of truth is the
 * symbol_summaries table; we don't summarise dirs whose symbols
 * haven't been summarised yet.
 */
function groupByDir(
  rows: ReadonlyArray<{ filePath: string; name: string; kind: string; summary: string }>,
): DirGroup[] {
  const groups = new Map<string, DirGroup>();
  for (const row of rows) {
    const posixPath = row.filePath.replace(/\\/g, '/');
    const dir = path.posix.dirname(posixPath);
    if (dir === '.' || dir === '') continue;
    let g = groups.get(dir);
    if (!g) {
      g = { dir, items: [] };
      groups.set(dir, g);
    }
    g.items.push({ name: row.name, kind: row.kind, summary: row.summary, filePath: posixPath });
  }
  // Drop dirs with too few symbols to be worth a paragraph.
  return [...groups.values()].filter((g) => g.items.length >= MIN_SYMBOLS_PER_DIR);
}

/** Stable hash so re-running is a cache hit when nothing changed.
 *
 *  `anchorText` is folded in so that a substantive edit to CLAUDE.md /
 *  README.md (the project-identity anchor) invalidates the cached
 *  paragraph and re-prompts the LLM with the new grounding. Without
 *  this, a fixed CLAUDE.md wouldn't take effect until the symbol
 *  summaries underneath the directory changed. */
function hashDirContent(group: DirGroup, anchorText: string): string {
  return hashSummaryGroupContent(group.items, anchorText);
}

/**
 * Truncate a paragraph to <= max chars, ending on a sentence boundary
 * when possible. Prefers the last `. `/`! `/`? ` within the final ~80
 * chars of the cap; falls back to the last whitespace; falls back to a
 * hard slice. Always appends `…` so the consumer can tell truncation
 * happened. Used by the directory-summary writer so cached summaries
 * don't end mid-word like "...within project boundar…".
 */
export function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  // Guard against the lastIndexOf-returns-(-1) case: -1 satisfies the
  // ">= max - 80" check for any small cap and would emit just " …".
  if (sentenceEnd >= 0 && sentenceEnd >= max - 80) {
    // +1 keeps the terminating punctuation, drops the trailing space.
    return window.slice(0, sentenceEnd + 1) + ' …';
  }
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0 && lastSpace >= max - 40) {
    return window.slice(0, lastSpace) + ' …';
  }
  return window.slice(0, max - 1) + '…';
}

/**
 * Tidy up an LLM-generated paragraph that may end mid-word because
 * `maxTokens` clipped it before the model finished a sentence.
 *
 * Symptom seen 2026-05-11 friction workout: the directory summary for
 * `src/mcp/tools` ended literally `... for storing and retrieving row-`
 * — a hyphen mid-word with no terminator. `truncateAtBoundary` only
 * fires when text exceeds the char cap; an LLM that ran out of tokens
 * BEFORE the cap produced a shorter-than-cap mid-word string that the
 * writer then stored verbatim.
 *
 * Fix: detect the no-terminator case (text doesn't end in `.`/`!`/`?`/`…`)
 * and trim back to the previous sentence boundary if one exists in the
 * trailing window, otherwise strip the trailing partial word and add `…`.
 */
export function tidyLlmEnding(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  const last = trimmed[trimmed.length - 1];
  if (last === '.' || last === '!' || last === '?' || last === '…') return trimmed;
  // Look for the most recent sentence terminator within a generous
  // trailing window (300 chars covers a paragraph's worth of context).
  const window = trimmed.slice(Math.max(0, trimmed.length - 300));
  const offset = trimmed.length - window.length;
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('.\n'),
    window.lastIndexOf('!\n'),
    window.lastIndexOf('?\n'),
  );
  if (sentenceEnd >= 0) {
    return trimmed.slice(0, offset + sentenceEnd + 1).trimEnd();
  }
  // No prior sentence boundary in the window — strip back to the last
  // whitespace and append the truncation marker so the consumer can
  // tell the LLM was cut off.
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace > 0) return trimmed.slice(0, lastSpace).trimEnd() + ' …';
  return trimmed + '…';
}

// ---------------------------------------------------------------------------
// Project-identity anchor
// ---------------------------------------------------------------------------
//
// The dir-summary prompt embeds raw symbol summaries and asks the LLM
// to write one paragraph per directory. Without any project-level
// context the model is free to invent — observed twice on 2026-05-14:
// granite-1b emitted "an AI-powered tool for generating agent
// instructions" for `src/installer`; qwen-3b emitted "a tool for
// generating code from text" for the same dir. Both wrong — Cartograph
// extracts FROM code, it doesn't generate code.
//
// Fix: prepend a "## Project Overview" anchor to the prompt, sourced
// from the project's own CLAUDE.md (preferred — it tends to carry a
// crisp purpose statement) or README.md (fallback). The anchor is
// cached per `projectRoot` so we don't re-read on every dir.

/** Project-identity anchor — the "what this project IS" grounding
 *  text prepended to summariser prompts so the LLM stops inventing
 *  purpose. Shared between the dir-summarizer and file-summarizer
 *  (handoff #9 sub-b) — they cache + read it identically. */
export interface ProjectAnchor {
  /** The grounding text fed into the prompt. Empty string when neither
   *  CLAUDE.md nor README.md is available — caller skips the anchor block. */
  text: string;
  /** Which file the anchor came from, for logging / cache-keying. */
  source: 'CLAUDE.md' | 'README.md' | 'none';
}

const anchorCache = new Map<string, ProjectAnchor>();

/** Trim a multi-line block to ≤ MAX_ANCHOR_LINES lines and ≤ MAX_ANCHOR_CHARS chars
 *  at a line boundary. Whitespace at the edges is collapsed; trailing blank
 *  lines are dropped. */
function clampAnchor(block: string): string {
  const lines = block.split(/\r?\n/);
  const sliced = lines.slice(0, MAX_ANCHOR_LINES);
  let out = sliced.join('\n').trim();
  if (out.length > MAX_ANCHOR_CHARS) {
    // Roll back to the last newline before the cap so we don't cut mid-line.
    const window = out.slice(0, MAX_ANCHOR_CHARS);
    const lastNl = window.lastIndexOf('\n');
    out = (lastNl > 0 ? window.slice(0, lastNl) : window).trimEnd();
  }
  return out;
}

/**
 * Pull a "what this project IS" block out of a CLAUDE.md file.
 *
 * Strategy: prefer the section under `## Project Overview` (Cartograph's
 * own CLAUDE.md uses this heading verbatim — see line 5 of `./CLAUDE.md`).
 * Falls back to the first `## ` heading section. The section ends at the
 * next `## ` heading or EOF.
 *
 * Returns null when the file is empty or has no headings.
 */
export function extractClaudeMdAnchor(content: string): string | null {
  if (content.trim().length === 0) return null;
  // Strip the first `# Title` line so the anchor starts with content, not
  // the document title (which is usually just "CLAUDE.md" or the project
  // name — uninformative grounding).
  const lines = content.split(/\r?\n/);
  // Find every `## ` heading and the line index it sits on.
  const headingIndexes: Array<{ line: number; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^##\s+(.+?)\s*$/);
    if (m) headingIndexes.push({ line: i, title: m[1]! });
  }
  if (headingIndexes.length === 0) return null;
  // Prefer "Project Overview" (case-insensitive); else use the first `## ` heading.
  const overviewIdx = headingIndexes.findIndex((h) => /project\s*overview/i.test(h.title));
  const startIdx = overviewIdx >= 0 ? overviewIdx : 0;
  const startLine = headingIndexes[startIdx]!.line;
  const endLine = startIdx + 1 < headingIndexes.length ? headingIndexes[startIdx + 1]!.line : lines.length;
  const block = lines.slice(startLine, endLine).join('\n');
  const clamped = clampAnchor(block);
  return clamped.length > 0 ? clamped : null;
}

/**
 * Pull the first ~3 paragraphs (or up to MAX_ANCHOR_LINES lines) out of a
 * README.md file. Paragraphs are blank-line-separated. Headings (`#`/`##`/…)
 * are kept inline since they often carry the project tagline.
 */
export function extractReadmeAnchor(content: string): string | null {
  if (content.trim().length === 0) return null;
  // Split on blank-line boundaries; keep heading-only paragraphs since
  // many READMEs lead with `# ProjectName\n\nOne-line tagline.\n\nBody...`
  const paragraphs = content
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return null;
  const head = paragraphs.slice(0, 3).join('\n\n');
  const clamped = clampAnchor(head);
  return clamped.length > 0 ? clamped : null;
}

/**
 * Resolve and cache the project-identity anchor for one project root.
 *
 * Tries `CLAUDE.md` then `README.md`. Cached per `projectRoot` so a
 * full dir-summary pass over hundreds of directories does at most two
 * file reads.
 *
 * Exported for tests; in production callers go through `getProjectAnchor`.
 */
export function loadProjectAnchor(projectRoot: string): ProjectAnchor {
  const claudePath = path.join(projectRoot, 'CLAUDE.md');
  try {
    if (fs.existsSync(claudePath)) {
      const text = fs.readFileSync(claudePath, 'utf8');
      const anchor = extractClaudeMdAnchor(text);
      if (anchor) return { text: anchor, source: 'CLAUDE.md' };
    }
  } catch (err) {
    logDebug('DirSummarizer: CLAUDE.md read failed', { projectRoot, error: String(err) });
  }
  const readmePath = path.join(projectRoot, 'README.md');
  try {
    if (fs.existsSync(readmePath)) {
      const text = fs.readFileSync(readmePath, 'utf8');
      const anchor = extractReadmeAnchor(text);
      if (anchor) return { text: anchor, source: 'README.md' };
    }
  } catch (err) {
    logDebug('DirSummarizer: README.md read failed', { projectRoot, error: String(err) });
  }
  return { text: '', source: 'none' };
}

/**
 * Per-projectRoot anchor lookup with module-level memoisation. Reads
 * CLAUDE.md / README.md once and reuses the result so a 60-directory
 * sync doesn't trigger 60 file reads.
 *
 * **Known limitation (long-lived MCP sessions):** the cache is never
 * invalidated except by process restart. If an operator edits CLAUDE.md
 * or README.md mid-session, subsequent `summarizeAllDirectories` calls
 * keep using the OLD anchor until the server is restarted. Per-directory
 * summary content does still invalidate correctly because `hashDirContent`
 * folds `anchorText` into the cache key — so once the anchor IS refreshed
 * (next restart), every dir summary regenerates with the new anchor.
 *
 * If this becomes painful, invalidate on the file-watcher path when
 * CLAUDE.md / README.md changes, OR drop the per-process cache entirely
 * (one fs.readFileSync per dir is cheap — ~100µs per call).
 */
export function getProjectAnchor(projectRoot: string): ProjectAnchor {
  const cached = anchorCache.get(projectRoot);
  if (cached) return cached;
  const anchor = loadProjectAnchor(projectRoot);
  anchorCache.set(projectRoot, anchor);
  return anchor;
}

/** Test-only: clear the per-projectRoot anchor cache so a fixture
 *  rewriting CLAUDE.md / README.md between calls sees the new content. */
export function _resetProjectAnchorCache(): void {
  anchorCache.clear();
}

// ---------------------------------------------------------------------------
// Structural-pattern bypass
// ---------------------------------------------------------------------------
//
// F-I (2026-05-11): when a directory has a strong structural signature
// (e.g. >=40% of its exports are `handle*` functions paired with `*_TOOL`
// definitions, as in `src/mcp/tools/`), the granite-1b summarizer tends
// to fixate on one outlier file and emit a paragraph that mis-describes
// the whole module. Bypass the LLM entirely for those dirs and emit a
// deterministic, accurate paragraph instead — mirrors the per-symbol
// `structural-summarizer.ts` pattern that ships synthetic summaries
// under `model='structural:v1'`.
//
// The bypass is opt-in via `detectDirectoryPattern`: returning null
// falls through to the existing LLM path unchanged. Today only the
// `mcp_tools` pattern is wired; the same hook can be extended to
// migrations / tree-sitter extractors / `queries-*.ts` families later
// (extension point lives at the bottom of `detectDirectoryPattern`).

/** Discriminator union — one value per supported directory pattern.
 *  String literal so the persisted `model` tag is self-describing
 *  (`structural-dir:mcp_tools` etc.) for forensic queries. */
export type StructuralPattern = 'mcp_tools';

/** Model tag written into `directory_summaries.model` for structural
 *  paragraphs. Versioned (`v1`) so a future change to paragraph wording
 *  invalidates cached rows naturally — `summariseOneDir` rejects the
 *  cache when the model column doesn't match. */
export const STRUCTURAL_DIR_MODEL = 'structural-dir:v1';

/** Minimum share of exported functions that must share the `handle*`
 *  prefix before the `mcp_tools` pattern fires. 0.40 chosen empirically
 *  on `src/mcp/tools/` (48/65 = 73.8%) — a noise-floor that ignores
 *  one-off `handleFoo` helpers in unrelated dirs. */
const MCP_HANDLE_PREFIX_RATIO = 0.4;

/** Minimum count of `*_TOOL` constant exports that, on its own,
 *  identifies an MCP-tool directory regardless of the `handle*` ratio.
 *  The ratio signal is fragile to directory growth — as each tool gets
 *  split into `_helper.ts` modules full of `formatX` / `parseX`
 *  functions, the `handle*` share drifts below the 0.40 floor even
 *  though the directory is unmistakably the MCP tools dir (FRICTION-M,
 *  2026-05-15: `src/mcp/tools/` fell to a sub-floor ratio with 67 files
 *  and ~910 symbols, so the structural bypass stopped firing and the
 *  LLM resumed hallucinating). No non-MCP directory exports 3+ distinct
 *  `*_TOOL` `ToolModule` constants, so the count alone is a zero-false-
 *  positive signature. */
const MCP_TOOL_EXPORT_FLOOR = 3;

/**
 * Detect a strong structural pattern in a directory's symbol set.
 *
 * Returns a discriminator when the directory matches a known pattern,
 * `null` otherwise — the caller then falls through to the LLM path.
 *
 * Currently recognised:
 *   - **`'mcp_tools'`** — fires on EITHER signal: (a) `>=40%` of the
 *     directory's function symbols start with `handle` AND at least one
 *     `*_TOOL` constant export exists (catches a small MCP-tools dir),
 *     OR (b) the directory has `>=3` `*_TOOL` constant exports (catches
 *     a large MCP-tools dir whose `handle*` ratio has been diluted by
 *     per-tool `_helper.ts` modules). The `*_TOOL` requirement in (a)
 *     and the count in (b) both guard against false positives in
 *     unrelated dirs that happen to have many handler helpers (e.g. a
 *     routing layer that defines `handleRequest` / `handleError` but
 *     exports no `*_TOOL` value).
 *
 * `opts.toolExportCount` lets the caller supply the directory's TRUE
 * `*_TOOL` constant count, sourced structurally (over all nodes) rather
 * than counted from `items`. `items` only carries symbols that have a
 * summary or docstring, and `*_TOOL` constants rarely carry either —
 * on `src/mcp/tools/` only 2 of 36 qualified, collapsing the items-
 * derived count below the floor (FRICTION-M). When omitted, the count
 * falls back to the items-derived one (back-compat for the pure unit
 * tests and any caller without DB access).
 *
 * Hooks for follow-up patterns (not implemented in this pass — F-I
 * scope discipline):
 *   - migrations (`^\d+-.*\.ts$` filenames)
 *   - tree-sitter extractors (`tree-sitter-*.ts` filenames)
 *   - db queries (`queries-*.ts` filenames)
 */
export function detectDirectoryPattern(
  items: ReadonlyArray<DirGroupItem>,
  opts?: { toolExportCount?: number },
): StructuralPattern | null {
  // Pattern 1 — MCP tool handler directory. Two independent triggers:
  // a handle*-ratio signal (small dirs) and a *_TOOL-count signal
  // (large dirs whose ratio is diluted by helper modules). The
  // structural count (opts.toolExportCount) wins when supplied — and is
  // checked BEFORE the empty-items guard so a caller that supplies the
  // count still gets a verdict when `items` is empty.
  const toolExportCount = opts?.toolExportCount ?? items.filter((it) => /_TOOL$/.test(it.name)).length;
  if (toolExportCount >= MCP_TOOL_EXPORT_FLOOR) {
    return 'mcp_tools';
  }
  if (items.length === 0) return null;
  const functions = items.filter((it) => it.kind === 'function' || it.kind === 'method');
  if (functions.length > 0) {
    const handleCount = functions.filter((it) => /^handle[A-Z]/.test(it.name)).length;
    const handleRatio = handleCount / functions.length;
    if (handleRatio >= MCP_HANDLE_PREFIX_RATIO && toolExportCount > 0) {
      return 'mcp_tools';
    }
  }

  // Extension point: detect migrations / tree-sitter extractors / db
  // queries families via filename predicates over `items[].filePath`.
  // Hooks documented but unimplemented per scope discipline; add the
  // new branch above when a family is ready to ship.
  return null;
}

/**
 * Build the deterministic paragraph for a structurally-recognised
 * directory. Pure function — same input always produces the same
 * output, which is what makes the `content_hash` cache key stable.
 *
 * The output is intentionally tight (2-3 sentences) — readers of
 * `cartograph_module` skim, and the LLM path's `MAX_SUMMARY_CHARS=600`
 * budget is an upper bound, not a target. Top-3 files by symbol count
 * give a representative sample without trying to enumerate the whole
 * directory.
 */
export function buildStructuralDirectorySummary(
  dirPath: string,
  pattern: StructuralPattern,
  items: ReadonlyArray<DirGroupItem>,
): string {
  // Tally per-file symbol counts to surface the densest modules first.
  const perFile = new Map<string, number>();
  for (const it of items) {
    const base = path.posix.basename(it.filePath);
    perFile.set(base, (perFile.get(base) ?? 0) + 1);
  }
  // Top-3 files by count; tie-break alphabetically for determinism.
  const topFiles = [...perFile.entries()]
    .filter(([name]) => !name.startsWith('_')) // private helpers are noise here
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name]) => name);

  if (pattern === 'mcp_tools') {
    // Count distinct files containing handle* exports (rough module count).
    const handlerFiles = new Set<string>();
    for (const it of items) {
      if (/^handle[A-Z]/.test(it.name) && (it.kind === 'function' || it.kind === 'method')) {
        handlerFiles.add(path.posix.basename(it.filePath));
      }
    }
    const moduleCount = handlerFiles.size;
    const filesList = topFiles.length > 0 ? ` Files: ${topFiles.join(', ')}.` : '';
    return (
      `The \`${dirPath}\` directory hosts ${moduleCount} MCP tool handler modules. ` +
      `Each module exports a \`*_TOOL\` \`ToolModule\` definition and one or more ` +
      `\`async function handle*(ctx, args): Promise<ToolResult>\` entry points invoked ` +
      `by the MCP server dispatcher (\`src/mcp/tools.ts\`).${filesList}`
    );
  }

  // Exhaustiveness guard — fall back to a generic stub.
  // (Unreachable today; keeps the function total over the union.)
  const _exhaustive: never = pattern;
  void _exhaustive;
  return `The \`${dirPath}\` directory is a structurally-recognised module.`;
}

/**
 * Build the synthesis prompt for one directory.
 *
 * `anchorText` (extracted from CLAUDE.md / README.md at the project
 * root) is prepended as grounding so the model knows what the project
 * IS before describing what a sub-directory does. Without this the
 * model is free to invent — observed 2026-05-14 with both granite-1b
 * and qwen-3b hallucinating Cartograph's purpose for `src/installer`.
 *
 * Exported for tests so a fixture project can assert the anchor block
 * is present in the assembled prompt.
 */
export function buildPrompt(group: DirGroup, anchorText: string): string {
  const lines: string[] = [];
  if (anchorText.length > 0) {
    lines.push('## Project Overview (for grounding only — do not paraphrase verbatim)');
    lines.push(anchorText);
    lines.push('');
  }
  lines.push(`You are documenting the module \`${group.dir}\` of the project described above.`);
  lines.push('');
  lines.push(`Below are one-line descriptions of every meaningful symbol in this directory.`);
  lines.push(`Write a SHORT paragraph (max ${MAX_SUMMARY_CHARS} chars) describing what this`);
  lines.push(`module does as a whole — its responsibility, the main types/functions it`);
  lines.push(`exposes, and how a caller would use it. Ground the description in the`);
  lines.push(`Project Overview above and in the symbol summaries below; do not invent`);
  lines.push(`functionality that is not present in the symbol summaries.`);
  // Handoff #9: dir-summary prose hallucinated acronym expansions for
  // directory names (e.g. "mcp" → "Microcontroller Platform" /
  // "Minecraft Code Platform"). Same guidance as file-summarizer.ts.
  lines.push(`When the directory path contains an acronym (e.g. "mcp", "hnsw"), use it`);
  lines.push(`VERBATIM unless the Project Overview above explicitly defines its`);
  lines.push(`expansion. Never guess at acronym meanings from training data.`);
  lines.push(`No bullet lists. No headers. Just prose.`);
  lines.push('');
  lines.push('## Symbols in this module');
  const items = group.items.slice(0, MAX_SYMBOLS_IN_PROMPT);
  for (const it of items) {
    lines.push(`- ${it.name} (${it.kind}): ${it.summary}`);
  }
  if (group.items.length > items.length) {
    lines.push(`- ... and ${group.items.length - items.length} more`);
  }
  lines.push('');
  lines.push('Module summary:');
  return lines.join('\n');
}

interface SummarizeAllDirectoriesArgs {
  /** Absolute path to the project root. Used to locate `CLAUDE.md` /
   *  `README.md` for the project-identity anchor that grounds the
   *  per-directory prompt. Optional for backward compatibility — when
   *  omitted the anchor is skipped (legacy behavior) and a debug log
   *  is emitted so callers can spot the missing wiring. */
  projectRoot?: string;
  queries: QueryBuilder;
  client: LlmClient;
  modelLabel: string;
  options?: DirSummarizerOptions;
}

/**
 * Run a full directory-summarisation pass. Cheap: only directories
 * whose content_hash differs from the cached one regenerate.
 */
export async function summarizeAllDirectories(args: SummarizeAllDirectoriesArgs): Promise<DirSummarizerResult> {
  const { projectRoot, queries, client, modelLabel, options = {} } = args;
  const t0 = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const anchor: ProjectAnchor = projectRoot ? getProjectAnchor(projectRoot) : { text: '', source: 'none' };
  if (!projectRoot) {
    logDebug('DirSummarizer: projectRoot not provided — skipping project-identity anchor');
  } else {
    logDebug('DirSummarizer: project-identity anchor', {
      source: anchor.source,
      chars: anchor.text.length,
    });
  }

  const summarisedSymbols = getSummarisedSymbolsByDir(queries);
  const groups = groupByDir(summarisedSymbols);
  const total = groups.length;
  let done = 0;
  let generated = 0;
  let cacheHits = 0;
  let errors = 0;

  let next = 0;
  async function worker(): Promise<void> {
    while (next < groups.length) {
      if (options.signal?.aborted) return;
      const i = next++;
      const group = groups[i]!;
      try {
        const outcome = await summariseOneDir({
          queries,
          client,
          modelLabel,
          group,
          anchorText: anchor.text,
          signal: options.signal,
        });
        if (outcome === 'aborted') return;
        if (outcome === 'cached') cacheHits++;
        if (outcome === 'generated') generated++;
        if (outcome === 'empty') errors++;
      } catch (err) {
        errors++;
        logSummariseError(err, group.dir);
      } finally {
        done++;
        options.onProgress?.(done, total);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    candidates: total,
    generated,
    cacheHits,
    errors,
    durationMs: Date.now() - t0,
  };
}

type DirSummariseOutcome = 'cached' | 'generated' | 'empty' | 'aborted';

/** Classify a thrown error and log at the appropriate level. Pulled
 *  out of the worker's catch-block so the worker stays at depth 2. */
function logSummariseError(err: unknown, dir: string): void {
  if (err instanceof LlmEndpointError) {
    logDebug('DirSummarizer: endpoint error', { dir, error: err.message });
    return;
  }
  logWarn('DirSummarizer: unexpected error', { dir, error: String(err) });
}

/**
 * Summarise one directory group: cache-hit fast path; otherwise
 * chat → trim → upsert. Returns a discriminated outcome so the
 * caller's counter bookkeeping doesn't need to live inside the
 * try-block (which kept the worker at depth 4 of nested_complexity).
 *
 * `'empty'` covers the degenerate case where the chat returns no
 * usable text — the caller treats it as an error for accounting
 * even though no exception was thrown.
 */
interface SummariseOneDirArgs {
  queries: QueryBuilder;
  client: LlmClient;
  modelLabel: string;
  group: DirGroup;
  /** Project-identity anchor (extracted from CLAUDE.md / README.md) to
   *  prepend to the prompt. Empty string when no anchor was available;
   *  buildPrompt skips the block in that case. */
  anchorText: string;
  signal: AbortSignal | undefined;
}

async function summariseOneDir(args: SummariseOneDirArgs): Promise<DirSummariseOutcome> {
  const { queries, client, modelLabel, group, anchorText, signal } = args;
  const hash = hashDirContent(group, anchorText);
  const existing = getDirectorySummary(queries, group.dir);

  // Structural-pattern bypass (F-I): if the directory has a strong
  // structural signature (e.g. MCP tool handlers), emit a deterministic
  // paragraph and skip the LLM entirely. Cache key is the structural
  // model label, so a once-bad LLM row gets overwritten naturally on
  // the next sync (different model column → cache miss).
  // Source the `*_TOOL` count structurally (all nodes in the dir), not
  // from `group.items` — the items list only carries summarised symbols
  // and `*_TOOL` constants rarely have a summary/docstring (FRICTION-M).
  const toolExportCount = getDirToolExportConstantCount(queries, group.dir);
  const pattern = detectDirectoryPattern(group.items, { toolExportCount });
  if (pattern !== null) {
    if (existing && existing.contentHash === hash && existing.model === STRUCTURAL_DIR_MODEL) {
      return 'cached';
    }
    const structuralSummary = buildStructuralDirectorySummary(group.dir, pattern, group.items);
    const capped =
      structuralSummary.length > MAX_SUMMARY_CHARS
        ? truncateAtBoundary(structuralSummary, MAX_SUMMARY_CHARS)
        : structuralSummary;
    upsertDirectorySummary({
      qb: queries,
      dirPath: group.dir,
      contentHash: hash,
      summary: capped,
      model: STRUCTURAL_DIR_MODEL,
    });
    return 'generated';
  }

  if (existing && existing.contentHash === hash && existing.model === modelLabel) {
    return 'cached';
  }
  const result = await client.chat(
    [{ role: 'user', content: buildPrompt(group, anchorText) }],
    compact({ temperature: 0.2, maxTokens: 220, signal }),
  );
  // Honor abort signals between the chat call and the DB write so a
  // close()-cancelled run doesn't persist a stale entry.
  if (signal?.aborted) return 'aborted';
  // tidyLlmEnding repairs mid-word truncation from a maxTokens cap
  // BEFORE the char-cap-driven truncateAtBoundary fires. Both passes
  // are idempotent on already-clean text.
  let summary = tidyLlmEnding(result.text);
  if (summary.length === 0) return 'empty';
  if (summary.length > MAX_SUMMARY_CHARS) summary = truncateAtBoundary(summary, MAX_SUMMARY_CHARS);
  upsertDirectorySummary({ qb: queries, dirPath: group.dir, contentHash: hash, summary, model: modelLabel });
  return 'generated';
}
