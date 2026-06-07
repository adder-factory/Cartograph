import { errMsg } from '../../errors.js';
import { migrationSuccessMessage, type MigrationOutcome } from './runtime.js';

import type { CliCommand } from '../shared/cli-command.js';

type CommandLike = CliCommand;

interface MigrationGraph {
  db: { getSchemaVersion: () => { version?: number | string | null } | null | undefined };
  close: () => void;
}

export interface AdminMigrateCommandDeps {
  adminCmd: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  isInitialized: (projectPath: string) => boolean;
  loadCartograph: () => Promise<{
    default: {
      open: (projectPath: string, opts?: { autoMigrate?: boolean }) => Promise<MigrationGraph>;
    };
  }>;
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
}

export function registerAdminMigrateCommand(deps: AdminMigrateCommandDeps): void {
  const { adminCmd, error, info, isInitialized, loadCartograph, resolveProjectPath, success } = deps;
  adminCmd
    .command('migrate [path]')
    .description(
      'Apply forward schema migrations on the project DB (mirrors cartograph_admin MCP tool with action=\'migrate\'). Use after a read-style command fails with "Database schema vN is behind".',
    )
    .action(async (pathArg: string | undefined) => {
      const projectPath = resolveProjectPath(pathArg);
      let cg: MigrationGraph | undefined;
      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          process.exit(1);
        }
        const { default: Cartograph } = await loadCartograph();
        // Two-phase open lets us distinguish "already current" from
        // "migrated this run" without a separate version probe: the
        // default open() throws when the DB is behind, so success means
        // already-current. On the throw we re-open with autoMigrate=true
        // to actually run the migrations.
        let migratedThisRun = false;
        try {
          cg = await Cartograph.open(projectPath);
        } catch {
          cg = await Cartograph.open(projectPath, { autoMigrate: true });
          migratedThisRun = true;
        }
        const version = cg.db.getSchemaVersion()?.version;
        const outcome: MigrationOutcome = { migratedThisRun };
        if (version !== undefined) outcome.version = version;
        success(migrationSuccessMessage(outcome));
        if (migratedThisRun) {
          info(
            'Restart any MCP server still bound to the old schema (its tools will return "stale code, restart" until you do).',
          );
        }
      } catch (err) {
        error(`Failed to migrate: ${errMsg(err)}`);
        process.exit(1);
      } finally {
        cg?.close();
      }
    });
}
