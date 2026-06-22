import type { CliCommand } from '../shared/cli-command.js';

type CommandLike = CliCommand;

interface PlaybookToolHandler {
  execute: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ text?: string }>;
    isError?: boolean;
  }>;
  closeAll: () => void;
}

export interface PlaybookCommandDeps {
  program: CommandLike;
  writeStdout: (message?: string) => void;
  loadToolHandler: () => Promise<{
    ToolHandler: new (cg: null) => PlaybookToolHandler;
  }>;
}

export function registerPlaybookCommand(deps: PlaybookCommandDeps): void {
  const { program, loadToolHandler, writeStdout } = deps;
  program
    .command('playbook')
    .description('Print the cartograph tool playbook (mirrors cartograph_playbook MCP tool)')
    .action(async () => {
      const { ToolHandler } = await loadToolHandler();
      const handler = new ToolHandler(null);
      try {
        const result = await handler.execute('cartograph_playbook', {});
        writeStdout(result.content[0]?.text ?? '');
        if (result.isError) process.exitCode = 1;
      } finally {
        handler.closeAll();
      }
    });
}
