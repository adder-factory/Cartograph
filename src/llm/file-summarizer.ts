/**
 * File-level summaries — the tier BETWEEN symbol and directory.
 *
 * Rolls up the per-symbol summaries of one file into a single prose
 * paragraph answering "what does this file do?". Mirrors the
 * directory-summary tier (`dir-summarizer.ts`) one rung lower: where
 * the directory tier rolls up symbols across a directory, this rolls
 * them up within a file. Lets the AI assistant get file-level context
 * in a single MCP lookup instead of crawling every symbol.
 *
 * Source of truth is `symbol_summaries` (joined via
 * `getSummarisedSymbolsByDir`, which returns every summarised symbol
 * with its file path — the same row set both tiers group). A file is
 * only summarised once at least one of its symbols has a summary.
 *
 * Prompt-injection note: the synthesis prompt embeds LLM-generated
 * symbol summaries verbatim — same accepted risk as the directory
 * tier (all data originates from the user's own codebase).
 *
 * KV-cache reuse (lever A, commit `7abb01e`): the instruction preamble
 * is a constant `system` message and only the per-file roll-up is the
 * variable `user` message, so the openai-compat backend reuses the system-prompt
 * KV prefix across every file in a pass.
 */

import { type LlmClient, LlmEndpointError } from './client.js';
import type { QueryBuilder } from '../db/queries.js';
import { getSummarisedSymbolsByDir } from '../db/queries-directory-summaries.js';
import { getFileSummary, upsertFileSummary } from '../db/queries-file-summaries.js';
import { truncateAtBoundary, tidyLlmEnding, getProjectAnchor, type ProjectAnchor } from './dir-summarizer.js';
import { hashSummaryGroupContent } from './summary-hash.js';
import { logDebug, logWarn } from '../errors.js';
import { compact } from '../utils.js';

/** Min number of summarised symbols before a file is worth a paragraph.
 *  1 — a file with a single summarised symbol still gets a roll-up; the
 *  content-hash cache makes the marginal case near-free on re-runs. */
const MIN_SYMBOLS_PER_FILE = 1;

/** Cap how many symbol summaries feed one file prompt. Rows arrive
 *  centrality-ordered (`getSummarisedSymbolsByDir`), so the slice keeps
 *  a file's structural spine; 50 covers all but the largest files. */
const MAX_SYMBOLS_IN_PROMPT = 50;

/** Output cap for the synth call. Tight: this is meant to be skimmed. */
const MAX_SUMMARY_CHARS = 600;

const DEFAULT_CONCURRENCY = 1; // Synthesis is large per call; serial is fine.

/**
 * Constant instruction preamble — the `system` half of the prompt.
 * Held byte-identical across every file so the openai-compat backend reuses its
 * KV-cache prefix (lever A). Per-file content lives in the user message.
 */
const FILE_SUMMARY_SYSTEM_PROMPT = [
  'You are a senior engineer documenting an unfamiliar codebase.',
  '',
  'You will be given a file path and one-line descriptions of the symbols',
  `it defines. Write ONE SHORT paragraph (max ${MAX_SUMMARY_CHARS} characters)`,
  'describing what the FILE does as a whole — its responsibility and the',
  'main symbols it exposes. Ground every claim in the symbol descriptions',
  'provided; do not invent functionality that is not present in them.',
  // Handoff #9: the file-summary prose hallucinated acronym expansions
  // for directory names (e.g. "MCP" → "Microcontroller Platform" /
  // "Minecraft Code Platform" / "Maven Central Platform" on the same
  // project). The anti-expansion guidance below limits the LLM to
  // verbatim use of any acronym it sees, unless the Project Overview
  // text in the user prompt defines the expansion.
  'When a directory name or file path contains an acronym (e.g. "mcp",',
  '"hnsw"), use it VERBATIM unless the Project Overview in the user',
  'message explicitly defines its expansion. Never guess at acronym',
  'meanings from training data.',
  'No bullet lists, no headers, no markdown — just prose.',
].join('\n');

interface FileSummarizerOptions {
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

interface FileSummarizerResult {
  candidates: number;
  generated: number;
  cacheHits: number;
  /** Files whose parent `files` row vanished between the symbol query
   *  and the FK-guarded upsert — a benign mid-flight race, NOT an error. */
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface FileGroupItem {
  name: string;
  kind: string;
  summary: string;
}

interface FileGroup {
  filePath: string;
  items: FileGroupItem[];
}

/**
 * Group summarised symbols by their file path. Source of truth is the
 * symbol_summaries table; a file with no summarised symbols never
 * appears here. `filePath` is used verbatim (no posix-normalisation) so
 * it matches `files.path` — the FK target of `file_summaries`.
 */
function groupByFile(
  rows: ReadonlyArray<{ filePath: string; name: string; kind: string; summary: string }>,
): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const row of rows) {
    let g = groups.get(row.filePath);
    if (!g) {
      g = { filePath: row.filePath, items: [] };
      groups.set(row.filePath, g);
    }
    g.items.push({ name: row.name, kind: row.kind, summary: row.summary });
  }
  return [...groups.values()].filter((g) => g.items.length >= MIN_SYMBOLS_PER_FILE);
}

/** Stable hash of a file's rolled-up symbol summaries so re-running is
 *  a cache hit when nothing changed. Sorted to be order-stable across
 *  DB row order.
 *
 *  `anchorText` is folded in so that a substantive edit to CLAUDE.md /
 *  README.md (the project-identity anchor) invalidates the cached
 *  paragraph and re-prompts the LLM with the new grounding. Without
 *  this, a fixed CLAUDE.md wouldn't take effect until the symbol
 *  summaries underneath the file changed — mirrors `hashDirContent`
 *  in `dir-summarizer.ts:116-135` (same contract). */
function hashFileContent(group: FileGroup, anchorText: string): string {
  return hashSummaryGroupContent(group.items, anchorText);
}

/**
 * Build the per-file user message — the variable half of the prompt.
 * Every constant instruction lives in {@link FILE_SUMMARY_SYSTEM_PROMPT};
 * keeping this minimal maximises the shared KV-cache prefix.
 *
 * `anchorText` is the project-identity grounding extracted from
 * CLAUDE.md / README.md by {@link getProjectAnchor} — same mechanism
 * the dir-summarizer uses. When the project documents an acronym in
 * its Project Overview, the LLM can ground its prose against the
 * definition instead of hallucinating from training data. Empty
 * string skips the anchor block entirely (legacy behaviour).
 *
 * Exported for tests so a fixture can assert the roll-up shape.
 */
export function buildFileSummaryUserPrompt(group: FileGroup, anchorText: string): string {
  const lines: string[] = [];
  if (anchorText.length > 0) {
    lines.push('## Project Overview (for grounding only — do not paraphrase verbatim)');
    lines.push(anchorText);
    lines.push('');
  }
  lines.push(`File: ${group.filePath}`);
  lines.push('');
  lines.push('Symbols defined in this file:');
  const items = group.items.slice(0, MAX_SYMBOLS_IN_PROMPT);
  for (const it of items) {
    lines.push(`- ${it.name} (${it.kind}): ${it.summary}`);
  }
  if (group.items.length > items.length) {
    lines.push(`- ... and ${group.items.length - items.length} more`);
  }
  lines.push('');
  lines.push('File summary:');
  return lines.join('\n');
}

interface SummarizeAllFilesArgs {
  /** Absolute path to the project root. Used to locate `CLAUDE.md` /
   *  `README.md` for the project-identity anchor that grounds every
   *  per-file prompt. Optional for backward compatibility — when
   *  omitted the anchor is skipped (legacy behaviour) and a debug log
   *  is emitted so callers can spot the missing wiring. Mirrors
   *  {@link import('./dir-summarizer.js').summarizeAllDirectories}'s
   *  same-named arg. */
  projectRoot?: string;
  queries: QueryBuilder;
  client: LlmClient;
  modelLabel: string;
  options?: FileSummarizerOptions;
}

/**
 * Run a full file-summarisation pass. Cheap: only files whose
 * content_hash differs from the cached one regenerate.
 */
export async function summarizeAllFiles(args: SummarizeAllFilesArgs): Promise<FileSummarizerResult> {
  const { projectRoot, queries, client, modelLabel, options = {} } = args;
  const t0 = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const anchor: ProjectAnchor = projectRoot ? getProjectAnchor(projectRoot) : { text: '', source: 'none' };
  if (projectRoot) {
    logDebug('FileSummarizer: project-identity anchor', {
      source: anchor.source,
      textLen: anchor.text.length,
    });
  } else {
    logDebug('FileSummarizer: projectRoot not provided — skipping project-identity anchor');
  }

  const summarisedSymbols = getSummarisedSymbolsByDir(queries);
  const groups = groupByFile(summarisedSymbols);
  const total = groups.length;
  let done = 0;
  let generated = 0;
  let cacheHits = 0;
  let skipped = 0;
  let errors = 0;

  let next = 0;
  async function worker(): Promise<void> {
    while (next < groups.length) {
      if (options.signal?.aborted) return;
      const i = next++;
      const group = groups[i]!;
      try {
        const outcome = await summariseOneFile({
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
        if (outcome === 'skipped') skipped++;
        if (outcome === 'empty') errors++;
      } catch (err) {
        errors++;
        logSummariseError(err, group.filePath);
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
    skipped,
    errors,
    durationMs: Date.now() - t0,
  };
}

type FileSummariseOutcome = 'cached' | 'generated' | 'skipped' | 'empty' | 'aborted';

/** Classify a thrown error and log at the appropriate level. */
function logSummariseError(err: unknown, filePath: string): void {
  if (err instanceof LlmEndpointError) {
    logDebug('FileSummarizer: endpoint error', { filePath, error: err.message });
    return;
  }
  logWarn('FileSummarizer: unexpected error', { filePath, error: String(err) });
}

interface SummariseOneFileArgs {
  queries: QueryBuilder;
  client: LlmClient;
  modelLabel: string;
  group: FileGroup;
  /** Project-identity anchor text, threaded through from
   *  {@link summarizeAllFiles}'s `projectRoot`. Empty string when the
   *  caller didn't pass projectRoot — caller skips the anchor block. */
  anchorText: string;
  signal: AbortSignal | undefined;
}

/**
 * Summarise one file group: cache-hit fast path; otherwise
 * chat → trim → upsert. Returns a discriminated outcome so the
 * caller's counter bookkeeping stays out of the try-block.
 *
 * `'skipped'` covers the case where the FK-guarded `upsertFileSummary`
 * found no parent `files` row (the file was deleted mid-pass) — a
 * benign race, counted apart from `errors`.
 */
async function summariseOneFile(args: SummariseOneFileArgs): Promise<FileSummariseOutcome> {
  const { queries, client, modelLabel, group, anchorText, signal } = args;
  const hash = hashFileContent(group, anchorText);
  const existing = getFileSummary(queries, group.filePath);
  if (existing && existing.contentHash === hash && existing.model === modelLabel) {
    return 'cached';
  }
  const result = await client.chat(
    [
      { role: 'system', content: FILE_SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: buildFileSummaryUserPrompt(group, anchorText) },
    ],
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
  const written = upsertFileSummary({
    qb: queries,
    filePath: group.filePath,
    contentHash: hash,
    summary,
    model: modelLabel,
  });
  return written ? 'generated' : 'skipped';
}
