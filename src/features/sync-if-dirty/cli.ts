import { errMsg } from '../../errors.js';
import { hasFreshnessRisk, type FreshnessInfo } from '../../freshness.js';
import { parseMaxFileSizeValue } from '../admin-indexing/runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

interface SyncIfDirtyGraph {
  sync: (opts: { summarize: false; maxFileSize?: number }) => Promise<unknown>;
  close: () => void;
  stats: { getFreshness: () => FreshnessInfo | null };
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
    .description('Compatibility hook command: run admin sync when the working tree is dirty or the index lags HEAD')
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

    const dirty = deps.hasUncommittedChanges(projectPath);
    const { default: Cartograph } = await deps.loadCartograph();
    cg = await Cartograph.open(projectPath, { autoMigrate: true });

    if (!dirty) {
      // A clean tree is not "nothing to do": commits, merges, checkouts,
      // and rebases all move HEAD without dirtying the tree, and the
      // index keeps answering from the old graph. Compare the indexed
      // sha against HEAD (plus disk-vs-index content drift) before
      // skipping. A never-stamped index (null) errs toward syncing.
      const freshness = cg.stats.getFreshness();
      if (freshness !== null && !hasFreshnessRisk(freshness)) {
        if (!options.quiet) deps.info('No source changes and index in sync with HEAD; skipping sync');
        return;
      }
    }

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
