/**
 * Cartograph CLI — shared core infrastructure.
 *
 * Holds the pieces of the CLI that every command group needs but that
 * are not themselves command definitions: the commander `program`, the
 * family-parent commands (`admin` / `summaries` / `review` / `llm` /
 * `session`), and the stateless helpers (path resolution, number /
 * duration formatting, verbose-progress callbacks, the `success` /
 * `error` / `info` / `warn` styled printers, numeric-arg parsers,
 * index-result rendering, error-log writing, the `runViaMCP` shim and
 * the `registerGeneratedCommand` factory).
 *
 * Extracted from `cartograph.ts` (a 3900-line god-module) as Stage 1 of
 * its decomposition so per-command-group modules can import this shared
 * surface without forming an import cycle through `cartograph.ts`.
 *
 * The `program.name(...).description(...).version(...)` chain and the
 * family-parent `program.command(...)` calls run at module-init — they
 * are pure commander metadata-building, cheap to run at import time.
 */
import { Command } from 'commander';
import { z } from 'zod';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { isInitialized } from '../directory.js';
import { compact } from '../utils.js';
import { errMsg } from '../errors.js';
import { getSummaryCoverage } from '../db/queries-summaries.js';
import { contentDriftCount } from '../freshness.js';
import { SUMMARIZABLE_KINDS } from '../llm/summarizer.js';
import { buildGeneratedCommand, type GenerateCommandOptions } from './_command-generator.js';
import { getToolModules } from '../mcp/tools/registry.js';

// Lazy-load heavy modules (Cartograph, runInstaller) to keep CLI startup fast.
export async function loadCartograph(): Promise<typeof import('../index.js')> {
  try {
    return await import('../index.js');
  } catch (err) {
    const msg = errMsg(err);
    process.stderr.write('\x1b[31m✗\x1b[0m Failed to load Cartograph modules.\n');
    process.stderr.write(`\n  Node: ${process.version}  Platform: ${process.platform} ${process.arch}\n`);
    process.stderr.write(`\n  Error: ${msg}\n`);
    process.stderr.write('\n  Try reinstalling with: npm install -g @adder-factory/cartograph\n\n');
    process.exit(1);
  }
}

// Set up the commander program at module scope. Commander
// registrations are pure metadata-building method calls — cheap to
// run at import time, and removing the previous `function main() {}`
// wrapper drops `main` from the biomarker hot list (was 2266 LOC).
// `program.parse()` is still called conditionally so the no-arg path
// can still hand off to the installer instead of dispatching the CLI.
export const program = new Command();

// Family-command parents per the agentic-backlog #7 / CLI-alignment
// pass: subcommands attach to these so nested syntax (`cartograph
// admin init`, `cartograph summaries pending`) resolves through
// Commander's addCommand path instead of the colliding bare-string
// `command('admin init')` form.
// CLI/MCP alignment exception (B11): admin subcommands are direct
// implementations rather than runViaMCP shims because their actions
// (init / uninit / index / sync) involve filesystem mutation and
// long-running progress streaming. The MCP versions return a single
// completion message; the CLI versions stream per-file progress so
// human operators see indexing advance instead of waiting blind.
export const adminCmd = program
  .command('admin')
  .summary('Project lifecycle, indexing, setup, doctor, and LLM admin commands')
  .description(
    'Project lifecycle / index maintenance. Subcommands: init / uninit / sync / index / summarize / embed / classify / doctor / llm-plan / llm-apply / llm-tune / install-models / scip import/export.',
  );
export const summariesCmd = program
  .command('summaries')
  .summary('Pull and save agent-written symbol summaries')
  .description('Agent-bridge summaries — pending (pull) / save (persist). Mirrors cartograph_summaries MCP tool.');
export const reviewCmd = program
  .command('review')
  .summary('Diff, neighbor, risk, audit, and trust review helpers')
  .description(
    'Review / triage helpers (mirrors cartograph_review MCP tool). Subcommands: context (diff-driven structural review) / neighbors (semantic lookalikes) / risk (project-wide triage) / agent-audit (agent-prone biomarkers) / trust (readiness self-check).',
  );

// `llm setup` is the only remaining LLM provisioning command. Kept
// as a subcommand under `llm` so the surface stays extensible (e.g.
// future `llm test`, `llm list-models`) without renaming.
export const llmCmd = program
  .command('llm')
  .summary('Interactive local or cloud LLM provider setup')
  .description('Local-LLM utilities: provider setup.');

/**
 * cartograph session <action>
 *
 * Mirrors the `cartograph_session({action})` MCP family. Lets a CLI-driven
 * agent create/resume/list sessions and manage macros without going through
 * the MCP server. Same family pattern as `admin <action>` / `note <action>`.
 *
 * Subcommands mirror the MCP action enum:
 *   create / resume / list / delete
 *   macro_save / macro_run / macro_list / macro_delete
 *   (kebab-case aliases: macro-save / macro-run / macro-list /
 *   macro-delete)
 */
export const sessionCmd = program
  .command('session')
  .summary('Create, list, resume, delete sessions and macros')
  .description(
    'Agent session state + macros. Subcommands: create / resume / list / delete / macro_save / macro_run / macro_list / macro_delete; kebab aliases also work.',
  );

// Version from package.json
const packageJson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf-8'));

// =============================================================================
// ANSI Color Helpers (avoid chalk ESM issues)
// =============================================================================

export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

export const chalk = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  magenta: (s: string) => `${colors.magenta}${s}${colors.reset}`,
  white: (s: string) => `${colors.white}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,
};

program
  .name('cartograph')
  .description('Code intelligence and knowledge graph for any codebase')
  .version(packageJson.version);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve project path from argument or current directory
 * Walks up parent directories to find nearest initialized Cartograph project
 * (must have .cartograph/cartograph.db, not just .cartograph/lessons.db)
 */
export function resolveProjectPath(pathArg?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());

  // If exact path is initialized (has cartograph.db), use it
  if (isInitialized(absolutePath)) {
    return absolutePath;
  }

  // Walk up to find nearest parent with Cartograph initialized
  // Note: findNearestCartographRoot finds any .cartograph folder, but we need one with cartograph.db
  let current = absolutePath;
  const root = path.parse(current).root;

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;

    if (isInitialized(current)) {
      return current;
    }
  }

  // Not found - return original path (will fail later with helpful error)
  return absolutePath;
}

/**
 * Format a number with commas
 */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** Multiplier converting a 0..1 fraction to a 0..100 integer percent. */
const FRACTION_TO_PERCENT = 100;

/**
 * Per-step percentage delta required before logging a new progress
 * line in --verbose mode. Logging every increment floods the
 * terminal; 5% strikes a balance between resolution and noise.
 */
const VERBOSE_PROGRESS_PCT_STEP = 5;

/**
 * Scanning-phase log cadence: emit a line every N files when no
 * total is known yet. Smaller values flood, larger values look hung
 * on slow scans.
 */
const VERBOSE_SCANNING_LOG_INTERVAL = 1000;

/**
 * Heartbeat interval (ms) for the background-summarisation progress
 * ticker. Slow models on large repos otherwise look identical to a
 * hang; 15s lets the user see steady progress without spamming.
 */
const SUMMARY_TICKER_INTERVAL_MS = 15_000;

/**
 * Format duration in milliseconds to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) {
    return `${ms}ms`;
  }
  const seconds = ms / MS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const remainingSeconds = seconds % SECONDS_PER_MINUTE;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

// Shimmer progress renderer (runs in a worker thread for smooth animation)
// Imported at top of file from '../ui/shimmer-progress'

/**
 * Create a plain-text progress callback for --verbose mode.
 * No animations, no ANSI tricks — just timestamped lines to stdout.
 */
export function createVerboseProgress(): (progress: {
  phase: string;
  current: number;
  total: number;
  currentFile?: string;
}) => void {
  let lastPhase = '';
  let lastPct = -1;
  const startTime = Date.now();

  return (progress) => {
    const elapsed = ((Date.now() - startTime) / MS_PER_SECOND).toFixed(1);

    if (progress.phase !== lastPhase) {
      lastPhase = progress.phase;
      lastPct = -1;
      process.stdout.write(`[${elapsed}s] Phase: ${progress.phase}\n`);
    }

    if (progress.total > 0) {
      const pct = Math.floor((progress.current / progress.total) * FRACTION_TO_PERCENT);
      // Log every VERBOSE_PROGRESS_PCT_STEP percent to keep output manageable
      if (pct >= lastPct + VERBOSE_PROGRESS_PCT_STEP || progress.current === progress.total) {
        lastPct = pct;
        const currentFileSuffix = progress.currentFile ? ` — ${progress.currentFile}` : '';
        process.stdout.write(`[${elapsed}s]   ${progress.current}/${progress.total} (${pct}%)${currentFileSuffix}\n`);
      }
    } else if (progress.current > 0) {
      // Scanning phase (no total yet) — log periodically
      if (progress.current % VERBOSE_SCANNING_LOG_INTERVAL === 0 || progress.current === 1) {
        process.stdout.write(`[${elapsed}s]   ${formatNumber(progress.current)} files found\n`);
      }
    }
  };
}

/**
 * Print success message
 */
export function success(message: string): void {
  console.log(chalk.green('✓') + ' ' + message);
}

/**
 * Print error message
 */
export function error(message: string): void {
  console.error(chalk.red('✗') + ' ' + message);
}

/**
 * Wire a styled unknown-subcommand handler onto a family command group
 * (`session` / `admin`). Without this, commander emits its bare
 * `error: unknown command 'X'` for a mistyped action, whereas the
 * single-command `note` family emits a styled `✗ Unknown … action`
 * enum error. This brings the subcommand-style families in line: a bad
 * action prints `✗ Unknown <family> action 'X' — valid: …` and exits 1.
 */
export function attachUnknownActionHandler(group: import('commander').Command, family: string): void {
  group.on('command:*', (operands: string[]) => {
    const bad = operands[0] ?? '';
    const valid = group.commands.map((c) => c.name()).join(', ');
    error(`Unknown ${family} action '${bad}' — valid: ${valid}.`);
    process.exit(1);
  });
}

/**
 * Wire a `--<discriminator> <name>` alias onto a SUBCOMMAND-style family
 * parent (`summaries` / `review`) so the MCP shape
 * `cartograph summaries --action pending` parses (mirrors the MCP arg
 * name without changing the canonical `cartograph summaries pending`
 * subcommand form — handoff #23 MCP-shape alignment).
 *
 * Implementation: intercept `process.argv` BEFORE commander walks the
 * family parent. When the family token is followed by `--<disc> <name>`
 * (or `--<disc>=<name>`), rewrite the slot in place so commander
 * dispatches to the named subcommand exactly as if the user had typed
 * `<family> <name> ...rest` (every other flag passed alongside reaches
 * the subcommand's own option parser). The argv rewrite is a no-op on
 * the canonical subcommand form (`<family> <name>`) and on `--help`.
 *
 * `family` is the CLI family name (`summaries` / `review`); `disc`
 * is the discriminator MCP arg name (`action` / `mode`).
 */
export function installFamilyActionAlias(group: import('commander').Command, family: string, disc: string): void {
  // Documentation-only option so `--help` lists the alias even though
  // the real wiring is the argv rewrite below.
  group.option(`--${disc} <name>`, `Alias for the [${disc}] subcommand (mirrors MCP arg name)`);
  // Argv rewrite: find the `<family>` token in `process.argv`, peek
  // for an immediately-following `--<disc> <name>` (or `--<disc>=<name>`),
  // and replace the flag pair with the bare `<name>` so commander's
  // own subcommand router does the rest. Runs at module-import time so
  // it sits in place by `program.parse()`.
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== family) continue;
    const next = argv[i + 1];
    if (next === `--${disc}` && typeof argv[i + 2] === 'string') {
      argv.splice(i + 1, 2, argv[i + 2]!);
      return;
    }
    if (typeof next === 'string' && next.startsWith(`--${disc}=`)) {
      argv.splice(i + 1, 1, next.slice(`--${disc}=`.length));
      return;
    }
    // Family token found but no alias pair — canonical subcommand
    // form. Nothing to rewrite; bail out of the scan.
    return;
  }
}

/**
 * Print info message
 */
export function info(message: string): void {
  console.log(chalk.blue('ℹ') + ' ' + message);
}

/**
 * Print warning message
 */
export function warn(message: string): void {
  console.log(chalk.yellow('⚠') + ' ' + message);
}

/** Optional inclusive numeric bounds for `assignIntArg` / `assignFloatArg`. */
interface NumericArgBounds {
  min?: number;
  max?: number;
}

/**
 * Bundled arguments for `assignIntArg` / `assignFloatArg` — collapses
 * the prior 5 positional params into one object so call sites stay
 * readable and the long_parameter_list biomarker doesn't fire.
 *
 * - `args` — the MCP-arg bag the parsed value is written into on success.
 * - `key` — the property on `args` to set.
 * - `raw` — the raw CLI string; `undefined` / `''` is a no-op success.
 * - `optionName` — the user-facing flag name used in error messages.
 * - `opts` — optional inclusive `min` / `max` range validation.
 */
export interface AssignNumericArgArgs {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: NumericArgBounds;
}

/**
 * Shared body for `assignIntArg` / `assignFloatArg`. Gate-parse-assigns
 * a CLI numeric arg: when `raw` is unset it leaves `args` untouched and
 * returns `true`; when it fails to parse or falls outside the optional
 * `min` / `max` bounds it prints a clean error, sets
 * `process.exitCode = 1`, and returns `false`; otherwise it writes the
 * parsed value to `args[key]` and returns `true`.
 *
 * `schema` supplies the int-vs-float Zod coercion and `noun` is the
 * error wording ("integer" / "number") — the only bits that differ
 * between the two public entry points.
 */
function assignNumericArg(
  { args, key, raw, optionName, opts }: AssignNumericArgArgs,
  schema: z.ZodType<number>,
  noun: string,
): boolean {
  if (raw === undefined || raw === '') return true;
  const parsed = schema.safeParse(raw);
  if (!parsed.success || !Number.isFinite(parsed.data)) {
    error(`Invalid value for ${optionName}: "${raw}" is not ${noun === 'integer' ? 'an' : 'a'} ${noun}`);
    process.exitCode = 1;
    return false;
  }
  const n = parsed.data;
  if (opts?.min !== undefined && n < opts.min) {
    error(`Invalid value for ${optionName}: must be >= ${opts.min}`);
    process.exitCode = 1;
    return false;
  }
  if (opts?.max !== undefined && n > opts.max) {
    error(`Invalid value for ${optionName}: must be <= ${opts.max}`);
    process.exitCode = 1;
    return false;
  }
  args[key] = n;
  return true;
}

/**
 * Gate-parse-assign helper for the common `if (options.x) args['x'] =
 * parseInt(options.x, 10)` CLI forwarding pattern. When `raw` is set
 * but is not a valid integer (non-numeric, trailing garbage like
 * `12abc`, or fractional) it prints a clean error, sets
 * `process.exitCode = 1`, and returns `false` — the caller MUST `return` from its action
 * handler. When `raw` is unset it leaves `args` untouched and returns
 * `true`. Centralising this stops `NaN` from leaking into the MCP layer.
 *
 * Pass `opts.min` / `opts.max` for inclusive range validation — an
 * out-of-range value is rejected with the same clean-error contract so
 * negative / zero limits can't silently clamp to 1 downstream.
 */
export function assignIntArg(a: AssignNumericArgArgs): boolean {
  // `z.coerce.number().int()` rejects a non-integer AND any trailing
  // garbage — `parseInt('12abc', 10)` used to silently yield `12`,
  // letting `--limit 12abc` through. `.int()` also rejects a
  // fractional (`12.9`) and non-finite input.
  return assignNumericArg(a, z.coerce.number().int(), 'integer');
}

/**
 * `assignIntArg` sibling for `parseFloat`-class CLI options (centrality
 * / score thresholds etc.). Same contract: rejects input that is not a
 * finite number (non-numeric, or trailing garbage like `1.5x`)
 * with a clean error + `process.exitCode = 1` and a `false` return so
 * `NaN` can't leak into the MCP layer. Pass `opts.min` / `opts.max` for
 * inclusive range validation (e.g. `{min: 0, max: 1}` for 0-1 scores).
 */
export function assignFloatArg(a: AssignNumericArgArgs): boolean {
  // `z.coerce.number()` rejects trailing garbage that `parseFloat`
  // silently truncated (`parseFloat('1.5x')` used to yield `1.5`);
  // the shared `Number.isFinite` guard additionally rejects
  // `Infinity` / `NaN`.
  return assignNumericArg(a, z.coerce.number(), 'number');
}

/**
 * Await any background LLM summarisation pass kicked off by indexAll
 * or sync. Shows a small status line so the user knows what's
 * happening, and lets them Ctrl-C to skip — partial work is preserved
 * because the summariser persists each summary as it lands.
 */
/**
 * Build the heartbeat ticker callback for `awaitSummarisationWithProgress`.
 * Polls the bg pass and emits a one-line phase update only when the
 * formatted message changes — silent otherwise.
 */
function makeSummaryTicker(cg: import('../index.js').default, clack: typeof import('@clack/prompts')): () => void {
  const phaseLabels: Record<string, string> = {
    summarise: 'symbol summaries',
    embed: 'embeddings',
    directory: 'directory summaries',
    classify: 'role classification',
  };
  let lastMsg = '';
  return (): void => {
    const p = cg.llm.bgCtrl.getProgress();
    if (!p || p.total === 0) return;
    const pct = Math.round((p.done / p.total) * FRACTION_TO_PERCENT);
    const msg = `${phaseLabels[p.phase] ?? p.phase}: ${formatNumber(p.done)}/${formatNumber(p.total)} (${pct}%)`;
    if (msg !== lastMsg) {
      clack.log.info(msg);
      lastMsg = msg;
    }
  };
}

export async function awaitSummarisationWithProgress(
  cg: import('../index.js').default,
  clack: typeof import('@clack/prompts'),
): Promise<void> {
  if (cg.llm.bgCtrl.promise === null) return;

  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  const { getChatModel } = await import('../llm/provider.js');
  const label = getChatModel(llmConfig) ?? 'local LLM';
  clack.log.info(`Summarising symbols with ${label} (Ctrl-C to skip)…`);

  const onSigint = (): void => {
    // Closing cancels the in-flight pass via AbortController.
    cg.close();
    process.exit(0);
  };
  process.once('SIGINT', onSigint);

  // Poll the bg pass and emit heartbeat lines so a slow model on a
  // large codebase doesn't look like a hang.
  const ticker = setInterval(makeSummaryTicker(cg, clack), SUMMARY_TICKER_INTERVAL_MS);
  ticker.unref?.(); // don't keep Node alive past the await

  try {
    await cg.llm.bgCtrl.awaitCompletion();
    const cov = getSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS);
    if (cov.total > 0) {
      const pct = Math.round((cov.summarised / cov.total) * FRACTION_TO_PERCENT);
      clack.log.info(`Summary coverage: ${formatNumber(cov.summarised)}/${formatNumber(cov.total)} (${pct}%)`);
    }
  } finally {
    clearInterval(ticker);
    process.removeListener('SIGINT', onSigint);
  }
}

export type IndexResult = {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>;
  durationMs: number;
  profile?: {
    scanMs?: number;
    parseStoreMs?: number;
    retryMs?: number;
    extractionMs?: number;
    resolveMs?: number;
    postHooksMs?: number;
    maintenanceMs?: number;
    postHooksByHook?: Record<string, number>;
  };
};

/**
 * Print indexing results using clack log methods
 */
/**
 * Print the high-level success/error/empty summary line(s). Returns
 * true when a lock-acquisition (or other non-file-level) failure
 * fired, so the caller skips the size-skips + breakdown sections.
 */
function printIndexHeadlineOrLockShortCircuit(clack: typeof import('@clack/prompts'), result: IndexResult): boolean {
  const hasErrors = result.filesErrored > 0;
  // Lock-acquisition failure (or any non-file-level failure) — surface
  // before the file-count branches so the CLI doesn't fall through to
  // a misleading "No files found to index".
  if (!result.success && !hasErrors && result.filesIndexed === 0) {
    const generic = result.errors.find((e) => e.severity === 'error');
    clack.log.error(generic?.message ?? 'Indexing failed — no further details available');
    return true;
  }
  if (result.filesIndexed > 0) {
    if (hasErrors) {
      clack.log.success(
        `Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} could not be parsed)`,
      );
    } else {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files`);
    }
    clack.log.info(
      `${formatNumber(result.nodesCreated)} nodes, ${formatNumber(result.edgesCreated)} edges in ${formatDuration(result.durationMs)}`,
    );
  } else if (hasErrors) {
    clack.log.error(`Indexing failed — all ${formatNumber(result.filesErrored)} files had errors`);
  } else {
    clack.log.warn('No files found to index');
  }
  return false;
}

export function printIndexResult(
  clack: typeof import('@clack/prompts'),
  result: IndexResult,
  projectPath?: string,
): void {
  if (printIndexHeadlineOrLockShortCircuit(clack, result)) return;

  // Surface size-cap skips so they don't disappear silently. The
  // most common cause is `maxFileSize` — generated schemas, vendored
  // bundles, and large fixture files routinely trip it. Only warn on
  // size_exceeded specifically: empty/comment-only files also
  // increment filesSkipped, but those are benign.
  const sizeSkips = result.errors.filter((e) => e.code === 'size_exceeded').length;
  if (sizeSkips > 0) {
    clack.log.warn(
      `Skipped ${formatNumber(sizeSkips)} files exceeding maxFileSize — see .cartograph/errors.log; raise the cap in .cartograph/config.json if intentional`,
    );
  }

  if (result.filesErrored > 0) {
    printIndexErrorBreakdown(clack, result, projectPath);
    return;
  }
  if (sizeSkips > 0 && projectPath) {
    // No hard errors, but the size-cap warning above needs the log to
    // lead somewhere — without this branch errors.log is unlinked.
    writeErrorLog(projectPath, result.errors);
    return;
  }
  if (projectPath) clearStaleErrorLog(projectPath);
}

const ERROR_CODE_LABELS: Record<string, string> = {
  parse_error: 'files failed to parse',
  store_error: 'files failed to store (DB contention?)',
  read_error: 'files could not be read',
  size_exceeded: 'files exceeded size limit',
  path_traversal: 'blocked paths',
  unsupported_language: 'unsupported language',
  parser_error: 'parser initialization failures',
};

/** Tally severity:'error' entries by their `code` field. Falls back
 *  to `'unknown'` when the producer omitted the code. */
function tallyErrorsByCode(errors: IndexResult['errors']): Map<string, number> {
  const out = new Map<string, number>();
  for (const err of errors) {
    if (err.severity !== 'error') continue;
    const code = err.code || 'unknown';
    out.set(code, (out.get(code) || 0) + 1);
  }
  return out;
}

/** Render the by-code error breakdown note + write the on-disk
 *  log. Pulled out of {@link printIndexResult} so the branch isn't
 *  carrying a 4-deep `for/if/set` walker plus two trailing `if`s
 *  alongside the else-if cascade. */
function printIndexErrorBreakdown(
  clack: typeof import('@clack/prompts'),
  result: IndexResult,
  projectPath?: string,
): void {
  const errorsByCode = tallyErrorsByCode(result.errors);
  const breakdown = Array.from(errorsByCode)
    .map(([code, count]) => `${formatNumber(count)} ${ERROR_CODE_LABELS[code] || code}`)
    .join('\n');
  clack.note(breakdown, 'Error breakdown');
  if (projectPath) {
    writeErrorLog(projectPath, result.errors);
    clack.log.info('See .cartograph/errors.log for details');
  }
  if (result.filesIndexed > 0) {
    clack.log.info('The index is fully usable — only the failed files are missing.');
  }
}

function clearStaleErrorLog(projectPath: string): void {
  const logPath = path.join(projectPath, '.cartograph', 'errors.log');
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
}

interface ErrorEntry {
  message: string;
  filePath?: string;
  severity: string;
  code?: string;
}
interface LoggedEntry {
  message: string;
  code?: string;
}

/**
 * Bucket the input errors into (file → entries) and a separate list
 * for entries with no `filePath`. Includes warnings (e.g.
 * `size_exceeded` skips) so the user can look up which files were
 * skipped, not just which ones errored.
 */
function groupErrorsByFile(errors: ReadonlyArray<ErrorEntry>): {
  errorsByFile: Map<string, LoggedEntry[]>;
  noFileErrors: LoggedEntry[];
} {
  const errorsByFile = new Map<string, LoggedEntry[]>();
  const noFileErrors: LoggedEntry[] = [];
  for (const err of errors) {
    if (err.severity !== 'error' && err.severity !== 'warning') continue;
    const entry = compact({ message: err.message, code: err.code });
    if (err.filePath) {
      let list = errorsByFile.get(err.filePath);
      if (!list) {
        list = [];
        errorsByFile.set(err.filePath, list);
      }
      list.push(entry);
    } else {
      noFileErrors.push(entry);
    }
  }
  return { errorsByFile, noFileErrors };
}

/**
 * Format the "X errors, Y warnings" header bit. Reflects the log's
 * actual contents — the file may include warning entries without any
 * hard errors (or vice versa). Returns an empty string when nothing
 * loggable is present.
 */
function formatErrorHeaderCounts(errors: ReadonlyArray<ErrorEntry>): string {
  let errorCount = 0;
  let warningCount = 0;
  for (const err of errors) {
    if (err.severity === 'error') errorCount++;
    else if (err.severity === 'warning') warningCount++;
  }
  const parts: string[] = [];
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  if (warningCount > 0) parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Write detailed error log to .cartograph/errors.log
 */
export function writeErrorLog(projectPath: string, errors: ReadonlyArray<ErrorEntry>): void {
  const cgDir = path.join(projectPath, '.cartograph');
  if (!fs.existsSync(cgDir)) return;
  const logPath = path.join(cgDir, 'errors.log');

  const { errorsByFile, noFileErrors } = groupErrorsByFile(errors);
  const headerCounts = formatErrorHeaderCounts(errors);

  const lines: string[] = [
    `Cartograph Error Log — ${new Date().toISOString()}`,
    `${errorsByFile.size} files with issues (${headerCounts || 'no entries'})`,
    '',
  ];
  for (const [filePath, fileErrors] of errorsByFile) {
    for (const err of fileErrors) lines.push(`${filePath}: ${err.message}`);
  }
  for (const err of noFileErrors) lines.push(err.message);

  fs.writeFileSync(logPath, lines.join('\n') + '\n');
}

/**
 * Outcome of {@link runViaMCPCapture}: the markdown text the MCP tool
 * returned plus a derived freshness reading (used by callers that
 * want to append a CLI-side hint like the compare-to-ref content-drift
 * note in handoff #27). When the call errored, `text` carries the
 * styled message and `exitCode` is non-zero — callers should exit
 * with the supplied code rather than attempting to extend the output.
 */
export interface McpCallResult {
  readonly text: string;
  readonly exitCode: number;
  /** Files content-drifted on disk vs the index, or `null` when the
   *  project's freshness probe isn't available. */
  readonly contentDriftedFiles: number | null;
}

/**
 * Variant of {@link runViaMCP} that RETURNS the tool's text + the
 * project's freshness reading instead of printing the text and
 * exiting. Lets a CLI command post-process the output — append a
 * CLI-only hint, summarise, etc. — without forking the MCP tool.
 */
export async function runViaMCPCapture(
  toolName: string,
  args: Record<string, unknown>,
  pathArg: string | undefined,
): Promise<McpCallResult> {
  const projectPath = resolveProjectPath(pathArg);
  if (!isInitialized(projectPath)) {
    return {
      text: `${chalk.red('✗')} Cartograph not initialized in ${projectPath}`,
      exitCode: 1,
      contentDriftedFiles: null,
    };
  }
  const { default: Cartograph } = await loadCartograph();
  const { getToolModules } = await import('../mcp/tools/registry.js');
  const mod = getToolModules().find((m) => m.definition.name === toolName);
  const autoMigrate = mod?.isWriteTool === true;
  const cg = await Cartograph.open(projectPath, { autoMigrate });
  try {
    const { ToolHandler } = await import('../mcp/tools.js');
    const handler = new ToolHandler(cg);
    const result = await handler.execute(toolName, args);
    handler.closeAll();
    let text = result.content[0]?.text ?? '';
    let exitCode = 0;
    if (result.isError) {
      exitCode = 1;
      const invalidArgsPrefix = /^Invalid arguments for `?cartograph_[A-Za-z_]+`?:\s*/;
      if (text.startsWith('Error: ')) text = text.slice('Error: '.length);
      text = text.replace(invalidArgsPrefix, '');
      text = `${chalk.red('✗')} ${text}`;
    }
    const freshness = cg.stats.getFreshness();
    const drifted = freshness && freshness.contentDriftedFiles !== null ? contentDriftCount(freshness) : null;
    return { text, exitCode, contentDriftedFiles: drifted };
  } finally {
    cg.close();
  }
}

/**
 * Shared shim for CLI commands that delegate to an MCP tool handler.
 * Keeps the CLI/MCP surfaces aligned: same args, same logic, same
 * output formatting — the CLI command is a thin frontend that prints
 * the handler's text result to stdout. Used for query-class tools
 * (callers, callees, impact, node, similar, biomarkers, imports)
 * whose output is already markdown-friendly.
 */
export async function runViaMCP(
  toolName: string,
  args: Record<string, unknown>,
  pathArg: string | undefined,
): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  if (!isInitialized(projectPath)) {
    error(`Cartograph not initialized in ${projectPath}`);
    process.exit(1);
  }
  const { default: Cartograph } = await loadCartograph();
  // Tools flagged `isWriteTool: true` (admin actions, summarize/embed
  // batches, agent-bridge save, etc.) are explicitly the user's
  // "fix the index" path, so they opt in to auto-migration. Pure
  // read tools leave autoMigrate=false so a read invocation can
  // never silently bump the schema and lock out a running MCP
  // server bound to the older version.
  const { getToolModules } = await import('../mcp/tools/registry.js');
  const mod = getToolModules().find((m) => m.definition.name === toolName);
  const autoMigrate = mod?.isWriteTool === true;
  const cg = await Cartograph.open(projectPath, { autoMigrate });
  // Defer `process.exit` until AFTER the finally cleanup. Calling
  // process.exit inside the try would short-circuit the finally and
  // leak the SQLite WAL + file-lock until the OS reclaimed them.
  let exitCode = 0;
  try {
    const { ToolHandler } = await import('../mcp/tools.js');
    const handler = new ToolHandler(cg);
    const result = await handler.execute(toolName, args);
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    if (result.isError) {
      exitCode = 1;
      // Re-style raw MCP-layer error text into the CLI's `✗ ...` form
      // so schema-validation / validateString failures don't surface
      // as bare `Error: ...` while CLI-guard errors use `✗`. The MCP
      // `errorResult` helper always prefixes `Error: `; schema
      // failures additionally carry `Invalid arguments for
      // cartograph_<tool>: `. Strip the generic `Error: ` first, then
      // the internal tool-name prefix, so the surfaced message is the
      // human-meaningful tail in both cases:
      //   `Error: Invalid arguments for cartograph_<tool>: <rest>` → `✗ <rest>`
      //   `Error: <rest>`                                         → `✗ <rest>`
      const invalidArgsPrefix = /^Invalid arguments for `?cartograph_[A-Za-z_]+`?:\s*/;
      let styled = text;
      if (styled.startsWith('Error: ')) {
        styled = styled.slice('Error: '.length);
      }
      styled = styled.replace(invalidArgsPrefix, '');
      // Either way this is an error result — render it in the `✗`
      // style (the `else` covers an errorResult whose text carried
      // neither the `Error: ` nor the `Invalid arguments` prefix).
      error(styled);
    } else {
      process.stdout.write(text + '\n');
    }
  } finally {
    cg.close();
  }
  if (exitCode !== 0) process.exit(exitCode);
}

/**
 * P8 — register a CLI command GENERATED from a tool's Zod schema.
 *
 * Looks the tool up in the MCP registry by name, hands it to
 * {@link buildGeneratedCommand} (options derived from the same Zod
 * schema that drives the MCP `inputSchema`), and attaches the result
 * to `program` (or a family-parent command). The CLI option list can
 * therefore never drift from the MCP surface — the
 * `cli-mcp-alignment` arg-shape test enforces it.
 *
 * `parent` defaults to the root `program`; pass a family parent
 * (`adminCmd` etc.) to nest the generated command.
 */
export function registerGeneratedCommand(
  toolName: string,
  opts: GenerateCommandOptions & {
    parent?: Command;
    /**
     * Custom dispatcher in place of the default {@link runViaMCP}. Use
     * when the generated command needs to post-process the MCP output
     * (e.g. append a CLI-side hint based on freshness state — handoff
     * #27's compare-to-ref content-drift note). The signature matches
     * `runViaMCP` so the generated action still calls it the same way.
     */
    runViaMcp?: typeof runViaMCP;
  } = {},
): void {
  // The MCP registry is the single source of truth for tool modules.
  const mod = getToolModules().find((m) => m.definition.name === toolName);
  if (!mod) {
    throw new Error(`registerGeneratedCommand: unknown tool \`${toolName}\``);
  }
  const { parent, runViaMcp: customRunner, ...genOpts } = opts;
  const cmd = buildGeneratedCommand(mod, customRunner ?? runViaMCP, genOpts);
  (parent ?? program).addCommand(cmd);
}
