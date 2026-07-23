/**
 * `cartograph review` family subcommands + the `similar` command —
 * feature-local CLI registration.
 */
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { errMsg } from '../../errors.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

interface AssignNumericArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

type AssignNumericArgFn = (args: AssignNumericArgInput) => boolean;
type RunViaMCPFn = (tool: string, args: Record<string, unknown>, projectPath?: string) => Promise<void>;

export interface ReviewCommandDeps {
  program: CommandLike;
  // The real commander Command — it is both the builder used below and
  // the value handed to installFamilyActionAlias / attachUnknownActionHandler,
  // whose internals read Command-only members (.commands, .on, ...).
  reviewCmd: Command;
  error: (message: string) => void;
  assignIntArg: AssignNumericArgFn;
  assignFloatArg: AssignNumericArgFn;
  runViaMCP: RunViaMCPFn;
  installFamilyActionAlias: (group: Command, family: string, disc: string) => void;
  attachUnknownActionHandler: (group: Command, family: string) => void;
}

interface ReviewContextOptions {
  projectPath?: string;
  diff?: string;
  maxCallersPerSymbol?: string;
  maxCalleesPerSymbol?: string;
  maxCoChangeWarnings?: string;
  minCoChangeJaccard?: string;
  minDiffMagnitude?: string;
}

function readStdinText(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function readReviewDiffInput(raw: string, error: (message: string) => void): Promise<string> {
  if (raw === '-') return readStdinText();
  if (raw.includes('\n') || raw.startsWith('@@') || raw.startsWith('diff --git')) return raw;
  try {
    return await readFile(raw, 'utf-8');
  } catch (readErr) {
    if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
      error(`review context: diff file not found: ${raw}`);
    } else {
      error(`review context: could not read diff file ${raw}: ${errMsg(readErr)}`);
    }
    process.exitCode = 1;
    return '';
  }
}

async function loadReviewContextDiff(
  diffFile: string | undefined,
  options: ReviewContextOptions,
  error: (message: string) => void,
): Promise<string | null> {
  if (diffFile && options.diff !== undefined) {
    error('review context: pass either [diff-file] or --diff, not both.');
    process.exitCode = 1;
    return null;
  }

  if (options.diff !== undefined) return loadExplicitReviewDiff(options.diff, '--diff input is empty.', error);
  if (!diffFile) return readStdinText();

  const diff = await readReviewDiffInput(diffFile, error);
  if (process.exitCode) return null;
  if (diff.trim().length > 0) return diff;

  error(`review context: diff file is empty: ${diffFile}`);
  process.exitCode = 1;
  return null;
}

async function loadExplicitReviewDiff(
  raw: string,
  emptyMessage: string,
  error: (message: string) => void,
): Promise<string | null> {
  const diff = await readReviewDiffInput(raw, error);
  if (process.exitCode) return null;
  if (diff.trim().length > 0) return diff;
  error(`review context: ${emptyMessage}`);
  process.exitCode = 1;
  return null;
}

function assignReviewContextArgs(
  args: Record<string, unknown>,
  options: ReviewContextOptions,
  deps: Pick<ReviewCommandDeps, 'assignIntArg' | 'assignFloatArg'>,
): boolean {
  const { assignIntArg, assignFloatArg } = deps;
  return (
    assignIntArg({
      args,
      key: 'maxCallersPerSymbol',
      raw: options.maxCallersPerSymbol,
      optionName: '--max-callers-per-symbol',
    }) &&
    assignIntArg({
      args,
      key: 'maxCalleesPerSymbol',
      raw: options.maxCalleesPerSymbol,
      optionName: '--max-callees-per-symbol',
    }) &&
    assignIntArg({
      args,
      key: 'maxCoChangeWarnings',
      raw: options.maxCoChangeWarnings,
      optionName: '--max-co-change-warnings',
    }) &&
    assignFloatArg({
      args,
      key: 'minCoChangeJaccard',
      raw: options.minCoChangeJaccard,
      optionName: '--min-co-change-jaccard',
    }) &&
    assignIntArg({
      args,
      key: 'minDiffMagnitude',
      raw: options.minDiffMagnitude,
      optionName: '--min-diff-magnitude',
    })
  );
}

/**
 * cartograph review <mode>
 *
 * Subcommands mirror the cartograph_review({mode}) MCP shape directly.
 * The earlier top-level forms (`review-context`, `review-neighbors`,
 * `risk-review`) collapsed into the unified family in 2026-05-10 to
 * match the MCP merge that landed earlier — same family pattern as
 * `admin <action>` and `summaries <action>`. Note the previous
 * `risk-review` top-level command had been calling the no-longer-
 * registered `cartograph_risk_review` MCP name; this fix routes
 * through the merged tool with `mode: 'risk'`.
 */
function registerReviewContextCommand(deps: ReviewCommandDeps): void {
  const { reviewCmd, error, runViaMCP } = deps;
  reviewCmd
    .command('context [diff-file]')
    .description("Diff-driven review context (mirrors cartograph_review({mode: 'context'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('--diff <pathOrText|->', 'Unified diff text, path, or - for stdin (MCP arg mirror)')
    .option('--max-callers-per-symbol <n>', 'Cap callers per symbol (default 5)')
    .option('--max-callees-per-symbol <n>', 'Cap callees per symbol (default 5)')
    .option('--max-co-change-warnings <n>', 'Cap co-change warnings per file (default 3, 0 disables)')
    .option('--min-co-change-jaccard <n>', 'Minimum Jaccard for a co-change warning (default 0.4)')
    .option(
      '--min-diff-magnitude <n>',
      'Suppress co-change warnings when total diff lines < n (default 10, 0 disables)',
    )
    .action(async (diffFile: string | undefined, options: ReviewContextOptions) => {
      const diff = await loadReviewContextDiff(diffFile, options, error);
      if (diff === null) return;
      const args: Record<string, unknown> = { mode: 'context', diff };
      if (!assignReviewContextArgs(args, options, deps)) return;
      await runViaMCP('cartograph_review', args, options.projectPath);
    });
}

interface ReviewNeighborsOptions {
  projectPath?: string;
  files?: string;
  symbols?: string;
  k?: string;
  dedupeByName?: boolean;
}

function parseCommaList(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function registerReviewNeighborsCommand(deps: ReviewCommandDeps): void {
  const { reviewCmd, error, assignIntArg, runViaMCP } = deps;
  reviewCmd
    .command('neighbors')
    .description("Semantic lookalikes for changed files/symbols (mirrors cartograph_review({mode: 'neighbors'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('--files <paths>', 'Comma-separated changed file paths')
    .option('--symbols <names>', 'Comma-separated changed symbol names')
    .option('-k, --k <n>', 'Top-K lookalikes to return (default 5, max 50)')
    .option('--no-dedupe-by-name', 'Allow duplicate-named neighbors in the result (default: dedupe on)')
    .action(async (options: ReviewNeighborsOptions) => {
      const files = parseCommaList(options.files);
      const symbols = parseCommaList(options.symbols);
      if (files.length === 0 && symbols.length === 0) {
        error('Pass at least one --files or --symbols (comma-separated).');
        process.exitCode = 1;
        return;
      }
      const args: Record<string, unknown> = { mode: 'neighbors' };
      if (files.length > 0) args['files'] = files;
      if (symbols.length > 0) args['symbols'] = symbols;
      if (!assignIntArg({ args, key: 'k', raw: options.k, optionName: '--k', opts: { min: 1 } })) return;
      // commander sets `dedupeByName: false` when --no-dedupe-by-name is passed.
      if (options.dedupeByName === false) args['dedupeByName'] = false;
      await runViaMCP('cartograph_review', args, options.projectPath);
    });
}

interface ReviewRiskOptions {
  projectPath?: string;
  topN?: string;
  limit?: string;
  minCentrality?: string;
  coverageSource?: string;
  pathFilter?: string;
}

function assignReviewRiskArgs(
  args: Record<string, unknown>,
  options: ReviewRiskOptions,
  deps: Pick<ReviewCommandDeps, 'assignIntArg' | 'assignFloatArg'>,
): boolean {
  const { assignIntArg, assignFloatArg } = deps;
  if (options.limit !== undefined) {
    if (!assignIntArg({ args, key: 'limit', raw: options.limit, optionName: '--limit', opts: { min: 1 } })) {
      return false;
    }
  }
  const rawTopN = options.topN ?? (options.limit === undefined ? '5' : undefined);
  if (!assignIntArg({ args, key: 'topN', raw: rawTopN, optionName: '--top-n', opts: { min: 1 } })) return false;
  return assignFloatArg({
    args,
    key: 'minCentrality',
    raw: options.minCentrality,
    optionName: '--min-centrality',
    opts: { min: 0, max: 1 },
  });
}

function registerReviewRiskCommand(deps: ReviewCommandDeps): void {
  const { reviewCmd, runViaMCP } = deps;
  reviewCmd
    .command('risk')
    .description(
      "Composed risk-triage report — biomarkers + hotspots + coverage gaps + dead-code (mirrors cartograph_review({mode: 'risk'}))",
    )
    .option('-p, --project-path <path>', 'Project path')
    .option('-n, --top-n <n>', 'Per-lens cap (default 5)')
    .option('--limit <n>', 'Alias of --top-n (MCP arg mirror); --top-n wins when both are set')
    .option('--min-centrality <n>', 'Minimum centrality (0–1, default 0)')
    .option('--coverage-source <s>', 'Coverage source key (e.g. unit, e2e)')
    .option('--path-filter <prefix>', 'Project-relative file path prefix for risk lenses')
    .action(async (options: ReviewRiskOptions) => {
      const args: Record<string, unknown> = { mode: 'risk' };
      if (!assignReviewRiskArgs(args, options, deps)) return;
      if (options.coverageSource) args['coverageSource'] = options.coverageSource;
      if (options.pathFilter) args['pathFilter'] = options.pathFilter;
      await runViaMCP('cartograph_review', args, options.projectPath);
    });
}

function registerReviewAgentAuditCommand(deps: ReviewCommandDeps): void {
  const { reviewCmd, error, assignIntArg, runViaMCP } = deps;
  reviewCmd
    .command('agent-audit')
    .description("Agent-prone biomarker audit (mirrors cartograph_review({mode: 'agent-audit'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('--per-detector-limit <n>', 'Max findings per detector (default 10, max 50)')
    .option('--min-severity <level>', 'Minimum severity: info, warning, or error')
    .action(async (options: { projectPath?: string; perDetectorLimit?: string; minSeverity?: string }) => {
      const args: Record<string, unknown> = { mode: 'agent-audit' };
      if (
        !assignIntArg({
          args,
          key: 'perDetectorLimit',
          raw: options.perDetectorLimit,
          optionName: '--per-detector-limit',
          opts: { min: 1, max: 50 },
        })
      )
        return;
      if (options.minSeverity !== undefined) {
        if (!['info', 'warning', 'error'].includes(options.minSeverity)) {
          error('--min-severity must be one of: info, warning, error');
          process.exitCode = 1;
          return;
        }
        args['minSeverity'] = options.minSeverity;
      }
      await runViaMCP('cartograph_review', args, options.projectPath);
    });
}

function registerReviewTrustCommand(deps: ReviewCommandDeps): void {
  const { reviewCmd, assignIntArg, runViaMCP } = deps;
  reviewCmd
    .command('trust')
    .description("Readiness self-check for graph, embeddings, and LLMs (mirrors cartograph_review({mode: 'trust'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('--deep', 'Execute live LLM requests and a semantic self-retrieval probe')
    .option('--timeout-ms <n>', 'Deep-probe timeout in milliseconds (default 60000)')
    .action(async (options: { projectPath?: string; deep?: boolean; timeoutMs?: string }) => {
      const args: Record<string, unknown> = { mode: 'trust' };
      if (options.deep === true) args['deep'] = true;
      if (
        !assignIntArg({
          args,
          key: 'timeoutMs',
          raw: options.timeoutMs,
          optionName: '--timeout-ms',
          opts: { min: 100, max: 300_000 },
        })
      )
        return;
      await runViaMCP('cartograph_review', args, options.projectPath);
    });
}

interface SimilarOptions {
  projectPath?: string;
  topK?: string;
  minScore?: string;
  sameLanguage?: boolean;
}

function registerSimilarCommand(deps: ReviewCommandDeps): void {
  const { program, assignIntArg, assignFloatArg, runViaMCP } = deps;
  // Note: the prior `cartograph search-fuzzy` command was retired in the
  // family-alignment pass — it's now `cartograph find [query] --by name
  // --mode fuzzy|semantic ...` (the unified `find` command, in
  // `commands/read.ts`). `cartograph similar` is reintroduced below as a
  // first-class embedding-cosine peer tool — semantically distinct from
  // the legacy search-similar mode.
  program
    .command('similar <symbol>')
    .description(
      "Embedding-cosine peers of a symbol — refactor companions / sister implementations (routes through cartograph_graph({direction: 'similar'}); was standalone cartograph_similar pre-2026-05-14)",
    )
    .option('-p, --project-path <path>', 'Project path')
    .option('-k, --top-k <n>', 'Top-K neighbours (default 5, max 50)', '5')
    .option('--min-score <n>', 'Minimum cosine similarity (0..1, default 0.3)')
    .option('--same-language', 'Restrict matches to the same language as the source')
    .action(async (symbol: string, options: SimilarOptions) => {
      const args: Record<string, unknown> = {
        direction: 'similar',
        start: symbol,
      };
      if (!assignIntArg({ args, key: 'k', raw: options.topK ?? '5', optionName: '--top-k', opts: { min: 1 } })) return;
      if (
        !assignFloatArg({
          args,
          key: 'minScore',
          raw: options.minScore,
          optionName: '--min-score',
          opts: { min: 0, max: 1 },
        })
      )
        return;
      if (options.sameLanguage) args['sameLanguage'] = true;
      await runViaMCP('cartograph_graph', args, options.projectPath);
    });
}

export function registerReviewCommands(deps: ReviewCommandDeps): void {
  deps.installFamilyActionAlias(deps.reviewCmd, 'review', 'mode');
  registerReviewContextCommand(deps);
  registerReviewNeighborsCommand(deps);
  registerReviewRiskCommand(deps);
  registerReviewAgentAuditCommand(deps);
  registerReviewTrustCommand(deps);
  deps.attachUnknownActionHandler(deps.reviewCmd, 'review');
  registerSimilarCommand(deps);
}
