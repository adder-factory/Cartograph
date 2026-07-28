use std::time::Duration;

use cartograph_domain::{ModelId, ProjectId};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::PgConnection;

use crate::{CartographDatabase, database::set_local_statement_timeout};

use super::{
    common::configure_filtered_hnsw_scan,
    types::{SemanticStorageError, database_error, invalid, validate_timeout},
};

const MAXIMUM_NEIGHBORS: u16 = 50;
const MAXIMUM_MODEL_SYMBOL_PAIRS: u64 = 100_000;
const MATERIALIZE_LOCK_NAMESPACE: &str = "cartograph-v2-materialized-similarity";

/// Atomic model-scoped similarity-cache rebuild for one current generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityMaterializationReport {
    pub models: u64,
    pub source_symbols: u64,
    pub model_symbol_pairs: u64,
    pub edges_written: u64,
    pub neighbors_per_symbol: u16,
    pub minimum_score_millionths: u32,
}

/// Validated neighbor, score, and timeout policy for one similarity-cache rebuild.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimilarityMaterializationPolicy {
    neighbors: u16,
    minimum_score: f64,
    statement_timeout: Duration,
}

impl SimilarityMaterializationPolicy {
    /// Validate the complete rebuild policy before opening a transaction.
    pub fn new(
        neighbors: u16,
        minimum_score: f64,
        statement_timeout: Duration,
    ) -> Result<Self, SemanticStorageError> {
        validate_timeout(statement_timeout)?;
        if neighbors == 0
            || neighbors > MAXIMUM_NEIGHBORS
            || !minimum_score.is_finite()
            || !(0.0..=1.0).contains(&minimum_score)
        {
            return Err(invalid("similarity_materialization"));
        }
        Ok(Self {
            neighbors,
            minimum_score,
            statement_timeout,
        })
    }
}

struct MaterializationModel {
    model_id: ModelId,
    dimension: u16,
    source_symbols: u64,
}

struct MaterializationGeneration<'value> {
    schema: &'value str,
    project_id: &'value ProjectId,
    generation_id: &'value str,
}

impl CartographDatabase {
    /// Rebuild current pgvector neighbors as a rebuildable accelerator.
    ///
    /// On-demand vector search remains authoritative when no compatible build
    /// metadata exists. Each model query retains its fixed-dimension cast so
    /// PostgreSQL can use Cartograph's model-specific HNSW expression index.
    pub async fn rebuild_current_similarity_edges(
        &self,
        project_id: &ProjectId,
        policy: SimilarityMaterializationPolicy,
    ) -> Result<SimilarityMaterializationReport, SemanticStorageError> {
        let SimilarityMaterializationPolicy {
            neighbors,
            minimum_score,
            statement_timeout,
        } = policy;
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("similarity-materialize-begin"))?;
        set_local_statement_timeout(&mut transaction, statement_timeout)
            .await
            .map_err(|()| database_error("similarity-materialize-timeout"))?;
        query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!(
                "{MATERIALIZE_LOCK_NAMESPACE}:{}:{}",
                self.schema.as_str(),
                project_id
            ))
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("similarity-materialize-lock"))?;

        let schema = crate::database::quoted_schema(&self.schema);
        let generation_sql = format!(
            r#"SELECT current_generation_id::text AS generation_id
                FROM {schema}."projects"
                WHERE project_id = CAST($1 AS uuid)
                  AND current_generation_id IS NOT NULL
                FOR SHARE"#
        );
        let generation_id = query(AssertSqlSafe(generation_sql))
            .bind(project_id.as_str())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| database_error("similarity-materialize-generation"))?
            .ok_or(SemanticStorageError::CurrentGenerationUnavailable)?
            .try_get::<String, _>("generation_id")
            .map_err(|_| SemanticStorageError::CorruptStoredValue {
                field: "generation_id",
            })?;

        let generation = MaterializationGeneration {
            schema: &schema,
            project_id,
            generation_id: &generation_id,
        };
        let models = load_materialization_models(&mut transaction, &generation).await?;
        let model_symbol_pairs = models.iter().try_fold(0_u64, |total, model| {
            total
                .checked_add(model.source_symbols)
                .ok_or_else(|| invalid("similarity_source_symbols"))
        })?;
        if model_symbol_pairs > MAXIMUM_MODEL_SYMBOL_PAIRS {
            return Err(invalid("similarity_source_symbols"));
        }
        let source_symbols = count_distinct_source_symbols(&mut transaction, &generation).await?;

        clear_current_materialization(&mut transaction, &generation).await?;
        configure_filtered_hnsw_scan(&mut transaction).await?;

        let mut edges_written = 0_u64;
        for model in &models {
            let context = MaterializationContext {
                schema: &schema,
                project_id,
                generation: &generation_id,
                model,
                neighbors,
                minimum_score,
            };
            let written = materialize_model(&mut transaction, &context).await?;
            edges_written = edges_written
                .checked_add(written)
                .ok_or_else(|| database_error("similarity-materialize-edge-count"))?;
            record_materialization(&mut transaction, &context, written).await?;
        }
        transaction
            .commit()
            .await
            .map_err(|_| database_error("similarity-materialize-commit"))?;
        Ok(SimilarityMaterializationReport {
            models: u64::try_from(models.len())
                .map_err(|_| database_error("similarity-materialize-model-count"))?,
            source_symbols,
            model_symbol_pairs,
            edges_written,
            neighbors_per_symbol: neighbors,
            minimum_score_millionths: (minimum_score * 1_000_000.0).round() as u32,
        })
    }
}

async fn load_materialization_models(
    connection: &mut PgConnection,
    generation: &MaterializationGeneration<'_>,
) -> Result<Vec<MaterializationModel>, SemanticStorageError> {
    let MaterializationGeneration {
        schema,
        project_id,
        generation_id,
    } = generation;
    let sql = format!(
        r#"SELECT models.model_id::text AS model_id, models.dimension
            FROM {schema}."embedding_models" AS models
            WHERE models.state = 'active'
              AND EXISTS (
                  SELECT 1
                  FROM {schema}."document_embeddings" AS embeddings
                  INNER JOIN {schema}."search_documents" AS documents
                    ON documents.project_id = embeddings.project_id
                   AND documents.generation_id = embeddings.generation_id
                   AND documents.document_id = embeddings.document_id
                  WHERE embeddings.model_id = models.model_id
                    AND embeddings.project_id = CAST($1 AS uuid)
                    AND embeddings.generation_id = CAST($2 AS uuid)
                    AND documents.document_kind = 'symbol'
                    AND documents.symbol_id IS NOT NULL
              )
            ORDER BY models.model_id
            FOR SHARE OF models"#
    );
    let rows = query(AssertSqlSafe(sql))
        .bind(project_id.as_str())
        .bind(*generation_id)
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| database_error("similarity-materialize-models"))?;
    let count_sql = format!(
        r#"SELECT count(DISTINCT documents.symbol_id)::bigint AS source_symbols
            FROM {schema}."search_documents" AS documents
            INNER JOIN {schema}."document_embeddings" AS embeddings
              ON embeddings.project_id = documents.project_id
             AND embeddings.generation_id = documents.generation_id
             AND embeddings.document_id = documents.document_id
            WHERE documents.project_id = CAST($1 AS uuid)
              AND documents.generation_id = CAST($2 AS uuid)
              AND documents.document_kind = 'symbol'
              AND documents.symbol_id IS NOT NULL
              AND embeddings.model_id = CAST($3 AS uuid)"#
    );
    let mut models = Vec::with_capacity(rows.len());
    for row in rows {
        let raw_model_id = row
            .try_get::<String, _>("model_id")
            .map_err(|_| corrupt("model_id"))?;
        let model_id = ModelId::parse(&raw_model_id).map_err(|_| corrupt("model_id"))?;
        let dimension = row
            .try_get::<i32, _>("dimension")
            .ok()
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0 && *value <= 2_000)
            .ok_or_else(|| corrupt("dimension"))?;
        let count_row = query(AssertSqlSafe(count_sql.as_str()))
            .bind(project_id.as_str())
            .bind(*generation_id)
            .bind(model_id.as_str())
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| database_error("similarity-materialize-model-count"))?;
        models.push(MaterializationModel {
            model_id,
            dimension,
            source_symbols: nonnegative(&count_row, "source_symbols")?,
        });
    }
    Ok(models)
}

async fn count_distinct_source_symbols(
    connection: &mut PgConnection,
    generation: &MaterializationGeneration<'_>,
) -> Result<u64, SemanticStorageError> {
    let MaterializationGeneration {
        schema,
        project_id,
        generation_id,
    } = generation;
    let sql = format!(
        r#"SELECT count(DISTINCT documents.symbol_id)::bigint AS source_symbols
            FROM {schema}."search_documents" AS documents
            INNER JOIN {schema}."document_embeddings" AS embeddings
              ON embeddings.project_id = documents.project_id
             AND embeddings.generation_id = documents.generation_id
             AND embeddings.document_id = documents.document_id
            INNER JOIN {schema}."embedding_models" AS models
              ON models.model_id = embeddings.model_id AND models.state = 'active'
            WHERE documents.project_id = CAST($1 AS uuid)
              AND documents.generation_id = CAST($2 AS uuid)
              AND documents.document_kind = 'symbol'
              AND documents.symbol_id IS NOT NULL"#
    );
    let row = query(AssertSqlSafe(sql))
        .bind(project_id.as_str())
        .bind(*generation_id)
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("similarity-materialize-source-count"))?;
    nonnegative(&row, "source_symbols")
}

async fn clear_current_materialization(
    connection: &mut PgConnection,
    generation: &MaterializationGeneration<'_>,
) -> Result<(), SemanticStorageError> {
    let MaterializationGeneration {
        schema,
        project_id,
        generation_id,
    } = generation;
    for table in ["symbol_similarity_edges", "symbol_similarity_builds"] {
        let sql = format!(
            r#"DELETE FROM {schema}."{table}"
                WHERE project_id = CAST($1 AS uuid)
                  AND generation_id = CAST($2 AS uuid)"#
        );
        query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .bind(*generation_id)
            .execute(&mut *connection)
            .await
            .map_err(|_| database_error("similarity-materialize-clear"))?;
    }
    Ok(())
}

struct MaterializationContext<'value> {
    schema: &'value str,
    project_id: &'value ProjectId,
    generation: &'value str,
    model: &'value MaterializationModel,
    neighbors: u16,
    minimum_score: f64,
}

async fn materialize_model(
    connection: &mut PgConnection,
    context: &MaterializationContext<'_>,
) -> Result<u64, SemanticStorageError> {
    let MaterializationContext {
        schema,
        project_id,
        generation,
        model,
        neighbors,
        minimum_score,
    } = context;
    let dimension = model.dimension;
    let model_id = model.model_id.as_str();
    let sql = format!(
        r#"WITH source_documents AS MATERIALIZED (
                SELECT documents.symbol_id, documents.document_id,
                       embeddings.embedding::vector({dimension}) AS embedding
                FROM {schema}."search_documents" AS documents
                INNER JOIN {schema}."document_embeddings" AS embeddings
                  ON embeddings.project_id = documents.project_id
                 AND embeddings.generation_id = documents.generation_id
                 AND embeddings.document_id = documents.document_id
                 AND embeddings.model_id = '{model_id}'::uuid
                WHERE documents.project_id = CAST($1 AS uuid)
                  AND documents.generation_id = CAST($2 AS uuid)
                  AND documents.document_kind = 'symbol'
                  AND documents.symbol_id IS NOT NULL
            ), ranked AS (
                SELECT source.symbol_id AS source_symbol_id,
                       neighbor.target_symbol_id,
                       neighbor.score,
                       row_number() OVER (
                           PARTITION BY source.symbol_id
                           ORDER BY neighbor.score DESC, neighbor.target_symbol_id
                       ) AS neighbor_rank
                FROM source_documents AS source
                CROSS JOIN LATERAL (
                    SELECT candidate.symbol_id AS target_symbol_id,
                           (1.0 - (target.embedding::vector({dimension})
                               <=> source.embedding))::float8 AS score
                    FROM {schema}."document_embeddings" AS target
                    INNER JOIN {schema}."search_documents" AS candidate
                      ON candidate.project_id = target.project_id
                     AND candidate.generation_id = target.generation_id
                     AND candidate.document_id = target.document_id
                    WHERE target.project_id = CAST($1 AS uuid)
                      AND target.generation_id = CAST($2 AS uuid)
                      AND target.model_id = '{model_id}'::uuid
                      AND candidate.document_kind = 'symbol'
                      AND candidate.symbol_id IS NOT NULL
                      AND candidate.symbol_id <> source.symbol_id
                      AND (1.0 - (target.embedding::vector({dimension})
                           <=> source.embedding)) >= $3
                    ORDER BY target.embedding::vector({dimension}) <=> source.embedding,
                             target.document_id
                    LIMIT $4
                ) AS neighbor
            )
            INSERT INTO {schema}."symbol_similarity_edges" (
                project_id, generation_id, model_id, source_symbol_id,
                target_symbol_id, score, neighbor_rank
            )
            SELECT CAST($1 AS uuid), CAST($2 AS uuid), '{model_id}'::uuid,
                   ranked.source_symbol_id, ranked.target_symbol_id,
                   LEAST(1.0, GREATEST(0.0, ranked.score)), ranked.neighbor_rank
            FROM ranked"#
    );
    query(AssertSqlSafe(sql))
        .bind(project_id.as_str())
        .bind(generation)
        .bind(*minimum_score)
        .bind(i64::from(*neighbors))
        .execute(connection)
        .await
        .map(|result| result.rows_affected())
        .map_err(|_| database_error("similarity-materialize-write"))
}

async fn record_materialization(
    connection: &mut PgConnection,
    context: &MaterializationContext<'_>,
    edges_written: u64,
) -> Result<(), SemanticStorageError> {
    let MaterializationContext {
        schema,
        project_id,
        generation,
        model,
        neighbors,
        minimum_score,
    } = context;
    let sql = format!(
        r#"INSERT INTO {schema}."symbol_similarity_builds" (
                project_id, generation_id, model_id, neighbors_per_symbol,
                minimum_score, source_symbols, edges_written
            ) VALUES (
                CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid),
                $4, $5, $6, $7
            )"#
    );
    query(AssertSqlSafe(sql))
        .bind(project_id.as_str())
        .bind(generation)
        .bind(model.model_id.as_str())
        .bind(i16::try_from(*neighbors).map_err(|_| invalid("neighbors"))?)
        .bind(*minimum_score)
        .bind(i64::try_from(model.source_symbols).map_err(|_| corrupt("source_symbols"))?)
        .bind(i64::try_from(edges_written).map_err(|_| corrupt("edges_written"))?)
        .execute(connection)
        .await
        .map(|_| ())
        .map_err(|_| database_error("similarity-materialize-record"))
}

fn nonnegative(
    row: &sqlx_postgres::PgRow,
    field: &'static str,
) -> Result<u64, SemanticStorageError> {
    row.try_get::<i64, _>(field)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| corrupt(field))
}

const fn corrupt(field: &'static str) -> SemanticStorageError {
    SemanticStorageError::CorruptStoredValue { field }
}
