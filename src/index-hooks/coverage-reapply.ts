/**
 * Coverage-reapply index hook — re-derives `node_coverage` from the
 * persisted lcov report after a sync / indexAll re-extracts files.
 *
 * Re-extraction mints fresh content-addressed node ids; the old
 * nodes' `node_coverage` rows cascade-delete (FK ON DELETE CASCADE),
 * so without this hook lcov coverage silently erodes with every edit
 * — and `index --force` wipes it wholesale. The hook re-reads the
 * report path recorded by the last `cartograph_coverage` load/refresh
 * and re-ingests it, restoring coverage for the re-extracted symbols.
 *
 * Ordering: registered BEFORE the biomarkers hook so the full
 * biomarker pass (which owns the `low_coverage` rule) sees fresh
 * coverage rather than the post-re-extraction decayed set.
 *
 * No-op when coverage was never loaded (no report path on record) or
 * the report file is no longer on disk — best-effort by design.
 */

import * as fsp from 'node:fs/promises';
import type { IndexHook, IndexHookContext } from './registry.js';
import type { SyncResult } from '../extraction/index.js';
import { ingestCoverage, getCoverageReportPaths } from '../coverage/index.js';
import { logDebug, errMsg } from '../errors.js';

/** One persisted (source, report) pair to re-apply. */
interface ReapplyJob {
  source: string;
  reportPath: string;
}

async function reapply(ctx: IndexHookContext): Promise<void> {
  const paths = getCoverageReportPaths(ctx.queries);
  // Flatten to (source, reportPath) jobs in persisted (oldest-first)
  // order. Each label can have several reports — sharded test runs, or
  // monorepo workspaces each exercising a shared file. The upsert
  // max-merges, so re-applying all of them reconstructs the same union
  // the original loads produced (#17).
  const jobs: ReapplyJob[] = Object.entries(paths).flatMap(([source, reportPaths]) =>
    reportPaths.map((reportPath) => ({ source, reportPath })),
  );
  // Sequential by design: every ingest mutates the same DB and the
  // max-merge is order-independent, so there is nothing to parallelize.
  for (const { source, reportPath } of jobs) {
    await reapplyReport(ctx, source, reportPath);
  }
}

/** Re-ingest a single persisted report; best-effort, never throws. */
async function reapplyReport(ctx: IndexHookContext, source: string, reportPath: string): Promise<void> {
  const reportExists = await fsp
    .access(reportPath)
    .then(() => true)
    .catch(() => false);
  if (!reportExists) {
    logDebug(
      `coverage-reapply: report for source '${source}' missing on disk ` +
        `(${reportPath}); skipping — run cartograph_coverage load/refresh to re-point it`,
    );
    return;
  }
  try {
    // clearSource omitted (false): upsert max-merges, and rows for
    // symbols deleted by an edit are already cascade-gone, so a plain
    // re-apply leaves no stale rows and unions all reports.
    await ingestCoverage({
      queries: ctx.queries,
      projectRoot: ctx.projectRoot,
      reportPath,
      options: { source },
    });
  } catch (err) {
    logDebug(`coverage-reapply: re-ingest of source '${source}' failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'coverage-reapply',
  async afterIndexAll(ctx) {
    await reapply(ctx);
  },
  async afterSync(ctx, result: SyncResult) {
    // Only re-apply when files actually changed — a no-op sync left
    // every node id intact, so coverage rows are still valid.
    if ((result.changedFilePaths && result.changedFilePaths.length > 0) || result.filesRemoved > 0) {
      await reapply(ctx);
    }
  },
};
