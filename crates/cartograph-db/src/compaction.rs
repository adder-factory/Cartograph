use std::time::Duration;

use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use thiserror::Error;

use crate::{CartographDatabase, database::quoted_schema};

const MAXIMUM_COMPACTION_INDEXES: u16 = 64;
const MAXIMUM_COMPACTION_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MINIMUM_INDEX_BYTES: u64 = 1024 * 1024;
const MAXIMUM_STATEMENT_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const HEADROOM_MULTIPLIER: u64 = 2;
const HEADROOM_ALLOWANCE_BYTES: u64 = 64 * 1024 * 1024;
const COMPACTION_LOCK_NAMESPACE: &str = "cartograph-v2-online-compaction";
const AUTOMATIC_MAXIMUM_INDEXES: u16 = 32;
const AUTOMATIC_MAXIMUM_CANDIDATE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const AUTOMATIC_MINIMUM_INDEX_BYTES: u64 = 8 * 1024 * 1024;
const AUTOMATIC_STATEMENT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// One exact B-tree candidate selected for an online rebuild.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCompactionCandidate {
    pub index: String,
    pub table: String,
    pub bytes: u64,
}

/// Invalid concurrent-reindex artifact that requires operator review. Cartograph
/// never drops these automatically because `_ccold` and `_ccnew` have different
/// PostgreSQL recovery semantics.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidIndexArtifact {
    pub index: String,
    pub table: String,
    pub bytes: u64,
    pub valid: bool,
    pub ready: bool,
}

/// Hard work and deadline bounds for one resumable online compaction call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageCompactionPolicy {
    maximum_indexes: u16,
    maximum_candidate_bytes: u64,
    minimum_index_bytes: u64,
    statement_timeout: Duration,
}

/// Caller-selected online-compaction bounds validated as one typed input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageCompactionPolicyInput {
    pub maximum_indexes: u16,
    pub maximum_candidate_bytes: u64,
    pub minimum_index_bytes: u64,
    pub statement_timeout: Duration,
}

impl StorageCompactionPolicy {
    pub fn new(input: StorageCompactionPolicyInput) -> Result<Self, StorageCompactionError> {
        if input.maximum_indexes == 0 || input.maximum_indexes > MAXIMUM_COMPACTION_INDEXES {
            return Err(StorageCompactionError::InvalidPolicy);
        }
        if input.maximum_candidate_bytes == 0
            || input.maximum_candidate_bytes > MAXIMUM_COMPACTION_BYTES
        {
            return Err(StorageCompactionError::InvalidPolicy);
        }
        if input.minimum_index_bytes < MINIMUM_INDEX_BYTES
            || input.minimum_index_bytes > input.maximum_candidate_bytes
        {
            return Err(StorageCompactionError::InvalidPolicy);
        }
        if input.statement_timeout.is_zero() || input.statement_timeout > MAXIMUM_STATEMENT_TIMEOUT
        {
            return Err(StorageCompactionError::InvalidPolicy);
        }
        Ok(Self {
            maximum_indexes: input.maximum_indexes,
            maximum_candidate_bytes: input.maximum_candidate_bytes,
            minimum_index_bytes: input.minimum_index_bytes,
            statement_timeout: input.statement_timeout,
        })
    }

    #[must_use]
    pub const fn automatic_plan() -> Self {
        Self {
            maximum_indexes: AUTOMATIC_MAXIMUM_INDEXES,
            maximum_candidate_bytes: AUTOMATIC_MAXIMUM_CANDIDATE_BYTES,
            minimum_index_bytes: AUTOMATIC_MINIMUM_INDEX_BYTES,
            statement_timeout: AUTOMATIC_STATEMENT_TIMEOUT,
        }
    }
}

impl Default for StorageCompactionPolicy {
    fn default() -> Self {
        Self::automatic_plan()
    }
}

/// Dry-run plan with conservative headroom and invalid-artifact evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCompactionPlan {
    pub candidates: Vec<StorageCompactionCandidate>,
    pub invalid_artifacts: Vec<InvalidIndexArtifact>,
    pub candidate_bytes: u64,
    pub required_headroom_bytes: u64,
    pub truncated: bool,
}

/// Why an applied online plan stopped before completing every candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageCompactionStopReason {
    ReindexFailed,
    TimeoutRestoreFailed,
    AdvisoryUnlockFailed,
}

/// Dry-run or applied online B-tree compaction report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCompactionReport {
    pub plan: StorageCompactionPlan,
    pub dry_run: bool,
    pub reindexed: Vec<StorageCompactionCandidate>,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub stopped_at: Option<String>,
    pub stop_reason: Option<StorageCompactionStopReason>,
}

/// Bounded online-compaction failure without query, path, or credential text.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum StorageCompactionError {
    #[error("Cartograph storage compaction policy is invalid")]
    InvalidPolicy,
    #[error("Cartograph storage compaction requires verified free-space headroom")]
    HeadroomUnavailable,
    #[error("Cartograph storage compaction has insufficient free-space headroom")]
    InsufficientHeadroom,
    #[error("another Cartograph online compaction is active")]
    Busy,
    #[error("Cartograph PostgreSQL compaction failed during {operation}")]
    DatabaseOperation { operation: &'static str },
    #[error("Cartograph PostgreSQL compaction found corrupt catalog {field}")]
    CorruptCatalog { field: &'static str },
}

impl CartographDatabase {
    /// Build a bounded, read-only B-tree compaction plan.
    pub async fn storage_compaction_plan(
        &self,
        policy: StorageCompactionPolicy,
    ) -> Result<StorageCompactionPlan, StorageCompactionError> {
        validate_policy(policy)?;
        load_plan(self, policy).await
    }

    /// Apply one dry-run plan one index at a time with `REINDEX INDEX
    /// CONCURRENTLY`. The caller must provide observed free bytes; external
    /// deployments cannot infer filesystem headroom through PostgreSQL.
    pub async fn compact_storage_online(
        &self,
        policy: StorageCompactionPolicy,
        available_headroom_bytes: u64,
    ) -> Result<StorageCompactionReport, StorageCompactionError> {
        validate_policy(policy)?;
        let plan = load_plan(self, policy).await?;
        require_headroom(available_headroom_bytes, plan.required_headroom_bytes)?;
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| database_error("acquire"))?;
        let session =
            begin_compaction_session(&mut connection, self.schema.as_str(), policy).await?;
        let schema = quoted_schema(&self.schema);
        let mut execution = execute_reindex_plan(&mut connection, &schema, &plan.candidates).await;
        let session_clean =
            finish_compaction_session(&mut connection, session, &mut execution).await;
        if !session_clean && connection.close().await.is_err() && execution.stop_reason.is_none() {
            execution.stop_reason = Some(StorageCompactionStopReason::AdvisoryUnlockFailed);
        }
        let bytes_before = sum_candidate_bytes(&execution.reindexed)?;
        let bytes_after = load_candidate_bytes(self, &execution.reindexed).await?;
        Ok(StorageCompactionReport {
            plan,
            dry_run: false,
            reindexed: execution.reindexed,
            bytes_before,
            bytes_after,
            stopped_at: execution.stopped_at,
            stop_reason: execution.stop_reason,
        })
    }
}

struct OnlineCompactionSession {
    prior_timeout: String,
    lock_name: String,
}

struct OnlineCompactionExecution {
    reindexed: Vec<StorageCompactionCandidate>,
    stopped_at: Option<String>,
    stop_reason: Option<StorageCompactionStopReason>,
}

fn require_headroom(available: u64, required: u64) -> Result<(), StorageCompactionError> {
    if available == 0 {
        return Err(StorageCompactionError::HeadroomUnavailable);
    }
    if available < required {
        return Err(StorageCompactionError::InsufficientHeadroom);
    }
    Ok(())
}

async fn begin_compaction_session(
    connection: &mut sqlx_postgres::PgConnection,
    schema: &str,
    policy: StorageCompactionPolicy,
) -> Result<OnlineCompactionSession, StorageCompactionError> {
    let prior_timeout = query("SELECT current_setting('statement_timeout')")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| database_error("read-timeout"))?
        .try_get::<String, _>(0)
        .map_err(|_| corrupt("statement_timeout"))?;
    let timeout_millis = i64::try_from(policy.statement_timeout.as_millis())
        .map_err(|_| StorageCompactionError::InvalidPolicy)?;
    let lock_name = format!("{COMPACTION_LOCK_NAMESPACE}:{schema}");
    let lock = query("SELECT pg_try_advisory_lock(hashtextextended($1, 0))")
        .bind(&lock_name)
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| database_error("advisory-lock"))?
        .try_get::<bool, _>(0)
        .map_err(|_| corrupt("advisory_lock"))?;
    if !lock {
        return Err(StorageCompactionError::Busy);
    }
    if set_compaction_timeout(connection, timeout_millis)
        .await
        .is_err()
    {
        let _ = unlock_compaction(connection, &lock_name).await;
        return Err(database_error("set-timeout"));
    }
    Ok(OnlineCompactionSession {
        prior_timeout,
        lock_name,
    })
}

async fn set_compaction_timeout(
    connection: &mut sqlx_postgres::PgConnection,
    timeout_millis: i64,
) -> Result<(), StorageCompactionError> {
    query("SELECT set_config('statement_timeout', $1, false)")
        .bind(format!("{timeout_millis}ms"))
        .execute(connection)
        .await
        .map(|_| ())
        .map_err(|_| database_error("set-timeout"))
}

async fn execute_reindex_plan(
    connection: &mut sqlx_postgres::PgConnection,
    schema: &str,
    candidates: &[StorageCompactionCandidate],
) -> OnlineCompactionExecution {
    let mut execution = OnlineCompactionExecution {
        reindexed: Vec::new(),
        stopped_at: None,
        stop_reason: None,
    };
    for candidate in candidates {
        if !reindex_candidate(connection, schema, candidate).await {
            execution.stopped_at = Some(candidate.index.clone());
            execution.stop_reason = Some(StorageCompactionStopReason::ReindexFailed);
            break;
        }
        execution.reindexed.push(candidate.clone());
    }
    execution
}

async fn reindex_candidate(
    connection: &mut sqlx_postgres::PgConnection,
    schema: &str,
    candidate: &StorageCompactionCandidate,
) -> bool {
    if !valid_identifier(&candidate.index) {
        return false;
    }
    let statement = format!(
        r#"REINDEX INDEX CONCURRENTLY {schema}."{}""#,
        candidate.index
    );
    query(AssertSqlSafe(statement))
        .execute(connection)
        .await
        .is_ok()
}

async fn finish_compaction_session(
    connection: &mut sqlx_postgres::PgConnection,
    session: OnlineCompactionSession,
    execution: &mut OnlineCompactionExecution,
) -> bool {
    let timeout_restored = query("SELECT set_config('statement_timeout', $1, false)")
        .bind(session.prior_timeout)
        .execute(&mut *connection)
        .await
        .is_ok();
    if !timeout_restored && execution.stop_reason.is_none() {
        execution.stop_reason = Some(StorageCompactionStopReason::TimeoutRestoreFailed);
    }
    let unlocked = unlock_compaction(connection, &session.lock_name).await;
    if !unlocked && execution.stop_reason.is_none() {
        execution.stop_reason = Some(StorageCompactionStopReason::AdvisoryUnlockFailed);
    }
    timeout_restored && unlocked
}

async fn unlock_compaction(connection: &mut sqlx_postgres::PgConnection, lock_name: &str) -> bool {
    query("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
        .bind(lock_name)
        .fetch_one(connection)
        .await
        .ok()
        .and_then(|row| row.try_get::<bool, _>(0).ok())
        .unwrap_or(false)
}

fn sum_candidate_bytes(
    candidates: &[StorageCompactionCandidate],
) -> Result<u64, StorageCompactionError> {
    candidates.iter().try_fold(0_u64, |total, candidate| {
        total
            .checked_add(candidate.bytes)
            .ok_or_else(|| corrupt("bytes_before"))
    })
}

async fn load_plan(
    database: &CartographDatabase,
    policy: StorageCompactionPolicy,
) -> Result<StorageCompactionPlan, StorageCompactionError> {
    let statement = r#"SELECT indexes.relname AS index_name,
               tables.relname AS table_name,
               pg_relation_size(indexes.oid)::bigint AS bytes,
               count(*) OVER ()::bigint AS total_candidates
        FROM pg_catalog.pg_index AS catalog
        INNER JOIN pg_catalog.pg_class AS indexes
            ON indexes.oid = catalog.indexrelid
        INNER JOIN pg_catalog.pg_class AS tables
            ON tables.oid = catalog.indrelid
        INNER JOIN pg_catalog.pg_namespace AS namespaces
            ON namespaces.oid = indexes.relnamespace
        INNER JOIN pg_catalog.pg_am AS methods
            ON methods.oid = indexes.relam
        LEFT JOIN pg_catalog.pg_constraint AS constraints
            ON constraints.conindid = indexes.oid
           AND constraints.contype = 'x'
        WHERE namespaces.nspname = $1
          AND methods.amname = 'btree'
          AND catalog.indisvalid
          AND catalog.indisready
          AND constraints.oid IS NULL
          AND pg_relation_size(indexes.oid) >= $2
        ORDER BY bytes DESC, indexes.relname
        LIMIT $3"#;
    let rows = query(statement)
        .bind(database.schema.as_str())
        .bind(
            i64::try_from(policy.minimum_index_bytes)
                .map_err(|_| StorageCompactionError::InvalidPolicy)?,
        )
        .bind(i64::from(policy.maximum_indexes) + 1)
        .fetch_all(&database.pool)
        .await
        .map_err(|_| database_error("plan-candidates"))?;
    let total_candidates = rows
        .first()
        .map(|row| read_nonnegative(row, "total_candidates"))
        .transpose()?
        .unwrap_or(0);
    let mut candidates = Vec::new();
    let mut candidate_bytes = 0_u64;
    let mut truncated = total_candidates > u64::from(policy.maximum_indexes);
    for row in rows.into_iter().take(usize::from(policy.maximum_indexes)) {
        let candidate = StorageCompactionCandidate {
            index: read_identifier(&row, "index_name")?,
            table: read_identifier(&row, "table_name")?,
            bytes: read_nonnegative(&row, "bytes")?,
        };
        let admitted = candidate_bytes
            .checked_add(candidate.bytes)
            .ok_or_else(|| corrupt("candidate_bytes"))?;
        if admitted > policy.maximum_candidate_bytes {
            truncated = true;
            continue;
        }
        candidate_bytes = admitted;
        candidates.push(candidate);
    }
    let largest = candidates
        .iter()
        .map(|candidate| candidate.bytes)
        .max()
        .unwrap_or(0);
    let required_headroom_bytes = if largest == 0 {
        0
    } else {
        largest
            .checked_mul(HEADROOM_MULTIPLIER)
            .and_then(|bytes| bytes.checked_add(HEADROOM_ALLOWANCE_BYTES))
            .ok_or_else(|| corrupt("required_headroom_bytes"))?
    };
    let invalid_artifacts = load_invalid_artifacts(database).await?;
    Ok(StorageCompactionPlan {
        candidates,
        invalid_artifacts,
        candidate_bytes,
        required_headroom_bytes,
        truncated,
    })
}

async fn load_invalid_artifacts(
    database: &CartographDatabase,
) -> Result<Vec<InvalidIndexArtifact>, StorageCompactionError> {
    let statement = r#"SELECT indexes.relname AS index_name,
               tables.relname AS table_name,
               pg_relation_size(indexes.oid)::bigint AS bytes,
               catalog.indisvalid,
               catalog.indisready
        FROM pg_catalog.pg_index AS catalog
        INNER JOIN pg_catalog.pg_class AS indexes
            ON indexes.oid = catalog.indexrelid
        INNER JOIN pg_catalog.pg_class AS tables
            ON tables.oid = catalog.indrelid
        INNER JOIN pg_catalog.pg_namespace AS namespaces
            ON namespaces.oid = indexes.relnamespace
        WHERE namespaces.nspname = $1
          AND (NOT catalog.indisvalid OR NOT catalog.indisready
               OR indexes.relname ~ '_cc(new|old)[0-9]*$')
        ORDER BY bytes DESC, indexes.relname
        LIMIT 64"#;
    query(statement)
        .bind(database.schema.as_str())
        .fetch_all(&database.pool)
        .await
        .map_err(|_| database_error("plan-invalid-artifacts"))?
        .iter()
        .map(|row| {
            Ok(InvalidIndexArtifact {
                index: read_identifier(row, "index_name")?,
                table: read_identifier(row, "table_name")?,
                bytes: read_nonnegative(row, "bytes")?,
                valid: row
                    .try_get::<bool, _>("indisvalid")
                    .map_err(|_| corrupt("index_valid"))?,
                ready: row
                    .try_get::<bool, _>("indisready")
                    .map_err(|_| corrupt("index_ready"))?,
            })
        })
        .collect()
}

async fn load_candidate_bytes(
    database: &CartographDatabase,
    candidates: &[StorageCompactionCandidate],
) -> Result<u64, StorageCompactionError> {
    let names = candidates
        .iter()
        .map(|candidate| candidate.index.clone())
        .collect::<Vec<_>>();
    let statement = r#"SELECT COALESCE(sum(pg_relation_size(indexes.oid)), 0)::bigint AS bytes
        FROM pg_catalog.pg_class AS indexes
        INNER JOIN pg_catalog.pg_namespace AS namespaces
            ON namespaces.oid = indexes.relnamespace
        WHERE namespaces.nspname = $1
          AND indexes.relname = ANY($2::text[])"#;
    let row = query(statement)
        .bind(database.schema.as_str())
        .bind(names)
        .fetch_one(&database.pool)
        .await
        .map_err(|_| database_error("post-compaction-size"))?;
    read_nonnegative(&row, "bytes")
}

fn validate_policy(policy: StorageCompactionPolicy) -> Result<(), StorageCompactionError> {
    StorageCompactionPolicy::new(StorageCompactionPolicyInput {
        maximum_indexes: policy.maximum_indexes,
        maximum_candidate_bytes: policy.maximum_candidate_bytes,
        minimum_index_bytes: policy.minimum_index_bytes,
        statement_timeout: policy.statement_timeout,
    })
    .map(|_| ())
}

fn read_identifier(
    row: &sqlx_postgres::PgRow,
    field: &'static str,
) -> Result<String, StorageCompactionError> {
    row.try_get::<String, _>(field)
        .ok()
        .filter(|value| valid_identifier(value))
        .ok_or_else(|| corrupt(field))
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn read_nonnegative(
    row: &sqlx_postgres::PgRow,
    field: &'static str,
) -> Result<u64, StorageCompactionError> {
    row.try_get::<i64, _>(field)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| corrupt(field))
}

const fn database_error(operation: &'static str) -> StorageCompactionError {
    StorageCompactionError::DatabaseOperation { operation }
}

const fn corrupt(field: &'static str) -> StorageCompactionError {
    StorageCompactionError::CorruptCatalog { field }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_policy_and_identifiers_are_strictly_bounded() {
        assert!(
            StorageCompactionPolicy::new(StorageCompactionPolicyInput {
                maximum_indexes: 0,
                maximum_candidate_bytes: 1,
                minimum_index_bytes: 1,
                statement_timeout: Duration::from_secs(1),
            })
            .is_err()
        );
        assert!(
            StorageCompactionPolicy::new(StorageCompactionPolicyInput {
                maximum_indexes: 1,
                maximum_candidate_bytes: 2,
                minimum_index_bytes: 1,
                statement_timeout: Duration::from_secs(1),
            })
            .is_err()
        );
        assert!(valid_identifier("references_exact_name_site_idx"));
        assert!(!valid_identifier("public.references_idx"));
        assert!(!valid_identifier("unsafe\"identifier"));
    }
}
