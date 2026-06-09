import { z } from 'zod';
import { projectPathField, lowTokensField } from './_common-fields.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, err, ok } from './_outcome.js';

import { getAllFilesWithSymbolCount } from '../../db/queries-files.js';
import { getFileSummaries } from '../../db/queries-file-summaries.js';
import {
  FILE_DEPS_DIRECTIONS,
  MAX_FILE_DEPS_LIMIT,
  collectFileDeps,
  renderFileDeps,
} from '../../features/file-deps/index.js';
import {
  MAX_FILE_SYMBOL_LIMIT,
  collectFileSymbols,
  parseFileSymbolKinds,
  renderFileSymbols,
  resolveIndexedFilePath,
} from '../../features/file-symbols/index.js';
import {
  LOW_TOKEN_FILES_MAX_DEPTH,
  MAX_FILES_FOR_INLINE_SUMMARY,
  buildFilesNoMatchesMessage,
  filterFilesByDir,
  filterFilesByPattern,
  renderFilesMcpOutput,
  type FileListFormat,
} from '../../features/files/runtime.js';
import { LIST_ALL_DEFAULT_LIMIT, runModuleSummary } from '../../features/module/index.js';
import {
  MAX_SOURCE_READ_LINE_LIMIT,
  readIndexedFileSource,
  renderSourceRead,
} from '../../features/source-read/index.js';

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
    .enum(['tree', 'flat', 'grouped', 'summary', 'symbols', 'deps', 'module', 'read'])
    .optional()
    .describe(
      'Output: "tree" (hierarchical, default), "flat" (alphabetical), "grouped" (by language), ' +
        '"summary" (per-directory file/symbol-count rollup), "symbols" (one-file outline), ' +
        '"deps" (one-file dependencies/dependents), "module" (directory/module summary), or "read" (line-window source).',
    ),
  file: z
    .string()
    .min(1)
    .optional()
    .describe(
      'For format="symbols", "deps", or "read": project-relative indexed file path, or an absolute path inside the project.',
    ),
  lineOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('For format="read": zero-based source line offset. Defaults to 0.'),
  lineLimit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SOURCE_READ_LINE_LIMIT)
    .optional()
    .describe(`For format="read": number of source lines to return, in [1, ${MAX_SOURCE_READ_LINE_LIMIT}].`),
  kinds: z
    .string()
    .optional()
    .describe('For format="symbols": comma-separated node kinds to include, e.g. class,function,method.'),
  includeParameters: z
    .boolean()
    .optional()
    .describe('For format="symbols": include parameter nodes. Defaults to false.'),
  includeImports: z
    .boolean()
    .optional()
    .describe('For format="symbols": include import/export nodes. Defaults to false.'),
  direction: z
    .enum(FILE_DEPS_DIRECTIONS)
    .optional()
    .describe('For format="deps": dependencies, dependents, or both (default).'),
  symbols: z
    .boolean()
    .optional()
    .describe('For format="deps": include a short defines section. Defaults to true; pass false to omit.'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `For format="symbols"/"deps": cap returned rows in [1, ${MAX_FILE_SYMBOL_LIMIT}]. For format="module": cap cached directory summaries when no dirPath is supplied.`,
    ),
  dirPath: z
    .string()
    .optional()
    .describe('For format="module": project-relative directory path. When omitted, lists cached directory summaries.'),
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

interface HandleFileListingFormatArgs {
  ctx: ToolCtx;
  args: FilesArgs;
  format: FileListFormat;
  lowTokens: boolean;
}

function empty(message: string) {
  return ok(renderToolResponse({ body: '', empty: { message } }));
}

async function handleFiles(ctx: ToolCtx, args: FilesArgs): Promise<ToolOutcome> {
  const lowTokens = args.lowTokens === true;
  const format = args.format ?? defaultFilesFormat(lowTokens);
  switch (format) {
    case 'symbols':
      return handleFileSymbolsFormat(ctx, args);
    case 'deps':
      return handleFileDepsFormat(ctx, args);
    case 'module':
      return handleModuleFormat(ctx, args);
    case 'read':
      return handleFileReadFormat(ctx, args);
    default:
      return handleFileListingFormat({ ctx, args, format, lowTokens });
  }
}

function defaultFilesFormat(lowTokens: boolean): FileListFormat {
  return lowTokens ? 'summary' : 'tree';
}

async function handleFileListingFormat(input: HandleFileListingFormatArgs): Promise<ToolOutcome> {
  const { ctx, args, format, lowTokens } = input;
  const cg = ctx.getCartograph(args.projectPath);
  const pathFilter = args.dir;
  const pattern = args.pattern;
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
        empty: { message: 'No files indexed. Run `cartograph quickstart` first.' },
      }),
    );
  }

  const files = filterFilesByPattern({
    files: allFiles,
    options: {
      ...(pathFilter ? { dir: pathFilter } : {}),
      ...(pattern ? { pattern } : {}),
    },
    filterFilesByDir,
  });

  if (files.length === 0) {
    return ok(
      renderToolResponse({
        body: '',
        empty: {
          message: buildFilesNoMatchesMessage({
            allFiles,
            dir: pathFilter,
            pattern,
            projectRoot: cg.projectRoot,
          }),
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
      body: renderFilesMcpOutput({
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

function branchLimitInRange(limit: number | undefined, max: number, branch: string): ToolOutcome | null {
  if (limit === undefined || limit <= max) return null;
  return err(`\`limit\` for format="${branch}" must be an integer between 1 and ${max}.`);
}

async function handleFileSymbolsFormat(ctx: ToolCtx, args: FilesArgs): Promise<ToolOutcome> {
  if (!args.file) return err('`file` is required when `format` is "symbols".');
  const limitError = branchLimitInRange(args.limit, MAX_FILE_SYMBOL_LIMIT, 'symbols');
  if (limitError) return limitError;

  const cg = ctx.getCartograph(args.projectPath);
  const indexedFiles = getAllFilesWithSymbolCount(cg.queries);
  const resolved = resolveIndexedFilePath({ file: args.file, projectRoot: cg.projectRoot, indexedFiles });
  if (!resolved.ok) return empty(resolved.message);
  const kinds = parseFileSymbolKinds(args.kinds);
  if (!kinds.ok) return err(kinds.message);
  const result = collectFileSymbols({
    nodes: cg.queries.getNodesByFile(resolved.filePath),
    kinds: kinds.kinds,
    includeParameters: args.includeParameters === true,
    includeImports: args.includeImports === true,
    limit: args.limit,
    lowTokens: args.lowTokens === true,
  });
  return ok(
    renderToolResponse({
      body: renderFileSymbols({
        filePath: resolved.filePath,
        result,
        note: resolved.note,
        lowTokens: args.lowTokens === true,
      }),
    }),
  );
}

async function handleFileDepsFormat(ctx: ToolCtx, args: FilesArgs): Promise<ToolOutcome> {
  if (!args.file) return err('`file` is required when `format` is "deps".');
  const limitError = branchLimitInRange(args.limit, MAX_FILE_DEPS_LIMIT, 'deps');
  if (limitError) return limitError;

  const cg = ctx.getCartograph(args.projectPath);
  const indexedFiles = getAllFilesWithSymbolCount(cg.queries);
  const resolved = resolveIndexedFilePath({ file: args.file, projectRoot: cg.projectRoot, indexedFiles });
  if (!resolved.ok) return empty(resolved.message);
  const result = collectFileDeps({
    filePath: resolved.filePath,
    dependencies: cg.internals.graphManager.getFileDependencies(resolved.filePath),
    dependents: cg.internals.graphManager.getFileDependents(resolved.filePath),
    nodes: cg.queries.getNodesByFile(resolved.filePath),
    direction: args.direction,
    symbols: args.symbols,
    limit: args.limit,
    lowTokens: args.lowTokens === true,
  });
  return ok(
    renderToolResponse({
      body: renderFileDeps({ result, note: resolved.note, lowTokens: args.lowTokens === true }),
    }),
  );
}

async function handleModuleFormat(ctx: ToolCtx, args: FilesArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const outcome = runModuleSummary(cg, {
    dirPath: args.dirPath ?? args.dir,
    limit: args.limit ?? LIST_ALL_DEFAULT_LIMIT,
  });
  if (!outcome.ok) return err(outcome.message);
  return ok(renderToolResponse({ body: outcome.body }));
}

async function handleFileReadFormat(ctx: ToolCtx, args: FilesArgs): Promise<ToolOutcome> {
  if (!args.file) return err('`file` is required when `format` is "read".');
  const cg = ctx.getCartograph(args.projectPath);
  const indexedFiles = getAllFilesWithSymbolCount(cg.queries);
  const outcome = readIndexedFileSource({
    projectRoot: cg.projectRoot,
    file: args.file,
    indexedFiles,
    lineOffset: args.lineOffset,
    lineLimit: args.lineLimit,
  });
  if (!outcome.ok) return empty(outcome.message);
  return ok(renderToolResponse({ body: renderSourceRead(outcome.result, args.lowTokens === true) }));
}

export const FILES_TOOL = defineTool({
  name: 'cartograph_files',
  description:
    'Indexed file and directory surface — project tree, grouped/summary views, one-file symbols, one-file dependencies, and directory/module summaries. ' +
    'Filter by `dir` prefix or `pattern` glob (e.g. `**/*.test.ts`). ' +
    'Format: `tree` (default) | `flat` | `grouped` | `summary` | `symbols` | `deps` | `module` | `read`. ' +
    '`lowTokens: true` defaults to summary format, no metadata, and a shallow depth cap. ' +
    'The `flat` format folds a per-file LLM summary under each row when the listing is ≤80 files.',
  schema: filesSchema,
  handle: handleFiles,
});
