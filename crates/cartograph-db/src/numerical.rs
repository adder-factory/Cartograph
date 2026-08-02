//! Generation-fenced, read-only access to privacy-safe numerical source evidence.

use std::{collections::BTreeMap, time::Duration};

use cartograph_domain::{
    ContentDigest, FileId, GenerationId, NormalizedPath, NumericalSiteId, SymbolId,
};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, CurrentGenerationLookup, StorageError,
    retrieval::{begin_bounded_read, commit_bounded_read, require_expected_current_generation},
};

const MAXIMUM_SITE_LIMIT: u16 = 100;
const MAXIMUM_CATEGORY_BYTES: usize = 64;
const MAXIMUM_BREAKDOWN_VALUES: i64 = 64;
const DEFAULT_NUMERICAL_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Validated filters for one bounded current-generation numerical-site page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NumericalSiteQuery {
    limit: u16,
    path_prefix: Option<NormalizedPath>,
    owner_symbol_id: Option<SymbolId>,
    operation: Option<String>,
    hazard: Option<String>,
    precision: Option<String>,
    evidence_level: Option<String>,
    minimum_confidence_ppm: u32,
    hazards_only: bool,
}

impl NumericalSiteQuery {
    /// Create one bounded page request.
    /// # Errors
    ///
    /// Returns an error when `limit` is zero or exceeds the public result ceiling.
    pub fn new(limit: u16) -> Result<Self, StorageError> {
        if limit == 0 || limit > MAXIMUM_SITE_LIMIT {
            return Err(invalid("numerical_site_limit"));
        }
        Ok(Self {
            limit,
            path_prefix: None,
            owner_symbol_id: None,
            operation: None,
            hazard: None,
            precision: None,
            evidence_level: None,
            minimum_confidence_ppm: 0,
            hazards_only: false,
        })
    }

    /// Restrict the page to one exact path or directory prefix.
    /// # Errors
    ///
    /// Returns an error when the path is not a validated project-relative path.
    pub fn with_path_prefix(mut self, value: Option<&str>) -> Result<Self, StorageError> {
        self.path_prefix = value
            .map(NormalizedPath::parse)
            .transpose()
            .map_err(|_| invalid("numerical_path_prefix"))?;
        Ok(self)
    }

    /// Restrict the page to one exact owning symbol.
    #[must_use]
    pub fn with_owner_symbol_id(mut self, value: Option<SymbolId>) -> Self {
        self.owner_symbol_id = value;
        self
    }

    /// Restrict the page to one stable operation category.
    /// # Errors
    ///
    /// Returns an error when the category is not a bounded machine token.
    pub fn with_operation(mut self, value: Option<&str>) -> Result<Self, StorageError> {
        self.operation = validated_filter(value, "numerical_operation")?;
        Ok(self)
    }

    /// Restrict the page to one stable hazard category.
    /// # Errors
    ///
    /// Returns an error when the category is not a bounded machine token.
    pub fn with_hazard(mut self, value: Option<&str>) -> Result<Self, StorageError> {
        self.hazard = validated_filter(value, "numerical_hazard")?;
        Ok(self)
    }

    /// Restrict the page to one stable precision category.
    /// # Errors
    ///
    /// Returns an error when the category is not a bounded machine token.
    pub fn with_precision(mut self, value: Option<&str>) -> Result<Self, StorageError> {
        self.precision = validated_filter(value, "numerical_precision")?;
        Ok(self)
    }

    /// Restrict the page to one explicit evidence level.
    /// # Errors
    ///
    /// Returns an error when the value is not a source-derived evidence level.
    pub fn with_evidence_level(mut self, value: Option<&str>) -> Result<Self, StorageError> {
        if value.is_some_and(|value| !matches!(value, "proven" | "heuristic" | "coverage_gap")) {
            return Err(invalid("numerical_evidence_level"));
        }
        self.evidence_level = value.map(ToOwned::to_owned);
        Ok(self)
    }

    /// Require at least the supplied deterministic confidence in parts per million.
    /// # Errors
    ///
    /// Returns an error when the value is above one million.
    pub fn with_minimum_confidence_ppm(mut self, value: u32) -> Result<Self, StorageError> {
        if value > 1_000_000 {
            return Err(invalid("numerical_minimum_confidence_ppm"));
        }
        self.minimum_confidence_ppm = value;
        Ok(self)
    }

    /// Omit sites whose current static pass observed no named hazard.
    #[must_use]
    pub const fn with_hazards_only(mut self, value: bool) -> Self {
        self.hazards_only = value;
        self
    }
}

/// One exact, privacy-safe current-generation numerical source site.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NumericalSiteRecord {
    generation_id: GenerationId,
    numerical_site_id: NumericalSiteId,
    file_id: FileId,
    path: NormalizedPath,
    language: String,
    owner_symbol_id: Option<SymbolId>,
    owner_qualified_name: Option<String>,
    start_byte: u64,
    end_byte: u64,
    start_line: u32,
    end_line: u32,
    operation: String,
    hazard: String,
    precision: String,
    expression_digest: ContentDigest,
    confidence_ppm: u32,
    provenance: String,
    evidence_level: String,
    unknowns: Vec<String>,
}

impl NumericalSiteRecord {
    /// Immutable generation containing this site.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Stable numerical-site identity.
    #[must_use]
    pub const fn numerical_site_id(&self) -> &NumericalSiteId {
        &self.numerical_site_id
    }

    /// Source file containing this site.
    #[must_use]
    pub const fn file_id(&self) -> &FileId {
        &self.file_id
    }

    /// Project-relative source path.
    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    /// Closest containing declaration, when extraction proved one.
    #[must_use]
    pub const fn owner_symbol_id(&self) -> Option<&SymbolId> {
        self.owner_symbol_id.as_ref()
    }

    /// Stable operation category.
    #[must_use]
    pub fn operation(&self) -> &str {
        &self.operation
    }

    /// Potential-hazard category, or `none_observed`.
    #[must_use]
    pub fn hazard(&self) -> &str {
        &self.hazard
    }

    /// Best statically visible precision category.
    #[must_use]
    pub fn precision(&self) -> &str {
        &self.precision
    }

    /// Evidence tier, independent of confidence.
    #[must_use]
    pub fn evidence_level(&self) -> &str {
        &self.evidence_level
    }

    /// Facts that this static analyzer could not prove.
    #[must_use]
    pub fn unknowns(&self) -> &[String] {
        &self.unknowns
    }
}

/// Exact pre-limit cardinality plus one deterministic numerical-site page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NumericalSitePage {
    generation_id: GenerationId,
    total: u64,
    sites: Vec<NumericalSiteRecord>,
    truncated: bool,
}

impl NumericalSitePage {
    /// Immutable generation queried by this page.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Complete count before the page cap.
    #[must_use]
    pub const fn total(&self) -> u64 {
        self.total
    }

    /// Deterministically ordered page rows.
    #[must_use]
    pub fn sites(&self) -> &[NumericalSiteRecord] {
        &self.sites
    }

    /// Whether additional matching sites were omitted.
    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

/// Complete current-generation static numerical readiness rollup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NumericalSiteStats {
    generation_id: GenerationId,
    total_sites: u64,
    hazard_sites: u64,
    unknown_precision_sites: u64,
    sites_with_unknowns: u64,
    supported_files: u64,
    analyzed_files: u64,
    unanalyzed_files: u64,
    files_with_sites: u64,
    symbols_with_sites: u64,
    by_operation: BTreeMap<String, u64>,
    by_hazard: BTreeMap<String, u64>,
    by_precision: BTreeMap<String, u64>,
    by_evidence_level: BTreeMap<String, u64>,
    by_provenance: BTreeMap<String, u64>,
    by_language: BTreeMap<String, u64>,
    breakdowns_truncated: bool,
}

impl NumericalSiteStats {
    /// Immutable generation summarized by this rollup.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Complete number of persisted static numerical sites.
    #[must_use]
    pub const fn total_sites(&self) -> u64 {
        self.total_sites
    }

    /// Sites whose static pass named a potential hazard.
    #[must_use]
    pub const fn hazard_sites(&self) -> u64 {
        self.hazard_sites
    }

    /// Whether at least one static site is queryable in this generation.
    #[must_use]
    pub const fn has_sites(&self) -> bool {
        self.total_sites > 0
    }

    /// Number of current-generation Rust files covered by the MVP analyzer contract.
    #[must_use]
    pub const fn supported_files(&self) -> u64 {
        self.supported_files
    }

    /// Number of supported files whose parsed or partial syntax tree was analyzed.
    #[must_use]
    pub const fn analyzed_files(&self) -> u64 {
        self.analyzed_files
    }

    /// Number of supported files skipped or failed before numerical analysis.
    #[must_use]
    pub const fn unanalyzed_files(&self) -> u64 {
        self.unanalyzed_files
    }

    /// Supported files containing at least one numerical site.
    #[must_use]
    pub const fn files_with_sites(&self) -> u64 {
        self.files_with_sites
    }
}

impl CartographDatabase {
    /// Query one deterministic page from an exact current generation.
    /// # Errors
    ///
    /// Returns an error when the generation fence changes, filters are invalid,
    /// PostgreSQL exceeds the bounded deadline, or a stored row violates its schema.
    pub async fn current_numerical_sites(
        &self,
        lookup: CurrentGenerationLookup<'_>,
        request: &NumericalSiteQuery,
    ) -> Result<NumericalSitePage, StorageError> {
        let mut transaction = begin_bounded_read(self, DEFAULT_NUMERICAL_READ_TIMEOUT).await?;
        require_expected_current_generation(&mut transaction, &self.schema, lookup).await?;
        let schema = crate::database::quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT sites.generation_id::text, sites.numerical_site_id::text,
                       sites.file_id::text, files.normalized_path, files.language,
                       sites.owner_symbol_id::text, owners.qualified_name,
                       sites.start_byte, sites.end_byte, sites.start_line, sites.end_line,
                       sites.operation, sites.hazard, sites.precision,
                       sites.expression_digest, sites.confidence_ppm,
                       sites.provenance, sites.evidence_level, sites.unknowns,
                       COUNT(*) OVER ()::bigint AS total
                FROM {schema}."numerical_sites" AS sites
                JOIN {schema}."files" AS files
                  ON files.project_id = sites.project_id
                 AND files.generation_id = sites.generation_id
                 AND files.file_id = sites.file_id
                LEFT JOIN {schema}."symbols" AS owners
                  ON owners.project_id = sites.project_id
                 AND owners.generation_id = sites.generation_id
                 AND owners.symbol_id = sites.owner_symbol_id
                WHERE sites.project_id = CAST($1 AS uuid)
                  AND sites.generation_id = CAST($2 AS uuid)
                  AND ($3::text IS NULL
                       OR files.normalized_path = $3
                       OR LEFT(files.normalized_path, LENGTH($3) + 1) = $3 || '/')
                  AND ($4::uuid IS NULL OR sites.owner_symbol_id = $4::uuid)
                  AND ($5::text IS NULL OR sites.operation = $5)
                  AND ($6::text IS NULL OR sites.hazard = $6)
                  AND ($7::text IS NULL OR sites.precision = $7)
                  AND ($8::text IS NULL OR sites.evidence_level = $8)
                  AND sites.confidence_ppm >= $9
                  AND (NOT $10::boolean OR sites.hazard <> 'none_observed')
                ORDER BY (sites.hazard = 'none_observed'), sites.confidence_ppm DESC,
                         files.normalized_path, sites.start_line, sites.start_byte,
                         sites.numerical_site_id
                LIMIT $11"#,
        );
        let rows = query(AssertSqlSafe(statement))
            .bind(lookup.project_id().as_str())
            .bind(lookup.expected_generation_id().as_str())
            .bind(request.path_prefix.as_ref().map(NormalizedPath::as_str))
            .bind(request.owner_symbol_id.as_ref().map(SymbolId::as_str))
            .bind(request.operation.as_deref())
            .bind(request.hazard.as_deref())
            .bind(request.precision.as_deref())
            .bind(request.evidence_level.as_deref())
            .bind(
                i32::try_from(request.minimum_confidence_ppm)
                    .map_err(|_| invalid("numerical_minimum_confidence_ppm"))?,
            )
            .bind(request.hazards_only)
            .bind(i64::from(request.limit))
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| database_error("current-numerical-sites"))?;
        commit_bounded_read(transaction, "current-numerical-sites-commit").await?;
        let total = rows
            .first()
            .map(|row| nonnegative_u64(row, "total"))
            .transpose()?
            .unwrap_or(0);
        let sites = rows
            .iter()
            .map(decode_site)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(NumericalSitePage {
            generation_id: lookup.expected_generation_id().clone(),
            total,
            truncated: total > u64::try_from(sites.len()).unwrap_or(u64::MAX),
            sites,
        })
    }

    /// Aggregate all static numerical sites in one exact current generation.
    /// # Errors
    ///
    /// Returns an error when the generation fence changes, PostgreSQL exceeds
    /// the bounded deadline, or an aggregate violates its typed contract.
    pub async fn current_numerical_site_stats(
        &self,
        lookup: CurrentGenerationLookup<'_>,
    ) -> Result<NumericalSiteStats, StorageError> {
        let mut transaction = begin_bounded_read(self, DEFAULT_NUMERICAL_READ_TIMEOUT).await?;
        require_expected_current_generation(&mut transaction, &self.schema, lookup).await?;
        let schema = crate::database::quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH selected AS (
                    SELECT sites.operation, sites.hazard, sites.precision,
                           sites.evidence_level, sites.provenance, sites.unknowns,
                           sites.file_id, sites.owner_symbol_id, files.language
                    FROM {schema}."numerical_sites" AS sites
                    JOIN {schema}."files" AS files
                      ON files.project_id = sites.project_id
                     AND files.generation_id = sites.generation_id
                     AND files.file_id = sites.file_id
                    WHERE sites.project_id = CAST($1 AS uuid)
                      AND sites.generation_id = CAST($2 AS uuid)
                ), file_coverage AS (
                    SELECT COUNT(*) FILTER (WHERE language = 'rust')::bigint AS supported_files,
                           COUNT(*) FILTER (
                               WHERE language = 'rust'
                                 AND parse_status IN ('parsed', 'partial')
                           )::bigint AS analyzed_files,
                           COUNT(*) FILTER (
                               WHERE language = 'rust'
                                 AND parse_status NOT IN ('parsed', 'partial')
                           )::bigint AS unanalyzed_files
                    FROM {schema}."files"
                    WHERE project_id = CAST($1 AS uuid)
                      AND generation_id = CAST($2 AS uuid)
                ), totals AS (
                    SELECT COUNT(*)::bigint AS total_sites,
                           COUNT(*) FILTER (WHERE hazard <> 'none_observed')::bigint AS hazard_sites,
                           COUNT(*) FILTER (WHERE precision = 'unknown')::bigint AS unknown_precision_sites,
                           COUNT(*) FILTER (WHERE unknowns <> '')::bigint AS sites_with_unknowns,
                           COUNT(DISTINCT file_id)::bigint AS files_with_sites,
                           COUNT(DISTINCT owner_symbol_id) FILTER (WHERE owner_symbol_id IS NOT NULL)::bigint AS symbols_with_sites,
                           COUNT(DISTINCT operation)::bigint AS operation_values,
                           COUNT(DISTINCT hazard)::bigint AS hazard_values,
                           COUNT(DISTINCT precision)::bigint AS precision_values,
                           COUNT(DISTINCT evidence_level)::bigint AS evidence_values,
                           COUNT(DISTINCT provenance)::bigint AS provenance_values,
                           COUNT(DISTINCT language)::bigint AS language_values
                    FROM selected
                ), breakdown AS (
                    SELECT dimension, value, count FROM (
                        SELECT dimension, value, count,
                               ROW_NUMBER() OVER (PARTITION BY dimension ORDER BY count DESC, value) AS rank
                        FROM (
                            SELECT 'operation'::text AS dimension, operation AS value, COUNT(*)::bigint AS count FROM selected GROUP BY operation
                            UNION ALL SELECT 'hazard', hazard, COUNT(*)::bigint FROM selected GROUP BY hazard
                            UNION ALL SELECT 'precision', precision, COUNT(*)::bigint FROM selected GROUP BY precision
                            UNION ALL SELECT 'evidence_level', evidence_level, COUNT(*)::bigint FROM selected GROUP BY evidence_level
                            UNION ALL SELECT 'provenance', provenance, COUNT(*)::bigint FROM selected GROUP BY provenance
                            UNION ALL SELECT 'language', language, COUNT(*)::bigint FROM selected GROUP BY language
                        ) AS grouped
                    ) AS ranked
                    WHERE rank <= $3
                )
                SELECT totals.*, file_coverage.*,
                       breakdown.dimension, breakdown.value, breakdown.count
                FROM totals CROSS JOIN file_coverage LEFT JOIN breakdown ON true
                ORDER BY breakdown.dimension, breakdown.count DESC, breakdown.value"#,
        );
        let rows = query(AssertSqlSafe(statement))
            .bind(lookup.project_id().as_str())
            .bind(lookup.expected_generation_id().as_str())
            .bind(MAXIMUM_BREAKDOWN_VALUES)
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| database_error("current-numerical-site-stats"))?;
        commit_bounded_read(transaction, "current-numerical-site-stats-commit").await?;
        decode_stats(lookup.expected_generation_id().clone(), &rows)
    }
}

fn decode_site(row: &sqlx_postgres::PgRow) -> Result<NumericalSiteRecord, StorageError> {
    let unknowns = text(row, "unknowns")?;
    Ok(NumericalSiteRecord {
        generation_id: generation_id(row, "generation_id")?,
        numerical_site_id: NumericalSiteId::parse(&text(row, "numerical_site_id")?)
            .map_err(|_| corrupt("numerical_site_id"))?,
        file_id: FileId::parse(&text(row, "file_id")?).map_err(|_| corrupt("file_id"))?,
        path: NormalizedPath::parse(&text(row, "normalized_path")?)
            .map_err(|_| corrupt("normalized_path"))?,
        language: text(row, "language")?,
        owner_symbol_id: optional_text(row, "owner_symbol_id")?
            .map(|value| SymbolId::parse(&value).map_err(|_| corrupt("owner_symbol_id")))
            .transpose()?,
        owner_qualified_name: optional_text(row, "qualified_name")?,
        start_byte: nonnegative_u64(row, "start_byte")?,
        end_byte: nonnegative_u64(row, "end_byte")?,
        start_line: positive_u32(row, "start_line")?,
        end_line: positive_u32(row, "end_line")?,
        operation: text(row, "operation")?,
        hazard: text(row, "hazard")?,
        precision: text(row, "precision")?,
        expression_digest: ContentDigest::parse(&text(row, "expression_digest")?)
            .map_err(|_| corrupt("expression_digest"))?,
        confidence_ppm: nonnegative_u32(row, "confidence_ppm")?
            .filter(|value| *value <= 1_000_000)
            .ok_or_else(|| corrupt("confidence_ppm"))?,
        provenance: text(row, "provenance")?,
        evidence_level: text(row, "evidence_level")?,
        unknowns: if unknowns.is_empty() {
            Vec::new()
        } else {
            unknowns.split(',').map(ToOwned::to_owned).collect()
        },
    })
}

fn decode_stats(
    generation_id: GenerationId,
    rows: &[sqlx_postgres::PgRow],
) -> Result<NumericalSiteStats, StorageError> {
    let first = rows
        .first()
        .ok_or_else(|| database_error("current-numerical-site-stats"))?;
    let mut stats = NumericalSiteStats {
        generation_id,
        total_sites: nonnegative_u64(first, "total_sites")?,
        hazard_sites: nonnegative_u64(first, "hazard_sites")?,
        unknown_precision_sites: nonnegative_u64(first, "unknown_precision_sites")?,
        sites_with_unknowns: nonnegative_u64(first, "sites_with_unknowns")?,
        supported_files: nonnegative_u64(first, "supported_files")?,
        analyzed_files: nonnegative_u64(first, "analyzed_files")?,
        unanalyzed_files: nonnegative_u64(first, "unanalyzed_files")?,
        files_with_sites: nonnegative_u64(first, "files_with_sites")?,
        symbols_with_sites: nonnegative_u64(first, "symbols_with_sites")?,
        by_operation: BTreeMap::new(),
        by_hazard: BTreeMap::new(),
        by_precision: BTreeMap::new(),
        by_evidence_level: BTreeMap::new(),
        by_provenance: BTreeMap::new(),
        by_language: BTreeMap::new(),
        breakdowns_truncated: [
            "operation_values",
            "hazard_values",
            "precision_values",
            "evidence_values",
            "provenance_values",
            "language_values",
        ]
        .iter()
        .map(|field| nonnegative_u64(first, *field))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .any(|count| count > u64::try_from(MAXIMUM_BREAKDOWN_VALUES).unwrap_or(u64::MAX)),
    };
    for row in rows {
        let Some(dimension) = optional_text(row, "dimension")? else {
            continue;
        };
        let value = optional_text(row, "value")?.ok_or_else(|| corrupt("numerical_breakdown"))?;
        let count = nonnegative_u64(row, "count")?;
        let target = match dimension.as_str() {
            "operation" => &mut stats.by_operation,
            "hazard" => &mut stats.by_hazard,
            "precision" => &mut stats.by_precision,
            "evidence_level" => &mut stats.by_evidence_level,
            "provenance" => &mut stats.by_provenance,
            "language" => &mut stats.by_language,
            _ => return Err(corrupt("numerical_breakdown")),
        };
        target.insert(value, count);
    }
    Ok(stats)
}

fn validated_filter(
    value: Option<&str>,
    field: &'static str,
) -> Result<Option<String>, StorageError> {
    value
        .map(|value| {
            if value.is_empty()
                || value.len() > MAXIMUM_CATEGORY_BYTES
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
            {
                Err(invalid(field))
            } else {
                Ok(value.to_owned())
            }
        })
        .transpose()
}

fn text<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<String, StorageError>
where
    Index: sqlx_core::column::ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get(index).map_err(|_| corrupt("numerical_site"))
}

fn optional_text<Index>(
    row: &sqlx_postgres::PgRow,
    index: Index,
) -> Result<Option<String>, StorageError>
where
    Index: sqlx_core::column::ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get(index).map_err(|_| corrupt("numerical_site"))
}

fn generation_id<Index>(
    row: &sqlx_postgres::PgRow,
    index: Index,
) -> Result<GenerationId, StorageError>
where
    Index: sqlx_core::column::ColumnIndex<sqlx_postgres::PgRow>,
{
    GenerationId::parse(&text(row, index)?).map_err(|_| corrupt("generation_id"))
}

fn nonnegative_u64<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<u64, StorageError>
where
    Index: sqlx_core::column::ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get::<i64, _>(index)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| corrupt("numerical_site"))
}

fn nonnegative_u32<Index>(
    row: &sqlx_postgres::PgRow,
    index: Index,
) -> Result<Option<u32>, StorageError>
where
    Index: sqlx_core::column::ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get::<i32, _>(index)
        .ok()
        .map(u32::try_from)
        .transpose()
        .map_err(|_| corrupt("numerical_site"))
}

fn positive_u32<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<u32, StorageError>
where
    Index: sqlx_core::column::ColumnIndex<sqlx_postgres::PgRow>,
{
    nonnegative_u32(row, index)?
        .filter(|value| *value > 0)
        .ok_or_else(|| corrupt("numerical_site"))
}

const fn invalid(field: &'static str) -> StorageError {
    StorageError::InvalidInput { field }
}

const fn corrupt(field: &'static str) -> StorageError {
    StorageError::CorruptStoredValue { field }
}

const fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numerical_query_filters_are_bounded_machine_tokens() {
        assert!(NumericalSiteQuery::new(0).is_err());
        assert!(NumericalSiteQuery::new(MAXIMUM_SITE_LIMIT + 1).is_err());
        assert!(NumericalSiteQuery::new(1).is_ok());

        let query = NumericalSiteQuery::new(10)
            .and_then(|query| query.with_path_prefix(Some("src/numerical")))
            .and_then(|query| query.with_operation(Some("tolerance_comparison")))
            .and_then(|query| query.with_hazard(Some("absolute_only_tolerance")))
            .and_then(|query| query.with_precision(Some("f32")))
            .and_then(|query| query.with_evidence_level(Some("heuristic")))
            .and_then(|query| query.with_minimum_confidence_ppm(900_000));
        assert!(query.is_ok());

        for value in ["", "Uppercase", "contains-hyphen", "contains space"] {
            assert!(
                NumericalSiteQuery::new(1)
                    .and_then(|query| query.with_operation(Some(value)))
                    .is_err()
            );
        }
        assert!(
            NumericalSiteQuery::new(1)
                .and_then(|query| query.with_evidence_level(Some("observed")))
                .is_err()
        );
        assert!(
            NumericalSiteQuery::new(1)
                .and_then(|query| query.with_minimum_confidence_ppm(1_000_001))
                .is_err()
        );
    }
}
