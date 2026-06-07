import { clamp } from '../../utils.js';

export const STATUS_MAX_INLINE_TOP_N = 30;

export interface StatusRollupInput {
  readonly verbose?: boolean | undefined;
  readonly topHotspots?: unknown;
  readonly topBiomarkers?: unknown;
  readonly summaryBreakdown?: boolean | undefined;
}

export interface ResolvedStatusRollups {
  readonly topHotspots: number;
  readonly topBiomarkers: number;
  readonly summaryBreakdown: boolean;
}

export function parseInlineTopN(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === 'number' ? Math.floor(raw) : Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return clamp(n, 1, STATUS_MAX_INLINE_TOP_N);
}

export function resolveStatusRollups(input: StatusRollupInput): ResolvedStatusRollups {
  const verbose = input.verbose === true;
  const rawTopHotspots = parseInlineTopN(input.topHotspots);
  const rawTopBiomarkers = parseInlineTopN(input.topBiomarkers);
  return {
    topHotspots: verbose && rawTopHotspots === 0 ? 5 : rawTopHotspots,
    topBiomarkers: verbose && rawTopBiomarkers === 0 ? 5 : rawTopBiomarkers,
    summaryBreakdown: typeof input.summaryBreakdown === 'boolean' ? input.summaryBreakdown : verbose,
  };
}
