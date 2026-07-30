use std::{collections::BTreeMap, time::Duration};

use cartograph_domain::{NormalizedPath, ProjectId, SourceLanguage};
use serde::Serialize;
use sqlx_core::row::Row;

use crate::{
    CartographDatabase, StorageError,
    database::{PgQuery, RowReadRequest, quoted_schema, read_rows},
};

const FILE_QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_FILE_ROWS: u16 = 2_000;
const MAX_FILE_DEPENDENCY_ROWS: u16 = 500;
const MAX_PATH_REGEX_BYTES: usize = 8_192;

/// Database-side file inventory filters applied before the response cap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSurfaceQuery {
    directory: Option<NormalizedPath>,
    language: Option<SourceLanguage>,
    path_regex: Option<String>,
    limit: u16,
}

impl FileSurfaceQuery {
    /// Build a bounded inventory query.
    /// # Errors
    ///
    /// Returns an error if `limit` is zero or exceeds the file-surface row cap.
    pub fn new(limit: u16) -> Result<Self, StorageError> {
        validate_limit(limit, MAX_FILE_ROWS, "file_surface_limit")?;
        Ok(Self {
            directory: None,
            language: None,
            path_regex: None,
            limit,
        })
    }

    /// Restrict rows to one exact directory subtree.
    #[must_use]
    pub fn within_directory(mut self, directory: NormalizedPath) -> Self {
        self.directory = Some(directory);
        self
    }

    /// Restrict rows to one supported language.
    #[must_use]
    pub const fn with_language(mut self, language: SourceLanguage) -> Self {
        self.language = Some(language);
        self
    }

    /// Apply an anchored PostgreSQL regular expression generated from a bounded glob.
    /// # Errors
    ///
    /// Returns an error if the optional expression is empty, contains a NUL
    /// byte, or exceeds the path-regex byte bound.
    pub fn with_path_regex(mut self, regex: Option<&str>) -> Result<Self, StorageError> {
        if regex.is_some_and(|value| {
            value.is_empty() || value.len() > MAX_PATH_REGEX_BYTES || value.contains('\0')
        }) {
            return Err(StorageError::InvalidInput {
                field: "file_path_regex",
            });
        }
        self.path_regex = regex.map(ToOwned::to_owned);
        Ok(self)
    }
}

/// One current file with exact structural counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSurfaceRow {
    path: String,
    language: String,
    byte_size: u64,
    parse_status: String,
    symbol_count: u64,
}

impl FileSurfaceRow {
    #[must_use]
    /// Returns the path.
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    /// Returns the language.
    pub fn language(&self) -> &str {
        &self.language
    }

    #[must_use]
    /// Returns the byte size.
    pub const fn byte_size(&self) -> u64 {
        self.byte_size
    }

    #[must_use]
    /// Returns the symbol count.
    pub const fn symbol_count(&self) -> u64 {
        self.symbol_count
    }
}

/// Exact pre-limit inventory totals plus a bounded path-ordered page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSurfaceResult {
    files: Vec<FileSurfaceRow>,
    total_files: u64,
    total_bytes: u64,
    total_symbols: u64,
    truncated: bool,
}

/// Exact full-filter language rollup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLanguageAggregate {
    language: String,
    files: u64,
    symbols: u64,
    bytes: u64,
}

/// Recursive directory rollup; each file contributes to every ancestor directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDirectoryAggregate {
    path: String,
    files: u64,
    symbols: u64,
    bytes: u64,
}

/// Complete language totals plus a bounded recursive directory page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAggregateResult {
    languages: Vec<FileLanguageAggregate>,
    directories: Vec<FileDirectoryAggregate>,
    total_directories: u64,
    directories_truncated: bool,
}

impl FileAggregateResult {
    #[must_use]
    /// Returns the languages.
    pub fn languages(&self) -> &[FileLanguageAggregate] {
        &self.languages
    }

    #[must_use]
    /// Returns the directories.
    pub fn directories(&self) -> &[FileDirectoryAggregate] {
        &self.directories
    }

    #[must_use]
    /// Returns whether additional matching directories were omitted.
    pub const fn directories_truncated(&self) -> bool {
        self.directories_truncated
    }
}

impl FileSurfaceResult {
    #[must_use]
    /// Returns the files.
    pub fn files(&self) -> &[FileSurfaceRow] {
        &self.files
    }

    #[must_use]
    /// Returns the total files.
    pub const fn total_files(&self) -> u64 {
        self.total_files
    }

    #[must_use]
    /// Returns the total bytes.
    pub const fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    #[must_use]
    /// Returns the total symbols.
    pub const fn total_symbols(&self) -> u64 {
        self.total_symbols
    }

    #[must_use]
    /// Whether the file limit omitted additional matching rows.
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

/// Direction for one file's cross-file graph relationships.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileDependencyDirection {
    /// Return files referenced by the anchor file.
    Dependencies,
    /// Return files that reference the anchor file.
    Dependents,
    #[default]
    /// Return both dependencies and dependents.
    Both,
}

impl FileDependencyDirection {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Dependencies => "dependencies",
            Self::Dependents => "dependents",
            Self::Both => "both",
        }
    }
}

/// Independently bounded dependency/dependent request for one exact indexed path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileDependencyQuery {
    path: NormalizedPath,
    direction: FileDependencyDirection,
    per_direction_limit: u16,
}

impl FileDependencyQuery {
    /// Creates a validated file dependency query.
    ///
    /// # Errors
    ///
    /// Returns an error if `per_direction_limit` is zero or exceeds the
    /// bounded adjacent-file row maximum.
    pub fn new(path: NormalizedPath, per_direction_limit: u16) -> Result<Self, StorageError> {
        validate_limit(
            per_direction_limit,
            MAX_FILE_DEPENDENCY_ROWS,
            "file_dependency_limit",
        )?;
        Ok(Self {
            path,
            direction: FileDependencyDirection::Both,
            per_direction_limit,
        })
    }

    #[must_use]
    /// Sets the direction and returns the updated value.
    pub const fn with_direction(mut self, direction: FileDependencyDirection) -> Self {
        self.direction = direction;
        self
    }
}

/// One adjacent file with aggregated edge kinds and exact represented sites.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDependencyRow {
    direction: String,
    path: String,
    language: String,
    edge_count: u64,
    site_count: u64,
    edge_kinds: Vec<String>,
}

/// Exact pre-limit counts and independently capped adjacent-file groups.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDependencyResult {
    rows: Vec<FileDependencyRow>,
    counts: BTreeMap<String, u64>,
    truncated: BTreeMap<String, bool>,
}

impl FileDependencyResult {
    #[must_use]
    /// Returns the rows.
    pub fn rows(&self) -> &[FileDependencyRow] {
        &self.rows
    }
}

impl CartographDatabase {
    /// Return a file inventory whose directory/language/glob filters precede LIMIT.
    /// # Errors
    ///
    /// Returns an error if the row limit is invalid or filtered current-file
    /// records and their structural counts cannot be queried or decoded.
    pub async fn current_file_surface(
        &self,
        project_id: &ProjectId,
        request: &FileSurfaceQuery,
    ) -> Result<FileSurfaceResult, StorageError> {
        validate_limit(request.limit, MAX_FILE_ROWS, "file_surface_limit")?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), selected AS (
                    SELECT files.normalized_path, files.language, files.byte_size,
                           files.parse_status,
                           COUNT(symbols.symbol_id) FILTER (
                               WHERE symbols.symbol_kind <> 'file'
                           )::bigint AS symbol_count
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    LEFT JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = files.project_id
                     AND symbols.generation_id = files.generation_id
                     AND symbols.file_id = files.file_id
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND ($2::text IS NULL
                           OR files.normalized_path = $2
                           OR LEFT(files.normalized_path, LENGTH($2) + 1) = $2 || '/')
                      AND ($3::text IS NULL OR files.language = $3)
                      AND ($4::text IS NULL OR files.normalized_path ~ $4)
                    GROUP BY files.file_id, files.normalized_path, files.language,
                             files.byte_size, files.parse_status
                )
                SELECT normalized_path, language, byte_size, parse_status, symbol_count,
                       COUNT(*) OVER ()::bigint AS total_files,
                       SUM(byte_size) OVER ()::bigint AS total_bytes,
                       SUM(symbol_count) OVER ()::bigint AS total_symbols
                FROM selected
                ORDER BY normalized_path
                LIMIT $5"#,
        );
        let rows = self
            .file_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(request.directory.as_ref().map(NormalizedPath::as_str))
                        .bind(request.language.map(SourceLanguage::as_str))
                        .bind(request.path_regex.as_deref())
                        .bind(i64::from(request.limit))
                },
                "current-file-surface",
            )
            .await?;
        let total_files = rows
            .first()
            .map(|row| nonnegative_u64(row, 5))
            .transpose()?
            .unwrap_or(0);
        let total_bytes = rows
            .first()
            .map(|row| nonnegative_u64(row, 6))
            .transpose()?
            .unwrap_or(0);
        let total_symbols = rows
            .first()
            .map(|row| nonnegative_u64(row, 7))
            .transpose()?
            .unwrap_or(0);
        let files = rows
            .iter()
            .map(decode_file_surface)
            .collect::<Result<_, _>>()?;
        Ok(FileSurfaceResult {
            files,
            total_files,
            total_bytes,
            total_symbols,
            truncated: total_files > u64::from(request.limit),
        })
    }

    /// Aggregate the complete filtered file set before any directory output cap.
    /// # Errors
    ///
    /// Returns an error if `directory_limit` is invalid or the complete
    /// filtered aggregate cannot be queried, bounded, or decoded.
    pub async fn current_file_aggregates(
        &self,
        project_id: &ProjectId,
        request: &FileSurfaceQuery,
        directory_limit: u16,
    ) -> Result<FileAggregateResult, StorageError> {
        validate_limit(directory_limit, MAX_FILE_ROWS, "file_aggregate_limit")?;
        let schema = quoted_schema(&self.schema);
        let statement = include_str!("sql/file_aggregates.sql").replace("{schema}", &schema);
        let rows = self
            .file_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(request.directory.as_ref().map(NormalizedPath::as_str))
                        .bind(request.language.map(SourceLanguage::as_str))
                        .bind(request.path_regex.as_deref())
                        .bind(i64::from(directory_limit))
                },
                "current-file-aggregates",
            )
            .await?;
        let mut languages = Vec::new();
        let mut directories = Vec::new();
        let mut total_directories = 0_u64;
        for row in &rows {
            match text(row, 0)?.as_str() {
                "language" => languages.push(FileLanguageAggregate {
                    language: text(row, 1)?,
                    files: nonnegative_u64(row, 2)?,
                    symbols: nonnegative_u64(row, FILE_AGGREGATE_SYMBOLS_COLUMN)?,
                    bytes: nonnegative_u64(row, FILE_AGGREGATE_BYTES_COLUMN)?,
                }),
                "directory" => {
                    total_directories =
                        nonnegative_u64(row, FILE_AGGREGATE_DIRECTORY_TOTAL_COLUMN)?;
                    directories.push(FileDirectoryAggregate {
                        path: text(row, 1)?,
                        files: nonnegative_u64(row, 2)?,
                        symbols: nonnegative_u64(row, FILE_AGGREGATE_SYMBOLS_COLUMN)?,
                        bytes: nonnegative_u64(row, FILE_AGGREGATE_BYTES_COLUMN)?,
                    });
                }
                _ => return Err(corrupt("file_aggregate_kind")),
            }
        }
        Ok(FileAggregateResult {
            languages,
            directories,
            total_directories,
            directories_truncated: total_directories > u64::from(directory_limit),
        })
    }

    /// Aggregate cross-file structural edges with independent direction caps.
    /// # Errors
    ///
    /// Returns an error if the per-direction bound is invalid or current
    /// cross-file edges cannot be queried, aggregated, or decoded.
    pub async fn current_file_dependencies(
        &self,
        project_id: &ProjectId,
        request: &FileDependencyQuery,
    ) -> Result<FileDependencyResult, StorageError> {
        validate_limit(
            request.per_direction_limit,
            MAX_FILE_DEPENDENCY_ROWS,
            "file_dependency_limit",
        )?;
        let schema = quoted_schema(&self.schema);
        let statement = include_str!("sql/file_dependencies.sql").replace("{schema}", &schema);
        let rows = self
            .file_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(request.path.as_str())
                        .bind(request.direction.as_str())
                        .bind(i64::from(request.per_direction_limit))
                },
                "current-file-dependencies",
            )
            .await?;
        let mut counts = BTreeMap::from([
            ("dependencies".to_owned(), 0_u64),
            ("dependents".to_owned(), 0_u64),
        ]);
        let mut output = Vec::with_capacity(rows.len());
        for row in &rows {
            counts.insert(text(row, 0)?, nonnegative_u64(row, 6)?);
            output.push(decode_file_dependency(row)?);
        }
        let truncated = counts
            .iter()
            .map(|(direction, count)| {
                (
                    direction.clone(),
                    *count > u64::from(request.per_direction_limit),
                )
            })
            .collect();
        Ok(FileDependencyResult {
            rows: output,
            counts,
            truncated,
        })
    }

    async fn file_rows<'query>(
        &self,
        statement: String,
        bind: impl FnOnce(PgQuery<'query>) -> PgQuery<'query>,
        operation: &'static str,
    ) -> Result<Vec<sqlx_postgres::PgRow>, StorageError> {
        let request = RowReadRequest::new(statement, operation, FILE_QUERY_TIMEOUT);
        read_rows(self, request, bind).await
    }
}

fn decode_file_surface(row: &sqlx_postgres::PgRow) -> Result<FileSurfaceRow, StorageError> {
    Ok(FileSurfaceRow {
        path: text(row, 0)?,
        language: text(row, 1)?,
        byte_size: nonnegative_u64(row, 2)?,
        parse_status: text(row, 3)?,
        symbol_count: nonnegative_u64(row, 4)?,
    })
}

const FILE_AGGREGATE_SYMBOLS_COLUMN: usize = 3;
const FILE_AGGREGATE_BYTES_COLUMN: usize = 4;
const FILE_AGGREGATE_DIRECTORY_TOTAL_COLUMN: usize = 5;
const FILE_DEPENDENCY_EDGE_COUNT_COLUMN: usize = 3;
const FILE_DEPENDENCY_SITE_COUNT_COLUMN: usize = 4;
const FILE_DEPENDENCY_EDGE_KINDS_COLUMN: usize = 5;

fn decode_file_dependency(row: &sqlx_postgres::PgRow) -> Result<FileDependencyRow, StorageError> {
    Ok(FileDependencyRow {
        direction: text(row, 0)?,
        path: text(row, 1)?,
        language: text(row, 2)?,
        edge_count: nonnegative_u64(row, FILE_DEPENDENCY_EDGE_COUNT_COLUMN)?,
        site_count: nonnegative_u64(row, FILE_DEPENDENCY_SITE_COUNT_COLUMN)?,
        edge_kinds: row
            .try_get(FILE_DEPENDENCY_EDGE_KINDS_COLUMN)
            .map_err(|_| corrupt("file_dependency_kinds"))?,
    })
}

fn validate_limit(limit: u16, maximum: u16, field: &'static str) -> Result<(), StorageError> {
    if limit == 0 || limit > maximum {
        Err(StorageError::InvalidInput { field })
    } else {
        Ok(())
    }
}

fn text(row: &sqlx_postgres::PgRow, index: usize) -> Result<String, StorageError> {
    row.try_get(index).map_err(|_| corrupt("file_intelligence"))
}

fn nonnegative_u64(row: &sqlx_postgres::PgRow, index: usize) -> Result<u64, StorageError> {
    let value = row
        .try_get::<i64, _>(index)
        .map_err(|_| corrupt("file_intelligence"))?;
    u64::try_from(value).map_err(|_| corrupt("file_intelligence"))
}

const fn corrupt(field: &'static str) -> StorageError {
    StorageError::CorruptStoredValue { field }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_queries_reject_unbounded_inputs() {
        assert!(FileSurfaceQuery::new(0).is_err());
        assert!(FileSurfaceQuery::new(MAX_FILE_ROWS + 1).is_err());
        assert!(FileSurfaceQuery::new(MAX_FILE_ROWS).is_ok());
        assert!(
            FileSurfaceQuery::new(1)
                .and_then(|query| query.with_path_regex(Some(&"x".repeat(MAX_PATH_REGEX_BYTES + 1))))
                .is_err()
        );
        let path = NormalizedPath::parse("src/lib.rs")
            .unwrap_or_else(|error| panic!("fixture path failed: {error}"));
        assert!(FileDependencyQuery::new(path, MAX_FILE_DEPENDENCY_ROWS + 1).is_err());
    }
}
