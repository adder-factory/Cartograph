import type { MigrationModule } from './types.js';

/**
 * Add `summary_hash_at_embed` to `symbol_embeddings` so the
 * pipeline can detect "summary now exists but the embedding was
 * generated without it" as a staleness signal and trigger a
 * re-embed.
 *
 * Background — after migration 033 decoupled embeddings from
 * summaries, embed runs first (faster path to hot semantic
 * search) and summarise runs second. Without this column, an
 * embedding generated at t=2min from name + signature +
 * docstring stays in place even after summarise lands a 200-char
 * LLM summary at t=4h — `getEmbeddableNodes` keys staleness on
 * `files.content_hash`, which didn't change, so the embedding is
 * never refreshed.
 *
 * With this column, `upsertSymbolEmbedding` records the summary
 * `content_hash` baked into each embedding (or `''` when there
 * was no summary at embed time). The query then treats
 * `COALESCE(ss.content_hash, '') != e.summary_hash_at_embed` as
 * stale, and the second embed pass after summarise picks up
 * exactly the nodes that gained a summary.
 *
 * Existing embeddings get the empty-string default. On first run
 * after migration, every node that already has a summary
 * naturally appears stale (`'' != ss.content_hash`) and gets
 * re-embedded with the richer text. Existing migration-020
 * `source_content_hash` shape is mirrored — TEXT NOT NULL DEFAULT
 * '' so the column never carries NULL for already-written rows.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add summary_hash_at_embed to symbol_embeddings — re-embed nodes whose summary changed or arrived later',
  up: (db) => {
    // Post-migration-050 symbol_embeddings is a VIEW; ALTER TABLE fails.
    // Design C carries this column on embedding_refs directly.
    const existing = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_embeddings'").get() as
      | { type: string }
      | undefined;
    if (existing?.type === 'view') return;
    db.exec(`
      ALTER TABLE symbol_embeddings
        ADD COLUMN summary_hash_at_embed TEXT NOT NULL DEFAULT '';
    `);
  },
};
