use cartograph_domain::{DocumentId, GenerationId, ProjectId};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{CartographDatabase, StorageError};

const MAX_QUERY_BYTES: usize = 1_024;
const MAX_RESULT_LIMIT: u16 = 100;

/// Bounded BM25 query against one project's atomically published generation.
pub struct SearchQuery {
    project_id: ProjectId,
    query: String,
    limit: u16,
}

impl SearchQuery {
    /// Build a query request. It is validated immediately before execution.
    #[must_use]
    pub fn new(project_id: ProjectId, query: impl Into<String>, limit: u16) -> Self {
        Self {
            project_id,
            query: query.into().trim().to_owned(),
            limit,
        }
    }
}

/// Deterministically ordered ParadeDB evidence from the current generation.
#[derive(Clone, Debug)]
pub struct SearchHit {
    document_id: DocumentId,
    generation_id: GenerationId,
    path: String,
    qualified_name: String,
    score: f64,
}

impl SearchHit {
    /// Stable logical document identity.
    #[must_use]
    pub const fn document_id(&self) -> &DocumentId {
        &self.document_id
    }

    /// Published generation that produced this evidence.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Normalized project path.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Qualified symbol/declaration name when present.
    #[must_use]
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    /// Native ParadeDB BM25 score; only ordering within this candidate channel
    /// is meaningful.
    #[must_use]
    pub const fn score(&self) -> f64 {
        self.score
    }
}

impl CartographDatabase {
    /// Search code-aware names/source and natural-language evidence from only
    /// the generation referenced by the project's current pointer.
    pub async fn search_current_code(
        &self,
        input: SearchQuery,
    ) -> Result<Vec<SearchHit>, StorageError> {
        validate_query(&input)?;
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"SELECT
                    documents.document_id::text,
                    documents.generation_id::text,
                    documents.path,
                    documents.qualified_name,
                    pdb.score(documents.id)::double precision
                FROM {schema}."search_documents" AS documents
                INNER JOIN {schema}."projects" AS projects
                    ON projects.project_id = documents.project_id
                   AND projects.current_generation_id = documents.generation_id
                WHERE documents.project_id = CAST($1 AS uuid)
                  AND (
                    documents.qualified_name ||| $2
                    OR documents.code ||| $2
                    OR documents.natural_text ||| $2
                  )
                ORDER BY pdb.score(documents.id) DESC, documents.id ASC
                LIMIT $3"#
        );
        let rows = query(AssertSqlSafe(sql))
            .bind(input.project_id.as_str())
            .bind(input.query)
            .bind(i64::from(input.limit))
            .fetch_all(&self.pool)
            .await
            .map_err(|_| StorageError::DatabaseOperation {
                operation: "bm25-search",
            })?;
        rows.iter().map(decode_hit).collect()
    }
}

fn validate_query(input: &SearchQuery) -> Result<(), StorageError> {
    if input.query.is_empty() || input.query.len() > MAX_QUERY_BYTES || input.query.contains('\0') {
        return Err(StorageError::InvalidInput { field: "query" });
    }
    if !(1..=MAX_RESULT_LIMIT).contains(&input.limit) {
        return Err(StorageError::InvalidInput { field: "limit" });
    }
    Ok(())
}

fn decode_hit(row: &sqlx_postgres::PgRow) -> Result<SearchHit, StorageError> {
    let document_id = parse_document_id(row, 0)?;
    let generation_id = parse_generation_id(row, 1)?;
    let path = row.try_get::<String, _>(2).map_err(|_| corrupt("path"))?;
    let qualified_name = row
        .try_get::<String, _>(3)
        .map_err(|_| corrupt("qualified_name"))?;
    let score = row.try_get::<f64, _>(4).map_err(|_| corrupt("score"))?;
    if !score.is_finite() || score < 0.0 {
        return Err(corrupt("score"));
    }
    Ok(SearchHit {
        document_id,
        generation_id,
        path,
        qualified_name,
        score,
    })
}

fn parse_document_id(row: &sqlx_postgres::PgRow, index: usize) -> Result<DocumentId, StorageError> {
    let raw = read_string(row, index, "document_id")?;
    DocumentId::parse(&raw).map_err(|_| corrupt("document_id"))
}

fn parse_generation_id(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<GenerationId, StorageError> {
    let raw = read_string(row, index, "generation_id")?;
    GenerationId::parse(&raw).map_err(|_| corrupt("generation_id"))
}

fn read_string(
    row: &sqlx_postgres::PgRow,
    index: usize,
    field: &'static str,
) -> Result<String, StorageError> {
    row.try_get::<String, _>(index).map_err(|_| corrupt(field))
}

const fn corrupt(field: &'static str) -> StorageError {
    StorageError::CorruptStoredValue { field }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_id() -> ProjectId {
        match ProjectId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
            Ok(id) => id,
            Err(error) => panic!("fixture UUID is invalid: {error}"),
        }
    }

    #[test]
    fn query_bounds_reject_empty_unbounded_and_zero_limit_requests() {
        assert_eq!(
            validate_query(&SearchQuery::new(project_id(), "   ", 10)),
            Err(StorageError::InvalidInput { field: "query" })
        );
        assert_eq!(
            validate_query(&SearchQuery::new(
                project_id(),
                "x".repeat(MAX_QUERY_BYTES + 1),
                10,
            )),
            Err(StorageError::InvalidInput { field: "query" })
        );
        assert_eq!(
            validate_query(&SearchQuery::new(project_id(), "parser", 0)),
            Err(StorageError::InvalidInput { field: "limit" })
        );
    }
}
