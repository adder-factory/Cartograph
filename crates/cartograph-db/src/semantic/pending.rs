use futures_util::TryStreamExt;
use sqlx_core::{query::query, sql_str::AssertSqlSafe};

use crate::CartographDatabase;

use super::{
    common::{
        BoundedSemanticOperation, ModelLookup, TransactionCompletion, decode_document_source,
        execute_bounded, load_model, lock_current_generation, require_active_selector,
    },
    types::{
        EmbeddingPageCursor, PendingEmbeddingDocument, PendingEmbeddingPage,
        PendingEmbeddingPageRequest, SemanticStorageError, database_error,
    },
};

impl CartographDatabase {
    /// Page current-generation documents missing one exact active model vector.
    /// # Errors
    ///
    /// Returns an error if the model/generation/cursor is stale or missing, or
    /// bounded pending text cannot be queried/decoded within document/byte caps.
    pub async fn pending_current_embedding_documents(
        &self,
        request: PendingEmbeddingPageRequest,
    ) -> Result<PendingEmbeddingPage, SemanticStorageError> {
        execute_bounded(PendingPageOperation {
            database: self,
            request: &request,
        })
        .await
    }
}

struct PendingPageOperation<'a> {
    database: &'a CartographDatabase,
    request: &'a PendingEmbeddingPageRequest,
}

impl BoundedSemanticOperation for PendingPageOperation<'_> {
    type Output = PendingEmbeddingPage;

    const BEGIN_OPERATION: &'static str = "pending-embeddings-begin";
    const COMPLETION: TransactionCompletion =
        TransactionCompletion::new("pending-embeddings-commit", "pending-embeddings-rollback");

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
        pending_page_transaction(connection, self.database, self.request)
    }
}

async fn pending_page_transaction(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &PendingEmbeddingPageRequest,
) -> Result<PendingEmbeddingPage, SemanticStorageError> {
    let plan = prepare_pending_page(connection, database, request).await?;
    read_pending_page(
        connection,
        PendingPageQuery {
            database,
            request,
            plan,
        },
    )
    .await
}

struct PendingPagePlan {
    generation: cartograph_domain::GenerationId,
    after: i64,
    maximum_rows: i64,
}

struct PendingPageQuery<'a> {
    database: &'a CartographDatabase,
    request: &'a PendingEmbeddingPageRequest,
    plan: PendingPagePlan,
}

struct PendingPageAccumulator {
    documents: Vec<PendingEmbeddingDocument>,
    retained_bytes: u64,
    maximum_documents: usize,
    maximum_source_bytes: u64,
    has_more: bool,
}

impl PendingPageAccumulator {
    fn new(request: &PendingEmbeddingPageRequest) -> Result<Self, SemanticStorageError> {
        let mut documents = Vec::new();
        documents
            .try_reserve(usize::from(request.maximum_documents))
            .map_err(|_| database_error("pending-embeddings-reserve"))?;
        Ok(Self {
            documents,
            retained_bytes: 0,
            maximum_documents: usize::from(request.maximum_documents),
            maximum_source_bytes: request.maximum_source_bytes,
            has_more: false,
        })
    }

    fn admit(&mut self, row: &sqlx_postgres::PgRow) -> Result<bool, SemanticStorageError> {
        if self.documents.len() == self.maximum_documents {
            self.has_more = true;
            return Ok(false);
        }
        let source = decode_document_source(row)?;
        let row_id = source.row_id;
        let document_id = source.document_id.clone();
        let path = source.path.clone();
        let (text, source_digest) = source.render()?;
        let text_bytes =
            u64::try_from(text.len()).map_err(|_| database_error("pending-embeddings-bytes"))?;
        let next_bytes = self
            .retained_bytes
            .checked_add(text_bytes)
            .ok_or_else(|| database_error("pending-embeddings-bytes"))?;
        if next_bytes > self.maximum_source_bytes {
            if self.documents.is_empty() {
                return Err(SemanticStorageError::DocumentTooLarge);
            }
            self.has_more = true;
            return Ok(false);
        }
        self.retained_bytes = next_bytes;
        self.documents.push(PendingEmbeddingDocument {
            row_id,
            document_id,
            path,
            text,
            source_digest,
        });
        Ok(true)
    }

    fn finish(self, generation: cartograph_domain::GenerationId) -> PendingEmbeddingPage {
        let next_cursor = if self.has_more {
            self.documents.last().map(|document| EmbeddingPageCursor {
                generation_id: generation.clone(),
                after_row_id: document.row_id,
            })
        } else {
            None
        };
        PendingEmbeddingPage {
            generation_id: generation,
            documents: self.documents,
            next_cursor,
        }
    }
}

async fn prepare_pending_page(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &PendingEmbeddingPageRequest,
) -> Result<PendingPagePlan, SemanticStorageError> {
    let model = load_model(
        connection,
        ModelLookup::new(&database.schema, request.model.model_id()),
    )
    .await?
    .ok_or(SemanticStorageError::ModelNotFound)?;
    require_active_selector(model, &request.model)?;
    let generation =
        lock_current_generation(connection, &database.schema, &request.project_id).await?;
    if request
        .cursor
        .as_ref()
        .is_some_and(|cursor| cursor.generation_id != generation)
    {
        return Err(SemanticStorageError::CurrentGenerationChanged);
    }
    let after = request
        .cursor
        .as_ref()
        .map_or(0, |cursor| cursor.after_row_id);
    let after = i64::try_from(after).map_err(|_| super::types::invalid("cursor"))?;
    Ok(PendingPagePlan {
        generation,
        after,
        maximum_rows: i64::from(request.maximum_documents) + 1,
    })
}

async fn read_pending_page(
    connection: &mut sqlx_postgres::PgConnection,
    query_input: PendingPageQuery<'_>,
) -> Result<PendingEmbeddingPage, SemanticStorageError> {
    let schema = crate::database::quoted_schema(&query_input.database.schema);
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
            LEFT JOIN {schema}."document_embeddings" AS embeddings
              ON embeddings.project_id = documents.project_id
             AND embeddings.generation_id = documents.generation_id
             AND embeddings.document_id = documents.document_id
             AND embeddings.model_id = CAST($4 AS uuid)
            WHERE documents.project_id = CAST($1 AS uuid)
              AND documents.generation_id = CAST($2 AS uuid)
              AND documents.id > $3
              AND embeddings.document_id IS NULL
            ORDER BY documents.id
            LIMIT $5"#
    );
    let mut rows = query(AssertSqlSafe(sql))
        .bind(query_input.request.project_id.as_str())
        .bind(query_input.plan.generation.as_str())
        .bind(query_input.plan.after)
        .bind(query_input.request.model.model_id().as_str())
        .bind(query_input.plan.maximum_rows)
        .fetch(&mut *connection);
    let mut accumulator = PendingPageAccumulator::new(query_input.request)?;
    while let Some(row) = rows
        .try_next()
        .await
        .map_err(|_| database_error("pending-embeddings-read"))?
    {
        if !accumulator.admit(&row)? {
            break;
        }
    }
    drop(rows);
    Ok(accumulator.finish(query_input.plan.generation))
}
