/**
 * `cartograph review` family subcommands + the `similar` command —
 * extracted from the bin/cartograph.ts decomposition; side-effecting
 * module: importing it registers the commands.
 */
import * as fs from 'node:fs';
import { errMsg } from '../../errors.js';
import {
  program,
  reviewCmd,
  error,
  assignIntArg,
  assignFloatArg,
  runViaMCP,
  installFamilyActionAlias,
} from '../_cli-core.js';

// `--mode <name>` alias on the family parent so the MCP shape
// `cartograph review --mode neighbors` parses (mirrors the MCP arg
// name without changing the canonical subcommand form
// `cartograph review neighbors`). Argv rewrite — see
// installFamilyActionAlias in _cli-core.ts (handoff #23).
installFamilyActionAlias(reviewCmd, 'review', 'mode');

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
reviewCmd
  .command('context [diff-file]')
  .description("Diff-driven review context (mirrors cartograph_review({mode: 'context'}))")
  .option('-p, --project-path <path>', 'Project path')
  .option('--max-callers-per-symbol <n>', 'Cap callers per symbol (default 5)')
  .option('--max-callees-per-symbol <n>', 'Cap callees per symbol (default 5)')
  .option('--max-co-change-warnings <n>', 'Cap co-change warnings per file (default 3, 0 disables)')
  .option('--min-co-change-jaccard <n>', 'Minimum Jaccard for a co-change warning (default 0.4)')
  .option('--min-diff-magnitude <n>', 'Suppress co-change warnings when total diff lines < n (default 10, 0 disables)')
  .action(
    async (
      diffFile: string | undefined,
      options: {
        projectPath?: string;
        maxCallersPerSymbol?: string;
        maxCalleesPerSymbol?: string;
        maxCoChangeWarnings?: string;
        minCoChangeJaccard?: string;
        minDiffMagnitude?: string;
      },
    ) => {
      let diff: string;
      if (diffFile) {
        // Guard the read so a missing diff file yields a clean error +
        // non-zero exit instead of a raw Node ENOENT stack trace.
        try {
          diff = fs.readFileSync(diffFile, 'utf-8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            error(`review context: diff file not found: ${diffFile}`);
          } else {
            error(`review context: could not read diff file ${diffFile}: ${errMsg(err)}`);
          }
          process.exitCode = 1;
          return;
        }
        // An explicitly-passed diff-file path that is empty / whitespace-only
        // is a caller error — fail fast instead of silently falling back to
        // `git diff HEAD` and reviewing the working tree (the no-arg / empty-
        // stdin case below keeps its friendly git-derivation fallback).
        if (diff.trim().length === 0) {
          error(`review context: diff file is empty: ${diffFile}`);
          process.exitCode = 1;
          return;
        }
      } else {
        diff = await new Promise<string>((resolve, reject) => {
          let buf = '';
          process.stdin.setEncoding('utf-8');
          process.stdin.on('data', (c) => (buf += c));
          process.stdin.on('end', () => resolve(buf));
          process.stdin.on('error', reject);
        });
      }
      const args: Record<string, unknown> = { mode: 'context', diff };
      if (
        !assignIntArg({
          args,
          key: 'maxCallersPerSymbol',
          raw: options.maxCallersPerSymbol,
          optionName: '--max-callers-per-symbol',
        })
      )
        return;
      if (
        !assignIntArg({
          args,
          key: 'maxCalleesPerSymbol',
          raw: options.maxCalleesPerSymbol,
          optionName: '--max-callees-per-symbol',
        })
      )
        return;
      if (
        !assignIntArg({
          args,
          key: 'maxCoChangeWarnings',
          raw: options.maxCoChangeWarnings,
          optionName: '--max-co-change-warnings',
        })
      )
        return;
      if (
        !assignFloatArg({
          args,
          key: 'minCoChangeJaccard',
          raw: options.minCoChangeJaccard,
          optionName: '--min-co-change-jaccard',
        })
      )
        return;
      if (
        !assignIntArg({
          args,
          key: 'minDiffMagnitude',
          raw: options.minDiffMagnitude,
          optionName: '--min-diff-magnitude',
        })
      )
        return;
      await runViaMCP('cartograph_review', args, options.projectPath);
    },
  );

reviewCmd
  .command('neighbors')
  .description("Semantic lookalikes for changed files/symbols (mirrors cartograph_review({mode: 'neighbors'}))")
  .option('-p, --project-path <path>', 'Project path')
  .option('--files <paths>', 'Comma-separated changed file paths')
  .option('--symbols <names>', 'Comma-separated changed symbol names')
  .option('-k, --k <n>', 'Top-K lookalikes to return (default 5, max 50)')
  .option('--no-dedupe-by-name', 'Allow duplicate-named neighbors in the result (default: dedupe on)')
  .action(
    async (options: { projectPath?: string; files?: string; symbols?: string; k?: string; dedupeByName?: boolean }) => {
      const files = options.files
        ? options.files
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const symbols = options.symbols
        ? options.symbols
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      if (files.length === 0 && symbols.length === 0) {
        error('Pass at least one --files or --symbols (comma-separated).');
        process.exit(1);
      }
      const args: Record<string, unknown> = { mode: 'neighbors' };
      if (files.length > 0) args['files'] = files;
      if (symbols.length > 0) args['symbols'] = symbols;
      if (!assignIntArg({ args, key: 'k', raw: options.k, optionName: '--k', opts: { min: 1 } })) return;
      // commander sets `dedupeByName: false` when --no-dedupe-by-name is passed.
      if (options.dedupeByName === false) args['dedupeByName'] = false;
      await runViaMCP('cartograph_review', args, options.projectPath);
    },
  );

reviewCmd
  .command('risk')
  .description(
    "Composed risk-triage report — biomarkers + hotspots + coverage gaps + dead-code (mirrors cartograph_review({mode: 'risk'}))",
  )
  .option('-p, --project-path <path>', 'Project path')
  .option('-n, --top-n <n>', 'Per-lens cap (default 5)', '5')
  .option('--min-centrality <n>', 'Minimum centrality (0–1, default 0)')
  .option('--coverage-source <s>', 'Coverage source key (e.g. unit, e2e)')
  .action(async (options: { projectPath?: string; topN?: string; minCentrality?: string; coverageSource?: string }) => {
    const args: Record<string, unknown> = { mode: 'risk' };
    if (!assignIntArg({ args, key: 'topN', raw: options.topN ?? '5', optionName: '--top-n', opts: { min: 1 } })) return;
    if (
      !assignFloatArg({
        args,
        key: 'minCentrality',
        raw: options.minCentrality,
        optionName: '--min-centrality',
        opts: { min: 0, max: 1 },
      })
    )
      return;
    if (options.coverageSource) args['coverageSource'] = options.coverageSource;
    await runViaMCP('cartograph_review', args, options.projectPath);
  });

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
  .action(
    async (
      symbol: string,
      options: { projectPath?: string; topK?: string; minScore?: string; sameLanguage?: boolean },
    ) => {
      // Translates to the merged `cartograph_graph` tool with
      // `direction: 'similar'`; the dispatcher accepts `start` (the
      // graph-shaped name for the source symbol) and forwards to
      // handleSimilar internally. See graph.ts dispatcher.
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
    },
  );
