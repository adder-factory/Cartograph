/**
 * Shared result-rendering helpers.
 *
 * Used by graph-navigation tools (callers/callees, eventually node)
 * to render a list of `Node` results with per-row site-count suffix
 * when an edge backs the row.
 *
 * Stateless free functions; no dependency on `ToolHandler` or `cg`.
 */

import type { Edge, Node } from '../../types.js';
import type { RefIdCache } from './_id-cache.js';
import { err, type ToolOutcome } from './_outcome.js';

/**
 * Numeric ordering of confidence levels — used by `minConfidence`
 * filters on callers / callees / impact. Higher = more trustworthy.
 * AMBIGUOUS isn't currently stamped (see B3 in tasks), but the
 * ordering is defined so a future producer slots in cleanly.
 */
export const CONFIDENCE_RANK: Record<NonNullable<Edge['confidence']>, number> = {
  EXTRACTED: 2,
  INFERRED: 1,
  AMBIGUOUS: 0,
};

/**
 * Parse a `minConfidence` arg from a raw tool-args bag. Returns the
 * level, `null` when absent, or a {@link ToolOutcome} `err` arm when
 * malformed. Validates against the known levels so a typo
 * ('extracted' lower-case, 'EXTRACT', etc.) errors loudly instead of
 * silently letting everything through.
 *
 * The error arm is a `ToolOutcome` (not a `ToolResult`) so a
 * P6-converted sub-handler (`_impact` / `_callers` / `_callees`) can
 * return it directly without touching `errorResult`.
 */
export function parseMinConfidence(raw: unknown): NonNullable<Edge['confidence']> | null | ToolOutcome {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !(raw in CONFIDENCE_RANK)) {
    const valid = Object.keys(CONFIDENCE_RANK).join(' / ');
    return err(`'minConfidence' must be one of ${valid}; got ${JSON.stringify(raw)}.`);
  }
  return raw as NonNullable<Edge['confidence']>;
}

/**
 * Filter `(node, edge)` rows so only edges at-or-above `min` survive.
 * Edges with no confidence (legacy rows / structural edges) default
 * to EXTRACTED — they pass every filter, matching the migration's
 * backfill default.
 */
export function filterByConfidence<T extends { edge: Edge }>(
  rows: T[],
  min: NonNullable<Edge['confidence']> | null,
): T[] {
  if (!min) return rows;
  const threshold = CONFIDENCE_RANK[min];
  return rows.filter((r) => CONFIDENCE_RANK[r.edge.confidence ?? 'EXTRACTED'] >= threshold);
}

/**
 * Render a `(INFERRED)` / `(AMBIGUOUS)` suffix for an edge whose
 * resolver confidence is below the trustworthy default. EXTRACTED
 * rows render no suffix — the absence is the signal "this is fine".
 * Returns empty when no edge is available or it's the default level.
 */
export function formatConfidence(edge: Edge | undefined): string {
  const c = edge?.confidence;
  if (!c || c === 'EXTRACTED') return '';
  return ` *(${c})*`;
}

/**
 * Detect when every edge in `edges` carries the same non-default
 * confidence (INFERRED or AMBIGUOUS uniformly across all rows). The
 * common-case shape of resolver output: when symbol resolution is
 * ambiguous the resolver tends to mark every row identically, not
 * mix levels. Returns the shared label when uniform, null otherwise
 * (or when any row is EXTRACTED/missing — those rows wouldn't render
 * a marker anyway, so consolidation doesn't apply).
 *
 * Used by formatters to hoist a single header suffix
 * (` — all *INFERRED*`) instead of repeating ` *(INFERRED)*` on
 * every row. Saves ~12 chars × N rows when the shape is uniform.
 */
export function detectUniformConfidence(
  nodeIds: ReadonlyArray<string>,
  edges: Map<string, Edge> | undefined,
): string | null {
  if (!edges || nodeIds.length < 2) return null;
  let seen: string | null = null;
  for (const id of nodeIds) {
    const c = edges.get(id)?.confidence;
    if (!c || c === 'EXTRACTED') return null;
    if (seen === null) seen = c;
    else if (seen !== c) return null;
  }
  return seen;
}

/**
 * Render a "(N call sites: l1, l2, …)" suffix for a caller/callee
 * row when the underlying edge stood in for >1 site (the extractor
 * dedups (caller, callee, kind) and stamps siteCount on the edge
 * metadata). Label varies by edge kind so a duplicated `import` or
 * `references` edge doesn't get tagged as "call sites" — readers of
 * type-user / import surfaces would find that misleading. Empty
 * string when the edge represents a single site or no edge is
 * available — callers don't need to special-case.
 */
export function formatSiteCount(edge: Edge | undefined): string {
  if (!edge?.metadata) return '';
  const m = edge.metadata as { siteCount?: number; extraLines?: number[] };
  if (!m.siteCount || m.siteCount <= 1) return '';
  const samples: number[] = [];
  if (typeof edge.line === 'number') samples.push(edge.line);
  if (m.extraLines) samples.push(...m.extraLines);
  const ellipsis = m.siteCount > samples.length ? ', …' : '';
  const noun = edge.kind === 'calls' ? 'call sites' : 'sites';
  return ` (${m.siteCount} ${noun}: ${samples.join(', ')}${ellipsis})`;
}

/**
 * Render a markdown bullet list of nodes under a `## title (N found)`
 * header. When `edges` is provided, each row gets a site-count
 * suffix from {@link formatSiteCount}. When `refIds` is provided
 * (#15), each row also gets an `[id: n_xxxxxxxx]` suffix that the
 * agent can pass back as `id=...` instead of `symbol=<full name>`
 * on a follow-up call. The cache mints / re-uses the same UID per
 * node, scoped to MCP-server lifetime.
 */
interface FormatNodeListArgs {
  nodes: Node[];
  title: string;
  edges?: Map<string, Edge>;
  refIds?: RefIdCache | undefined;
  /**
   * Stage 6 #6.1 token-cost reduction: when true, drops the markdown
   * decoration (per-row confidence, call-site samples, header line)
   * and emits one terse line per node — `name|kind|path:line` (plus
   * `|id:n_xxxxxxxx` when `refIds` is passed). Cuts row size by
   * ~50-70% for typical walks. Default false (back-compat).
   */
  compact?: boolean;
  /**
   * Stage 6 #6.3 field projection: when set, only emit the requested
   * fields per row (compact mode only). Allowed values: 'name', 'kind',
   * 'path', 'line', 'id', 'role'. Combined with compact mode, drops to
   * the absolute minimum the caller needs. Default: all fields except
   * `role` (role is opt-in via `roles` map being passed AND included
   * in the `fields` set; absent rows omit the role column).
   */
  fields?: ReadonlyArray<'name' | 'kind' | 'path' | 'line' | 'id' | 'role'>;
  /**
   * Per-node role lookup. When passed, each row gets a `role:<value>`
   * column appended (compact mode) or `, role:<value>` injected after
   * the kind (markdown mode). Nodes absent from the map render no
   * role column. Saves a `cartograph_role` round-trip when callers
   * already know the answer is wanted. Use `getSymbolRoles` from
   * `db/queries-roles.ts` to build the map.
   */
  roles?: Map<string, string>;
}

export function formatNodeList(args: FormatNodeListArgs): string {
  const { nodes, title, edges, refIds, compact = false, roles } = args;
  if (compact) return formatNodeListCompact(args);

  const uniformConf = detectUniformConfidence(
    nodes.map((n) => n.id),
    edges,
  );
  const headerSuffix = uniformConf ? ` — all *${uniformConf}*` : '';
  const lines: string[] = [`## ${title} (${nodes.length} found)${headerSuffix}`, ''];

  for (const node of nodes) {
    const location = node.startLine ? `:${node.startLine}` : '';
    const edge = edges?.get(node.id);
    const sites = formatSiteCount(edge);
    // Per-row confidence suppressed when the header already says
    // "all <conf>" — saves ~12 chars × N rows on uniform output.
    const conf = uniformConf ? '' : formatConfidence(edge);
    const idTag = refIds ? ` \`[id: ${refIds.mint(node.id)}]\`` : '';
    // Role tag — opt-in via `roles` map; absent rows render no role.
    const role = roles?.get(node.id);
    const roleTag = role ? `, role:${role}` : '';
    lines.push(`- ${node.name} (${node.kind}${roleTag}) - ${node.filePath}${location}${conf}${sites}${idTag}`);
  }

  return lines.join('\n');
}

/**
 * Compact one-line-per-node renderer. Format:
 *
 *   <title> (N)
 *   name|kind|path:line[|id:n_xxxxxxxx]
 *   ...
 *
 * No markdown, no confidence annotations, no site samples.
 * For agent consumption when token budget matters more than
 * human readability.
 */
function formatNodeListCompact(args: FormatNodeListArgs): string {
  const { nodes, title, refIds, fields, roles } = args;
  const lines: string[] = [`${title} (${nodes.length})`];
  // Default field set: all five canonical + role when `roles` map
  // was passed. Field projection restricts the row to just the named
  // fields, in the canonical order regardless of input ordering, so
  // chained tools always see the same column shape.
  const defaultFields = roles ? ['name', 'kind', 'path', 'line', 'role', 'id'] : ['name', 'kind', 'path', 'line', 'id'];
  const hasExplicitFields = Array.isArray(fields) && fields.length > 0;
  const fieldSet = hasExplicitFields ? new Set<string>(fields) : new Set(defaultFields);
  for (const node of nodes) {
    const cols: string[] = [];
    if (fieldSet.has('name')) cols.push(node.name);
    if (fieldSet.has('kind')) cols.push(node.kind);
    // `path` and `line` collapse into ONE column rendered as `path:line`
    // (matches the universal `file:line` editor-jump convention; matches
    // the documented playbook shape). If only one of the two fields is
    // included, render that field alone — no orphan leading colon.
    const hasPathField = fieldSet.has('path');
    const hasLineField = fieldSet.has('line') && Boolean(node.startLine);
    if (hasPathField && hasLineField) cols.push(`${node.filePath}:${node.startLine}`);
    else if (hasPathField) cols.push(node.filePath);
    else if (hasLineField) cols.push(String(node.startLine));
    if (fieldSet.has('role')) {
      const role = roles?.get(node.id);
      if (role) cols.push(`role:${role}`);
    }
    const hasIdField = fieldSet.has('id') && refIds !== undefined;
    if (hasIdField) cols.push(`id:${refIds.mint(node.id)}`);
    lines.push(cols.join('|'));
  }
  return lines.join('\n');
}
