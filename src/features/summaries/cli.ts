import type { Command } from 'commander';
import {
  buildPendingSummariesArgs,
  buildSaveSummariesArgs,
  readSummariesSaveInput,
  type SummariesArgResult,
} from './runtime.js';
import { runMcpToolFamilyCall } from '../shared/mcp-call.js';

interface AssignIntArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

export interface SummariesCommandDeps {
  summariesCmd: Command;
  installFamilyActionAlias: (group: Command, family: string, disc: string) => void;
  attachUnknownActionHandler: (group: Command, family: string) => void;
  assignIntArg: (input: AssignIntArgInput) => boolean;
  error: (message: string) => void;
  runViaMCP: (toolName: string, args: Record<string, unknown>, projectPath?: string) => Promise<void>;
  readFile: (filePath: string) => string;
  readStdin: () => Promise<string>;
}

function runSummariesCall(
  result: SummariesArgResult,
  projectPath: string | undefined,
  deps: SummariesCommandDeps,
): Promise<void> {
  return runMcpToolFamilyCall({ toolName: 'cartograph_summaries', result, projectPath, deps });
}

export function registerSummariesCommand(deps: SummariesCommandDeps): void {
  deps.installFamilyActionAlias(deps.summariesCmd, 'summaries', 'action');
  registerPendingCommand(deps);
  registerSaveCommand(deps);
  deps.attachUnknownActionHandler(deps.summariesCmd, 'summaries');
}

function registerPendingCommand(deps: SummariesCommandDeps): void {
  const { summariesCmd } = deps;
  summariesCmd
    .command('pending')
    .description(
      "Pull a batch of symbols needing summaries (agent-bridge; mirrors cartograph_summaries MCP tool with action='pending')",
    )
    .option('-p, --project-path <path>', 'Project path')
    .option('-l, --limit <n>', 'Batch size (default 20, max 40)', '20')
    .option('--model-hint <m>', 'Model label to record (default "agent-cli", matching the `summaries save` default)')
    .action(async (options: { projectPath?: string; limit?: string; modelHint?: string }) => {
      const parsed: Record<string, unknown> = {};
      if (
        !deps.assignIntArg({
          args: parsed,
          key: 'limit',
          raw: options.limit ?? '20',
          optionName: '--limit',
          opts: { min: 1, max: 40 },
        })
      )
        return;
      const limit = typeof parsed['limit'] === 'number' ? parsed['limit'] : undefined;
      await runSummariesCall(
        buildPendingSummariesArgs({
          ...(limit === undefined ? {} : { limit }),
          ...(options.modelHint ? { modelHint: options.modelHint } : {}),
        }),
        options.projectPath,
        deps,
      );
    });
}

function registerSaveCommand(deps: SummariesCommandDeps): void {
  const { summariesCmd } = deps;
  summariesCmd
    .command('save [json-file]')
    .description(
      "Persist agent-generated summaries from a JSON file or stdin (mirrors cartograph_summaries MCP tool with action='save')",
    )
    .option('-p, --project-path <path>', 'Project path')
    .option('--model <m>', 'Model label to record (default "agent-cli")')
    .action(async (jsonFile: string | undefined, options: { projectPath?: string; model?: string }) => {
      const input = await readSummariesSaveInput(jsonFile, deps);
      if (!input.ok) {
        deps.error(input.error);
        process.exitCode = 1;
        return;
      }
      await runSummariesCall(
        buildSaveSummariesArgs(input.raw, options.model ? { model: options.model } : {}),
        options.projectPath,
        deps,
      );
    });
}
