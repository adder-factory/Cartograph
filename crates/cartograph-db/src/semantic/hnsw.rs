use std::time::Duration;

use cartograph_config::DatabaseSchema;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::PgConnection;

use crate::CartographDatabase;

use super::{
    common::{ModelLookup, begin_bounded, load_model, require_active_selector, rollback_error},
    types::{EmbeddingHnswStatus, EmbeddingModelSelector, SemanticStorageError, database_error},
};

const HNSW_LOCK_NAMESPACE: &str = "cartograph-v2-embedding-model-hnsw";
const CATALOG_TIMEOUT: Duration = Duration::from_secs(5);

impl CartographDatabase {
    /// Create or repair the exact model-specific cosine HNSW expression index.
    pub async fn ensure_embedding_model_hnsw(
        &self,
        selector: &EmbeddingModelSelector,
        statement_timeout: Duration,
    ) -> Result<EmbeddingHnswStatus, SemanticStorageError> {
        super::types::validate_timeout(statement_timeout)?;
        let mut transaction = begin_bounded(self, statement_timeout, "hnsw-begin").await?;
        let result = ensure_hnsw_transaction(&mut transaction, self, selector).await;
        match result {
            Ok(status) => {
                transaction
                    .commit()
                    .await
                    .map_err(|_| database_error("hnsw-commit"))?;
                Ok(status)
            }
            Err(error) => Err(rollback_error(transaction, error, "hnsw-rollback").await),
        }
    }

    /// Inspect the deterministic index without creating or repairing it.
    pub async fn embedding_model_hnsw_status(
        &self,
        selector: &EmbeddingModelSelector,
    ) -> Result<EmbeddingHnswStatus, SemanticStorageError> {
        let mut transaction = begin_bounded(self, CATALOG_TIMEOUT, "hnsw-status-begin").await?;
        let model = load_model(
            &mut transaction,
            ModelLookup::new(&self.schema, selector.model_id()),
        )
        .await?
        .ok_or(SemanticStorageError::ModelNotFound)?;
        require_active_selector(model, selector)?;
        let status = read_hnsw_status(&mut transaction, &self.schema, selector).await?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error("hnsw-status-commit"))?;
        Ok(status)
    }
}

async fn ensure_hnsw_transaction(
    connection: &mut PgConnection,
    database: &CartographDatabase,
    selector: &EmbeddingModelSelector,
) -> Result<EmbeddingHnswStatus, SemanticStorageError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{HNSW_LOCK_NAMESPACE}:{}:{}",
            database.schema.as_str(),
            selector.model_id()
        ))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("hnsw-lock"))?;
    let model = load_model(
        connection,
        ModelLookup::new(&database.schema, selector.model_id()).for_update(),
    )
    .await?
    .ok_or(SemanticStorageError::ModelNotFound)?;
    require_active_selector(model, selector)?;
    let existing = read_hnsw_status(connection, &database.schema, selector).await?;
    if existing.ready {
        return Ok(existing);
    }
    let schema = crate::database::quoted_schema(&database.schema);
    let index = existing.index_name.clone();
    let drop_sql = format!(r#"DROP INDEX IF EXISTS {schema}."{index}""#);
    query(AssertSqlSafe(drop_sql))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("hnsw-drop"))?;
    let model_id = selector.model_id().as_str();
    let dimension = selector.dimension();
    let create_sql = format!(
        r#"CREATE INDEX "{index}"
            ON {schema}."document_embeddings"
            USING hnsw ((embedding::vector({dimension})) vector_cosine_ops)
            WHERE model_id = '{model_id}'::uuid"#
    );
    query(AssertSqlSafe(create_sql))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("hnsw-create"))?;
    let status = read_hnsw_status(connection, &database.schema, selector).await?;
    if status.ready {
        Ok(status)
    } else {
        Err(database_error("hnsw-verify"))
    }
}

pub(crate) async fn read_hnsw_status(
    connection: &mut PgConnection,
    schema: &DatabaseSchema,
    selector: &EmbeddingModelSelector,
) -> Result<EmbeddingHnswStatus, SemanticStorageError> {
    let index_name = model_index_name(selector);
    let row = query(
        r#"SELECT indexes.indisvalid, indexes.indisready, indexes.indnkeyatts,
                  methods.amname,
                  pg_get_indexdef(indexes.indexrelid) AS definition,
                  pg_get_expr(indexes.indpred, indexes.indrelid) AS predicate
            FROM pg_catalog.pg_class AS index_relations
            INNER JOIN pg_catalog.pg_namespace AS namespaces
                ON namespaces.oid = index_relations.relnamespace
            INNER JOIN pg_catalog.pg_index AS indexes
                ON indexes.indexrelid = index_relations.oid
            INNER JOIN pg_catalog.pg_class AS tables
                ON tables.oid = indexes.indrelid
            INNER JOIN pg_catalog.pg_am AS methods
                ON methods.oid = index_relations.relam
            WHERE namespaces.nspname = $1
              AND index_relations.relname = $2
              AND tables.relname = 'document_embeddings'"#,
    )
    .bind(schema.as_str())
    .bind(&index_name)
    .fetch_optional(connection)
    .await
    .map_err(|_| database_error("hnsw-status"))?;
    let ready = row.as_ref().is_some_and(|row| {
        let valid = row.try_get::<bool, _>("indisvalid").unwrap_or(false);
        let catalog_ready = row.try_get::<bool, _>("indisready").unwrap_or(false);
        let key_attributes = row.try_get::<i16, _>("indnkeyatts").unwrap_or_default();
        let method = row.try_get::<String, _>("amname").unwrap_or_default();
        let definition = row.try_get::<String, _>("definition").unwrap_or_default();
        let predicate = row
            .try_get::<Option<String>, _>("predicate")
            .ok()
            .flatten()
            .unwrap_or_default();
        valid
            && catalog_ready
            && key_attributes == 1
            && method == "hnsw"
            && definition.contains("vector_cosine_ops")
            && definition.contains(&format!("vector({})", selector.dimension()))
            && predicate.contains(&format!("model_id = '{}'::uuid", selector.model_id()))
    });
    Ok(EmbeddingHnswStatus {
        model_id: selector.model_id().clone(),
        index_name,
        ready,
    })
}

fn model_index_name(selector: &EmbeddingModelSelector) -> String {
    let compact = selector.model_id().as_str().replace('-', "");
    format!("document_embeddings_model_{compact}_hnsw")
}

#[cfg(test)]
mod tests {
    use cartograph_domain::{ContentDigest, ModelId};

    use super::*;

    #[test]
    fn model_index_name_is_deterministic_and_within_postgresql_limit() {
        let selector = EmbeddingModelSelector {
            model_id: ModelId::parse("11111111-1111-8111-8111-111111111111")
                .unwrap_or_else(|error| panic!("model fixture failed: {error}")),
            fingerprint: ContentDigest::parse(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .unwrap_or_else(|error| panic!("fingerprint fixture failed: {error}")),
            dimension: 3,
        };
        let name = model_index_name(&selector);
        assert_eq!(name.len(), 63);
        assert!(
            name.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        );
    }
}
