import type { CliOptionCommand } from '../shared/cli-command.js';
import {
  completeWords,
  completionShellList,
  parseCompletionShell,
  renderCompletionScript,
  type CompletionCommandLike,
} from './runtime.js';

export type CompletionCliCommand = CliOptionCommand &
  CompletionCommandLike & {
    command(name: string, opts?: { hidden?: boolean }): CompletionCliCommand;
    allowUnknownOption?(allowUnknown?: boolean): CompletionCliCommand;
    alias?(value: string): CompletionCliCommand;
  };

export interface CompletionsCommandDeps {
  program: CompletionCliCommand;
  error: (message: string) => void;
  writeStdout: (message?: string) => void;
}

export function registerCompletionsCommand(deps: CompletionsCommandDeps): void {
  const visible = deps.program
    .command('completions <shell>')
    .description('Print shell completion setup for bash, zsh, fish, or PowerShell') as CompletionCliCommand;

  visible.alias?.('completion');
  visible.action((shellValue: string) => {
    const shell = parseCompletionShell(shellValue);
    if (!shell) {
      deps.error(`Unsupported completion shell "${shellValue}". Expected one of: ${completionShellList()}.`);
      process.exitCode = 1;
      return;
    }
    deps.writeStdout(renderCompletionScript(shell));
  });

  const helper = deps.program
    .command('__complete [words...]', { hidden: true })
    .description('Internal shell completion helper') as CompletionCliCommand;
  helper.allowUnknownOption?.();
  helper.action((words: string[] | undefined) => {
    deps.writeStdout(completeWords(deps.program, words ?? []).join('\n'));
  });
}
