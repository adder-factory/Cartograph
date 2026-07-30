use std::time::Duration;

use cartograph_domain::ProjectId;
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, GenerationStorageSummary, StorageError,
    database::{quoted_schema, set_local_statement_timeout},
};

const MAXIMUM_STORAGE_ROWS: u16 = 128;
const DEFAULT_PARSE_CACHE_ROWS: u64 = 20_000;
const DEFAULT_PARSE_CACHE_PAYLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_PARSE_CACHE_CONTRACTS: u64 = 2;
const PARSE_CACHE_AMPLIFICATION_MINIMUM_BYTES: u64 = 64 * 1024 * 1024;
const PARSE_CACHE_AMPLIFICATION_ALLOWANCE_BYTES: u64 = 64 * 1024 * 1024;
const PARSE_CACHE_AMPLIFICATION_MULTIPLIER: u64 = 4;
const STALE_READY_AGE: Duration = Duration::from_hours(24);

/// One bounded relation-level storage and autovacuum signal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStorageUsage {
    /// Relation for this record.
    pub relation: String,
    /// Number of bytes used by the heap.
    pub heap_bytes: u64,
    /// Number of bytes used by the index.
    pub index_bytes: u64,
    /// Number of bytes used by the toast.
    pub toast_bytes: u64,
    /// Number of bytes used by the total.
    pub total_bytes: u64,
    /// Number of estimated live rows.
    pub estimated_live_rows: u64,
    /// Number of estimated dead rows.
    pub estimated_dead_rows: u64,
    /// Optional last autovacuum, when available.
    pub last_autovacuum: Option<String>,
    /// Number of autovacuum entries.
    pub autovacuum_count: u64,
}

/// One bounded index allocation and catalog-health signal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStorageUsage {
    /// Index for this record.
    pub index: String,
    /// Table for this record.
    pub table: String,
    /// Access method for this record.
    pub access_method: String,
    /// Allocated byte size.
    pub bytes: u64,
    /// Whether the catalog entry is valid.
    pub valid: bool,
    /// Whether the catalog entry is ready for queries.
    pub ready: bool,
}

/// Logical and allocated parse-cache pressure for one project and schema.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseCacheStorageUsage {
    /// Number of rows.
    pub rows: u64,
    /// Number of contracts.
    pub contracts: u64,
    /// Number of bytes used by the logical payload.
    pub logical_payload_bytes: u64,
    /// Number of bytes used by the stored payload.
    pub stored_payload_bytes: u64,
    /// Number of bytes used by the schema stored payload.
    pub schema_stored_payload_bytes: u64,
    /// Number of bytes used by the physical relation.
    pub physical_relation_bytes: u64,
    /// Number of bytes used by the physical overhead.
    pub physical_overhead_bytes: u64,
}

/// Exact duplicate-content evidence. Mutation remains disabled until facts can
/// be shared without weakening immutable generation identity or freshness.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationDeduplicationAssessment {
    /// Number of duplicate content groups.
    pub duplicate_content_groups: u64,
    /// Number of redundant generations.
    pub redundant_generations: u64,
    /// Number of bytes used by the estimated redundant source.
    pub estimated_redundant_source_bytes: u64,
    /// Whether the current schema can safely deduplicate immutable generation data.
    pub mutation_supported: bool,
    /// Required migration for this record.
    pub required_migration: &'static str,
}

/// Stable storage warnings intended for CLI/MCP automation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageWarning {
    /// Represents the parse cache contract budget exceeded storage warning.
    ParseCacheContractBudgetExceeded,
    /// Represents the parse cache row budget exceeded storage warning.
    ParseCacheRowBudgetExceeded,
    /// Represents the parse cache payload budget exceeded storage warning.
    ParseCachePayloadBudgetExceeded,
    /// Represents the parse cache physical amplification storage warning.
    ParseCachePhysicalAmplification,
    /// Represents the stale ready generation storage warning.
    StaleReadyGeneration,
    /// Represents the invalid concurrent index artifact storage warning.
    InvalidConcurrentIndexArtifact,
    /// Represents the dead tuple pressure storage warning.
    DeadTuplePressure,
    /// Represents the duplicate generation content storage warning.
    DuplicateGenerationContent,
    /// Represents the relation list truncated storage warning.
    RelationListTruncated,
    /// Represents the index list truncated storage warning.
    IndexListTruncated,
}

/// Database, schema, relation, cache, generation, and maintenance-pressure
/// evidence. Byte counts are allocated bytes unless explicitly named logical.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageReport {
    /// Number of bytes used by the database.
    pub database_bytes: u64,
    /// Number of bytes used by the schema.
    pub schema_bytes: u64,
    /// Number of bytes used by the heap.
    pub heap_bytes: u64,
    /// Number of bytes used by the index.
    pub index_bytes: u64,
    /// Number of bytes used by the btree index.
    pub btree_index_bytes: u64,
    /// Number of bytes used by the toast.
    pub toast_bytes: u64,
    /// Generation storage for this record.
    pub generation_storage: GenerationStorageSummary,
    /// Parse cache for this record.
    pub parse_cache: ParseCacheStorageUsage,
    /// Number of stale ready generations.
    pub stale_ready_generations: u64,
    /// Bounded tables included in this result.
    pub tables: Vec<TableStorageUsage>,
    /// Bounded indexes included in this result.
    pub indexes: Vec<IndexStorageUsage>,
    /// Whether additional table-storage rows were omitted.
    pub tables_truncated: bool,
    /// Whether additional index-storage rows were omitted.
    pub indexes_truncated: bool,
    /// Deduplication for this record.
    pub deduplication: GenerationDeduplicationAssessment,
    /// Bounded warnings included in this result.
    pub warnings: Vec<StorageWarning>,
}

impl CartographDatabase {
    /// Inspect bounded schema storage under one repeatable transaction.
    /// # Errors
    ///
    /// Returns an error if the row limit or timeout is invalid, the project is
    /// unavailable, or repeatable-read storage statistics cannot be queried or decoded.
    pub async fn storage_usage(
        &self,
        project_id: &ProjectId,
        limit: u16,
        statement_timeout: Duration,
    ) -> Result<StorageUsageReport, StorageError> {
        if limit == 0 || limit > MAXIMUM_STORAGE_ROWS || statement_timeout.is_zero() {
            return Err(StorageError::InvalidInput {
                field: "storage_usage",
            });
        }
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("storage-usage-begin"))?;
        query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("storage-usage-snapshot"))?;
        set_local_statement_timeout(&mut transaction, statement_timeout)
            .await
            .map_err(|()| StorageError::InvalidInput {
                field: "storage_usage",
            })?;
        let totals = load_storage_totals(&mut transaction, self).await?;
        let generation_storage =
            load_generation_storage(&mut transaction, self, project_id).await?;
        let parse_cache = load_parse_cache_storage(&mut transaction, self, project_id).await?;
        let stale_ready_generations =
            load_stale_ready_generations(&mut transaction, self, project_id).await?;
        let (tables, tables_truncated) = load_table_storage(&mut transaction, self, limit).await?;
        let (indexes, indexes_truncated) =
            load_index_storage(&mut transaction, self, limit).await?;
        let deduplication = load_deduplication(&mut transaction, self, project_id).await?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error("storage-usage-commit"))?;
        let warnings = storage_warnings(StorageWarningInput {
            parse_cache,
            stale_ready_generations,
            tables: &tables,
            indexes: &indexes,
            tables_truncated,
            indexes_truncated,
            deduplication,
        });
        Ok(StorageUsageReport {
            database_bytes: totals.database,
            schema_bytes: totals.schema,
            heap_bytes: totals.heap,
            index_bytes: totals.index,
            btree_index_bytes: totals.btree_index,
            toast_bytes: totals.toast,
            generation_storage,
            parse_cache,
            stale_ready_generations,
            tables,
            indexes,
            tables_truncated,
            indexes_truncated,
            deduplication,
            warnings,
        })
    }
}

struct StorageTotals {
    database: u64,
    schema: u64,
    heap: u64,
    index: u64,
    btree_index: u64,
    toast: u64,
}

async fn load_storage_totals(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
) -> Result<StorageTotals, StorageError> {
    let statement = r"WITH tables AS (
            SELECT classes.oid,
                   pg_relation_size(classes.oid)::bigint AS heap_bytes,
                   pg_indexes_size(classes.oid)::bigint AS index_bytes,
                   pg_total_relation_size(classes.oid)::bigint AS total_bytes
            FROM pg_catalog.pg_class AS classes
            INNER JOIN pg_catalog.pg_namespace AS namespaces
                ON namespaces.oid = classes.relnamespace
            WHERE namespaces.nspname = $1
              AND classes.relkind IN ('r', 'p', 'm')
        ), btree AS (
            SELECT COALESCE(sum(pg_relation_size(indexes.oid)), 0)::bigint AS bytes
            FROM pg_catalog.pg_class AS indexes
            INNER JOIN pg_catalog.pg_namespace AS namespaces
                ON namespaces.oid = indexes.relnamespace
            INNER JOIN pg_catalog.pg_index AS catalog
                ON catalog.indexrelid = indexes.oid
            INNER JOIN pg_catalog.pg_am AS methods
                ON methods.oid = indexes.relam
            WHERE namespaces.nspname = $1
              AND methods.amname = 'btree'
        )
        SELECT pg_database_size(current_database())::bigint AS database_bytes,
               COALESCE(sum(tables.total_bytes), 0)::bigint AS schema_bytes,
               COALESCE(sum(tables.heap_bytes), 0)::bigint AS heap_bytes,
               COALESCE(sum(tables.index_bytes), 0)::bigint AS index_bytes,
               COALESCE(sum(GREATEST(
                   tables.total_bytes - tables.heap_bytes - tables.index_bytes, 0
               )), 0)::bigint AS toast_bytes,
               (SELECT bytes FROM btree) AS btree_index_bytes
        FROM tables";
    let row = query(statement)
        .bind(database.schema.as_str())
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("storage-totals"))?;
    Ok(StorageTotals {
        database: nonnegative(&row, "database_bytes")?,
        schema: nonnegative(&row, "schema_bytes")?,
        heap: nonnegative(&row, "heap_bytes")?,
        index: nonnegative(&row, "index_bytes")?,
        btree_index: nonnegative(&row, "btree_index_bytes")?,
        toast: nonnegative(&row, "toast_bytes")?,
    })
}

async fn load_generation_storage(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    project_id: &ProjectId,
) -> Result<GenerationStorageSummary, StorageError> {
    let schema = quoted_schema(&database.schema);
    let statement = format!(
        r#"SELECT
                count(*) FILTER (WHERE state = 'staging')::bigint AS staging,
                count(*) FILTER (WHERE state = 'ready')::bigint AS ready,
                count(*) FILTER (WHERE state = 'current')::bigint AS current,
                count(*) FILTER (WHERE state = 'superseded')::bigint AS superseded,
                count(*) FILTER (WHERE state = 'failed')::bigint AS failed,
                COALESCE((
                    SELECT sum(files.byte_size)::bigint
                    FROM {schema}."files" AS files
                    WHERE files.project_id = $1::uuid
                ), 0)::bigint AS source_bytes,
                COALESCE((
                    SELECT sum(pg_total_relation_size(tables.oid))::bigint
                    FROM {schema}."generation_search_relations" AS relations
                    INNER JOIN pg_catalog.pg_namespace AS namespaces
                      ON namespaces.nspname = $2
                    INNER JOIN pg_catalog.pg_class AS tables
                      ON tables.relnamespace = namespaces.oid
                     AND tables.relname = 'search_g_'
                         || replace(relations.generation_id::text, '-', '')
                    WHERE relations.project_id = $1::uuid
                ), 0)::bigint AS search_relation_bytes
            FROM {schema}."index_generations"
            WHERE project_id = $1::uuid"#
    );
    let row = query(AssertSqlSafe(statement))
        .bind(project_id.as_str())
        .bind(database.schema.as_str())
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("storage-generation-summary"))?;
    let source_bytes = nonnegative(&row, "source_bytes")?;
    let search_relation_bytes = nonnegative(&row, "search_relation_bytes")?;
    Ok(GenerationStorageSummary {
        staging: nonnegative(&row, "staging")?,
        ready: nonnegative(&row, "ready")?,
        current: nonnegative(&row, "current")?,
        superseded: nonnegative(&row, "superseded")?,
        failed: nonnegative(&row, "failed")?,
        source_bytes,
        search_relation_bytes,
        estimated_retained_bytes: source_bytes
            .checked_add(search_relation_bytes)
            .ok_or_else(|| corrupt("estimated_retained_bytes"))?,
    })
}

async fn load_parse_cache_storage(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    project_id: &ProjectId,
) -> Result<ParseCacheStorageUsage, StorageError> {
    let schema = quoted_schema(&database.schema);
    let statement = format!(
        r#"SELECT count(*) FILTER (WHERE project_id = $1::uuid)::bigint AS rows,
                  count(DISTINCT extractor_contract_digest)
                      FILTER (WHERE project_id = $1::uuid)::bigint AS contracts,
                  COALESCE(sum(payload_bytes)
                      FILTER (WHERE project_id = $1::uuid), 0)::bigint
                      AS logical_payload_bytes,
                  COALESCE(sum(pg_column_size(payload))
                      FILTER (WHERE project_id = $1::uuid), 0)::bigint
                      AS stored_payload_bytes,
                  COALESCE(sum(pg_column_size(payload)), 0)::bigint
                      AS schema_stored_payload_bytes,
                  pg_total_relation_size('{schema}."native_parse_cache"'::regclass)::bigint
                      AS physical_relation_bytes
           FROM {schema}."native_parse_cache""#
    );
    let row = query(AssertSqlSafe(statement))
        .bind(project_id.as_str())
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("storage-parse-cache"))?;
    let schema_stored_payload_bytes = nonnegative(&row, "schema_stored_payload_bytes")?;
    let physical_relation_bytes = nonnegative(&row, "physical_relation_bytes")?;
    Ok(ParseCacheStorageUsage {
        rows: nonnegative(&row, "rows")?,
        contracts: nonnegative(&row, "contracts")?,
        logical_payload_bytes: nonnegative(&row, "logical_payload_bytes")?,
        stored_payload_bytes: nonnegative(&row, "stored_payload_bytes")?,
        schema_stored_payload_bytes,
        physical_relation_bytes,
        physical_overhead_bytes: physical_relation_bytes
            .saturating_sub(schema_stored_payload_bytes),
    })
}

async fn load_stale_ready_generations(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    project_id: &ProjectId,
) -> Result<u64, StorageError> {
    let age_millis =
        i64::try_from(STALE_READY_AGE.as_millis()).map_err(|_| StorageError::InvalidInput {
            field: "storage_usage",
        })?;
    let schema = quoted_schema(&database.schema);
    let statement = format!(
        r#"SELECT count(*)::bigint AS stale_ready
           FROM {schema}."index_generations" AS generations
           WHERE generations.project_id = $1::uuid
             AND generations.state = 'ready'
             AND COALESCE(generations.ready_at, generations.started_at)
                 <= clock_timestamp() - $2 * interval '1 millisecond'
             AND generations.generation_id IS DISTINCT FROM (
                 SELECT current_generation_id FROM {schema}."projects"
                 WHERE project_id = $1::uuid
             )
             AND NOT EXISTS (
                 SELECT 1 FROM {schema}."project_operation_leases" AS leases
                 WHERE leases.project_id = generations.project_id
                   AND leases.generation_id = generations.generation_id
                   AND leases.expires_at > clock_timestamp()
             )
             AND NOT EXISTS (
                 SELECT 1 FROM {schema}."v1_import_runs" AS imports
                 WHERE imports.project_id = generations.project_id
                   AND imports.generation_id = generations.generation_id
                   AND imports.checkpoint <> 'complete'
             )"#
    );
    let row = query(AssertSqlSafe(statement))
        .bind(project_id.as_str())
        .bind(age_millis)
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("storage-stale-ready"))?;
    nonnegative(&row, "stale_ready")
}

async fn load_table_storage(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    limit: u16,
) -> Result<(Vec<TableStorageUsage>, bool), StorageError> {
    let statement = r"SELECT classes.relname,
               pg_relation_size(classes.oid)::bigint AS heap_bytes,
               pg_indexes_size(classes.oid)::bigint AS index_bytes,
               GREATEST(
                   pg_total_relation_size(classes.oid)
                   - pg_relation_size(classes.oid)
                   - pg_indexes_size(classes.oid), 0
               )::bigint AS toast_bytes,
               pg_total_relation_size(classes.oid)::bigint AS total_bytes,
               COALESCE(stats.n_live_tup, 0)::bigint AS live_rows,
               COALESCE(stats.n_dead_tup, 0)::bigint AS dead_rows,
               stats.last_autovacuum::text,
               COALESCE(stats.autovacuum_count, 0)::bigint AS autovacuum_count,
               count(*) OVER ()::bigint AS total_relations
        FROM pg_catalog.pg_class AS classes
        INNER JOIN pg_catalog.pg_namespace AS namespaces
            ON namespaces.oid = classes.relnamespace
        LEFT JOIN pg_catalog.pg_stat_user_tables AS stats
            ON stats.relid = classes.oid
        WHERE namespaces.nspname = $1
          AND classes.relkind IN ('r', 'p', 'm')
        ORDER BY total_bytes DESC, classes.relname
        LIMIT $2";
    let rows = query(statement)
        .bind(database.schema.as_str())
        .bind(i64::from(limit))
        .fetch_all(connection)
        .await
        .map_err(|_| database_error("storage-tables"))?;
    let total = rows
        .first()
        .map(|row| nonnegative(row, "total_relations"))
        .transpose()?
        .unwrap_or(0);
    let tables = rows
        .iter()
        .map(|row| {
            Ok(TableStorageUsage {
                relation: stored_name(row, "relname")?,
                heap_bytes: nonnegative(row, "heap_bytes")?,
                index_bytes: nonnegative(row, "index_bytes")?,
                toast_bytes: nonnegative(row, "toast_bytes")?,
                total_bytes: nonnegative(row, "total_bytes")?,
                estimated_live_rows: nonnegative(row, "live_rows")?,
                estimated_dead_rows: nonnegative(row, "dead_rows")?,
                last_autovacuum: row
                    .try_get::<Option<String>, _>("last_autovacuum")
                    .map_err(|_| corrupt("last_autovacuum"))?,
                autovacuum_count: nonnegative(row, "autovacuum_count")?,
            })
        })
        .collect::<Result<Vec<_>, StorageError>>()?;
    Ok((tables, total > u64::from(limit)))
}

async fn load_index_storage(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    limit: u16,
) -> Result<(Vec<IndexStorageUsage>, bool), StorageError> {
    let statement = r"SELECT indexes.relname AS index_name,
               tables.relname AS table_name,
               methods.amname AS access_method,
               pg_relation_size(indexes.oid)::bigint AS bytes,
               catalog.indisvalid,
               catalog.indisready,
               count(*) OVER ()::bigint AS total_indexes
        FROM pg_catalog.pg_index AS catalog
        INNER JOIN pg_catalog.pg_class AS indexes
            ON indexes.oid = catalog.indexrelid
        INNER JOIN pg_catalog.pg_class AS tables
            ON tables.oid = catalog.indrelid
        INNER JOIN pg_catalog.pg_namespace AS namespaces
            ON namespaces.oid = indexes.relnamespace
        INNER JOIN pg_catalog.pg_am AS methods
            ON methods.oid = indexes.relam
        WHERE namespaces.nspname = $1
        ORDER BY bytes DESC, indexes.relname
        LIMIT $2";
    let rows = query(statement)
        .bind(database.schema.as_str())
        .bind(i64::from(limit))
        .fetch_all(connection)
        .await
        .map_err(|_| database_error("storage-indexes"))?;
    let total = rows
        .first()
        .map(|row| nonnegative(row, "total_indexes"))
        .transpose()?
        .unwrap_or(0);
    let indexes = rows
        .iter()
        .map(|row| {
            Ok(IndexStorageUsage {
                index: stored_name(row, "index_name")?,
                table: stored_name(row, "table_name")?,
                access_method: stored_name(row, "access_method")?,
                bytes: nonnegative(row, "bytes")?,
                valid: row
                    .try_get::<bool, _>("indisvalid")
                    .map_err(|_| corrupt("index_valid"))?,
                ready: row
                    .try_get::<bool, _>("indisready")
                    .map_err(|_| corrupt("index_ready"))?,
            })
        })
        .collect::<Result<Vec<_>, StorageError>>()?;
    Ok((indexes, total > u64::from(limit)))
}

async fn load_deduplication(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    project_id: &ProjectId,
) -> Result<GenerationDeduplicationAssessment, StorageError> {
    let schema = quoted_schema(&database.schema);
    let statement = format!(
        r#"WITH duplicate_groups AS MATERIALIZED (
                SELECT content_digest_version, content_digest, count(*)::bigint AS generations
                FROM {schema}."index_generations"
                WHERE project_id = $1::uuid
                  AND content_digest IS NOT NULL
                  AND state IN ('ready', 'current', 'superseded')
                GROUP BY content_digest_version, content_digest
                HAVING count(*) > 1
            ), redundant AS MATERIALIZED (
                SELECT generations.content_digest_version, generations.content_digest,
                       generations.generation_id,
                       row_number() OVER (
                           PARTITION BY generations.content_digest_version,
                                        generations.content_digest
                           ORDER BY generations.generation_sequence DESC
                       ) AS content_rank
                FROM {schema}."index_generations" AS generations
                INNER JOIN duplicate_groups
                    USING (content_digest_version, content_digest)
                WHERE generations.project_id = $1::uuid
                  AND generations.state IN ('ready', 'current', 'superseded')
            )
            SELECT (SELECT count(*) FROM duplicate_groups)::bigint AS duplicate_groups,
                   count(DISTINCT redundant.generation_id)
                       FILTER (WHERE redundant.content_rank > 1)::bigint
                       AS redundant_generations,
                   COALESCE(sum(files.byte_size)
                       FILTER (WHERE redundant.content_rank > 1), 0)::bigint
                       AS redundant_source_bytes
            FROM redundant
            LEFT JOIN {schema}."files" AS files
              ON files.project_id = $1::uuid
             AND files.generation_id = redundant.generation_id"#
    );
    let row = query(AssertSqlSafe(statement))
        .bind(project_id.as_str())
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("storage-deduplication"))?;
    Ok(GenerationDeduplicationAssessment {
        duplicate_content_groups: nonnegative(&row, "duplicate_groups")?,
        redundant_generations: nonnegative(&row, "redundant_generations")?,
        estimated_redundant_source_bytes: nonnegative(&row, "redundant_source_bytes")?,
        mutation_supported: false,
        required_migration: "normalized_content_addressed_generation_facts",
    })
}

#[derive(Clone, Copy)]
struct StorageWarningInput<'a> {
    parse_cache: ParseCacheStorageUsage,
    stale_ready_generations: u64,
    tables: &'a [TableStorageUsage],
    indexes: &'a [IndexStorageUsage],
    tables_truncated: bool,
    indexes_truncated: bool,
    deduplication: GenerationDeduplicationAssessment,
}

fn storage_warnings(input: StorageWarningInput<'_>) -> Vec<StorageWarning> {
    let mut warnings = Vec::new();
    if input.parse_cache.contracts > DEFAULT_PARSE_CACHE_CONTRACTS {
        warnings.push(StorageWarning::ParseCacheContractBudgetExceeded);
    }
    if input.parse_cache.rows > DEFAULT_PARSE_CACHE_ROWS {
        warnings.push(StorageWarning::ParseCacheRowBudgetExceeded);
    }
    if input.parse_cache.logical_payload_bytes > DEFAULT_PARSE_CACHE_PAYLOAD_BYTES {
        warnings.push(StorageWarning::ParseCachePayloadBudgetExceeded);
    }
    if parse_cache_physically_amplified(input.parse_cache) {
        warnings.push(StorageWarning::ParseCachePhysicalAmplification);
    }
    if input.stale_ready_generations > 0 {
        warnings.push(StorageWarning::StaleReadyGeneration);
    }
    if input
        .indexes
        .iter()
        .any(|index| !index.valid || !index.ready)
    {
        warnings.push(StorageWarning::InvalidConcurrentIndexArtifact);
    }
    if input.tables.iter().any(|table| {
        table.estimated_dead_rows >= 10_000
            && table.estimated_dead_rows
                > table
                    .estimated_live_rows
                    .saturating_add(table.estimated_dead_rows)
                    / 10
    }) {
        warnings.push(StorageWarning::DeadTuplePressure);
    }
    if input.deduplication.duplicate_content_groups > 0 {
        warnings.push(StorageWarning::DuplicateGenerationContent);
    }
    if input.tables_truncated {
        warnings.push(StorageWarning::RelationListTruncated);
    }
    if input.indexes_truncated {
        warnings.push(StorageWarning::IndexListTruncated);
    }
    warnings
}

fn parse_cache_physically_amplified(cache: ParseCacheStorageUsage) -> bool {
    let healthy_upper_bound = cache
        .schema_stored_payload_bytes
        .saturating_mul(PARSE_CACHE_AMPLIFICATION_MULTIPLIER)
        .saturating_add(PARSE_CACHE_AMPLIFICATION_ALLOWANCE_BYTES);
    cache.physical_relation_bytes >= PARSE_CACHE_AMPLIFICATION_MINIMUM_BYTES
        && cache.physical_relation_bytes > healthy_upper_bound
}

fn nonnegative(row: &sqlx_postgres::PgRow, field: &'static str) -> Result<u64, StorageError> {
    row.try_get::<i64, _>(field)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| corrupt(field))
}

fn stored_name(row: &sqlx_postgres::PgRow, field: &'static str) -> Result<String, StorageError> {
    row.try_get::<String, _>(field)
        .ok()
        .filter(|value| !value.is_empty() && value.len() <= 63 && !value.contains('\0'))
        .ok_or_else(|| corrupt(field))
}

const fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

const fn corrupt(field: &'static str) -> StorageError {
    StorageError::CorruptStoredValue { field }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warning_policy_is_bounded_and_specific() {
        let tables = [TableStorageUsage {
            relation: "references".to_owned(),
            heap_bytes: 1,
            index_bytes: 1,
            toast_bytes: 0,
            total_bytes: 2,
            estimated_live_rows: 1,
            estimated_dead_rows: 10_000,
            last_autovacuum: None,
            autovacuum_count: 0,
        }];
        let indexes = [IndexStorageUsage {
            index: "references_ccnew".to_owned(),
            table: "references".to_owned(),
            access_method: "btree".to_owned(),
            bytes: 1,
            valid: false,
            ready: false,
        }];
        let warnings = storage_warnings(StorageWarningInput {
            parse_cache: ParseCacheStorageUsage {
                rows: DEFAULT_PARSE_CACHE_ROWS + 1,
                contracts: DEFAULT_PARSE_CACHE_CONTRACTS + 1,
                logical_payload_bytes: DEFAULT_PARSE_CACHE_PAYLOAD_BYTES + 1,
                stored_payload_bytes: 1,
                schema_stored_payload_bytes: 1,
                physical_relation_bytes: 128 * 1024 * 1024,
                physical_overhead_bytes: 128 * 1024 * 1024 - 1,
            },
            stale_ready_generations: 1,
            tables: &tables,
            indexes: &indexes,
            tables_truncated: true,
            indexes_truncated: true,
            deduplication: GenerationDeduplicationAssessment {
                duplicate_content_groups: 1,
                ..GenerationDeduplicationAssessment::default()
            },
        });
        assert_eq!(warnings.len(), 10);
        assert!(warnings.contains(&StorageWarning::ParseCachePhysicalAmplification));
    }

    #[test]
    fn small_parse_cache_relations_do_not_report_physical_amplification() {
        assert!(!parse_cache_physically_amplified(ParseCacheStorageUsage {
            stored_payload_bytes: 1,
            schema_stored_payload_bytes: 1,
            physical_relation_bytes: PARSE_CACHE_AMPLIFICATION_MINIMUM_BYTES - 1,
            physical_overhead_bytes: PARSE_CACHE_AMPLIFICATION_MINIMUM_BYTES - 2,
            ..ParseCacheStorageUsage::default()
        }));
    }
}
