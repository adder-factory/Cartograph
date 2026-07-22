/**
 * Project metadata queries — read/write the `project_metadata` table
 * plus a derived "stale artifacts" rollup for the freshness gate.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * per-domain helpers as direct members. All four functions are pure
 * DB operations — no per-instance caching, no shared prepared-
 * statement slots — so the extraction is mechanical.
 *
 * **Key-name discipline (FRICTION-17, 2026-05-14):** every key the
 * `project_metadata` table accepts is enumerated in {@link MetadataKey}
 * below. Callers MUST pass a value from that union (or a string that
 * matches the documented template prefix); a typo'd literal will fail
 * at compile time. Without this guard, three different writers used
 * three different names for the same fact ("when was the index
 * built") — `'index_timestamp'` / `'indexed_at'` / `'last_index_at'`.
 * The dead-read variants returned null silently; the only signal was
 * host discover rendering `_?_` for the indexed-at column.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

/**
 * Every metadata key the `project_metadata` table accepts. New entries
 * MUST land here in lockstep with any new writer; the type union is
 * the single source of truth for "what's a legal key."
 *
 * The `biomarker_file_state_${string}_${string}` template-literal arm
 * accepts {@link BIOMARKER_CACHE_KEY} from `src/biomarkers/index.ts`,
 * which interpolates the biomarker source-hash + EXTRACTION_LOGIC_VERSION
 * into a per-build-shape key.
 */
export type MetadataKey =
  | 'project_root'
  | 'index_timestamp'
  | 'index_head_sha'
  | 'path_alias_config_signature'
  | 'nested_function_extraction_config_signature'
  | 'source_set_config_signature'
  | 'extraction_logic_version'
  | 'last_mined_cochange_head'
  | 'last_mined_churn_head'
  | 'last_mined_churn_algo_version'
  | 'last_mined_config_refs_algo_version'
  | 'last_mined_sql_refs_algo_version'
  | 'last_mined_string_imports_algo_version'
  | 'last_mined_build_context_refs_algo_version'
  | 'last_mined_value_ref_edges_algo_version'
  | 'last_mined_dynamic_dispatch_algo_version'
  | 'last_mined_go_implements_algo_version'
  | 'last_mined_nestjs_routes_algo_version'
  | 'last_mined_spring_value_binding_algo_version'
  | 'last_mined_mybatis_binding_algo_version'
  | 'last_mined_drupal_hooks_algo_version'
  | 'last_mined_drupal_plugins_algo_version'
  | 'last_mined_drupal_service_tags_algo_version'
  | 'last_mined_fabric_native_impl_algo_version'
  | 'last_mined_rn_event_channel_algo_version'
  | 'last_mined_issues_head'
  | 'last_centrality_fingerprint'
  | 'last_betweenness_fingerprint'
  | 'last_synced_head'
  | 'coverage_report_paths'
  | 'biomarker_cross_file_pass_at'
  | 'biomarker_cross_file_errors'
  | 'similar_to_built'
  | `biomarker_file_state_${string}_${string}`;

// ─── Typed query definitions ─────────────────────────────────────────────

const getMetadataQuery = defineQuery({
  sql: 'SELECT value FROM project_metadata WHERE key = @key',
  params: z.object({ key: z.string() }),
  row: z.object({ value: z.string() }),
});

const setMetadataQuery = defineQuery({
  sql: `INSERT INTO project_metadata (key, value, updated_at)
        VALUES (@key, @value, @updatedAt)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        WHERE project_metadata.value <> excluded.value`,
  params: z.object({ key: z.string(), value: z.string(), updatedAt: z.number() }),
  row: z.never(),
});

const countStaleSummariesQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n
         FROM symbol_summaries s
         JOIN nodes n ON s.node_id = n.id
        WHERE n.body_hash <> '' AND s.content_hash <> n.body_hash`,
  params: z.object({}),
  row: z.object({ n: z.number() }),
});

const countStaleEmbeddingsQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n
         FROM embedding_refs er
         JOIN nodes n ON er.node_id = n.id
        WHERE er.grain = 'symbol'
          AND n.body_hash <> ''
          AND er.body_hash <> n.body_hash`,
  params: z.object({}),
  row: z.object({ n: z.number() }),
});

const countStaleFindingsQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n
         FROM code_health_findings c
         JOIN nodes n ON c.node_id = n.id
         JOIN files f ON n.file_path = f.path
        WHERE c.source_content_hash <> f.content_hash`,
  params: z.object({}),
  row: z.object({ n: z.number() }),
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    getMetadata?: TypedQuery<{ key: string }, { value: string }>;
    setMetadata?: TypedQuery<{ key: string; value: string; updatedAt: number }, never>;
    countStaleSummaries?: TypedQuery<Record<string, never>, { n: number }>;
    countStaleEmbeddings?: TypedQuery<Record<string, never>, { n: number }>;
    countStaleFindings?: TypedQuery<Record<string, never>, { n: number }>;
  }
}

/** Get a metadata value by key. Returns null when absent. */
export function getMetadata(qb: QueryBuilder, key: MetadataKey): string | null {
  qb.queries.getMetadata ??= getMetadataQuery(qb.db);
  const row = qb.queries.getMetadata.get({ key });
  return row?.value ?? null;
}

/** Upsert a metadata value, stamping `updated_at` only when the value changes. */
export function setMetadata(qb: QueryBuilder, key: MetadataKey, value: string): void {
  qb.queries.setMetadata ??= setMetadataQuery(qb.db);
  qb.queries.setMetadata.run({ key, value, updatedAt: Date.now() });
}

/**
 * Count pre-computed artifacts whose stored hash no longer matches the
 * canonical hash for the current source — surfaces "your LLM artifacts
 * are out of date" through the freshness gate.
 *
 * The three arms use different comparison strategies:
 *
 *  - **summaries** join `symbol_summaries.content_hash` (per-symbol
 *    sha256(sig+body) via `symbolBodyHash`) against `nodes.body_hash`
 *    (same hash function). Staleness-redesign Phase 2 / Design A.
 *    Pre-migration-048 rows with `body_hash = ''` are excluded
 *    ("tracking pending" — EXTRACTION_LOGIC_VERSION 5 heal populates
 *    them on the next sync).
 *  - **embeddings** (Phase 4 / Design C, migration 050) join
 *    `embedding_refs.body_hash` against `nodes.body_hash` for
 *    `grain = 'symbol'` rows only — file-grain rows store the
 *    file's content_hash and use a different hash space (excluded by
 *    the grain filter). Pre-migration-048 rows with empty body_hash
 *    are excluded for the same reason as the summaries arm.
 *  - **findings** compare `code_health_findings.source_content_hash`
 *    against `files.content_hash` (file-level on both sides — the
 *    biomarker rule cache key is file-keyed by construction).
 */
export function getStaleArtifactsCount(qb: QueryBuilder): {
  summaries: number;
  embeddings: number;
  findings: number;
  total: number;
} {
  // Staleness-redesign Phase 2 / Design A. Compare summary.content_hash
  // (per-symbol sha256(sig+body) written by the summarizer) against
  // nodes.body_hash (the same hash computed by the extractor on
  // createNode, migration 048). The two hashes are produced by the
  // SAME function (`symbolBodyHash`), so the comparison is semantically
  // sound — a mismatch means the symbol body actually drifted.
  //
  // Pre-migration-048 rows have body_hash = '' (DEFAULT). We exclude
  // those from the count: an empty body_hash means "tracking pending —
  // node not yet re-extracted with the new column populated." The
  // EXTRACTION_LOGIC_VERSION 4->5 bump in this commit triggers a
  // one-shot full re-extraction so every node gets a real body_hash
  // on the next sync.
  qb.queries.countStaleSummaries ??= countStaleSummariesQuery(qb.db);
  const summaries = qb.queries.countStaleSummaries.get({})?.n ?? 0;

  // Design C (migration 050): embeddings live in embedding_refs +
  // embedding_store. embedding_refs.body_hash is the symbol body hash
  // (matches nodes.body_hash by construction) ONLY for grain='symbol'
  // rows. File-grain rows store the file's content_hash as body_hash —
  // different hash space, would always appear stale without the filter.
  qb.queries.countStaleEmbeddings ??= countStaleEmbeddingsQuery(qb.db);
  const embeddings = qb.queries.countStaleEmbeddings.get({})?.n ?? 0;

  qb.queries.countStaleFindings ??= countStaleFindingsQuery(qb.db);
  const findings = qb.queries.countStaleFindings.get({})?.n ?? 0;

  return { summaries, embeddings, findings, total: summaries + embeddings + findings };
}
