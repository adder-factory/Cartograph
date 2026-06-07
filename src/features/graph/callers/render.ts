import type Cartograph from '../../../index.js';
import { formatConfidence, formatSiteCount } from '../../../graph/edge-confidence.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from '../../../rendering/result-spec.js';
import type { Edge, Node } from '../../../types.js';
import { collectCallersForSource } from './collect.js';
import { expandTestFileCallers } from './test-file-callers.js';

/**
 * Default "no callers" italic note emitted when a per-source section has
 * no incoming edges and the source is not a constructor.
 */
export const CALLERS_NO_CALLERS_NOTE = '_No callers._';

/**
 * Constructor-specific empty-callers hint. Constructors are invoked via
 * `new ClassName(...)`, which graph-edges as `instantiates` on the parent
 * class, not as a call edge on the constructor method itself.
 */
export const CALLERS_CONSTRUCTOR_HINT =
  '> Note: constructors are invoked via `new ClassName(...)`, which graph-edges as `instantiates` on the parent class. To find construction sites, run cartograph_callers on the enclosing class instead of "constructor".';

export interface CallerRefIds {
  mint(nodeId: string): string;
}

export interface BuildCallersGroupSpecArgs {
  node: Node;
  callers: ReadonlyArray<{ node: Node; edge: Edge }>;
  perSourceLimit: number;
  refIds: CallerRefIds | undefined;
}

export function buildCallersGroupSpec(args: BuildCallersGroupSpecArgs): MarkdownBulletListSpec<string> {
  const { node, callers, perSourceLimit, refIds } = args;
  const loc = node.startLine ? `:${node.startLine}` : '';
  const shown = callers.slice(0, perSourceLimit);
  const overflow = callers.length - shown.length;
  const bullets = shown.map((c) => {
    const cloc = c.node.startLine ? `:${c.node.startLine}` : '';
    const sites = formatSiteCount(c.edge);
    const conf = formatConfidence(c.edge);
    const idTag = refIds ? ` \`[id: ${refIds.mint(c.node.id)}]\`` : '';
    return `- ${c.node.name} (${c.node.kind}) - ${c.node.filePath}${cloc}${conf}${sites}${idTag}`;
  });
  const rows = overflow > 0 ? [...bullets, `- … (+${overflow} more)`] : bullets;
  const isConstructor = node.kind === 'method' && node.name === 'constructor';
  return {
    title: `${node.name} (${node.kind}) — ${node.filePath}${loc}`,
    headingLevel: 3,
    rows,
    formatRow: (s) => s,
    emptyState: '',
    emptyNote: isConstructor ? CALLERS_CONSTRUCTOR_HINT : CALLERS_NO_CALLERS_NOTE,
  };
}

export interface FormatGroupedCallersOpts {
  cg: Cartograph;
  symbol: string;
  matches: Node[];
  matchesNote?: string;
  limit: number;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
  refIds?: CallerRefIds;
}

export function formatGroupedCallers(opts: FormatGroupedCallersOpts): { text: string; hasMore: boolean } {
  const { cg, symbol, matches, matchesNote, limit, edgeKindFilter, minConfidence, refIds } = opts;
  const perSymbol = matches.map((node) => ({
    node,
    callers: expandTestFileCallers(cg, collectCallersForSource({ cg, source: node, edgeKindFilter, minConfidence })),
  }));
  const totalCallers = perSymbol.reduce((sum, p) => sum + p.callers.length, 0);
  const perSourceLimit = Math.max(Math.floor(limit / matches.length), 3);
  const lines: string[] = [
    `## Callers of ${symbol} (${matches.length} source definitions, ${totalCallers} callers total)`,
    '',
    `> **Note:** "${symbol}" resolves to multiple symbols. Callers are grouped per source so you can tell which definition each caller targets. Up to ${perSourceLimit} callers shown per source — the aggregate may exceed the \`limit\` argument when many sources have many callers.`,
    '',
  ];
  const candidateNote = matchesNote?.replace(/^\n+/, '').trim();
  if (candidateNote) lines.push(candidateNote, '');
  let hasMore = false;
  for (const { node, callers } of perSymbol) {
    lines.push(renderMarkdownBulletList(buildCallersGroupSpec({ node, callers, perSourceLimit, refIds })));
    if (callers.length > perSourceLimit) hasMore = true;
  }
  return { text: lines.join('\n'), hasMore };
}

const TYPE_USAGE_VERB: Record<string, string> = {
  instantiates: 'instantiate',
  type_of: 'use as a type',
  returns: 'return',
  extends: 'extend',
  implements: 'implement',
};

export interface CallersNoteArgs {
  symbol: string;
  typeUserCount: number;
  callerCount: number;
  edgeKindFilter?: string;
}

export function pickCallersNote(args: CallersNoteArgs): string {
  const { symbol, typeUserCount, callerCount, edgeKindFilter } = args;
  if (typeUserCount === 0) return '';
  if (callerCount === 0) {
    const verb = edgeKindFilter ? TYPE_USAGE_VERB[edgeKindFilter] : undefined;
    const usageDesc = verb ? `*${verb}* it.` : `*use* it (parameter / return / field / instantiation / inheritance).`;
    return `\n\n> **Note:** \`${symbol}\` is a type, not a callable. Showing symbols that ${usageDesc}`;
  }
  return `\n\n> **Note:** \`${symbol}\` resolves to both callable and type-like definitions; both surfaces shown.`;
}
