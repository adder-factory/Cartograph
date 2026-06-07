import type { Edge } from '../types.js';

/**
 * Numeric ordering of confidence levels. Higher = more trustworthy.
 * AMBIGUOUS is the floor so filtering at AMBIGUOUS keeps every edge.
 */
export const CONFIDENCE_RANK: Record<NonNullable<Edge['confidence']>, number> = {
  EXTRACTED: 2,
  INFERRED: 1,
  AMBIGUOUS: 0,
};

/**
 * Filter `(node, edge)` rows so only edges at-or-above `min` survive.
 * Edges with no confidence default to EXTRACTED, matching the migration
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
 * Render a confidence suffix for an edge whose resolver confidence is
 * below the trustworthy default. EXTRACTED rows render no suffix.
 */
export function formatConfidence(edge: Edge | undefined): string {
  const c = edge?.confidence;
  if (!c || c === 'EXTRACTED') return '';
  return ` *(${c})*`;
}

/**
 * Detect when every rendered row carries the same non-default confidence,
 * allowing renderers to hoist the marker to a header.
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
 * Render a "(N call sites: l1, l2, …)" suffix when the underlying edge
 * represents multiple source sites.
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
