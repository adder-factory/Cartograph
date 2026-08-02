//! Generation-fenced PostgreSQL execution for field-qualified symbol search.

use std::time::Duration;

use cartograph_domain::{GenerationId, ProjectId};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, CurrentSymbolRecord, StorageError,
    retrieval::{
        CurrentGenerationLookup, begin_bounded_read, commit_bounded_read, decode_symbol,
        require_expected_current_generation,
    },
};

const MAXIMUM_QUERY_BYTES: usize = 1_024;
const MAXIMUM_FILTER_BYTES: usize = 4_096;
const MAXIMUM_FILTER_VALUES: usize = 64;
const MAXIMUM_RESULT_LIMIT: u16 = 100;
const DEFAULT_QUALIFIED_SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const CENTRALITY_COLUMN: usize = 16;
const LEXICAL_SCORE_COLUMN: usize = 17;
const TOTAL_COLUMN: usize = 18;

/// SQL-level centrality comparison with v1-compatible unranked-symbol semantics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QualifiedCentralityComparator {
    /// Require a non-null score strictly above the threshold.
    GreaterThan,
    /// Require a non-null score at or above the threshold.
    GreaterThanOrEqual,
    /// Require a score below the threshold; unranked symbols are retained.
    LessThan,
    /// Require a score at or below the threshold; unranked symbols are retained.
    LessThanOrEqual,
}

impl QualifiedCentralityComparator {
    const fn as_sql_parameter(self) -> &'static str {
        match self {
            Self::GreaterThan => "gt",
            Self::GreaterThanOrEqual => "ge",
            Self::LessThan => "lt",
            Self::LessThanOrEqual => "le",
        }
    }
}

/// Stable qualified-query ordering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QualifiedSymbolSort {
    /// `ParadeDB` relevance first, then deterministic declaration order.
    #[default]
    Relevance,
    /// Directed `PageRank` descending, with unranked symbols last.
    Centrality,
}

/// One bounded current-generation field-qualified query.
#[derive(Clone, Copy, Debug)]
pub struct QualifiedSymbolQuery<'a> {
    project_id: &'a ProjectId,
    expected_generation_id: &'a GenerationId,
    text: &'a str,
    kinds: &'a [String],
    languages: &'a [String],
    path_prefixes: &'a [String],
    path_filters: &'a [String],
    name_filters: &'a [String],
    signature_filters: &'a [String],
    callers_of: &'a [String],
    callees_of: &'a [String],
    depends_on: &'a [String],
    centrality: Option<(QualifiedCentralityComparator, f64)>,
    sort: QualifiedSymbolSort,
    scan_all: bool,
    limit: u16,
}

impl<'a> QualifiedSymbolQuery<'a> {
    /// Bind a parsed query to one immutable published generation.
    #[must_use]
    pub const fn new(generation: CurrentGenerationLookup<'a>, text: &'a str, limit: u16) -> Self {
        Self {
            project_id: generation.project_id(),
            expected_generation_id: generation.expected_generation_id(),
            text,
            kinds: &[],
            languages: &[],
            path_prefixes: &[],
            path_filters: &[],
            name_filters: &[],
            signature_filters: &[],
            callers_of: &[],
            callees_of: &[],
            depends_on: &[],
            centrality: None,
            sort: QualifiedSymbolSort::Relevance,
            scan_all: false,
            limit,
        }
    }

    /// Add OR-composed symbol kinds.
    #[must_use]
    pub const fn with_kinds(mut self, values: &'a [String]) -> Self {
        self.kinds = values;
        self
    }

    /// Add OR-composed source languages.
    #[must_use]
    pub const fn with_languages(mut self, values: &'a [String]) -> Self {
        self.languages = values;
        self
    }

    /// Add explicit normalized path prefixes.
    #[must_use]
    pub const fn with_path_prefixes(mut self, values: &'a [String]) -> Self {
        self.path_prefixes = values;
        self
    }

    /// Add case-insensitive path substring filters.
    #[must_use]
    pub const fn with_path_filters(mut self, values: &'a [String]) -> Self {
        self.path_filters = values;
        self
    }

    /// Add case-insensitive simple-name substring filters.
    #[must_use]
    pub const fn with_name_filters(mut self, values: &'a [String]) -> Self {
        self.name_filters = values;
        self
    }

    /// Add case-insensitive signature substring filters.
    #[must_use]
    pub const fn with_signature_filters(mut self, values: &'a [String]) -> Self {
        self.signature_filters = values;
        self
    }

    /// Add OR-composed call targets; this category intersects with other categories.
    #[must_use]
    pub const fn with_callers_of(mut self, values: &'a [String]) -> Self {
        self.callers_of = values;
        self
    }

    /// Add OR-composed call sources; this category intersects with other categories.
    #[must_use]
    pub const fn with_callees_of(mut self, values: &'a [String]) -> Self {
        self.callees_of = values;
        self
    }

    /// Add OR-composed structural dependency targets.
    #[must_use]
    pub const fn with_depends_on(mut self, values: &'a [String]) -> Self {
        self.depends_on = values;
        self
    }

    /// Add one centrality predicate.
    #[must_use]
    pub const fn with_centrality(
        mut self,
        comparator: QualifiedCentralityComparator,
        threshold: f64,
    ) -> Self {
        self.centrality = Some((comparator, threshold));
        self
    }

    /// Select relevance or graph-centrality ordering.
    #[must_use]
    pub const fn with_sort(mut self, sort: QualifiedSymbolSort) -> Self {
        self.sort = sort;
        self
    }

    /// Permit an explicitly requested bounded all-symbol scan, such as `sort:centrality` alone.
    #[must_use]
    pub const fn with_scan_all(mut self, scan_all: bool) -> Self {
        self.scan_all = scan_all;
        self
    }
}

/// One qualified-query hit with lexical and graph ranking evidence.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct QualifiedSymbolHit {
    symbol: CurrentSymbolRecord,
    centrality: Option<f64>,
    lexical_score: Option<f64>,
}

impl QualifiedSymbolHit {
    /// Hydrated current-generation declaration.
    #[must_use]
    pub const fn symbol(&self) -> &CurrentSymbolRecord {
        &self.symbol
    }

    /// Directed calls/references `PageRank`, when computed.
    #[must_use]
    pub const fn centrality(&self) -> Option<f64> {
        self.centrality
    }

    /// Reserved lexical score. Exact-name identity queries do not use a tokenizer.
    #[must_use]
    pub const fn lexical_score(&self) -> Option<f64> {
        self.lexical_score
    }
}

/// Exact pre-limit cardinality plus one deterministic result page.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct QualifiedSymbolPage {
    total: u64,
    hits: Vec<QualifiedSymbolHit>,
}

impl QualifiedSymbolPage {
    /// Exact number of declarations matching all hard filters before `LIMIT`.
    #[must_use]
    pub const fn total(&self) -> u64 {
        self.total
    }

    /// Deterministically ranked bounded result rows.
    #[must_use]
    pub fn hits(&self) -> &[QualifiedSymbolHit] {
        &self.hits
    }

    /// Whether more matching declarations exist beyond this page.
    #[must_use]
    pub fn truncated(&self) -> bool {
        self.total > u64::try_from(self.hits.len()).unwrap_or(u64::MAX)
    }
}

impl CartographDatabase {
    /// Execute all field-qualified predicates in PostgreSQL before applying the response limit.
    /// # Errors
    ///
    /// Returns an error if text/filter/result bounds are invalid, the expected
    /// generation is not current, or qualified symbol rows cannot be read.
    pub async fn qualified_current_symbols(
        &self,
        input: QualifiedSymbolQuery<'_>,
    ) -> Result<QualifiedSymbolPage, StorageError> {
        self.qualified_current_symbols_bounded(input, DEFAULT_QUALIFIED_SEARCH_TIMEOUT)
            .await
    }

    /// Execute field-qualified search under an explicit PostgreSQL statement timeout.
    /// # Errors
    ///
    /// Returns an error if the explicit deadline or query fields are invalid,
    /// the generation fence fails, or a qualified result cannot be decoded.
    pub async fn qualified_current_symbols_bounded(
        &self,
        input: QualifiedSymbolQuery<'_>,
        statement_timeout: Duration,
    ) -> Result<QualifiedSymbolPage, StorageError> {
        validate_query(&input)?;
        let mut transaction = begin_bounded_read(self, statement_timeout).await?;
        require_expected_current_generation(
            &mut transaction,
            &self.schema,
            CurrentGenerationLookup::new(input.project_id, input.expected_generation_id),
        )
        .await?;
        let schema = crate::database::quoted_schema(&self.schema);
        let has_text = !input.text.is_empty();
        // Exact-name mode is an identity operation. Keep its free text on ordinary bound SQL
        // equality so prefix, substring, and tokenizer-adjacent names cannot enter the page.
        let (document_join, text_predicate, lexical_score, exact_name_rank) = if has_text {
            (
                String::new(),
                "AND (lower(symbols.simple_name) = lower($15) OR lower(symbols.qualified_name) = lower($15))",
                "NULL::double precision",
                "",
            )
        } else {
            (String::new(), "", "NULL::double precision", "")
        };
        let primary_order = match input.sort {
            QualifiedSymbolSort::Relevance => format!(
                "{exact_name_rank} lexical_score DESC NULLS LAST, symbols.simple_name, files.normalized_path, symbols.start_line, symbols.symbol_id"
            ),
            QualifiedSymbolSort::Centrality => format!(
                "symbols.pagerank DESC NULLS LAST, {exact_name_rank} lexical_score DESC NULLS LAST, symbols.simple_name, files.normalized_path, symbols.start_line, symbols.symbol_id"
            ),
        };
        let sql = qualified_symbol_sql(QualifiedSymbolSql {
            schema: &schema,
            document_join: &document_join,
            text_predicate,
            lexical_score,
            primary_order: &primary_order,
        });
        let (centrality_operator, centrality_threshold) = input
            .centrality
            .map_or((None, None), |(operator, threshold)| {
                (Some(operator.as_sql_parameter()), Some(threshold))
            });
        let mut statement = query(AssertSqlSafe(sql))
            .bind(input.project_id.as_str())
            .bind(input.expected_generation_id.as_str())
            .bind(input.kinds)
            .bind(input.languages)
            .bind(input.path_prefixes)
            .bind(input.path_filters)
            .bind(input.name_filters)
            .bind(input.signature_filters)
            .bind(input.callers_of)
            .bind(input.callees_of)
            .bind(input.depends_on)
            .bind(centrality_operator)
            .bind(centrality_threshold)
            .bind(i64::from(input.limit));
        if has_text {
            statement = statement.bind(input.text);
        }
        let rows = statement.fetch_all(&mut *transaction).await.map_err(|_| {
            StorageError::DatabaseOperation {
                operation: "qualified-symbol-search",
            }
        })?;
        commit_bounded_read(transaction, "qualified-symbol-search-commit").await?;
        decode_page(&rows)
    }
}

#[derive(Clone, Copy, Debug)]
struct QualifiedSymbolSql<'a> {
    schema: &'a str,
    document_join: &'a str,
    text_predicate: &'a str,
    lexical_score: &'a str,
    primary_order: &'a str,
}

const QUALIFIED_SYMBOL_SQL_TEMPLATE: &str = r#"SELECT symbols.generation_id::text, symbols.symbol_id::text,
           symbols.file_id::text, files.normalized_path, files.language,
           symbols.symbol_kind, symbols.qualified_name, symbols.signature,
           symbols.start_line, symbols.end_line,
           symbols.visibility, symbols.exported, symbols.default_export,
           symbols.async_symbol, symbols.static_member, symbols.declaration_only,
           symbols.pagerank, {lexical_score} AS lexical_score,
           count(*) OVER ()::bigint AS exact_total
    FROM {schema}."symbols" AS symbols
    INNER JOIN {schema}."files" AS files
        ON files.project_id = symbols.project_id
       AND files.generation_id = symbols.generation_id
       AND files.file_id = symbols.file_id
    {document_join}
    WHERE symbols.project_id = CAST($1 AS uuid)
      AND symbols.generation_id = CAST($2 AS uuid)
      AND (cardinality(CAST($3 AS text[])) = 0 OR symbols.symbol_kind = ANY(CAST($3 AS text[])))
      AND (cardinality(CAST($4 AS text[])) = 0 OR files.language = ANY(CAST($4 AS text[])))
      AND (
            cardinality(CAST($5 AS text[])) = 0
            OR EXISTS (
                SELECT 1 FROM unnest(CAST($5 AS text[])) AS prefix(value)
                WHERE files.normalized_path = prefix.value
                   OR starts_with(files.normalized_path, prefix.value || '/')
            )
          )
      AND (
            cardinality(CAST($6 AS text[])) = 0
            OR EXISTS (
                SELECT 1 FROM unnest(CAST($6 AS text[])) AS path_filter(value)
                WHERE strpos(lower(files.normalized_path), lower(path_filter.value)) > 0
            )
          )
      AND (
            cardinality(CAST($7 AS text[])) = 0
            OR EXISTS (
                SELECT 1 FROM unnest(CAST($7 AS text[])) AS name_filter(value)
                WHERE strpos(lower(symbols.simple_name), lower(name_filter.value)) > 0
            )
          )
      AND (
            cardinality(CAST($8 AS text[])) = 0
            OR EXISTS (
                SELECT 1 FROM unnest(CAST($8 AS text[])) AS signature_filter(value)
                WHERE strpos(lower(symbols.signature), lower(signature_filter.value)) > 0
            )
          )
      AND (
            cardinality(CAST($9 AS text[])) = 0
            OR EXISTS (
                SELECT 1
                FROM {schema}."edges" AS caller_edge
                INNER JOIN {schema}."symbols" AS call_target
                    ON call_target.project_id = caller_edge.project_id
                   AND call_target.generation_id = caller_edge.generation_id
                   AND call_target.symbol_id = caller_edge.target_symbol_id
                WHERE caller_edge.project_id = symbols.project_id
                  AND caller_edge.generation_id = symbols.generation_id
                  AND caller_edge.source_symbol_id = symbols.symbol_id
                  AND caller_edge.edge_kind = 'calls'
                  AND (
                        call_target.simple_name = ANY(CAST($9 AS text[]))
                        OR call_target.qualified_name = ANY(CAST($9 AS text[]))
                      )
            )
          )
      AND (
            cardinality(CAST($10 AS text[])) = 0
            OR EXISTS (
                SELECT 1
                FROM {schema}."edges" AS callee_edge
                INNER JOIN {schema}."symbols" AS call_source
                    ON call_source.project_id = callee_edge.project_id
                   AND call_source.generation_id = callee_edge.generation_id
                   AND call_source.symbol_id = callee_edge.source_symbol_id
                WHERE callee_edge.project_id = symbols.project_id
                  AND callee_edge.generation_id = symbols.generation_id
                  AND callee_edge.target_symbol_id = symbols.symbol_id
                  AND callee_edge.edge_kind = 'calls'
                  AND (
                        call_source.simple_name = ANY(CAST($10 AS text[]))
                        OR call_source.qualified_name = ANY(CAST($10 AS text[]))
                      )
            )
          )
      AND (
            cardinality(CAST($11 AS text[])) = 0
            OR EXISTS (
                SELECT 1
                FROM {schema}."edges" AS dependency_edge
                INNER JOIN {schema}."symbols" AS dependency_target
                    ON dependency_target.project_id = dependency_edge.project_id
                   AND dependency_target.generation_id = dependency_edge.generation_id
                   AND dependency_target.symbol_id = dependency_edge.target_symbol_id
                WHERE dependency_edge.project_id = symbols.project_id
                  AND dependency_edge.generation_id = symbols.generation_id
                  AND dependency_edge.source_symbol_id = symbols.symbol_id
                  AND dependency_edge.edge_kind = ANY(ARRAY[
                        'calls', 'imports', 'extends', 'implements', 'type_of',
                        'returns', 'instantiates', 'overrides'
                      ]::text[])
                  AND (
                        dependency_target.simple_name = ANY(CAST($11 AS text[]))
                        OR dependency_target.qualified_name = ANY(CAST($11 AS text[]))
                      )
            )
          )
      AND (
            CAST($12 AS text) IS NULL
            OR (CAST($12 AS text) = 'gt' AND symbols.pagerank > CAST($13 AS double precision))
            OR (CAST($12 AS text) = 'ge' AND symbols.pagerank >= CAST($13 AS double precision))
            OR (CAST($12 AS text) = 'lt' AND (symbols.pagerank IS NULL OR symbols.pagerank < CAST($13 AS double precision)))
            OR (CAST($12 AS text) = 'le' AND (symbols.pagerank IS NULL OR symbols.pagerank <= CAST($13 AS double precision)))
          )
      {text_predicate}
    ORDER BY {primary_order}
    LIMIT $14"#;

fn qualified_symbol_sql(input: QualifiedSymbolSql<'_>) -> String {
    let QualifiedSymbolSql {
        schema,
        document_join,
        text_predicate,
        lexical_score,
        primary_order,
    } = input;
    QUALIFIED_SYMBOL_SQL_TEMPLATE
        .replace("{schema}", schema)
        .replace("{document_join}", document_join)
        .replace("{text_predicate}", text_predicate)
        .replace("{lexical_score}", lexical_score)
        .replace("{primary_order}", primary_order)
}

fn validate_query(input: &QualifiedSymbolQuery<'_>) -> Result<(), StorageError> {
    validate_query_text(input.text)?;
    validate_query_limit(input.limit)?;
    validate_primary_filters(input)?;
    validate_text_filters(input)?;
    validate_graph_filters(input)?;
    validate_centrality(input.centrality)?;
    if !query_has_constraint(input) {
        return Err(invalid("query"));
    }
    Ok(())
}

fn validate_query_text(text: &str) -> Result<(), StorageError> {
    if text.len() > MAXIMUM_QUERY_BYTES || text.contains('\0') {
        return Err(invalid("query"));
    }
    Ok(())
}

fn validate_query_limit(limit: u16) -> Result<(), StorageError> {
    if !(1..=MAXIMUM_RESULT_LIMIT).contains(&limit) {
        return Err(invalid("limit"));
    }
    Ok(())
}

fn validate_primary_filters(input: &QualifiedSymbolQuery<'_>) -> Result<(), StorageError> {
    validate_filter_group([
        ("kinds", input.kinds),
        ("languages", input.languages),
        ("path_prefixes", input.path_prefixes),
    ])
}

fn validate_text_filters(input: &QualifiedSymbolQuery<'_>) -> Result<(), StorageError> {
    validate_filter_group([
        ("path_filters", input.path_filters),
        ("name_filters", input.name_filters),
        ("signature_filters", input.signature_filters),
    ])
}

fn validate_graph_filters(input: &QualifiedSymbolQuery<'_>) -> Result<(), StorageError> {
    validate_filter_group([
        ("callers_of", input.callers_of),
        ("callees_of", input.callees_of),
        ("depends_on", input.depends_on),
    ])
}

fn validate_centrality(
    centrality: Option<(QualifiedCentralityComparator, f64)>,
) -> Result<(), StorageError> {
    if centrality.is_some_and(|(_, threshold)| !threshold.is_finite() || threshold < 0.0) {
        return Err(invalid("centrality"));
    }
    Ok(())
}

fn validate_filter_group<const COUNT: usize>(
    filters: [(&'static str, &[String]); COUNT],
) -> Result<(), StorageError> {
    for (field, values) in filters {
        if invalid_filter_values(values) {
            return Err(invalid(field));
        }
    }
    Ok(())
}

fn invalid_filter_values(values: &[String]) -> bool {
    if values.len() > MAXIMUM_FILTER_VALUES {
        return true;
    }
    values
        .iter()
        .any(|value| value.is_empty() || value.len() > MAXIMUM_FILTER_BYTES || value.contains('\0'))
}

fn query_has_constraint(input: &QualifiedSymbolQuery<'_>) -> bool {
    has_primary_query_constraint(input)
        || has_text_filter_constraint(input)
        || has_graph_filter_constraint(input)
}

fn has_primary_query_constraint(input: &QualifiedSymbolQuery<'_>) -> bool {
    [
        !input.text.is_empty(),
        !input.kinds.is_empty(),
        !input.languages.is_empty(),
        !input.path_prefixes.is_empty(),
    ]
    .into_iter()
    .any(std::convert::identity)
}

fn has_text_filter_constraint(input: &QualifiedSymbolQuery<'_>) -> bool {
    [
        !input.path_filters.is_empty(),
        !input.name_filters.is_empty(),
        !input.signature_filters.is_empty(),
    ]
    .into_iter()
    .any(std::convert::identity)
}

fn has_graph_filter_constraint(input: &QualifiedSymbolQuery<'_>) -> bool {
    [
        !input.callers_of.is_empty(),
        !input.callees_of.is_empty(),
        !input.depends_on.is_empty(),
        input.centrality.is_some(),
        input.scan_all,
    ]
    .into_iter()
    .any(std::convert::identity)
}

fn decode_page(rows: &[sqlx_postgres::PgRow]) -> Result<QualifiedSymbolPage, StorageError> {
    let total = match rows.first() {
        Some(row) => u64::try_from(
            row.try_get::<i64, _>(TOTAL_COLUMN)
                .map_err(|_| corrupt("qualified_total"))?,
        )
        .map_err(|_| corrupt("qualified_total"))?,
        None => 0,
    };
    let hits = rows
        .iter()
        .map(|row| {
            let centrality = row
                .try_get::<Option<f64>, _>(CENTRALITY_COLUMN)
                .map_err(|_| corrupt("centrality"))?;
            if centrality.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
                return Err(corrupt("centrality"));
            }
            let lexical_score = row
                .try_get::<Option<f64>, _>(LEXICAL_SCORE_COLUMN)
                .map_err(|_| corrupt("lexical_score"))?;
            if lexical_score.is_some_and(|value| !value.is_finite() || value < 0.0) {
                return Err(corrupt("lexical_score"));
            }
            Ok(QualifiedSymbolHit {
                symbol: decode_symbol(row)?,
                centrality,
                lexical_score,
            })
        })
        .collect::<Result<Vec<_>, StorageError>>()?;
    Ok(QualifiedSymbolPage { total, hits })
}

const fn invalid(field: &'static str) -> StorageError {
    StorageError::InvalidInput { field }
}

const fn corrupt(field: &'static str) -> StorageError {
    StorageError::CorruptStoredValue { field }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_id() -> ProjectId {
        ProjectId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            .unwrap_or_else(|error| panic!("project fixture is invalid: {error}"))
    }

    fn generation_id() -> GenerationId {
        GenerationId::parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
            .unwrap_or_else(|error| panic!("generation fixture is invalid: {error}"))
    }

    #[test]
    fn query_validation_requires_bounded_text_or_a_real_filter() {
        let project = project_id();
        let generation = generation_id();
        let generation = CurrentGenerationLookup::new(&project, &generation);
        assert_eq!(
            validate_query(&QualifiedSymbolQuery::new(generation, "", 10)),
            Err(StorageError::InvalidInput { field: "query" })
        );
        let kinds = vec!["function".to_owned()];
        assert!(
            validate_query(&QualifiedSymbolQuery::new(generation, "", 10).with_kinds(&kinds))
                .is_ok()
        );
        assert_eq!(
            validate_query(&QualifiedSymbolQuery::new(
                generation,
                &"x".repeat(MAXIMUM_QUERY_BYTES + 1),
                10,
            )),
            Err(StorageError::InvalidInput { field: "query" })
        );
    }

    #[test]
    fn generated_sql_pushes_every_filter_before_limit() {
        let sql = qualified_symbol_sql(QualifiedSymbolSql {
            schema: "\"cartograph\"",
            document_join: "INNER JOIN docs",
            text_predicate: "AND documents.qualified_name ||| $15",
            lexical_score: "pdb.score(documents.id)::double precision",
            primary_order: "lexical_score DESC",
        });
        let limit = sql.find("LIMIT $14").unwrap_or(0);
        for predicate in [
            "symbols.symbol_kind",
            "files.language",
            "path_filter",
            "name_filter",
            "signature_filter",
            "caller_edge",
            "callee_edge",
            "dependency_edge",
            "symbols.pagerank",
            "documents.qualified_name ||| $15",
        ] {
            let offset = sql.find(predicate).unwrap_or(usize::MAX);
            assert!(offset < limit, "{predicate} was not pushed before LIMIT");
        }
    }
}
