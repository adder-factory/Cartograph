/**
 * `cartograph_graph(direction: 'path')` — shortest dependency path between
 * two symbols ("how does X reach Y").
 *
 * A thin wrapper over the existing `GraphTraverser.findPath` BFS (shortest
 * path over OUTGOING edges, queue-capped), which was previously implemented
 * + tested but unexposed on any tool/CLI surface. Resolves `start` and `to`
 * to nodes via `findSymbol` (same disambiguation as callers/callees/impact),
 * runs the BFS over the stored edge graph — all edge kinds by default, or a
 * single kind when `edgeKind` is set — and renders the resulting node→edge
 * chain as a METADATA path: name / kind / location per hop, edge kind between
 * hops, no source bodies. That keeps `path` on the "answer directly" side of
 * the metadata-vs-source split (`cartograph_node` / `cartograph_explore` fetch
 * the hop bodies on demand).
 */
import type { Edge, Node } from '../../types.js';
import type { EdgeKind } from '../../types.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { renderToolResponse } from './_response.js';
import { validateStringOutcome } from './shared.js';
import { findSymbol, symbolNotFound, withDisambiguationBanner } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';

interface PathArgs {
  start?: unknown;
  to?: unknown;
  edgeKind?: string | undefined;
  projectPath?: string | undefined;
}

type PathHop = { node: Node; edge: Edge | null };

export async function handlePath(ctx: ToolCtx, args: PathArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);

  // Both endpoints are required for a path. `start` is the same field
  // callers/callees use; `to` is path-only.
  const startVal = validateStringOutcome({ value: args.start, name: 'start' });
  if (typeof startVal !== 'string') return startVal;
  const toVal = validateStringOutcome({ value: args.to, name: 'to' });
  if (typeof toVal !== 'string') return toVal;

  const fromMatch = findSymbol(cg, startVal, ctx.refIds);
  if (!fromMatch) return err(symbolNotFound(cg, startVal));
  const toMatch = findSymbol(cg, toVal, ctx.refIds);
  if (!toMatch) return err(symbolNotFound(cg, toVal));

  // findSymbol picks the best match per the disambiguation policy and
  // reports the runners-up in `note`. Surface BOTH endpoints' notes at the
  // top so a wrong-endpoint pick is visible before the path (mirrors
  // history.ts's banner-at-top rationale).
  const note = [fromMatch.note, toMatch.note].filter((n) => n).join('\n');

  if (fromMatch.node.id === toMatch.node.id) {
    return ok(
      renderToolResponse({
        body: withDisambiguationBanner(
          note,
          `\`${fromMatch.node.name}\` and the target resolve to the same symbol — no path to trace.`,
        ),
        freshness: { cg },
      }),
    );
  }

  // Cast is safe: the graph schema declares `edgeKind` as a `z.enum` over the
  // valid kinds, so safeParse rejects any other value before this handler runs.
  const edgeKinds: EdgeKind[] = args.edgeKind ? [args.edgeKind as EdgeKind] : [];
  const path = cg.internals.traverser.findPath(fromMatch.node.id, toMatch.node.id, edgeKinds);

  if (!path) {
    const via = args.edgeKind ? ` over \`${args.edgeKind}\` edges` : '';
    return ok(
      renderToolResponse({
        body: withDisambiguationBanner(
          note,
          `No path found from \`${fromMatch.node.name}\` to \`${toMatch.node.name}\`${via}. ` +
            'They may sit in disconnected parts of the graph, be connected only through edge kinds excluded by ' +
            '`edgeKind`, or be separated by more hops than the search budget allows. Try `direction: callees` from ' +
            'the start (or `direction: callers` into the target) to see the immediate frontier.',
        ),
        freshness: { cg, nodes: [fromMatch.node, toMatch.node] },
      }),
    );
  }

  return ok(
    renderToolResponse({
      body: withDisambiguationBanner(note, renderPath(path, args.edgeKind)),
      freshness: { cg, nodes: path.map((h) => h.node) },
    }),
  );
}

/**
 * Render a findPath result as a numbered hop list. `path[i].edge` is the
 * edge that led INTO `path[i].node` from `path[i-1]` (the first hop's edge
 * is null), so the connector printed AFTER node `i` is `path[i+1].edge.kind`.
 */
function renderPath(path: PathHop[], edgeKind: string | undefined): string {
  const hops = path.length - 1;
  const from = path[0]!.node.name;
  const to = path.at(-1)!.node.name;
  const kinds = path.slice(1).map((h) => h.edge?.kind ?? '?');
  const lines: string[] = [
    `## Path: \`${from}\` → \`${to}\``,
    '',
    `${hops} ${hops === 1 ? 'hop' : 'hops'}${edgeKind ? ` (over \`${edgeKind}\` edges only)` : ''} — ${kinds.join(' → ')}.`,
    '',
  ];
  path.forEach((hop, i) => {
    lines.push(`${i + 1}. \`${hop.node.name}\` — ${hop.node.kind} · ${hop.node.filePath}:${hop.node.startLine}`);
    const next = path[i + 1];
    if (next) lines.push(`   ↓ ${next.edge?.kind ?? '?'}`);
  });
  return lines.join('\n');
}
