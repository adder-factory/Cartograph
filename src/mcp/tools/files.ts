import * as path from 'node:path';
import { z } from 'zod';
import { projectPathField, lowTokensField } from './_common-fields.js';
import { globToSafeRegex } from '../../utils.js';
import { pathFilterStripHint } from './shared.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';

import { getAllFilesWithSymbolCount } from '../../db/queries-files.js';
import { getFileSummaries } from '../../db/queries-file-summaries.js';
import { type DirRollup, buildDirRollup, filterFilesByDir } from '../../features/files/runtime.js';
import {
  type FileTreeNode,
  buildFileTree,
  compareFileTreeChildren,
  recurseFileTreeChildren as sharedRecurseFileTreeChildren,
} from '../../file-tree-render.js';

type FileRow = { path: string; language: string; nodeCount: number };

/**
 * Only fold per-file LLM summaries into the flat listing when the
 * result set is this small or smaller. A full-project flat listing of
 * hundreds of files would be too noisy; a filtered dir/pattern query
 * stays readable.
 */
const MAX_FILES_FOR_INLINE_SUMMARY = 80;
const LOW_TOKEN_FILES_MAX_DEPTH = 3;

function formatFilesFlat(files: FileRow[], includeMetadata: boolean, summaries?: Map<string, string>): string {
  const lines: string[] = [`## Files (${files.length})`, ''];
  const sortedFiles = [...files];
  sortedFiles.sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sortedFiles) {
    if (includeMetadata) {
      lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
    } else {
      lines.push(`- ${file.path}`);
    }
    const summary = summaries?.get(file.path);
    if (summary) {
      lines.push(`    ${summary}`);
    }
  }
  return lines.join('\n');
}

function formatFilesGrouped(files: FileRow[], includeMetadata: boolean): string {
  const byLang = new Map<string, FileRow[]>();
  for (const file of files) {
    const existing = byLang.get(file.language) || [];
    existing.push(file);
    byLang.set(file.language, existing);
  }

  const lines: string[] = [`## Files by Language (${files.length} total)`, ''];

  // Sort languages by file count (descending)
  const sortedLangs = [...byLang.entries()];
  sortedLangs.sort((a, b) => b[1].length - a[1].length);

  for (const [lang, langFiles] of sortedLangs) {
    lines.push(`### ${lang} (${langFiles.length})`);
    const sortedLangFiles = [...langFiles];
    sortedLangFiles.sort((a, b) => a.path.localeCompare(b.path));
    for (const file of sortedLangFiles) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Options bundle for {@link formatFilesSummary}. */
export interface FormatFilesSummaryArgs {
  files: FileRow[];
  maxDepth?: number | undefined;
  dirFilter?: string | undefined;
  projectFileCount?: number | undefined;
}

/**
 * Build the `## Project Summary` / `## Subtree Summary` header line.
 *
 * Extracted from {@link formatFilesSummary} to decompose the nested
 * ternary that was driving the complex_conditional biomarker finding.
 * When `dirFilter` is set the header calls out the subtree scope and
 * (when `projectFileCount` differs from the filtered total) appends
 * the project-wide file count so the agent doesn't read in-scope
 * numbers as project-wide totals.
 */
function buildSummaryHeader(
  rollup: DirRollup,
  dirFilter: string | undefined,
  projectFileCount: number | undefined,
): string {
  const filterPrefix = dirFilter ? dirFilter.replace(/\/+$/, '') : null;
  // The "symbols" column in the summary table is the same nodeCount used by
  // tree/flat: `getAllFilesWithSymbolCount` subtracts the file node itself but
  // still includes import nodes. Label it "nodes (incl. imports)" to match
  // what the per-directory Symbols column actually contains, and avoid the
  // impression that the count is import-exclusive.
  const symbolsLabel = 'nodes (incl. imports)';
  if (!filterPrefix) {
    return `## Project Summary (${rollup.totalFiles} files, ${rollup.totalSymbols} ${symbolsLabel})`;
  }
  const base = `## Subtree Summary — \`${filterPrefix}/\` (${rollup.totalFiles} files, ${rollup.totalSymbols} ${symbolsLabel}`;
  const showProjectTotal =
    projectFileCount !== undefined && projectFileCount !== 0 && projectFileCount !== rollup.totalFiles;
  const suffix = showProjectTotal ? `; project-wide total ${projectFileCount} files)` : ')';
  return base + suffix;
}

/**
 * Per-directory summary — file + symbol counts rolled up at every
 * directory level. Lets the agent see "where the bulk of the code
 * lives" without paying for the full file list. Especially useful
 * on a fresh-repo onboarding ("which dirs are dense?") and during
 * impact-scope reasoning ("how big is `src/db/` actually?").
 *
 * Delegates the rollup computation to the shared {@link buildDirRollup}
 * so the MCP + CLI surfaces stay in lockstep.
 */
function formatFilesSummary(args: FormatFilesSummaryArgs): string {
  const { files, maxDepth, dirFilter, projectFileCount } = args;
  const rollup = buildDirRollup(files, maxDepth, dirFilter);
  const header = buildSummaryHeader(rollup, dirFilter, projectFileCount);
  const lines: string[] = [
    header,
    '',
    'Directory rollups — file + node counts per directory, sorted by node density. Node count includes import nodes.',
    '',
    '| Directory | Files | Nodes |',
    '|-----------|------:|------:|',
  ];
  for (const row of rollup.rows) {
    const label = row.dir === null ? '(root)' : `${row.dir}/`;
    lines.push(`| \`${label}\` | ${row.files} | ${row.symbols} |`);
  }
  return lines.join('\n');
}

interface RenderTreeArgs {
  node: FileTreeNode;
  prefix: string;
  isLast: boolean;
  depth: number;
  out: string[];
  includeMetadata: boolean;
  maxDepth: number | undefined;
}

/** Recursive ASCII-tree renderer. Free-function form (not an arrow
 *  inside the orchestrator) so its branch count doesn't roll up
 *  into the orchestrator's cyclomatic complexity. */
function renderFileTreeNode(args: RenderTreeArgs): void {
  const { node, prefix, isLast, depth, out, includeMetadata, maxDepth } = args;
  const exceedsMaxDepth = maxDepth !== undefined && depth > maxDepth;
  if (exceedsMaxDepth) return;
  const connector = isLast ? '└── ' : '├── ';
  const childPrefix = isLast ? '    ' : '│   ';
  if (node.name) {
    let line = prefix + connector + node.name;
    if (node.file && includeMetadata) {
      line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
    }
    out.push(line);
  }
  const children = [...node.children.values()].sort(compareFileTreeChildren);
  sharedRecurseFileTreeChildren<FileTreeNode, string[]>(
    children,
    { prefix, childPrefix, depth, includeMetadata, maxDepth, parentName: node.name, extra: out },
    (child, cArgs, childIsLast) =>
      renderFileTreeNode({
        node: child,
        prefix: cArgs.prefix,
        isLast: childIsLast,
        depth: cArgs.depth,
        out: cArgs.extra,
        includeMetadata: cArgs.includeMetadata,
        maxDepth: cArgs.maxDepth,
      }),
  );
}

function formatFilesTree(files: FileRow[], includeMetadata: boolean, maxDepth?: number): string {
  const lines: string[] = [`## Project Structure (${files.length} files)`, ''];
  renderFileTreeNode({
    node: buildFileTree(files),
    prefix: '',
    isLast: true,
    depth: 0,
    out: lines,
    includeMetadata,
    maxDepth,
  });
  return lines.join('\n');
}

/**
 * "Did you mean …?" hint for an empty `cartograph_files` result, mirroring
 * the `imports`/`grep` `pathFilter` nudge (audit-4 group-2 #3). Three
 * common agent mistakes are caught:
 *   1. an absolute path inside the project root
 *      (`/Users/.../cartograph/src/mcp`) → strip the project-root prefix
 *      (handoff #5 sub-i).
 *   2. a leading `/` not inside the project (`/src/mcp`) → strip the
 *      leading slash and probe.
 *   3. a project-root-basename prefix (`cartograph/src/...` on a repo
 *      named `cartograph`) → strip via `pathFilterStripHint`.
 * Returns the hint string (leading blank line included), or the empty
 * string when `dir` is absent / already correct.
 */
function buildEmptyDirHint(allFiles: ReadonlyArray<FileRow>, dir: string | undefined, projectRoot: string): string {
  if (!dir) return '';
  // Absolute path inside the project root (`/Users/.../cartograph/src/x`).
  // Strip the project-root prefix and probe — emit a "did you mean..."
  // hint with the project-relative form. Handoff #5 sub-i.
  const absoluteHint = buildAbsoluteDirHint(allFiles, dir, projectRoot);
  if (absoluteHint) return absoluteHint;
  // A leading `/` is silently swallowed by `filterFilesByDir`'s
  // normalisation only when the rest matches — strip it and probe.
  const leadingSlashHint = buildLeadingSlashDirHint(allFiles, dir);
  if (leadingSlashHint) return leadingSlashHint;
  // Project-root-basename prefix (`cartograph/src/...`).
  return pathFilterStripHint({
    pathFilter: dir,
    projectRoot,
    probe: (s) => filterFilesByDir(allFiles, s).length > 0,
  });
}

function buildAbsoluteDirHint(allFiles: ReadonlyArray<FileRow>, dir: string, projectRoot: string): string {
  if (!path.isAbsolute(dir)) return '';
  const normRoot = projectRoot.replace(/\/+$/, '');
  if (dir !== normRoot && !dir.startsWith(normRoot + '/')) return '';

  const stripped = dir === normRoot ? '' : dir.slice(normRoot.length + 1);
  if (stripped.length > 0 && filterFilesByDir(allFiles, stripped).length === 0) return '';

  const suggestion = stripped.length === 0 ? '(omit `dir`)' : `"${stripped}"`;
  return `\n\n> _\`dir\` "${dir}" looks like an absolute path inside the project. Did you mean ${suggestion}? Path filters are project-relative._`;
}

function buildLeadingSlashDirHint(allFiles: ReadonlyArray<FileRow>, dir: string): string {
  if (!dir.startsWith('/')) return '';
  const stripped = dir.replace(/^\/+/, '');
  if (stripped.length === 0 || filterFilesByDir(allFiles, stripped).length === 0) return '';
  return `\n\n> _\`dir\` "${dir}" matched 0 files. Did you mean "${stripped}"? Path filters are index-relative — drop the leading "/"._`;
}

/** Detect unsupported glob constructs in a `pattern` arg. The
 *  `globToSafeRegex` implementation deliberately supports only
 *  `*` / `?` / `**` and escapes other regex metacharacters as
 *  literals — so a pattern like `[a-z].ts` matches the literal
 *  `[`, not "any letter then `.ts`". Returns a short label naming
 *  the unsupported construct so the empty-result hint is actionable;
 *  returns `undefined` when no unsupported construct is present.
 *  Handoff #5 sub-iii. */
function detectUnsupportedGlobConstruct(pattern: string): string | undefined {
  if (/[[\]]/.test(pattern)) return '`[...]` character classes';
  if (/\{[^}]*\}/.test(pattern)) return '`{a,b}` alternation';
  if (pattern.startsWith('!')) return 'leading `!` negation';
  return undefined;
}

/** Hard cap on `maxDepth` — matches the schema-documented `[1, 20]` range. */
const MAX_MAX_DEPTH = 20;

/**
 * Zod schema for `cartograph_files`. `maxDepth` is `.int().min(1).max(20)`
 * — an out-of-range or non-integer value is REJECTED at the dispatch
 * boundary (the locked reject-out-of-range decision), matching the
 * CLI's `--max-depth` rejection. The handler therefore drops the old
 * defensive range check + `clamp`.
 *
 * `path` (legacy alias for `dir`) and `includeMetadata` (legacy alias
 * for `metadata`) are declared optional so older MCP clients that
 * pre-date the renames keep working — `safeParse` would otherwise
 * strip those undeclared keys before the handler's fallback could read
 * them.
 */
const filesSchema = z.object({
  dir: z.string().optional().describe('Filter to files under this directory path. Defaults to all files.'),
  pattern: z.string().optional().describe('Filter files by glob pattern (e.g. "*.tsx", "**/*.test.ts").'),
  format: z
    .enum(['tree', 'flat', 'grouped', 'summary'])
    .optional()
    .describe(
      'Output: "tree" (hierarchical, default), "flat" (alphabetical), "grouped" (by language), ' +
        '"summary" (per-directory file/symbol-count rollup, sorted by symbol density).',
    ),
  metadata: z.boolean().optional().describe('Include language and symbol count per file (default true).'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_DEPTH)
    .optional()
    .describe('Max directory depth to show, in [1, 20] (default unlimited).'),
  // The legacy `path` alias was retired (handoff #5 sub-ii): the CLI
  // never mirrored it, and keeping a deprecated MCP-only knob around
  // long after the rename produced cross-surface drift. We keep the
  // field in the schema with an explicit rejection so pre-rename
  // callers get a precise pointer to `dir` instead of silently empty
  // results. The `includeMetadata` alias is MCP-only too — the CLI
  // never exposed it as `--include-metadata`; both fields are listed in
  // the `files` per-property carve-out of the alignment test's
  // `ARG_SHAPE_EXCEPTIONS` (#31).
  path: z
    .any()
    .refine((v) => v === undefined, {
      error: '`path` was retired — use `dir` (same semantics). The legacy alias is no longer accepted.',
    })
    .optional()
    .describe('REMOVED — use `dir` instead. Passing `path` is rejected.'),
  includeMetadata: z.boolean().optional().describe('Legacy alias for `metadata`. Prefer `metadata`.'),
  lowTokens: lowTokensField,
  projectPath: projectPathField,
});

type FilesArgs = z.infer<typeof filesSchema>;

async function handleFiles(ctx: ToolCtx, args: FilesArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const pathFilter = args.dir;
  const pattern = args.pattern;
  const lowTokens = args.lowTokens === true;
  const format = args.format ?? (lowTokens ? 'summary' : 'tree');
  // `metadata` is the canonical key (default true); accept legacy
  // `includeMetadata` as a fallback so older MCP clients keep working.
  // An explicit `includeMetadata: false` still wins over the `metadata`
  // default.
  const includeMetadata = args.includeMetadata ?? args.metadata ?? !lowTokens;
  // `maxDepth` is already an integer in [1, 20] when present — Zod's
  // `.int().min().max()` rejected anything else at the dispatch
  // boundary. No clamp / range check needed.
  const maxDepth = args.maxDepth ?? (lowTokens ? LOW_TOKEN_FILES_MAX_DEPTH : undefined);

  // Get all files from the index, with `nodeCount` corrected to a true
  // symbol count (the renderers below all label this figure "symbols").
  // The `files.node_count` → symbol-count correction lives in
  // getAllFilesWithSymbolCount so CLI and MCP can't drift.
  const allFiles = getAllFilesWithSymbolCount(cg.queries);

  if (allFiles.length === 0) {
    return ok(
      renderToolResponse({
        body: '',
        empty: { message: 'No files indexed. Run `cartograph index` first.' },
      }),
    );
  }

  // Filter by directory — SEGMENT-boundary match so the filter
  // `src/mcp/tools` does NOT also capture the sibling file
  // `src/mcp/tools.ts` (literal startsWith would).
  let files = pathFilter ? filterFilesByDir(allFiles, pathFilter) : allFiles;

  // Filter by glob pattern. globToSafeRegex returns null only for a
  // pathologically long (>1024-char) glob — treat that as "matches
  // nothing" so the degenerate input can't fall through unfiltered.
  if (pattern) {
    const regexBody = globToSafeRegex(pattern);
    const regex = regexBody === null ? /(?!)/ : new RegExp(regexBody);
    files = files.filter((f) => regex.test(f.path));
  }

  if (files.length === 0) {
    // The "did you mean …?" hint is a path-correction nudge, not a
    // freshness signal — it already carries its own leading blank line,
    // so it folds straight into the empty-result message. The
    // unsupported-glob hint complements it for `pattern` arg mistakes.
    const dirHint = buildEmptyDirHint(allFiles, pathFilter, cg.projectRoot);
    const unsupported = pattern ? detectUnsupportedGlobConstruct(pattern) : undefined;
    const patternHint = unsupported
      ? `\n\n> _\`pattern\` "${pattern}" contains ${unsupported}, which is NOT honored. Only \`*\` / \`?\` / \`**\` glob syntax is supported — unsupported metacharacters are treated as literals. Use a simpler pattern (\`*.ts\`, \`**/*.test.ts\`)._`
      : '';
    return ok(
      renderToolResponse({
        body: '',
        empty: {
          message: `No files found matching the criteria.${dirHint}${patternHint}`,
        },
      }),
    );
  }

  // Pass the `dir` filter through so the summary renderer can label
  // its header correctly (subtree vs project) and suppress ancestor
  // rows that would otherwise carry the misleading filtered-scope count.
  const projectFileCount = pathFilter ? allFiles.length : undefined;

  // For flat format, batch-fetch per-file LLM summaries (one query) and
  // fold them as indented continuation lines — but only when the result
  // set is small enough to stay readable.
  const flatSummaries =
    format === 'flat' && files.length <= MAX_FILES_FOR_INLINE_SUMMARY
      ? getFileSummaries(
          cg.queries,
          files.map((f) => f.path),
        )
      : undefined;

  return ok(
    renderToolResponse({
      body: renderFilesByFormat({
        format,
        files,
        includeMetadata,
        maxDepth,
        dirFilter: pathFilter,
        projectFileCount,
        flatSummaries,
      }),
    }),
  );
}

/** Dispatch the format string to its renderer; default is `tree`. */
interface RenderFilesByFormatArgs {
  format: 'tree' | 'flat' | 'grouped' | 'summary';
  files: FileRow[];
  includeMetadata: boolean;
  maxDepth: number | undefined;
  dirFilter: string | undefined;
  projectFileCount: number | undefined;
  /** Pre-fetched path→summary map for the flat format; absent when the
   *  result set exceeds MAX_FILES_FOR_INLINE_SUMMARY or format ≠ flat. */
  flatSummaries?: Map<string, string> | undefined;
}

function renderFilesByFormat(args: RenderFilesByFormatArgs): string {
  const { format, files, includeMetadata, maxDepth, dirFilter, projectFileCount, flatSummaries } = args;
  if (format === 'flat') return formatFilesFlat(files, includeMetadata, flatSummaries);
  if (format === 'grouped') return formatFilesGrouped(files, includeMetadata);
  if (format === 'summary') return formatFilesSummary({ files, maxDepth, dirFilter, projectFileCount });
  return formatFilesTree(files, includeMetadata, maxDepth);
}

export const FILES_TOOL = defineTool({
  name: 'cartograph_files',
  description:
    'Indexed-file tree view with language + symbol count — faster than shell `find` for project structure. ' +
    'Filter by `dir` prefix or `pattern` glob (e.g. `**/*.test.ts`). ' +
    'Format: `tree` (default) | `flat` | `grouped` (by language) | `summary`. ' +
    '`lowTokens: true` defaults to summary format, no metadata, and a shallow depth cap. ' +
    'The `flat` format folds a per-file LLM summary under each row when the listing is ≤80 files.',
  schema: filesSchema,
  handle: handleFiles,
});
