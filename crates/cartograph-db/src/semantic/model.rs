use cartograph_domain::{GenerationId, ProjectId};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::CartographDatabase;

use super::{
    common::{
        ModelLookup, begin_bounded, corrupt, load_model, read_string, require_active_selector,
        require_selector, rollback_error,
    },
    hnsw::read_hnsw_status,
    readiness::{ReadinessTarget, query_probe},
    types::{
        EmbeddingModelRegistration, EmbeddingModelState, RegisteredEmbeddingModel,
        RetireEmbeddingModelRequest, SemanticStorageError, database_error,
    },
};

const MODEL_REGISTRY_LOCK_NAMESPACE: &str = "cartograph-v2-embedding-model-registry";

impl CartographDatabase {
    /// Register immutable non-secret model metadata, or return the exact idempotent row.
    pub async fn register_embedding_model(
        &self,
        registration: EmbeddingModelRegistration,
        statement_timeout: std::time::Duration,
    ) -> Result<RegisteredEmbeddingModel, SemanticStorageError> {
        super::types::validate_timeout(statement_timeout)?;
        let mut transaction =
            begin_bounded(self, statement_timeout, "register-model-begin").await?;
        let result = register_model_transaction(&mut transaction, self, &registration).await;
        match result {
            Ok(model) => {
                transaction
                    .commit()
                    .await
                    .map_err(|_| database_error("register-model-commit"))?;
                Ok(model)
            }
            Err(error) => Err(rollback_error(transaction, error, "register-model-rollback").await),
        }
    }

    /// Retire one model only after every current old-model project has a ready replacement.
    pub async fn retire_embedding_model(
        &self,
        request: RetireEmbeddingModelRequest,
    ) -> Result<RegisteredEmbeddingModel, SemanticStorageError> {
        let mut transaction =
            begin_bounded(self, request.statement_timeout, "retire-model-begin").await?;
        let result = retire_model_transaction(&mut transaction, self, &request).await;
        let model = match result {
            Ok(model) => model,
            Err(error) => {
                return Err(rollback_error(transaction, error, "retire-model-rollback").await);
            }
        };
        transaction
            .commit()
            .await
            .map_err(|_| database_error("retire-model-commit"))?;
        Ok(model)
    }
}

async fn register_model_transaction(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    registration: &EmbeddingModelRegistration,
) -> Result<RegisteredEmbeddingModel, SemanticStorageError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{MODEL_REGISTRY_LOCK_NAMESPACE}:{}",
            database.schema.as_str()
        ))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("register-model-lock"))?;
    let schema = crate::database::quoted_schema(&database.schema);
    let insert = format!(
        r#"INSERT INTO {schema}."embedding_models" (
                model_id, fingerprint, provider, model_name, dimension, normalization
            ) VALUES (CAST($1 AS uuid), $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING"#
    );
    query(AssertSqlSafe(insert))
        .bind(registration.model_id().as_str())
        .bind(registration.fingerprint().as_str())
        .bind(registration.provider())
        .bind(registration.model_name())
        .bind(i32::from(registration.dimension()))
        .bind(registration.normalization().as_str())
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("register-model-insert"))?;
    let model = load_model(
        connection,
        ModelLookup::new(&database.schema, registration.model_id()).for_update(),
    )
    .await?
    .ok_or(SemanticStorageError::ModelConflict)?;
    if model.selector != registration.selector()
        || model.provider != registration.provider()
        || model.model_name != registration.model_name()
        || model.normalization != registration.normalization()
    {
        return Err(SemanticStorageError::ModelConflict);
    }
    Ok(model)
}

async fn retire_model_transaction(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &RetireEmbeddingModelRequest,
) -> Result<RegisteredEmbeddingModel, SemanticStorageError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{MODEL_REGISTRY_LOCK_NAMESPACE}:{}",
            database.schema.as_str()
        ))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("retire-model-lock"))?;
    let retiring = load_model(
        connection,
        ModelLookup::new(&database.schema, request.retiring.model_id()).for_update(),
    )
    .await?
    .ok_or(SemanticStorageError::ModelNotFound)?;
    let mut retiring = require_selector(retiring, &request.retiring)?;
    if retiring.state == EmbeddingModelState::Retired {
        return Ok(retiring);
    }
    let replacement = load_model(
        connection,
        ModelLookup::new(&database.schema, request.replacement.model_id()).for_update(),
    )
    .await?
    .ok_or(SemanticStorageError::ModelNotFound)?;
    require_active_selector(replacement, &request.replacement)?;
    if !read_hnsw_status(connection, &database.schema, &request.replacement)
        .await?
        .ready
    {
        return Err(SemanticStorageError::ReplacementNotReady);
    }
    lock_project_publications(connection, database).await?;
    let affected = replacement_coverage(connection, database, request).await?;
    if affected.incomplete > 0
        || (affected.projects > 0
            && !probe_replacement(connection, database, &request.replacement).await?)
    {
        return Err(SemanticStorageError::ReplacementNotReady);
    }
    let schema = crate::database::quoted_schema(&database.schema);
    let update = format!(
        r#"UPDATE {schema}."embedding_models"
            SET state = 'retired', retired_at = clock_timestamp()
            WHERE model_id = CAST($1 AS uuid) AND state = 'active'"#
    );
    let changed = query(AssertSqlSafe(update))
        .bind(request.retiring.model_id().as_str())
        .execute(connection)
        .await
        .map_err(|_| database_error("retire-model-update"))?;
    if changed.rows_affected() != 1 {
        return Err(database_error("retire-model-update-count"));
    }
    retiring.state = EmbeddingModelState::Retired;
    Ok(retiring)
}

struct ReplacementCoverage {
    projects: u64,
    incomplete: u64,
}

async fn lock_project_publications(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
) -> Result<(), SemanticStorageError> {
    let schema = crate::database::quoted_schema(&database.schema);
    let sql = format!(r#"LOCK TABLE {schema}."projects" IN SHARE MODE"#);
    query(AssertSqlSafe(sql))
        .execute(connection)
        .await
        .map(|_| ())
        .map_err(|_| database_error("retire-model-project-lock"))
}

async fn replacement_coverage(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &RetireEmbeddingModelRequest,
) -> Result<ReplacementCoverage, SemanticStorageError> {
    let schema = crate::database::quoted_schema(&database.schema);
    let sql = format!(
        r#"WITH affected AS (
                SELECT projects.project_id, projects.current_generation_id AS generation_id
                FROM {schema}."projects" AS projects
                WHERE projects.current_generation_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM {schema}."document_embeddings" AS old_embeddings
                    WHERE old_embeddings.project_id = projects.project_id
                      AND old_embeddings.generation_id = projects.current_generation_id
                      AND old_embeddings.model_id = CAST($1 AS uuid)
                  )
            ), coverage AS (
                SELECT affected.project_id,
                       count(documents.document_id)::bigint AS documents,
                       count(replacement.document_id)::bigint AS embedded
                FROM affected
                INNER JOIN {schema}."search_documents" AS documents
                  ON documents.project_id = affected.project_id
                 AND documents.generation_id = affected.generation_id
                LEFT JOIN {schema}."document_embeddings" AS replacement
                  ON replacement.project_id = documents.project_id
                 AND replacement.generation_id = documents.generation_id
                 AND replacement.document_id = documents.document_id
                 AND replacement.model_id = CAST($2 AS uuid)
                GROUP BY affected.project_id
            )
            SELECT count(*)::bigint AS projects,
                   count(*) FILTER (
                       WHERE documents = 0 OR embedded <> documents
                   )::bigint AS incomplete
            FROM coverage"#
    );
    let row = query(AssertSqlSafe(sql))
        .bind(request.retiring.model_id().as_str())
        .bind(request.replacement.model_id().as_str())
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("retire-model-coverage"))?;
    Ok(ReplacementCoverage {
        projects: read_count(&row, "projects")?,
        incomplete: read_count(&row, "incomplete")?,
    })
}

async fn probe_replacement(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    replacement: &super::types::EmbeddingModelSelector,
) -> Result<bool, SemanticStorageError> {
    let schema = crate::database::quoted_schema(&database.schema);
    let sql = format!(
        r#"SELECT embeddings.project_id::text, embeddings.generation_id::text
            FROM {schema}."document_embeddings" AS embeddings
            INNER JOIN {schema}."projects" AS projects
              ON projects.project_id = embeddings.project_id
             AND projects.current_generation_id = embeddings.generation_id
            WHERE embeddings.model_id = CAST($1 AS uuid)
            ORDER BY embeddings.project_id
            LIMIT 1"#
    );
    let Some(row) = query(AssertSqlSafe(sql))
        .bind(replacement.model_id().as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| database_error("retire-model-probe-target"))?
    else {
        return Ok(false);
    };
    let project =
        ProjectId::parse(&read_string(&row, "project_id")?).map_err(|_| corrupt("project_id"))?;
    let generation = GenerationId::parse(&read_string(&row, "generation_id")?)
        .map_err(|_| corrupt("generation_id"))?;
    query_probe(
        connection,
        ReadinessTarget::new(&database.schema, &project, replacement).with_generation(&generation),
    )
    .await
}

fn read_count(
    row: &sqlx_postgres::PgRow,
    column: &'static str,
) -> Result<u64, SemanticStorageError> {
    let value = row.try_get::<i64, _>(column).map_err(|_| corrupt(column))?;
    u64::try_from(value).map_err(|_| corrupt(column))
}
