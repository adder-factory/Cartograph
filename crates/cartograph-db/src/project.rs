use std::time::Duration;

use cartograph_domain::{ContentDigest, GenerationDigestVersion, GenerationId, ProjectId};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::PgConnection;
use thiserror::Error;

use crate::{
    CartographDatabase, StorageError,
    database::{read_stored_string, stored_value_error},
};

const MAX_ROOT_IDENTITY_BYTES: usize = 4_096;
const PROJECT_ID_COLUMN: usize = 0;
const GENERATION_ID_COLUMN: usize = 1;
const GENERATION_SEQUENCE_COLUMN: usize = 2;
const SOURCE_REVISION_COLUMN: usize = 3;
const CONTENT_DIGEST_COLUMN: usize = 4;
const DIGEST_VERSION_COLUMN: usize = 5;
const FILE_COUNT_COLUMN: usize = 6;
const SYMBOL_COUNT_COLUMN: usize = 7;
const EDGE_COUNT_COLUMN: usize = 8;
const REFERENCE_COUNT_COLUMN: usize = 9;
const DOCUMENT_COUNT_COLUMN: usize = 10;
const PROJECT_PURGE_LOCK_NAMESPACE: &str = "cartograph-v2-project-purge";
const PUBLICATION_LOCK_NAMESPACE: &str = "cartograph-v2-publish";
const DIRECT_PROJECT_TABLES: &[&str] = &[
    "index_generations",
    "files",
    "symbols",
    "edges",
    "references",
    "search_documents",
    "project_operation_leases",
    "v1_import_runs",
    "document_embeddings",
    "generation_search_relations",
    "coverage_sources",
    "symbol_coverage",
    "file_history",
    "file_cochanges",
    "agent_artifacts",
    "mcp_sessions",
    "mcp_tool_calls",
    "mcp_macros",
    "symbol_similarity_edges",
    "symbol_similarity_builds",
];

/// Exact bounded deletion report for one PostgreSQL-backed project.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPurgeReport {
    pub generations_removed: u64,
    pub search_relations_removed: u64,
    pub cascade_rows_removed: u64,
}

/// Safe, actionable reasons a project purge did not run.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProjectPurgeError {
    #[error("invalid Cartograph project purge bounds")]
    InvalidBounds,
    #[error("Cartograph project does not exist")]
    ProjectNotFound,
    #[error("Cartograph project has {count} unexpired operation leases")]
    LiveLeases { count: u64 },
    #[error("Cartograph project purge exceeds its generation bound")]
    GenerationBoundExceeded,
    #[error("Cartograph project purge exceeds its row bound")]
    RowBoundExceeded,
    #[error("Cartograph project purge found corrupt stored {field}")]
    CorruptStoredValue { field: &'static str },
    #[error("Cartograph PostgreSQL project purge failed during {operation}")]
    DatabaseOperation { operation: &'static str },
}

/// Exact row counts for the atomically published generation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct GenerationCounts {
    /// Source files in the generation.
    pub files: i64,
    /// Extracted symbols in the generation.
    pub symbols: i64,
    /// Resolved graph edges in the generation.
    pub edges: i64,
    /// Resolved and unresolved source references in the generation.
    pub references: i64,
    /// File and symbol documents available to ParadeDB.
    pub documents: i64,
}

/// Durable metadata for one project's visible generation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectCurrentGeneration {
    /// Immutable generation identity.
    pub generation_id: GenerationId,
    /// Monotonic project-local publication sequence.
    pub sequence: i64,
    /// Complete source-manifest digest captured before indexing.
    pub source_revision: String,
    /// Deterministic logical fact digest.
    pub content_digest: ContentDigest,
    /// Version used to interpret the logical digest.
    pub digest_version: GenerationDigestVersion,
    /// Exact persisted relation counts.
    pub counts: GenerationCounts,
}

/// Read-only project state used by CLI, MCP, and freshness checks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectSnapshot {
    /// Stable database identity for the project.
    pub project_id: ProjectId,
    /// The currently visible generation, absent before first publication.
    pub current: Option<ProjectCurrentGeneration>,
}

impl CartographDatabase {
    /// Resolve one privacy-preserving root identity without creating project state.
    pub async fn project_snapshot_by_root(
        &self,
        root_identity: &str,
    ) -> Result<Option<ProjectSnapshot>, StorageError> {
        validate_root_identity(root_identity)?;
        let schema = crate::database::quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT
                    projects.project_id::text,
                    generations.generation_id::text,
                    generations.generation_sequence,
                    generations.source_revision,
                    generations.content_digest,
                    generations.content_digest_version,
                    COALESCE((SELECT count(*) FROM {schema}."files" AS rows
                        WHERE rows.project_id = projects.project_id
                          AND rows.generation_id = generations.generation_id), 0)::bigint,
                    COALESCE((SELECT count(*) FROM {schema}."symbols" AS rows
                        WHERE rows.project_id = projects.project_id
                          AND rows.generation_id = generations.generation_id), 0)::bigint,
                    COALESCE((SELECT count(*) FROM {schema}."edges" AS rows
                        WHERE rows.project_id = projects.project_id
                          AND rows.generation_id = generations.generation_id), 0)::bigint,
                    COALESCE((SELECT count(*) FROM {schema}."references" AS rows
                        WHERE rows.project_id = projects.project_id
                          AND rows.generation_id = generations.generation_id), 0)::bigint,
                    COALESCE((SELECT count(*) FROM {schema}."search_documents" AS rows
                        WHERE rows.project_id = projects.project_id
                          AND rows.generation_id = generations.generation_id), 0)::bigint
                FROM {schema}."projects" AS projects
                LEFT JOIN {schema}."index_generations" AS generations
                  ON generations.project_id = projects.project_id
                 AND generations.generation_id = projects.current_generation_id
                WHERE projects.root_identity = $1"#,
        );
        let row = query(AssertSqlSafe(statement))
            .bind(root_identity)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("project-status"))?;
        row.as_ref().map(decode_snapshot).transpose()
    }

    /// Remove one project and every generation-scoped physical BM25 relation.
    ///
    /// The caller supplies hard work bounds. A live operation lease always
    /// blocks deletion; expired leases are removed by the project cascade.
    pub async fn purge_project(
        &self,
        project_id: &ProjectId,
        maximum_generations: u16,
        maximum_cascade_rows: u64,
        statement_timeout: Duration,
    ) -> Result<ProjectPurgeReport, ProjectPurgeError> {
        if maximum_generations == 0 || maximum_cascade_rows == 0 || statement_timeout.is_zero() {
            return Err(ProjectPurgeError::InvalidBounds);
        }
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| purge_database_error("begin"))?;
        crate::database::set_local_statement_timeout(&mut transaction, statement_timeout)
            .await
            .map_err(|()| ProjectPurgeError::InvalidBounds)?;
        let result = purge_project_transaction(
            &mut transaction,
            self,
            project_id,
            maximum_generations,
            maximum_cascade_rows,
        )
        .await;
        match result {
            Ok(report) => {
                transaction
                    .commit()
                    .await
                    .map_err(|_| purge_database_error("commit"))?;
                Ok(report)
            }
            Err(error) => {
                transaction
                    .rollback()
                    .await
                    .map_err(|_| purge_database_error("rollback"))?;
                Err(error)
            }
        }
    }
}

async fn purge_project_transaction(
    connection: &mut PgConnection,
    database: &CartographDatabase,
    project_id: &ProjectId,
    maximum_generations: u16,
    maximum_cascade_rows: u64,
) -> Result<ProjectPurgeReport, ProjectPurgeError> {
    for lock in [
        crate::leases::project_lock_key(&database.schema, project_id),
        format!(
            "{PUBLICATION_LOCK_NAMESPACE}:{}:{project_id}",
            database.schema.as_str()
        ),
        format!(
            "{PROJECT_PURGE_LOCK_NAMESPACE}:{}:{project_id}",
            database.schema.as_str()
        ),
    ] {
        query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(lock)
            .execute(&mut *connection)
            .await
            .map_err(|_| purge_database_error("lock"))?;
    }
    let schema = crate::database::quoted_schema(&database.schema);
    let project_sql = format!(
        r#"SELECT 1 FROM {schema}."projects"
            WHERE project_id = CAST($1 AS uuid) FOR UPDATE"#
    );
    if query(AssertSqlSafe(project_sql))
        .bind(project_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| purge_database_error("lock-project"))?
        .is_none()
    {
        return Err(ProjectPurgeError::ProjectNotFound);
    }
    let leases_sql = format!(
        r#"SELECT count(*)::bigint AS live_leases
            FROM {schema}."project_operation_leases"
            WHERE project_id = CAST($1 AS uuid)
              AND expires_at > clock_timestamp()"#
    );
    let live_leases = query(AssertSqlSafe(leases_sql))
        .bind(project_id.as_str())
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| purge_database_error("live-leases"))
        .and_then(|row| purge_count(&row, "live_leases"))?;
    if live_leases > 0 {
        return Err(ProjectPurgeError::LiveLeases { count: live_leases });
    }
    let generations_sql = format!(
        r#"SELECT generation_id::text AS generation_id
            FROM {schema}."index_generations"
            WHERE project_id = CAST($1 AS uuid)
            ORDER BY generation_sequence
            LIMIT $2
            FOR UPDATE"#
    );
    let rows = query(AssertSqlSafe(generations_sql))
        .bind(project_id.as_str())
        .bind(i64::from(maximum_generations) + 1)
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| purge_database_error("generations"))?;
    if rows.len() > usize::from(maximum_generations) {
        return Err(ProjectPurgeError::GenerationBoundExceeded);
    }
    let generations = rows
        .iter()
        .map(|row| {
            let raw = row
                .try_get::<String, _>("generation_id")
                .map_err(|_| purge_corrupt("generation_id"))?;
            GenerationId::parse(&raw).map_err(|_| purge_corrupt("generation_id"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let cascade_rows = count_project_rows(connection, &schema, project_id).await?;
    if cascade_rows > maximum_cascade_rows {
        return Err(ProjectPurgeError::RowBoundExceeded);
    }
    let mut search_relations_removed = 0_u64;
    for generation_id in &generations {
        if generation_search_relation_exists(connection, database, generation_id).await? {
            search_relations_removed = search_relations_removed
                .checked_add(1)
                .ok_or_else(|| purge_corrupt("search_relation_count"))?;
        }
        crate::search_relation::drop_generation_search_relation(
            connection,
            &database.schema,
            generation_id,
        )
        .await
        .map_err(|_| purge_database_error("drop-search-relation"))?;
    }
    let delete_sql = format!(
        r#"DELETE FROM {schema}."projects"
            WHERE project_id = CAST($1 AS uuid)"#
    );
    let deleted = query(AssertSqlSafe(delete_sql))
        .bind(project_id.as_str())
        .execute(connection)
        .await
        .map_err(|_| purge_database_error("delete-project"))?;
    if deleted.rows_affected() != 1 {
        return Err(ProjectPurgeError::ProjectNotFound);
    }
    Ok(ProjectPurgeReport {
        generations_removed: u64::try_from(generations.len())
            .map_err(|_| purge_corrupt("generation_count"))?,
        search_relations_removed,
        cascade_rows_removed: cascade_rows,
    })
}

async fn generation_search_relation_exists(
    connection: &mut PgConnection,
    database: &CartographDatabase,
    generation_id: &GenerationId,
) -> Result<bool, ProjectPurgeError> {
    let relation = crate::search_relation::GenerationSearchRelation::from_generation(generation_id)
        .map_err(|_| purge_corrupt("generation_id"))?;
    query("SELECT to_regclass($1) IS NOT NULL AS present")
        .bind(relation.qualified_table(&database.schema))
        .fetch_one(connection)
        .await
        .map_err(|_| purge_database_error("search-relation-status"))?
        .try_get::<bool, _>("present")
        .map_err(|_| purge_corrupt("search_relation_status"))
}

async fn count_project_rows(
    connection: &mut PgConnection,
    schema: &str,
    project_id: &ProjectId,
) -> Result<u64, ProjectPurgeError> {
    let mut total = 1_u64;
    for table in DIRECT_PROJECT_TABLES {
        let sql = format!(
            r#"SELECT count(*)::bigint AS rows
                FROM {schema}."{table}"
                WHERE project_id = CAST($1 AS uuid)"#
        );
        let rows = query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| purge_database_error("count-project-rows"))
            .and_then(|row| purge_count(&row, "rows"))?;
        total = total
            .checked_add(rows)
            .ok_or_else(|| purge_corrupt("row_count"))?;
    }
    let checkpoints_sql = format!(
        r#"SELECT count(*)::bigint AS rows
            FROM {schema}."v1_import_checkpoints" AS checkpoints
            INNER JOIN {schema}."v1_import_runs" AS runs
              ON runs.import_id = checkpoints.import_id
            WHERE runs.project_id = CAST($1 AS uuid)"#
    );
    let checkpoints = query(AssertSqlSafe(checkpoints_sql))
        .bind(project_id.as_str())
        .fetch_one(connection)
        .await
        .map_err(|_| purge_database_error("count-import-checkpoints"))
        .and_then(|row| purge_count(&row, "rows"))?;
    total
        .checked_add(checkpoints)
        .ok_or_else(|| purge_corrupt("row_count"))
}

fn purge_count(row: &sqlx_postgres::PgRow, field: &'static str) -> Result<u64, ProjectPurgeError> {
    row.try_get::<i64, _>(field)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| purge_corrupt(field))
}

const fn purge_corrupt(field: &'static str) -> ProjectPurgeError {
    ProjectPurgeError::CorruptStoredValue { field }
}

const fn purge_database_error(operation: &'static str) -> ProjectPurgeError {
    ProjectPurgeError::DatabaseOperation { operation }
}

fn validate_root_identity(value: &str) -> Result<(), StorageError> {
    if value.is_empty() || value.len() > MAX_ROOT_IDENTITY_BYTES || value.contains('\0') {
        return Err(StorageError::InvalidInput {
            field: "root_identity",
        });
    }
    Ok(())
}

fn decode_snapshot(row: &sqlx_postgres::PgRow) -> Result<ProjectSnapshot, StorageError> {
    let project_id = ProjectId::parse(&read_stored_string(row, PROJECT_ID_COLUMN, "project_id")?)
        .map_err(|_| corrupt("project_id"))?;
    let generation_id = row
        .try_get::<Option<String>, _>(GENERATION_ID_COLUMN)
        .map_err(|_| corrupt("generation_id"))?;
    let current = match generation_id {
        None => None,
        Some(raw) => Some(ProjectCurrentGeneration {
            generation_id: GenerationId::parse(&raw).map_err(|_| corrupt("generation_id"))?,
            sequence: read_nonnegative(row, GENERATION_SEQUENCE_COLUMN, "generation_sequence")?,
            source_revision: read_stored_string(row, SOURCE_REVISION_COLUMN, "source_revision")?,
            content_digest: ContentDigest::parse(&read_stored_string(
                row,
                CONTENT_DIGEST_COLUMN,
                "content_digest",
            )?)
            .map_err(|_| corrupt("content_digest"))?,
            digest_version: GenerationDigestVersion::from_database_value(
                row.try_get::<i16, _>(DIGEST_VERSION_COLUMN)
                    .map_err(|_| corrupt("digest_version"))?,
            )
            .map_err(|_| corrupt("digest_version"))?,
            counts: GenerationCounts {
                files: read_nonnegative(row, FILE_COUNT_COLUMN, "files")?,
                symbols: read_nonnegative(row, SYMBOL_COUNT_COLUMN, "symbols")?,
                edges: read_nonnegative(row, EDGE_COUNT_COLUMN, "edges")?,
                references: read_nonnegative(row, REFERENCE_COUNT_COLUMN, "references")?,
                documents: read_nonnegative(row, DOCUMENT_COUNT_COLUMN, "documents")?,
            },
        }),
    };
    Ok(ProjectSnapshot {
        project_id,
        current,
    })
}

fn read_nonnegative(
    row: &sqlx_postgres::PgRow,
    index: usize,
    field: &'static str,
) -> Result<i64, StorageError> {
    let value = row.try_get::<i64, _>(index).map_err(|_| corrupt(field))?;
    if value < 0 {
        return Err(corrupt(field));
    }
    Ok(value)
}

const fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

const fn corrupt(field: &'static str) -> StorageError {
    stored_value_error(field)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_identity_rejects_empty_unbounded_and_nul_values() {
        assert_eq!(
            validate_root_identity(""),
            Err(StorageError::InvalidInput {
                field: "root_identity"
            })
        );
        assert_eq!(
            validate_root_identity(&"x".repeat(MAX_ROOT_IDENTITY_BYTES + 1)),
            Err(StorageError::InvalidInput {
                field: "root_identity"
            })
        );
        assert_eq!(
            validate_root_identity("project\0escape"),
            Err(StorageError::InvalidInput {
                field: "root_identity"
            })
        );
    }
}
