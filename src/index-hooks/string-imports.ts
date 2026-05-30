/**
 * String-imports index hook — extracts import-shaped specifiers
 * inside template literals / string literals and persists to
 * `string_imports`. Incremental on sync; full rescan on indexAll.
 * See `src/string-imports/` for the extractor.
 */

import type { IndexHook, IndexHookContext } from './types.js';
import type { SyncResult } from '../extraction/index.js';
import {
  extractStringImports,
  STRING_IMPORTS_ALGO_VERSION,
  LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY,
} from '../string-imports/index.js';
import { logDebug, errMsg } from '../errors.js';
import { getAllFiles, getFileByPath } from '../db/queries-files.js';
import {
  applyStringImports,
  clearStringImports,
  deleteStringImportsForPaths,
  pruneOrphanedStringImports,
} from '../db/queries-string-imports.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';

function refresh(ctx: IndexHookContext, options: { scope: 'all' } | { scope: 'files'; files: string[] }): void {
  if (ctx.config.enableStringImports === false) return;
  try {
    let targets: Array<{ path: string; language: string }>;
    if (options.scope === 'all') {
      targets = getAllFiles(ctx.queries).map((f) => ({
        path: f.path,
        language: f.language,
      }));
      clearStringImports(ctx.queries);
    } else {
      const records = options.files
        .map((p) => getFileByPath(ctx.queries, p))
        .filter((f): f is NonNullable<typeof f> => f != null);
      targets = records.map((f) => ({ path: f.path, language: f.language }));
      pruneOrphanedStringImports(ctx.queries);
      if (targets.length > 0) {
        deleteStringImportsForPaths(
          ctx.queries,
          targets.map((t) => t.path),
        );
      }
    }

    const refs = extractStringImports(ctx.projectRoot, targets);
    applyStringImports(ctx.queries, refs);
    // Stamp the algo version after every run (both afterIndexAll and afterSync)
    // so the next sync knows the stored rows are up to date.
    setMetadata(ctx.queries, LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY, STRING_IMPORTS_ALGO_VERSION);
  } catch (err) {
    logDebug(`string-imports hook failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'string-imports',
  afterIndexAll(ctx) {
    refresh(ctx, { scope: 'all' });
  },
  afterSync(ctx, result: SyncResult) {
    // Self-heal: when the stored algo version differs from the current one,
    // force a full re-mine so stale rows from a prior extractor version are
    // replaced — no `cartograph index` needed after a mining-logic fix.
    // This check must precede the changed-files guard so a no-op sync
    // (zero changed files) still triggers the full rescan.
    // Mirrors the pattern in src/index-hooks/build-context-refs.ts.
    if (ctx.config.enableStringImports !== false) {
      const storedAlgo = getMetadata(ctx.queries, LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY);
      if (storedAlgo !== STRING_IMPORTS_ALGO_VERSION) {
        refresh(ctx, { scope: 'all' });
        return;
      }
    }

    if ((result.changedFilePaths && result.changedFilePaths.length > 0) || result.filesRemoved > 0) {
      refresh(ctx, { scope: 'files', files: result.changedFilePaths ?? [] });
    }
  },
};
