import { errMsg } from '../../errors.js';
import {
  classifySuccessMessages,
  embedSuccessMessage,
  parseConcurrencyOptionValue,
  parseEagerLimitValue,
  printMessages,
  summarizeDetailMessages,
  summarizeEmbedDetailMessages,
  type LlmClassifyResult,
  type LlmEmbedResult,
  type LlmSummarizeResult,
  type SummarizeOptions,
} from './runtime.js';
import { chatOverrideFromOptions } from '../shared/cli-args.js';
import type { CliOptionCommand } from '../shared/cli-command.js';
import type { ClackUi, LoadClackUi } from '../shared/clack-ui.js';
import type { IndexProgress } from '../../index.js';

type CommandLike = CliOptionCommand;

interface EnrichmentGraph {
  close: () => void;
  llm: {
    config: { getEffectiveLlmConfig: () => Promise<unknown> };
    summarizeAll: (opts: {
      concurrency: number;
      eagerLimit?: number;
      onProgress?: (done: number, total: number) => void;
      chatOverride?: { model?: string; endpoint?: string };
    }) => Promise<LlmSummarizeResult>;
    embed: {
      embedAll: (opts?: { concurrency?: number }) => Promise<LlmEmbedResult>;
    };
    classifyAll: (opts: { concurrency: number }) => Promise<LlmClassifyResult>;
  };
}

interface EnrichmentCommandOptions {
  quiet?: boolean;
  concurrency?: string;
}

interface OpenedEnrichmentGraphContext {
  cg: EnrichmentGraph;
  concurrency: number;
}

type CliParseResult<T> = { ok: true; value: T } | { ok: false };

interface RunOpenedEnrichmentGraphArgs {
  pathArg: string | undefined;
  options: EnrichmentCommandOptions;
  deps: AdminLlmEnrichmentCommandDeps;
  failureVerb: string;
  action: (ctx: OpenedEnrichmentGraphContext) => Promise<void>;
}

export interface AdminLlmEnrichmentCommandDeps {
  adminCmd: CommandLike;
  createShimmerProgress: () => { onProgress: (progress: IndexProgress) => void; stop: () => Promise<void> };
  error: (message: string) => void;
  formatDuration: (ms: number) => string;
  formatNumber: (n: number) => string;
  isInitialized: (projectPath: string) => boolean;
  loadCartograph: () => Promise<{
    default: {
      open: (projectPath: string, opts?: { autoMigrate?: boolean }) => Promise<EnrichmentGraph>;
    };
  }>;
  loadClack: LoadClackUi;
  parseConcurrency: (raw: string | undefined) => number;
  resolveProjectPath: (pathArg?: string) => string;
}

export function registerAdminLlmEnrichmentCommands(deps: AdminLlmEnrichmentCommandDeps): void {
  registerSummarizeCommand(deps);
  registerEmbedCommand(deps);
  registerClassifyCommand(deps);
}

export function parseConcurrencyOption(
  raw: string | undefined,
  deps: Pick<AdminLlmEnrichmentCommandDeps, 'error' | 'parseConcurrency'>,
): CliParseResult<number> {
  const parsed = parseConcurrencyOptionValue(raw, deps.parseConcurrency);
  if (!parsed.ok) {
    deps.error(parsed.error);
    process.exitCode = 1;
    return { ok: false };
  }
  return { ok: true, value: parsed.value ?? deps.parseConcurrency(undefined) };
}

export function parseEagerLimit(
  options: SummarizeOptions,
  deps: Pick<AdminLlmEnrichmentCommandDeps, 'error'>,
  onInvalid?: () => void,
): CliParseResult<number | undefined> {
  const parsed = parseEagerLimitValue(options);
  if (!parsed.ok) {
    if (!options.quiet) deps.error(parsed.error);
    onInvalid?.();
    process.exitCode = 1;
    return { ok: false };
  }
  return { ok: true, value: parsed.value };
}

export function printSummarizeDetails(
  clack: ClackUi,
  result: LlmSummarizeResult,
  deps: Pick<AdminLlmEnrichmentCommandDeps, 'formatDuration' | 'formatNumber'>,
): void {
  printMessages(clack, summarizeDetailMessages(result, deps));
}

export function printSummarizeEmbedDetails(
  clack: ClackUi,
  embed: LlmEmbedResult | null | undefined,
  deps: Pick<AdminLlmEnrichmentCommandDeps, 'formatDuration' | 'formatNumber'>,
): void {
  printMessages(clack, summarizeEmbedDetailMessages(embed, deps));
}

function registerSummarizeCommand(deps: AdminLlmEnrichmentCommandDeps): void {
  const { adminCmd } = deps;
  adminCmd
    .command('summarize [path]')
    .description('Generate one-line LLM summaries for indexed symbols (requires config.llm)')
    .option('-q, --quiet', 'Suppress output')
    .option('-c, --concurrency <n>', 'Concurrent LLM requests')
    .option(
      '--limit <n>',
      'Cap eager summary generations this pass; the importance-ordered tail defers to on-demand summarisation. `0` = ad-hoc only (summarise nothing eagerly). Overrides config.llm.summarizeEagerLimit',
    )
    .option(
      '--all',
      'Summarize every eligible symbol — uncapped full pass (overrides config.llm.summarizeEagerLimit and --limit)',
    )
    .option(
      '--model <path>',
      'Override the summarizeLlm model for THIS pass only (A/B test without editing config or restarting the backend). Summaries cache under this model id.',
    )
    .option(
      '--endpoint <url>',
      'Override the summarizeLlm endpoint for THIS pass only (implies an openai-compat HTTP backend at the given base URL).',
    )
    .action((pathArg: string | undefined, options: SummarizeOptions) =>
      runSummarizeCommand({ pathArg, options, deps }),
    );
}

async function runSummarizeCommand(args: {
  pathArg: string | undefined;
  options: SummarizeOptions;
  deps: AdminLlmEnrichmentCommandDeps;
}): Promise<void> {
  const { pathArg, options, deps } = args;
  const { error, isInitialized, loadCartograph, resolveProjectPath } = deps;
  const projectPath = resolveProjectPath(pathArg);
  const parsedConcurrency = parseConcurrencyOption(options.concurrency, deps);
  if (!parsedConcurrency.ok) return;
  const parsedEagerLimit = parseEagerLimit(options, deps);
  if (!parsedEagerLimit.ok) return;
  const concurrency = parsedConcurrency.value;
  const eagerLimit = parsedEagerLimit.value;
  const eagerLimitOpt = eagerLimit === undefined ? {} : { eagerLimit };
  const chatOverride = chatOverrideFromOptions(options);
  const chatOverrideOpt = chatOverride === undefined ? {} : { chatOverride };
  let cg: EnrichmentGraph | undefined;

  try {
    if (!isInitialized(projectPath)) {
      if (!options.quiet) error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }
    const { default: Cartograph } = await loadCartograph();
    // Write path (summarize): opt in to auto-migration.
    cg = await Cartograph.open(projectPath, { autoMigrate: true });

    const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
    if (!llmConfig) {
      if (!options.quiet) {
        error(
          'No LLM available. Add config.llm to .cartograph/config.json (run `cartograph admin install-models --write-config` for the recommended stack — llama-server HTTP for every tier — or set provider: "anthropic-api" for Claude).',
        );
      }
      cg.close();
      cg = undefined;
      process.exitCode = 1;
      return;
    }

    if (options.quiet) {
      await cg.llm.summarizeAll({ concurrency, ...eagerLimitOpt, ...chatOverrideOpt });
      return;
    }

    const clack = await deps.loadClack();
    clack.intro('Summarising indexed symbols');

    const progress = deps.createShimmerProgress();
    progress.onProgress({ phase: 'parsing', current: 0, total: 0 });

    let result: LlmSummarizeResult;
    try {
      result = await cg.llm.summarizeAll({
        concurrency,
        ...eagerLimitOpt,
        ...chatOverrideOpt,
        onProgress: (done: number, total: number) => {
          progress.onProgress({ phase: 'parsing', current: done, total });
        },
      });
    } finally {
      await progress.stop();
    }

    printSummarizeDetails(clack, result, deps);

    clack.outro('Done');
  } catch (err) {
    cg?.close();
    cg = undefined;
    if (!options.quiet) error(`Failed to summarise: ${errMsg(err)}`);
    process.exitCode = 1;
    return;
  } finally {
    cg?.close();
  }
}

async function runOpenedEnrichmentGraph(args: RunOpenedEnrichmentGraphArgs): Promise<void> {
  const { pathArg, options, deps, failureVerb, action } = args;
  const { error, isInitialized, loadCartograph, resolveProjectPath } = deps;
  const projectPath = resolveProjectPath(pathArg);
  const parsedConcurrency = parseConcurrencyOption(options.concurrency, deps);
  if (!parsedConcurrency.ok) return;
  const concurrency = parsedConcurrency.value;
  let cg: EnrichmentGraph | undefined;

  try {
    if (!isInitialized(projectPath)) {
      if (!options.quiet) error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }
    const { default: Cartograph } = await loadCartograph();
    cg = await Cartograph.open(projectPath, { autoMigrate: true });
    await action({ cg, concurrency });
  } catch (err) {
    cg?.close();
    cg = undefined;
    if (!options.quiet) error(`Failed to ${failureVerb}: ${errMsg(err)}`);
    process.exitCode = 1;
    return;
  } finally {
    cg?.close();
  }
}

function registerEmbedCommand(deps: AdminLlmEnrichmentCommandDeps): void {
  const { adminCmd } = deps;
  adminCmd
    .command('embed [path]')
    .description('Generate embeddings for every indexed symbol (requires embedding provider)')
    .option('-q, --quiet', 'Suppress output')
    .option('-c, --concurrency <n>', 'Concurrent embedding requests')
    .action((pathArg: string | undefined, options: EnrichmentCommandOptions) =>
      runEmbedCommand({ pathArg, options, deps }),
    );
}

async function runEmbedCommand(args: {
  pathArg: string | undefined;
  options: EnrichmentCommandOptions;
  deps: AdminLlmEnrichmentCommandDeps;
}): Promise<void> {
  await runOpenedEnrichmentGraph({
    ...args,
    failureVerb: 'embed',
    action: async ({ cg, concurrency }) => {
      if (args.options.quiet) {
        await cg.llm.embed.embedAll({ concurrency });
        return;
      }
      const clack = await args.deps.loadClack();
      clack.intro('Embedding indexed symbols');
      const result = await cg.llm.embed.embedAll({ concurrency });
      clack.log.success(embedSuccessMessage(result, args.deps));
      clack.outro('Done');
    },
  });
}

function registerClassifyCommand(deps: AdminLlmEnrichmentCommandDeps): void {
  const { adminCmd } = deps;
  adminCmd
    .command('classify [path]')
    .description('Assign roles via the LLM (cascade input: summary if present, else docstring; requires config.llm)')
    .option('-q, --quiet', 'Suppress output')
    .option('-c, --concurrency <n>', 'Concurrent LLM requests')
    .action((pathArg: string | undefined, options: EnrichmentCommandOptions) =>
      runClassifyCommand({ pathArg, options, deps }),
    );
}

async function runClassifyCommand(args: {
  pathArg: string | undefined;
  options: EnrichmentCommandOptions;
  deps: AdminLlmEnrichmentCommandDeps;
}): Promise<void> {
  await runOpenedEnrichmentGraph({
    ...args,
    failureVerb: 'classify',
    action: async ({ cg, concurrency }) => {
      if (args.options.quiet) {
        await cg.llm.classifyAll({ concurrency });
        return;
      }
      const clack = await args.deps.loadClack();
      clack.intro('Classifying symbol roles');
      const result = await cg.llm.classifyAll({ concurrency });
      printMessages(clack, classifySuccessMessages(result, args.deps));
      clack.outro('Done');
    },
  });
}
