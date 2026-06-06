import { buildDigestMcpArgs, type DigestOptions } from './runtime.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

export interface DigestCommandDeps {
  program: CommandLike;
  runViaMCP: (toolName: string, args: Record<string, never>, projectPath?: string) => Promise<void>;
}

export function registerDigestCommand(deps: DigestCommandDeps): void {
  deps.program
    .command('digest')
    .description(
      '"Land in a new repo" overview — hotspots, code health, entry points, recent churn, suggested next queries (mirrors cartograph_digest MCP tool)',
    )
    .option('-p, --project-path <path>', 'Project path')
    .action(async (options: DigestOptions) => {
      await deps.runViaMCP('cartograph_digest', buildDigestMcpArgs(), options.projectPath);
    });
}
