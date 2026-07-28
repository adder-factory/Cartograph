use cartograph_domain::ModelId;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::CartographDatabase;

use super::{
    common::{
        ModelLookup, begin_bounded, configure_filtered_hnsw_scan, load_model,
        lock_current_generation, read_string, rollback_error,
    },
    readiness::{ReadinessTarget, evaluate_readiness},
    search::decode_hit,
    types::{
        EmbeddingModelSelector, EmbeddingModelState, RegisteredEmbeddingModel,
        SemanticReadinessState, SemanticStorageError, SimilarSymbolHit, SimilarSymbolsRequest,
        SimilarSymbolsResult, SimilarSymbolsResultInput, database_error,
    },
};

impl CartographDatabase {
    /// Find current symbol neighbors from the source symbol's stored pgvector embedding.
    pub async fn similar_current_symbols(
        &self,
        request: SimilarSymbolsRequest,
    ) -> Result<SimilarSymbolsResult, SemanticStorageError> {
        let mut transaction =
            begin_bounded(self, request.statement_timeout, "similar-symbols-begin").await?;
        let result = similar_symbols_transaction(&mut transaction, self, &request).await;
        match result {
            Ok(value) => {
                transaction
                    .commit()
                    .await
                    .map_err(|_| database_error("similar-symbols-commit"))?;
                Ok(value)
            }
            Err(error) => Err(rollback_error(transaction, error, "similar-symbols-rollback").await),
        }
    }
}

struct SimilarQueryContext<'value> {
    database: &'value CartographDatabase,
    request: &'value SimilarSymbolsRequest,
    model: &'value EmbeddingModelSelector,
}

async fn similar_symbols_transaction(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &SimilarSymbolsRequest,
) -> Result<SimilarSymbolsResult, SemanticStorageError> {
    let current =
        lock_current_generation(connection, &database.schema, &request.project_id).await?;
    if current != request.expected_generation_id {
        return Err(SemanticStorageError::CurrentGenerationChanged);
    }
    let model = resolve_model(connection, database, request).await?;
    let readiness = evaluate_readiness(
        connection,
        ReadinessTarget::new(&database.schema, &request.project_id, model.selector()),
    )
    .await?;
    if readiness.state() != SemanticReadinessState::Ready {
        return Err(SemanticStorageError::NotReady {
            state: readiness.state(),
        });
    }
    let generation = readiness
        .generation_id()
        .ok_or(SemanticStorageError::CurrentGenerationUnavailable)?;
    if generation != &request.expected_generation_id {
        return Err(SemanticStorageError::CurrentGenerationChanged);
    }
    let query = SimilarQueryContext {
        database,
        request,
        model: model.selector(),
    };
    if !request.same_language
        && let Some(mut hits) = query_materialized_neighbors(connection, &query).await?
    {
        let truncated = hits.len() > usize::from(request.limit);
        hits.truncate(usize::from(request.limit));
        return Ok(SimilarSymbolsResult::new(SimilarSymbolsResultInput {
            model: model.selector().clone(),
            source_symbol_id: request.source_symbol_id.clone(),
            hits,
            truncated,
        }));
    }
    let source = read_source_vector(connection, &query).await?;
    configure_filtered_hnsw_scan(connection).await?;
    let mut hits = query_neighbors(connection, &query, &source).await?;
    let truncated = hits.len() > usize::from(request.limit);
    hits.truncate(usize::from(request.limit));
    Ok(SimilarSymbolsResult::new(SimilarSymbolsResultInput {
        model: model.selector().clone(),
        source_symbol_id: request.source_symbol_id.clone(),
        hits,
        truncated,
    }))
}

/// Read a materialized Top-K only when its build contract is strong enough for
/// this request and still covers every currently embedded symbol for the model.
/// Language-filtered calls deliberately fall back to live pgvector because a
/// global Top-K cache cannot prove it retained the next same-language neighbor.
async fn query_materialized_neighbors(
    connection: &mut sqlx_postgres::PgConnection,
    context: &SimilarQueryContext<'_>,
) -> Result<Option<Vec<SimilarSymbolHit>>, SemanticStorageError> {
    let SimilarQueryContext {
        database,
        request,
        model,
    } = context;
    let fetch_limit = request
        .limit
        .checked_add(1)
        .ok_or(SemanticStorageError::InvalidInput {
            field: "similar_symbols",
        })?;
    let schema = crate::database::quoted_schema(&database.schema);
    let eligibility_sql = format!(
        r#"SELECT 1
            FROM {schema}."symbol_similarity_builds" AS builds
            WHERE builds.project_id = CAST($1 AS uuid)
              AND builds.generation_id = CAST($2 AS uuid)
              AND builds.model_id = CAST($3 AS uuid)
              AND builds.neighbors_per_symbol >= $4
              AND builds.minimum_score <= $5
              AND builds.source_symbols = (
                  SELECT count(DISTINCT documents.symbol_id)::bigint
                  FROM {schema}."search_documents" AS documents
                  INNER JOIN {schema}."document_embeddings" AS embeddings
                    ON embeddings.project_id = documents.project_id
                   AND embeddings.generation_id = documents.generation_id
                   AND embeddings.document_id = documents.document_id
                   AND embeddings.model_id = CAST($3 AS uuid)
                  WHERE documents.project_id = CAST($1 AS uuid)
                    AND documents.generation_id = CAST($2 AS uuid)
                    AND documents.document_kind = 'symbol'
                    AND documents.symbol_id IS NOT NULL
              )"#
    );
    if query(AssertSqlSafe(eligibility_sql))
        .bind(request.project_id.as_str())
        .bind(request.expected_generation_id.as_str())
        .bind(model.model_id().as_str())
        .bind(
            i16::try_from(fetch_limit).map_err(|_| SemanticStorageError::InvalidInput {
                field: "similar_symbols",
            })?,
        )
        .bind(request.minimum_score)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| database_error("similar-symbols-cache-eligibility"))?
        .is_none()
    {
        return Ok(None);
    }
    let sql = format!(
        r#"SELECT documents.generation_id::text, documents.document_id::text,
                   documents.file_id::text, documents.symbol_id::text,
                   documents.path, documents.language, documents.document_kind,
                   documents.qualified_name,
                   (1.0 - edges.score)::float8 AS distance,
                   edges.score
            FROM {schema}."symbol_similarity_edges" AS edges
            INNER JOIN {schema}."search_documents" AS documents
              ON documents.project_id = edges.project_id
             AND documents.generation_id = edges.generation_id
             AND documents.symbol_id = edges.target_symbol_id
             AND documents.document_kind = 'symbol'
            WHERE edges.project_id = CAST($1 AS uuid)
              AND edges.generation_id = CAST($2 AS uuid)
              AND edges.model_id = CAST($3 AS uuid)
              AND edges.source_symbol_id = CAST($4 AS uuid)
              AND edges.score >= $5
            ORDER BY edges.neighbor_rank, edges.target_symbol_id
            LIMIT $6"#
    );
    let rows = query(AssertSqlSafe(sql))
        .bind(request.project_id.as_str())
        .bind(request.expected_generation_id.as_str())
        .bind(model.model_id().as_str())
        .bind(request.source_symbol_id.as_str())
        .bind(request.minimum_score)
        .bind(i64::from(fetch_limit))
        .fetch_all(connection)
        .await
        .map_err(|_| database_error("similar-symbols-cache-query"))?;
    rows.iter()
        .map(|row| {
            let score = row
                .try_get::<f64, _>("score")
                .map_err(|_| SemanticStorageError::CorruptStoredValue { field: "score" })?;
            if !score.is_finite() || !(0.0..=1.0).contains(&score) {
                return Err(SemanticStorageError::CorruptStoredValue { field: "score" });
            }
            Ok(SimilarSymbolHit::new(decode_hit(row)?, score))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

async fn resolve_model(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &SimilarSymbolsRequest,
) -> Result<RegisteredEmbeddingModel, SemanticStorageError> {
    let model_id = match &request.model_id {
        Some(model_id) => model_id.clone(),
        None => select_unique_source_model(connection, database, request).await?,
    };
    let model = load_model(connection, ModelLookup::new(&database.schema, &model_id))
        .await?
        .ok_or(SemanticStorageError::ModelNotFound)?;
    if model.state() == EmbeddingModelState::Retired {
        Err(SemanticStorageError::ModelRetired)
    } else {
        Ok(model)
    }
}

async fn select_unique_source_model(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &SimilarSymbolsRequest,
) -> Result<ModelId, SemanticStorageError> {
    let schema = crate::database::quoted_schema(&database.schema);
    let sql = format!(
        r#"SELECT DISTINCT embeddings.model_id::text AS model_id
            FROM {schema}."search_documents" AS documents
            INNER JOIN {schema}."document_embeddings" AS embeddings
              ON embeddings.project_id = documents.project_id
             AND embeddings.generation_id = documents.generation_id
             AND embeddings.document_id = documents.document_id
            INNER JOIN {schema}."embedding_models" AS models
              ON models.model_id = embeddings.model_id
            WHERE documents.project_id = CAST($1 AS uuid)
              AND documents.generation_id = CAST($2 AS uuid)
              AND documents.symbol_id = CAST($3 AS uuid)
              AND models.state = 'active'
            ORDER BY model_id
            LIMIT 2"#
    );
    let rows = query(AssertSqlSafe(sql))
        .bind(request.project_id.as_str())
        .bind(request.expected_generation_id.as_str())
        .bind(request.source_symbol_id.as_str())
        .fetch_all(connection)
        .await
        .map_err(|_| database_error("similar-symbols-models"))?;
    match rows.as_slice() {
        [] => Err(SemanticStorageError::SourceEmbeddingUnavailable),
        [row] => ModelId::parse(&read_string(row, "model_id")?)
            .map_err(|_| SemanticStorageError::CorruptStoredValue { field: "model_id" }),
        _ => Err(SemanticStorageError::AmbiguousActiveModels),
    }
}

struct SourceVector {
    document_id: String,
    language: String,
    vector: String,
}

async fn read_source_vector(
    connection: &mut sqlx_postgres::PgConnection,
    context: &SimilarQueryContext<'_>,
) -> Result<SourceVector, SemanticStorageError> {
    let SimilarQueryContext {
        database,
        request,
        model,
    } = context;
    let schema = crate::database::quoted_schema(&database.schema);
    let sql = format!(
        r#"SELECT documents.document_id::text AS document_id,
                  documents.language, embeddings.embedding::text AS embedding
            FROM {schema}."search_documents" AS documents
            INNER JOIN {schema}."document_embeddings" AS embeddings
              ON embeddings.project_id = documents.project_id
             AND embeddings.generation_id = documents.generation_id
             AND embeddings.document_id = documents.document_id
            WHERE documents.project_id = CAST($1 AS uuid)
              AND documents.generation_id = CAST($2 AS uuid)
              AND documents.symbol_id = CAST($3 AS uuid)
              AND embeddings.model_id = CAST($4 AS uuid)
            ORDER BY documents.id
            LIMIT 2"#
    );
    let rows = query(AssertSqlSafe(sql))
        .bind(request.project_id.as_str())
        .bind(request.expected_generation_id.as_str())
        .bind(request.source_symbol_id.as_str())
        .bind(model.model_id().as_str())
        .fetch_all(connection)
        .await
        .map_err(|_| database_error("similar-symbols-source"))?;
    let [row] = rows.as_slice() else {
        return if rows.is_empty() {
            Err(SemanticStorageError::SourceEmbeddingUnavailable)
        } else {
            Err(SemanticStorageError::CorruptStoredValue {
                field: "source_symbol_document",
            })
        };
    };
    Ok(SourceVector {
        document_id: read_string(row, "document_id")?,
        language: read_string(row, "language")?,
        vector: read_string(row, "embedding")?,
    })
}

async fn query_neighbors(
    connection: &mut sqlx_postgres::PgConnection,
    context: &SimilarQueryContext<'_>,
    source: &SourceVector,
) -> Result<Vec<SimilarSymbolHit>, SemanticStorageError> {
    let SimilarQueryContext {
        database,
        request,
        model,
    } = context;
    let schema = crate::database::quoted_schema(&database.schema);
    let dimension = model.dimension();
    let model_id = model.model_id().as_str();
    let sql = format!(
        r#"WITH nearest AS MATERIALIZED (
                SELECT embeddings.project_id, embeddings.generation_id,
                       embeddings.document_id,
                       (embeddings.embedding::vector({dimension})
                           <=> CAST($4 AS vector({dimension})))::float8 AS distance
                FROM {schema}."document_embeddings" AS embeddings
                WHERE embeddings.project_id = CAST($1 AS uuid)
                  AND embeddings.generation_id = CAST($2 AS uuid)
                  AND embeddings.model_id = '{model_id}'::uuid
                  AND embeddings.document_id <> CAST($3 AS uuid)
                  AND (1.0 - (embeddings.embedding::vector({dimension})
                           <=> CAST($4 AS vector({dimension})))) >= $5
                  AND EXISTS (
                      SELECT 1 FROM {schema}."search_documents" AS candidate
                      WHERE candidate.project_id = embeddings.project_id
                        AND candidate.generation_id = embeddings.generation_id
                        AND candidate.document_id = embeddings.document_id
                        AND candidate.symbol_id IS NOT NULL
                        AND candidate.document_kind = 'symbol'
                        AND (NOT $6 OR candidate.language = $7)
                  )
                ORDER BY embeddings.embedding::vector({dimension})
                             <=> CAST($4 AS vector({dimension})),
                         embeddings.document_id
                LIMIT $8
            )
            SELECT documents.generation_id::text, documents.document_id::text,
                   documents.file_id::text, documents.symbol_id::text,
                   documents.path, documents.language, documents.document_kind,
                   documents.qualified_name, nearest.distance
            FROM nearest
            INNER JOIN {schema}."search_documents" AS documents
              ON documents.project_id = nearest.project_id
             AND documents.generation_id = nearest.generation_id
             AND documents.document_id = nearest.document_id
            ORDER BY nearest.distance, documents.id"#
    );
    let fetch_limit = request
        .limit
        .checked_add(1)
        .ok_or(SemanticStorageError::InvalidInput {
            field: "similar_symbols",
        })?;
    let rows = query(AssertSqlSafe(sql))
        .bind(request.project_id.as_str())
        .bind(request.expected_generation_id.as_str())
        .bind(&source.document_id)
        .bind(&source.vector)
        .bind(request.minimum_score)
        .bind(request.same_language)
        .bind(&source.language)
        .bind(i64::from(fetch_limit))
        .fetch_all(connection)
        .await
        .map_err(|_| database_error("similar-symbols-query"))?;
    rows.iter()
        .map(|row| {
            let hit = decode_hit(row)?;
            let score = (1.0 - hit.distance()).clamp(0.0, 1.0);
            Ok(SimilarSymbolHit::new(hit, score))
        })
        .collect()
}
