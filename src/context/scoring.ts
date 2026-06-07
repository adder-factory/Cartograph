import * as path from 'node:path';
import type { Node, SearchResult } from '../types.js';

export const CENTRALITY_BOOST_WEIGHT = 5;
export const COLOCATION_BOOST = 20;
export const TEXT_MULTI_TERM_BONUS = 5;
export const TEXT_SEARCH_DAMPEN_RATE = 0.5;
export const TEST_FILE_PENALTY = 0.3;

const BEHAVIOR_BIAS_FN_BOOST = 1.4;
const BEHAVIOR_BIAS_SHAPE_PENALTY = 0.7;
const BEHAVIOR_BIAS_FN_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'route', 'component']);
const BEHAVIOR_BIAS_SHAPE_KINDS: ReadonlySet<string> = new Set(['interface', 'type_alias', 'enum', 'enum_member']);

export interface ApplyMultiTermBoostArgs {
  result: SearchResult;
  matchCount: number;
  exactMatchIds: Set<string>;
  extraIds: ReadonlySet<string>;
}

export function accumulateTermResults(
  termResultsMap: Map<string, { result: SearchResult; termHits: number }>,
  termResults: ReadonlyArray<SearchResult>,
  weight: number,
): void {
  const skipReweight = weight >= 0.999;
  for (const r of termResults) {
    const reweighted = { ...r, score: r.score * weight };
    const adjusted = skipReweight ? r : reweighted;
    const existing = termResultsMap.get(r.node.id);
    if (existing) {
      existing.termHits++;
      existing.result.score = Math.max(existing.result.score, adjusted.score);
      continue;
    }
    termResultsMap.set(r.node.id, { result: adjusted, termHits: 1 });
  }
}

export function applyBehaviorBias(results: SearchResult[]): void {
  for (const r of results) {
    if (BEHAVIOR_BIAS_FN_KINDS.has(r.node.kind)) {
      r.score *= BEHAVIOR_BIAS_FN_BOOST;
    } else if (BEHAVIOR_BIAS_SHAPE_KINDS.has(r.node.kind)) {
      r.score *= BEHAVIOR_BIAS_SHAPE_PENALTY;
    }
  }
}

export function applyCentralityBoost(results: SearchResult[], weight: number): void {
  if (weight <= 0) return;
  for (const r of results) {
    const c = r.node.centrality;
    if (c == null || c <= 0) continue;
    r.score *= 1 + weight * Math.sqrt(c);
  }
}

export function mergeSearchChannels(exactMatches: SearchResult[], textResults: SearchResult[]): SearchResult[] {
  const resultById = new Map<string, SearchResult>();
  const merged: SearchResult[] = [];
  for (const result of exactMatches) mergeSearchResult(resultById, merged, result);
  for (const result of textResults) mergeSearchResult(resultById, merged, result);
  return merged;
}

export function groupSubstringStemVariants(queryTerms: string[]): string[][] {
  const termGroups: string[][] = [];
  const sorted = [...queryTerms].sort((a, b) => b.length - a.length);
  const assigned = new Set<string>();
  for (const term of sorted) {
    if (assigned.has(term)) continue;
    const group = [term];
    assigned.add(term);
    for (const other of sorted) {
      if (assigned.has(other)) continue;
      if (term.includes(other) || other.includes(term)) {
        group.push(other);
        assigned.add(other);
      }
    }
    termGroups.push(group);
  }
  return termGroups;
}

export function countTermGroupMatches(node: Node, termGroups: string[][]): number {
  const nameLower = node.name.toLowerCase();
  const dirSegments = path.dirname(node.filePath).toLowerCase().split('/');
  let matchCount = 0;
  for (const group of termGroups) {
    if (groupMatchesNode(group, nameLower, dirSegments)) matchCount++;
  }
  return matchCount;
}

export function applyMultiTermBoost(args: ApplyMultiTermBoostArgs): void {
  const { result, matchCount, exactMatchIds, extraIds } = args;
  if (matchCount >= 2) {
    result.score *= 1 + matchCount * 0.5;
  } else if (!exactMatchIds.has(result.node.id) && !extraIds.has(result.node.id)) {
    result.score *= 0.6;
  }
}

export function colocationScore(baseScore: number, symbolCount: number): number {
  return symbolCount > 1 ? baseScore + (symbolCount - 1) * COLOCATION_BOOST : baseScore;
}

function mergeSearchResult(byId: Map<string, SearchResult>, merged: SearchResult[], result: SearchResult): void {
  const existing = byId.get(result.node.id);
  if (existing) {
    existing.score = Math.max(existing.score, result.score);
    return;
  }
  byId.set(result.node.id, result);
  merged.push(result);
}

function groupMatchesNode(group: string[], nameLower: string, dirSegments: string[]): boolean {
  for (const term of group) {
    if (nameLower.includes(term)) return true;
    if (dirSegments.includes(term)) return true;
  }
  return false;
}
