import { runScipExport, runScipImport, type ScipAdminRunResult, type ScipAdminRuntimeDeps } from './runtime.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

export interface ScipAdminCommandDeps extends ScipAdminRuntimeDeps {
  adminCmd: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  info: (message: string) => void;
  error: (message: string) => void;
}

function renderScipResult(result: ScipAdminRunResult, deps: ScipAdminCommandDeps): void {
  if (!result.ok) {
    deps.error(result.error);
    process.exitCode = 1;
    return;
  }
  for (const message of result.messages) deps.info(message);
}

export function registerScipAdminCommands(deps: ScipAdminCommandDeps): void {
  registerScipExportCommand(deps);
  registerScipImportCommand(deps);
}

function registerScipExportCommand(deps: ScipAdminCommandDeps): void {
  deps.adminCmd
    .command('scip-export [path]')
    .description(
      "Export the cartograph index to a SCIP protobuf file (mirrors cartograph_admin MCP tool with action='scip-export')",
    )
    .option('-o, --out <file>', 'Output .scip file path (default: <project>/index.scip)')
    .action(async (pathArg: string | undefined, options: { out?: string }) => {
      const projectPath = deps.resolveProjectPath(pathArg);
      renderScipResult(
        await runScipExport({ projectPath, ...(options.out ? { outPath: options.out } : {}) }, deps),
        deps,
      );
    });
}

function registerScipImportCommand(deps: ScipAdminCommandDeps): void {
  deps.adminCmd
    .command('scip-import [path]')
    .description(
      "Import a SCIP protobuf index into the cartograph graph — per-file replace (mirrors cartograph_admin MCP tool with action='scip-import')",
    )
    .option('-i, --in <file>', 'Input .scip file path (default: <project>/index.scip)')
    .action(async (pathArg: string | undefined, options: { in?: string }) => {
      const projectPath = deps.resolveProjectPath(pathArg);
      renderScipResult(await runScipImport({ projectPath, ...(options.in ? { inPath: options.in } : {}) }, deps), deps);
    });
}
