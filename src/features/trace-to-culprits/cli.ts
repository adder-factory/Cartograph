import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

interface AssignNumericArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

interface TraceToCulpritsOptions {
  projectPath?: string;
  limit?: string;
  trace?: string;
}

export interface TraceToCulpritsCommandDeps {
  program: CommandLike;
  assignIntArg: (args: AssignNumericArgInput) => boolean;
  runViaMCP: (tool: string, args: Record<string, unknown>, projectPath?: string) => Promise<void>;
  writeStderr: (message?: string) => void;
  readStdin?: () => Promise<string>;
}

export function registerTraceToCulpritsCommand(deps: TraceToCulpritsCommandDeps): void {
  const { program, assignIntArg, runViaMCP, writeStderr } = deps;
  program
    .command('trace-to-culprits')
    .description(
      'Pipe a stack trace into cartograph and get a ranked list of likely fix-site candidates (mirrors cartograph_trace_to_culprits MCP tool). Reads the trace from stdin (or pass --trace).',
    )
    .option('-p, --project-path <path>', 'Project path')
    .option('-l, --limit <n>', 'Maximum culprits to return (default 10, max 50)')
    .option('-t, --trace <text>', 'Trace text inline (default: read from stdin)')
    .action(async (options: TraceToCulpritsOptions) => {
      const trace = options.trace ?? (await (deps.readStdin ?? readProcessStdin)());
      if (!trace.trim()) {
        writeStderr('No trace provided. Pipe a stack trace to stdin or pass --trace "<text>".');
        process.exitCode = 2;
        return;
      }
      const args: Record<string, unknown> = { trace };
      if (!assignIntArg({ args, key: 'limit', raw: options.limit, optionName: '--limit', opts: { min: 1 } })) return;
      await runViaMCP('cartograph_trace_to_culprits', args, options.projectPath);
    });
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
