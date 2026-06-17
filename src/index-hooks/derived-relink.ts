/**
 * Derived-data self-heal index hook.
 *
 * A whole-file re-extract (an edit, a concurrent agent's sync, an
 * `index --force`) deletes the file's nodes, cascade-deleting their
 * `summary_refs`, `embedding_refs`, and `similar_to` edges — even for the
 * symbols in that file whose own body did NOT change. The expensive artefacts
 * survive in the content-addressed stores (`summary_store`, `embedding_store`)
 * and the vec0 index (keyed by store rowid, not node id), so the only thing
 * lost is the per-node pointer.
 *
 * This hook re-pins those pointers from the stores after extraction — pure SQL,
 * zero LLM/embedding-model calls — and incrementally repairs the affected
 * nodes' outgoing `similar_to` edges. The result: a concurrent re-index stops
 * eroding semantic search, summary coverage, and similarity navigation.
 *
 * Ordering: registered next to `coverage-reapply` in Group B (before the
 * biomarker / centrality readers in Group C). Genuinely-changed symbols (new
 * `body_hash` absent from the stores) are not matched here — they fall to the
 * normal summarise / embed passes.
 *
 * PostgreSQL/pgvector projects: the incremental `similar_to` repair is a no-op
 * there (it uses the sqlite-vec index), so pgvector users rely on the next full
 * `build-similarity-edges` to restore similarity edges. The ref relinks (which
 * are pure SQL) still apply on every backend.
 */

import type { IndexHook, IndexHookContext } from './types.js';
import type { SyncResult } from '../extraction/index.js';
import type { QueryBuilder } from '../db/queries.js';
import { relinkDerivedRefsFromStore } from '../db/relink-refs.js';
import { repairSimilarToForNodes } from '../embeddings/similar-edges.js';

/** Current node ids living in the given (re-extracted) files. */
function nodeIdsForFiles(qb: QueryBuilder, filePaths: readonly string[]): string[] {
  if (filePaths.length === 0) return [];
  const rows = qb.db
    .prepare('SELECT id FROM nodes WHERE file_path IN (SELECT value FROM json_each(@paths))')
    .all({ paths: JSON.stringify(filePaths) }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** True when the project uses similar_to (some edge survives on an unchanged node). */
function similarToInUse(qb: QueryBuilder): boolean {
  const row = qb.db.prepare("SELECT EXISTS(SELECT 1 FROM edges WHERE kind = 'similar_to') AS ok").get() as
    | { ok: number }
    | undefined;
  return row?.ok === 1;
}

export const HOOK: IndexHook = {
  name: 'derived-relink',

  afterIndexAll(ctx: IndexHookContext): void {
    // indexAll re-extracted everything; restore cached summaries + embeddings
    // for every unchanged body from the content-addressed stores. similar_to is
    // left to `build-similarity-edges`: indexAll wiped every edge, so there is
    // no bounded subset to repair and a full O(N) rebuild does not belong in a
    // post-index hook.
    relinkDerivedRefsFromStore(ctx.queries);
  },

  afterSync(ctx: IndexHookContext, result: SyncResult): void {
    const changed = result.changedFilePaths ?? [];
    if (changed.length === 0) return; // no-op sync left every node id intact
    const nodeIds = nodeIdsForFiles(ctx.queries, changed);
    if (nodeIds.length === 0) return;

    relinkDerivedRefsFromStore(ctx.queries, nodeIds);

    // Only repair similar_to when the feature is already in use — never start
    // materialising it for a project that never built it.
    if (similarToInUse(ctx.queries)) {
      repairSimilarToForNodes({
        db: ctx.db.getDb(),
        queries: ctx.queries,
        vecLoaded: ctx.db.hasVecExtension(),
        nodeIds,
      });
    }
  },
};
