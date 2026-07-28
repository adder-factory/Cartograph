use std::time::Duration;

use cartograph_domain::ProjectId;
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{CartographDatabase, database::set_local_statement_timeout};

use super::types::{SemanticStorageError, database_error, validate_timeout};

const AUDIT_CURRENT_EMBEDDINGS_COLUMN: usize = 3;
const AUDIT_HISTORICAL_EMBEDDINGS_COLUMN: usize = 4;
const AUDIT_RETIRED_MODEL_EMBEDDINGS_COLUMN: usize = 5;
const AUDIT_MODEL_INDEXES_COLUMN: usize = 6;

/// Database-only semantic storage evidence; no endpoint or credential is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStorageAudit {
    pub active_models: u64,
    pub retired_models: u64,
    pub current_documents: u64,
    pub current_embeddings: u64,
    pub historical_embeddings: u64,
    pub retired_model_embeddings: u64,
    pub model_indexes: u64,
}

/// Dry-run or applied cleanup of embeddings belonging to retired models.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredEmbeddingCleanupReport {
    pub dry_run: bool,
    pub candidate_embeddings: u64,
    pub deleted_embeddings: u64,
    pub dropped_model_indexes: u64,
}

impl CartographDatabase {
    /// Audit semantic storage without requiring the configured HTTP endpoint.
    pub async fn embedding_storage_audit(
        &self,
        project_id: &ProjectId,
        statement_timeout: Duration,
    ) -> Result<EmbeddingStorageAudit, SemanticStorageError> {
        validate_timeout(statement_timeout)?;
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("embedding-audit-begin"))?;
        set_local_statement_timeout(&mut transaction, statement_timeout)
            .await
            .map_err(|()| database_error("embedding-audit-timeout"))?;
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT
                    (SELECT count(*) FROM {schema}."embedding_models" WHERE state = 'active')::bigint,
                    (SELECT count(*) FROM {schema}."embedding_models" WHERE state = 'retired')::bigint,
                    (SELECT count(*) FROM {schema}."search_documents" AS documents
                     JOIN current ON current.generation_id = documents.generation_id
                     WHERE documents.project_id = CAST($1 AS uuid))::bigint,
                    (SELECT count(*) FROM {schema}."document_embeddings" AS embeddings
                     JOIN current ON current.generation_id = embeddings.generation_id
                     WHERE embeddings.project_id = CAST($1 AS uuid))::bigint,
                    (SELECT count(*) FROM {schema}."document_embeddings" AS embeddings
                     WHERE embeddings.project_id = CAST($1 AS uuid)
                       AND embeddings.generation_id IS DISTINCT FROM
                           (SELECT generation_id FROM current))::bigint,
                    (SELECT count(*) FROM {schema}."document_embeddings" AS embeddings
                     JOIN {schema}."embedding_models" AS models
                       ON models.model_id = embeddings.model_id
                     WHERE embeddings.project_id = CAST($1 AS uuid)
                       AND models.state = 'retired')::bigint,
                    (SELECT count(*)
                     FROM pg_catalog.pg_class AS indexes
                     JOIN pg_catalog.pg_namespace AS namespaces
                       ON namespaces.oid = indexes.relnamespace
                     WHERE namespaces.nspname = $2
                       AND indexes.relkind = 'i'
                       AND indexes.relname LIKE 'document_embeddings_model_%_hnsw')::bigint"#
        );
        let row = query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .bind(self.schema.as_str())
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| database_error("embedding-audit-read"))?;
        let report = EmbeddingStorageAudit {
            active_models: count(&row, 0)?,
            retired_models: count(&row, 1)?,
            current_documents: count(&row, 2)?,
            current_embeddings: count(&row, AUDIT_CURRENT_EMBEDDINGS_COLUMN)?,
            historical_embeddings: count(&row, AUDIT_HISTORICAL_EMBEDDINGS_COLUMN)?,
            retired_model_embeddings: count(&row, AUDIT_RETIRED_MODEL_EMBEDDINGS_COLUMN)?,
            model_indexes: count(&row, AUDIT_MODEL_INDEXES_COLUMN)?,
        };
        transaction
            .commit()
            .await
            .map_err(|_| database_error("embedding-audit-commit"))?;
        Ok(report)
    }

    /// Delete only vectors owned by explicitly retired models. Active-model
    /// and historical-generation vectors are never candidates.
    pub async fn cleanup_retired_embeddings(
        &self,
        project_id: &ProjectId,
        confirm: bool,
        statement_timeout: Duration,
    ) -> Result<RetiredEmbeddingCleanupReport, SemanticStorageError> {
        validate_timeout(statement_timeout)?;
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("embedding-cleanup-begin"))?;
        set_local_statement_timeout(&mut transaction, statement_timeout)
            .await
            .map_err(|()| database_error("embedding-cleanup-timeout"))?;
        let schema = crate::database::quoted_schema(&self.schema);
        let candidates_sql = format!(
            r#"SELECT count(*)::bigint
                FROM {schema}."document_embeddings" AS embeddings
                JOIN {schema}."embedding_models" AS models
                  ON models.model_id = embeddings.model_id
                WHERE embeddings.project_id = CAST($1 AS uuid)
                  AND models.state = 'retired'"#
        );
        let candidate_row = query(AssertSqlSafe(candidates_sql))
            .bind(project_id.as_str())
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| database_error("embedding-cleanup-count"))?;
        let candidates = count(&candidate_row, 0)?;
        if !confirm {
            transaction
                .rollback()
                .await
                .map_err(|_| database_error("embedding-cleanup-dry-run"))?;
            return Ok(RetiredEmbeddingCleanupReport {
                dry_run: true,
                candidate_embeddings: candidates,
                deleted_embeddings: 0,
                dropped_model_indexes: 0,
            });
        }
        let delete_sql = format!(
            r#"DELETE FROM {schema}."document_embeddings" AS embeddings
                USING {schema}."embedding_models" AS models
                WHERE embeddings.project_id = CAST($1 AS uuid)
                  AND models.model_id = embeddings.model_id
                  AND models.state = 'retired'"#
        );
        let deleted = query(AssertSqlSafe(delete_sql))
            .bind(project_id.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("embedding-cleanup-delete"))?
            .rows_affected();
        let retired_models_sql = format!(
            r#"SELECT model_id::text FROM {schema}."embedding_models"
                WHERE state = 'retired' ORDER BY model_id"#
        );
        let model_rows = query(AssertSqlSafe(retired_models_sql))
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| database_error("embedding-cleanup-models"))?;
        let mut dropped = 0_u64;
        for row in model_rows {
            let model_id = row
                .try_get::<String, _>(0)
                .map_err(|_| SemanticStorageError::CorruptStoredValue { field: "model_id" })?;
            if !canonical_uuid(&model_id) {
                return Err(SemanticStorageError::CorruptStoredValue { field: "model_id" });
            }
            let index = format!(
                "document_embeddings_model_{}_hnsw",
                model_id.replace('-', "")
            );
            let drop_sql = format!(r#"DROP INDEX IF EXISTS {schema}."{index}""#);
            let existed = query(
                r#"SELECT EXISTS (
                    SELECT 1 FROM pg_catalog.pg_class AS indexes
                    JOIN pg_catalog.pg_namespace AS namespaces
                      ON namespaces.oid = indexes.relnamespace
                    WHERE namespaces.nspname = $1 AND indexes.relname = $2
                )"#,
            )
            .bind(self.schema.as_str())
            .bind(&index)
            .fetch_one(&mut *transaction)
            .await
            .ok()
            .and_then(|row| row.try_get::<bool, _>(0).ok())
            .unwrap_or(false);
            query(AssertSqlSafe(drop_sql))
                .execute(&mut *transaction)
                .await
                .map_err(|_| database_error("embedding-cleanup-drop-index"))?;
            dropped = dropped.saturating_add(u64::from(existed));
        }
        transaction
            .commit()
            .await
            .map_err(|_| database_error("embedding-cleanup-commit"))?;
        Ok(RetiredEmbeddingCleanupReport {
            dry_run: false,
            candidate_embeddings: candidates,
            deleted_embeddings: deleted,
            dropped_model_indexes: dropped,
        })
    }
}

fn count(row: &sqlx_postgres::PgRow, index: usize) -> Result<u64, SemanticStorageError> {
    row.try_get::<i64, _>(index)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(SemanticStorageError::CorruptStoredValue { field: "count" })
}

fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}
