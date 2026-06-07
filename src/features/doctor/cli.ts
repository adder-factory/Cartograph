import {
  doctorRunOptions,
  finalDoctorStatus,
  type DoctorOptions,
  type DoctorResult,
  type DoctorRunOptions,
} from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface DoctorCommandDeps {
  program: CommandLike;
  loadDoctor: () => Promise<{
    runDoctor: (opts: DoctorRunOptions) => Promise<DoctorResult>;
    formatDoctorReport: (result: unknown) => string;
    formatDoctorJson: (result: unknown) => string;
  }>;
  writeStdout: (message?: string) => void;
}

export function registerDoctorCommand(deps: DoctorCommandDeps): void {
  const { program } = deps;
  program
    .command('doctor [path]')
    .description(
      'Diagnose install state (Bun, models, project init/config, detected LLM backends, embedding endpoint reachability) with actionable next steps. Pass `--fix` to auto-apply remediations.',
    )
    .option('--no-project-checks', 'Skip the project-init + config checks (useful for fresh-install verification).')
    .option('--skip-project-checks', 'Skip the project-init + config checks (alias of --no-project-checks).')
    .option(
      '--fix',
      'Auto-apply remediations for fixable gaps (creates `.cartograph/`, downloads models, writes a recommended LLM config). Re-runs checks after applying. Backend-not-running gaps remain manual.',
    )
    .option('--json', 'Print structured JSON instead of Markdown')
    .action((pathArg: string | undefined, options: DoctorOptions) => runDoctorCommand(pathArg, options, deps));
}

async function runDoctorCommand(
  pathArg: string | undefined,
  options: DoctorOptions,
  deps: DoctorCommandDeps,
): Promise<void> {
  const { runDoctor, formatDoctorReport, formatDoctorJson } = await deps.loadDoctor();
  const result = await runDoctor(doctorRunOptions(pathArg, options));
  deps.writeStdout(options.json ? formatDoctorJson(result) : formatDoctorReport(result));
  if (finalDoctorStatus(result) === 'fail') process.exit(1);
}
