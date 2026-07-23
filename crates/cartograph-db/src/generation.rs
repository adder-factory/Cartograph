use cartograph_domain::{
    ContentDigest, DocumentId, DocumentKind, FileId, GenerationId, GenerationState, ProjectId,
    SymbolId,
};
use serde_json::Value;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::PgConnection;
use thiserror::Error;

use crate::{CartographDatabase, StorageError};

const MAX_ROOT_IDENTITY_BYTES: usize = 4_096;
const MAX_SOURCE_REVISION_BYTES: usize = 1_024;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_LANGUAGE_BYTES: usize = 64;
const MAX_QUALIFIED_NAME_BYTES: usize = 2_048;
const MAX_CODE_BYTES: usize = 8 * 1_024 * 1_024;
const MAX_NATURAL_TEXT_BYTES: usize = 1_024 * 1_024;
const MAX_METADATA_BYTES: usize = 64 * 1_024;
const MAX_WORKERS: u16 = 256;

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

/// Search document staged as part of one immutable generation.
#[derive(Clone, Debug)]
pub struct SearchDocumentInput {
    /// Stable logical identity, independent of ParadeDB's bigint key field.
    pub document_id: DocumentId,
    /// Owning file when the structural file row is available.
    pub file_id: Option<FileId>,
    /// Owning symbol for symbol-level evidence.
    pub symbol_id: Option<SymbolId>,
    /// Project-normalized source path.
    pub path: String,
    /// Normalized language identifier.
    pub language: String,
    /// Intent-routing document category.
    pub kind: DocumentKind,
    /// Code-aware symbol or declaration name.
    pub qualified_name: String,
    /// Source text indexed with `pdb.source_code`.
    pub code: String,
    /// Documentation and summaries indexed as natural language.
    pub natural_text: String,
    /// Bounded structured ranking/filter metadata.
    pub metadata: Value,
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
}

/// Opaque token proving the atomic publication transaction committed.
#[derive(Debug)]
pub struct CurrentGeneration {
    project_id: ProjectId,
    generation_id: GenerationId,
    sequence: i64,
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

/// Complete first-slice contents required before a generation can become ready.
pub struct GenerationContents {
    generation: StagedGeneration,
    content_digest: ContentDigest,
    documents: Vec<SearchDocumentInput>,
}

struct PrepareTransactionInput<'a> {
    schema: &'a cartograph_config::DatabaseSchema,
    contents: &'a GenerationContents,
    metadata: &'a [String],
}

struct GenerationStateRequirement<'a> {
    quoted_schema: &'a str,
    project_id: &'a ProjectId,
    generation_id: &'a GenerationId,
    sequence: i64,
    required: GenerationState,
}

impl GenerationContents {
    /// Consume a staging token and attach the deterministic logical digest and
    /// complete search-document batch.
    #[must_use]
    pub fn new(
        generation: StagedGeneration,
        content_digest: ContentDigest,
        documents: Vec<SearchDocumentInput>,
    ) -> Self {
        Self {
            generation,
            content_digest,
            documents,
        }
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

    /// Atomically stage all search documents and move the consumed generation
    /// token to `ready`. Any insert failure rolls back the entire batch.
    pub async fn prepare_generation(
        &self,
        contents: GenerationContents,
    ) -> Result<ReadyGeneration, PrepareGenerationError> {
        let metadata = match contents
            .documents
            .iter()
            .map(validate_search_document)
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(metadata) => metadata,
            Err(error) => {
                return Err(PrepareGenerationError {
                    generation: contents.generation,
                    error,
                });
            }
        };
        let mut transaction = match self.pool.begin().await {
            Ok(transaction) => transaction,
            Err(_) => {
                return Err(PrepareGenerationError {
                    generation: contents.generation,
                    error: database_error("prepare-begin"),
                });
            }
        };
        let result = prepare_transaction(
            &mut transaction,
            PrepareTransactionInput {
                schema: &self.schema,
                contents: &contents,
                metadata: &metadata,
            },
        )
        .await;
        if let Err(error) = result {
            let error = match transaction.rollback().await {
                Ok(()) => error,
                Err(_) => database_error("prepare-rollback"),
            };
            return Err(PrepareGenerationError {
                generation: contents.generation,
                error,
            });
        }
        if transaction.commit().await.is_err() {
            return Err(PrepareGenerationError {
                generation: contents.generation,
                error: database_error("prepare-commit"),
            });
        }
        Ok(ReadyGeneration {
            project_id: contents.generation.project_id,
            generation_id: contents.generation.generation_id,
            sequence: contents.generation.sequence,
        })
    }

    /// Atomically supersede the previous current generation and publish the
    /// consumed ready token under a project-scoped advisory lock.
    pub async fn publish_generation(
        &self,
        generation: ReadyGeneration,
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
        let result = publish_transaction(&mut transaction, &self.schema, &generation).await;
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
            r#"SELECT state, generation_sequence FROM {schema}."index_generations"
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
        Ok(match state {
            GenerationState::Staging => Some(RecoverableGeneration::Staged(StagedGeneration {
                project_id: project_id.clone(),
                generation_id: generation_id.clone(),
                sequence,
            })),
            GenerationState::Ready => Some(RecoverableGeneration::Ready(ReadyGeneration {
                project_id: project_id.clone(),
                generation_id: generation_id.clone(),
                sequence,
            })),
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
    ) -> Result<FailedGeneration, FailGenerationError> {
        let (project_id, generation_id, sequence, expected_state) = recoverable_parts(&generation);
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"UPDATE {schema}."index_generations"
                SET state = 'failed'
                WHERE project_id = CAST($1 AS uuid)
                  AND generation_id = CAST($2 AS uuid)
                  AND generation_sequence = $3
                  AND state = $4"#
        );
        let result = audited_query(sql)
            .bind(project_id.as_str())
            .bind(generation_id.as_str())
            .bind(sequence)
            .bind(expected_state.as_str())
            .execute(&self.pool)
            .await;
        let result = match result {
            Ok(result) => result,
            Err(_) => {
                return Err(FailGenerationError {
                    generation,
                    error: database_error("fail-generation"),
                });
            }
        };
        if result.rows_affected() != 1 {
            return Err(FailGenerationError {
                generation,
                error: StorageError::InvalidGenerationTransition {
                    actual: "changed concurrently".to_owned(),
                    requested: GenerationState::Failed.as_str(),
                },
            });
        }
        let (project_id, generation_id, sequence, _) = into_recoverable_parts(generation);
        Ok(FailedGeneration {
            project_id,
            generation_id,
            sequence,
        })
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

async fn prepare_transaction(
    connection: &mut PgConnection,
    input: PrepareTransactionInput<'_>,
) -> Result<(), StorageError> {
    let quoted_schema = crate::database::quoted_schema(input.schema);
    require_generation_state(
        connection,
        GenerationStateRequirement {
            quoted_schema: &quoted_schema,
            project_id: input.contents.generation.project_id(),
            generation_id: input.contents.generation.generation_id(),
            sequence: input.contents.generation.sequence(),
            required: GenerationState::Staging,
        },
    )
    .await?;
    let insert_sql = format!(
        r#"INSERT INTO {quoted_schema}."search_documents" (
            project_id, generation_id, document_id, file_id, symbol_id, path, language,
            document_kind, qualified_name, code, natural_text, metadata
        ) VALUES (
            CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
            CAST($5 AS uuid), $6, $7, $8, $9, $10, $11, CAST($12 AS jsonb)
        )"#
    );
    for (document, encoded_metadata) in input.contents.documents.iter().zip(input.metadata) {
        audited_query(insert_sql.clone())
            .bind(input.contents.generation.project_id().as_str())
            .bind(input.contents.generation.generation_id().as_str())
            .bind(document.document_id.as_str())
            .bind(document.file_id.as_ref().map(FileId::as_str))
            .bind(document.symbol_id.as_ref().map(SymbolId::as_str))
            .bind(&document.path)
            .bind(&document.language)
            .bind(document.kind.as_str())
            .bind(&document.qualified_name)
            .bind(&document.code)
            .bind(&document.natural_text)
            .bind(encoded_metadata)
            .execute(&mut *connection)
            .await
            .map_err(|_| database_error("stage-search-document"))?;
    }
    let ready_sql = format!(
        r#"UPDATE {quoted_schema}."index_generations"
            SET state = 'ready', content_digest = $3, ready_at = clock_timestamp()
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)
              AND state = 'staging'"#
    );
    let result = audited_query(ready_sql)
        .bind(input.contents.generation.project_id().as_str())
        .bind(input.contents.generation.generation_id().as_str())
        .bind(input.contents.content_digest.as_str())
        .execute(connection)
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
    schema: &cartograph_config::DatabaseSchema,
    generation: &ReadyGeneration,
) -> Result<(), StorageError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("cartograph-v2-publish:{}", generation.project_id()))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("publish-lock"))?;
    let quoted_schema = crate::database::quoted_schema(schema);
    require_generation_state(
        connection,
        GenerationStateRequirement {
            quoted_schema: &quoted_schema,
            project_id: generation.project_id(),
            generation_id: generation.generation_id(),
            sequence: generation.sequence(),
            required: GenerationState::Ready,
        },
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
        .execute(connection)
        .await
        .map_err(|_| database_error("publish-project-pointer"))?;
    if project.rows_affected() != 1 {
        return Err(StorageError::GenerationNotFound);
    }
    Ok(())
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

async fn require_generation_state(
    connection: &mut PgConnection,
    requirement: GenerationStateRequirement<'_>,
) -> Result<(), StorageError> {
    let sql = format!(
        r#"SELECT state, generation_sequence FROM {schema}."index_generations"
            WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)
            FOR UPDATE"#,
        schema = requirement.quoted_schema,
    );
    let row = audited_query(sql)
        .bind(requirement.project_id.as_str())
        .bind(requirement.generation_id.as_str())
        .fetch_optional(connection)
        .await
        .map_err(|_| database_error("lock-generation"))?
        .ok_or(StorageError::GenerationNotFound)?;
    let actual = row
        .try_get::<String, _>(0)
        .map_err(|_| StorageError::CorruptStoredValue { field: "state" })?;
    let sequence = parse_generation_sequence(&row, 1)?;
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

fn validate_search_document(document: &SearchDocumentInput) -> Result<String, StorageError> {
    validate_bounded_text(&document.path, "path", MAX_PATH_BYTES)?;
    validate_bounded_text(&document.language, "language", MAX_LANGUAGE_BYTES)?;
    validate_optional_text(
        &document.qualified_name,
        "qualified_name",
        MAX_QUALIFIED_NAME_BYTES,
    )?;
    validate_optional_text(&document.code, "code", MAX_CODE_BYTES)?;
    validate_optional_text(
        &document.natural_text,
        "natural_text",
        MAX_NATURAL_TEXT_BYTES,
    )?;
    if document.qualified_name.is_empty()
        && document.code.is_empty()
        && document.natural_text.is_empty()
    {
        return Err(StorageError::InvalidInput {
            field: "searchable_text",
        });
    }
    if !document.metadata.is_object() {
        return Err(StorageError::InvalidInput { field: "metadata" });
    }
    let encoded = serde_json::to_string(&document.metadata)
        .map_err(|_| StorageError::InvalidInput { field: "metadata" })?;
    if encoded.len() > MAX_METADATA_BYTES || encoded.contains('\0') {
        return Err(StorageError::InvalidInput { field: "metadata" });
    }
    Ok(encoded)
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

fn validate_optional_text(
    value: &str,
    field: &'static str,
    maximum: usize,
) -> Result<(), StorageError> {
    if value.len() > maximum || value.contains('\0') {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> SearchDocumentInput {
        let document_id = match DocumentId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
            Ok(id) => id,
            Err(error) => panic!("fixture UUID is invalid: {error}"),
        };
        SearchDocumentInput {
            document_id,
            file_id: None,
            symbol_id: None,
            path: "src/lib.rs".to_owned(),
            language: "rust".to_owned(),
            kind: DocumentKind::Symbol,
            qualified_name: "parseRequest".to_owned(),
            code: "fn parse_request() {}".to_owned(),
            natural_text: String::new(),
            metadata: serde_json::json!({}),
        }
    }

    #[test]
    fn search_document_validation_blocks_unbounded_and_non_object_payloads() {
        let mut input = document();
        input.metadata = serde_json::json!(["not", "an", "object"]);
        assert_eq!(
            validate_search_document(&input),
            Err(StorageError::InvalidInput { field: "metadata" })
        );

        let mut input = document();
        input.code = "x".repeat(MAX_CODE_BYTES + 1);
        assert_eq!(
            validate_search_document(&input),
            Err(StorageError::InvalidInput { field: "code" })
        );
    }

    #[test]
    fn empty_search_documents_are_rejected_before_postgres() {
        let mut input = document();
        input.qualified_name.clear();
        input.code.clear();
        input.natural_text.clear();
        assert_eq!(
            validate_search_document(&input),
            Err(StorageError::InvalidInput {
                field: "searchable_text"
            })
        );
    }
}
