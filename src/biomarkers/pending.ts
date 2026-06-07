import type Cartograph from '../index.js';
import { getMetadata } from '../db/queries-metadata.js';

/**
 * Detect whether cross-file biomarker findings are stale for the current index.
 *
 * A missing or older `biomarker_cross_file_pass_at` timestamp means the
 * findings table should be treated as pending rather than authoritative.
 */
export function areBiomarkersPending(cg: Cartograph): boolean {
  try {
    const passAtRaw = getMetadata(cg.queries, 'biomarker_cross_file_pass_at');
    if (!passAtRaw) return true;
    const passAt = Number(passAtRaw);
    if (!Number.isFinite(passAt)) return true;
    const indexedAtRaw = getMetadata(cg.queries, 'index_timestamp');
    if (!indexedAtRaw) return false;
    const indexedAt = Number(indexedAtRaw);
    if (!Number.isFinite(indexedAt)) return false;
    return passAt < indexedAt;
  } catch {
    return false;
  }
}
