import { runSetup, type RunSetupOptions, type SetupRuntimeDeps } from './runtime.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

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
    .description('One-shot bootstrap: admin init + install-models + doctor. Each step skips when already satisfied.')
    .option('--minimal', 'Install only the smallest viable model subset (embed + 3B chat) instead of the full set.')
    .option('--no-models', 'Skip the install-models step (use when models are already present).')
    .action(async (pathArg: string | undefined, options: { minimal?: boolean; models?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      const setupOptions: RunSetupOptions = { projectPath };
      if (options.minimal === true) setupOptions.minimal = true;
      if (options.models !== undefined) setupOptions.models = options.models;
      const result = await runSetup(setupOptions, {
        ...deps,
        writeProgress: deps.writeProgress ?? ((message: string) => process.stderr.write(message)),
      });
      writeStdout('\n' + result.doctorReport);
      if (result.doctor.overallStatus === 'fail') process.exit(1);
    });
}
