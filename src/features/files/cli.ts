import { errMsg } from '../../errors.js';
import type { CliOptionCommand } from '../shared/cli-command.js';
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
} from './runtime.js';

type CommandLike = CliOptionCommand;

interface FilesCartographModule {
  default: {
    open: (projectPath: string) => Promise<any>;
  };
}

export interface FilesCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  info: (message: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  loadCartograph: () => Promise<FilesCartographModule>;
  isInitialized: (projectPath: string) => boolean;
  getAllFilesWithSymbolCount: (queries: any) => FileListing;
  getFileSummaries: (queries: any, paths: string[]) => Map<string, string>;
  filterFilesByDir: <T extends { path: string }>(files: ReadonlyArray<T>, dir: string) => T[];
  buildDirRollup: (files: ReadonlyArray<FileListingRow>, maxDepth?: number, dir?: string) => DirRollup;
  writeLine?: (message?: string) => void;
  style?: FilesRenderStyle;
}

interface WriteRenderedFilesArgs {
  deps: FilesCommandDeps;
  files: FileListing;
  outputOptions: { format: 'tree' | 'flat' | 'grouped' | 'summary'; maxDepth: number | undefined };
  effectiveOptions: FilesCommandOptions;
  queries: any;
}

export function registerFilesCommand(deps: FilesCommandDeps): void {
  deps.program
    .command('files [dir]')
    .description('Show project file structure from the index')
    .option('-p, --project-path <path>', 'Project path')
    .option('--dir <dir>', 'Filter to files under this directory')
    .option('--pattern <glob>', 'Filter files matching this glob pattern')
    .option('--format <format>', 'Output format (tree, flat, grouped, summary)')
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

async function openIndexedFiles(deps: FilesCommandDeps, projectPath: string): Promise<{ cg: any; files: FileListing }> {
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
