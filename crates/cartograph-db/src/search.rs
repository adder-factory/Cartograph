use cartograph_domain::{DocumentId, FileId, GenerationId, ProjectId, SymbolId};
use serde::Serialize;
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchComponent {
    /// Qualified declaration names contributed to the match.
    QualifiedName,
    /// Indexed source code contributed to the match.
    Code,
    /// Documentation or other natural language contributed to the match.
    NaturalText,
}

/// Deterministically ordered ParadeDB evidence from the current generation.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SearchHit {
    document_id: DocumentId,
    generation_id: GenerationId,
    file_id: Option<FileId>,
    symbol_id: Option<SymbolId>,
    path: String,
    language: String,
    document_kind: String,
    qualified_name: String,
    score: f64,
    components: Vec<SearchComponent>,
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

    /// File represented by the document, when the document is file-backed.
    #[must_use]
    pub const fn file_id(&self) -> Option<&FileId> {
        self.file_id.as_ref()
    }

    /// Symbol represented by the document, when the document is symbol-backed.
    #[must_use]
    pub const fn symbol_id(&self) -> Option<&SymbolId> {
        self.symbol_id.as_ref()
    }

    /// Normalized project path.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Stable indexed language name.
    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }

    /// Stable search-document kind name.
    #[must_use]
    pub fn document_kind(&self) -> &str {
        &self.document_kind
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

    /// Ordered fields that contributed to the BM25 candidate match. This is
    /// provenance, not a cross-field score decomposition.
    #[must_use]
    pub fn components(&self) -> &[SearchComponent] {
        &self.components
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
                    documents.file_id::text,
                    documents.symbol_id::text,
                    documents.path,
                    documents.language,
                    documents.document_kind,
                    documents.qualified_name,
                    pdb.score(documents.id)::double precision,
                    documents.qualified_name ||| $2,
                    documents.code ||| $2,
                    documents.natural_text ||| $2
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
    let file_id = parse_optional_file_id(row, 2)?;
    let symbol_id = parse_optional_symbol_id(row, 3)?;
    let path = read_string(row, 4, "path")?;
    let language = read_string(row, 5, "language")?;
    let document_kind = read_string(row, 6, "document_kind")?;
    let qualified_name = read_string(row, 7, "qualified_name")?;
    let score = row.try_get::<f64, _>(8).map_err(|_| corrupt("score"))?;
    if !score.is_finite() || score < 0.0 {
        return Err(corrupt("score"));
    }
    let mut components = Vec::with_capacity(3);
    if read_bool(row, 9, "qualified_name_match")? {
        components.push(SearchComponent::QualifiedName);
    }
    if read_bool(row, 10, "code_match")? {
        components.push(SearchComponent::Code);
    }
    if read_bool(row, 11, "natural_text_match")? {
        components.push(SearchComponent::NaturalText);
    }
    if components.is_empty() {
        return Err(corrupt("search_components"));
    }
    Ok(SearchHit {
        document_id,
        generation_id,
        file_id,
        symbol_id,
        path,
        language,
        document_kind,
        qualified_name,
        score,
        components,
    })
}

fn parse_optional_file_id(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<Option<FileId>, StorageError> {
    parse_optional_id(row, index, "file_id", FileId::parse)
}

fn parse_optional_symbol_id(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<Option<SymbolId>, StorageError> {
    parse_optional_id(row, index, "symbol_id", SymbolId::parse)
}

fn parse_optional_id<T>(
    row: &sqlx_postgres::PgRow,
    index: usize,
    field: &'static str,
    parse: impl FnOnce(&str) -> Result<T, cartograph_domain::InvalidId>,
) -> Result<Option<T>, StorageError> {
    let raw = row
        .try_get::<Option<String>, _>(index)
        .map_err(|_| corrupt(field))?;
    raw.map(|value| parse(&value).map_err(|_| corrupt(field)))
        .transpose()
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

fn read_bool(
    row: &sqlx_postgres::PgRow,
    index: usize,
    field: &'static str,
) -> Result<bool, StorageError> {
    row.try_get::<bool, _>(index).map_err(|_| corrupt(field))
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

    #[test]
    fn component_provenance_has_a_stable_priority_order() {
        let components = [
            SearchComponent::QualifiedName,
            SearchComponent::Code,
            SearchComponent::NaturalText,
        ];
        assert!(components.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn query_validation_errors_never_render_query_text() {
        let secret = "postgres://private-user:private-password@database/private-query\0";
        let error = match validate_query(&SearchQuery::new(project_id(), secret, 10)) {
            Ok(()) => panic!("nul-bearing query unexpectedly passed validation"),
            Err(error) => error,
        };
        let rendered = error.to_string();
        assert!(!rendered.contains("private-password"));
        assert!(!rendered.contains("private-query"));
        assert!(rendered.contains("query"));
    }
}
