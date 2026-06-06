import { errMsg } from '../../errors.js';
import {
  finalDoctorStatus,
  resolveSkipProjectChecks,
  type AdminDoctorOptions,
  type AdminDoctorResult,
} from './runtime.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

export interface AdminDoctorCommandDeps {
  adminCmd: CommandLike;
  loadDoctor: () => Promise<{
    runDoctor: (opts: Record<string, unknown>) => Promise<AdminDoctorResult>;
    formatDoctorReport: (result: unknown) => string;
    formatDoctorJson: (result: unknown) => string;
  }>;
  resolveProjectPath: (pathArg?: string) => string;
  writeStdout: (message: string) => void;
  error: (message: string) => void;
}

export function registerAdminDoctorCommand(deps: AdminDoctorCommandDeps): void {
  const { adminCmd, error, loadDoctor, resolveProjectPath, writeStdout } = deps;
  adminCmd
    .command('doctor [path]')
    .description("Diagnose install state (mirrors cartograph_admin MCP tool with action='doctor')")
    .option('--fix', 'Auto-apply fixable remediations')
    .option('--no-project-checks', 'Skip project init/config checks')
    .option('--skip-project-checks', 'Skip project init/config checks')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: AdminDoctorOptions & { fix?: boolean; json?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      try {
        const { runDoctor, formatDoctorReport, formatDoctorJson } = await loadDoctor();
        const result = await runDoctor({
          projectPath,
          fix: options.fix === true,
          skipProjectChecks: resolveSkipProjectChecks(options),
        });
        writeStdout(`${options.json ? formatDoctorJson(result) : formatDoctorReport(result)}\n`);
        if (finalDoctorStatus(result) === 'fail') process.exit(1);
      } catch (err) {
        error(`doctor failed: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}
