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

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

type ClackPrompts = typeof import('@clack/prompts');

interface EnrichmentGraph {
  close: () => void;
  llm: {
    config: { getEffectiveLlmConfig: () => Promise<unknown> };
    summarizeAll: (opts: {
      concurrency: number;
      eagerLimit?: number;
      onProgress?: (done: number, total: number) => void;
    }) => Promise<LlmSummarizeResult>;
    embed: {
      embedAll: (opts?: { concurrency?: number }) => Promise<LlmEmbedResult>;
    };
    classifyAll: (opts: { concurrency: number }) => Promise<LlmClassifyResult>;
  };
}

export interface AdminLlmEnrichmentCommandDeps {
  adminCmd: CommandLike;
  createShimmerProgress: () => { onProgress: any; stop: () => Promise<void> };
  error: (message: string) => void;
  formatDuration: (ms: number) => string;
  formatNumber: (n: number) => string;
  isInitialized: (projectPath: string) => boolean;
  loadCartograph: () => Promise<{
    default: {
      open: (projectPath: string, opts?: { autoMigrate?: boolean }) => Promise<EnrichmentGraph>;
    };
  }>;
  loadClack: () => Promise<ClackPrompts>;
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
): number {
  const parsed = parseConcurrencyOptionValue(raw, deps.parseConcurrency);
  if (!parsed.ok) {
    deps.error(parsed.error);
    process.exit(1);
  }
  return parsed.value ?? deps.parseConcurrency(undefined);
}

export function parseEagerLimit(
  options: SummarizeOptions,
  deps: Pick<AdminLlmEnrichmentCommandDeps, 'error'>,
  onInvalid?: () => void,
): number | undefined {
  const parsed = parseEagerLimitValue(options);
  if (!parsed.ok) {
    if (!options.quiet) deps.error(parsed.error);
    onInvalid?.();
    process.exit(1);
  }
  return parsed.value;
}

export function printSummarizeDetails(
  clack: ClackPrompts,
  result: LlmSummarizeResult,
  deps: Pick<AdminLlmEnrichmentCommandDeps, 'formatDuration' | 'formatNumber'>,
): void {
  printMessages(clack, summarizeDetailMessages(result, deps));
}

export function printSummarizeEmbedDetails(
  clack: ClackPrompts,
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
  const concurrency = parseConcurrencyOption(options.concurrency, deps);
  const eagerLimit = parseEagerLimit(options, deps);
  const eagerLimitOpt = eagerLimit === undefined ? {} : { eagerLimit };
  let cg: EnrichmentGraph | undefined;

  try {
    if (!isInitialized(projectPath)) {
      if (!options.quiet) error(`Cartograph not initialized in ${projectPath}`);
      process.exit(1);
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
      process.exit(1);
    }

    if (options.quiet) {
      await cg.llm.summarizeAll({ concurrency, ...eagerLimitOpt });
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
    process.exit(1);
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
    .action((pathArg: string | undefined, options: { quiet?: boolean; concurrency?: string }) =>
      runEmbedCommand({ pathArg, options, deps }),
    );
}

async function runEmbedCommand(args: {
  pathArg: string | undefined;
  options: { quiet?: boolean; concurrency?: string };
  deps: AdminLlmEnrichmentCommandDeps;
}): Promise<void> {
  const { pathArg, options, deps } = args;
  const { error, isInitialized, loadCartograph, resolveProjectPath } = deps;
  const projectPath = resolveProjectPath(pathArg);
  const concurrency = parseConcurrencyOption(options.concurrency, deps);
  let cg: EnrichmentGraph | undefined;

  try {
    if (!isInitialized(projectPath)) {
      if (!options.quiet) error(`Cartograph not initialized in ${projectPath}`);
      process.exit(1);
    }
    const { default: Cartograph } = await loadCartograph();
    // Write path (embed): opt in to auto-migration.
    cg = await Cartograph.open(projectPath, { autoMigrate: true });

    if (options.quiet) {
      await cg.llm.embed.embedAll({ concurrency });
      return;
    }

    const clack = await deps.loadClack();
    clack.intro('Embedding indexed symbols');
    const result = await cg.llm.embed.embedAll({ concurrency });
    clack.log.success(embedSuccessMessage(result, deps));
    clack.outro('Done');
  } catch (err) {
    cg?.close();
    cg = undefined;
    if (!options.quiet) error(`Failed to embed: ${errMsg(err)}`);
    process.exit(1);
  } finally {
    cg?.close();
  }
}

function registerClassifyCommand(deps: AdminLlmEnrichmentCommandDeps): void {
  const { adminCmd } = deps;
  adminCmd
    .command('classify [path]')
    .description('Assign roles via the LLM (cascade input: summary if present, else docstring; requires config.llm)')
    .option('-q, --quiet', 'Suppress output')
    .option('-c, --concurrency <n>', 'Concurrent LLM requests')
    .action((pathArg: string | undefined, options: { quiet?: boolean; concurrency?: string }) =>
      runClassifyCommand({ pathArg, options, deps }),
    );
}

async function runClassifyCommand(args: {
  pathArg: string | undefined;
  options: { quiet?: boolean; concurrency?: string };
  deps: AdminLlmEnrichmentCommandDeps;
}): Promise<void> {
  const { pathArg, options, deps } = args;
  const { error, isInitialized, loadCartograph, resolveProjectPath } = deps;
  const projectPath = resolveProjectPath(pathArg);
  const concurrency = parseConcurrencyOption(options.concurrency, deps);
  let cg: EnrichmentGraph | undefined;

  try {
    if (!isInitialized(projectPath)) {
      if (!options.quiet) error(`Cartograph not initialized in ${projectPath}`);
      process.exit(1);
    }
    const { default: Cartograph } = await loadCartograph();
    // Write path (classify): opt in to auto-migration.
    cg = await Cartograph.open(projectPath, { autoMigrate: true });

    if (options.quiet) {
      await cg.llm.classifyAll({ concurrency });
      return;
    }

    const clack = await deps.loadClack();
    clack.intro('Classifying symbol roles');
    const result = await cg.llm.classifyAll({ concurrency });
    printMessages(clack, classifySuccessMessages(result, deps));
    clack.outro('Done');
  } catch (err) {
    cg?.close();
    cg = undefined;
    if (!options.quiet) error(`Failed to classify: ${errMsg(err)}`);
    process.exit(1);
  } finally {
    cg?.close();
  }
}
