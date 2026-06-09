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
  deps.program
    .command('quickstart [path]')
    .description('Initialize and index the project without downloading models; LLM setup remains optional')
    .action(async (pathArg: string | undefined) => {
      const projectPath = deps.resolveProjectPath(pathArg);
      try {
        const result = await runQuickstart({ projectPath }, deps);
        deps.writeStdout(renderQuickstartReport(result));
        if (!result.index.success) process.exit(1);
      } catch (err) {
        deps.error(errMsg(err));
        process.exit(1);
      }
    });
}
