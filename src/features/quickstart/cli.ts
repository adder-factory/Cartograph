import { errMsg } from '../../errors.js';
import { renderQuickstartReport, runQuickstart, type QuickstartRuntimeDeps } from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface QuickstartCommandDeps extends QuickstartRuntimeDeps {
  program: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  error: (message: string) => void;
  writeStdout: (message?: string) => void;
}

export function registerQuickstartCommand(deps: QuickstartCommandDeps): void {
  const command = deps.program.command('index [path]');
  command.alias?.('quickstart');
  command
    .description('Initialize and index the project, then run a readiness check (no model downloads)')
    .action(async (pathArg: string | undefined) => {
      // The pre-rename name keeps working; nudge toward the new one.
      if (process.argv[2] === 'quickstart') {
        deps.info('note: `cartograph quickstart` is now `cartograph index`; the old name keeps working.');
      }
      const projectPath = deps.resolveProjectPath(pathArg);
      try {
        const result = await runQuickstart({ projectPath }, deps);
        deps.writeStdout(renderQuickstartReport(result));
        if (!result.index.success) {
          process.exitCode = 1;
          return;
        }
      } catch (err) {
        deps.error(errMsg(err));
        process.exitCode = 1;
      }
    });
}
