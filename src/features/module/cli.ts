import { errMsg } from '../../errors.js';
import type { CliArgumentOptionCommand } from '../shared/cli-command.js';
import { LIST_ALL_DEFAULT_LIMIT, runModuleSummary } from './runtime.js';

type CommandLike = CliArgumentOptionCommand;

interface ModuleCartographModule {
  default: {
    open: (projectPath: string) => Promise<any>;
  };
}

export interface ModuleCommandOptions {
  projectPath?: string;
  dir?: string;
  limit?: string;
}

export interface ModuleCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  info: (message: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  loadCartograph: () => Promise<ModuleCartographModule>;
  isInitialized: (projectPath: string) => boolean;
  writeLine?: (message?: string) => void;
}

function writeLine(deps: Pick<ModuleCommandDeps, 'writeLine'>, message = ''): void {
  (deps.writeLine ?? ((line = '') => process.stdout.write(`${line}\n`)))(message);
}

export function registerModuleCommand(deps: ModuleCommandDeps): void {
  deps.program
    .command('module [dirPath]')
    .description('Directory/module summary')
    .option('-p, --project-path <path>', 'Project path')
    .option('--dir <dirPath>', 'Project-relative directory path')
    .option('-l, --limit <n>', `Max directory summaries when no dir is supplied (default ${LIST_ALL_DEFAULT_LIMIT})`)
    .action((dirPath: string | undefined, options: ModuleCommandOptions) => runModuleCommand(deps, dirPath, options));
}

export async function runModuleCommand(
  deps: ModuleCommandDeps,
  dirPath: string | undefined,
  options: ModuleCommandOptions,
): Promise<void> {
  const projectPath = deps.resolveProjectPath(options.projectPath);
  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }

    const limit = parseModuleLimit(options.limit);
    if (!limit.ok) {
      deps.error(limit.message);
      process.exitCode = 1;
      return;
    }

    const { default: Cartograph } = await deps.loadCartograph();
    const cg = await Cartograph.open(projectPath);
    try {
      const outcome = runModuleSummary(cg, {
        dirPath: dirPath ?? options.dir,
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

function parseModuleLimit(raw: string | undefined): { ok: true; limit?: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true };
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, message: '--limit must be a positive integer' };
  }
  return { ok: true, limit };
}
