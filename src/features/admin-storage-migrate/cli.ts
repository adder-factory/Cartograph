import { databaseConfigFromOptionInput, type DatabaseConfig, resolveDatabaseConfig } from '../../db/database-config.js';
import { errMsg } from '../../errors.js';
import {
  migratePostgresProjectToSqlite as defaultMigratePostgresProjectToSqlite,
  migrateSqliteProjectToPostgres as defaultMigrateSqliteProjectToPostgres,
  storageMigrationSuccessMessage,
} from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface AdminStorageMigrateCommandDeps {
  adminCmd: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
  migratePostgresProjectToSqlite?: typeof defaultMigratePostgresProjectToSqlite;
  migrateSqliteProjectToPostgres?: typeof defaultMigrateSqliteProjectToPostgres;
}

interface StorageMigrateCommandOptions {
  databaseProvider?: string;
  databaseUrl?: string;
  databaseSchema?: string;
  databasePgvector?: string;
  databaseMaxConnections?: string;
  databaseQueryTimeoutMs?: string;
  databaseConnectionTimeoutSeconds?: string;
  databaseSsl?: boolean;
  force?: boolean;
}

export function registerAdminStorageMigrateCommand(deps: AdminStorageMigrateCommandDeps): void {
  const {
    adminCmd,
    error,
    info,
    migratePostgresProjectToSqlite = defaultMigratePostgresProjectToSqlite,
    migrateSqliteProjectToPostgres = defaultMigrateSqliteProjectToPostgres,
    resolveProjectPath,
    success,
  } = deps;
  adminCmd
    .command('storage-migrate [path]')
    .description(
      'Migrate Cartograph storage between SQLite and PostgreSQL. PostgreSQL targets require a fresh schema unless --force is passed.',
    )
    .option('--database-provider <provider>', 'Target storage backend: postgres (default) or sqlite')
    .option(
      '--database-url <url>',
      'PostgreSQL connection URL; required unless CARTOGRAPH_DATABASE_URL / DATABASE_URL is set',
    )
    .option('--database-schema <schema>', 'PostgreSQL schema name (default: auto-derived per-project schema)')
    .option('--database-pgvector <mode>', 'PostgreSQL pgvector mode for the target: auto (default), off, or require')
    .option('--database-max-connections <n>', 'PostgreSQL pool cap for the target connection (default: 1)')
    .option('--database-query-timeout-ms <ms>', 'PostgreSQL query timeout in milliseconds (default: 120000)')
    .option('--database-connection-timeout-seconds <seconds>', 'PostgreSQL connection timeout in seconds (default: 30)')
    .option('--database-ssl', 'Force TLS for PostgreSQL connections (URL sslmode= is preferred for verification modes)')
    .option('--force', 'Drop the target PostgreSQL schema before migrating')
    .action(async (pathArg: string | undefined, options: StorageMigrateCommandOptions) => {
      const projectPath = resolveProjectPath(pathArg);
      let database: DatabaseConfig;
      try {
        const databaseInput = databaseConfigFromOptionInput({
          databaseProvider: options.databaseProvider ?? 'postgres',
          databaseUrl: options.databaseUrl,
          databaseSchema: options.databaseSchema,
          databasePgvector: options.databasePgvector,
          databaseMaxConnections: options.databaseMaxConnections,
          databaseQueryTimeoutMs: options.databaseQueryTimeoutMs,
          databaseConnectionTimeoutSeconds: options.databaseConnectionTimeoutSeconds,
          databaseSsl: options.databaseSsl,
        });
        if (!databaseInput) throw new Error('PostgreSQL database URL is required.');
        database = resolveDatabaseConfig(databaseInput);
      } catch (err) {
        error(errMsg(err));
        process.exitCode = 1;
        return;
      }
      const result =
        database.provider === 'sqlite'
          ? migratePostgresProjectToSqlite({ projectPath })
          : migrateSqliteProjectToPostgres({
              projectPath,
              database,
              force: options.force === true,
            });
      const resolvedResult = await Promise.resolve(result);
      if (!resolvedResult.ok) {
        const remediation = resolvedResult.error.remediation ? ` ${resolvedResult.error.remediation}` : '';
        error(`${resolvedResult.error.message}${remediation}`);
        process.exitCode = resolvedResult.exitCode;
        return;
      }
      success(storageMigrationSuccessMessage(resolvedResult.summary));
      info(`Updated config: ${resolvedResult.summary.configPath}`);
      info(`Restart any MCP server still attached to the old ${resolvedResult.summary.sourceProvider} database.`);
    });
}
