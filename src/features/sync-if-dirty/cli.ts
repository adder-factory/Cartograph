import { errMsg } from '../../errors.js';
import { parseMaxFileSizeValue } from '../admin-indexing/runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

interface SyncIfDirtyGraph {
  sync: (opts: { summarize: false; maxFileSize?: number }) => Promise<unknown>;
  close: () => void;
}

export interface SyncIfDirtyCommandDeps {
  program: CliOptionCommand;
  resolveProjectPath: (pathArg?: string) => string;
  isInitialized: (projectPath: string) => boolean;
  hasUncommittedChanges: (projectPath: string) => boolean;
  loadCartograph: () => Promise<{
    default: {
      open: (projectPath: string, opts: { autoMigrate: boolean }) => Promise<SyncIfDirtyGraph>;
    };
  }>;
  info: (message: string) => void;
  error: (message: string) => void;
  writeStderr: (message?: string) => void;
}

export function registerSyncIfDirtyCommand(deps: SyncIfDirtyCommandDeps): void {
  deps.program
    .command('sync-if-dirty [path]')
    .description('Compatibility hook command: run admin sync only when git reports source changes')
    .option('-q, --quiet', 'Suppress output (for hooks)')
    .option(
      '--max-file-size <size>',
      'Transiently override config.maxFileSize. Use bytes or a kb/mb suffix, up to 10mb.',
    )
    .action((pathArg: string | undefined, options: { quiet?: boolean; maxFileSize?: string }) =>
      runSyncIfDirtyCommand(pathArg, options, deps),
    );
}

export async function runSyncIfDirtyCommand(
  pathArg: string | undefined,
  options: { quiet?: boolean; maxFileSize?: string },
  deps: SyncIfDirtyCommandDeps,
): Promise<void> {
  const projectPath = deps.resolveProjectPath(pathArg);
  const parsedMaxFileSize = parseMaxFileSizeValue(options.maxFileSize);
  if (!parsedMaxFileSize.ok) {
    deps.error(parsedMaxFileSize.error);
    process.exit(1);
  }
  const maxFileSize = parsedMaxFileSize.value;
  let cg: SyncIfDirtyGraph | undefined;

  try {
    if (!deps.isInitialized(projectPath)) {
      if (!options.quiet) deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exit(1);
    }

    if (!deps.hasUncommittedChanges(projectPath)) {
      if (!options.quiet) deps.info('No source changes detected; skipping sync');
      return;
    }

    const { default: Cartograph } = await deps.loadCartograph();
    cg = await Cartograph.open(projectPath, { autoMigrate: true });
    await cg.sync({ summarize: false, ...(maxFileSize !== undefined && { maxFileSize }) });
    if (!options.quiet) deps.info('Synced changed files');
  } catch (err) {
    if (!options.quiet) {
      deps.error(`Failed to sync: ${errMsg(err)}`);
      if (process.env['CG_DEBUG']) deps.writeStderr(`${errMsg(err)}\n`);
    }
    process.exit(1);
  } finally {
    cg?.close();
  }
}
