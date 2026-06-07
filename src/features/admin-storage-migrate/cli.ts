import { databaseConfigFromOptionInput, type DatabaseConfig, resolveDatabaseConfig } from '../../db/database-config.js';
import { errMsg } from '../../errors.js';
import { migrateSqliteProjectToPostgres, storageMigrationSuccessMessage } from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface AdminStorageMigrateCommandDeps {
  adminCmd: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
}

interface StorageMigrateCommandOptions {
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
  const { adminCmd, error, info, resolveProjectPath, success } = deps;
  adminCmd
    .command('storage-migrate [path]')
    .description(
      'Migrate a SQLite-backed Cartograph project to PostgreSQL storage. Requires a fresh PostgreSQL schema unless --force is passed.',
    )
    .option(
      '--database-url <url>',
      'PostgreSQL connection URL; required unless CARTOGRAPH_DATABASE_URL / DATABASE_URL is set',
    )
    .option('--database-schema <schema>', 'PostgreSQL schema name (default: public)')
    .option('--database-pgvector <mode>', 'PostgreSQL pgvector mode for the target: auto (default), off, or require')
    .option('--database-max-connections <n>', 'PostgreSQL pool cap for the target connection (default: 1)')
    .option('--database-query-timeout-ms <ms>', 'PostgreSQL query timeout in milliseconds (default: 120000)')
    .option('--database-connection-timeout-seconds <seconds>', 'PostgreSQL connection timeout in seconds (default: 30)')
    .option('--database-ssl', 'Force TLS for PostgreSQL connections (URL sslmode= is preferred for verification modes)')
    .option('--force', 'Drop the target PostgreSQL schema before migrating')
    .action(async (pathArg: string | undefined, options: StorageMigrateCommandOptions) => {
      const projectPath = resolveProjectPath(pathArg);
      const databaseInput = databaseConfigFromOptionInput({
        databaseProvider: 'postgres',
        databaseUrl: options.databaseUrl,
        databaseSchema: options.databaseSchema,
        databasePgvector: options.databasePgvector,
        databaseMaxConnections: options.databaseMaxConnections,
        databaseQueryTimeoutMs: options.databaseQueryTimeoutMs,
        databaseConnectionTimeoutSeconds: options.databaseConnectionTimeoutSeconds,
        databaseSsl: options.databaseSsl,
      });
      if (!databaseInput) {
        error('PostgreSQL database URL is required.');
        process.exit(1);
      }
      let database: DatabaseConfig;
      try {
        database = resolveDatabaseConfig(databaseInput);
      } catch (err) {
        error(errMsg(err));
        process.exit(1);
      }
      const result = await migrateSqliteProjectToPostgres({
        projectPath,
        database,
        force: options.force === true,
      });
      if (!result.ok) {
        const remediation = result.error.remediation ? ` ${result.error.remediation}` : '';
        error(`${result.error.message}${remediation}`);
        process.exit(result.exitCode);
      }
      success(storageMigrationSuccessMessage(result.summary));
      info(`Updated config: ${result.summary.configPath}`);
      info('Restart any MCP server still attached to the old SQLite database.');
    });
}
