use std::time::Duration;

use cartograph_domain::{ContentDigest, GenerationId, NormalizedPath, ProjectId, SymbolId};
use serde::Serialize;
use sqlx_core::{column::ColumnIndex, query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, StorageError,
    database::{ProjectReadRequest, quoted_schema, read_project_rows, set_local_statement_timeout},
};

const COVERAGE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
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
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    #[must_use]
    pub const fn symbol_id(&self) -> &SymbolId {
        &self.symbol_id
    }

    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    #[must_use]
    pub const fn start_line(&self) -> u32 {
        self.start_line
    }

    #[must_use]
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
    pub const ZERO: Self = Self { found: 0, hit: 0 };

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
    pub project_id: ProjectId,
    pub generation_id: GenerationId,
    pub source_label: String,
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

    pub fn with_source(mut self, source: Option<&str>) -> Result<Self, StorageError> {
        validate_source(source)?;
        self.source = source.map(ToOwned::to_owned);
        Ok(self)
    }

    #[must_use]
    pub fn with_symbol(mut self, symbol_id: Option<SymbolId>) -> Self {
        self.symbol_id = symbol_id;
        self
    }

    #[must_use]
    pub const fn with_include_tests(mut self, include_tests: bool) -> Self {
        self.include_tests = include_tests;
        self
    }

    pub fn with_maximum_fraction(mut self, value: Option<f64>) -> Result<Self, StorageError> {
        validate_fraction(value, "coverage_fraction")?;
        self.maximum_fraction = value;
        Ok(self)
    }

    pub fn with_minimum_centrality(mut self, value: Option<f64>) -> Result<Self, StorageError> {
        validate_fraction(value, "coverage_centrality")?;
        self.minimum_centrality = value;
        Ok(self)
    }

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
            .map_err(|_| database_error("coverage-load-timeout"))?;
        let current = format!(
            r#"SELECT current_generation_id::text
                FROM {schema}."projects"
                WHERE project_id = CAST($1 AS uuid)
                FOR UPDATE"#,
        );
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
        let upsert = format!(
            r#"INSERT INTO {schema}."coverage_sources" (
                    project_id, label, report_format, report_digest, report_metadata
                ) VALUES (CAST($1 AS uuid), $2, 'lcov', $3, CAST($4 AS jsonb))
                ON CONFLICT (project_id, label) DO UPDATE
                SET report_format = EXCLUDED.report_format,
                    report_digest = EXCLUDED.report_digest,
                    report_metadata = EXCLUDED.report_metadata,
                    loaded_at = clock_timestamp()
                RETURNING source_id::text"#,
        );
        let source_id = query(AssertSqlSafe(upsert))
            .bind(request.project_id.as_str())
            .bind(&request.source_label)
            .bind(request.report_digest.as_str())
            .bind(metadata)
            .fetch_one(&mut *transaction)
            .await
            .and_then(|row| row.try_get::<String, _>(0))
            .map_err(|_| database_error("coverage-source-upsert"))?;
        let delete = format!(
            r#"DELETE FROM {schema}."symbol_coverage"
                WHERE project_id = CAST($1 AS uuid)
                  AND generation_id = CAST($2 AS uuid)
                  AND source_id = CAST($3 AS uuid)"#,
        );
        query(AssertSqlSafe(delete))
            .bind(request.project_id.as_str())
            .bind(request.generation_id.as_str())
            .bind(&source_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("coverage-replace-delete"))?;
        let insert = format!(
            r#"INSERT INTO {schema}."symbol_coverage" (
                    project_id, generation_id, source_id, symbol_id,
                    lines_found, lines_hit, functions_found, functions_hit
                )
                SELECT CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid),
                       CAST(rows.symbol_id AS uuid), rows.lines_found, rows.lines_hit,
                       rows.functions_found, rows.functions_hit
                FROM UNNEST(
                    $4::text[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[]
                ) AS rows(
                    symbol_id, lines_found, lines_hit, functions_found, functions_hit
                )"#,
        );
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
    pub async fn current_symbol_coverage(
        &self,
        project_id: &ProjectId,
        request: &SymbolCoverageQuery,
    ) -> Result<Vec<SymbolCoverageRecord>, StorageError> {
        validate_source_and_limit(request.source.as_deref(), request.limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), population AS (
                    SELECT COUNT(*)::double precision AS symbol_count
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    WHERE symbols.project_id = CAST($1 AS uuid)
                      AND symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
                ), incoming AS (
                    SELECT edges.target_symbol_id, SUM(edges.site_count)::bigint AS edge_count
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND edges.edge_kind <> 'contains'
                    GROUP BY edges.target_symbol_id
                ), test_pressure AS (
                    SELECT edges.target_symbol_id,
                           COUNT(DISTINCT files.file_id)::bigint AS test_files
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    JOIN {schema}."symbols" AS sources
                      ON sources.project_id = edges.project_id
                     AND sources.generation_id = edges.generation_id
                     AND sources.symbol_id = edges.source_symbol_id
                    JOIN {schema}."files" AS files
                     ON files.project_id = sources.project_id
                     AND files.generation_id = sources.generation_id
                     AND files.file_id = sources.file_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND (
                          files.normalized_path ~* '(^|/)(__tests__|tests?|specs?)(/|$)'
                          OR files.normalized_path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)'
                          OR EXISTS (
                              SELECT 1
                              FROM {schema}."search_documents" AS documents
                              WHERE documents.project_id = files.project_id
                                AND documents.generation_id = files.generation_id
                                AND documents.file_id = files.file_id
                                AND documents.document_kind = 'test'
                          )
                      )
                    GROUP BY edges.target_symbol_id
                ), selected AS (
                    SELECT DISTINCT ON (coverage.symbol_id)
                           coverage.symbol_id, coverage.project_id, coverage.generation_id,
                           coverage.lines_found, coverage.lines_hit,
                           coverage.coverage_fraction, sources.label
                    FROM {schema}."symbol_coverage" AS coverage
                    JOIN current ON current.generation_id = coverage.generation_id
                    JOIN {schema}."coverage_sources" AS sources
                      ON sources.project_id = coverage.project_id
                     AND sources.source_id = coverage.source_id
                    WHERE coverage.project_id = CAST($1 AS uuid)
                      AND ($2::text IS NULL OR sources.label = $2)
                    ORDER BY coverage.symbol_id,
                             coverage.coverage_fraction DESC NULLS LAST,
                             sources.label
                ), scored AS (
                    SELECT selected.symbol_id, files.normalized_path, files.language,
                           symbols.symbol_kind, symbols.qualified_name, selected.label,
                           selected.lines_found, selected.lines_hit,
                           selected.coverage_fraction,
                           COALESCE(incoming.edge_count, 0)::bigint AS incoming_edges,
                           COALESCE(test_pressure.test_files, 0)::bigint AS direct_test_files,
                           LEAST(
                               1.0,
                               COALESCE(incoming.edge_count, 0)::double precision
                               / GREATEST(population.symbol_count - 1.0, 1.0)
                           ) AS degree_centrality
                    FROM selected
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = selected.project_id
                     AND symbols.generation_id = selected.generation_id
                     AND symbols.symbol_id = selected.symbol_id
                    JOIN {schema}."files" AS files
                      ON files.project_id = symbols.project_id
                     AND files.generation_id = symbols.generation_id
                     AND files.file_id = symbols.file_id
                    CROSS JOIN population
                    LEFT JOIN incoming ON incoming.target_symbol_id = selected.symbol_id
                    LEFT JOIN test_pressure
                      ON test_pressure.target_symbol_id = selected.symbol_id
                )
                SELECT symbol_id::text, normalized_path, language, symbol_kind,
                       qualified_name, label, lines_found, lines_hit, coverage_fraction,
                       incoming_edges, direct_test_files, degree_centrality
                FROM scored
                WHERE ($3::text IS NULL OR symbol_id = CAST($3 AS uuid))
                  AND ($4::boolean OR NOT (
                      normalized_path ~* '(^|/)(__tests__|tests?|specs?)(/|$)'
                      OR normalized_path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)'
                  ))
                  AND ($5::double precision IS NULL
                       OR COALESCE(coverage_fraction, 0.0) <= $5)
                  AND ($6::double precision IS NULL OR degree_centrality >= $6)
                  AND ($7::text[] IS NULL OR symbol_kind = ANY($7))
                  AND ($8::text IS NULL OR LEFT(normalized_path, LENGTH($8)) = $8)
                ORDER BY coverage_fraction ASC NULLS FIRST,
                         degree_centrality DESC, incoming_edges DESC,
                         normalized_path, qualified_name, symbol_id
                LIMIT $9"#,
        );
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
