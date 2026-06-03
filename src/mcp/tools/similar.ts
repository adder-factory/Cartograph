/**
 * Similar — embedding-cosine peers for a symbol. Dispatched via
 * `cartograph_graph({direction: 'similar', start: 'X'})` since
 * 2026-05-14 (FRICTION-46); was a standalone `cartograph_similar`
 * tool before that. The handler logic is unchanged — only the
 * agent-facing surface moved to the unified graph tool.
 *
 * Promotes the previously opt-in `edgeKinds: ['similar_to']` traversal
 * pattern to a first-class `direction` value. Answers "find refactor
 * companions / sister implementations of X" — the nearest neighbours
 * in embedding space, with cosine score.
 *
 * Strategy (per source symbol):
 *   1. Read existing `similar_to` outgoing edges. When present (a
 *      prior `build-similarity-edges` pass ran), return those — fast,
 *      no recompute, edge metadata carries the score.
 *   2. Otherwise fall back to on-demand vec0 KNN using the source's
 *      embedding. Slower per call but available without a separate
 *      admin pass; matches are degraded gracefully when the project
 *      has no embeddings (returns a clear "no embeddings" message).
 *
 * Multi-symbol form (`symbols: [...]`) groups results per source —
 * same shape as `cartograph_node` / batched `cartograph_callers`.
 */

import type Cartograph from '../../index.js';
import type { Edge, Node } from '../../types.js';
import { clamp, numArg } from '../../utils.js';
import { getOutgoingEdges } from '../../db/queries-edges.js';
import { getEmbeddingForNode } from '../../db/queries-embeddings.js';
import { findSimilarViaVec } from '../../db/vec-helpers.js';
import { freshnessHintForEmptyResult, validateStringOutcome } from './shared.js';
import { renderToolResponse } from './_response.js';
import { findAllSymbols, notFoundMessage } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { BATCHED_SYMBOLS_MAX } from './_common-fields.js';

const DEFAULT_K = 5;
const MAX_K = 50;
const DEFAULT_MIN_SCORE = 0.3;
/** Mirror of {@link BATCHED_SYMBOLS_MAX} from `_common-fields.ts`. */
const MAX_SYMBOLS = BATCHED_SYMBOLS_MAX;

interface Hit {
  node: Node;
  score: number;
  source: 'edge' | 'vec0';
}

/** @internal Arguments for {@link readSimilarFromEdges}. */
interface ReadSimilarFromEdgesArgs {
  cg: Cartograph;
  nodeId: string;
  k: number;
  minScore: number;
}

/**
 * Read persisted `similar_to` outgoing edges for a node. Returns the
 * top-K by score, filtered by `minScore`. Score is read from
 * `edge.metadata.score` (set by `insertSimilarToEdges`).
 */
function readSimilarFromEdges({ cg, nodeId, k, minScore }: ReadSimilarFromEdgesArgs): Hit[] {
  const edges: Edge[] = getOutgoingEdges(cg.queries, nodeId, ['similar_to']);
  if (edges.length === 0) return [];

  const scored: Array<{ targetId: string; score: number }> = [];
  for (const e of edges) {
    const meta = e.metadata;
    const raw = meta?.['score'];
    // `metadata.score` is a cosine similarity in [-1, 1] (see
    // similar-edges.ts). Defend against stale rows written by a
    // pre-fix `build-similarity-edges` pass that persisted the raw
    // HNSW 'ip' dot product (values like 50..230) — an out-of-range
    // score would silently bypass the `minScore` filter. Such rows
    // are skipped here, so a stale index degrades to "no edge hits"
    // (and the vec0 fallback) rather than nonsense scores.
    const score = typeof raw === 'number' && raw >= -1 && raw <= 1 ? raw : 0;
    if (score < minScore) continue;
    scored.push({ targetId: e.target, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const topK = scored.slice(0, k);
  if (topK.length === 0) return [];

  const nodes = cg.queries.getNodesByIds(topK.map((s) => s.targetId));
  const hits: Hit[] = [];
  for (const s of topK) {
    const n = nodes.get(s.targetId);
    if (n) hits.push({ node: n, score: s.score, source: 'edge' });
  }
  return hits;
}

/** @internal Arguments for {@link readSimilarFromVec}. */
interface ReadSimilarFromVecArgs {
  cg: Cartograph;
  node: Node;
  k: number;
  minScore: number;
}

/**
 * Fallback path: on-demand vec0 KNN using the source's embedding.
 * Returns [] when the project has no embeddings, vec extension isn't
 * loaded, or this node has no embedding row.
 */
function readSimilarFromVec({ cg, node, k, minScore }: ReadSimilarFromVecArgs): Hit[] {
  const cfg = cg.config?.llm?.embeddingLlm;
  const model = typeof cfg?.model === 'string' ? cfg.model : null;
  if (!model) return [];

  const blob = getEmbeddingForNode(cg.queries, node.id, model);
  if (!blob) return [];
  const dim = blob.length / 4;
  const queryVec = new Float32Array(blob.buffer, blob.byteOffset, dim);

  const vecLoaded = cg.db.hasVecExtension();
  const rawHits = findSimilarViaVec({ db: cg.db.getDb(), vecLoaded, queryVec, model, k: k + 1 });
  if (rawHits.length === 0) return [];

  const ids = rawHits.filter((h) => h.nodeId !== node.id).map((h) => h.nodeId);
  const nodes = cg.queries.getNodesByIds(ids);
  const out: Hit[] = [];
  for (const h of rawHits) {
    if (h.nodeId === node.id) continue;
    const similarity = 1 - h.distance;
    if (similarity < minScore) continue;
    const n = nodes.get(h.nodeId);
    if (!n) continue;
    out.push({ node: n, score: similarity, source: 'vec0' });
    if (out.length >= k) break;
  }
  return out;
}

/** Arguments for {@link resolveHits}. */
interface ResolveHitsArgs {
  cg: Cartograph;
  source: Node;
  k: number;
  minScore: number;
  sameLanguage: boolean;
}

/**
 * Resolve hits for a single source — try edges first, fall back to
 * on-demand vec0. The two sources never mix per call: edge results
 * mean a `build-similarity-edges` pass ran, in which case we trust it.
 */
type SimilarHitSource = 'edge' | 'vec0' | 'empty';

function resolveHits(args: ResolveHitsArgs): { hits: Hit[]; via: SimilarHitSource } {
  const { cg, source, k, minScore, sameLanguage } = args;
  const edgeHits = readSimilarFromEdges({ cg, nodeId: source.id, k, minScore });
  let hits = edgeHits.length > 0 ? edgeHits : readSimilarFromVec({ cg, node: source, k, minScore });
  let via: SimilarHitSource = 'empty';
  if (edgeHits.length > 0) {
    via = 'edge';
  } else if (hits.length > 0) {
    via = 'vec0';
  }

  if (sameLanguage) {
    hits = hits.filter((h) => h.node.language === source.language);
  }
  return { hits, via };
}

/** @internal Arguments for {@link renderSourceSection}. */
interface RenderSourceSectionArgs {
  source: Node;
  hits: Hit[];
  via: 'edge' | 'vec0' | 'empty';
  minScore: number;
}

/** Render one source's hits as a markdown section. */
function renderSourceSection({ source, hits, via, minScore }: RenderSourceSectionArgs): string[] {
  const sloc = source.startLine ? `:${source.startLine}` : '';
  const lines: string[] = [`### ${source.name} (${source.kind}) — ${source.filePath}${sloc}`, ''];
  if (hits.length === 0) {
    if (via === 'empty') {
      lines.push(`_No similar symbols found at minScore ≥ ${minScore}._`);
    } else {
      lines.push('_No similar symbols (this node has no embedding, or the project has no embeddings configured)._');
    }
    lines.push('');
    return lines;
  }
  const viaLabel = via === 'edge' ? 'persisted similar_to edges' : 'on-demand vec0 KNN';
  lines.push(`_Source: ${viaLabel}._`, '');
  for (const h of hits) {
    const loc = h.node.startLine ? `:${h.node.startLine}` : '';
    const score = h.score.toFixed(3);
    lines.push(`- **${h.node.name}** (${h.node.kind}) — \`${h.node.filePath}${loc}\` · score=${score}`);
  }
  lines.push('');
  return lines;
}

interface ParsedArgs {
  cg: Cartograph;
  symbols: string[];
  k: number;
  minScore: number;
  sameLanguage: boolean;
}

function parseArgs(ctx: ToolCtx, args: Record<string, unknown>): ParsedArgs | ToolOutcome {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);

  const single = args['symbol'];
  const multi = args['symbols'];
  if (single !== undefined && multi !== undefined) {
    return err('Cannot specify both `symbol` and `symbols`.');
  }
  let symbols: string[];
  if (multi === undefined) {
    const s = validateStringOutcome({ value: single, name: 'symbol' });
    if (typeof s !== 'string') return s;
    symbols = [s];
  } else {
    if (!Array.isArray(multi) || multi.length === 0) {
      return err('`symbols` must be a non-empty array of strings.');
    }
    if (multi.length > MAX_SYMBOLS) {
      return err(`\`symbols\` accepts at most ${MAX_SYMBOLS} entries; got ${multi.length}.`);
    }
    const validated: string[] = [];
    for (let i = 0; i < multi.length; i++) {
      const v = multi[i];
      if (typeof v !== 'string' || v.length === 0) {
        return err(`\`symbols[${i}]\` must be a non-empty string.`);
      }
      validated.push(v);
    }
    symbols = validated;
  }

  const k = clamp(numArg(args['k'], DEFAULT_K), 1, MAX_K);
  const minScoreRaw = numArg(args['minScore'], DEFAULT_MIN_SCORE);
  const minScore = Math.min(Math.max(minScoreRaw, 0), 1);
  const sameLanguage = args['sameLanguage'] === true;

  return { cg, symbols, k, minScore, sameLanguage };
}

/** Build the H2 header line for the similar-results block. */
function buildSimilarHeader(symbols: string[], k: number, minScore: number): string {
  if (symbols.length === 1) {
    return `## Similar to \`${symbols[0]}\` (k=${k}, minScore=${minScore})`;
  }
  return `## Similar peers (${symbols.length} sources, k=${k}, minScore=${minScore})`;
}

/**
 * Embedding-cosine peers of a symbol. Reached via
 * `cartograph_graph({direction: 'similar', start: 'X'})` since
 * 2026-05-14 — `cartograph_similar` as a standalone tool was retired
 * to free a slot against the 45-tool registry cap. The handler logic
 * is unchanged; only the surface is now a `direction` value on the
 * unified graph tool.
 */
export async function handleSimilar(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const parsed = parseArgs(ctx, args);
  if ('ok' in parsed) return parsed;
  const { cg, symbols, k, minScore, sameLanguage } = parsed;

  const sections: string[] = [];
  const seenSourceIds = new Set<string>();
  let totalHits = 0;
  let anySymbolNotFound = false;

  for (const symbol of symbols) {
    const matches = findAllSymbols(cg, symbol, ctx.refIds);
    if (matches.nodes.length === 0) {
      anySymbolNotFound = true;
      sections.push(`### ${symbol}\n\n${notFoundMessage(cg, symbol)}\n`);
      continue;
    }
    const candidateNote = matches.note.replace(/^\n+/, '').trim();
    if (candidateNote) sections.push(candidateNote, '');
    for (const source of matches.nodes) {
      if (seenSourceIds.has(source.id)) continue;
      seenSourceIds.add(source.id);
      const { hits, via } = resolveHits({ cg, source, k, minScore, sameLanguage });
      totalHits += hits.length;
      sections.push(...renderSourceSection({ source, hits, via, minScore }).join('\n').split('\n'));
    }
  }

  const header = buildSimilarHeader(symbols, k, minScore);
  const body = [header, '', ...sections].join('\n');

  /** Sources were found but no hits passed minScore — surface the tip. */
  const sourcesFoundButEmpty = totalHits === 0 && seenSourceIds.size > 0;
  if (sourcesFoundButEmpty) {
    // The tip is a footer (placed after truncation by the chokepoint);
    // the freshness hint is the empty-result form (sources resolved but
    // no neighbours passed minScore — same true-negative-vs-lag signal).
    const tip =
      "> Tip: a `cartograph_admin({action: 'build-similarity-edges'})` pass speeds up future calls and may surface neighbours below the per-call vec0 fallback. The default minScore=0.3 is permissive — drop it lower to widen the net.";
    return ok(
      renderToolResponse({
        body,
        footers: [tip],
        freshness: { text: freshnessHintForEmptyResult(cg) },
      }),
    );
  }

  /** A requested symbol resolved to nothing — append the same
   *  freshness hint find/graph/node use so the agent can tell a
   *  true-negative from an indexing lag. */
  if (anySymbolNotFound) {
    return ok(
      renderToolResponse({
        body,
        freshness: { text: freshnessHintForEmptyResult(cg) },
      }),
    );
  }

  return ok(renderToolResponse({ body }));
}
