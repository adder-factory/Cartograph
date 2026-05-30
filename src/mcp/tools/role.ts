import { z } from 'zod';
import { projectPathField, batchedSymbols, BATCHED_SYMBOLS_MAX } from './_common-fields.js';
import {
  findNodesByRole,
  getRoleCounts,
  getNonClassifierTargetNodeCount,
  getUnclassifiedTargetNodeCount,
  upsertSymbolRole,
} from '../../db/queries-roles.js';
import { getSymbolDescriptions } from '../../db/queries-summaries.js';
import { classifyByStructure, STRUCTURAL_ROLE_MODEL } from '../../llm/classifier.js';
import { displayModelName, validateStringOutcome } from './shared.js';
import { renderToolResponse } from './_response.js';
import { renderMarkdownTable, type MarkdownTableSpec } from './_result-spec.js';
import type { ToolCtx } from './types.js';
import type { RefIdCache } from './_id-cache.js';
import { resolveSymbolToNode, symbolNotFound } from './symbol-resolver.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';

/** Maximum number of symbols accepted in a single batch get-role-of call. */
const ROLE_BATCH_LIMIT = BATCHED_SYMBOLS_MAX;
/** Default limit for list-by-role results. */
const ROLE_LIST_DEFAULT_LIMIT = 50;
/** Maximum limit for list-by-role results. */
const ROLE_LIST_MAX_LIMIT = 500;

/** Classifier axis for the on-demand role path. The role head was
 *  removed (it was nomic-trained and inert against the jina embedder),
 *  so the on-demand cascade is structural-only — `rule` and `auto`
 *  behave identically; `llm` is not supported on the on-demand path. */
type ClassifierVia = 'rule' | 'llm' | 'auto';

/**
 * Fetch role + role_model for a single node id.
 * Returns null fields when the node hasn't been classified yet.
 */
function getNodeRoleInfo(
  cg: import('../../index.js').default,
  nodeId: string,
): { role: string | null; roleModel: string | null } {
  const row = cg.queries.db.prepare('SELECT role, role_model FROM nodes WHERE id = ?').get(nodeId) as
    | { role: string | null; role_model: string | null }
    | undefined;
  if (!row) return { role: null, roleModel: null };
  return { role: row.role, roleModel: row.role_model };
}

/**
 * On-demand role inference for unclassified nodes.
 *
 * When `getRoleOf` is called on a node whose `role` is NULL — the
 * symbol exists but the bulk classifier pass hasn't covered it (newly
 * added since the last `classify`, or no summary/docstring so it never
 * entered the candidate pool) — run the structural pre-filter so the
 * agent gets an answer immediately rather than the bare "unknown".
 *
 * Structural-only: fires on kind / test-file path / framework-handler
 * signature. No model load, no embedding, ~5 µs. Returns the inferred
 * label + the model tag to stamp, or null when the rules don't fire
 * (caller keeps the "unknown" placeholder). Persists via
 * `upsertSymbolRole` so subsequent queries hit the cache. The richer
 * LLM classification runs only in the bulk
 * `cartograph_admin({action: 'classify'})` pass.
 */
/** @internal Arguments for {@link inferRoleOnDemand}. */
interface InferRoleOnDemandArgs {
  cg: import('../../index.js').default;
  nodeId: string;
  via: ClassifierVia;
}

interface InferRoleResult {
  role: string;
  roleModel: string;
}

function inferRoleOnDemand({ cg, nodeId, via }: InferRoleOnDemandArgs): InferRoleResult | null {
  // `via='llm'` has no on-demand path (handled earlier with a helpful
  // error); `rule` and `auto` both run the structural pre-filter.
  if (via === 'llm') return null;
  const node = cg.queries.getNodeById(nodeId);
  if (!node) return null;
  const structural = classifyByStructure({
    kind: node.kind,
    name: node.name,
    filePath: node.filePath,
    signature: node.signature ?? null,
  });
  if (!structural) return null;
  upsertSymbolRole(cg.queries, nodeId, { role: structural, roleModel: STRUCTURAL_ROLE_MODEL });
  return { role: structural, roleModel: STRUCTURAL_ROLE_MODEL };
}

/** @internal Arguments for {@link renderGetRoleOfBlock}. */
interface RenderGetRoleOfBlockArgs {
  cg: import('../../index.js').default;
  nodeId: string;
  label: string;
  via: ClassifierVia;
  /** Non-empty when the `symbol` arg resolved only via a fuzzy FTS
   *  guess — prepended so the agent never reads a role for a symbol
   *  that doesn't exist under the queried name. */
  fuzzyBanner: string;
}

/** @internal Arguments for {@link renderUnknownDiagnostic}. */
interface RenderUnknownDiagnosticArgs {
  desc: { source: string; text: string } | undefined;
  /** Source signature of the symbol — used to detect handler-shaped
   *  signatures whose structural rule didn't match. Null / undefined
   *  when the symbol carries no signature. */
  signature: string | null | undefined;
}

/**
 * Tokens that strongly suggest a framework handler signature. When the
 * structural classifier returns null on a symbol whose signature
 * contains one of these, the supported-shape hint in
 * {@link renderUnknownDiagnostic} fires so the agent knows the
 * classifier's catalog and can either rewrite the signature to a
 * supported shape or file an issue with the exact unmatched form.
 */
const HANDLER_SIGNATURE_TOKENS = [
  'gin.Context',
  'echo.Context',
  'fiber.Ctx',
  'cobra.Command',
  'http.ResponseWriter',
  'APIGatewayProxyHandler',
  'RequestHandler',
  'RouteHandler',
  'HttpHandler',
];

/** @internal — exported for unit testing the handler-token detector. */
export function signatureLooksLikeHandler(signature: string | null | undefined): boolean {
  if (!signature) return false;
  return HANDLER_SIGNATURE_TOKENS.some((tok) => signature.includes(tok));
}

/**
 * Render the `**Why unknown:**` lines for an unknown verdict.
 *
 *   - No description → the symbol had no input at all; guide the agent
 *     at the summarize/classify pipeline.
 *   - Description present → the bulk classifier saw a summary/docstring
 *     and still returned unknown; guide the agent at refining it.
 *   - Signature shows a known handler token (gin.Context / cobra.Command
 *     / http.ResponseWriter etc.) → append a supported-shape hint so the
 *     agent knows the structural classifier's catalog. Rare in practice
 *     since most of these ARE in `GO_HANDLER_RE` / `REQ_RES_PAIR_RE` /
 *     `HANDLER_TYPE_RE` — fires when a near-match shape didn't quite
 *     line up with the regex.
 */
function renderUnknownDiagnostic({ desc, signature }: RenderUnknownDiagnosticArgs): string[] {
  const lines: string[] = ['', '**Why unknown:**'];
  if (desc) {
    lines.push(
      `  The classifier had a ${desc.source} but still returned unknown — the text may be too short, ` +
        'too generic, or the model was low-confidence. Review the input above and consider adding a docstring.',
    );
  } else {
    lines.push(
      '  The classifier had no input — this symbol has no LLM summary, no docstring, and no test coverage. ' +
        'Run `cartograph summarize` to generate a summary, then re-run `cartograph classify`.',
    );
  }
  if (signatureLooksLikeHandler(signature)) {
    lines.push(
      '  Signature contains a recognized handler token but the structural classifier did not match. ' +
        'Supported shapes: Express `(req, res)`, Go `*gin.Context` / `*cobra.Command` / `http.ResponseWriter, *http.Request` / `echo.Context` / `*fiber.Ctx`, ' +
        'NestJS `@Body`/`@Param`/`@Query` decorators, AWS `APIGatewayProxyHandler`. ' +
        'If the signature should match one of these but did not, file the exact form so the regex can be widened.',
    );
  }
  return lines;
}

/** Render the get-role-of block for one resolved symbol. */
function renderGetRoleOfBlock({ cg, nodeId, label, via, fuzzyBanner }: RenderGetRoleOfBlockArgs): string[] {
  let { role, roleModel } = getNodeRoleInfo(cg, nodeId);
  const descs = getSymbolDescriptions(cg.queries, [nodeId]);
  const desc = descs.get(nodeId);
  const signature = cg.queries.getNodeById(nodeId)?.signature ?? null;

  // When a symbol hasn't been classified by the bulk pass, try the
  // on-demand structural pre-filter (free) and persist the result so
  // future queries are cached.
  let inferredOnDemand = false;
  // True once the structural pre-filter has been *attempted* for this
  // node — distinguishes "the on-demand pass ran and matched nothing"
  // from "no classification has been attempted at all". `via='llm'`
  // skips the pass (handled with an error upstream for get-role-of),
  // so this tracks the real cascade state rather than assuming it ran.
  let onDemandAttempted = false;
  if (role === null) {
    onDemandAttempted = via !== 'llm';
    const inferred = inferRoleOnDemand({ cg, nodeId, via });
    if (inferred) {
      role = inferred.role;
      roleModel = inferred.roleModel;
      inferredOnDemand = true;
    }
  }

  const displayRole = role ?? 'unknown';
  // Prepend the fuzzy-fallback banner so the agent never reads a role
  // for a symbol that doesn't exist under the queried name.
  const banner = fuzzyBanner ? [fuzzyBanner, ''] : [];
  const lines: string[] = [...banner, `## Role for ${label}`, ''];

  if (role === null) {
    // "not classified yet" would be misleading once the on-demand
    // structural pass HAS run for this node — it ran, it just found no
    // matching rule. Word the verdict to match the cascade state.
    const suffix = onDemandAttempted
      ? 'structural pre-filter ran, no rule matched; awaiting the bulk LLM classify pass'
      : 'not classified yet';
    lines.push(`- **Role:** unknown (${suffix})`);
  } else {
    lines.push(`- **Role:** ${role}${inferredOnDemand ? ' (inferred on demand)' : ''}`);
  }

  if (roleModel) {
    // Collapse an absolute GGUF path down to its basename so the line
    // doesn't leak the operator's home directory (mirrors ask /
    // local-chat — friction #42).
    lines.push(`- **Classified by:** ${displayModelName(roleModel)}`);
  }

  if (desc) {
    const preview = desc.text.length > 80 ? desc.text.slice(0, 80) + '...' : desc.text;
    lines.push(`- **Source:** ${desc.source}`, `- **Input:** "${preview}"`);
  } else {
    lines.push(`- **Source:** NONE`, `- **Input:** NONE — no summary, no docstring, no test coverage`);
  }

  if (displayRole === 'unknown' || role === null) {
    lines.push(...renderUnknownDiagnostic({ desc, signature }));
  }

  return lines;
}

interface HandleGetRoleOfArgs {
  cg: import('../../index.js').default;
  symbols: string[];
  via: ClassifierVia;
  refIds: RefIdCache | undefined;
}

/** Batched get-role-of: returns one ## block per symbol. The
 *  {@link ROLE_BATCH_LIMIT} cap is enforced by `batchedSymbols` at the
 *  Zod boundary (structural fix A) so an over-cap input never reaches
 *  this handler — the previous defensive `slice(0, LIMIT)` +
 *  "_N over the cap_" footer (audit-4 #6) is no longer needed. */
function handleGetRoleOf(args: HandleGetRoleOfArgs): ToolOutcome {
  const { cg, symbols, via, refIds } = args;

  if (symbols.length === 1) {
    const sym = symbols[0]!;
    // `resolveSymbolToNode` (not the id-only sibling) so a fuzzy FTS
    // match surfaces a `⚠ Fuzzy fallback` banner instead of silently
    // presenting an arbitrary node's role. Mirrors biomarkers / note.
    const resolved = resolveSymbolToNode(cg, sym, refIds);
    // A bogus symbol is a caller error, not an empty-but-valid result —
    // return the `err(...)` arm so the CLI exits non-zero (consistent
    // with `session resume <bad-id>` / `note delete <bad-id>`).
    if (!resolved) return err(symbolNotFound(cg, sym));
    return ok(
      renderToolResponse({
        body: renderGetRoleOfBlock({
          cg,
          nodeId: resolved.node.id,
          label: sym,
          via,
          fuzzyBanner: resolved.fuzzyBanner,
        }).join('\n'),
      }),
    );
  }

  // Render per-symbol blocks first so we can roll up the fuzzy-fallback
  // count for the header. Per-row banners stay; the header rollup makes
  // a non-zero count visible at-a-glance in batched calls where individual
  // banners are easy to miss in a 20-symbol wall of output.
  const blocks: string[] = [];
  let fuzzyCount = 0;
  for (const sym of symbols) {
    const resolved = resolveSymbolToNode(cg, sym, refIds);
    if (resolved) {
      if (resolved.fuzzyBanner) fuzzyCount++;
      blocks.push(
        ...renderGetRoleOfBlock({
          cg,
          nodeId: resolved.node.id,
          label: sym,
          via,
          fuzzyBanner: resolved.fuzzyBanner,
        }),
        '',
      );
    } else {
      blocks.push(`## Role for ${sym}`, '', `_no symbol matched "${sym}"_`, '');
    }
  }
  const headerSuffix = fuzzyCount > 0 ? `, ${fuzzyCount} resolved via fuzzy fallback` : '';
  const sections: string[] = [`## Roles (${symbols.length} symbols${headerSuffix})`, ''];
  sections.push(...blocks);
  return ok(
    renderToolResponse({
      body: sections.join('\n'),
    }),
  );
}

/**
 * Render one `- **name** (kind) — path:line` bullet for a role-list
 * node, plus an indented description line when a description exists.
 */
function roleNodeLines(
  n: ReturnType<typeof findNodesByRole>[number],
  descriptions: ReturnType<typeof getSymbolDescriptions>,
): string[] {
  const loc = n.startLine ? `:${n.startLine}` : '';
  const out = [`- **${n.name}** (${n.kind}) — ${n.filePath}${loc}`];
  const d = descriptions.get(n.id);
  if (d) out.push(`  ${d.text}`);
  return out;
}

/**
 * Build the `## Symbols with role` heading and the optional
 * "N more not shown" footer for a role list. When the shown count is
 * below the role's true total, both reflect the "showing N of M" cap
 * (friction audit-4 #2); otherwise the footer is omitted.
 */
function roleListHeading(
  role: string,
  shown: number,
  total: number,
): { header: string; moreFooter: string | undefined } {
  if (shown < total) {
    return {
      header: `## Symbols with role: ${role} (showing ${shown} of ${total})`,
      moreFooter: `_${total - shown} more symbol(s) with this role not shown — raise \`limit\` (cap ${ROLE_LIST_MAX_LIMIT}) to see them._`,
    };
  }
  return {
    header: `## Symbols with role: ${role} (${shown})`,
    moreFooter: undefined,
  };
}

/** Existing list-by-role behaviour. */
function handleFindByRole(cg: import('../../index.js').default, role: string, limit: number): ToolOutcome {
  const nodes = findNodesByRole(cg.queries, role as never, limit);
  if (nodes.length === 0) {
    return ok(
      renderToolResponse({
        body: '',
        empty: {
          message: `No symbols classified as "${role}". The role classifier may not have run yet — check cartograph_status for coverage.`,
          freshness: { cg },
        },
      }),
    );
  }
  // `findNodesByRole` returns the limit-capped slice — render it as
  // "showing N of M" against the role's true total so the agent never
  // mistakes a capped count for the complete set (friction audit-4 #2,
  // mirroring the `session list` treatment).
  const roleCount = getRoleCounts(cg.queries).get(role);
  const total = roleCount === undefined ? nodes.length : roleCount;
  const descriptions = getSymbolDescriptions(
    cg.queries,
    nodes.map((n) => n.id),
  );
  // The "N more not shown" notice routes through the footer slot so the
  // chokepoint truncates the symbol list first, then appends the hint.
  const { header, moreFooter } = roleListHeading(role, nodes.length, total);
  const lines: string[] = [header, ''];
  for (const n of nodes) {
    lines.push(...roleNodeLines(n, descriptions));
  }
  return ok(
    renderToolResponse({
      body: lines.join('\n'),
      footers: [moreFooter],
    }),
  );
}

/**
 * Render a project-wide role distribution table. Takes a
 * {@link RenderRoleDistributionArgs} bundle (count map + the two
 * classifier-disclosure counts + the live Cartograph for freshness).
 * Returns a {@link ToolOutcome} `ok` arm wrapping a
 * `renderToolResponse` chokepoint result: the spec-rendered table
 * body via `buildRoleDistributionSpec` plus the unclassified /
 * skipped footers. When the map is empty and both disclosure counts
 * are zero it routes through the empty-result branch instead
 * (carrying the index-freshness hint).
 *
 * Field semantics on the args bundle:
 *
 * - `counts` — Map<role, count> of already-classified nodes. Sorted
 *   into descending-by-count rows; the synthetic Total row is
 *   appended last by {@link buildRoleDistributionSpec}.
 * - `unclassifiedTargets` — count of NULL-role nodes whose KIND is a
 *   classifier target (function / method / class / interface / struct /
 *   trait / protocol / component). ONLY these count against the
 *   percentage base — the classifier never targets file / import /
 *   constant / variable / property / field / parameter / etc., so
 *   folding those into the denominator would inflate the
 *   "unclassified %" by thousands of nodes the classifier never even
 *   considered (bug #12).
 * - `nonTargetSkipped` — count of NULL-role nodes the classifier
 *   intentionally skips (the kinds listed above). Surfaced as a
 *   separate disclosure footer so the agent knows that, say, 7500 of
 *   the project's 15000 nodes are out-of-scope by design, not by
 *   oversight.
 *
 * The trailing notes route through the footer slot so they land
 * after body truncation. Footers stay outside `buildRoleDistributionSpec`
 * (the spec's `footers` is unset) because they need the live
 * unclassifiedTargets / nonTargetSkipped counts AND the
 * `renderToolResponse` chokepoint owns their truncation handling.
 */
/** Arg bundle for {@link renderRoleDistribution} — keeps the renderer
 *  under the 4-param `long_parameter_list` info floor. */
interface RenderRoleDistributionArgs {
  cg: import('../../index.js').default;
  counts: Map<string, number>;
  unclassifiedTargets: number;
  nonTargetSkipped: number;
}

function renderRoleDistribution(args: RenderRoleDistributionArgs): ToolOutcome {
  const { cg, counts, unclassifiedTargets, nonTargetSkipped } = args;
  if (counts.size === 0 && unclassifiedTargets === 0 && nonTargetSkipped === 0) {
    return ok(
      renderToolResponse({
        body: '',
        empty: {
          message:
            '## Role distribution (project-wide)\n\n' +
            'No roles classified yet — the role classifier has not run on this project.\n' +
            "Run `cartograph_admin({action: 'classify'})` to populate role labels.",
          freshness: { cg },
        },
      }),
    );
  }
  const classifiedTotal = [...counts.values()].reduce((s, n) => s + n, 0);
  // Percentage denominator counts ONLY classifier-target kinds — both
  // already-classified rows and NULL-role-but-target nodes. Skipped
  // kinds (file/import/constant/etc.) are excluded by design (bug #12).
  const total = classifiedTotal + unclassifiedTargets;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // The unclassified bucket always sorts last regardless of its size.
  if (unclassifiedTargets > 0) sorted.push(['unclassified', unclassifiedTargets]);
  const rows: RoleDistributionTableRow[] = [
    ...sorted.map(([role, n]) => ({ role, count: n, isTotal: false })),
    { role: 'Total', count: total, isTotal: true },
  ];
  const unclassifiedFooter =
    unclassifiedTargets > 0
      ? `_${unclassifiedTargets} classifier-target node${unclassifiedTargets === 1 ? '' : 's'} not yet classified — ` +
        "run `cartograph_admin({action: 'classify'})` to label them._"
      : undefined;
  const skippedFooter =
    nonTargetSkipped > 0
      ? `_${nonTargetSkipped} node${nonTargetSkipped === 1 ? '' : 's'} intentionally not classified ` +
        '(file / import / constant / variable / property / field / parameter / etc. — kinds the classifier never targets, ' +
        'so they are excluded from the percentage denominator)._'
      : undefined;
  return ok(
    renderToolResponse({
      body: renderMarkdownTable(buildRoleDistributionSpec(rows, total)),
      footers: [unclassifiedFooter, skippedFooter],
    }),
  );
}

/**
 * One row of the role-distribution table — a role label plus its
 * count. The bottom-of-table Total row uses the same shape with
 * `isTotal: true` so the cell renderers can emit the **bold** form
 * matching the pre-migration output. Exported alongside
 * {@link buildRoleDistributionSpec} so the wording lint can
 * construct an instance without a real Cartograph.
 */
export interface RoleDistributionTableRow {
  role: string;
  count: number;
  /** `true` for the synthetic Total row at the bottom; renders as
   *  `**Total** | **N** | 100%`. */
  isTotal: boolean;
}

/**
 * Build the typed `ResultSpec` for the project-wide role-distribution
 * table. Pure — call sites pass already-aggregated rows + the
 * percentage denominator. The wording-alignment lint pins title +
 * column headers to the role-classifier vocabulary. Footers
 * (`unclassifiedFooter` / `skippedFooter`) are handled by the
 * caller's `renderToolResponse` because they need the live
 * unclassifiedTargets / nonTargetSkipped counts — those route
 * through the response chokepoint's truncation handling.
 */
export function buildRoleDistributionSpec(
  rows: ReadonlyArray<RoleDistributionTableRow>,
  total: number,
): MarkdownTableSpec<RoleDistributionTableRow> {
  return {
    title: 'Role distribution (project-wide, classifier-target kinds only)',
    emptyState:
      'No roles classified yet — the role classifier has not run on this project.\n' +
      "Run `cartograph_admin({action: 'classify'})` to populate role labels.",
    columns: [
      { header: 'Role', cell: (r) => (r.isTotal ? `**${r.role}**` : r.role) },
      { header: 'Count', align: 'right', cell: (r) => (r.isTotal ? `**${r.count}**` : String(r.count)) },
      {
        header: '%',
        align: 'right',
        cell: (r) => {
          if (r.isTotal) return '100%';
          const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : '0.0';
          return `${pct}%`;
        },
      },
    ],
    rows,
  };
}

async function handleRole(ctx: ToolCtx, args: RoleArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);

  const hasRole = args.role != null;
  const hasSingle = args.symbol != null;
  const hasBatch = Array.isArray(args.symbols);
  // `via` defaults to `auto` (set explicitly here, not in the schema,
  // so the `args.via != null` check below can still distinguish "the
  // caller passed `via`" from "defaulted"); `rule`/`auto` behave
  // identically on the structural-only on-demand path.
  const via = args.via ?? 'auto';

  // Mutual-exclusion guards. Contradictory args are a hard error
  // (`err(...)` → `isError` on MCP, exit 1 on the CLI) — a caller that
  // passed both modes cannot tell a real result from this advisory
  // otherwise. Consistent with `tests-for` / `sql`, which reject the
  // same contradictory-args shape; the CLI command is generated from
  // this schema, so this is the single enforcement point.
  if (hasSingle && hasBatch) {
    return err('Pass either `symbol` or `symbols`, not both.');
  }
  if (hasRole && (hasSingle || hasBatch)) {
    return err('Pass either `role` (list-by-role) or `symbol`/`symbols` (get-role-of), not both.');
  }

  // No-arg path — project-wide role distribution. The percentage
  // denominator counts ONLY classifier-target kinds (function / method /
  // class / interface / struct / trait / protocol / component);
  // intentionally-skipped kinds (file / import / constant / variable /
  // property / field / parameter / etc.) are surfaced as a separate
  // disclosure footer instead of being folded into the denominator —
  // otherwise the "unclassified %" would overstate the gap by every
  // node the classifier never even targets (bug #12).
  if (!hasRole && !hasSingle && !hasBatch) {
    const counts = getRoleCounts(cg.queries);
    const unclassifiedTargets = getUnclassifiedTargetNodeCount(cg.queries);
    const nonTargetSkipped = getNonClassifierTargetNodeCount(cg.queries);
    return renderRoleDistribution({ cg, counts, unclassifiedTargets, nonTargetSkipped });
  }

  // `via='llm'` on the get-role-of path is unsupported — the on-demand
  // path runs the structural pre-filter only. Surface a helpful error
  // rather than silently returning unknown.
  if ((hasSingle || hasBatch) && via === 'llm') {
    return err(
      "via='llm' is not supported on `cartograph_role` get-role-of — the on-demand path runs the structural pre-filter only. " +
        "Run the bulk `cartograph_admin({action: 'classify'})` pipeline to populate roles via the LLM path, " +
        "then re-query without `via` (or with `via: 'auto'`) to read the cached label.",
    );
  }

  // get-role-of path. `batchedSymbols` enforced `.min(1).max(20)` at
  // the Zod boundary, so a present `args.symbols` is guaranteed to be
  // a non-empty bounded string array — no defensive slice needed.
  if (hasSingle || hasBatch) {
    let symbols: string[];
    if (hasBatch) {
      symbols = args.symbols ?? [];
    } else {
      const symbolResult = validateStringOutcome({ value: args.symbol, name: 'symbol' });
      if (typeof symbolResult !== 'string') return symbolResult;
      symbols = [symbolResult];
    }
    return handleGetRoleOf({ cg, symbols, via, refIds: ctx.refIds });
  }

  // list-by-role path (original behaviour). The list query just reads
  // cached `nodes.role` rows — there's no on-demand inference to pin —
  // so `via` has no effect here. An explicit `via` (other than the
  // default `auto`) is therefore a no-op; reject it loudly rather than
  // silently dropping it, so the agent isn't misled into thinking it
  // triggered a classification pass.
  if (args.via != null && via !== 'auto') {
    return err(
      `\`via\` is not supported on \`cartograph_role\` list-by-role — listing only reads cached \`nodes.role\` rows, ` +
        `there is no on-demand classification to steer. ` +
        `Drop \`via\` to list; to (re-)populate roles via the LLM run \`cartograph_admin({action: 'classify'})\`.`,
    );
  }
  const role = validateStringOutcome({ value: args.role, name: 'role' });
  if (typeof role !== 'string') return role;
  // `limit` is already an integer in [1, 500] — Zod rejected anything
  // else at the dispatch boundary, so no clamp is needed.
  const limit = args.limit ?? ROLE_LIST_DEFAULT_LIMIT;
  return handleFindByRole(cg, role, limit);
}

/**
 * Zod schema for `cartograph_role` — a flat object with three call
 * shapes (no-arg distribution / `role:` filter / `symbol`/`symbols`
 * lookup). Every field is `.optional()`; mode selection + all
 * mutual-exclusion guards stay in the handler. `limit` is
 * `.int().min(1).max(500)` — the legacy handler clamped, but under the
 * locked reject-out-of-range policy both ends are rejected at the
 * dispatch boundary, so the handler drops the `clamp`.
 */
const roleSchema = z.object({
  role: z
    .enum(['api_endpoint', 'business_logic', 'data_model', 'util', 'framework_glue', 'test_helper', 'unknown'])
    .optional()
    .describe('Role label to filter by (list-by-role mode). Exclusive with `symbol`/`symbols`.'),
  symbol: z
    .string()
    .optional()
    .describe(
      'Get the role of one symbol by node id, qualified name, or plain name. Exclusive with `role` and `symbols`.',
    ),
  symbols: batchedSymbols
    .optional()
    .describe(
      `Get roles of up to ${BATCHED_SYMBOLS_MAX} symbols at once. Exclusive with \`role\` and \`symbol\`. Hard cap — over-cap inputs are rejected, so split into multiple calls.`,
    ),
  via: z
    .enum(['rule', 'llm', 'auto'])
    .optional()
    .describe(
      'On-demand classification axis. ' +
        '`rule`/`auto` (default, identical) — run the structural pre-filter (kind / test-file path / handler signature) and persist. ' +
        '`llm` — not supported on get-role-of (returns an error); the bulk classify pass is the LLM path.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ROLE_LIST_MAX_LIMIT)
    .optional()
    .describe('Max results for list-by-role mode (default 50, integer in [1, 500]).'),
  projectPath: projectPathField,
});

type RoleArgs = z.infer<typeof roleSchema>;

export const ROLE_TOOL = defineTool({
  name: 'cartograph_role',
  description:
    'Symbol roles — three modes. No args: project-wide distribution table (count + % per role). ' +
    '`role`: list all symbols with that role. ' +
    '`symbol`/`symbols` (up to 20): get the role of specific symbols. ' +
    'Labels: `api_endpoint`|`business_logic`|`data_model`|`util`|`framework_glue`|`test_helper`|`unknown`. ' +
    "Get triggers on-demand structural classification and persists; the LLM classification runs in the bulk classify pass (`cartograph_admin({action: 'classify'})`), which list/distribution require.",
  schema: roleSchema,
  handle: handleRole,
});
