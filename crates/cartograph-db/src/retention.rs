use std::time::Duration;

use cartograph_domain::{GenerationId, ProjectOperation};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use thiserror::Error;

use crate::{CartographDatabase, LeaseFence, leases::project_lock_key};

const MAXIMUM_DELETE_BATCH: u32 = 10_000;
const MAXIMUM_CASCADE_ROW_BUDGET: u64 = 100_000_000;
const MAXIMUM_SEARCH_RELATION_BYTE_BUDGET: u64 = 64 * 1_024 * 1_024 * 1_024;
const MAXIMUM_DDL_RELATIONS: u32 = 64;
const DEFAULT_CASCADE_ROW_BUDGET: u64 = 5_000_000;
const DEFAULT_SEARCH_RELATION_BYTE_BUDGET: u64 = 8 * 1_024 * 1_024 * 1_024;
const DEFAULT_STALE_STAGING_AGE: Duration = Duration::from_secs(10 * 60);
const MAXIMUM_STALE_STAGING_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const DEFAULT_STALE_READY_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const MAXIMUM_STALE_READY_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const POST_RETENTION_VACUUM_ROW_THRESHOLD: u64 = 100_000;
const POST_RETENTION_VACUUM_TABLES: [&str; 10] = [
    "index_generations",
    "files",
    "symbols",
    "edges",
    "references",
    "search_documents",
    "document_embeddings",
    "symbol_similarity_edges",
    "symbol_similarity_builds",
    "generation_search_relations",
];
const RETENTION_LOCK_NAMESPACE: &str = "cartograph-v2-generation-retention";
const PUBLICATION_LOCK_NAMESPACE: &str = "cartograph-v2-publish";
const INVALID_DELETE_BATCH: u32 = 0;

/// Bounded policy for deleting only terminal historical generations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GenerationRetentionPolicy {
    recent_superseded: u32,
    maximum_deletions: u32,
    stale_staging_age: Duration,
    stale_ready_age: Duration,
    maximum_cascade_rows: u64,
    maximum_search_relation_bytes: u64,
    maximum_ddl_relations: u32,
}

/// Exact lease fence and deadline for one bounded retention transaction.
pub struct GenerationRetentionRequest<'a> {
    policy: GenerationRetentionPolicy,
    fence: &'a LeaseFence,
    statement_timeout: Duration,
}

impl<'a> GenerationRetentionRequest<'a> {
    /// Bind one retention policy to an exact project-wide migration lease.
    #[must_use]
    pub const fn new(
        policy: GenerationRetentionPolicy,
        fence: &'a LeaseFence,
        statement_timeout: Duration,
    ) -> Self {
        Self {
            policy,
            fence,
            statement_timeout,
        }
    }
}

impl GenerationRetentionPolicy {
    /// Preserve the newest `recent_superseded` histories and bound one cleanup batch.
    pub const fn new(
        recent_superseded: u32,
        maximum_deletions: u32,
    ) -> Result<Self, GenerationRetentionError> {
        if maximum_deletions == INVALID_DELETE_BATCH || maximum_deletions > MAXIMUM_DELETE_BATCH {
            return Err(GenerationRetentionError::InvalidPolicy);
        }
        Ok(Self {
            recent_superseded,
            maximum_deletions,
            stale_staging_age: DEFAULT_STALE_STAGING_AGE,
            stale_ready_age: DEFAULT_STALE_READY_AGE,
            maximum_cascade_rows: DEFAULT_CASCADE_ROW_BUDGET,
            maximum_search_relation_bytes: DEFAULT_SEARCH_RELATION_BYTE_BUDGET,
            maximum_ddl_relations: if maximum_deletions < MAXIMUM_DDL_RELATIONS {
                maximum_deletions
            } else {
                MAXIMUM_DDL_RELATIONS
            },
        })
    }

    /// Override how old an unleased ready generation must be before it can be
    /// reconciled. Current pointers and incomplete imports remain protected.
    pub fn with_stale_ready_age(
        mut self,
        stale_ready_age: Duration,
    ) -> Result<Self, GenerationRetentionError> {
        if stale_ready_age.is_zero() || stale_ready_age > MAXIMUM_STALE_READY_AGE {
            return Err(GenerationRetentionError::InvalidPolicy);
        }
        self.stale_ready_age = stale_ready_age;
        Ok(self)
    }

    /// Override how old an unleased staging generation must be before collection.
    pub fn with_stale_staging_age(
        mut self,
        stale_staging_age: Duration,
    ) -> Result<Self, GenerationRetentionError> {
        if stale_staging_age.is_zero() || stale_staging_age > MAXIMUM_STALE_STAGING_AGE {
            return Err(GenerationRetentionError::InvalidPolicy);
        }
        self.stale_staging_age = stale_staging_age;
        Ok(self)
    }

    /// Override exact row, physical relation-byte, and DDL-count work caps.
    pub const fn with_work_limits(
        mut self,
        maximum_cascade_rows: u64,
        maximum_search_relation_bytes: u64,
        maximum_ddl_relations: u32,
    ) -> Result<Self, GenerationRetentionError> {
        if !valid_positive_limit(maximum_cascade_rows, MAXIMUM_CASCADE_ROW_BUDGET)
            || !valid_positive_limit(
                maximum_search_relation_bytes,
                MAXIMUM_SEARCH_RELATION_BYTE_BUDGET,
            )
            || maximum_ddl_relations == 0
            || maximum_ddl_relations > MAXIMUM_DDL_RELATIONS
        {
            return Err(GenerationRetentionError::InvalidPolicy);
        }
        self.maximum_cascade_rows = maximum_cascade_rows;
        self.maximum_search_relation_bytes = maximum_search_relation_bytes;
        self.maximum_ddl_relations = maximum_ddl_relations;
        Ok(self)
    }

    /// Number of most-recent superseded generations that can never be selected.
    #[must_use]
    pub const fn recent_superseded(self) -> u32 {
        self.recent_superseded
    }

    /// Maximum terminal generations deleted by one transaction.
    #[must_use]
    pub const fn maximum_deletions(self) -> u32 {
        self.maximum_deletions
    }

    /// Minimum database-clock age for collecting an unleased staging generation.
    #[must_use]
    pub const fn stale_staging_age(self) -> Duration {
        self.stale_staging_age
    }

    /// Minimum database-clock age for collecting an unleased ready generation.
    #[must_use]
    pub const fn stale_ready_age(self) -> Duration {
        self.stale_ready_age
    }

    /// Maximum canonical/cascade rows admitted into one cleanup transaction.
    #[must_use]
    pub const fn maximum_cascade_rows(self) -> u64 {
        self.maximum_cascade_rows
    }

    /// Maximum physical bytes of generation search relations dropped per call.
    #[must_use]
    pub const fn maximum_search_relation_bytes(self) -> u64 {
        self.maximum_search_relation_bytes
    }

    /// Maximum dynamic relation drops issued per cleanup transaction.
    #[must_use]
    pub const fn maximum_ddl_relations(self) -> u32 {
        self.maximum_ddl_relations
    }
}

const fn valid_positive_limit(value: u64, maximum: u64) -> bool {
    value > 0 && value <= maximum
}

/// Exact bounded cleanup result after cascades committed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct GenerationRetentionReport {
    /// Stale unleased staging generations deleted in this batch.
    pub staging_removed: u64,
    /// Old unleased ready generations reconciled in this batch.
    pub ready_removed: u64,
    /// Superseded generations deleted in this batch.
    pub superseded_removed: u64,
    /// Failed generations deleted in this batch.
    pub failed_removed: u64,
    /// Model-scoped vectors removed by generation cascades in this batch.
    pub embeddings_removed: u64,
    /// Current generations still present; valid project state is zero or one.
    pub current_preserved: u64,
    /// Superseded generations retained after this batch.
    pub superseded_preserved: u64,
    /// Failed generations still waiting for a later bounded batch.
    pub failed_remaining: u64,
    /// Staging generations still present, including recent or leased work.
    pub staging_remaining: u64,
    /// Ready generations still protected or waiting for a later bounded batch.
    pub ready_remaining: u64,
    /// Canonical and cascading rows admitted under the exact row-work cap.
    pub cascade_rows_removed: u64,
    /// Physical generation search relations removed in the bounded DDL batch.
    pub search_relations_removed: u64,
    /// Physical table and BM25 index bytes admitted under the byte-work cap.
    pub search_relation_bytes_removed: u64,
    /// Thresholded, table-scoped post-commit vacuum outcome.
    pub maintenance: PostRetentionMaintenance,
}

impl GenerationRetentionReport {
    /// Total generations deleted by this invocation.
    #[must_use]
    pub const fn removed(self) -> u64 {
        self.staging_removed + self.ready_removed + self.superseded_removed + self.failed_removed
    }
}

/// Table-scoped post-retention maintenance. Routine cleanup never performs
/// `VACUUM FULL` or an unqualified database-wide `ANALYZE`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PostRetentionMaintenance {
    #[default]
    NotNeeded,
    Completed {
        tables_attempted: u64,
    },
    Deferred {
        reason: &'static str,
    },
}

/// Credential-safe generation-retention failure.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum GenerationRetentionError {
    /// Batch size or statement deadline was zero or outside its hard bound.
    #[error("Cartograph generation retention policy is invalid")]
    InvalidPolicy,
    /// The supplied token is not the current exact project migration lease.
    #[error("Cartograph generation retention lost its exact migration lease fence")]
    LeaseFenceLost,
    /// The lease project does not exist in the destination schema.
    #[error("Cartograph generation retention project does not exist")]
    ProjectNotFound,
    /// A PostgreSQL operation failed without rendering connection or query detail.
    #[error("Cartograph PostgreSQL retention operation failed during {operation}")]
    DatabaseOperation {
        /// Stable operation label.
        operation: &'static str,
    },
}

impl CartographDatabase {
    /// Delete a bounded batch of stale unleased staging/ready, failed, and old
    /// superseded generations.
    ///
    /// The current generation, recent or leased staging/ready work, incomplete
    /// imports, and the configured newest superseded histories are never
    /// candidates. The caller must hold an exact, unexpired project
    /// `migration` lease that is not generation-bound.
    pub async fn cleanup_generations(
        &self,
        request: GenerationRetentionRequest<'_>,
    ) -> Result<GenerationRetentionReport, GenerationRetentionError> {
        validate_fence_shape(request.fence)?;
        if request.statement_timeout.is_zero() {
            return Err(GenerationRetentionError::InvalidPolicy);
        }
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("begin"))?;
        if crate::database::set_local_statement_timeout(&mut transaction, request.statement_timeout)
            .await
            .is_err()
        {
            let _ = transaction.rollback().await;
            return Err(GenerationRetentionError::InvalidPolicy);
        }
        let context = RetentionContext {
            database: self,
            policy: request.policy,
            fence: request.fence,
            quoted_schema: crate::database::quoted_schema(&self.schema),
        };
        let result = cleanup_transaction(&mut transaction, &context).await;
        match result {
            Ok(report) => {
                transaction
                    .commit()
                    .await
                    .map_err(|_| database_error("commit"))?;
                let mut report = report;
                if report.cascade_rows_removed >= POST_RETENTION_VACUUM_ROW_THRESHOLD {
                    report.maintenance = match self
                        .vacuum_retention_tables(request.statement_timeout)
                        .await
                    {
                        Ok(tables_attempted) => {
                            PostRetentionMaintenance::Completed { tables_attempted }
                        }
                        Err(()) => PostRetentionMaintenance::Deferred {
                            reason: "table_maintenance_unavailable",
                        },
                    };
                }
                Ok(report)
            }
            Err(error) => {
                transaction
                    .rollback()
                    .await
                    .map_err(|_| database_error("rollback"))?;
                Err(error)
            }
        }
    }

    async fn vacuum_retention_tables(&self, statement_timeout: Duration) -> Result<u64, ()> {
        let timeout_millis = i64::try_from(statement_timeout.as_millis()).map_err(|_| ())?;
        if timeout_millis == 0 {
            return Err(());
        }
        let mut connection = self.pool.acquire().await.map_err(|_| ())?;
        let prior_timeout = query("SELECT current_setting('statement_timeout')")
            .fetch_one(&mut *connection)
            .await
            .ok()
            .and_then(|row| row.try_get::<String, _>(0).ok())
            .ok_or(())?;
        query("SELECT set_config('statement_timeout', $1, false)")
            .bind(format!("{timeout_millis}ms"))
            .execute(&mut *connection)
            .await
            .map_err(|_| ())?;
        let schema = crate::database::quoted_schema(&self.schema);
        let mut attempted = 0_u64;
        let mut result = Ok(());
        for table in POST_RETENTION_VACUUM_TABLES {
            let statement = format!(
                r#"VACUUM (
                        ANALYZE,
                        SKIP_LOCKED,
                        INDEX_CLEANUP ON,
                        TRUNCATE OFF,
                        SKIP_DATABASE_STATS
                    ) {schema}."{table}""#
            );
            if query(AssertSqlSafe(statement))
                .execute(&mut *connection)
                .await
                .is_err()
            {
                result = Err(());
                break;
            }
            attempted = attempted.checked_add(1).ok_or(())?;
        }
        let restored = query("SELECT set_config('statement_timeout', $1, false)")
            .bind(prior_timeout)
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|_| ());
        result.and(restored).map(|()| attempted)
    }
}

struct RetentionContext<'a> {
    database: &'a CartographDatabase,
    policy: GenerationRetentionPolicy,
    fence: &'a LeaseFence,
    quoted_schema: String,
}

struct RemovedGenerationCounts {
    staging: u64,
    ready: u64,
    superseded: u64,
    failed: u64,
    embeddings: u64,
}

struct PreservedGenerationCounts {
    current: u64,
    staging: u64,
    ready: u64,
    superseded: u64,
    failed: u64,
}

struct RetentionCandidate {
    generation_id: GenerationId,
}

struct CandidateWork {
    candidate: RetentionCandidate,
    cascade_rows: u64,
    search_relation_bytes: u64,
    search_relation_present: bool,
}

#[derive(Default)]
struct BoundedCandidateWork {
    candidates: Vec<CandidateWork>,
    cascade_rows: u64,
    search_relation_bytes: u64,
    search_relations: u64,
}

async fn cleanup_transaction(
    connection: &mut sqlx_postgres::PgConnection,
    context: &RetentionContext<'_>,
) -> Result<GenerationRetentionReport, GenerationRetentionError> {
    acquire_retention_locks(connection, context).await?;
    require_live_fence(connection, context).await?;
    lock_project(connection, context).await?;
    let candidates = load_terminal_candidates(connection, context).await?;
    let bounded = bound_candidate_work(connection, context, candidates).await?;
    for work in &bounded.candidates {
        crate::search_relation::drop_generation_search_relation(
            connection,
            &context.database.schema,
            &work.candidate.generation_id,
        )
        .await
        .map_err(|_| database_error("drop-generation-search-relation"))?;
    }
    let removed = delete_terminal_generations(connection, context, &bounded.candidates).await?;
    let preserved = load_preserved_counts(connection, context).await?;
    // Row locks prevent takeover, but they do not freeze database-clock expiry.
    require_live_fence(connection, context).await?;
    Ok(GenerationRetentionReport {
        staging_removed: removed.staging,
        ready_removed: removed.ready,
        superseded_removed: removed.superseded,
        failed_removed: removed.failed,
        embeddings_removed: removed.embeddings,
        current_preserved: preserved.current,
        superseded_preserved: preserved.superseded,
        failed_remaining: preserved.failed,
        staging_remaining: preserved.staging,
        ready_remaining: preserved.ready,
        cascade_rows_removed: bounded.cascade_rows,
        search_relations_removed: bounded.search_relations,
        search_relation_bytes_removed: bounded.search_relation_bytes,
        maintenance: PostRetentionMaintenance::NotNeeded,
    })
}

async fn load_terminal_candidates(
    connection: &mut sqlx_postgres::PgConnection,
    context: &RetentionContext<'_>,
) -> Result<Vec<RetentionCandidate>, GenerationRetentionError> {
    let stale_staging_millis = i64::try_from(context.policy.stale_staging_age.as_millis())
        .map_err(|_| GenerationRetentionError::InvalidPolicy)?;
    let stale_ready_millis = i64::try_from(context.policy.stale_ready_age.as_millis())
        .map_err(|_| GenerationRetentionError::InvalidPolicy)?;
    let sql = format!(
        r#"WITH ranked AS (
                SELECT generation_id, generation_sequence, state, started_at, ready_at,
                       row_number() OVER (
                           PARTITION BY state ORDER BY generation_sequence DESC
                       ) AS state_rank
                FROM {}."index_generations"
                WHERE project_id = CAST($1 AS uuid)
            )
            SELECT generation_id::text
            FROM ranked
            WHERE (state = 'failed' AND NOT EXISTS (
                    SELECT 1
                    FROM {}."v1_import_runs" AS import_runs
                    WHERE import_runs.project_id = CAST($1 AS uuid)
                      AND import_runs.generation_id = ranked.generation_id
                      AND import_runs.checkpoint <> 'complete'
                ))
               OR (state = 'superseded' AND state_rank > $2)
               OR (state = 'ready'
                   AND COALESCE(ready_at, started_at)
                       <= clock_timestamp() - $4 * interval '1 millisecond'
                   AND generation_id IS DISTINCT FROM (
                       SELECT current_generation_id
                       FROM {}."projects"
                       WHERE project_id = CAST($1 AS uuid)
                   )
                   AND NOT EXISTS (
                       SELECT 1
                       FROM {}."project_operation_leases" AS leases
                       WHERE leases.project_id = CAST($1 AS uuid)
                         AND leases.generation_id = ranked.generation_id
                         AND leases.expires_at > clock_timestamp()
                   )
                   AND NOT EXISTS (
                       SELECT 1
                       FROM {}."v1_import_runs" AS import_runs
                       WHERE import_runs.project_id = CAST($1 AS uuid)
                         AND import_runs.generation_id = ranked.generation_id
                         AND import_runs.checkpoint <> 'complete'
                   ))
               OR (state = 'staging'
                   AND started_at <= clock_timestamp() - $3 * interval '1 millisecond'
                   AND NOT EXISTS (
                       SELECT 1
                       FROM {}."project_operation_leases" AS leases
                       WHERE leases.project_id = CAST($1 AS uuid)
                         AND leases.generation_id = ranked.generation_id
                         AND leases.expires_at > clock_timestamp()
                   )
                   AND NOT EXISTS (
                       SELECT 1
                       FROM {}."v1_import_runs" AS import_runs
                       WHERE import_runs.project_id = CAST($1 AS uuid)
                         AND import_runs.generation_id = ranked.generation_id
                         AND import_runs.checkpoint <> 'complete'
                   ))
            ORDER BY generation_sequence ASC
            LIMIT $5"#,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
    );
    query(AssertSqlSafe(sql))
        .bind(context.fence.target().project_id().as_str())
        .bind(i64::from(context.policy.recent_superseded))
        .bind(stale_staging_millis)
        .bind(stale_ready_millis)
        .bind(i64::from(
            context
                .policy
                .maximum_deletions
                .min(context.policy.maximum_ddl_relations),
        ))
        .fetch_all(connection)
        .await
        .map_err(|_| database_error("load-terminal-generations"))?
        .iter()
        .map(|row| {
            let value = row
                .try_get::<String, _>(0)
                .map_err(|_| database_error("decode-terminal-generation"))?;
            GenerationId::parse(&value)
                .map(|generation_id| RetentionCandidate { generation_id })
                .map_err(|_| database_error("decode-terminal-generation"))
        })
        .collect()
}

async fn bound_candidate_work(
    connection: &mut sqlx_postgres::PgConnection,
    context: &RetentionContext<'_>,
    candidates: Vec<RetentionCandidate>,
) -> Result<BoundedCandidateWork, GenerationRetentionError> {
    let mut candidate_work = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        candidate_work.push(load_candidate_work(connection, context, candidate).await?);
    }
    select_bounded_candidate_work(context.policy, candidate_work)
}

fn select_bounded_candidate_work(
    policy: GenerationRetentionPolicy,
    candidates: impl IntoIterator<Item = CandidateWork>,
) -> Result<BoundedCandidateWork, GenerationRetentionError> {
    let mut bounded = BoundedCandidateWork::default();
    for work in candidates {
        let cascade_rows = bounded
            .cascade_rows
            .checked_add(work.cascade_rows)
            .ok_or_else(|| database_error("candidate-row-budget"))?;
        let search_relation_bytes = bounded
            .search_relation_bytes
            .checked_add(work.search_relation_bytes)
            .ok_or_else(|| database_error("candidate-byte-budget"))?;
        if cascade_rows > policy.maximum_cascade_rows
            || search_relation_bytes > policy.maximum_search_relation_bytes
        {
            continue;
        }
        bounded.cascade_rows = cascade_rows;
        bounded.search_relation_bytes = search_relation_bytes;
        if work.search_relation_present {
            bounded.search_relations += 1;
        }
        bounded.candidates.push(work);
    }
    Ok(bounded)
}

async fn load_candidate_work(
    connection: &mut sqlx_postgres::PgConnection,
    context: &RetentionContext<'_>,
    candidate: RetentionCandidate,
) -> Result<CandidateWork, GenerationRetentionError> {
    let relation_name = format!(
        "{}.search_g_{}",
        context.database.schema.as_str(),
        candidate.generation_id.as_str().replace('-', "")
    );
    let sql = format!(
        r#"SELECT
                1
                + (SELECT count(*) FROM {}."files"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {}."symbols"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {}."edges"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {}."references"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {}."search_documents"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {}."document_embeddings"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {}."symbol_similarity_edges"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {}."symbol_similarity_builds"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {}."generation_search_relations"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {}."project_operation_leases"
                   WHERE project_id = CAST($1 AS uuid)
                     AND generation_id = CAST($2 AS uuid))
                    AS cascade_rows,
                COALESCE(pg_total_relation_size(to_regclass($3)), 0)::bigint
                    AS search_relation_bytes,
                to_regclass($3) IS NOT NULL AS search_relation_present"#,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
        context.quoted_schema,
    );
    let row = query(AssertSqlSafe(sql))
        .bind(context.fence.target().project_id().as_str())
        .bind(candidate.generation_id.as_str())
        .bind(relation_name)
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("load-candidate-work"))?;
    let cascade_rows = read_named_count(&row, "cascade_rows")?;
    let search_relation_bytes = read_named_count(&row, "search_relation_bytes")?;
    let search_relation_present = row
        .try_get::<bool, _>("search_relation_present")
        .map_err(|_| database_error("decode-candidate-work"))?;
    Ok(CandidateWork {
        candidate,
        cascade_rows,
        search_relation_bytes,
        search_relation_present,
    })
}

async fn acquire_retention_locks(
    connection: &mut sqlx_postgres::PgConnection,
    context: &RetentionContext<'_>,
) -> Result<(), GenerationRetentionError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(project_lock_key(
            &context.database.schema,
            context.fence.target().project_id(),
        ))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("operation-lock"))?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{PUBLICATION_LOCK_NAMESPACE}:{}:{}",
            context.database.schema.as_str(),
            context.fence.target().project_id()
        ))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("publication-lock"))?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{RETENTION_LOCK_NAMESPACE}:{}:{}",
            context.database.schema.as_str(),
            context.fence.target().project_id()
        ))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("retention-lock"))?;
    Ok(())
}

async fn lock_project(
    connection: &mut sqlx_postgres::PgConnection,
    context: &RetentionContext<'_>,
) -> Result<(), GenerationRetentionError> {
    let project_sql = format!(
        r#"SELECT 1 FROM {}."projects"
            WHERE project_id = CAST($1 AS uuid) FOR UPDATE"#,
        context.quoted_schema
    );
    if query(AssertSqlSafe(project_sql))
        .bind(context.fence.target().project_id().as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| database_error("lock-project"))?
        .is_none()
    {
        Err(GenerationRetentionError::ProjectNotFound)
    } else {
        Ok(())
    }
}

async fn delete_terminal_generations(
    connection: &mut sqlx_postgres::PgConnection,
    context: &RetentionContext<'_>,
    candidates: &[CandidateWork],
) -> Result<RemovedGenerationCounts, GenerationRetentionError> {
    if candidates.is_empty() {
        return Ok(RemovedGenerationCounts {
            staging: 0,
            ready: 0,
            superseded: 0,
            failed: 0,
            embeddings: 0,
        });
    }
    let generation_ids = candidates
        .iter()
        .map(|work| work.candidate.generation_id.as_str().to_owned())
        .collect::<Vec<_>>();
    let cleanup_sql = format!(
        r#"WITH candidate_embeddings AS MATERIALIZED (
                SELECT count(*)::bigint AS embeddings_removed
                FROM {}."document_embeddings" AS embeddings
                WHERE embeddings.project_id = CAST($1 AS uuid)
                  AND embeddings.generation_id = ANY(CAST($2 AS uuid[]))
            ), deleted AS (
                DELETE FROM {}."index_generations" AS generations
                WHERE generations.project_id = CAST($1 AS uuid)
                  AND generations.generation_id = ANY(CAST($2 AS uuid[]))
                  AND generations.state IN ('staging', 'ready', 'failed', 'superseded')
                RETURNING generations.state
            )
            SELECT
                count(*) FILTER (WHERE state = 'staging')::bigint AS staging_removed,
                count(*) FILTER (WHERE state = 'ready')::bigint AS ready_removed,
                count(*) FILTER (WHERE state = 'superseded')::bigint AS superseded_removed,
                count(*) FILTER (WHERE state = 'failed')::bigint AS failed_removed,
                (SELECT embeddings_removed FROM candidate_embeddings) AS embeddings_removed
            FROM deleted"#,
        context.quoted_schema, context.quoted_schema
    );
    let row = query(AssertSqlSafe(cleanup_sql))
        .bind(context.fence.target().project_id().as_str())
        .bind(generation_ids)
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| database_error("delete-terminal-generations"))?;
    Ok(RemovedGenerationCounts {
        staging: read_named_count(&row, "staging_removed")?,
        ready: read_named_count(&row, "ready_removed")?,
        superseded: read_named_count(&row, "superseded_removed")?,
        failed: read_named_count(&row, "failed_removed")?,
        embeddings: read_named_count(&row, "embeddings_removed")?,
    })
}

async fn load_preserved_counts(
    connection: &mut sqlx_postgres::PgConnection,
    context: &RetentionContext<'_>,
) -> Result<PreservedGenerationCounts, GenerationRetentionError> {
    let remaining_sql = format!(
        r#"SELECT
            count(*) FILTER (WHERE state = 'current')::bigint AS current_preserved,
            count(*) FILTER (WHERE state = 'staging')::bigint AS staging_remaining,
            count(*) FILTER (WHERE state = 'ready')::bigint AS ready_remaining,
            count(*) FILTER (WHERE state = 'superseded')::bigint AS superseded_preserved,
            count(*) FILTER (WHERE state = 'failed')::bigint AS failed_remaining
        FROM {}."index_generations"
        WHERE project_id = CAST($1 AS uuid)"#,
        context.quoted_schema
    );
    let remaining = query(AssertSqlSafe(remaining_sql))
        .bind(context.fence.target().project_id().as_str())
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| database_error("count-retained-generations"))?;
    Ok(PreservedGenerationCounts {
        current: read_named_count(&remaining, "current_preserved")?,
        staging: read_named_count(&remaining, "staging_remaining")?,
        ready: read_named_count(&remaining, "ready_remaining")?,
        superseded: read_named_count(&remaining, "superseded_preserved")?,
        failed: read_named_count(&remaining, "failed_remaining")?,
    })
}

fn validate_fence_shape(fence: &LeaseFence) -> Result<(), GenerationRetentionError> {
    if fence.target().operation() != ProjectOperation::Migration
        || fence.target().generation_id().is_some()
    {
        Err(GenerationRetentionError::LeaseFenceLost)
    } else {
        Ok(())
    }
}

async fn require_live_fence(
    connection: &mut sqlx_postgres::PgConnection,
    context: &RetentionContext<'_>,
) -> Result<(), GenerationRetentionError> {
    let sql = format!(
        r#"SELECT 1 FROM {}."project_operation_leases"
            WHERE project_id = CAST($1 AS uuid)
              AND operation = 'migration'
              AND lease_id = CAST($2 AS uuid)
              AND generation_id IS NULL
              AND expires_at > clock_timestamp()
            FOR UPDATE"#,
        context.quoted_schema
    );
    let exists = query(AssertSqlSafe(sql))
        .bind(context.fence.target().project_id().as_str())
        .bind(context.fence.lease_id().as_str())
        .fetch_optional(connection)
        .await
        .map_err(|_| database_error("lock-lease"))?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(GenerationRetentionError::LeaseFenceLost)
    }
}

fn read_named_count(
    row: &sqlx_postgres::PgRow,
    column: &'static str,
) -> Result<u64, GenerationRetentionError> {
    let value = row
        .try_get::<i64, _>(column)
        .map_err(|_| database_error("decode-counts"))?;
    u64::try_from(value).map_err(|_| database_error("decode-counts"))
}

const fn database_error(operation: &'static str) -> GenerationRetentionError {
    GenerationRetentionError::DatabaseOperation { operation }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use cartograph_domain::GenerationId;

    use super::{
        CandidateWork, DEFAULT_STALE_STAGING_AGE, GenerationRetentionError,
        GenerationRetentionPolicy, INVALID_DELETE_BATCH, MAXIMUM_DELETE_BATCH,
        MAXIMUM_STALE_STAGING_AGE, RetentionCandidate, select_bounded_candidate_work,
    };

    const TEST_RETAINED_SUPERSEDED: u32 = 2;
    const TEST_DELETE_BATCH: u32 = 10;
    const TEST_OVERSIZED_DELETE_BATCH: u32 = MAXIMUM_DELETE_BATCH + 1;

    #[test]
    fn retention_requires_a_nonzero_bounded_delete_batch() {
        assert!(matches!(
            GenerationRetentionPolicy::new(TEST_RETAINED_SUPERSEDED, INVALID_DELETE_BATCH),
            Err(GenerationRetentionError::InvalidPolicy)
        ));
        assert!(matches!(
            GenerationRetentionPolicy::new(TEST_RETAINED_SUPERSEDED, TEST_OVERSIZED_DELETE_BATCH),
            Err(GenerationRetentionError::InvalidPolicy)
        ));
        assert!(matches!(
            GenerationRetentionPolicy::new(TEST_RETAINED_SUPERSEDED, TEST_DELETE_BATCH),
            Ok(policy)
                if policy.recent_superseded() == TEST_RETAINED_SUPERSEDED
                    && policy.maximum_deletions() == TEST_DELETE_BATCH
                    && policy.stale_staging_age() == DEFAULT_STALE_STAGING_AGE
        ));
    }

    #[test]
    fn stale_staging_age_is_nonzero_and_hard_bounded() {
        let policy = GenerationRetentionPolicy::new(TEST_RETAINED_SUPERSEDED, TEST_DELETE_BATCH)
            .unwrap_or_else(|error| panic!("base retention policy failed: {error}"));
        assert_eq!(
            policy.with_stale_staging_age(Duration::ZERO),
            Err(GenerationRetentionError::InvalidPolicy)
        );
        assert_eq!(
            policy.with_stale_staging_age(MAXIMUM_STALE_STAGING_AGE + Duration::from_secs(1)),
            Err(GenerationRetentionError::InvalidPolicy)
        );
        assert!(matches!(
            policy.with_stale_staging_age(Duration::from_secs(60)),
            Ok(updated) if updated.stale_staging_age() == Duration::from_secs(60)
        ));
    }

    #[test]
    fn oversized_oldest_candidate_does_not_starve_smaller_later_work() {
        let policy = GenerationRetentionPolicy::new(0, 3)
            .and_then(|policy| policy.with_work_limits(10, 100, 3))
            .unwrap_or_else(|error| panic!("retention test policy failed: {error}"));
        let oversized = candidate_work("00000000-0000-0000-0000-000000000001", 11, 1);
        let smaller = candidate_work("00000000-0000-0000-0000-000000000002", 4, 20);

        let selected = select_bounded_candidate_work(policy, [oversized, smaller])
            .unwrap_or_else(|error| panic!("candidate selection failed: {error}"));

        assert_eq!(selected.candidates.len(), 1);
        assert_eq!(
            selected.candidates[0].candidate.generation_id.as_str(),
            "00000000-0000-0000-0000-000000000002"
        );
        assert_eq!(selected.cascade_rows, 4);
        assert_eq!(selected.search_relation_bytes, 20);
        assert_eq!(selected.search_relations, 1);
    }

    fn candidate_work(
        generation_id: &str,
        cascade_rows: u64,
        relation_bytes: u64,
    ) -> CandidateWork {
        CandidateWork {
            candidate: RetentionCandidate {
                generation_id: GenerationId::parse(generation_id)
                    .unwrap_or_else(|error| panic!("test generation id failed: {error}")),
            },
            cascade_rows,
            search_relation_bytes: relation_bytes,
            search_relation_present: true,
        }
    }
}
