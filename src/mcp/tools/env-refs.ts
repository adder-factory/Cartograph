/**
 * @internal — env-mode handler for the consolidated `cartograph_string_refs`
 * family tool. Dispatched from `refs.ts` when `kind === 'env'`. No
 * registered ToolModule export — the registry only knows REFS_TOOL.
 */
import type { ToolResult } from '../tool-types.js';
import { getConfigKeys, getConfigRefsByKey } from '../../db/queries-refs.js';
import { clamp, isTestPath } from '../../utils.js';
import { textResult, truncateOutput, countByTestPath, formatRefSiteLine, isFixturePath } from './shared.js';
import { renderMarkdownTable, type MarkdownTableSpec } from './_result-spec.js';
import type { ToolCtx } from './types.js';

/** Clamp ceiling for `limit` from agent input. */
const ENV_REFS_LIMIT_MAX = 500;

/** Default `limit` when caller doesn't pass one. */
const ENV_REFS_LIMIT_DEFAULT = 30;

/**
 * Multiplier widening the raw fetch beyond `limit` so post-filtering
 * by test/prod still produces enough rows for prod-heavy keys.
 */
const ENV_REFS_OVERFETCH_MULTIPLIER = 4;

function enrichEnvKey(
  cg: ReturnType<ToolCtx['getCartograph']>,
  row: { configKey: string; reads: number },
): { configKey: string; reads: number; prodReads: number; testReads: number; prodFiles: number; testFiles: number } {
  const sites = getConfigRefsByKey(cg.queries, row.configKey, { configKind: 'env' });
  let prodReads = 0;
  let testReads = 0;
  const prodFiles = new Set<string>();
  const testFiles = new Set<string>();
  for (const s of sites) {
    // Classify fixture directories (docs/test-beds/, __tests__/fixtures/, etc.)
    // as non-prod using isFixturePath in addition to isTestPath — these are
    // extraction fixtures / test-bed sample files, not production code. Without
    // the isFixturePath check, files like docs/test-beds/typescript/fixture.ts
    // could appear as prod reads when the is_test DB column is 0 but the path
    // clearly lives under a known fixture directory.
    if (isTestPath(s.filePath) || isFixturePath(s.filePath)) {
      testReads++;
      testFiles.add(s.filePath);
    } else {
      prodReads++;
      prodFiles.add(s.filePath);
    }
  }
  return { ...row, prodReads, testReads, prodFiles: prodFiles.size, testFiles: testFiles.size };
}

/**
 * No-key path: rank top env keys by prod reads, render the table.
 * Split out so the dispatch in `handleEnvRefs` stays a thin if/else.
 */
function renderEnvKeysTable(
  cg: ReturnType<ToolCtx['getCartograph']>,
  args: Record<string, unknown>,
  includeTests: boolean,
): ToolResult {
  const limit = args['limit'] != null ? clamp(args['limit'] as number, 1, ENV_REFS_LIMIT_MAX) : ENV_REFS_LIMIT_DEFAULT;
  // Pull a wider candidate set so post-filtering by test/prod still
  // produces `limit` rows for prod-heavy keys.
  const rows = getConfigKeys(cg.queries, {
    configKind: 'env',
    limit: limit * ENV_REFS_OVERFETCH_MULTIPLIER,
  });
  // For each candidate key, fetch its sites and split prod / test by
  // path classification. N keys × O(small) sites each — acceptable for
  // the typical project (sub-100 ms total at 30 keys × 10 sites).
  const enriched = rows.map((r) => enrichEnvKey(cg, r));
  const filtered = includeTests ? enriched : enriched.filter((e) => e.prodReads > 0);
  // Rank by prod reads first (real signal), then total — keeps
  // ANTHROPIC_API_KEY ahead of `users`-fixture-style noise.
  filtered.sort((a, b) => b.prodReads - a.prodReads || b.reads - a.reads);
  const shown = filtered.slice(0, limit);

  return textResult(truncateOutput(renderMarkdownTable(buildEnvKeysTableSpec(shown, includeTests))));
}

/**
 * One row of the env-keys table as the renderer sees it — keys + the
 * presentation index that drives the `#` column.
 *
 * Exported alongside {@link buildEnvKeysTableSpec} so the wording-lint
 * test in `__tests__/result-spec.test.ts` can construct an instance
 * and assert on the spec's `title` / `emptyState` / column headers
 * directly (without spinning up a real `Cartograph`).
 */
export interface EnvKeysTableRow {
  i: number;
  configKey: string;
  prodReads: number;
  testReads: number;
  prodFiles: number;
  testFiles: number;
}

/**
 * Build the typed `ResultSpec` for the env-keys table. Pure (no `cg`,
 * no DB I/O) — call sites pass the already-fetched + enriched +
 * sliced rows. The wording-alignment lint imports this and asserts
 * its `title` / column headers / empty-state stay aligned with the
 * tool's `.describe()` text.
 */
export function buildEnvKeysTableSpec(
  shown: ReadonlyArray<Omit<EnvKeysTableRow, 'i'>>,
  includeTests: boolean,
): MarkdownTableSpec<EnvKeysTableRow> {
  const footers = ['Pass `key` to a follow-up call to see exact read sites.'];
  if (!includeTests) footers.push('_test-only env vars hidden (`includeTests: true` to show)._');
  return {
    title: `Environment variables read in this project (top ${shown.length})`,
    emptyState:
      'No env-var reads found. Either the index has no env-var read sites, or `enableConfigRefs` is disabled in config.',
    columns: [
      { header: '#', align: 'right', cell: (r) => String(r.i + 1) },
      { header: 'Env var', cell: (r) => `\`${r.configKey}\`` },
      { header: 'Reads (prod)', align: 'right', cell: (r) => String(r.prodReads) },
      { header: 'Reads (test)', align: 'right', cell: (r) => String(r.testReads) },
      { header: 'Files (prod)', align: 'right', cell: (r) => String(r.prodFiles) },
      { header: 'Files (test)', align: 'right', cell: (r) => String(r.testFiles) },
    ],
    rows: shown.map((r, i) => ({ ...r, i })),
    footers,
  };
}

/** Args bundle for {@link renderEnvKeySites} — mirrors
 *  {@link RenderSqlTableSitesArgs} in sql-refs.ts so the dispatcher
 *  passes `includeTests` explicitly (no redundant re-read from args). */
interface RenderEnvKeySitesArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  key: string;
  rawLimitArg: unknown;
  includeTests: boolean;
}

/** Single-key path: render every read site of the requested env var.
 *  When `includeTests` is false, fixture/test sites are dropped before
 *  slicing — matches the no-key path's filtering semantics. */
function renderEnvKeySites(opts: RenderEnvKeySitesArgs): ToolResult {
  const { cg, key, rawLimitArg, includeTests } = opts;
  const allSites = getConfigRefsByKey(cg.queries, key, { configKind: 'env' });
  if (allSites.length === 0) {
    return textResult(`No reads found for env var "${key}".`);
  }
  // Fixture-directory reads (docs/test-beds/, **/fixtures/) are not real
  // prod usage even though files.is_test = 0 — classify them as non-prod
  // here too, matching enrichEnvKey's table-view counts.
  const isFixtureOrTest = (p: string): boolean => isTestPath(p) || isFixturePath(p);
  const sites = includeTests ? allSites : allSites.filter((s) => !isFixtureOrTest(s.filePath));
  const hiddenTestCount = allSites.length - sites.length;
  if (sites.length === 0) {
    return textResult(
      `No prod reads found for env var "${key}" — ${hiddenTestCount} test-only site${hiddenTestCount === 1 ? '' : 's'} hidden (pass \`includeTests: true\` to see them).`,
    );
  }
  const limit = rawLimitArg != null ? clamp(rawLimitArg as number, 1, ENV_REFS_LIMIT_MAX) : ENV_REFS_LIMIT_DEFAULT;
  const shown = sites.slice(0, limit);
  const { prod: prodCount, test: testCount } = countByTestPath(sites, isFixtureOrTest);
  const truncated = sites.length > shown.length;
  const lines: string[] = [
    `## Reads of \`${key}\` (${sites.length} site${sites.length === 1 ? '' : 's'} — ${prodCount} prod / ${testCount} test${truncated ? `; showing first ${shown.length}` : ''})`,
    '',
    ...shown.map((s) => formatRefSiteLine(s, undefined, isFixtureOrTest)),
  ];
  if (truncated) {
    lines.push(
      '',
      `_${sites.length - shown.length} more sites suppressed by \`limit=${limit}\` — raise \`limit\` to see them._`,
    );
  }
  if (!includeTests && hiddenTestCount > 0) {
    lines.push(
      '',
      `_${hiddenTestCount} test-only site${hiddenTestCount === 1 ? '' : 's'} hidden (\`includeTests: true\` to show)._`,
    );
  }
  return textResult(truncateOutput(lines.join('\n')));
}

export async function handleEnvRefs(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const key = typeof args['key'] === 'string' ? args['key'].trim() : '';
  // includeTests=true (default) keeps test-only keys/sites visible but
  // ranks by prod reads first so fixtures don't dominate.
  // includeTests=false hides test-only keys (no-key path) AND filters
  // test/fixture sites from the per-key site listing.
  const includeTests = args['includeTests'] !== false;
  return key
    ? renderEnvKeySites({ cg, key, rawLimitArg: args['limit'], includeTests })
    : renderEnvKeysTable(cg, args, includeTests);
}
