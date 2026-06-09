import { runSetup, type RunSetupOptions, type SetupRuntimeDeps } from './runtime.js';
import { databaseConfigFromOptionInput } from '../../db/database-config.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface SetupCommandDeps extends Omit<SetupRuntimeDeps, 'writeProgress'> {
  program: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  writeStdout: (message?: string) => void;
  writeProgress?: (message: string) => void;
}

/**
 * cartograph setup [path]
 *
 * One-shot bootstrap for first-time users. Runs:
 *   1. admin init (if .cartograph/ missing)
 *   2. install-models (if no GGUFs present; honors --minimal — used
 *      with a llama-server pointing at the downloaded GGUFs)
 *   3. doctor (final verification — surfaces missing HTTP backend)
 *
 * Idempotent — each step skips when its precondition is already met,
 * so re-running setup on a partially-installed environment is safe.
 *
 * Pre-2026-05-24c this also ran an `install-shim` step for the
 * in-process libcgshim pathway; that pathway was deleted in step 4c
 * of the LLM HTTP migration. Setup now assumes the user runs
 * `llama-server` (or another OpenAI-compat backend) themselves — the
 * doctor step prints a remediation line with the exact command if
 * not detected.
 *
 * Direct implementation rather than runViaMCP because setup runs
 * BEFORE the MCP server is reachable.
 */
export function registerSetupCommand(deps: SetupCommandDeps): void {
  const { program, resolveProjectPath, writeStdout } = deps;
  program
    .command('setup [path]')
    .description(
      'LLM bootstrap: admin init + install-models + doctor. For no-download structural indexing, use `cartograph quickstart`.',
    )
    .option(
      '--minimal',
      'Recommended local quickstart: install only the smallest viable model subset (embed + 3B chat).',
    )
    .option('--no-models', 'Skip model downloads for Ollama, cloud, or already-managed backends.')
    .option('--database-provider <provider>', 'Storage backend: sqlite (default) or postgres')
    .option(
      '--database-url <url>',
      'PostgreSQL connection URL; required for provider=postgres unless CARTOGRAPH_DATABASE_URL / DATABASE_URL is set',
    )
    .option('--database-schema <schema>', 'PostgreSQL schema name (default: public)')
    .option('--database-pgvector <mode>', 'PostgreSQL pgvector mode: auto (default), off, or require')
    .option('--database-max-connections <n>', 'PostgreSQL pool cap (default: 1)')
    .option('--database-query-timeout-ms <ms>', 'PostgreSQL query timeout in milliseconds (default: 120000)')
    .option('--database-connection-timeout-seconds <seconds>', 'PostgreSQL connection timeout in seconds (default: 30)')
    .option('--database-ssl', 'Force TLS for PostgreSQL connections (URL sslmode= is preferred for verification modes)')
    .action(async (pathArg: string | undefined, options: SetupCommandOptions) => {
      const projectPath = resolveProjectPath(pathArg);
      const setupOptions: RunSetupOptions = { projectPath };
      if (options.minimal === true) setupOptions.minimal = true;
      if (options.models !== undefined) setupOptions.models = options.models;
      const database = databaseConfigFromOptionInput(options);
      if (database) setupOptions.database = database;
      const result = await runSetup(setupOptions, {
        ...deps,
        writeProgress: deps.writeProgress ?? ((message: string) => process.stderr.write(message)),
      });
      writeStdout('\n' + result.doctorReport);
      if (result.doctor.overallStatus === 'fail') process.exit(1);
    });
}

interface SetupCommandOptions {
  minimal?: boolean;
  models?: boolean;
  databaseProvider?: string;
  databaseUrl?: string;
  databaseSchema?: string;
  databasePgvector?: string;
  databaseMaxConnections?: string;
  databaseQueryTimeoutMs?: string;
  databaseConnectionTimeoutSeconds?: string;
  databaseSsl?: boolean;
}
