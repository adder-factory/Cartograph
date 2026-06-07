import type { formatLlmSmokeJson, formatLlmSmokeReport, LlmSmokeResult, RunLlmSmokeOptions } from './runtime.js';
import { parseOptionalPositiveInt } from '../shared/cli-args.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface LlmSmokeRuntimeModule {
  runLlmSmoke: (opts: RunLlmSmokeOptions) => Promise<LlmSmokeResult>;
  formatLlmSmokeReport: typeof formatLlmSmokeReport;
  formatLlmSmokeJson: typeof formatLlmSmokeJson;
}

export interface LlmSmokeCommandDeps {
  llmCmd: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  error: (message: string) => void;
  writeStdout: (message?: string) => void;
  loadLlmSmoke: () => Promise<LlmSmokeRuntimeModule>;
}

export function registerLlmSmokeCommand(deps: LlmSmokeCommandDeps): void {
  const { llmCmd, loadLlmSmoke, resolveProjectPath, writeStdout, error } = deps;
  llmCmd
    .command('smoke [path]')
    .description('Send tiny real requests to configured LLM tiers (embedding, summarize, ask/local, rerank)')
    .option('--timeout-ms <n>', 'Per-tier smoke timeout in milliseconds (default 60000)')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { timeoutMs?: string; json?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      const timeoutMs = parseOptionalPositiveInt(options.timeoutMs, '--timeout-ms', error);
      if (timeoutMs === null) return;
      const { runLlmSmoke, formatLlmSmokeReport, formatLlmSmokeJson } = await loadLlmSmoke();
      const result = await runLlmSmoke({ projectPath, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      writeStdout(options.json ? formatLlmSmokeJson(result) : formatLlmSmokeReport(result));
      if (result.overallStatus === 'fail') process.exit(1);
    });
}
