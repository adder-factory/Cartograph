use cartograph_domain::{ContentDigest, GenerationDigestVersion, GenerationId, ProjectId};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{CartographDatabase, StorageError};

const MAX_ROOT_IDENTITY_BYTES: usize = 4_096;

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
    let project_id =
        ProjectId::parse(&read_string(row, 0, "project_id")?).map_err(|_| corrupt("project_id"))?;
    let generation_id = row
        .try_get::<Option<String>, _>(1)
        .map_err(|_| corrupt("generation_id"))?;
    let current = match generation_id {
        None => None,
        Some(raw) => Some(ProjectCurrentGeneration {
            generation_id: GenerationId::parse(&raw).map_err(|_| corrupt("generation_id"))?,
            sequence: read_nonnegative(row, 2, "generation_sequence")?,
            source_revision: read_string(row, 3, "source_revision")?,
            content_digest: ContentDigest::parse(&read_string(row, 4, "content_digest")?)
                .map_err(|_| corrupt("content_digest"))?,
            digest_version: GenerationDigestVersion::from_database_value(
                row.try_get::<i16, _>(5)
                    .map_err(|_| corrupt("digest_version"))?,
            )
            .map_err(|_| corrupt("digest_version"))?,
            counts: GenerationCounts {
                files: read_nonnegative(row, 6, "files")?,
                symbols: read_nonnegative(row, 7, "symbols")?,
                edges: read_nonnegative(row, 8, "edges")?,
                references: read_nonnegative(row, 9, "references")?,
                documents: read_nonnegative(row, 10, "documents")?,
            },
        }),
    };
    Ok(ProjectSnapshot {
        project_id,
        current,
    })
}

fn read_string(
    row: &sqlx_postgres::PgRow,
    index: usize,
    field: &'static str,
) -> Result<String, StorageError> {
    row.try_get::<String, _>(index).map_err(|_| corrupt(field))
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
    StorageError::CorruptStoredValue { field }
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
