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

async function reapply(ctx: IndexHookContext): Promise<void> {
  const paths = getCoverageReportPaths(ctx.queries);
  for (const [source, reportPath] of Object.entries(paths)) {
    const reportExists = await fsp
      .access(reportPath)
      .then(() => true)
      .catch(() => false);
    if (!reportExists) {
      logDebug(
        `coverage-reapply: report for source '${source}' missing on disk ` +
          `(${reportPath}); skipping — run cartograph_coverage load/refresh to re-point it`,
      );
      continue;
    }
    try {
      // clearSource omitted (false): upsert is idempotent, and rows
      // for symbols deleted by an edit are already cascade-gone, so a
      // plain re-apply leaves no stale rows.
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
