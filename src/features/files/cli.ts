import { errMsg } from '../../errors.js';
import type { Node, NodeKind } from '../../types.js';
import {
  MAX_FILE_DEPS_LIMIT,
  collectFileDeps,
  parseFileDepsDirection,
  parseFileDepsLimit,
  renderFileDeps,
  type FileDepsDirection,
} from '../file-deps/index.js';
import {
  MAX_FILE_SYMBOL_LIMIT,
  collectFileSymbols,
  parseFileSymbolKinds,
  renderFileSymbols,
  resolveIndexedFilePath,
} from '../file-symbols/index.js';
import { LIST_ALL_DEFAULT_LIMIT, runModuleSummary } from '../module/index.js';
import { MAX_SOURCE_READ_LINE_LIMIT } from '../source-read/index.js';
import { parseIntegerValue } from '../shared/cli-args.js';
import type { CliOptionCommand } from '../shared/cli-command.js';
import type Cartograph from '../../index.js';
import type { QueryBuilder } from '../../db/queries.js';
import {
  type DirRollup,
  type FileListing,
  type FileListingRow,
  type FilesCommandOptions,
  type FilesRenderStyle,
  type RenderFilesOutputArgs,
  buildEffectiveFilesOptions,
  buildFilesJsonRows,
  filterFilesForCli,
  parseFilesOutputOptions,
  renderFilesOutput,
  VALID_FILE_FORMATS,
} from './runtime.js';

type CommandLike = CliOptionCommand;

interface FilesCartographModule {
  default: {
    open: (projectPath: string) => Promise<Cartograph>;
  };
}

export interface FilesCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  info: (message: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  loadCartograph: () => Promise<FilesCartographModule>;
  isInitialized: (projectPath: string) => boolean;
  getAllFilesWithSymbolCount: (queries: QueryBuilder) => FileListing;
  getFileSummaries: (queries: QueryBuilder, paths: string[]) => Map<string, string>;
  filterFilesByDir: <T extends { path: string }>(files: ReadonlyArray<T>, dir: string) => T[];
  buildDirRollup: (files: ReadonlyArray<FileListingRow>, maxDepth?: number, dir?: string) => DirRollup;
  runViaMCP: (toolName: string, args: Record<string, unknown>, pathArg: string | undefined) => Promise<void>;
  writeLine?: (message?: string) => void;
  style?: FilesRenderStyle;
}

interface WriteRenderedFilesArgs {
  deps: FilesCommandDeps;
  files: FileListing;
  outputOptions: { format: 'tree' | 'flat' | 'grouped' | 'summary'; maxDepth: number | undefined };
  effectiveOptions: FilesCommandOptions;
  queries: QueryBuilder;
}

interface ParsedFilesDepsOptions {
  direction: FileDepsDirection;
  limit?: number | undefined;
}

interface ParsedFilesSymbolsOptions {
  kinds?: NodeKind[] | undefined;
  limit?: number | undefined;
}

interface ParseOptionalReadIntegerArgs {
  deps: Pick<FilesCommandDeps, 'error'>;
  raw: string | undefined;
  optionName: string;
  bounds: { min: number; max?: number };
}

export function registerFilesCommand(deps: FilesCommandDeps): void {
  deps.program
    .command('files [target]')
    .description('Show indexed file structure, file details, or directory/module summaries')
    .option('-p, --project-path <path>', 'Project path')
    .option('--dir <dir>', 'Filter to files under this directory')
    .option('--dir-path <dirPath>', 'For --format module: project-relative directory path')
    .option('--file <path>', 'For --format symbols/deps/read: indexed file path')
    .option('--pattern <glob>', 'Filter files matching this glob pattern')
    .option('--format <format>', `Output format (${VALID_FILE_FORMATS.join(', ')})`)
    .option('--line-offset <number>', 'For --format read: zero-based source line offset')
    .option('--line-limit <number>', `For --format read: source line count in [1, ${MAX_SOURCE_READ_LINE_LIMIT}]`)
    .option('--kinds <kinds>', 'For --format symbols: comma-separated node kinds to include')
    .option('--include-parameters', 'For --format symbols: include parameter nodes')
    .option('--include-imports', 'For --format symbols: include import/export nodes')
    .option('--direction <direction>', 'For --format deps: dependencies, dependents, or both')
    .option('--no-symbols', 'For --format deps: omit the short defines section')
    .option(
      '--limit <n>',
      `For --format symbols/deps/module: maximum rows (${MAX_FILE_SYMBOL_LIMIT} symbols, ${MAX_FILE_DEPS_LIMIT} deps per section)`,
    )
    .option('--max-depth <number>', 'Maximum directory depth for tree format')
    .option('--no-metadata', 'Hide file metadata (language, symbol count)')
    .option('--low-tokens', 'Prefer compact output: defaults to summary format, no metadata, and shallow max depth')
    .option('-j, --json', 'Output as JSON')
    .action(async (dirArg: string | undefined, options: FilesCommandOptions) => runFilesCommand(deps, dirArg, options));
}

export async function runFilesCommand(
  deps: FilesCommandDeps,
  dirArg: string | undefined,
  options: FilesCommandOptions,
): Promise<void> {
  const effectiveOptions = buildEffectiveFilesOptions(dirArg, options);
  switch (effectiveOptions.format) {
    case 'deps':
      await runFilesDepsCommand(deps, effectiveOptions);
      return;
    case 'symbols':
      await runFilesSymbolsCommand(deps, effectiveOptions);
      return;
    case 'module':
      await runFilesModuleCommand(deps, effectiveOptions);
      return;
    case 'read':
      await runFilesReadCommand(deps, effectiveOptions);
      return;
  }
  const projectPath = deps.resolveProjectPath(effectiveOptions.projectPath);

  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exit(1);
    }

    const { cg, files: indexedFiles } = await openIndexedFiles(deps, projectPath);
    try {
      const files = filterFilesForCli({
        files: indexedFiles,
        options: effectiveOptions,
        filterFilesByDir: deps.filterFilesByDir,
      });
      if (!files.ok) {
        deps.info(files.message);
        return;
      }

      if (effectiveOptions.json) {
        writeLine(deps, JSON.stringify(buildFilesJsonRows(files.files), null, 2));
        return;
      }

      const outputOptions = parseFilesOutputOptions(effectiveOptions);
      if (!outputOptions.ok) {
        deps.error(outputOptions.error);
        process.exitCode = 1;
        return;
      }

      writeRenderedFiles({ deps, files: files.files, outputOptions, effectiveOptions, queries: cg.queries });
    } finally {
      cg.close();
    }
  } catch (err) {
    deps.error(`Failed to list files: ${errMsg(err)}`);
    process.exit(1);
  }
}

async function runFilesDepsCommand(deps: FilesCommandDeps, options: FilesCommandOptions): Promise<void> {
  const file = options.file;
  if (!file) {
    deps.error('`--file` or a positional file path is required when --format is "deps".');
    process.exitCode = 1;
    return;
  }

  const parsed = parseFilesDepsOptions(options);
  if (!parsed.ok) {
    deps.error(parsed.message);
    process.exitCode = 1;
    return;
  }

  const projectPath = deps.resolveProjectPath(options.projectPath);
  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }

    const { cg, files } = await openIndexedFiles(deps, projectPath);
    try {
      const resolved = resolveIndexedFilePath({
        file,
        projectRoot: projectPath,
        indexedFiles: files,
        inspectHint: 'cartograph files',
      });
      if (!resolved.ok) {
        deps.info(resolved.message);
        return;
      }
      const result = collectFileDeps({
        filePath: resolved.filePath,
        dependencies: cg.internals.graphManager.getFileDependencies(resolved.filePath),
        dependents: cg.internals.graphManager.getFileDependents(resolved.filePath),
        nodes: cg.queries.getNodesByFile(resolved.filePath),
        direction: parsed.options.direction,
        symbols: options.symbols !== false,
        limit: parsed.options.limit,
        lowTokens: options.lowTokens === true,
      });
      if (options.json) {
        writeLine(deps, JSON.stringify({ ...result, note: resolved.note }, null, 2));
        return;
      }
      writeLine(deps, renderFileDeps({ result, note: resolved.note, lowTokens: options.lowTokens === true }));
    } finally {
      cg.close();
    }
  } catch (err) {
    deps.error(`Failed to show file dependencies: ${errMsg(err)}`);
    process.exitCode = 1;
  }
}

async function runFilesSymbolsCommand(deps: FilesCommandDeps, options: FilesCommandOptions): Promise<void> {
  const file = options.file;
  if (!file) {
    deps.error('`--file` or a positional file path is required when --format is "symbols".');
    process.exitCode = 1;
    return;
  }

  const parsed = parseFilesSymbolsOptions(options);
  if (!parsed.ok) {
    deps.error(parsed.message);
    process.exitCode = 1;
    return;
  }

  const projectPath = deps.resolveProjectPath(options.projectPath);
  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }

    const { cg, files } = await openIndexedFiles(deps, projectPath);
    try {
      const resolved = resolveIndexedFilePath({
        file,
        projectRoot: projectPath,
        indexedFiles: files,
        inspectHint: 'cartograph files',
      });
      if (!resolved.ok) {
        deps.info(resolved.message);
        return;
      }
      const result = collectFileSymbols({
        nodes: cg.queries.getNodesByFile(resolved.filePath) as Node[],
        kinds: parsed.options.kinds,
        includeParameters: options.includeParameters === true,
        includeImports: options.includeImports === true,
        limit: parsed.options.limit,
        lowTokens: options.lowTokens === true,
      });
      if (options.json) {
        writeLine(
          deps,
          JSON.stringify(
            {
              file: resolved.filePath,
              total: result.total,
              returned: result.symbols.length,
              symbols: result.symbols,
            },
            null,
            2,
          ),
        );
        return;
      }
      writeLine(
        deps,
        renderFileSymbols({
          filePath: resolved.filePath,
          result,
          note: resolved.note,
          lowTokens: options.lowTokens === true,
        }),
      );
    } finally {
      cg.close();
    }
  } catch (err) {
    deps.error(`Failed to list file symbols: ${errMsg(err)}`);
    process.exitCode = 1;
  }
}

async function runFilesModuleCommand(deps: FilesCommandDeps, options: FilesCommandOptions): Promise<void> {
  if (options.json) {
    deps.error('`--json` is not supported for `--format module` (markdown summary only).');
    process.exitCode = 1;
    return;
  }
  const projectPath = deps.resolveProjectPath(options.projectPath);
  const limit = parseModuleLimit(options.limit);
  if (!limit.ok) {
    deps.error(limit.message);
    process.exitCode = 1;
    return;
  }

  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }

    const { default: Cartograph } = await deps.loadCartograph();
    const cg = await Cartograph.open(projectPath);
    try {
      const outcome = runModuleSummary(cg, {
        dirPath: options.dirPath ?? options.dir,
        limit: limit.limit ?? LIST_ALL_DEFAULT_LIMIT,
      });
      if (!outcome.ok) {
        deps.error(outcome.message);
        process.exitCode = 1;
        return;
      }
      writeLine(deps, outcome.body);
    } finally {
      cg.close();
    }
  } catch (err) {
    deps.error(`Failed to show module summary: ${errMsg(err)}`);
    process.exitCode = 1;
  }
}

async function runFilesReadCommand(deps: FilesCommandDeps, options: FilesCommandOptions): Promise<void> {
  if (options.json) {
    deps.error('`--json` is not supported for `--format read` (raw source output only).');
    process.exitCode = 1;
    return;
  }
  const file = options.file ?? options.dir;
  if (!file) {
    deps.error('`--file` or a positional file path is required when --format is "read".');
    process.exitCode = 1;
    return;
  }

  const lineOffset = parseOptionalReadInteger({
    deps,
    raw: options.lineOffset,
    optionName: '--line-offset',
    bounds: { min: 0 },
  });
  if (lineOffset === null) return;
  const lineLimit = parseOptionalReadInteger({
    deps,
    raw: options.lineLimit,
    optionName: '--line-limit',
    bounds: { min: 1, max: MAX_SOURCE_READ_LINE_LIMIT },
  });
  if (lineLimit === null) return;

  await deps.runViaMCP(
    'cartograph_files',
    {
      format: 'read',
      file,
      lineOffset,
      lineLimit,
      lowTokens: options.lowTokens,
    },
    options.projectPath,
  );
}

function parseOptionalReadInteger(args: ParseOptionalReadIntegerArgs): number | undefined | null {
  const { deps, raw, optionName, bounds } = args;
  if (raw === undefined) return undefined;
  const parsed = parseIntegerValue(raw, optionName, bounds);
  if (parsed.ok) return parsed.value;
  deps.error(parsed.error);
  process.exitCode = 1;
  return null;
}

function parseFilesDepsOptions(
  options: FilesCommandOptions,
): { ok: true; options: ParsedFilesDepsOptions } | { ok: false; message: string } {
  const direction = parseFileDepsDirection(options.direction);
  if (!direction.ok) return direction;
  const limit = parseFileDepsLimit(options.limit);
  if (!limit.ok) return limit;
  const parsed: ParsedFilesDepsOptions = { direction: direction.direction };
  if (limit.limit !== undefined) parsed.limit = limit.limit;
  return { ok: true, options: parsed };
}

function parseFilesSymbolsOptions(
  options: FilesCommandOptions,
): { ok: true; options: ParsedFilesSymbolsOptions } | { ok: false; message: string } {
  const kinds = parseKinds(options.kinds);
  if (!kinds.ok) return kinds;
  const limit = parseSymbolsLimit(options.limit);
  if (!limit.ok) return limit;
  const parsed: ParsedFilesSymbolsOptions = {};
  if (kinds.kinds) parsed.kinds = kinds.kinds;
  if (limit.limit !== undefined) parsed.limit = limit.limit;
  return { ok: true, options: parsed };
}

function parseKinds(raw: string | undefined): { ok: true; kinds?: NodeKind[] } | { ok: false; message: string } {
  const parsed = parseFileSymbolKinds(raw);
  if (parsed.ok) return parsed;
  return { ok: false, message: parsed.message.replace('Invalid kind value', 'Invalid --kind value') };
}

function parseSymbolsLimit(raw: string | undefined): { ok: true; limit?: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true };
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FILE_SYMBOL_LIMIT) {
    return { ok: false, message: `--limit must be an integer between 1 and ${MAX_FILE_SYMBOL_LIMIT}` };
  }
  return { ok: true, limit };
}

function parseModuleLimit(raw: string | undefined): { ok: true; limit?: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true };
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, message: '--limit must be a positive integer' };
  }
  return { ok: true, limit };
}

async function openIndexedFiles(
  deps: FilesCommandDeps,
  projectPath: string,
): Promise<{ cg: Cartograph; files: FileListing }> {
  const { default: Cartograph } = await deps.loadCartograph();
  const cg = await Cartograph.open(projectPath);
  return { cg, files: deps.getAllFilesWithSymbolCount(cg.queries) };
}

function writeRenderedFiles({ deps, files, outputOptions, effectiveOptions, queries }: WriteRenderedFilesArgs): void {
  const summaries =
    outputOptions.format === 'flat' && files.length <= 80
      ? deps.getFileSummaries(
          queries,
          files.map((f) => f.path),
        )
      : undefined;
  const renderArgs: RenderFilesOutputArgs = {
    files,
    format: outputOptions.format,
    includeMetadata: effectiveOptions.lowTokens ? false : effectiveOptions.metadata !== false,
    maxDepth: outputOptions.maxDepth,
    dir: effectiveOptions.dir,
    buildDirRollup: deps.buildDirRollup,
  };
  if (summaries) renderArgs.summaries = summaries;
  if (deps.style) renderArgs.style = deps.style;
  const lines = renderFilesOutput(renderArgs);
  for (const line of lines) writeLine(deps, line);
  writeLine(deps);
}

function writeLine(deps: Pick<FilesCommandDeps, 'writeLine'>, message = ''): void {
  if (deps.writeLine) {
    deps.writeLine(message);
    return;
  }
  process.stdout.write(`${message}\n`);
}
