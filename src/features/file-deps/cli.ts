import { errMsg } from '../../errors.js';
import type { FileListing } from '../files/runtime.js';
import type { CliArgumentOptionCommand } from '../shared/cli-command.js';
import { resolveIndexedFilePath } from '../shared/indexed-file-path.js';
import {
  MAX_FILE_DEPS_LIMIT,
  collectFileDeps,
  parseFileDepsDirection,
  parseFileDepsLimit,
  renderFileDeps,
  type FileDepsDirection,
} from './runtime.js';

type CommandLike = CliArgumentOptionCommand;

interface FileDepsCartographModule {
  default: {
    open: (projectPath: string) => Promise<any>;
  };
}

export interface FileDepsCommandOptions {
  projectPath?: string;
  direction?: string;
  symbols?: boolean;
  limit?: string;
  lowTokens?: boolean;
  json?: boolean;
}

export interface FileDepsCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  info: (message: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  loadCartograph: () => Promise<FileDepsCartographModule>;
  isInitialized: (projectPath: string) => boolean;
  getAllFilesWithSymbolCount: (queries: any) => FileListing;
  writeLine?: (message?: string) => void;
}

interface ParsedFileDepsOptions {
  direction: FileDepsDirection;
  limit?: number | undefined;
}

function writeLine(deps: FileDepsCommandDeps, message = ''): void {
  (deps.writeLine ?? ((line = '') => process.stdout.write(`${line}\n`)))(message);
}

export function registerFileDepsCommand(deps: FileDepsCommandDeps): void {
  deps.program
    .command('file-deps <file>')
    .description('Show local file dependencies and dependents for one indexed file')
    .option('-p, --project-path <path>', 'Project path')
    .option('--direction <direction>', 'dependencies, dependents, or both')
    .option('--no-symbols', 'Omit the short defines section')
    .option('--limit <n>', `Maximum paths per section (1-${MAX_FILE_DEPS_LIMIT})`)
    .option('--low-tokens', 'Use compact rows and a lower default limit')
    .option('-j, --json', 'Output as JSON')
    .action((file: string, options: FileDepsCommandOptions) => runFileDepsCommand(deps, file, options));
}

export async function runFileDepsCommand(
  deps: FileDepsCommandDeps,
  file: string,
  options: FileDepsCommandOptions,
): Promise<void> {
  const projectPath = deps.resolveProjectPath(options.projectPath);
  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }
    const parsed = parseFileDepsOptions(options);
    if (!parsed.ok) {
      deps.error(parsed.message);
      process.exitCode = 1;
      return;
    }

    const { default: Cartograph } = await deps.loadCartograph();
    const cg = await Cartograph.open(projectPath);
    try {
      const indexedFiles = deps.getAllFilesWithSymbolCount(cg.queries);
      const resolved = resolveIndexedFilePath({ file, projectRoot: projectPath, indexedFiles });
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

function parseFileDepsOptions(
  options: FileDepsCommandOptions,
): { ok: true; options: ParsedFileDepsOptions } | { ok: false; message: string } {
  const direction = parseFileDepsDirection(options.direction);
  if (!direction.ok) return direction;
  const limit = parseFileDepsLimit(options.limit);
  if (!limit.ok) return limit;
  const parsed: ParsedFileDepsOptions = { direction: direction.direction };
  if (limit.limit !== undefined) parsed.limit = limit.limit;
  return { ok: true, options: parsed };
}
