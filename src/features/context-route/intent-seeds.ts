import type { QueryBuilder } from '../../db/queries.js';
import { searchIntentSymbolRows, type IntentSymbolHitRow } from '../../db/queries-intent-search.js';
import type { SearchResult } from '../../search/types.js';
import { extractSearchTerms } from '../../search/query-utils.js';
import { ContextRouteIntentSeedsSchema, type ContextRouteIntentSeeds } from './contract.js';

export interface ContextIntentSeedResult {
  candidates: SearchResult[];
  evidenceByNodeId: ReadonlyMap<string, readonly string[]>;
  metadata: ContextRouteIntentSeeds;
}

export interface CollectContextIntentSeedsArgs {
  clauses: readonly string[];
  queries: QueryBuilder;
  limit: number;
}

interface RankedIntentHit {
  row: IntentSymbolHitRow;
  clause: string;
  matchedTerms: string[];
}

const MAX_INTENT_TERMS_PER_CLAUSE = 8;
const INTENT_OVERFETCH_MULTIPLIER = 3;
const MIN_MULTI_TERM_OVERLAP = 2;

export function collectContextIntentSeeds(args: CollectContextIntentSeedsArgs): ContextIntentSeedResult {
  const perClause = args.clauses.map((clause) => searchClause(args.queries, clause, args.limit));
  const ordered = roundRobinIntentHits(perClause, args.limit);
  const candidates: SearchResult[] = [];
  const evidenceByNodeId = new Map<string, readonly string[]>();

  for (let index = 0; index < ordered.length; index++) {
    const hit = ordered[index]!;
    const node = args.queries.getNodeById(hit.row.id);
    if (!node) continue;
    const evidence = `${hit.row.source} matched ${hit.matchedTerms.length} clause term${hit.matchedTerms.length === 1 ? '' : 's'} (${hit.matchedTerms.join(', ')}) in "${hit.clause}"`;
    candidates.push({ node, score: Math.max(0.1, 1 - index / Math.max(ordered.length, 1)), highlights: [evidence] });
    evidenceByNodeId.set(node.id, [evidence]);
  }

  const metadata = ContextRouteIntentSeedsSchema.parse({
    queries: args.clauses.filter((clause) => clauseTerms(clause).length > 0),
    nodeIds: candidates.map((candidate) => candidate.node.id),
    evidenceByNodeId: Object.fromEntries(evidenceByNodeId),
  });
  return { candidates, evidenceByNodeId, metadata };
}

function searchClause(queries: QueryBuilder, clause: string, limit: number): RankedIntentHit[] {
  const terms = clauseTerms(clause);
  if (terms.length === 0) return [];
  const expression = terms.join(' OR ');
  const fetchLimit = Math.max(limit * INTENT_OVERFETCH_MULTIPLIER, limit);
  try {
    const rows = [
      ...searchIntentSymbolRows({
        db: queries.db,
        corpus: 'summary',
        expression,
        filters: {},
        limit: fetchLimit,
        rowCount: 1,
      }),
      ...searchIntentSymbolRows({
        db: queries.db,
        corpus: 'docstring',
        expression,
        filters: {},
        limit: fetchLimit,
        rowCount: 1,
      }),
    ];
    return rankClauseHits(rows, clause, terms, limit);
  } catch {
    return [];
  }
}

function clauseTerms(clause: string): string[] {
  return extractSearchTerms(clause, { stems: false }).slice(0, MAX_INTENT_TERMS_PER_CLAUSE);
}

function rankClauseHits(
  rows: readonly IntentSymbolHitRow[],
  clause: string,
  terms: readonly string[],
  limit: number,
): RankedIntentHit[] {
  const bestByNodeId = new Map<string, RankedIntentHit>();
  for (const row of rows) {
    const text = row.text.toLowerCase();
    const matchedTerms = terms.filter((term) => text.includes(term.toLowerCase()));
    if (terms.length > 1 && matchedTerms.length < MIN_MULTI_TERM_OVERLAP) continue;
    if (matchedTerms.length === 0) continue;
    const candidate = { row, clause, matchedTerms };
    const existing = bestByNodeId.get(row.id);
    if (!existing || compareIntentHits(candidate, existing) < 0) bestByNodeId.set(row.id, candidate);
  }
  return [...bestByNodeId.values()].sort(compareIntentHits).slice(0, limit);
}

function compareIntentHits(a: RankedIntentHit, b: RankedIntentHit): number {
  const overlapDiff = b.matchedTerms.length - a.matchedTerms.length;
  if (overlapDiff !== 0) return overlapDiff;
  const rankDiff = a.row.rank - b.row.rank;
  if (rankDiff !== 0) return rankDiff;
  return a.row.id.localeCompare(b.row.id);
}

function roundRobinIntentHits(perClause: readonly RankedIntentHit[][], limit: number): RankedIntentHit[] {
  const result: RankedIntentHit[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (result.length < limit) {
    let added = false;
    for (const hits of perClause) {
      const hit = hits[index];
      if (!hit || seen.has(hit.row.id)) continue;
      seen.add(hit.row.id);
      result.push(hit);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added && perClause.every((hits) => index >= hits.length - 1)) break;
    index++;
  }
  return result;
}
