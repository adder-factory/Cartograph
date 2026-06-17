/**
 * Re-link derived per-node pointer tables (`summary_refs`, `embedding_refs`)
 * from their content-addressed stores after a re-extract cascade-evicted them.
 *
 * A whole-file re-extract deletes the file's nodes, cascade-deleting their refs
 * even for symbols whose body did NOT change. The expensive artefacts survive
 * in `summary_store` / `embedding_store` (and the vec0 index, keyed by store
 * rowid), so only the per-node pointer is lost — restoring it is pure SQL, no
 * LLM / embedding-model calls.
 *
 * Both relinks share one function (the self-heal hook always restores both) so
 * the near-identical scope + reliable-count skeleton lives in one place. Counts
 * come from a pre-`INSERT` SELECT: the `*_refs` `last_ref_at` AFTER-INSERT
 * triggers inflate the driver's `info.changes`, so it cannot be trusted as a
 * relinked-row count.
 *
 * Both count→INSERT pairs run inside a single transaction: the returned counts
 * then exactly match the rows written (no interleaved writer can invalidate the
 * pre-INSERT count), and the embedding back-fill's read of `summary_refs` is
 * guaranteed to see the summaries relinked in the same transaction first. Every
 * caller already holds the index mutex (single writer per project), so the
 * transaction is belt-and-suspenders rather than the only guard.
 *
 * Scope to `nodeIds` (the bounded set a sync re-extracted) or pass undefined to
 * relink every node (post-`indexAll` clean-slate). `[]` is a no-op.
 */
import type { QueryBuilder } from './queries.js';

export interface RelinkCounts {
  summaries: number;
  embeddings: number;
}

export function relinkDerivedRefsFromStore(qb: QueryBuilder, nodeIds?: readonly string[]): RelinkCounts {
  if (nodeIds?.length === 0) return { summaries: 0, embeddings: 0 };
  const scope = nodeIds === undefined ? '' : ' AND n.id IN (SELECT value FROM json_each(@nodeIds))';
  const params = nodeIds === undefined ? {} : { nodeIds: JSON.stringify(nodeIds) };
  const countOf = (where: string, expr: string): number =>
    (qb.db.prepare(`SELECT ${expr} AS n ${where}`).get(params) as { n: number }).n;

  // One transaction so the returned counts match the rows inserted and the
  // embedding back-fill below reads the summary_refs relinked just above.
  // Nests as a SAVEPOINT when a caller already opened a transaction.
  return qb.db.transaction((): RelinkCounts => {
    // Summaries: one ref per node; MAX(generated_at) picks the freshest summary
    // for a body on multi-model ties.
    const sumWhere =
      `FROM nodes n
       JOIN summary_store ss ON ss.body_hash = n.body_hash
      WHERE n.body_hash != '' AND n.id NOT IN (SELECT node_id FROM summary_refs)` + scope;
    const summaries = countOf(sumWhere, 'COUNT(DISTINCT n.id)');
    qb.db
      .prepare(`INSERT OR IGNORE INTO summary_refs (node_id, body_hash, model)
       SELECT n.id, ss.body_hash, ss.model ${sumWhere}
         AND ss.generated_at = (SELECT MAX(s2.generated_at) FROM summary_store s2 WHERE s2.body_hash = n.body_hash)`)
      .run(params);

    // Embeddings: a ref per (node, store-row); the vec0 vector survives, so the
    // restored ref makes the node searchable again immediately. Back-fill
    // summary_hash_at_embed from the summary just relinked above — the node's
    // current summary content_hash IS its summary_refs.body_hash — so the next
    // `embed` staleness check (getEmbeddableNodes compares ss.content_hash vs
    // summary_hash_at_embed) does not flag these nodes and re-run the embedder.
    // '' when the node has no summary (matches getEmbeddableNodes' COALESCE).
    const embWhere =
      `FROM nodes n
       JOIN embedding_store es ON es.body_hash = n.body_hash
      WHERE n.body_hash != '' AND es.grain = 'symbol'
        AND NOT EXISTS (
          SELECT 1 FROM embedding_refs er
           WHERE er.node_id = n.id AND er.model = es.model AND er.grain = es.grain
        )` + scope;
    const embeddings = countOf(embWhere, 'COUNT(*)');
    qb.db
      .prepare(`INSERT OR IGNORE INTO embedding_refs (node_id, body_hash, model, grain, summary_hash_at_embed)
       SELECT n.id, n.body_hash, es.model, es.grain,
              COALESCE((SELECT sr.body_hash FROM summary_refs sr WHERE sr.node_id = n.id), '') ${embWhere}`)
      .run(params);

    return { summaries, embeddings };
  })();
}
