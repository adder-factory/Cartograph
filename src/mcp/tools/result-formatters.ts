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
import {
  CONFIDENCE_RANK,
  detectUniformConfidence,
  filterByConfidence,
  formatConfidence,
  formatSiteCount,
} from '../../graph/edge-confidence.js';
import type { RefIdCache } from './_id-cache.js';
import { err, type ToolOutcome } from './_outcome.js';

export { CONFIDENCE_RANK, detectUniformConfidence, filterByConfidence, formatConfidence, formatSiteCount };

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
    lines.push(formatCompactNodeColumns({ node, fieldSet, refIds, roles }));
  }
  return lines.join('\n');
}

function formatCompactNodeColumns(args: {
  node: Node;
  fieldSet: ReadonlySet<string>;
  refIds: RefIdCache | undefined;
  roles: Map<string, string> | undefined;
}): string {
  const { node, fieldSet, refIds, roles } = args;
  const cols: string[] = [];
  if (fieldSet.has('name')) cols.push(node.name);
  if (fieldSet.has('kind')) cols.push(node.kind);
  pushPathLineColumns(cols, node, fieldSet);
  if (fieldSet.has('role')) {
    const role = roles?.get(node.id);
    if (role) cols.push(`role:${role}`);
  }
  const hasIdField = fieldSet.has('id') && refIds !== undefined;
  if (hasIdField) cols.push(`id:${refIds.mint(node.id)}`);
  return cols.join('|');
}

function pushPathLineColumns(cols: string[], node: Node, fieldSet: ReadonlySet<string>): void {
  // `path` and `line` collapse into ONE column rendered as `path:line`
  // when both are requested. If only one is included, render it alone.
  const hasPathField = fieldSet.has('path');
  const hasLineField = fieldSet.has('line') && Boolean(node.startLine);
  if (hasPathField && hasLineField) cols.push(`${node.filePath}:${node.startLine}`);
  else if (hasPathField) cols.push(node.filePath);
  else if (hasLineField) cols.push(String(node.startLine));
}
