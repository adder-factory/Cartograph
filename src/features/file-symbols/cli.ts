import { errMsg } from '../../errors.js';
import type { Node, NodeKind } from '../../types.js';
import type { FileListing } from '../files/runtime.js';
import type { CliArgumentOptionCommand } from '../shared/cli-command.js';
import {
  MAX_FILE_SYMBOL_LIMIT,
  collectFileSymbols,
  parseFileSymbolKinds,
  renderFileSymbols,
  resolveIndexedFilePath,
} from './runtime.js';

type CommandLike = CliArgumentOptionCommand;

interface FileSymbolsCartographModule {
  default: {
    open: (projectPath: string) => Promise<any>;
  };
}

export interface FileSymbolsCommandOptions {
  projectPath?: string;
  kinds?: string;
  includeParameters?: boolean;
  includeImports?: boolean;
  limit?: string;
  lowTokens?: boolean;
  json?: boolean;
}

export interface FileSymbolsCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  info: (message: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  loadCartograph: () => Promise<FileSymbolsCartographModule>;
  isInitialized: (projectPath: string) => boolean;
  getAllFilesWithSymbolCount: (queries: any) => FileListing;
  writeLine?: (message?: string) => void;
}

interface ParsedFileSymbolsOptions {
  kinds?: NodeKind[] | undefined;
  limit?: number | undefined;
}

function writeLine(deps: FileSymbolsCommandDeps, message = ''): void {
  (deps.writeLine ?? ((line = '') => process.stdout.write(`${line}\n`)))(message);
}

export function registerFileSymbolsCommand(deps: FileSymbolsCommandDeps): void {
  deps.program
    .command('file-symbols <file>')
    .description('List indexed symbols in one file')
    .option('-p, --project-path <path>', 'Project path')
    .option('--kinds <kinds>', 'Comma-separated node kinds to include')
    .option('--include-parameters', 'Include parameter nodes')
    .option('--include-imports', 'Include import/export nodes')
    .option('--limit <n>', `Maximum symbols to return (1-${MAX_FILE_SYMBOL_LIMIT})`)
    .option('--low-tokens', 'Use compact rows and a lower default limit')
    .option('-j, --json', 'Output as JSON')
    .action((file: string, options: FileSymbolsCommandOptions) => runFileSymbolsCommand(deps, file, options));
}

export async function runFileSymbolsCommand(
  deps: FileSymbolsCommandDeps,
  file: string,
  options: FileSymbolsCommandOptions,
): Promise<void> {
  const projectPath = deps.resolveProjectPath(options.projectPath);
  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }
    const parsed = parseFileSymbolsOptions(options);
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
      const nodes = cg.queries.getNodesByFile(resolved.filePath) as Node[];
      const result = collectFileSymbols({
        nodes,
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

function parseFileSymbolsOptions(
  options: FileSymbolsCommandOptions,
): { ok: true; options: ParsedFileSymbolsOptions } | { ok: false; message: string } {
  const kinds = parseKinds(options.kinds);
  if (!kinds.ok) return kinds;
  const limit = parseLimit(options.limit);
  if (!limit.ok) return limit;
  const parsed: ParsedFileSymbolsOptions = {};
  if (kinds.kinds) parsed.kinds = kinds.kinds;
  if (limit.limit !== undefined) parsed.limit = limit.limit;
  return { ok: true, options: parsed };
}

function parseKinds(raw: string | undefined): { ok: true; kinds?: NodeKind[] } | { ok: false; message: string } {
  const parsed = parseFileSymbolKinds(raw);
  if (parsed.ok) return parsed;
  return { ok: false, message: parsed.message.replace('Invalid kind value', 'Invalid --kind value') };
}

function parseLimit(raw: string | undefined): { ok: true; limit?: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true };
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FILE_SYMBOL_LIMIT) {
    return { ok: false, message: `--limit must be an integer between 1 and ${MAX_FILE_SYMBOL_LIMIT}` };
  }
  return { ok: true, limit };
}
