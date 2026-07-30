use std::time::Duration;

use cartograph_domain::{ContentDigest, GenerationId, NormalizedPath, ProjectId, SymbolId};
use serde::Serialize;
use sqlx_core::{column::ColumnIndex, query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, StorageError,
    database::{ProjectReadRequest, quoted_schema, read_project_rows, set_local_statement_timeout},
};

const COVERAGE_TIMEOUT: Duration = Duration::from_mins(2);
const MAX_COVERAGE_TARGETS: i64 = 1_000_000;
const COVERAGE_TARGET_OVERFLOW_PROBE: i64 = MAX_COVERAGE_TARGETS + 1;
const MAX_COVERAGE_FACTS: usize = 1_000_000;
const COVERAGE_INSERT_CHUNK: usize = 5_000;
const MAX_COVERAGE_LIMIT: u16 = 500;

/// Current-generation symbol span used to join LCOV line observations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageTarget {
    generation_id: GenerationId,
    symbol_id: SymbolId,
    path: NormalizedPath,
    symbol_kind: String,
    qualified_name: String,
    start_line: u32,
    end_line: u32,
}

impl CoverageTarget {
    #[must_use]
    /// Returns the generation ID.
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    #[must_use]
    /// Returns the symbol ID.
    pub const fn symbol_id(&self) -> &SymbolId {
        &self.symbol_id
    }

    #[must_use]
    /// Returns the path.
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    #[must_use]
    /// Returns the start line.
    pub const fn start_line(&self) -> u32 {
        self.start_line
    }

    #[must_use]
    /// Returns the end line.
    pub const fn end_line(&self) -> u32 {
        self.end_line
    }
}

/// Validated found/hit counts for one coverage dimension.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoverageCount {
    found: u64,
    hit: u64,
}

impl CoverageCount {
    /// Public constant defining the zero.
    pub const ZERO: Self = Self { found: 0, hit: 0 };

    /// Creates a validated coverage count.
    ///
    /// # Errors
    ///
    /// Returns an error if `hit` exceeds `found`.
    pub fn new(found: u64, hit: u64) -> Result<Self, StorageError> {
        if hit > found {
            Err(StorageError::InvalidInput {
                field: "coverage_counts",
            })
        } else {
            Ok(Self { found, hit })
        }
    }
}

/// One exact symbol-level coverage observation ready for bulk insertion.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolCoverageFact {
    symbol_id: SymbolId,
    lines_found: u64,
    lines_hit: u64,
    functions_found: u64,
    functions_hit: u64,
}

impl SymbolCoverageFact {
    #[must_use]
    /// Creates a validated symbol coverage fact.
    pub fn new(symbol_id: SymbolId, lines: CoverageCount, functions: CoverageCount) -> Self {
        Self {
            symbol_id,
            lines_found: lines.found,
            lines_hit: lines.hit,
            functions_found: functions.found,
            functions_hit: functions.hit,
        }
    }
}

/// Identity and provenance for one current-generation coverage replacement.
pub struct CoverageLoadInput {
    /// Stable project ID for this record.
    pub project_id: ProjectId,
    /// Stable generation ID for this record.
    pub generation_id: GenerationId,
    /// Source label for this record.
    pub source_label: String,
    /// Digest-fenced report digest for this record.
    pub report_digest: ContentDigest,
}

/// Validated replacement of one source/current-generation coverage snapshot.
pub struct CoverageLoadRequest {
    project_id: ProjectId,
    generation_id: GenerationId,
    source_label: String,
    report_digest: ContentDigest,
    report_metadata: serde_json::Value,
    facts: Vec<SymbolCoverageFact>,
}

impl CoverageLoadRequest {
    /// Creates a validated coverage load request.
    ///
    /// # Errors
    ///
    /// Returns an error if the source label is empty, oversized, or contains a
    /// NUL byte, or the fact count exceeds the atomic load bound.
    pub fn new(
        input: CoverageLoadInput,
        facts: Vec<SymbolCoverageFact>,
    ) -> Result<Self, StorageError> {
        let CoverageLoadInput {
            project_id,
            generation_id,
            source_label,
            report_digest,
        } = input;
        if source_label.is_empty()
            || source_label.len() > 256
            || source_label.contains('\0')
            || facts.len() > MAX_COVERAGE_FACTS
        {
            return Err(StorageError::InvalidInput {
                field: "coverage_load",
            });
        }
        Ok(Self {
            project_id,
            generation_id,
            source_label,
            report_digest,
            report_metadata: serde_json::json!({}),
            facts,
        })
    }

    /// Sets the metadata and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if metadata is not a JSON object, cannot be encoded, or
    /// exceeds the coverage metadata byte limit.
    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Result<Self, StorageError> {
        let bytes = serde_json::to_vec(&metadata).map_err(|_| StorageError::InvalidInput {
            field: "coverage_metadata",
        })?;
        if !metadata.is_object() || bytes.len() > 65_536 {
            return Err(StorageError::InvalidInput {
                field: "coverage_metadata",
            });
        }
        self.report_metadata = metadata;
        Ok(self)
    }
}

/// Atomic LCOV replacement result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageLoadReport {
    generation_id: GenerationId,
    source_id: String,
    source_label: String,
    symbols_written: u64,
}

/// One graph-composed LCOV row.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolCoverageRecord {
    symbol_id: String,
    path: String,
    language: String,
    symbol_kind: String,
    qualified_name: String,
    source: String,
    lines_found: u64,
    lines_hit: u64,
    coverage_fraction: Option<f64>,
    incoming_edges: u64,
    direct_test_files: u64,
    degree_centrality: f64,
}

/// Validated filters for one current-generation coverage ranking.
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolCoverageQuery {
    source: Option<String>,
    symbol_id: Option<SymbolId>,
    limit: u16,
    include_tests: bool,
    maximum_fraction: Option<f64>,
    minimum_centrality: Option<f64>,
    symbol_kinds: Vec<String>,
    path_prefix: Option<String>,
}

impl SymbolCoverageQuery {
    /// Creates a validated symbol coverage query.
    ///
    /// # Errors
    ///
    /// Returns an error if `limit` is zero or exceeds the bounded coverage row maximum.
    pub fn new(limit: u16) -> Result<Self, StorageError> {
        validate_source_and_limit(None, limit)?;
        Ok(Self {
            source: None,
            symbol_id: None,
            limit,
            include_tests: true,
            maximum_fraction: None,
            minimum_centrality: None,
            symbol_kinds: Vec::new(),
            path_prefix: None,
        })
    }

    /// Sets the source and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if the optional source label is empty, oversized, or
    /// contains a NUL byte.
    pub fn with_source(mut self, source: Option<&str>) -> Result<Self, StorageError> {
        validate_source(source)?;
        self.source = source.map(ToOwned::to_owned);
        Ok(self)
    }

    #[must_use]
    /// Sets the symbol and returns the updated value.
    pub fn with_symbol(mut self, symbol_id: Option<SymbolId>) -> Self {
        self.symbol_id = symbol_id;
        self
    }

    #[must_use]
    /// Sets the include tests and returns the updated value.
    pub const fn with_include_tests(mut self, include_tests: bool) -> Self {
        self.include_tests = include_tests;
        self
    }

    /// Sets the maximum fraction and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if the optional maximum is not finite or lies outside
    /// the inclusive coverage-fraction range from zero to one.
    pub fn with_maximum_fraction(mut self, value: Option<f64>) -> Result<Self, StorageError> {
        validate_fraction(value, "coverage_fraction")?;
        self.maximum_fraction = value;
        Ok(self)
    }

    /// Sets the minimum centrality and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if the optional minimum is not finite or lies outside
    /// the inclusive centrality range from zero to one.
    pub fn with_minimum_centrality(mut self, value: Option<f64>) -> Result<Self, StorageError> {
        validate_fraction(value, "coverage_centrality")?;
        self.minimum_centrality = value;
        Ok(self)
    }

    /// Sets the symbol kinds and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if there are too many kinds or any kind is empty,
    /// oversized, or contains a NUL byte.
    pub fn with_symbol_kinds(mut self, kinds: Vec<String>) -> Result<Self, StorageError> {
        if kinds.len() > 64
            || kinds
                .iter()
                .any(|kind| kind.is_empty() || kind.len() > 64 || kind.contains('\0'))
        {
            return Err(StorageError::InvalidInput {
                field: "coverage_kinds",
            });
        }
        for kind in kinds {
            if !self.symbol_kinds.contains(&kind) {
                self.symbol_kinds.push(kind);
            }
        }
        Ok(self)
    }

    /// Sets the path prefix and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if the optional prefix is empty, absolute, oversized,
    /// or contains a NUL byte.
    pub fn with_path_prefix(mut self, prefix: Option<&str>) -> Result<Self, StorageError> {
        if prefix.is_some_and(|value| {
            value.is_empty()
                || value.len() > 4_096
                || value.contains('\0')
                || value.starts_with('/')
        }) {
            return Err(StorageError::InvalidInput {
                field: "coverage_path_prefix",
            });
        }
        self.path_prefix = prefix.map(ToOwned::to_owned);
        Ok(self)
    }
}

/// One loaded coverage source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageSourceRecord {
    source_id: String,
    label: String,
    report_digest: String,
    loaded_at: String,
    current_symbols: u64,
}

/// Complete project coverage aggregate.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageStats {
    symbols: u64,
    lines_found: u64,
    lines_hit: u64,
    coverage_fraction: Option<f64>,
    sources: u64,
}

impl CartographDatabase {
    /// Load every current symbol span for deterministic parallel LCOV joining.
    /// # Errors
    ///
    /// Returns an error if current symbol spans cannot be queried/decoded or
    /// the target count exceeds the deterministic LCOV join bound.
    pub async fn current_coverage_targets(
        &self,
        project_id: &ProjectId,
    ) -> Result<Vec<CoverageTarget>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT symbols.generation_id::text, symbols.symbol_id::text,
                       files.normalized_path, symbols.symbol_kind,
                       symbols.qualified_name, symbols.start_line, symbols.end_line
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
                ORDER BY files.normalized_path, symbols.start_line, symbols.symbol_id
                LIMIT {COVERAGE_TARGET_OVERFLOW_PROBE}"#,
        );
        let rows = read_project_rows(
            self,
            ProjectReadRequest {
                statement,
                project_id,
                operation: "current-coverage-targets",
                statement_timeout: COVERAGE_TIMEOUT,
            },
            |statement| statement,
        )
        .await?;
        if i64::try_from(rows.len()).unwrap_or(i64::MAX) > MAX_COVERAGE_TARGETS {
            return Err(StorageError::InvalidInput {
                field: "coverage_target_limit",
            });
        }
        rows.iter().map(decode_target).collect()
    }

    /// Replace one source snapshot with PostgreSQL array-UNNEST bulk batches.
    /// # Errors
    ///
    /// Returns an error if fact bounds are exceeded, the requested generation
    /// is not current, or the transactional source/fact replacement fails.
    pub async fn replace_current_symbol_coverage(
        &self,
        request: CoverageLoadRequest,
    ) -> Result<CoverageLoadReport, StorageError> {
        if request.facts.len() > MAX_COVERAGE_FACTS {
            return Err(StorageError::InvalidInput {
                field: "coverage_facts",
            });
        }
        let schema = quoted_schema(&self.schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("coverage-load-begin"))?;
        set_local_statement_timeout(&mut transaction, COVERAGE_TIMEOUT)
            .await
            .map_err(|()| database_error("coverage-load-timeout"))?;
        let current =
            include_str!("sql/coverage_current_generation.sql").replace("{schema}", &schema);
        let generation = query(AssertSqlSafe(current))
            .bind(request.project_id.as_str())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| database_error("coverage-load-current"))?
            .and_then(|row| row.try_get::<Option<String>, _>(0).ok().flatten())
            .ok_or(StorageError::CurrentGenerationChanged)?;
        if generation != request.generation_id.as_str() {
            let _ = transaction.rollback().await;
            return Err(StorageError::CurrentGenerationChanged);
        }
        let metadata = serde_json::to_string(&request.report_metadata).map_err(|_| {
            StorageError::InvalidInput {
                field: "coverage_metadata",
            }
        })?;
        let upsert = include_str!("sql/coverage_source_upsert.sql").replace("{schema}", &schema);
        let source_id = query(AssertSqlSafe(upsert))
            .bind(request.project_id.as_str())
            .bind(&request.source_label)
            .bind(request.report_digest.as_str())
            .bind(metadata)
            .fetch_one(&mut *transaction)
            .await
            .and_then(|row| row.try_get::<String, _>(0))
            .map_err(|_| database_error("coverage-source-upsert"))?;
        let delete = include_str!("sql/coverage_symbol_delete.sql").replace("{schema}", &schema);
        query(AssertSqlSafe(delete))
            .bind(request.project_id.as_str())
            .bind(request.generation_id.as_str())
            .bind(&source_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("coverage-replace-delete"))?;
        let insert = include_str!("sql/coverage_symbol_insert.sql").replace("{schema}", &schema);
        for chunk in request.facts.chunks(COVERAGE_INSERT_CHUNK) {
            let symbol_ids = chunk
                .iter()
                .map(|fact| fact.symbol_id.as_str().to_owned())
                .collect::<Vec<_>>();
            let lines_found = counts(chunk, |fact| fact.lines_found)?;
            let lines_hit = counts(chunk, |fact| fact.lines_hit)?;
            let functions_found = counts(chunk, |fact| fact.functions_found)?;
            let functions_hit = counts(chunk, |fact| fact.functions_hit)?;
            query(AssertSqlSafe(insert.clone()))
                .bind(request.project_id.as_str())
                .bind(request.generation_id.as_str())
                .bind(&source_id)
                .bind(symbol_ids)
                .bind(lines_found)
                .bind(lines_hit)
                .bind(functions_found)
                .bind(functions_hit)
                .execute(&mut *transaction)
                .await
                .map_err(|_| database_error("coverage-bulk-insert"))?;
        }
        transaction
            .commit()
            .await
            .map_err(|_| database_error("coverage-load-commit"))?;
        Ok(CoverageLoadReport {
            generation_id: request.generation_id,
            source_id,
            source_label: request.source_label,
            symbols_written: u64::try_from(request.facts.len()).unwrap_or(u64::MAX),
        })
    }

    /// Rank LCOV rows worst-first and compose them with graph/test pressure.
    /// # Errors
    ///
    /// Returns an error if source/filter/limit validation fails or ranked
    /// current coverage and graph-pressure rows cannot be queried or decoded.
    pub async fn current_symbol_coverage(
        &self,
        project_id: &ProjectId,
        request: &SymbolCoverageQuery,
    ) -> Result<Vec<SymbolCoverageRecord>, StorageError> {
        validate_source_and_limit(request.source.as_deref(), request.limit)?;
        let schema = quoted_schema(&self.schema);
        let statement =
            include_str!("sql/coverage_current_symbols.sql").replace("{schema}", &schema);
        let symbol_kinds = (!request.symbol_kinds.is_empty()).then(|| request.symbol_kinds.clone());
        let rows = read_project_rows(
            self,
            ProjectReadRequest {
                statement,
                project_id,
                operation: "current-symbol-coverage",
                statement_timeout: COVERAGE_TIMEOUT,
            },
            |statement| {
                statement
                    .bind(request.source.as_deref())
                    .bind(request.symbol_id.as_ref().map(SymbolId::as_str))
                    .bind(request.include_tests)
                    .bind(request.maximum_fraction)
                    .bind(request.minimum_centrality)
                    .bind(symbol_kinds)
                    .bind(request.path_prefix.as_deref())
                    .bind(i64::from(request.limit))
            },
        )
        .await?;
        rows.iter().map(decode_coverage_record).collect()
    }

    /// Aggregate current coverage across the best row per symbol.
    /// # Errors
    ///
    /// Returns an error if the optional source label is invalid or aggregate
    /// current-generation counts/fractions cannot be queried or decoded.
    pub async fn current_coverage_stats(
        &self,
        project_id: &ProjectId,
        source: Option<&str>,
    ) -> Result<CoverageStats, StorageError> {
        validate_source(source)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), selected AS (
                    SELECT DISTINCT ON (coverage.symbol_id)
                           coverage.symbol_id, coverage.lines_found, coverage.lines_hit,
                           coverage.coverage_fraction, coverage.source_id
                    FROM {schema}."symbol_coverage" AS coverage
                    JOIN current ON current.generation_id = coverage.generation_id
                    JOIN {schema}."coverage_sources" AS sources
                      ON sources.project_id = coverage.project_id
                     AND sources.source_id = coverage.source_id
                    WHERE coverage.project_id = CAST($1 AS uuid)
                      AND ($2::text IS NULL OR sources.label = $2)
                    ORDER BY coverage.symbol_id, coverage.coverage_fraction DESC NULLS LAST,
                             coverage.source_id
                )
                SELECT COUNT(*)::bigint,
                       COALESCE(SUM(lines_found), 0)::bigint,
                       COALESCE(SUM(lines_hit), 0)::bigint,
                       CASE WHEN COALESCE(SUM(lines_found), 0) = 0 THEN NULL
                            ELSE SUM(lines_hit)::double precision / SUM(lines_found)::double precision
                       END,
                       COUNT(DISTINCT source_id)::bigint
                FROM selected"#,
        );
        let mut rows = read_project_rows(
            self,
            ProjectReadRequest {
                statement,
                project_id,
                operation: "current-coverage-stats",
                statement_timeout: COVERAGE_TIMEOUT,
            },
            |statement| statement.bind(source),
        )
        .await?;
        let row = rows
            .pop()
            .ok_or(StorageError::CorruptStoredValue { field: "coverage" })?;
        Ok(CoverageStats {
            symbols: nonnegative_u64(&row, 0)?,
            lines_found: nonnegative_u64(&row, 1)?,
            lines_hit: nonnegative_u64(&row, 2)?,
            coverage_fraction: row.try_get(3).map_err(|_| corrupt())?,
            sources: nonnegative_u64(&row, 4)?,
        })
    }

    /// Returns the coverage sources.
    ///
    /// # Errors
    ///
    /// Returns an error if source metadata/current-symbol counts cannot be
    /// queried or a stored source record is malformed.
    pub async fn coverage_sources(
        &self,
        project_id: &ProjectId,
    ) -> Result<Vec<CoverageSourceRecord>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT sources.source_id::text, sources.label, sources.report_digest,
                       sources.loaded_at::text,
                       COUNT(coverage.symbol_id)::bigint
                FROM {schema}."coverage_sources" AS sources
                LEFT JOIN current ON true
                LEFT JOIN {schema}."symbol_coverage" AS coverage
                  ON coverage.project_id = sources.project_id
                 AND coverage.source_id = sources.source_id
                 AND coverage.generation_id = current.generation_id
                WHERE sources.project_id = CAST($1 AS uuid)
                GROUP BY sources.source_id, sources.label, sources.report_digest,
                         sources.loaded_at
                ORDER BY sources.label"#,
        );
        let rows = read_project_rows(
            self,
            ProjectReadRequest {
                statement,
                project_id,
                operation: "coverage-sources",
                statement_timeout: COVERAGE_TIMEOUT,
            },
            |statement| statement,
        )
        .await?;
        rows.iter().map(decode_source).collect()
    }

    /// Deletes one named coverage source and its generation-scoped facts.
    ///
    /// # Errors
    ///
    /// Returns an error if `source` is empty/oversized/NUL-containing or the
    /// project-scoped source cascade cannot be deleted.
    pub async fn drop_coverage_source(
        &self,
        project_id: &ProjectId,
        source: &str,
    ) -> Result<bool, StorageError> {
        validate_source(Some(source))?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"DELETE FROM {schema}."coverage_sources"
                WHERE project_id = CAST($1 AS uuid) AND label = $2"#,
        );
        let result = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(source)
            .execute(&self.pool)
            .await
            .map_err(|_| database_error("drop-coverage-source"))?;
        Ok(result.rows_affected() == 1)
    }
}

fn counts(
    chunk: &[SymbolCoverageFact],
    pick: impl Fn(&SymbolCoverageFact) -> u64,
) -> Result<Vec<i64>, StorageError> {
    chunk
        .iter()
        .map(|fact| {
            i64::try_from(pick(fact)).map_err(|_| StorageError::InvalidInput {
                field: "coverage_count",
            })
        })
        .collect()
}

fn validate_source_and_limit(source: Option<&str>, limit: u16) -> Result<(), StorageError> {
    validate_source(source)?;
    if limit == 0 || limit > MAX_COVERAGE_LIMIT {
        Err(StorageError::InvalidInput { field: "limit" })
    } else {
        Ok(())
    }
}

fn validate_source(source: Option<&str>) -> Result<(), StorageError> {
    if source.is_some_and(|value| value.is_empty() || value.len() > 256 || value.contains('\0')) {
        Err(StorageError::InvalidInput {
            field: "coverage_source",
        })
    } else {
        Ok(())
    }
}

fn validate_fraction(value: Option<f64>, field: &'static str) -> Result<(), StorageError> {
    if value.is_some_and(|number| !number.is_finite() || !(0.0..=1.0).contains(&number)) {
        Err(StorageError::InvalidInput { field })
    } else {
        Ok(())
    }
}

const COVERAGE_SYMBOL_KIND_COLUMN: usize = 3;
const COVERAGE_QUALIFIED_NAME_COLUMN: usize = 4;
const COVERAGE_START_LINE_COLUMN: usize = 5;
const COVERAGE_END_LINE_COLUMN: usize = 6;

fn decode_target(row: &sqlx_postgres::PgRow) -> Result<CoverageTarget, StorageError> {
    Ok(CoverageTarget {
        generation_id: GenerationId::parse(&text(row, 0)?).map_err(|_| corrupt())?,
        symbol_id: SymbolId::parse(&text(row, 1)?).map_err(|_| corrupt())?,
        path: NormalizedPath::parse(&text(row, 2)?).map_err(|_| corrupt())?,
        symbol_kind: text(row, COVERAGE_SYMBOL_KIND_COLUMN)?,
        qualified_name: text(row, COVERAGE_QUALIFIED_NAME_COLUMN)?,
        start_line: positive_u32(row, COVERAGE_START_LINE_COLUMN)?,
        end_line: positive_u32(row, COVERAGE_END_LINE_COLUMN)?,
    })
}

fn decode_coverage_record(
    row: &sqlx_postgres::PgRow,
) -> Result<SymbolCoverageRecord, StorageError> {
    Ok(SymbolCoverageRecord {
        symbol_id: text(row, "symbol_id")?,
        path: text(row, "normalized_path")?,
        language: text(row, "language")?,
        symbol_kind: text(row, "symbol_kind")?,
        qualified_name: text(row, "qualified_name")?,
        source: text(row, "label")?,
        lines_found: nonnegative_u64(row, "lines_found")?,
        lines_hit: nonnegative_u64(row, "lines_hit")?,
        coverage_fraction: row.try_get("coverage_fraction").map_err(|_| corrupt())?,
        incoming_edges: nonnegative_u64(row, "incoming_edges")?,
        direct_test_files: nonnegative_u64(row, "direct_test_files")?,
        degree_centrality: row.try_get("degree_centrality").map_err(|_| corrupt())?,
    })
}

fn decode_source(row: &sqlx_postgres::PgRow) -> Result<CoverageSourceRecord, StorageError> {
    Ok(CoverageSourceRecord {
        source_id: text(row, 0)?,
        label: text(row, 1)?,
        report_digest: text(row, 2)?,
        loaded_at: text(row, 3)?,
        current_symbols: nonnegative_u64(row, 4)?,
    })
}

fn text<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<String, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get(index).map_err(|_| corrupt())
}

fn positive_u32<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<u32, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get::<i32, _>(index)
        .ok()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(corrupt)
}

fn nonnegative_u64<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<u64, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get::<i64, _>(index)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(corrupt)
}

const fn corrupt() -> StorageError {
    StorageError::CorruptStoredValue { field: "coverage" }
}

const fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_facts_reject_impossible_hit_counts() {
        let symbol = SymbolId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            .unwrap_or_else(|error| panic!("fixture symbol failed: {error}"));
        let lines =
            CoverageCount::new(10, 8).unwrap_or_else(|error| panic!("line counts failed: {error}"));
        let functions = CoverageCount::new(2, 1)
            .unwrap_or_else(|error| panic!("function counts failed: {error}"));
        let fact = SymbolCoverageFact::new(symbol, lines, functions);
        assert_eq!(fact.lines_hit, 8);
        assert!(CoverageCount::new(10, 11).is_err());
    }
}
