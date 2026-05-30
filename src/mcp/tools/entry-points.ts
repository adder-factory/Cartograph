/**
 * `cartograph_entry_points` — surface candidate "top of the stack"
 * symbols for an unfamiliar repo. Backlog #10. Answers the agent's
 * first question on a cold open: "where does the program START?"
 *
 * Five buckets, each tiny when empty:
 *   - **Routes**: HTTP handlers (`kind: 'route'`) detected by the
 *     framework resolvers — Express / Laravel / Go HTTP / .NET /
 *     Django / Rails / etc. Each route's `name` carries
 *     `METHOD path` per the framework conventions.
 *   - **CLI commands**: argument-parser subcommands (`kind: 'route'`,
 *     name prefixed `cmd `) extracted by the commander/yargs/caporal/
 *     cac (JS/TS) and cobra (Go) framework resolvers. Each row
 *     corresponds to one `program.command('NAME ...')` call site or
 *     one `&cobra.Command{Use: "NAME ..."}` literal.
 *   - **MCP tools**: exported constants matching the `XXX_TOOL`
 *     shape with a `definition: { name: 'cartograph_*' }` initializer.
 *     These are top-of-stack symbols for any project that registers
 *     tools through Anthropic's Model Context Protocol — every
 *     tool call lands on one of these. Detected by signature pattern,
 *     not framework resolver.
 *   - **CLI files**: exported function/class symbols whose file path
 *     lives under `bin/` or `cli/` — a coarser heuristic for CLI
 *     surfaces where an arg-parser framework wasn't detected.
 *   - **Public exports**: `isExported = true` symbols that have NO
 *     incoming `calls` edges. The "no internal callers" filter
 *     surfaces the actual public surface (consumed only externally
 *     by importers of the package) instead of every exported symbol.
 *
 * All five buckets filter out test paths (`isTestPath`) so test
 * helpers and fixtures (e.g. `export function fakeServer()` in
 * `__tests__/helpers.ts`) do not crowd the agent-facing report.
 *
 * Output stays markdown so the agent can pick a row and chain to
 * `cartograph_callers` / `cartograph_node` without reformatting.
 *
 * Cap each bucket at MAX_PER_BUCKET to keep the response compact;
 * the agent typically scans the top of each section to orient.
 */

import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { getIncomingEdges } from '../../db/queries-edges.js';
import { getNodesByKind } from '../../db/queries.js';
import type Cartograph from '../../index.js';
import type { Node } from '../../types.js';
import { isTestPath } from '../../utils.js';
import { TYPE_USAGE_EDGE_KINDS } from './shared.js';
import { renderToolResponse } from './_response.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';

/**
 * Edge kinds the public-exports orphan predicate treats as "in-tree caller".
 * Conservatively approximates the default set walked by
 * `cartograph_graph({direction: 'callers'})`. `traverser.getCallers` follows
 * `calls` / `references` / `imports`, and `_callers.ts` adds the type-usage
 * kinds ONLY when the source is a type-like node. This list applies the
 * type-usage kinds UNCONDITIONALLY (regardless of source kind) — strictly
 * more permissive, in the correct direction: a permissive predicate suppresses
 * false orphan flags rather than introducing them. The 2026-05-11 binding-table
 * fix made dispatch-table assignments (`XXX_TOOL.handle = handleX`) emit
 * `references` edges; previously the public-exports bucket filtered to
 * `['calls']` only and flagged every `handleX` as a "no in-tree callers"
 * public surface.
 *
 * We OMIT `imports` deliberately: a stray `import { foo } from '…'` with
 * no usage shouldn't disqualify `foo` from the public-surface bucket
 * (the importer is the one we want to surface, not the importee).
 */
const PUBLIC_EXPORT_CALLER_EDGE_KINDS: import('../../types.js').Edge['kind'][] = [
  'calls',
  'references',
  ...TYPE_USAGE_EDGE_KINDS,
];

/** Default per-bucket cap (matches the legacy pre-pagination behavior). */
const MAX_PER_BUCKET = 20;
/** Hard ceiling on `limit` (200) — FRICTION-2 pagination knob. `limit` is
 *  clamped to [1, 200]; pair with `bucket` to page into a single section's
 *  long tail rather than scanning all five buckets at once. */
const MAX_LIMIT = 200;

/** Bucket selector values for the optional `bucket` arg. Must match the
 *  EntryReport field names so the handler can dispatch directly. */
type BucketKey = 'routes' | 'cliCommands' | 'mcpTools' | 'cliFiles' | 'publicExports';
/** Public enum surfaced through the MCP schema. Snake-case so the agent
 *  doesn't have to guess between cliFiles vs cli_files. */
type BucketArg = 'routes' | 'cli' | 'mcp_tools' | 'cli_files' | 'public_exports';
const BUCKET_ARG_TO_KEY: Record<BucketArg, BucketKey> = {
  routes: 'routes',
  cli: 'cliCommands',
  mcp_tools: 'mcpTools',
  cli_files: 'cliFiles',
  public_exports: 'publicExports',
};

interface EntryReport {
  routes: Node[];
  cliCommands: Node[];
  mcpTools: Node[];
  cliFiles: Node[];
  publicExports: Node[];
  /** True when any bucket was capped — formatter shows "(+N more, capped)". */
  capped: { routes: number; cliCommands: number; mcpTools: number; cliFiles: number; publicExports: number };
  /**
   * Diagnostics for buckets that came back empty in the *production*
   * filter but DO have nodes in test fixtures / CLI. Lets the formatter
   * print an honest "none in production source (N exist in fixtures)"
   * note instead of silently dropping the bucket — or, worse, declaring
   * the whole project "internal-only" when 79 route nodes exist.
   */
  diag: {
    /** Total `kind:'route'` nodes incl. test fixtures + `cmd ` CLI nodes. */
    totalRouteNodes: number;
    /** Test-fixture-only HTTP routes (would-be `routes` rows in fixtures). */
    fixtureHttpRoutes: number;
    /** `cmd `-prefixed CLI-command route nodes in PRODUCTION source
     *  (test-path nodes excluded — those land in {@link fixtureCliCommandNodes}).
     *  This is the count the CLI commands bucket actually renders. */
    cliCommandNodes: number;
    /** `cmd `-prefixed CLI-command route nodes that live under a test
     *  path. Counted separately so the routes/CLI-files empty-bucket
     *  notes don't mis-attribute fixture CLI nodes as production
     *  commands (audit #18). */
    fixtureCliCommandNodes: number;
  };
}

/**
 * Match a `*_TOOL` constant initializer that registers an MCP tool.
 * The shape is universal across every tool module:
 *   `export const XXX_TOOL: ToolModule = { definition: { name: 'cartograph_X', ... } ... }`
 * Detection uses the signature column (first ~100 chars of initializer)
 * so we don't need a follow-up edge query. The regex tolerates either
 * quote style and intermediate whitespace.
 */
const MCP_TOOL_NAME_RE = /name:\s*['"]([a-z_][a-z0-9_]*)['"]/i;
function detectMcpToolName(n: Node): string | null {
  if (n.kind !== 'constant') return null;
  if (!n.isExported) return null;
  if (!n.signature) return null;
  // Cheap two-substring guard — must mention `name:` AND `cartograph_`
  // somewhere in the signature window before we run the regex. The
  // looser check (vs. the previous `name: 'cartograph_` literal) lets
  // us also match a signature with no space after the colon
  // (`name:'cartograph_X'`), matching what the regex would already
  // accept. False positives here are filtered by the regex anyway.
  if (!n.signature.includes('name:') || !n.signature.includes('cartograph_')) return null;
  const m = MCP_TOOL_NAME_RE.exec(n.signature);
  return m ? m[1]! : null;
}

/** CLI-command route nodes are emitted with the `cmd ` name prefix by
 *  the commander/yargs/caporal/cac (JS/TS) and cobra (Go) framework
 *  resolvers. Exported so `cartograph_digest` can filter them out of its
 *  HTTP-routes section. */
export function isCliCommandRoute(n: Node): boolean {
  return n.kind === 'route' && n.name.startsWith('cmd ');
}

/**
 * Collect exported nodes that have no in-tree callers according to the
 * full {@link PUBLIC_EXPORT_CALLER_EDGE_KINDS} set (`calls` +
 * `references` + type-usage edges). The result is the canonical
 * "public surface" predicate shared by `cartograph_entry_points` (the
 * `publicExports` bucket) and `cartograph_digest` (the "Public exports"
 * sub-section) so that both tools agree on which symbols qualify.
 *
 * @param cg          - Live Cartograph instance.
 * @param cap         - Maximum number of nodes to return. Iteration
 *                      stops as soon as the cap is reached so callers
 *                      with a small cap (e.g. digest's top-5) pay only
 *                      proportional edge-query cost.
 * @param skipCliPaths - When `true` (default), nodes whose file path is
 *                      under `bin/`, `cli/`, or `commands/` are omitted.
 *                      `cartograph_digest` sets this to `true` because
 *                      the CLI surface is surfaced separately; the
 *                      entry-points tool sets it to `false` and routes
 *                      those nodes to the `cliFiles` bucket instead.
 */
export function collectPublicExportNodes(
  cg: ReturnType<ToolCtx['getCartograph']>,
  cap: number,
  skipCliPaths = true,
): Node[] {
  const exportedNodes = collectExportedDefinitions(cg);
  const out: Node[] = [];
  for (const n of exportedNodes) {
    if (out.length >= cap) break;
    if (skipCliPaths && isUnderCliPath(n.filePath)) continue;
    const callers = getIncomingEdges(cg.queries, n.id, PUBLIC_EXPORT_CALLER_EDGE_KINDS);
    if (callers.length === 0) out.push(n);
  }
  return out;
}

function isUnderCliPath(filePath: string): boolean {
  // bin/, cli/, commands/, command/ at any depth — the conventions
  // converge across tooling stacks.
  return /(?:^|\/)(?:bin|cli|commands?)\//.test(filePath);
}

/**
 * Zod schema for `cartograph_entry_points`.
 *
 * `limit` is `.int().min(1).max(MAX_LIMIT)` — the legacy handler
 * clamped to `[1, MAX_LIMIT]`; under the locked reject-out-of-range
 * policy an out-of-range / non-integer value is now REJECTED at the
 * dispatch boundary, so the handler drops the `clamp(numArg(...))`.
 */
const entryPointsSchema = z.object({
  bucket: z
    .enum(['routes', 'cli', 'mcp_tools', 'cli_files', 'public_exports'])
    .optional()
    .describe('Narrow the report to ONE bucket so its capped long tail is reachable. Omit to return all five buckets.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(MAX_PER_BUCKET)
    .describe('Per-bucket row cap; integer in [1, 200], default 20. Pair with `bucket` to page into one section.'),
  projectPath: projectPathField,
});

type EntryPointsArgs = z.infer<typeof entryPointsSchema>;

/** Shared inputs for a single bucket-collection phase — bundled so the
 *  per-phase collectors stay under the long-parameter-list floor. */
interface BucketPhaseArgs {
  cg: Cartograph;
  report: EntryReport;
  limit: number;
  wants: (k: BucketKey) => boolean;
}

/**
 * Routes phase — split `kind:'route'` nodes into HTTP routes and CLI
 * commands, populate the route/cliCommand buckets, and record the
 * fixture/CLI diagnostic counts. Drops test-bed fixtures so
 * `app.get('/foo')` patterns inside `__tests__/` don't crowd out real
 * handlers from `src/` (same pattern as cartograph_digest). Mutates
 * `report` in place.
 */
function collectRouteBuckets({ cg, report, limit, wants }: BucketPhaseArgs): void {
  // Pull the *unfiltered* set first so the formatter can give an honest
  // "N route nodes exist in test fixtures / CLI" note when the
  // production-filtered bucket comes back empty (rather than declaring
  // the project internal-only).
  const allRouteNodes = getNodesByKind(cg.queries, 'route');
  report.diag.totalRouteNodes = allRouteNodes.length;
  report.diag.fixtureHttpRoutes = allRouteNodes.filter((n) => isTestPath(n.filePath) && !isCliCommandRoute(n)).length;
  // Split `cmd `-prefixed CLI commands by production-vs-test path so
  // the empty-bucket notes report an honest fixture/CLI breakdown
  // (audit #18 — the old single `cliCommandNodes` count folded
  // fixture CLI commands into the "production CLI commands" figure).
  report.diag.cliCommandNodes = allRouteNodes.filter((n) => isCliCommandRoute(n) && !isTestPath(n.filePath)).length;
  report.diag.fixtureCliCommandNodes = allRouteNodes.filter(
    (n) => isCliCommandRoute(n) && isTestPath(n.filePath),
  ).length;
  const allRoutes = allRouteNodes.filter((n) => !isTestPath(n.filePath));
  if (wants('routes')) {
    const httpRoutes = allRoutes.filter((n) => !isCliCommandRoute(n));
    if (httpRoutes.length > limit) report.capped.routes = httpRoutes.length - limit;
    report.routes = httpRoutes.slice(0, limit);
  }
  if (wants('cliCommands')) {
    const cliRoutes = allRoutes.filter(isCliCommandRoute);
    if (cliRoutes.length > limit) report.capped.cliCommands = cliRoutes.length - limit;
    report.cliCommands = cliRoutes.slice(0, limit);
  }
}

/**
 * MCP-tools phase — surface `XXX_TOOL` constants with a
 * `definition: { name: 'cartograph_*' }` shape and populate the
 * mcpTools bucket. Closes the "where does an MCP request enter?" gap:
 * every cartograph_* call lands on one of these constants' `.handle`
 * property; the public exports bucket misses them because they have a
 * same-file references edge (FIND_TOOL → handleFind), not a calls
 * edge. Mutates `report` in place.
 */
function collectMcpToolBucket({ cg, report, limit }: BucketPhaseArgs): void {
  const mcpToolNodes = getNodesByKind(cg.queries, 'constant')
    .filter((n) => !isTestPath(n.filePath))
    .filter((n) => detectMcpToolName(n) !== null);
  // FRICTION-I (2026-05-14): sort by the parsed canonical `cartograph_X`
  // name BEFORE applying the per-bucket cap. The underlying nodes-by-kind
  // walk surfaces tool constants in registration order (AFFECTED → ASK →
  // … → TESTS_FOR), and at default `limit: 20` the late-registered
  // high-traffic tools (CONTEXT, FIND, GRAPH, STATUS, BIOMARKERS, NODE,
  // HISTORY) get truncated. Alphabetising the canonical tool name gives
  // the agent a stable, scannable index and stops the cap from hiding
  // the most-used tools.
  mcpToolNodes.sort((a, b) => {
    const an = detectMcpToolName(a) ?? '';
    const bn = detectMcpToolName(b) ?? '';
    return an.localeCompare(bn);
  });
  if (mcpToolNodes.length > limit) report.capped.mcpTools = mcpToolNodes.length - limit;
  report.mcpTools = mcpToolNodes.slice(0, limit);
}

async function handleEntryPoints(ctx: ToolCtx, args: EntryPointsArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  // FRICTION-2 pagination knobs. `limit` caps each bucket (default = legacy
  // MAX_PER_BUCKET). `bucket` narrows the report to one section so callers
  // can drill into the long tail without grepping a 200-row dump.
  // `limit` is already an integer in [1, MAX_LIMIT] — Zod rejected
  // anything else at the dispatch boundary; no clamp needed.
  const limit = args.limit;
  const selectedBucket = args.bucket ? BUCKET_ARG_TO_KEY[args.bucket] : null;
  /** True when this bucket should be populated for the current call. */
  const wants = (k: BucketKey): boolean => selectedBucket === null || selectedBucket === k;

  const report: EntryReport = {
    routes: [],
    cliCommands: [],
    mcpTools: [],
    cliFiles: [],
    publicExports: [],
    capped: { routes: 0, cliCommands: 0, mcpTools: 0, cliFiles: 0, publicExports: 0 },
    diag: { totalRouteNodes: 0, fixtureHttpRoutes: 0, cliCommandNodes: 0, fixtureCliCommandNodes: 0 },
  };

  const phaseArgs: BucketPhaseArgs = { cg, report, limit, wants };

  // === Routes — split kind:'route' into HTTP routes and CLI commands ===
  if (wants('routes') || wants('cliCommands')) {
    collectRouteBuckets(phaseArgs);
  }

  // === MCP tools — XXX_TOOL constants with `definition: { name: 'cartograph_*' }` ===
  if (wants('mcpTools')) {
    collectMcpToolBucket(phaseArgs);
  }

  // === CLI files (path heuristic) + Public exports — single sweep over exported nodes ===
  if (wants('cliFiles') || wants('publicExports')) {
    const exportedNodes = collectExportedDefinitions(cg);
    const { cliCandidates, publicCandidates } = bucketEntryPointCandidates(cg, exportedNodes);

    if (wants('cliFiles')) {
      if (cliCandidates.length > limit) report.capped.cliFiles = cliCandidates.length - limit;
      report.cliFiles = cliCandidates.slice(0, limit);
    }
    if (wants('publicExports')) {
      if (publicCandidates.length > limit) report.capped.publicExports = publicCandidates.length - limit;
      report.publicExports = publicCandidates.slice(0, limit);
    }
  }

  return ok(renderToolResponse({ body: formatReport(cg, report, selectedBucket) }));
}

/**
 * Pull exported function/method/class nodes once, deduped by id.
 * Test paths are excluded (`isTestPath`) so test helpers (e.g.
 * `export function fakeServer()` in `__tests__/helpers.ts`) do not
 * leak into the CLI-files or public-exports buckets.
 */
function collectExportedDefinitions(cg: ReturnType<ToolCtx['getCartograph']>): Node[] {
  const exportedKinds: Array<Node['kind']> = ['function', 'method', 'class'];
  const seen = new Set<string>();
  const out: Node[] = [];
  for (const k of exportedKinds) {
    for (const n of getNodesByKind(cg.queries, k)) {
      if (isTestPath(n.filePath)) continue;
      if (!n.isExported) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

/**
 * Bucket each exported node into `cliCandidates` (under a CLI path) or
 * `publicCandidates` (zero incoming edges per the full
 * {@link PUBLIC_EXPORT_CALLER_EDGE_KINDS} set — the public boundary).
 * Dead-code overlap is acceptable: surfacing a dead symbol as "entry point"
 * is mildly noisy, not wrong.
 *
 * Note: `publicCandidates` uses the same predicate as
 * {@link collectPublicExportNodes} (with `skipCliPaths = false`) so the two
 * paths can never silently diverge. `collectPublicExportNodes` is the
 * exported form; this helper keeps the cli/public split logic local to the
 * handler where cap is applied per-bucket.
 */
function bucketEntryPointCandidates(
  cg: ReturnType<ToolCtx['getCartograph']>,
  exportedNodes: Node[],
): { cliCandidates: Node[]; publicCandidates: Node[] } {
  const cliCandidates: Node[] = [];
  const publicCandidates: Node[] = [];
  for (const n of exportedNodes) {
    if (isUnderCliPath(n.filePath)) {
      cliCandidates.push(n);
      continue;
    }
    // FRICTION-K (2026-05-14): match the default edge-kind set walked by
    // `cartograph_graph({direction: 'callers'})` so the public-exports
    // predicate doesn't disagree with the callers tool. The pre-2026-05-14
    // filter looked at `['calls']` only and missed dispatch-table bindings
    // (`XXX_TOOL.handle = handleX`) which emit `references` edges — every
    // `handleX` MCP handler was flagged as "no in-tree callers" despite the
    // graph clearly showing 2+ callers. See `PUBLIC_EXPORT_CALLER_EDGE_KINDS`
    // at module top for the full set and rationale.
    const callers = getIncomingEdges(cg.queries, n.id, PUBLIC_EXPORT_CALLER_EDGE_KINDS);
    if (callers.length === 0) publicCandidates.push(n);
  }
  return { cliCandidates, publicCandidates };
}

/**
 * One-line "why this bucket is empty" note for the default no-arg
 * view. Returns `null` when the bucket should just be dropped silently
 * (genuinely nothing to say). Currently only `routes` and `cliFiles`
 * carry a note — both can be empty in production source while route /
 * CLI nodes still exist in test fixtures, and a silent drop hides that.
 */
function emptyBucketNote(bucket: BucketKey, diag: EntryReport['diag']): string | null {
  if (bucket === 'routes') {
    if (diag.totalRouteNodes === 0) return null;
    // Honest partition of totalRouteNodes: fixture routes (HTTP + CLI)
    // vs production CLI commands. `cliCommandNodes` is now production-
    // only, so fixture CLI commands are folded into the fixtures count.
    const fixtures = diag.fixtureHttpRoutes + diag.fixtureCliCommandNodes;
    return `_routes: none in production source (${diag.totalRouteNodes} \`route\` node(s) exist — ${fixtures} in test fixtures, ${diag.cliCommandNodes} production CLI commands; see the CLI commands bucket or \`bucket: 'routes'\`)._`;
  }
  if (bucket === 'cliFiles') {
    if (diag.cliCommandNodes === 0) return null;
    return `_CLI files: none under \`bin/\`/\`cli/\` in production source (${diag.cliCommandNodes} production CLI command node(s) detected — see the CLI commands bucket)._`;
  }
  return null;
}

/** Accurate empty-result message for a single-bucket (`bucket:` arg) call. */
function singleBucketEmptyMessage(bucket: BucketKey, diag: EntryReport['diag']): string {
  if (bucket === 'routes') {
    if (diag.totalRouteNodes === 0) {
      return "_No `route` nodes detected anywhere in the index. This may be a library / internal-only project, or the index hasn't picked up the framework's routing patterns. Try `cartograph_files` for the layout._";
    }
    const fixtures = diag.fixtureHttpRoutes + diag.fixtureCliCommandNodes;
    return `_No HTTP routes in production source. The index DOES hold ${diag.totalRouteNodes} \`route\` node(s): ${fixtures} in test fixtures (filtered out of this bucket) and ${diag.cliCommandNodes} production CLI commands (\`cmd \`-prefixed — see \`bucket: 'cli'\`). This is NOT necessarily an internal-only project._`;
  }
  return `_No entries in the \`${bucket}\` bucket. Try \`cartograph_entry_points\` with no \`bucket\` arg for the full breakdown._`;
}

function formatReport(cg: Cartograph, r: EntryReport, selectedBucket: BucketKey | null): string {
  // `shown` = rows actually rendered (post-cap). `total` = the TRUE
  // entry-point count: every bucket's pre-cap size. `r.capped.X` holds
  // `realCount - limit` for a capped bucket (0 otherwise), so the real
  // per-bucket count is `displayed + capped`. The header reports the
  // true total; a "showing N of M" clause appears when the cap hid
  // rows — previously the header echoed only `shown` and understated
  // reality by more than half (audit Group 2 #4-5).
  const shown = r.routes.length + r.cliCommands.length + r.mcpTools.length + r.cliFiles.length + r.publicExports.length;
  const total =
    shown + r.capped.routes + r.capped.cliCommands + r.capped.mcpTools + r.capped.cliFiles + r.capped.publicExports;
  if (shown === 0) {
    // A single-bucket call gets a bucket-specific, accurate message —
    // never the blanket "internal-only project" claim when route nodes
    // demonstrably exist (just not in production source).
    if (selectedBucket !== null) {
      return ['## Entry points', '', singleBucketEmptyMessage(selectedBucket, r.diag)].join('\n');
    }
    return [
      '## Entry points',
      '',
      "_No routes, CLI handlers, MCP tools, or public exports detected. This may be a library / internal-only project, or the index hasn't picked up framework patterns. Try `cartograph_files` to see the project layout, or `cartograph_find (by='name')` for a known-name lookup._",
    ].join('\n');
  }
  const root = cg.projectRoot;
  // When the per-bucket cap hid rows, the header says "showing N of M"
  // so the agent knows it has NOT seen every entry point. `bucket:` +
  // `limit` pages into the long tail.
  const headerCount =
    total > shown ? `${total} total — showing ${shown}; pass \`bucket\` + \`limit\` to page` : `${total} total`;
  const lines: string[] = [
    `## Entry points (${headerCount})`,
    '',
    `Top-of-stack symbols for \`${root}\` — pair with \`cartograph_graph({direction: 'callers'})\` to see who depends on each, or \`cartograph_node\` for source.`,
    '',
  ];
  // Routes-bucket reconciliation footnote: `cartograph_status` reports
  // every `kind:route` node (production + test fixture + CLI), so an
  // agent who saw "73 routes" there but "44 total" here would have to
  // reverse-engineer the partition. Surface it inline when test-fixture
  // routes exist so the discrepancy is reconcilable at-a-glance.
  const fixtureRoutes = r.diag.fixtureHttpRoutes + r.diag.fixtureCliCommandNodes;
  if (fixtureRoutes > 0 && r.diag.totalRouteNodes > 0) {
    const httpProd = r.diag.totalRouteNodes - fixtureRoutes - r.diag.cliCommandNodes;
    lines.push(
      `_Routes total: ${r.diag.totalRouteNodes} \`kind:route\` nodes in the index — ${httpProd} HTTP in production, ${r.diag.cliCommandNodes} CLI in production, ${fixtureRoutes} in test fixtures (filtered out of this view)._`,
      '',
    );
  }
  // In the default no-arg view an empty bucket is no longer dropped
  // silently — `emptyNote` surfaces a one-liner when route/CLI nodes
  // exist only in fixtures so the agent isn't misled into thinking the
  // project has no routes at all.
  const showNotes = selectedBucket === null;
  const bucketSpecs = [
    buildEntryPointsBucketSpec({
      kind: 'routes',
      nodes: r.routes,
      cappedExtra: r.capped.routes,
      emptyNote: showNotes ? emptyBucketNote('routes', r.diag) : null,
    }),
    buildEntryPointsBucketSpec({
      kind: 'cliCommands',
      nodes: r.cliCommands,
      cappedExtra: r.capped.cliCommands,
      emptyNote: null,
    }),
    buildEntryPointsBucketSpec({
      kind: 'mcpTools',
      nodes: r.mcpTools,
      cappedExtra: r.capped.mcpTools,
      emptyNote: null,
    }),
    buildEntryPointsBucketSpec({
      kind: 'cliFiles',
      nodes: r.cliFiles,
      cappedExtra: r.capped.cliFiles,
      emptyNote: showNotes ? emptyBucketNote('cliFiles', r.diag) : null,
    }),
    buildEntryPointsBucketSpec({
      kind: 'publicExports',
      nodes: r.publicExports,
      cappedExtra: r.capped.publicExports,
      emptyNote: null,
    }),
  ];
  for (const spec of bucketSpecs) {
    if (spec.rows.length === 0 && (spec.emptyNote == null || spec.emptyNote === '')) continue;
    lines.push(renderMarkdownBulletList(spec));
  }
  return lines.join('\n');
}

/** Bucket-kind discriminator on the entry-points report. Each value
 *  maps to one of the five sub-sections rendered by {@link formatReport}
 *  and pins the user-facing label + heading-level + row-format choice
 *  in {@link buildEntryPointsBucketSpec}. */
export type EntryPointsBucketKind = 'routes' | 'cliCommands' | 'mcpTools' | 'cliFiles' | 'publicExports';

/** Args for {@link buildEntryPointsBucketSpec}. Bundled so the
 *  builder stays under the 4-param `long_parameter_list` info floor
 *  even when called with all four fields. */
export interface BuildEntryPointsBucketSpecArgs {
  readonly kind: EntryPointsBucketKind;
  readonly nodes: ReadonlyArray<Node>;
  readonly cappedExtra: number;
  readonly emptyNote: string | null;
}

/** User-facing label for each bucket — owned ON the spec so the
 *  wording-alignment lint walks the labels. */
const ENTRY_POINTS_BUCKET_LABELS: Record<EntryPointsBucketKind, string> = {
  routes: 'Routes (HTTP handlers)',
  cliCommands: 'CLI commands (commander / yargs / caporal / cac)',
  mcpTools: 'MCP tools (XXX_TOOL constants)',
  cliFiles: 'CLI files (under bin/ or cli/)',
  publicExports: 'Public exports (no in-tree callers)',
};

/**
 * Build the typed `MarkdownBulletListSpec` for one entry-points
 * bucket. Pure — call sites pass the already-filtered nodes + the
 * cap-overflow count + the optional empty note. Heading-level is
 * always 3 (each bucket renders under the top-level `## Entry
 * points` H2 emitted by the composing handler). The MCP-tools
 * bucket overrides the row formatter to surface the parsed
 * `cartograph_*` tool name instead of the long
 * `= { definition: { ... }, ... }` initializer signature.
 */
export function buildEntryPointsBucketSpec(args: BuildEntryPointsBucketSpecArgs): MarkdownBulletListSpec<Node> {
  const { kind, nodes, cappedExtra, emptyNote } = args;
  const label = ENTRY_POINTS_BUCKET_LABELS[kind];
  const cap = cappedExtra > 0 ? ` (+${cappedExtra} more, capped)` : '';
  const title = nodes.length === 0 ? `${label} (0)` : `${label} (${nodes.length}${cap})`;
  const formatRow =
    kind === 'mcpTools'
      ? (n: Node): string => {
          const toolName = detectMcpToolName(n);
          const loc = n.startLine ? `:${n.startLine}` : '';
          const tag = toolName ? ` \`${toolName}\`` : '';
          return `- **${n.name}** (mcp tool)${tag} — ${n.filePath}${loc}`;
        }
      : (n: Node): string => {
          const loc = n.startLine ? `:${n.startLine}` : '';
          const sig = n.signature ? ` \`${n.signature}\`` : '';
          return `- **${n.name}** (${n.kind}) — ${n.filePath}${loc}${sig}`;
        };
  return {
    title,
    headingLevel: 3,
    rows: nodes,
    formatRow,
    // emptyState is never rendered by the composing handler — the
    // outer `formatReport` short-circuits at `shown === 0` with its
    // own composite empty messages. Surface a placeholder so the
    // spec interface is satisfied; the lint walks it for vocabulary
    // alignment with the bucket label.
    emptyState: `No entries in the \`${kind}\` bucket.`,
    emptyNote,
  };
}

/* `appendBucket` removed — superseded by {@link buildEntryPointsBucketSpec}
 * + `renderMarkdownBulletList`. The bucket label / heading-level /
 * row-format choice now lives on the typed spec; the per-bucket
 * compose loop is in `formatReport`. */

export const ENTRY_POINTS_TOOL = defineTool({
  name: 'cartograph_entry_points',
  description:
    'Top-of-stack symbols — "where does the program start?".\n\n' +
    'Five buckets (default cap 20 each, raise via `limit`): HTTP routes, CLI commands, MCP tools (XXX_TOOL constants, sorted by canonical name), CLI files (bin/ or cli/ exports), and public exports with no incoming calls/references/type-usage edges. ' +
    "Pass `bucket` to drill into one section (e.g. `bucket: 'public_exports', limit: 200`).",
  schema: entryPointsSchema,
  handle: handleEntryPoints,
});
