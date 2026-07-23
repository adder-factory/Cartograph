import { z } from 'zod';
import type { QueryBuilder } from '../../db/queries.js';
import {
  searchIntentAnchorRows,
  searchIntentSymbolRows,
  type IntentSymbolHitRow,
} from '../../db/queries-intent-search.js';
import type { SearchResult } from '../../search/types.js';
import { extractSearchTerms, getStemVariants } from '../../search/query-utils.js';
import { splitIdentifierTokens } from '../../utils.js';

const ContextRouteIntentSeedsSchema = z.object({
  queries: z.array(z.string().min(1)),
  nodeIds: z.array(z.string().min(1)),
  evidenceByNodeId: z.record(z.string(), z.array(z.string().min(1)).min(1)),
});
type ContextRouteIntentSeeds = z.infer<typeof ContextRouteIntentSeedsSchema>;

export interface ContextIntentSeedResult {
  candidates: SearchResult[];
  evidenceByNodeId: ReadonlyMap<string, readonly string[]>;
  specificityByNodeId: ReadonlyMap<string, number>;
  metadata: ContextRouteIntentSeeds;
}

export interface CollectContextIntentSeedsArgs {
  clauses: readonly string[];
  queries: QueryBuilder;
  limit: number;
}

type IntentEvidenceSource =
  | IntentSymbolHitRow['source']
  | 'symbol anchor'
  | 'symbol anchor + docstring'
  | 'symbol anchor + summary';

interface RankedIntentHit {
  nodeId: string;
  kind: string;
  source: IntentEvidenceSource;
  clause: string;
  matchedTerms: string[];
  anchorMatches: string[];
  nameMatches: string[];
  documentationMatches: string[];
  specificity: number;
  rank: number;
}

const MAX_INTENT_TERMS_PER_CLAUSE = 12;
const MAX_DOCUMENTATION_FETCH_LIMIT = 500;
const MAX_ANCHOR_FETCH_LIMIT = 500;
const MIN_MULTI_TERM_OVERLAP = 2;
const MIN_LONG_CLAUSE_COVERAGE = 0.4;
const RETAINED_ANCHOR_STOP_WORDS = new Set(['affected']);
const GENERIC_INTENT_ANCHOR_TERMS = new Set([
  'active',
  'build',
  'change',
  'changed',
  'direct',
  'likely',
  'model',
  'node',
  'rank',
  'stored',
]);
const PATH_ONLY_SPECIFICITY_WEIGHT = 0.25;
const GENERIC_TERM_SPECIFICITY_WEIGHT = 0;

export function collectContextIntentSeeds(args: CollectContextIntentSeedsArgs): ContextIntentSeedResult {
  const perClause = args.clauses.map((clause) => searchClause(args.queries, clause, args.limit));
  const ordered = roundRobinIntentHits(perClause, args.limit);
  const candidates: SearchResult[] = [];
  const evidenceByNodeId = new Map<string, readonly string[]>();
  const specificityByNodeId = new Map<string, number>();

  for (let index = 0; index < ordered.length; index++) {
    const hit = ordered[index]!;
    const node = args.queries.getNodeById(hit.nodeId);
    if (!node) continue;
    const evidence = `${hit.source} matched ${hit.matchedTerms.length} clause term${hit.matchedTerms.length === 1 ? '' : 's'} (${hit.matchedTerms.join(', ')}) in "${hit.clause}"`;
    candidates.push({ node, score: Math.max(0.1, 1 - index / Math.max(ordered.length, 1)), highlights: [evidence] });
    evidenceByNodeId.set(node.id, [evidence]);
    specificityByNodeId.set(node.id, hit.specificity);
  }

  const metadata = ContextRouteIntentSeedsSchema.parse({
    queries: args.clauses.filter((clause) => clauseTerms(clause).length > 0),
    nodeIds: candidates.map((candidate) => candidate.node.id),
    evidenceByNodeId: Object.fromEntries(evidenceByNodeId),
  });
  return { candidates, evidenceByNodeId, specificityByNodeId, metadata };
}

function searchClause(queries: QueryBuilder, clause: string, limit: number): RankedIntentHit[] {
  const terms = clauseTerms(clause);
  if (terms.length === 0) return [];
  const expression = terms.join(' OR ');
  const documentationFetchLimit = MAX_DOCUMENTATION_FETCH_LIMIT;
  try {
    const rows = [
      ...searchIntentSymbolRows({
        db: queries.db,
        corpus: 'summary',
        expression,
        filters: {},
        limit: documentationFetchLimit,
        rowCount: 1,
      }),
      ...searchIntentSymbolRows({
        db: queries.db,
        corpus: 'docstring',
        expression,
        filters: {},
        limit: documentationFetchLimit,
        rowCount: 1,
      }),
    ];
    const anchors = searchIntentAnchorRows({
      db: queries.db,
      terms: expandedAnchorTerms(terms),
      limit: MAX_ANCHOR_FETCH_LIMIT,
    });
    return mergeRankedHits(
      [
        ...rankAnchorHits(anchors, clause, terms),
        ...rankClauseHits({ rows, clause, terms, limit: documentationFetchLimit }),
      ],
      limit,
    );
  } catch {
    return [];
  }
}

function clauseTerms(clause: string): string[] {
  const terms = new Set(extractSearchTerms(clause, { stems: false }));
  for (const rawTerm of splitAnchorWords(clause)) {
    if (RETAINED_ANCHOR_STOP_WORDS.has(rawTerm)) terms.add(rawTerm);
  }
  return dedupeMorphologicalTerms([...terms]).slice(0, MAX_INTENT_TERMS_PER_CLAUSE);
}

interface RankClauseHitsArgs {
  rows: readonly IntentSymbolHitRow[];
  clause: string;
  terms: readonly string[];
  limit: number;
}

function rankClauseHits(args: RankClauseHitsArgs): RankedIntentHit[] {
  const { rows, clause, terms, limit } = args;
  const bestByNodeId = new Map<string, RankedIntentHit>();
  for (const row of rows) {
    const matchedTerms = matchConceptTerms(row.text, terms);
    if (matchedTerms.length < requiredDocumentationOverlap(terms.length)) continue;
    if (matchedTerms.length === 0) continue;
    const candidate: RankedIntentHit = {
      nodeId: row.id,
      kind: row.kind,
      source: row.source,
      clause,
      matchedTerms,
      anchorMatches: matchConceptTerms(`${row.name} ${row.file_path}`, terms),
      nameMatches: matchConceptTerms(row.name, terms),
      documentationMatches: matchedTerms,
      specificity: 0,
      rank: row.rank,
    };
    const existing = bestByNodeId.get(row.id);
    if (!existing || compareIntentHits(candidate, existing) < 0) bestByNodeId.set(row.id, candidate);
  }
  return [...bestByNodeId.values()].sort(compareIntentHits).slice(0, limit);
}

function rankAnchorHits(
  rows: ReturnType<typeof searchIntentAnchorRows>,
  clause: string,
  terms: readonly string[],
): RankedIntentHit[] {
  const minimumOverlap = terms.length > 1 ? MIN_MULTI_TERM_OVERLAP : 1;
  const matchesByRow = rows.map((row) => ({
    row,
    matchedTerms: matchConceptTerms(`${row.name} ${row.file_path}`, terms),
    nameMatches: matchConceptTerms(row.name, terms),
  }));
  const frequencyByTerm = new Map<string, number>();
  for (const match of matchesByRow) {
    for (const term of match.matchedTerms) frequencyByTerm.set(term, (frequencyByTerm.get(term) ?? 0) + 1);
  }
  return matchesByRow
    .map(({ row, matchedTerms, nameMatches }): RankedIntentHit => {
      const documentationMatches = row.docstring ? matchConceptTerms(row.docstring, terms) : [];
      // A stable name/path anchor already supplies the distinguishing code
      // evidence, so two corroborating documentation concepts are enough.
      // Doc-only hits still use the stricter clause-coverage threshold below.
      const hasDocumentationCoverage = documentationMatches.length >= MIN_MULTI_TERM_OVERLAP;
      return {
        nodeId: row.id,
        kind: row.kind,
        source: hasDocumentationCoverage ? 'symbol anchor + docstring' : 'symbol anchor',
        clause,
        matchedTerms: hasDocumentationCoverage ? orderedUnion(matchedTerms, documentationMatches) : matchedTerms,
        anchorMatches: matchedTerms,
        nameMatches,
        documentationMatches,
        specificity: matchedTerms.reduce(
          (score, term) =>
            score + specificityWeight(term, nameMatches.includes(term)) / (frequencyByTerm.get(term) ?? 1),
          0,
        ),
        rank: -row.anchor_score,
      };
    })
    .filter((hit) => hit.anchorMatches.length >= minimumOverlap)
    .sort(compareIntentHits);
}

function specificityWeight(term: string, nameMatch: boolean): number {
  const locationWeight = nameMatch ? 1 : PATH_ONLY_SPECIFICITY_WEIGHT;
  const conceptWeight = GENERIC_INTENT_ANCHOR_TERMS.has(term) ? GENERIC_TERM_SPECIFICITY_WEIGHT : 1;
  return locationWeight * conceptWeight;
}

function mergeRankedHits(hits: readonly RankedIntentHit[], limit: number): RankedIntentHit[] {
  const bestByNodeId = new Map<string, RankedIntentHit>();
  for (const hit of hits) {
    const existing = bestByNodeId.get(hit.nodeId);
    if (!existing) {
      bestByNodeId.set(hit.nodeId, hit);
      continue;
    }
    const combined = combineAnchorAndDocumentation(existing, hit);
    bestByNodeId.set(hit.nodeId, combined ?? (compareIntentHits(hit, existing) < 0 ? hit : existing));
  }
  return [...bestByNodeId.values()].sort(compareIntentHits).slice(0, limit);
}

function combineAnchorAndDocumentation(a: RankedIntentHit, b: RankedIntentHit): RankedIntentHit | null {
  const anchor = bareSymbolAnchor(a, b);
  const documentation = documentationHit(a, b);
  if (!anchor || !documentation) return null;
  const combinedSource: IntentEvidenceSource =
    documentation.source === 'docstring' ? 'symbol anchor + docstring' : 'symbol anchor + summary';
  return {
    ...anchor,
    source: combinedSource,
    matchedTerms: orderedUnion(anchor.matchedTerms, documentation.matchedTerms),
    anchorMatches: orderedUnion(anchor.anchorMatches, documentation.anchorMatches),
    nameMatches: orderedUnion(anchor.nameMatches, documentation.nameMatches),
    documentationMatches: orderedUnion(anchor.documentationMatches, documentation.documentationMatches),
    rank: Math.min(anchor.rank, documentation.rank),
  };
}

function bareSymbolAnchor(a: RankedIntentHit, b: RankedIntentHit): RankedIntentHit | null {
  if (a.source === 'symbol anchor') return a;
  if (b.source === 'symbol anchor') return b;
  return null;
}

function documentationHit(a: RankedIntentHit, b: RankedIntentHit): RankedIntentHit | null {
  if (a.source === 'docstring' || a.source === 'summary') return a;
  if (b.source === 'docstring' || b.source === 'summary') return b;
  return null;
}

function orderedUnion(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function requiredDocumentationOverlap(termCount: number): number {
  if (termCount <= 1) return 1;
  return Math.max(MIN_MULTI_TERM_OVERLAP, Math.ceil(termCount * MIN_LONG_CLAUSE_COVERAGE));
}

function expandedAnchorTerms(terms: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    for (const variant of anchorVariants(term)) expanded.add(variant);
  }
  return [...expanded];
}

function dedupeMorphologicalTerms(terms: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const variants = anchorVariants(term);
    if (variants.some((variant) => seen.has(variant))) continue;
    result.push(term);
    for (const variant of variants) seen.add(variant);
  }
  return result;
}

function anchorVariants(term: string): string[] {
  return [term, ...getStemVariants(term).filter((variant) => term.length - variant.length <= 3)];
}

function matchConceptTerms(value: string, terms: readonly string[]): string[] {
  const valueTerms = anchorTermSet(value);
  return terms.filter((term) => expandedAnchorTerms([term]).some((variant) => valueTerms.has(variant)));
}

function anchorTermSet(value: string): Set<string> {
  const baseTerms = splitAnchorWords(value);
  const terms = new Set(baseTerms);
  for (const term of baseTerms) {
    for (const variant of anchorVariants(term)) terms.add(variant);
  }
  return terms;
}

function splitAnchorWords(value: string): string[] {
  return splitIdentifierTokens(value).filter((term) => term.length >= 3);
}

function compareIntentHits(a: RankedIntentHit, b: RankedIntentHit): number {
  const kindDiff = intentKindPriority(a.kind) - intentKindPriority(b.kind);
  if (kindDiff !== 0) return kindDiff;
  const relevanceDiff = intentRelevanceScore(b) - intentRelevanceScore(a);
  if (relevanceDiff !== 0) return relevanceDiff;
  const specificityDiff = b.specificity - a.specificity;
  if (Math.abs(specificityDiff) > Number.EPSILON) return specificityDiff;
  const channelDiff = evidenceChannelCount(b.source) - evidenceChannelCount(a.source);
  if (channelDiff !== 0) return channelDiff;
  const nameDiff = b.nameMatches.length - a.nameMatches.length;
  if (nameDiff !== 0) return nameDiff;
  const anchorDiff = b.anchorMatches.length - a.anchorMatches.length;
  if (anchorDiff !== 0) return anchorDiff;
  const overlapDiff = b.matchedTerms.length - a.matchedTerms.length;
  if (overlapDiff !== 0) return overlapDiff;
  const sourceDiff = Number(a.source !== 'symbol anchor') - Number(b.source !== 'symbol anchor');
  if (sourceDiff !== 0) return sourceDiff;
  const rankDiff = a.rank - b.rank;
  if (rankDiff !== 0) return rankDiff;
  return a.nodeId.localeCompare(b.nodeId);
}

function intentRelevanceScore(hit: RankedIntentHit): number {
  return (
    hit.nameMatches.length * 4 + hit.anchorMatches.length * 2 + hit.documentationMatches.length + hit.specificity * 50
  );
}

function intentKindPriority(kind: string): number {
  if (['function', 'method', 'route', 'component', 'class'].includes(kind)) return 0;
  if (['constant', 'variable', 'enum', 'module', 'namespace'].includes(kind)) return 1;
  if (['interface', 'struct', 'type_alias', 'trait'].includes(kind)) return 2;
  return 3;
}

function evidenceChannelCount(source: IntentEvidenceSource): number {
  return source.startsWith('symbol anchor +') ? 2 : 1;
}

function roundRobinIntentHits(perClause: readonly RankedIntentHit[][], limit: number): RankedIntentHit[] {
  const result: RankedIntentHit[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (result.length < limit) {
    let added = false;
    for (const hits of perClause) {
      const hit = hits[index];
      if (!hit || seen.has(hit.nodeId)) continue;
      seen.add(hit.nodeId);
      result.push(hit);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added && perClause.every((hits) => index >= hits.length - 1)) break;
    index++;
  }
  return result;
}
