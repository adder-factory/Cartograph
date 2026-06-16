import { isHnswAvailable } from '../../embeddings/hnsw-index.js';
import { errMsg } from '../../errors.js';
import {
  buildStatusRollupConfig,
  createStatusPrinter,
  loadStatusChangeInfo,
  type StatusOptions,
  type StatusPrinterDeps,
  STATUS_MAX_INLINE_TOP_N,
} from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';
import type Cartograph from '../../index.js';

type CommandLike = CliOptionCommand;

interface StatusCartographModule {
  default: {
    open: (projectPath: string) => Promise<Cartograph>;
  };
}

export interface StatusCommandDeps extends StatusPrinterDeps {
  program: CommandLike;
  error: (message: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  loadCartograph: () => Promise<StatusCartographModule>;
  isInitialized: (projectPath: string) => boolean;
  isHnswAvailable?: () => Promise<boolean>;
}

export function registerStatusCommand(deps: StatusCommandDeps): void {
  deps.program
    .command('status [path]')
    .description('Show index status and statistics')
    .option('-j, --json', 'Output as JSON')
    .option(
      '--verbose',
      'One-call onboarding view — enable all three composite rollups at sensible defaults (--top-hotspots 5, --top-biomarkers 5, --summary-breakdown). Mirrors cartograph_status `verbose`.',
    )
    .option(
      '--top-hotspots <n>',
      `Inline the top-N hotspots (risk = centrality × churn). Default 0 (suppressed). Negative / non-numeric → suppressed; values ≥ 1 capped at ${STATUS_MAX_INLINE_TOP_N}. Mirrors cartograph_status \`topHotspots\`.`,
    )
    .option(
      '--top-biomarkers <n>',
      `Inline the top-N biomarker findings (warning+ severity, worst-first). Default 0 (suppressed). Negative / non-numeric → suppressed; values ≥ 1 capped at ${STATUS_MAX_INLINE_TOP_N}. Mirrors cartograph_status \`topBiomarkers\`.`,
    )
    .option(
      '--summary-breakdown',
      'Expand the Summaries readiness line into per-phase counts (structural / neighbor-prop / llm + body-floor skips). Mirrors cartograph_status `summaryBreakdown`.',
    )
    .action(async (pathArg: string | undefined, options: StatusOptions) => {
      await handleStatusCommand({ deps, pathArg, options });
    });
}

interface HandleStatusCommandArgs {
  deps: StatusCommandDeps;
  pathArg: string | undefined;
  options: StatusOptions;
}

export async function handleStatusCommand({ deps, pathArg, options }: HandleStatusCommandArgs): Promise<void> {
  const printer = createStatusPrinter(deps);
  const projectPath = deps.resolveProjectPath(pathArg);

  try {
    if (!deps.isInitialized(projectPath)) {
      printer.printUninitializedStatus(projectPath, options);
      return;
    }

    const rollups = await buildStatusRollupConfig(options);
    const { default: Cartograph } = await deps.loadCartograph();
    const cg = await Cartograph.open(projectPath);
    try {
      const stats = cg.stats.getStats();
      const { changes, healOnly, realModifiedCount } = await loadStatusChangeInfo(cg);
      const hnswAvailable = await (deps.isHnswAvailable ?? isHnswAvailable)();

      if (options.json) {
        printer.printStatusJson({
          cg,
          projectPath,
          stats,
          changes,
          healOnly,
          realModifiedCount,
          hnswAvailable,
          rollups,
        });
        return;
      }

      printer.printStatusHeader(projectPath);
      printer.printStatusIndexStats(stats, cg, hnswAvailable);
      printer.printCountBreakdown('Nodes by Kind:', stats.nodesByKind);
      printer.printCountBreakdown('Files by Language:', stats.filesByLanguage);
      await printer.printParseCacheStatus(cg);
      printer.printPendingChanges(changes, realModifiedCount, healOnly);
      await printer.printLlmStatus(cg, projectPath);
      printer.printStatusRollups(cg, rollups);
    } finally {
      cg.close();
    }
  } catch (err) {
    deps.error(`Failed to get status: ${errMsg(err)}`);
    process.exitCode = 1;
  }
}
