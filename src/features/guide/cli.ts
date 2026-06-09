import { renderGuide } from './runtime.js';
import type { CliCommand } from '../shared/cli-command.js';

type CommandLike = CliCommand;

export interface GuideCommandDeps {
  program: CommandLike;
  writeStdout: (message?: string) => void;
}

export function registerGuideCommand(deps: GuideCommandDeps): void {
  deps.program
    .command('guide')
    .description('Print a compact first-use and daily-workflow guide')
    .action(() => deps.writeStdout(renderGuide()));
}
