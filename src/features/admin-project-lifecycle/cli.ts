import { errMsg } from '../../errors.js';
import { resolveInitProjectPath, shouldConfirmUninit } from './runtime.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

type ClackPrompts = typeof import('@clack/prompts');

interface ProjectLifecycleGraph {
  indexAll: (opts: Record<string, unknown>) => Promise<any>;
  uninitialize: () => Promise<void>;
  close: () => void;
}

export interface AdminProjectLifecycleCommandDeps {
  adminCmd: CommandLike;
  colors: { dim: string; reset: string };
  chalk: { yellow: (message: string) => string };
  createShimmerProgress: () => { onProgress: any; stop: () => Promise<void> };
  createVerboseProgress: () => any;
  isInitialized: (projectPath: string) => boolean;
  loadCartograph: () => Promise<{
    default: {
      init: (projectPath: string, opts: { index: boolean }) => Promise<ProjectLifecycleGraph>;
      openSync: (projectPath: string) => ProjectLifecycleGraph;
    };
  }>;
  loadClack: () => Promise<ClackPrompts>;
  loadReadline: () => Promise<{ createInterface: (...args: any[]) => any }>;
  printIndexResult: (clack: ClackPrompts, result: any, projectPath: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  writeStdout: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export function registerAdminProjectLifecycleCommands(deps: AdminProjectLifecycleCommandDeps): void {
  registerInitCommand(deps);
  registerUninitCommand(deps);
}

function registerInitCommand(deps: AdminProjectLifecycleCommandDeps): void {
  const {
    adminCmd,
    colors,
    createShimmerProgress,
    createVerboseProgress,
    isInitialized,
    loadCartograph,
    loadClack,
    printIndexResult,
    writeStdout,
  } = deps;
  adminCmd
    .command('init [path]')
    .description(
      "Initialize Cartograph in a project directory — creates .cartograph/ and ensures the project .gitignore excludes it (mirrors cartograph_admin MCP tool with action='init')",
    )
    .option('-i, --index', 'Run initial indexing after initialization')
    .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
    .action(async (pathArg: string | undefined, options: { index?: boolean; verbose?: boolean }) => {
      const projectPath = resolveInitProjectPath(pathArg);
      const clack = await loadClack();
      let cg: ProjectLifecycleGraph | undefined;

      clack.intro('Initializing Cartograph');

      try {
        if (isInitialized(projectPath)) {
          clack.log.warn(`Already initialized in ${projectPath}`);
          clack.log.info('Use "cartograph admin index" to re-index or "cartograph admin sync" to update');
          clack.outro('');
          return;
        }

        const { default: Cartograph } = await loadCartograph();
        cg = await Cartograph.init(projectPath, { index: false });
        clack.log.success(`Initialized in ${projectPath}`);

        if (options.index) {
          let result: any;

          if (options.verbose) {
            result = await cg.indexAll({
              onProgress: createVerboseProgress(),
              verbose: true,
            });
          } else {
            writeStdout(`${colors.dim}│${colors.reset}\n`);
            const progress = createShimmerProgress();
            result = await cg.indexAll({
              onProgress: progress.onProgress,
            });
            await progress.stop();
          }

          printIndexResult(clack, result, projectPath);
        } else {
          clack.log.info('Run "cartograph admin index" to index the project');
        }

        clack.outro('Done');
      } catch (err) {
        clack.log.error(`Failed: ${errMsg(err)}`);
        process.exit(1);
      } finally {
        cg?.close();
      }
    });
}

function registerUninitCommand(deps: AdminProjectLifecycleCommandDeps): void {
  const {
    adminCmd,
    chalk,
    error,
    info,
    isInitialized,
    loadCartograph,
    loadReadline,
    resolveProjectPath,
    success,
    warn,
  } = deps;
  adminCmd
    .command('uninit [path]')
    .description(
      "Remove Cartograph from a project, deletes .cartograph/ directory (mirrors cartograph_admin MCP tool with action='uninit')",
    )
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (pathArg: string | undefined, options: { force?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          warn(`Cartograph is not initialized in ${projectPath}`);
          return;
        }

        if (!options.force) {
          const readline = await loadReadline();
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.yellow('⚠ This will permanently delete all Cartograph data. Continue? (y/N) '), resolve);
          });
          rl.close();

          if (!shouldConfirmUninit(answer)) {
            info('Cancelled');
            return;
          }
        }

        const { default: Cartograph } = await loadCartograph();
        const cg = Cartograph.openSync(projectPath);
        await cg.uninitialize();

        success(`Removed Cartograph from ${projectPath}`);
      } catch (err) {
        error(`Failed to uninitialize: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}
