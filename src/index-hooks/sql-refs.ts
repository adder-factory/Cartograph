/**
 * SQL-refs index hook — extracts SQL string-literal references to
 * tables (read/write/ddl) and persists to `sql_refs`. Incremental
 * on sync; full atomic replace on indexAll. See `src/sql-refs/`.
 */

import type { IndexHook, IndexHookContext } from './registry.js';
import type { SyncResult } from '../extraction/index.js';
import { extractSqlRefs, SQL_REFS_ALGO_VERSION, LAST_MINED_SQL_REFS_ALGO_VERSION_KEY } from '../sql-refs/index.js';
import { findEnclosingNode, sortScopesBySpan, type ScopeNode } from './enclosing.js';
import { logDebug, errMsg } from '../errors.js';
import { getAllFiles, getFileByPath } from '../db/queries-files.js';
import { applySqlRefs, deleteSqlRefsForPaths, pruneOrphanedSqlRefs, replaceAllSqlRefs } from '../db/queries-refs.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';

/**
 * Run the sql-refs full-replace branch: extract every file's refs and
 * atomic-swap the table contents.
 */
function refreshSqlRefsAll(
  ctx: IndexHookContext,
  resolveEnclosing: (filePath: string, line: number) => string | null,
): void {
  const targets = getAllFiles(ctx.queries).map((f) => ({ path: f.path, language: f.language }));
  const refs = extractSqlRefs(ctx.projectRoot, targets, resolveEnclosing);
  replaceAllSqlRefs(ctx.queries, refs);
}

/** Run the sql-refs incremental branch: prune orphans, delete touched paths, append. */
function refreshSqlRefsForFiles(
  ctx: IndexHookContext,
  files: string[],
  resolveEnclosing: (filePath: string, line: number) => string | null,
): void {
  const records = files.map((p) => getFileByPath(ctx.queries, p)).filter((f): f is NonNullable<typeof f> => f != null);
  const targets = records.map((f) => ({ path: f.path, language: f.language }));
  pruneOrphanedSqlRefs(ctx.queries);
  if (targets.length > 0) {
    deleteSqlRefsForPaths(
      ctx.queries,
      targets.map((t) => t.path),
    );
  }
  const refs = extractSqlRefs(ctx.projectRoot, targets, resolveEnclosing);
  applySqlRefs(ctx.queries, refs);
}

function refresh(ctx: IndexHookContext, options: { scope: 'all' } | { scope: 'files'; files: string[] }): void {
  if (ctx.config.enableSqlRefs === false) return;
  try {
    const fileNodes = new Map<string, ScopeNode[]>();
    const resolveEnclosing = (filePath: string, line: number): string | null => {
      let nodes = fileNodes.get(filePath);
      if (!nodes) {
        nodes = sortScopesBySpan(
          ctx.queries
            .getNodesByFile(filePath)
            .filter((n) => n.kind === 'function' || n.kind === 'method' || n.kind === 'class' || n.kind === 'interface')
            .map((n) => ({ id: n.id, start: n.startLine, end: n.endLine })),
        );
        fileNodes.set(filePath, nodes);
      }
      return findEnclosingNode(nodes, line);
    };

    if (options.scope === 'all') {
      refreshSqlRefsAll(ctx, resolveEnclosing);
    } else {
      refreshSqlRefsForFiles(ctx, options.files, resolveEnclosing);
    }
    // Stamp the version after both `all` and `files` paths so the next
    // sync stays incremental (mirrors the churn hook pattern).
    setMetadata(ctx.queries, LAST_MINED_SQL_REFS_ALGO_VERSION_KEY, SQL_REFS_ALGO_VERSION);
  } catch (err) {
    logDebug(`sql-refs hook failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'sql-refs',
  afterIndexAll(ctx) {
    refresh(ctx, { scope: 'all' });
  },
  afterSync(ctx, result: SyncResult) {
    // Self-heal: when the stored algo version differs from the current one,
    // force a full re-mine so stale rows from a prior extractor version are
    // replaced — even on a no-op sync (zero changed files), which is exactly
    // the scenario after a user pulls a mining-logic fix without editing anything.
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_SQL_REFS_ALGO_VERSION_KEY);
    if (storedAlgo !== SQL_REFS_ALGO_VERSION) {
      refresh(ctx, { scope: 'all' });
      return;
    }

    if ((result.changedFilePaths && result.changedFilePaths.length > 0) || result.filesRemoved > 0) {
      refresh(ctx, { scope: 'files', files: result.changedFilePaths ?? [] });
    }
  },
};
