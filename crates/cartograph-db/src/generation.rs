use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use cartograph_domain::{ContentDigest, GenerationId, GenerationState, ProjectId};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::{PgConnection, PgRow};
use thiserror::Error;

use crate::{
    CartographDatabase, LeaseFence, StorageError,
    ingest::{
        CopyGenerationContext, GenerationFacts, ValidatedGenerationFacts, copy_generation_facts,
        validate_and_reduce,
    },
    leases::operation_lock_key,
};

const MAX_ROOT_IDENTITY_BYTES: usize = 4_096;
const MAX_SOURCE_REVISION_BYTES: usize = 1_024;
const MAX_WORKERS: u16 = 256;
const RECONCILE_STATE_COLUMN: usize = 0;
const RECONCILE_SEQUENCE_COLUMN: usize = 1;
const RECONCILE_DIGEST_COLUMN: usize = 2;
const RECONCILE_CURRENT_COLUMN: usize = 3;
const RECONCILE_LEASE_ID_COLUMN: usize = 4;
const RECONCILE_LEASE_UNEXPIRED_COLUMN: usize = 5;
const RECONCILE_LEASE_GENERATION_COLUMN: usize = 6;
const GENERATION_LOCK_NAMESPACE: &str = "cartograph-v2-generation";

/// Validated-at-write project registration input.
pub struct NewProject {
    root_identity: String,
    repository_fingerprint: ContentDigest,
}

impl NewProject {
    /// Build a project request. Validation occurs at the database boundary so
    /// every caller receives the same stable error contract.
    #[must_use]
    pub fn new(root_identity: impl Into<String>, repository_fingerprint: ContentDigest) -> Self {
        Self {
            root_identity: root_identity.into(),
            repository_fingerprint,
        }
    }
}

/// Validated-at-write immutable generation request.
pub struct NewGeneration {
    project_id: ProjectId,
    source_revision: String,
    worker_count: u16,
}

impl NewGeneration {
    /// Build a generation request tied to one branded project identity.
    #[must_use]
    pub fn new(
        project_id: ProjectId,
        source_revision: impl Into<String>,
        worker_count: u16,
    ) -> Self {
        Self {
            project_id,
            source_revision: source_revision.into(),
            worker_count,
        }
    }
}

/// Opaque token proving a durable generation exists in `staging` state.
#[derive(Debug)]
pub struct StagedGeneration {
    project_id: ProjectId,
    generation_id: GenerationId,
    sequence: i64,
}

impl StagedGeneration {
    /// Owning project.
    #[must_use]
    pub const fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    /// Immutable generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Monotonic project-local sequence used to prevent stale publication.
    #[must_use]
    pub const fn sequence(&self) -> i64 {
        self.sequence
    }
}

/// Opaque token proving all required contents committed and the durable state is `ready`.
#[derive(Debug)]
pub struct ReadyGeneration {
    project_id: ProjectId,
    generation_id: GenerationId,
    sequence: i64,
    content_digest: ContentDigest,
}

impl ReadyGeneration {
    /// Owning project.
    #[must_use]
    pub const fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    /// Immutable generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Monotonic project-local sequence used to prevent stale publication.
    #[must_use]
    pub const fn sequence(&self) -> i64 {
        self.sequence
    }

    /// Deterministic digest of the complete reduced logical fact set.
    #[must_use]
    pub const fn content_digest(&self) -> &ContentDigest {
        &self.content_digest
    }
}

/// Opaque token proving the atomic publication transaction committed.
#[derive(Debug)]
pub struct CurrentGeneration {
    project_id: ProjectId,
    generation_id: GenerationId,
    sequence: i64,
    content_digest: ContentDigest,
}

/// Durable generation state observed while reconciling a timed-out mutation.
#[derive(Debug)]
pub enum ObservedGeneration {
    /// The exact generation remains writable under a valid fence.
    Staged(StagedGeneration),
    /// COPY committed and the exact generation remains publishable.
    Ready(ReadyGeneration),
    /// Publication committed and the project pointer names this generation.
    Current(CurrentGeneration),
    /// Cleanup committed and the generation is terminally failed.
    Failed,
    /// A newer generation superseded this generation.
    Superseded,
}

/// Exact lease disposition observed in the same reconciliation query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObservedLease {
    /// The same exact token is current and unexpired according to PostgreSQL.
    Owned,
    /// No operation-lease row currently exists.
    Released,
    /// The row expired or belongs to a different takeover token.
    Lost,
}

/// Single-query durable snapshot used after a client-side timeout or commit error.
#[derive(Debug)]
pub struct OperationReconciliation {
    generation: ObservedGeneration,
    lease: ObservedLease,
}

impl OperationReconciliation {
    /// Rehydrated exact generation state.
    #[must_use]
    pub const fn generation(&self) -> &ObservedGeneration {
        &self.generation
    }

    /// Consume the snapshot and recover the generation type-state token.
    #[must_use]
    pub fn into_generation(self) -> ObservedGeneration {
        self.generation
    }

    /// Exact-token lease disposition from the same database statement.
    #[must_use]
    pub const fn lease(&self) -> ObservedLease {
        self.lease
    }
}

/// Exact prepare/COPY fence paired with its PostgreSQL-side statement deadline.
///
/// Prepare authority is not terminal authority:
///
/// ```compile_fail
/// async fn work_cannot_publish(
///     database: &cartograph_db::CartographDatabase,
///     ready: cartograph_db::ReadyGeneration,
///     prepare: cartograph_db::PrepareGenerationMutation<'_>,
/// ) {
///     let _ = database.publish_generation_bounded(ready, prepare).await;
/// }
/// ```
///
/// ```compile_fail
/// async fn work_cannot_cleanup(
///     database: &cartograph_db::CartographDatabase,
///     prepare: cartograph_db::PrepareGenerationMutation<'_>,
/// ) {
///     let _ = database
///         .fail_generation_and_release_bounded(prepare)
///         .await;
/// }
/// ```
pub struct PrepareGenerationMutation<'a>(LeaseMutationOptions<'a>);

impl<'a> PrepareGenerationMutation<'a> {
    /// Bind an exact lease fence to one prepare/COPY statement deadline.
    #[must_use]
    pub const fn new(fence: &'a LeaseFence, statement_timeout: Duration) -> Self {
        Self(LeaseMutationOptions::bounded(fence, statement_timeout))
    }
}

/// Exact terminal-transition fence paired with a short database deadline.
pub struct TerminalGenerationMutation<'a>(LeaseMutationOptions<'a>);

impl<'a> TerminalGenerationMutation<'a> {
    /// Bind an exact lease fence to one publish or cleanup deadline.
    #[must_use]
    pub const fn new(fence: &'a LeaseFence, statement_timeout: Duration) -> Self {
        Self(LeaseMutationOptions::bounded(fence, statement_timeout))
    }
}

impl CurrentGeneration {
    /// Owning project.
    #[must_use]
    pub const fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    /// Immutable generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Monotonic project-local publication sequence.
    #[must_use]
    pub const fn sequence(&self) -> i64 {
        self.sequence
    }

    /// Deterministic digest of the published logical fact set.
    #[must_use]
    pub const fn content_digest(&self) -> &ContentDigest {
        &self.content_digest
    }
}

/// Opaque token proving a staging or ready generation was deliberately failed.
#[derive(Debug)]
pub struct FailedGeneration {
    project_id: ProjectId,
    generation_id: GenerationId,
    sequence: i64,
}

impl FailedGeneration {
    /// Owning project.
    #[must_use]
    pub const fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    /// Immutable generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Monotonic project-local sequence.
    #[must_use]
    pub const fn sequence(&self) -> i64 {
        self.sequence
    }
}

/// Generation states that may be resumed or deliberately failed after a
/// transient error or process restart.
#[derive(Debug)]
pub enum RecoverableGeneration {
    /// Contents may still be staged and the generation may become ready.
    Staged(StagedGeneration),
    /// Contents committed and the generation may still be published.
    Ready(ReadyGeneration),
}

/// Failed prepare operation that returns ownership of the staging token.
#[derive(Debug, Error)]
#[error("{error}")]
pub struct PrepareGenerationError {
    generation: StagedGeneration,
    #[source]
    error: StorageError,
}

impl PrepareGenerationError {
    /// Inspect the credential-safe storage error without consuming recovery state.
    #[must_use]
    pub const fn error(&self) -> &StorageError {
        &self.error
    }

    /// Recover the staging token and underlying error for retry or failure marking.
    #[must_use]
    pub fn into_parts(self) -> (StagedGeneration, StorageError) {
        (self.generation, self.error)
    }
}

/// Failed publication that returns ownership of the ready token.
#[derive(Debug, Error)]
#[error("{error}")]
pub struct PublishGenerationError {
    generation: ReadyGeneration,
    #[source]
    error: StorageError,
}

impl PublishGenerationError {
    /// Inspect the credential-safe storage error without consuming recovery state.
    #[must_use]
    pub const fn error(&self) -> &StorageError {
        &self.error
    }

    /// Recover the ready token and underlying error for retry or failure marking.
    #[must_use]
    pub fn into_parts(self) -> (ReadyGeneration, StorageError) {
        (self.generation, self.error)
    }
}

/// Failed failure-marking operation that preserves the recoverable token.
#[derive(Debug, Error)]
#[error("{error}")]
pub struct FailGenerationError {
    generation: RecoverableGeneration,
    #[source]
    error: StorageError,
}

impl FailGenerationError {
    /// Inspect the credential-safe storage error without consuming recovery state.
    #[must_use]
    pub const fn error(&self) -> &StorageError {
        &self.error
    }

    /// Recover the state token and underlying error for another checked attempt.
    #[must_use]
    pub fn into_parts(self) -> (RecoverableGeneration, StorageError) {
        (self.generation, self.error)
    }
}

/// Complete unordered worker output required before a generation can become ready.
pub struct GenerationContents {
    generation: StagedGeneration,
    facts: GenerationFacts,
    metrics: Option<PrepareGenerationMetrics>,
}

struct PrepareTransactionInput<'a> {
    schema: &'a cartograph_config::DatabaseSchema,
    generation: &'a StagedGeneration,
    facts: ValidatedGenerationFacts,
    fence: &'a LeaseFence,
    metrics: Option<&'a PrepareGenerationMetrics>,
}

/// Cloneable observer for the exact PostgreSQL COPY-stream duration.
#[derive(Clone, Default)]
pub struct PrepareGenerationMetrics {
    copy_nanos: Arc<AtomicU64>,
}

/// Point-in-time prepare metrics retained after the generation contents move.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrepareGenerationMetricsSnapshot {
    copy_duration: Duration,
}

impl PrepareGenerationMetrics {
    /// Create an empty observer for one generation preparation attempt.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the most recently observed five-table PostgreSQL COPY duration.
    #[must_use]
    pub fn snapshot(&self) -> PrepareGenerationMetricsSnapshot {
        PrepareGenerationMetricsSnapshot {
            copy_duration: Duration::from_nanos(self.copy_nanos.load(Ordering::Relaxed)),
        }
    }

    fn record_copy(&self, duration: Duration) {
        let nanos = u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX);
        self.copy_nanos.store(nanos, Ordering::Relaxed);
    }
}

impl PrepareGenerationMetricsSnapshot {
    /// Wall-clock duration spent streaming files, symbols, edges, references, and documents.
    #[must_use]
    pub const fn copy_duration(self) -> Duration {
        self.copy_duration
    }
}

struct GenerationStateRequirement<'a> {
    quoted_schema: &'a str,
    project_id: &'a ProjectId,
    generation_id: &'a GenerationId,
    sequence: i64,
    required: GenerationState,
}

struct PublishTransactionInput<'a> {
    schema: &'a cartograph_config::DatabaseSchema,
    generation: &'a ReadyGeneration,
    fence: &'a LeaseFence,
}

struct FailTransactionInput<'a> {
    schema: &'a cartograph_config::DatabaseSchema,
    fence: &'a LeaseFence,
    project_id: &'a ProjectId,
    generation_id: &'a GenerationId,
    sequence: i64,
    expected_state: GenerationState,
}

struct LeaseMutationOptions<'a> {
    fence: &'a LeaseFence,
    statement_timeout: Option<Duration>,
}

impl<'a> LeaseMutationOptions<'a> {
    const fn unbounded(fence: &'a LeaseFence) -> Self {
        Self {
            fence,
            statement_timeout: None,
        }
    }

    const fn bounded(fence: &'a LeaseFence, statement_timeout: Duration) -> Self {
        Self {
            fence,
            statement_timeout: Some(statement_timeout),
        }
    }
}

#[derive(Clone, Copy)]
enum FenceCheck {
    Observe,
    Lock,
}

struct FenceValidation<'a> {
    schema: &'a cartograph_config::DatabaseSchema,
    fence: &'a LeaseFence,
    check: FenceCheck,
}

impl GenerationContents {
    /// Consume a staging token and attach complete unordered worker facts.
    #[must_use]
    pub const fn new(generation: StagedGeneration, facts: GenerationFacts) -> Self {
        Self {
            generation,
            facts,
            metrics: None,
        }
    }

    /// Attach an observer without changing validation or persistence behavior.
    #[must_use]
    pub fn with_metrics(mut self, metrics: PrepareGenerationMetrics) -> Self {
        self.metrics = Some(metrics);
        self
    }
}

impl CartographDatabase {
    /// Create or refresh a stable project row and return its branded identity.
    pub async fn register_project(&self, input: NewProject) -> Result<ProjectId, StorageError> {
        validate_bounded_text(
            &input.root_identity,
            "root_identity",
            MAX_ROOT_IDENTITY_BYTES,
        )?;
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"INSERT INTO {schema}."projects" (root_identity, repository_fingerprint)
                VALUES ($1, $2)
                ON CONFLICT (root_identity) DO UPDATE
                SET repository_fingerprint = EXCLUDED.repository_fingerprint,
                    updated_at = clock_timestamp()
                RETURNING project_id::text"#
        );
        let row = audited_query(sql)
            .bind(input.root_identity)
            .bind(input.repository_fingerprint.as_str())
            .fetch_one(&self.pool)
            .await
            .map_err(|_| database_error("register-project"))?;
        parse_project_id(&row, 0)
    }

    /// Start an immutable generation in staging state.
    pub async fn begin_generation(
        &self,
        input: NewGeneration,
    ) -> Result<StagedGeneration, StorageError> {
        validate_bounded_text(
            &input.source_revision,
            "source_revision",
            MAX_SOURCE_REVISION_BYTES,
        )?;
        if !(1..=MAX_WORKERS).contains(&input.worker_count) {
            return Err(StorageError::InvalidInput {
                field: "worker_count",
            });
        }
        let worker_count =
            i16::try_from(input.worker_count).map_err(|_| StorageError::InvalidInput {
                field: "worker_count",
            })?;
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"WITH reserved AS (
                    UPDATE {schema}."projects"
                    SET next_generation_sequence = next_generation_sequence + 1,
                        updated_at = clock_timestamp()
                    WHERE project_id = CAST($1 AS uuid)
                    RETURNING next_generation_sequence - 1 AS generation_sequence
                )
                INSERT INTO {schema}."index_generations" (
                    project_id, generation_sequence, source_revision, worker_count
                )
                SELECT CAST($1 AS uuid), generation_sequence, $2, $3 FROM reserved
                RETURNING generation_id::text, generation_sequence"#
        );
        let row = audited_query(sql)
            .bind(input.project_id.as_str())
            .bind(input.source_revision)
            .bind(worker_count)
            .fetch_one(&self.pool)
            .await
            .map_err(|_| database_error("begin-generation"))?;
        let generation_id = parse_generation_id(&row, 0)?;
        let sequence = parse_generation_sequence(&row, 1)?;
        Ok(StagedGeneration {
            project_id: input.project_id,
            generation_id,
            sequence,
        })
    }

    /// Deterministically reduce and atomically COPY all fact tables before
    /// moving the consumed generation token to `ready`.
    pub async fn prepare_generation(
        &self,
        contents: GenerationContents,
        fence: &LeaseFence,
    ) -> Result<ReadyGeneration, PrepareGenerationError> {
        self.prepare_generation_inner(contents, LeaseMutationOptions::unbounded(fence))
            .await
    }

    /// Validate, COPY, and mark ready under a PostgreSQL-side statement deadline.
    pub async fn prepare_generation_bounded(
        &self,
        contents: GenerationContents,
        mutation: PrepareGenerationMutation<'_>,
    ) -> Result<ReadyGeneration, PrepareGenerationError> {
        self.prepare_generation_inner(contents, mutation.0).await
    }

    async fn prepare_generation_inner(
        &self,
        contents: GenerationContents,
        mutation: LeaseMutationOptions<'_>,
    ) -> Result<ReadyGeneration, PrepareGenerationError> {
        let fence = mutation.fence;
        let GenerationContents {
            generation,
            facts,
            metrics,
        } = contents;
        if !fence_matches_generation(fence, generation.project_id(), generation.generation_id()) {
            return Err(PrepareGenerationError {
                generation,
                error: StorageError::LeaseFenceLost,
            });
        }
        let facts = match validate_and_reduce(facts) {
            Ok(facts) => facts,
            Err(error) => {
                return Err(PrepareGenerationError { generation, error });
            }
        };
        let content_digest = facts.digest.clone();
        let mut transaction = match self.pool.begin().await {
            Ok(transaction) => transaction,
            Err(_) => {
                return Err(PrepareGenerationError {
                    generation,
                    error: database_error("prepare-begin"),
                });
            }
        };
        if let Some(statement_timeout) = mutation.statement_timeout
            && crate::database::set_local_statement_timeout(&mut transaction, statement_timeout)
                .await
                .is_err()
        {
            let error = match transaction.rollback().await {
                Ok(()) => database_error("prepare-statement-timeout"),
                Err(_) => database_error("prepare-rollback"),
            };
            return Err(PrepareGenerationError { generation, error });
        }
        let result = prepare_transaction(
            &mut transaction,
            PrepareTransactionInput {
                schema: &self.schema,
                generation: &generation,
                facts,
                fence,
                metrics: metrics.as_ref(),
            },
        )
        .await;
        if let Err(error) = result {
            let error = match transaction.rollback().await {
                Ok(()) => error,
                Err(_) => database_error("prepare-rollback"),
            };
            return Err(PrepareGenerationError { generation, error });
        }
        if transaction.commit().await.is_err() {
            return Err(PrepareGenerationError {
                generation,
                error: database_error("prepare-commit"),
            });
        }
        Ok(ReadyGeneration {
            project_id: generation.project_id,
            generation_id: generation.generation_id,
            sequence: generation.sequence,
            content_digest,
        })
    }

    /// Atomically supersede the previous current generation and publish the
    /// consumed ready token under a project-scoped advisory lock.
    pub async fn publish_generation(
        &self,
        generation: ReadyGeneration,
        fence: &LeaseFence,
    ) -> Result<CurrentGeneration, PublishGenerationError> {
        self.publish_generation_inner(generation, LeaseMutationOptions::unbounded(fence))
            .await
    }

    /// Publish under a PostgreSQL-side statement deadline so a dropped client
    /// future cannot leave a lock-waiting backend statement behind.
    pub async fn publish_generation_bounded(
        &self,
        generation: ReadyGeneration,
        mutation: TerminalGenerationMutation<'_>,
    ) -> Result<CurrentGeneration, PublishGenerationError> {
        self.publish_generation_inner(generation, mutation.0).await
    }

    async fn publish_generation_inner(
        &self,
        generation: ReadyGeneration,
        mutation: LeaseMutationOptions<'_>,
    ) -> Result<CurrentGeneration, PublishGenerationError> {
        let mut transaction = match self.pool.begin().await {
            Ok(transaction) => transaction,
            Err(_) => {
                return Err(PublishGenerationError {
                    generation,
                    error: database_error("publish-begin"),
                });
            }
        };
        if let Some(statement_timeout) = mutation.statement_timeout
            && crate::database::set_local_statement_timeout(&mut transaction, statement_timeout)
                .await
                .is_err()
        {
            let error = match transaction.rollback().await {
                Ok(()) => database_error("publish-statement-timeout"),
                Err(_) => database_error("publish-rollback"),
            };
            return Err(PublishGenerationError { generation, error });
        }
        let result = publish_transaction(
            &mut transaction,
            PublishTransactionInput {
                schema: &self.schema,
                generation: &generation,
                fence: mutation.fence,
            },
        )
        .await;
        if let Err(error) = result {
            let error = match transaction.rollback().await {
                Ok(()) => error,
                Err(_) => database_error("publish-rollback"),
            };
            return Err(PublishGenerationError { generation, error });
        }
        if transaction.commit().await.is_err() {
            return Err(PublishGenerationError {
                generation,
                error: database_error("publish-commit"),
            });
        }
        Ok(CurrentGeneration {
            project_id: generation.project_id,
            generation_id: generation.generation_id,
            sequence: generation.sequence,
            content_digest: generation.content_digest,
        })
    }

    /// Rehydrate a staging or ready type-state token after a process restart or
    /// an ambiguous connection failure. Published and terminal states are not
    /// recoverable through this mutation surface.
    pub async fn recover_generation(
        &self,
        project_id: &ProjectId,
        generation_id: &GenerationId,
    ) -> Result<Option<RecoverableGeneration>, StorageError> {
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"SELECT state, generation_sequence, content_digest
                FROM {schema}."index_generations"
                WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)"#
        );
        let row = audited_query(sql)
            .bind(project_id.as_str())
            .bind(generation_id.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("recover-generation"))?;
        let Some(row) = row else {
            return Ok(None);
        };
        let state = parse_generation_state(&row, 0)?;
        let sequence = parse_generation_sequence(&row, 1)?;
        let content_digest =
            row.try_get::<Option<String>, _>(2)
                .map_err(|_| StorageError::CorruptStoredValue {
                    field: "content_digest",
                })?;
        Ok(match state {
            GenerationState::Staging if content_digest.is_none() => {
                Some(RecoverableGeneration::Staged(StagedGeneration {
                    project_id: project_id.clone(),
                    generation_id: generation_id.clone(),
                    sequence,
                }))
            }
            GenerationState::Ready => {
                let content_digest = content_digest
                    .ok_or(StorageError::CorruptStoredValue {
                        field: "content_digest",
                    })
                    .and_then(|digest| {
                        ContentDigest::parse(&digest).map_err(|_| {
                            StorageError::CorruptStoredValue {
                                field: "content_digest",
                            }
                        })
                    })?;
                Some(RecoverableGeneration::Ready(ReadyGeneration {
                    project_id: project_id.clone(),
                    generation_id: generation_id.clone(),
                    sequence,
                    content_digest,
                }))
            }
            GenerationState::Staging => {
                return Err(StorageError::CorruptStoredValue {
                    field: "content_digest",
                });
            }
            GenerationState::Current | GenerationState::Superseded | GenerationState::Failed => {
                None
            }
        })
    }

    /// Mark a recovered staging or ready generation terminally failed without
    /// affecting the project's visible current generation.
    pub async fn fail_generation(
        &self,
        generation: RecoverableGeneration,
        fence: &LeaseFence,
    ) -> Result<FailedGeneration, FailGenerationError> {
        let (project_id, generation_id, sequence, expected_state) = recoverable_parts(&generation);
        if !fence_matches_generation(fence, project_id, generation_id) {
            return Err(FailGenerationError {
                generation,
                error: StorageError::LeaseFenceLost,
            });
        }
        let mut transaction = match self.pool.begin().await {
            Ok(transaction) => transaction,
            Err(_) => {
                return Err(FailGenerationError {
                    generation,
                    error: database_error("fail-begin"),
                });
            }
        };
        let result = fail_transaction(
            &mut transaction,
            FailTransactionInput {
                schema: &self.schema,
                fence,
                project_id,
                generation_id,
                sequence,
                expected_state,
            },
        )
        .await;
        if let Err(error) = result {
            let error = match transaction.rollback().await {
                Ok(()) => error,
                Err(_) => database_error("fail-rollback"),
            };
            return Err(FailGenerationError { generation, error });
        }
        if transaction.commit().await.is_err() {
            return Err(FailGenerationError {
                generation,
                error: database_error("fail-commit"),
            });
        }
        let (project_id, generation_id, sequence, _) = into_recoverable_parts(generation);
        Ok(FailedGeneration {
            project_id,
            generation_id,
            sequence,
        })
    }

    /// Atomically fail a staging/ready generation and release its exact lease.
    ///
    /// This operation is idempotent for an already-failed generation that still
    /// carries the same live token, which permits bounded timeout reconciliation.
    pub async fn fail_generation_and_release(
        &self,
        fence: &LeaseFence,
    ) -> Result<(), StorageError> {
        self.fail_generation_and_release_inner(LeaseMutationOptions::unbounded(fence))
            .await
    }

    /// Fail and release under a PostgreSQL-side statement deadline.
    pub async fn fail_generation_and_release_bounded(
        &self,
        mutation: TerminalGenerationMutation<'_>,
    ) -> Result<(), StorageError> {
        self.fail_generation_and_release_inner(mutation.0).await
    }

    async fn fail_generation_and_release_inner(
        &self,
        mutation: LeaseMutationOptions<'_>,
    ) -> Result<(), StorageError> {
        let fence = mutation.fence;
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("cleanup-begin"))?;
        if let Some(statement_timeout) = mutation.statement_timeout
            && crate::database::set_local_statement_timeout(&mut transaction, statement_timeout)
                .await
                .is_err()
        {
            return match transaction.rollback().await {
                Ok(()) => Err(database_error("cleanup-statement-timeout")),
                Err(_) => Err(database_error("cleanup-rollback")),
            };
        }
        let result = cleanup_transaction(&mut transaction, &self.schema, fence).await;
        if let Err(error) = result {
            return match transaction.rollback().await {
                Ok(()) => Err(error),
                Err(_) => Err(database_error("cleanup-rollback")),
            };
        }
        transaction
            .commit()
            .await
            .map_err(|_| database_error("cleanup-commit"))
    }

    /// Reconcile generation and exact-token lease state in one PostgreSQL statement.
    pub async fn reconcile_operation(
        &self,
        fence: &LeaseFence,
    ) -> Result<OperationReconciliation, StorageError> {
        self.reconcile_operation_inner(fence, None).await
    }

    /// Reconcile generation and lease state under a PostgreSQL statement deadline.
    pub async fn reconcile_operation_bounded(
        &self,
        fence: &LeaseFence,
        statement_timeout: Duration,
    ) -> Result<OperationReconciliation, StorageError> {
        self.reconcile_operation_inner(fence, Some(statement_timeout))
            .await
    }

    async fn reconcile_operation_inner(
        &self,
        fence: &LeaseFence,
        statement_timeout: Option<Duration>,
    ) -> Result<OperationReconciliation, StorageError> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("reconcile-operation-begin"))?;
        if let Some(statement_timeout) = statement_timeout
            && crate::database::set_local_statement_timeout(&mut transaction, statement_timeout)
                .await
                .is_err()
        {
            return match transaction.rollback().await {
                Ok(()) => Err(database_error("reconcile-operation-statement-timeout")),
                Err(_) => Err(database_error("reconcile-operation-rollback")),
            };
        }
        let result = reconcile_operation_query(&mut transaction, &self.schema, fence).await;
        let reconciliation = match result {
            Ok(reconciliation) => reconciliation,
            Err(error) => {
                return match transaction.rollback().await {
                    Ok(()) => Err(error),
                    Err(_) => Err(database_error("reconcile-operation-rollback")),
                };
            }
        };
        transaction
            .commit()
            .await
            .map_err(|_| database_error("reconcile-operation-commit"))?;
        Ok(reconciliation)
    }

    /// Read the durable state for diagnostics and invariant tests.
    pub async fn generation_state(
        &self,
        project_id: &ProjectId,
        generation_id: &GenerationId,
    ) -> Result<Option<GenerationState>, StorageError> {
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"SELECT state FROM {schema}."index_generations"
                WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)"#
        );
        let row = audited_query(sql)
            .bind(project_id.as_str())
            .bind(generation_id.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("generation-state"))?;
        row.map(|row| parse_generation_state(&row, 0)).transpose()
    }
}

async fn reconcile_operation_query(
    connection: &mut PgConnection,
    schema: &cartograph_config::DatabaseSchema,
    fence: &LeaseFence,
) -> Result<OperationReconciliation, StorageError> {
    let generation_id = fence
        .target()
        .generation_id()
        .ok_or(StorageError::InvalidInput {
            field: "generation_id",
        })?;
    let schema = crate::database::quoted_schema(schema);
    let sql = format!(
        r#"WITH database_clock AS (SELECT clock_timestamp() AS now)
                SELECT generations.state,
                       generations.generation_sequence,
                       generations.content_digest,
                       projects.current_generation_id::text,
                       leases.lease_id::text,
                       leases.expires_at > database_clock.now,
                       leases.generation_id::text
                FROM {schema}."index_generations" AS generations
                JOIN {schema}."projects" AS projects
                  ON projects.project_id = generations.project_id
                CROSS JOIN database_clock
                LEFT JOIN {schema}."project_operation_leases" AS leases
                  ON leases.project_id = generations.project_id
                 AND leases.operation = $3
                WHERE generations.project_id = CAST($1 AS uuid)
                  AND generations.generation_id = CAST($2 AS uuid)"#
    );
    let row = audited_query(sql)
        .bind(fence.target().project_id().as_str())
        .bind(generation_id.as_str())
        .bind(fence.target().operation().as_str())
        .fetch_optional(connection)
        .await
        .map_err(|_| database_error("reconcile-operation"))?
        .ok_or(StorageError::GenerationNotFound)?;
    decode_reconciliation(&row, fence)
}

async fn cleanup_transaction(
    connection: &mut PgConnection,
    schema: &cartograph_config::DatabaseSchema,
    fence: &LeaseFence,
) -> Result<(), StorageError> {
    let generation_id = fence
        .target()
        .generation_id()
        .ok_or(StorageError::InvalidInput {
            field: "generation_id",
        })?;
    lock_generation_fence(connection, schema, fence).await?;
    let quoted_schema = crate::database::quoted_schema(schema);
    let state_sql = format!(
        r#"SELECT state FROM {quoted_schema}."index_generations"
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)
            FOR UPDATE"#
    );
    let row = audited_query(state_sql)
        .bind(fence.target().project_id().as_str())
        .bind(generation_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| database_error("cleanup-generation-state"))?
        .ok_or(StorageError::GenerationNotFound)?;
    let state = parse_generation_state(&row, 0)?;
    match state {
        GenerationState::Staging | GenerationState::Ready => {
            let update_sql = format!(
                r#"UPDATE {quoted_schema}."index_generations"
                    SET state = 'failed'
                    WHERE project_id = CAST($1 AS uuid)
                      AND generation_id = CAST($2 AS uuid)
                      AND state IN ('staging', 'ready')"#
            );
            let updated = audited_query(update_sql)
                .bind(fence.target().project_id().as_str())
                .bind(generation_id.as_str())
                .execute(&mut *connection)
                .await
                .map_err(|_| database_error("cleanup-fail-generation"))?;
            if updated.rows_affected() != 1 {
                return Err(StorageError::InvalidGenerationTransition {
                    actual: "changed concurrently".to_owned(),
                    requested: GenerationState::Failed.as_str(),
                });
            }
        }
        GenerationState::Failed => {}
        GenerationState::Current | GenerationState::Superseded => {
            return Err(StorageError::InvalidGenerationTransition {
                actual: state.as_str().to_owned(),
                requested: GenerationState::Failed.as_str(),
            });
        }
    }
    delete_generation_fence(connection, &quoted_schema, fence).await
}

async fn fail_transaction(
    connection: &mut PgConnection,
    input: FailTransactionInput<'_>,
) -> Result<(), StorageError> {
    lock_generation_fence(connection, input.schema, input.fence).await?;
    let quoted_schema = crate::database::quoted_schema(input.schema);
    let sql = format!(
        r#"UPDATE {quoted_schema}."index_generations"
            SET state = 'failed'
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)
              AND generation_sequence = $3
              AND state = $4"#
    );
    let result = audited_query(sql)
        .bind(input.project_id.as_str())
        .bind(input.generation_id.as_str())
        .bind(input.sequence)
        .bind(input.expected_state.as_str())
        .execute(connection)
        .await
        .map_err(|_| database_error("fail-generation"))?;
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(StorageError::InvalidGenerationTransition {
            actual: "changed concurrently".to_owned(),
            requested: GenerationState::Failed.as_str(),
        })
    }
}

async fn prepare_transaction(
    connection: &mut PgConnection,
    input: PrepareTransactionInput<'_>,
) -> Result<(), StorageError> {
    let quoted_schema = crate::database::quoted_schema(input.schema);
    let content_digest = input.facts.digest.clone();
    validate_generation_state(
        connection,
        GenerationStateRequirement {
            quoted_schema: &quoted_schema,
            project_id: input.generation.project_id(),
            generation_id: input.generation.generation_id(),
            sequence: input.generation.sequence(),
            required: GenerationState::Staging,
        },
        FenceCheck::Observe,
    )
    .await?;
    // Establish the same operation -> generation advisory order used by
    // cleanup and publication before COPY can acquire foreign-key row locks.
    // The exact lease row remains unlocked during the bulk stream so
    // heartbeats can renew it. The non-locking check below is stable against
    // takeover because acquisition shares the operation advisory lock, and a
    // final row-locking check still runs immediately before the ready
    // transition.
    lock_generation_mutation(connection, input.schema, input.fence).await?;
    check_generation_fence(connection, input.schema, input.fence).await?;
    validate_generation_state(
        connection,
        GenerationStateRequirement {
            quoted_schema: &quoted_schema,
            project_id: input.generation.project_id(),
            generation_id: input.generation.generation_id(),
            sequence: input.generation.sequence(),
            required: GenerationState::Staging,
        },
        FenceCheck::Observe,
    )
    .await?;
    let copy_started = Instant::now();
    let copy_result = copy_generation_facts(
        connection,
        CopyGenerationContext {
            schema: input.schema.clone(),
            project_id: input.generation.project_id().clone(),
            generation_id: input.generation.generation_id().clone(),
        },
        input.facts,
    )
    .await;
    if let Some(metrics) = input.metrics {
        metrics.record_copy(copy_started.elapsed());
    }
    copy_result?;
    lock_generation_fence(connection, input.schema, input.fence).await?;
    validate_generation_state(
        connection,
        GenerationStateRequirement {
            quoted_schema: &quoted_schema,
            project_id: input.generation.project_id(),
            generation_id: input.generation.generation_id(),
            sequence: input.generation.sequence(),
            required: GenerationState::Staging,
        },
        FenceCheck::Lock,
    )
    .await?;
    let ready_sql = format!(
        r#"UPDATE {quoted_schema}."index_generations"
            SET state = 'ready', content_digest = $3, ready_at = clock_timestamp()
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)
              AND state = 'staging'"#
    );
    let result = audited_query(ready_sql)
        .bind(input.generation.project_id().as_str())
        .bind(input.generation.generation_id().as_str())
        .bind(content_digest.as_str())
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("mark-generation-ready"))?;
    if result.rows_affected() != 1 {
        return Err(StorageError::InvalidGenerationTransition {
            actual: "changed concurrently".to_owned(),
            requested: GenerationState::Ready.as_str(),
        });
    }
    Ok(())
}

async fn publish_transaction(
    connection: &mut PgConnection,
    input: PublishTransactionInput<'_>,
) -> Result<(), StorageError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "cartograph-v2-publish:{}:{}",
            input.schema.as_str(),
            input.generation.project_id()
        ))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("publish-lock"))?;
    let quoted_schema = crate::database::quoted_schema(input.schema);
    let generation = input.generation;
    let fence = input.fence;
    if !fence_matches_generation(fence, generation.project_id(), generation.generation_id()) {
        return Err(StorageError::LeaseFenceLost);
    }
    lock_generation_fence(connection, input.schema, fence).await?;
    validate_generation_state(
        connection,
        GenerationStateRequirement {
            quoted_schema: &quoted_schema,
            project_id: generation.project_id(),
            generation_id: generation.generation_id(),
            sequence: generation.sequence(),
            required: GenerationState::Ready,
        },
        FenceCheck::Lock,
    )
    .await?;

    let current_sequence =
        lock_current_generation_sequence(connection, &quoted_schema, generation.project_id())
            .await?;
    if let Some(current_sequence) = current_sequence
        && generation.sequence() <= current_sequence
    {
        return Err(StorageError::StaleGeneration {
            candidate_sequence: generation.sequence(),
            current_sequence,
        });
    }

    let supersede_sql = format!(
        r#"UPDATE {quoted_schema}."index_generations"
            SET state = 'superseded'
            WHERE project_id = CAST($1 AS uuid) AND state = 'current'"#
    );
    audited_query(supersede_sql)
        .bind(generation.project_id().as_str())
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("supersede-generation"))?;

    let publish_sql = format!(
        r#"UPDATE {quoted_schema}."index_generations"
            SET state = 'current', published_at = clock_timestamp()
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)
              AND state = 'ready'"#
    );
    let published = audited_query(publish_sql)
        .bind(generation.project_id().as_str())
        .bind(generation.generation_id().as_str())
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("publish-generation"))?;
    if published.rows_affected() != 1 {
        return Err(StorageError::InvalidGenerationTransition {
            actual: "changed concurrently".to_owned(),
            requested: GenerationState::Current.as_str(),
        });
    }

    let project_sql = format!(
        r#"UPDATE {quoted_schema}."projects"
            SET current_generation_id = CAST($2 AS uuid), updated_at = clock_timestamp()
            WHERE project_id = CAST($1 AS uuid)"#
    );
    let project = audited_query(project_sql)
        .bind(generation.project_id().as_str())
        .bind(generation.generation_id().as_str())
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("publish-project-pointer"))?;
    if project.rows_affected() != 1 {
        return Err(StorageError::GenerationNotFound);
    }
    delete_generation_fence(connection, &quoted_schema, fence).await?;
    Ok(())
}

async fn lock_generation_fence(
    connection: &mut PgConnection,
    schema: &cartograph_config::DatabaseSchema,
    fence: &LeaseFence,
) -> Result<(), StorageError> {
    lock_generation_mutation(connection, schema, fence).await?;
    require_generation_fence(
        connection,
        FenceValidation {
            schema,
            fence,
            check: FenceCheck::Lock,
        },
    )
    .await
}

async fn check_generation_fence(
    connection: &mut PgConnection,
    schema: &cartograph_config::DatabaseSchema,
    fence: &LeaseFence,
) -> Result<(), StorageError> {
    require_generation_fence(
        connection,
        FenceValidation {
            schema,
            fence,
            check: FenceCheck::Observe,
        },
    )
    .await
}

async fn require_generation_fence(
    connection: &mut PgConnection,
    input: FenceValidation<'_>,
) -> Result<(), StorageError> {
    let generation_id = input
        .fence
        .target()
        .generation_id()
        .ok_or(StorageError::LeaseFenceLost)?;
    let quoted_schema = crate::database::quoted_schema(input.schema);
    let row_lock = match input.check {
        FenceCheck::Observe => "",
        FenceCheck::Lock => " FOR UPDATE",
    };
    let sql = format!(
        r#"SELECT 1 FROM {quoted_schema}."project_operation_leases"
            WHERE project_id = CAST($1 AS uuid)
              AND operation = $2
              AND lease_id = CAST($3 AS uuid)
              AND generation_id = CAST($4 AS uuid)
              AND expires_at > clock_timestamp(){row_lock}"#
    );
    let row = audited_query(sql)
        .bind(input.fence.target().project_id().as_str())
        .bind(input.fence.target().operation().as_str())
        .bind(input.fence.lease_id().as_str())
        .bind(generation_id.as_str())
        .fetch_optional(connection)
        .await
        .map_err(|_| {
            database_error(match input.check {
                FenceCheck::Observe => "check-generation-fence",
                FenceCheck::Lock => "lock-generation-fence",
            })
        })?;
    if row.is_some() {
        Ok(())
    } else {
        Err(StorageError::LeaseFenceLost)
    }
}

async fn lock_generation_mutation(
    connection: &mut PgConnection,
    schema: &cartograph_config::DatabaseSchema,
    fence: &LeaseFence,
) -> Result<(), StorageError> {
    let generation_id = fence
        .target()
        .generation_id()
        .ok_or(StorageError::LeaseFenceLost)?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(operation_lock_key(schema, fence.target()))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("lock-generation-operation"))?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{GENERATION_LOCK_NAMESPACE}:{}:{}:{}",
            schema.as_str(),
            fence.target().project_id(),
            generation_id
        ))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("lock-generation-identity"))?;
    Ok(())
}

async fn delete_generation_fence(
    connection: &mut PgConnection,
    quoted_schema: &str,
    fence: &LeaseFence,
) -> Result<(), StorageError> {
    let sql = format!(
        r#"DELETE FROM {quoted_schema}."project_operation_leases"
            WHERE project_id = CAST($1 AS uuid)
              AND operation = $2
              AND lease_id = CAST($3 AS uuid)"#
    );
    let deleted = audited_query(sql)
        .bind(fence.target().project_id().as_str())
        .bind(fence.target().operation().as_str())
        .bind(fence.lease_id().as_str())
        .execute(connection)
        .await
        .map_err(|_| database_error("delete-generation-fence"))?;
    if deleted.rows_affected() == 1 {
        Ok(())
    } else {
        Err(StorageError::LeaseFenceLost)
    }
}

fn fence_matches_generation(
    fence: &LeaseFence,
    project_id: &ProjectId,
    generation_id: &GenerationId,
) -> bool {
    fence.target().project_id() == project_id
        && fence.target().generation_id() == Some(generation_id)
}

fn decode_reconciliation(
    row: &PgRow,
    fence: &LeaseFence,
) -> Result<OperationReconciliation, StorageError> {
    let project_id = fence.target().project_id().clone();
    let generation_id = fence
        .target()
        .generation_id()
        .ok_or(StorageError::LeaseFenceLost)?
        .clone();
    let expected_generation_id = generation_id.as_str().to_owned();
    let state = parse_generation_state(row, RECONCILE_STATE_COLUMN)?;
    let sequence = parse_generation_sequence(row, RECONCILE_SEQUENCE_COLUMN)?;
    let raw_digest = row
        .try_get::<Option<String>, _>(RECONCILE_DIGEST_COLUMN)
        .map_err(|_| corrupt("content_digest"))?;
    let content_digest = raw_digest
        .map(|raw| ContentDigest::parse(&raw).map_err(|_| corrupt("content_digest")))
        .transpose()?;
    let generation = match state {
        GenerationState::Staging => {
            if content_digest.is_some() {
                return Err(corrupt("content_digest"));
            }
            ObservedGeneration::Staged(StagedGeneration {
                project_id,
                generation_id,
                sequence,
            })
        }
        GenerationState::Ready => ObservedGeneration::Ready(ReadyGeneration {
            project_id,
            generation_id,
            sequence,
            content_digest: content_digest.ok_or_else(|| corrupt("content_digest"))?,
        }),
        GenerationState::Current => {
            let current = row
                .try_get::<Option<String>, _>(RECONCILE_CURRENT_COLUMN)
                .map_err(|_| corrupt("current_generation_id"))?;
            if current.as_deref() != Some(generation_id.as_str()) {
                return Err(corrupt("current_generation_id"));
            }
            ObservedGeneration::Current(CurrentGeneration {
                project_id,
                generation_id,
                sequence,
                content_digest: content_digest.ok_or_else(|| corrupt("content_digest"))?,
            })
        }
        GenerationState::Failed => ObservedGeneration::Failed,
        GenerationState::Superseded => ObservedGeneration::Superseded,
    };
    let raw_lease_id = row
        .try_get::<Option<String>, _>(RECONCILE_LEASE_ID_COLUMN)
        .map_err(|_| corrupt("lease_id"))?;
    let lease = match raw_lease_id {
        None => ObservedLease::Released,
        Some(raw_lease_id) => {
            let lease_id = cartograph_domain::LeaseId::parse(&raw_lease_id)
                .map_err(|_| corrupt("lease_id"))?;
            let unexpired = row
                .try_get::<Option<bool>, _>(RECONCILE_LEASE_UNEXPIRED_COLUMN)
                .map_err(|_| corrupt("lease_expiry"))?
                .unwrap_or(false);
            let lease_generation = row
                .try_get::<Option<String>, _>(RECONCILE_LEASE_GENERATION_COLUMN)
                .map_err(|_| corrupt("lease_generation_id"))?;
            if lease_id == *fence.lease_id()
                && unexpired
                && lease_generation.as_deref() == Some(expected_generation_id.as_str())
            {
                ObservedLease::Owned
            } else {
                ObservedLease::Lost
            }
        }
    };
    Ok(OperationReconciliation { generation, lease })
}

async fn lock_current_generation_sequence(
    connection: &mut PgConnection,
    quoted_schema: &str,
    project_id: &ProjectId,
) -> Result<Option<i64>, StorageError> {
    let sql = format!(
        r#"SELECT generations.generation_sequence
            FROM {quoted_schema}."projects" AS projects
            LEFT JOIN {quoted_schema}."index_generations" AS generations
              ON generations.project_id = projects.project_id
             AND generations.generation_id = projects.current_generation_id
            WHERE projects.project_id = CAST($1 AS uuid)
            FOR UPDATE OF projects"#
    );
    let row = audited_query(sql)
        .bind(project_id.as_str())
        .fetch_optional(connection)
        .await
        .map_err(|_| database_error("lock-current-generation"))?
        .ok_or(StorageError::GenerationNotFound)?;
    row.try_get::<Option<i64>, _>(0)
        .map_err(|_| StorageError::CorruptStoredValue {
            field: "generation_sequence",
        })
}

async fn validate_generation_state(
    connection: &mut PgConnection,
    requirement: GenerationStateRequirement<'_>,
    check: FenceCheck,
) -> Result<(), StorageError> {
    let (lock_clause, operation) = match check {
        FenceCheck::Observe => ("", "check-generation"),
        FenceCheck::Lock => (" FOR UPDATE", "lock-generation"),
    };
    let sql = format!(
        r#"SELECT state, generation_sequence FROM {schema}."index_generations"
            WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid){lock_clause}"#,
        schema = requirement.quoted_schema,
    );
    let row = audited_query(sql)
        .bind(requirement.project_id.as_str())
        .bind(requirement.generation_id.as_str())
        .fetch_optional(connection)
        .await
        .map_err(|_| database_error(operation))?
        .ok_or(StorageError::GenerationNotFound)?;
    validate_generation_state_row(&row, requirement)
}

fn validate_generation_state_row(
    row: &PgRow,
    requirement: GenerationStateRequirement<'_>,
) -> Result<(), StorageError> {
    let actual = row
        .try_get::<String, _>(0)
        .map_err(|_| StorageError::CorruptStoredValue { field: "state" })?;
    let sequence = parse_generation_sequence(row, 1)?;
    if sequence != requirement.sequence {
        return Err(StorageError::CorruptStoredValue {
            field: "generation_sequence",
        });
    }
    if actual != requirement.required.as_str() {
        return Err(StorageError::InvalidGenerationTransition {
            actual,
            requested: requirement.required.as_str(),
        });
    }
    Ok(())
}

fn recoverable_parts(
    generation: &RecoverableGeneration,
) -> (&ProjectId, &GenerationId, i64, GenerationState) {
    match generation {
        RecoverableGeneration::Staged(generation) => (
            generation.project_id(),
            generation.generation_id(),
            generation.sequence(),
            GenerationState::Staging,
        ),
        RecoverableGeneration::Ready(generation) => (
            generation.project_id(),
            generation.generation_id(),
            generation.sequence(),
            GenerationState::Ready,
        ),
    }
}

fn into_recoverable_parts(
    generation: RecoverableGeneration,
) -> (ProjectId, GenerationId, i64, GenerationState) {
    match generation {
        RecoverableGeneration::Staged(generation) => (
            generation.project_id,
            generation.generation_id,
            generation.sequence,
            GenerationState::Staging,
        ),
        RecoverableGeneration::Ready(generation) => (
            generation.project_id,
            generation.generation_id,
            generation.sequence,
            GenerationState::Ready,
        ),
    }
}

fn validate_bounded_text(
    value: &str,
    field: &'static str,
    maximum: usize,
) -> Result<(), StorageError> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(StorageError::InvalidInput { field });
    }
    Ok(())
}

fn parse_project_id(row: &sqlx_postgres::PgRow, index: usize) -> Result<ProjectId, StorageError> {
    let raw = row
        .try_get::<String, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue {
            field: "project_id",
        })?;
    ProjectId::parse(&raw).map_err(|_| StorageError::CorruptStoredValue {
        field: "project_id",
    })
}

fn parse_generation_id(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<GenerationId, StorageError> {
    let raw = row
        .try_get::<String, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue {
            field: "generation_id",
        })?;
    GenerationId::parse(&raw).map_err(|_| StorageError::CorruptStoredValue {
        field: "generation_id",
    })
}

fn parse_generation_sequence(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<i64, StorageError> {
    let sequence = row
        .try_get::<i64, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue {
            field: "generation_sequence",
        })?;
    if sequence <= 0 {
        return Err(StorageError::CorruptStoredValue {
            field: "generation_sequence",
        });
    }
    Ok(sequence)
}

fn parse_generation_state(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<GenerationState, StorageError> {
    let raw = row
        .try_get::<String, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "state" })?;
    match raw.as_str() {
        "staging" => Ok(GenerationState::Staging),
        "ready" => Ok(GenerationState::Ready),
        "current" => Ok(GenerationState::Current),
        "superseded" => Ok(GenerationState::Superseded),
        "failed" => Ok(GenerationState::Failed),
        _ => Err(StorageError::CorruptStoredValue { field: "state" }),
    }
}

fn audited_query(
    sql: String,
) -> sqlx_core::query::Query<'static, sqlx_postgres::Postgres, sqlx_postgres::PgArguments> {
    // Dynamic content is limited to a DatabaseSchema that has passed the
    // conservative identifier validator and is always double-quoted.
    query(AssertSqlSafe(sql))
}

const fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

const fn corrupt(field: &'static str) -> StorageError {
    StorageError::CorruptStoredValue { field }
}
