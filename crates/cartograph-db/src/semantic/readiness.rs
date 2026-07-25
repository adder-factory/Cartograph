use cartograph_config::DatabaseSchema;
use cartograph_domain::{GenerationId, ProjectId};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::PgConnection;

use crate::CartographDatabase;

use super::{
    common::{
        ModelLookup, begin_bounded, configure_filtered_hnsw_scan, load_model,
        lock_optional_current_generation, read_string, rollback_error,
    },
    hnsw::read_hnsw_status,
    types::{
        EmbeddingModelSelector, EmbeddingModelState, SemanticReadinessReport,
        SemanticReadinessRequest, SemanticReadinessState, SemanticStorageError, database_error,
    },
};

impl CartographDatabase {
    /// Prove exact model identity, current coverage, HNSW shape, and live query execution.
    pub async fn semantic_readiness(
        &self,
        request: SemanticReadinessRequest,
    ) -> Result<SemanticReadinessReport, SemanticStorageError> {
        let mut transaction =
            begin_bounded(self, request.statement_timeout, "semantic-readiness-begin").await?;
        let result = evaluate_readiness(
            &mut transaction,
            ReadinessTarget::new(&self.schema, &request.project_id, &request.model),
        )
        .await;
        match result {
            Ok(report) => {
                transaction
                    .commit()
                    .await
                    .map_err(|_| database_error("semantic-readiness-commit"))?;
                Ok(report)
            }
            Err(error) => {
                Err(rollback_error(transaction, error, "semantic-readiness-rollback").await)
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct ReadinessTarget<'a> {
    schema: &'a DatabaseSchema,
    project_id: &'a ProjectId,
    selector: &'a EmbeddingModelSelector,
}

impl<'a> ReadinessTarget<'a> {
    pub(crate) const fn new(
        schema: &'a DatabaseSchema,
        project_id: &'a ProjectId,
        selector: &'a EmbeddingModelSelector,
    ) -> Self {
        Self {
            schema,
            project_id,
            selector,
        }
    }

    pub(crate) const fn with_generation(
        self,
        generation_id: &'a GenerationId,
    ) -> CurrentReadinessTarget<'a> {
        CurrentReadinessTarget {
            schema: self.schema,
            project_id: self.project_id,
            generation_id,
            selector: self.selector,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct CurrentReadinessTarget<'a> {
    schema: &'a DatabaseSchema,
    project_id: &'a ProjectId,
    generation_id: &'a GenerationId,
    selector: &'a EmbeddingModelSelector,
}

struct ReadinessEvidence {
    model_state: EmbeddingModelState,
    documents: u64,
    embedded: u64,
    hnsw_ready: bool,
    query_probe_ready: bool,
}

pub(crate) async fn evaluate_readiness(
    connection: &mut PgConnection,
    target: ReadinessTarget<'_>,
) -> Result<SemanticReadinessReport, SemanticStorageError> {
    let model = load_model(
        connection,
        ModelLookup::new(target.schema, target.selector.model_id()),
    )
    .await?;
    let Some(model) = model else {
        return Ok(empty_report(
            target.selector,
            SemanticReadinessState::ModelMissing,
        ));
    };
    if model.selector != *target.selector {
        return Ok(empty_report(
            target.selector,
            SemanticReadinessState::ModelMismatch,
        ));
    }
    let generation =
        lock_optional_current_generation(connection, target.schema, target.project_id).await?;
    let Some(generation) = generation else {
        return Ok(empty_report(
            target.selector,
            SemanticReadinessState::NoCurrentGeneration,
        ));
    };
    let current = target.with_generation(&generation);
    let (documents, embedded) = coverage_counts(connection, current).await?;
    let hnsw_ready = read_hnsw_status(connection, target.schema, target.selector)
        .await?
        .ready;
    let query_probe_ready = if model.state == EmbeddingModelState::Active
        && documents > 0
        && documents == embedded
        && hnsw_ready
    {
        query_probe(connection, current).await?
    } else {
        false
    };
    let state = readiness_state(ReadinessEvidence {
        model_state: model.state,
        documents,
        embedded,
        hnsw_ready,
        query_probe_ready,
    });
    Ok(SemanticReadinessReport {
        model_id: target.selector.model_id().clone(),
        generation_id: Some(generation),
        documents,
        embedded,
        hnsw_ready,
        query_probe_ready,
        state,
    })
}

async fn coverage_counts(
    connection: &mut PgConnection,
    target: CurrentReadinessTarget<'_>,
) -> Result<(u64, u64), SemanticStorageError> {
    let quoted = crate::database::quoted_schema(target.schema);
    let sql = format!(
        r#"SELECT count(*)::bigint AS documents,
                  count(embeddings.document_id)::bigint AS embedded
            FROM {quoted}."search_documents" AS documents
            LEFT JOIN {quoted}."document_embeddings" AS embeddings
              ON embeddings.project_id = documents.project_id
             AND embeddings.generation_id = documents.generation_id
             AND embeddings.document_id = documents.document_id
             AND embeddings.model_id = CAST($3 AS uuid)
            WHERE documents.project_id = CAST($1 AS uuid)
              AND documents.generation_id = CAST($2 AS uuid)"#
    );
    let row = query(AssertSqlSafe(sql))
        .bind(target.project_id.as_str())
        .bind(target.generation_id.as_str())
        .bind(target.selector.model_id().as_str())
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("semantic-coverage"))?;
    Ok((
        read_count(&row, "documents")?,
        read_count(&row, "embedded")?,
    ))
}

pub(crate) async fn query_probe(
    connection: &mut PgConnection,
    target: CurrentReadinessTarget<'_>,
) -> Result<bool, SemanticStorageError> {
    configure_filtered_hnsw_scan(connection).await?;
    let quoted = crate::database::quoted_schema(target.schema);
    let vector_sql = format!(
        r#"SELECT embedding::text AS embedding
            FROM {quoted}."document_embeddings"
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)
              AND model_id = CAST($3 AS uuid)
            ORDER BY document_id
            LIMIT 1"#
    );
    let Some(row) = query(AssertSqlSafe(vector_sql))
        .bind(target.project_id.as_str())
        .bind(target.generation_id.as_str())
        .bind(target.selector.model_id().as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| database_error("semantic-probe-vector"))?
    else {
        return Ok(false);
    };
    let vector = read_string(&row, "embedding")?;
    query("SAVEPOINT cartograph_semantic_probe")
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("semantic-probe-savepoint"))?;
    let probe = probe_query(connection, target, &vector).await;
    match probe {
        Ok(ready) => {
            query("RELEASE SAVEPOINT cartograph_semantic_probe")
                .execute(connection)
                .await
                .map_err(|_| database_error("semantic-probe-release"))?;
            Ok(ready)
        }
        Err(_) => {
            query("ROLLBACK TO SAVEPOINT cartograph_semantic_probe")
                .execute(&mut *connection)
                .await
                .map_err(|_| database_error("semantic-probe-rollback"))?;
            query("RELEASE SAVEPOINT cartograph_semantic_probe")
                .execute(connection)
                .await
                .map_err(|_| database_error("semantic-probe-release"))?;
            Ok(false)
        }
    }
}

async fn probe_query(
    connection: &mut PgConnection,
    target: CurrentReadinessTarget<'_>,
    vector: &str,
) -> Result<bool, ()> {
    let quoted = crate::database::quoted_schema(target.schema);
    let model_id = target.selector.model_id().as_str();
    let dimension = target.selector.dimension();
    let sql = format!(
        r#"SELECT document_id
            FROM {quoted}."document_embeddings"
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)
              AND model_id = '{model_id}'::uuid
            ORDER BY embedding::vector({dimension}) <=> CAST($3 AS vector({dimension}))
            LIMIT 1"#
    );
    query(AssertSqlSafe(sql))
        .bind(target.project_id.as_str())
        .bind(target.generation_id.as_str())
        .bind(vector)
        .fetch_optional(connection)
        .await
        .map(|row| row.is_some())
        .map_err(|_| ())
}

fn readiness_state(evidence: ReadinessEvidence) -> SemanticReadinessState {
    [
        (
            evidence.model_state == EmbeddingModelState::Retired,
            SemanticReadinessState::ModelRetired,
        ),
        (evidence.documents == 0, SemanticReadinessState::NoDocuments),
        (
            evidence.embedded != evidence.documents,
            SemanticReadinessState::CoverageIncomplete,
        ),
        (
            !evidence.hnsw_ready,
            SemanticReadinessState::HnswUnavailable,
        ),
        (
            !evidence.query_probe_ready,
            SemanticReadinessState::QueryProbeFailed,
        ),
    ]
    .into_iter()
    .find_map(|(applies, state)| applies.then_some(state))
    .unwrap_or(SemanticReadinessState::Ready)
}

fn empty_report(
    selector: &EmbeddingModelSelector,
    state: SemanticReadinessState,
) -> SemanticReadinessReport {
    SemanticReadinessReport {
        model_id: selector.model_id().clone(),
        generation_id: None,
        documents: 0,
        embedded: 0,
        hnsw_ready: false,
        query_probe_ready: false,
        state,
    }
}

fn read_count(
    row: &sqlx_postgres::PgRow,
    column: &'static str,
) -> Result<u64, SemanticStorageError> {
    let value = row
        .try_get::<i64, _>(column)
        .map_err(|_| SemanticStorageError::CorruptStoredValue { field: column })?;
    u64::try_from(value).map_err(|_| SemanticStorageError::CorruptStoredValue { field: column })
}
