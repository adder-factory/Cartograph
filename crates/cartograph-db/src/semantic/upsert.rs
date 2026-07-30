use std::collections::BTreeMap;

use cartograph_domain::{ContentDigest, DocumentId};
use futures_util::TryStreamExt;
use sqlx_core::{query::query, sql_str::AssertSqlSafe};

use crate::CartographDatabase;

use super::{
    common::{
        BoundedSemanticOperation, ModelLookup, TransactionCompletion, decode_document_source,
        execute_bounded, load_model, lock_current_generation, require_active_selector,
        require_generation, validate_normalization, vector_text,
    },
    types::{
        EmbeddingBatchUpsertReport, EmbeddingBatchUpsertRequest, MAXIMUM_PENDING_BYTES,
        SemanticStorageError, database_error,
    },
};

impl CartographDatabase {
    /// Revalidate exact current document text and atomically upsert one bounded vector batch.
    /// # Errors
    ///
    /// Returns an error if model/generation/source digests no longer match, a
    /// document is missing, or the bounded vector batch cannot commit atomically.
    pub async fn upsert_current_document_embeddings(
        &self,
        request: EmbeddingBatchUpsertRequest,
    ) -> Result<EmbeddingBatchUpsertReport, SemanticStorageError> {
        execute_bounded(EmbeddingUpsertOperation {
            database: self,
            request: &request,
        })
        .await
    }
}

struct EmbeddingUpsertOperation<'a> {
    database: &'a CartographDatabase,
    request: &'a EmbeddingBatchUpsertRequest,
}

impl BoundedSemanticOperation for EmbeddingUpsertOperation<'_> {
    type Output = EmbeddingBatchUpsertReport;

    const BEGIN_OPERATION: &'static str = "upsert-embeddings-begin";
    const COMPLETION: TransactionCompletion =
        TransactionCompletion::new("upsert-embeddings-commit", "upsert-embeddings-rollback");

    fn database(&self) -> &CartographDatabase {
        self.database
    }

    fn statement_timeout(&self) -> std::time::Duration {
        self.request.statement_timeout
    }

    fn execute<'connection>(
        &'connection self,
        connection: &'connection mut sqlx_postgres::PgConnection,
    ) -> impl std::future::Future<Output = Result<Self::Output, SemanticStorageError>> + 'connection
    {
        upsert_transaction(connection, self.database, self.request)
    }
}

async fn upsert_transaction(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &EmbeddingBatchUpsertRequest,
) -> Result<EmbeddingBatchUpsertReport, SemanticStorageError> {
    let model = load_model(
        connection,
        ModelLookup::new(&database.schema, request.model.model_id()).for_update(),
    )
    .await?
    .ok_or(SemanticStorageError::ModelNotFound)?;
    let model = require_active_selector(model, &request.model)?;
    for row in &request.rows {
        validate_normalization(&row.vector, model.normalization)?;
    }
    let current =
        lock_current_generation(connection, &database.schema, &request.project_id).await?;
    require_generation(&current, &request.generation_id)?;
    let sources = load_source_digests(connection, database, request).await?;
    for row in &request.rows {
        let source = sources
            .get(&row.document_id)
            .ok_or(SemanticStorageError::DocumentNotFound)?;
        if source != &row.source_digest {
            return Err(SemanticStorageError::SourceDigestChanged);
        }
    }
    let mut written = 0_u16;
    for row in &request.rows {
        written = written
            .checked_add(
                write_embedding(
                    connection,
                    EmbeddingWriteInput {
                        database,
                        request,
                        row,
                    },
                )
                .await?,
            )
            .ok_or_else(|| database_error("upsert-embeddings-count"))?;
    }
    let requested =
        u16::try_from(request.rows.len()).map_err(|_| database_error("upsert-embeddings-count"))?;
    Ok(EmbeddingBatchUpsertReport { requested, written })
}

async fn load_source_digests(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &EmbeddingBatchUpsertRequest,
) -> Result<BTreeMap<DocumentId, ContentDigest>, SemanticStorageError> {
    let ids = request
        .rows
        .iter()
        .map(|row| row.document_id.as_str().to_owned())
        .collect::<Vec<_>>();
    let schema = crate::database::quoted_schema(&database.schema);
    let sql = format!(
        r#"SELECT documents.id, documents.document_id::text, documents.path,
                  documents.language, documents.document_kind, documents.qualified_name,
                  documents.code, documents.natural_text,
                  COALESCE(summaries.body, '') AS summary
            FROM {schema}."search_documents" AS documents
            LEFT JOIN {schema}."symbols" AS symbols
              ON symbols.project_id = documents.project_id
             AND symbols.generation_id = documents.generation_id
             AND symbols.symbol_id = documents.symbol_id
            LEFT JOIN {schema}."agent_artifacts" AS summaries
              ON summaries.project_id = documents.project_id
             AND summaries.artifact_kind = 'summary'
             AND summaries.state = 'complete'
             AND summaries.generation_id = documents.generation_id
             AND COALESCE(summaries.metadata ->> 'model', '') NOT LIKE 'neighbor:%'
             AND (
                 (symbols.symbol_kind <> 'file'
                  AND summaries.scope_kind = 'symbol'
                  AND summaries.scope_key = documents.symbol_id::text
                  AND summaries.source_digest = symbols.structural_digest)
                 OR
                 (symbols.symbol_kind = 'file'
                  AND summaries.scope_kind = 'file'
                  AND summaries.scope_key = documents.path)
             )
            WHERE documents.project_id = CAST($1 AS uuid)
              AND documents.generation_id = CAST($2 AS uuid)
              AND documents.document_id = ANY(CAST($3 AS uuid[]))
            ORDER BY documents.document_id"#
    );
    let mut rows = query(AssertSqlSafe(sql))
        .bind(request.project_id.as_str())
        .bind(request.generation_id.as_str())
        .bind(ids)
        .fetch(&mut *connection);
    let mut sources = BTreeMap::new();
    let mut retained_bytes = 0_u64;
    while let Some(row) = rows
        .try_next()
        .await
        .map_err(|_| database_error("upsert-embeddings-source-read"))?
    {
        let source = decode_document_source(&row)?;
        retained_bytes = retained_bytes
            .checked_add(source.encoded_length()?)
            .ok_or_else(|| database_error("upsert-embeddings-source-bytes"))?;
        if retained_bytes > MAXIMUM_PENDING_BYTES {
            return Err(SemanticStorageError::DocumentTooLarge);
        }
        let document_id = source.document_id.clone();
        let (_, digest) = source.render()?;
        if sources.insert(document_id, digest).is_some() {
            return Err(SemanticStorageError::CorruptStoredValue {
                field: "document_id",
            });
        }
    }
    drop(rows);
    if sources.len() == request.rows.len() {
        Ok(sources)
    } else {
        Err(SemanticStorageError::DocumentNotFound)
    }
}

struct EmbeddingWriteInput<'a> {
    database: &'a CartographDatabase,
    request: &'a EmbeddingBatchUpsertRequest,
    row: &'a super::types::EmbeddingUpsertRow,
}

async fn write_embedding(
    connection: &mut sqlx_postgres::PgConnection,
    input: EmbeddingWriteInput<'_>,
) -> Result<u16, SemanticStorageError> {
    let schema = crate::database::quoted_schema(&input.database.schema);
    let sql = format!(
        r#"INSERT INTO {schema}."document_embeddings" AS existing (
                project_id, generation_id, document_id, model_id, source_digest, embedding
            ) VALUES (
                CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid),
                CAST($4 AS uuid), $5, CAST($6 AS vector)
            )
            ON CONFLICT (project_id, generation_id, document_id, model_id)
            DO UPDATE SET
                source_digest = EXCLUDED.source_digest,
                embedding = EXCLUDED.embedding,
                updated_at = clock_timestamp()
            WHERE existing.source_digest IS DISTINCT FROM EXCLUDED.source_digest
               OR existing.embedding IS DISTINCT FROM EXCLUDED.embedding"#
    );
    let result = query(AssertSqlSafe(sql))
        .bind(input.request.project_id.as_str())
        .bind(input.request.generation_id.as_str())
        .bind(input.row.document_id.as_str())
        .bind(input.request.model.model_id().as_str())
        .bind(input.row.source_digest.as_str())
        .bind(vector_text(&input.row.vector)?)
        .execute(connection)
        .await
        .map_err(|_| database_error("upsert-embedding-row"))?;
    u16::try_from(result.rows_affected())
        .ok()
        .filter(|count| *count <= 1)
        .ok_or_else(|| database_error("upsert-embedding-row-count"))
}
