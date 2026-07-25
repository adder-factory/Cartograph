use std::time::Duration;

use cartograph_domain::{ProjectId, SymbolId};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, StorageError,
    database::{quoted_schema, set_local_statement_timeout},
};

const SUMMARY_PRIORITY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_INTENT_TOKENS: usize = 32;
const MAX_INTENT_TOKEN_BYTES: usize = 128;
const MAX_ENQUEUE_CANDIDATES: u16 = 20;
const MAX_PRIORITY_ATTEMPTS: i16 = 3;
const EXISTING_DOCUMENTATION_THRESHOLD: i64 = 20;

/// Exact durable queue changes caused by one no-hit intent lookup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPriorityEnqueueReport {
    candidates: u64,
    enqueued: u64,
    refreshed: u64,
}

impl SummaryPriorityEnqueueReport {
    #[must_use]
    pub const fn candidates(&self) -> u64 {
        self.candidates
    }

    #[must_use]
    pub const fn enqueued(&self) -> u64 {
        self.enqueued
    }

    #[must_use]
    pub const fn refreshed(&self) -> u64 {
        self.refreshed
    }

    #[must_use]
    pub const fn affected(&self) -> u64 {
        self.enqueued.saturating_add(self.refreshed)
    }
}

/// Current-generation demand-driven summary backlog health.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPriorityQueueStats {
    pending: u64,
    oldest_enqueued_at: Option<String>,
    newest_enqueued_at: Option<String>,
    total_requests: u64,
    attempted: u64,
}

impl SummaryPriorityQueueStats {
    #[must_use]
    pub const fn pending(&self) -> u64 {
        self.pending
    }
}

/// Result of one poison-row attempt increment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPriorityFailure {
    present: bool,
    evicted: bool,
}

impl SummaryPriorityFailure {
    #[must_use]
    pub const fn evicted(self) -> bool {
        self.evicted
    }
}

impl CartographDatabase {
    /// Enqueue unsummarized current symbols whose exact simple names match
    /// bounded intent terms. Duplicate demand refreshes recency and count but
    /// deliberately preserves the poison-attempt budget.
    pub async fn enqueue_summary_candidates_for_intent(
        &self,
        project_id: &ProjectId,
        tokens: &[String],
        limit: u16,
    ) -> Result<SummaryPriorityEnqueueReport, StorageError> {
        validate_tokens(tokens)?;
        if limit == 0 || limit > MAX_ENQUEUE_CANDIDATES {
            return Err(StorageError::InvalidInput {
                field: "summary_priority_limit",
            });
        }
        let encoded = serde_json::to_string(tokens).map_err(|_| StorageError::InvalidInput {
            field: "summary_priority_tokens",
        })?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), terms AS (
                    SELECT DISTINCT lower(jsonb_array_elements_text(CAST($2 AS jsonb))) AS token
                ), candidates AS (
                    SELECT symbols.project_id, symbols.generation_id, symbols.symbol_id
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    LEFT JOIN {schema}."search_documents" AS documents
                      ON documents.project_id = symbols.project_id
                     AND documents.generation_id = symbols.generation_id
                     AND documents.symbol_id = symbols.symbol_id
                     AND documents.document_kind = 'symbol'
                    LEFT JOIN {schema}."agent_artifacts" AS summaries
                      ON summaries.project_id = symbols.project_id
                     AND summaries.artifact_kind = 'summary'
                     AND summaries.scope_kind = 'symbol'
                     AND summaries.scope_key = symbols.symbol_id::text
                     AND summaries.source_digest = symbols.structural_digest
                     AND summaries.state = 'complete'
                    WHERE symbols.project_id = CAST($1 AS uuid)
                      AND EXISTS (
                          SELECT 1 FROM terms WHERE terms.token = lower(symbols.simple_name)
                      )
                      AND symbols.symbol_kind IN (
                          'class', 'function', 'method', 'interface', 'struct',
                          'trait', 'protocol', 'enum', 'type_alias', 'component', 'route'
                      )
                      AND summaries.id IS NULL
                      AND length(COALESCE(documents.natural_text, '')) < $4
                    ORDER BY symbols.exported DESC,
                             (symbols.visibility = 'public') DESC,
                             symbols.pagerank DESC NULLS LAST,
                             symbols.symbol_id
                    LIMIT $3
                ), upserted AS (
                    INSERT INTO {schema}."summary_priority_queue" (
                        project_id, generation_id, symbol_id,
                        enqueued_at, requested_count, attempts
                    )
                    SELECT project_id, generation_id, symbol_id,
                           clock_timestamp(), 1, 0
                    FROM candidates
                    ON CONFLICT (project_id, generation_id, symbol_id)
                    DO UPDATE SET
                        enqueued_at = EXCLUDED.enqueued_at,
                        requested_count = LEAST(
                            {schema}."summary_priority_queue".requested_count + 1,
                            1000000000
                        )
                    RETURNING requested_count
                )
                SELECT COUNT(*)::bigint,
                       COUNT(*) FILTER (WHERE requested_count = 1)::bigint,
                       COUNT(*) FILTER (WHERE requested_count > 1)::bigint
                FROM upserted"#,
        );
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("enqueue-summary-priority"))?;
        set_local_statement_timeout(&mut transaction, SUMMARY_PRIORITY_TIMEOUT)
            .await
            .map_err(|_| database_error("enqueue-summary-priority"))?;
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(encoded)
            .bind(i64::from(limit))
            .bind(EXISTING_DOCUMENTATION_THRESHOLD)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| database_error("enqueue-summary-priority"))?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error("enqueue-summary-priority"))?;
        Ok(SummaryPriorityEnqueueReport {
            candidates: nonnegative(&row, 0)?,
            enqueued: nonnegative(&row, 1)?,
            refreshed: nonnegative(&row, 2)?,
        })
    }

    /// Read exact queue health for the currently published generation.
    pub async fn summary_priority_queue_stats(
        &self,
        project_id: &ProjectId,
    ) -> Result<SummaryPriorityQueueStats, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT COUNT(queue.symbol_id)::bigint,
                       MIN(queue.enqueued_at)::text,
                       MAX(queue.enqueued_at)::text,
                       COALESCE(SUM(queue.requested_count), 0)::bigint,
                       COUNT(queue.symbol_id) FILTER (WHERE queue.attempts > 0)::bigint
                FROM {schema}."projects" AS projects
                LEFT JOIN {schema}."summary_priority_queue" AS queue
                  ON queue.project_id = projects.project_id
                 AND queue.generation_id = projects.current_generation_id
                WHERE projects.project_id = CAST($1 AS uuid)"#,
        );
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .fetch_one(&self.pool)
            .await
            .map_err(|_| database_error("summary-priority-stats"))?;
        Ok(SummaryPriorityQueueStats {
            pending: nonnegative(&row, 0)?,
            oldest_enqueued_at: optional_text(&row, 1)?,
            newest_enqueued_at: optional_text(&row, 2)?,
            total_requests: nonnegative(&row, 3)?,
            attempted: nonnegative(&row, 4)?,
        })
    }

    /// Increment a failed queued-symbol attempt and evict it at the bounded cap.
    pub async fn record_summary_priority_failure(
        &self,
        project_id: &ProjectId,
        symbol_id: &SymbolId,
    ) -> Result<SummaryPriorityFailure, StorageError> {
        let schema = quoted_schema(&self.schema);
        let select = format!(
            r#"SELECT queue.generation_id::text, queue.attempts
                FROM {schema}."summary_priority_queue" AS queue
                JOIN {schema}."projects" AS projects
                  ON projects.project_id = queue.project_id
                 AND projects.current_generation_id = queue.generation_id
                WHERE queue.project_id = CAST($1 AS uuid)
                  AND queue.symbol_id = CAST($2 AS uuid)
                FOR UPDATE"#,
        );
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("record-summary-priority-failure"))?;
        set_local_statement_timeout(&mut transaction, SUMMARY_PRIORITY_TIMEOUT)
            .await
            .map_err(|_| database_error("record-summary-priority-failure"))?;
        let row = query(AssertSqlSafe(select))
            .bind(project_id.as_str())
            .bind(symbol_id.as_str())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| database_error("record-summary-priority-failure"))?;
        let Some(row) = row else {
            transaction
                .commit()
                .await
                .map_err(|_| database_error("record-summary-priority-failure"))?;
            return Ok(SummaryPriorityFailure {
                present: false,
                evicted: false,
            });
        };
        let generation_id =
            row.try_get::<String, _>(0)
                .map_err(|_| StorageError::CorruptStoredValue {
                    field: "summary_priority_queue",
                })?;
        let attempts = row
            .try_get::<i16, _>(1)
            .map_err(|_| StorageError::CorruptStoredValue {
                field: "summary_priority_queue",
            })?;
        let next = attempts.saturating_add(1);
        let evicted = next >= MAX_PRIORITY_ATTEMPTS;
        let statement = if evicted {
            format!(
                r#"DELETE FROM {schema}."summary_priority_queue"
                    WHERE project_id = CAST($1 AS uuid)
                      AND generation_id = CAST($2 AS uuid)
                      AND symbol_id = CAST($3 AS uuid)"#,
            )
        } else {
            format!(
                r#"UPDATE {schema}."summary_priority_queue"
                    SET attempts = $4
                    WHERE project_id = CAST($1 AS uuid)
                      AND generation_id = CAST($2 AS uuid)
                      AND symbol_id = CAST($3 AS uuid)"#,
            )
        };
        let mut statement = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(generation_id)
            .bind(symbol_id.as_str());
        if !evicted {
            statement = statement.bind(next);
        }
        let changed = statement
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("record-summary-priority-failure"))?
            .rows_affected();
        if changed != 1 {
            return Err(database_error("record-summary-priority-failure"));
        }
        transaction
            .commit()
            .await
            .map_err(|_| database_error("record-summary-priority-failure"))?;
        Ok(SummaryPriorityFailure {
            present: true,
            evicted,
        })
    }
}

fn validate_tokens(tokens: &[String]) -> Result<(), StorageError> {
    if tokens.is_empty()
        || tokens.len() > MAX_INTENT_TOKENS
        || tokens.iter().any(|token| {
            token.len() < 3
                || token.len() > MAX_INTENT_TOKEN_BYTES
                || token.chars().any(char::is_control)
        })
    {
        Err(StorageError::InvalidInput {
            field: "summary_priority_tokens",
        })
    } else {
        Ok(())
    }
}

fn nonnegative(row: &sqlx_postgres::PgRow, index: usize) -> Result<u64, StorageError> {
    row.try_get::<i64, _>(index)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(StorageError::CorruptStoredValue {
            field: "summary_priority_queue",
        })
}

fn optional_text(row: &sqlx_postgres::PgRow, index: usize) -> Result<Option<String>, StorageError> {
    row.try_get(index)
        .map_err(|_| StorageError::CorruptStoredValue {
            field: "summary_priority_queue",
        })
}

fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demand_terms_and_limits_are_bounded_before_database_work() {
        assert!(validate_tokens(&["parse".to_owned(), "token".to_owned()]).is_ok());
        assert!(validate_tokens(&[]).is_err());
        assert!(validate_tokens(&["xy".to_owned()]).is_err());
        assert!(validate_tokens(&["bad\nterm".to_owned()]).is_err());
        assert!(validate_tokens(&vec!["token".to_owned(); MAX_INTENT_TOKENS + 1]).is_err());
    }
}
