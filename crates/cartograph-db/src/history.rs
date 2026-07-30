use std::time::Duration;

use cartograph_domain::{NormalizedPath, ProjectId};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, StorageError,
    database::{quoted_schema, set_local_statement_timeout},
};

const HISTORY_WRITE_TIMEOUT: Duration = Duration::from_mins(5);
const HISTORY_READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HISTORY_FILES: usize = 500_000;
const MAX_HISTORY_PAIRS: usize = 2_000_000;
const HISTORY_INSERT_CHUNK: usize = 5_000;
const MAX_HISTORY_QUERY_LIMIT: u16 = 500;

/// Aggregated Git history for one project-relative path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileHistoryFact {
    path: NormalizedPath,
    commit_count: u64,
    author_count: u64,
    insertions: u64,
    deletions: u64,
    last_touched_at: Option<u64>,
}

/// Validated churn counters for one file-history fact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileHistoryMetrics {
    /// Number of commit entries.
    pub commit_count: u64,
    /// Number of author entries.
    pub author_count: u64,
    /// Number of insertions.
    pub insertions: u64,
    /// Number of deletions.
    pub deletions: u64,
    /// Unix timestamp of the most recent change.
    pub last_touched_at: Option<u64>,
}

impl FileHistoryFact {
    /// Creates a validated file history fact.
    ///
    /// # Errors
    ///
    /// Returns an error if authors exceed commits or commit/timestamp presence
    /// is inconsistent.
    pub fn new(path: NormalizedPath, metrics: FileHistoryMetrics) -> Result<Self, StorageError> {
        if metrics.author_count > metrics.commit_count
            || (metrics.commit_count == 0) != metrics.last_touched_at.is_none()
        {
            return Err(StorageError::InvalidInput {
                field: "file_history",
            });
        }
        Ok(Self {
            path,
            commit_count: metrics.commit_count,
            author_count: metrics.author_count,
            insertions: metrics.insertions,
            deletions: metrics.deletions,
            last_touched_at: metrics.last_touched_at,
        })
    }
}

/// Aggregated same-commit relationship between two canonical paths.
#[derive(Clone, Debug, PartialEq)]
pub struct FileCochangeFact {
    path_a: NormalizedPath,
    path_b: NormalizedPath,
    commit_count: u64,
    confidence: f32,
}

/// Validated shared-commit metrics for one co-change pair.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileCochangeMetrics {
    /// Number of commit entries.
    pub commit_count: u64,
    /// Confidence for this record.
    pub confidence: f32,
}

impl FileCochangeFact {
    /// Creates a validated file cochange fact.
    ///
    /// # Errors
    ///
    /// Returns an error if paths are not strictly ordered/distinct, commits are
    /// zero, or confidence is non-finite or outside zero to one.
    pub fn new(
        path_a: NormalizedPath,
        path_b: NormalizedPath,
        metrics: FileCochangeMetrics,
    ) -> Result<Self, StorageError> {
        if path_a >= path_b
            || metrics.commit_count == 0
            || !metrics.confidence.is_finite()
            || !(0.0..=1.0).contains(&metrics.confidence)
        {
            return Err(StorageError::InvalidInput {
                field: "file_cochange",
            });
        }
        Ok(Self {
            path_a,
            path_b,
            commit_count: metrics.commit_count,
            confidence: metrics.confidence,
        })
    }
}

/// Atomic replacement of one repository-head history snapshot.
pub struct HistoryRefreshRequest {
    project_id: ProjectId,
    head_commit: String,
    shallow_history: bool,
    commits_scanned: u64,
    truncated: bool,
    oversized_commits_skipped: u64,
    files: Vec<FileHistoryFact>,
    cochanges: Vec<FileCochangeFact>,
}

/// Git-scan provenance kept separate from the durable relation batches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HistoryRefreshMetadata {
    /// Whether this value is shallow history.
    pub shallow_history: bool,
    /// Number of commits scanned.
    pub commits_scanned: u64,
    /// Whether additional matching rows were omitted.
    pub truncated: bool,
    /// Number of oversized commits skipped.
    pub oversized_commits_skipped: u64,
}

/// Bounded history and co-change rows supplied by one Git scan.
pub struct HistoryRefreshInput {
    /// Metadata for this record.
    pub metadata: HistoryRefreshMetadata,
    /// Bounded files included in this result.
    pub files: Vec<FileHistoryFact>,
    /// Bounded cochanges included in this result.
    pub cochanges: Vec<FileCochangeFact>,
}

impl HistoryRefreshRequest {
    /// Creates a validated history refresh request.
    ///
    /// # Errors
    ///
    /// Returns an error if the head commit is invalid or file/co-change payloads
    /// exceed their bounded refresh maxima.
    pub fn new(
        project_id: ProjectId,
        head_commit: impl Into<String>,
        input: HistoryRefreshInput,
    ) -> Result<Self, StorageError> {
        let head_commit = head_commit.into();
        if !valid_commit(&head_commit)
            || input.files.len() > MAX_HISTORY_FILES
            || input.cochanges.len() > MAX_HISTORY_PAIRS
        {
            return Err(StorageError::InvalidInput {
                field: "history_refresh",
            });
        }
        Ok(Self {
            project_id,
            head_commit,
            shallow_history: input.metadata.shallow_history,
            commits_scanned: input.metadata.commits_scanned,
            truncated: input.metadata.truncated,
            oversized_commits_skipped: input.metadata.oversized_commits_skipped,
            files: input.files,
            cochanges: input.cochanges,
        })
    }
}

/// Bounded current-file history query.
pub struct FileHistoryQuery<'query> {
    project_id: &'query ProjectId,
    path: Option<&'query NormalizedPath>,
    minimum_commits: u32,
    limit: u16,
}

impl<'query> FileHistoryQuery<'query> {
    #[must_use]
    /// Creates a validated file history query.
    pub const fn new(project_id: &'query ProjectId, limit: u16) -> Self {
        Self {
            project_id,
            path: None,
            minimum_commits: 0,
            limit,
        }
    }

    #[must_use]
    /// Returns the for path.
    pub const fn for_path(mut self, path: &'query NormalizedPath) -> Self {
        self.path = Some(path);
        self
    }

    #[must_use]
    /// Sets the minimum commits and returns the updated value.
    pub const fn with_minimum_commits(mut self, minimum_commits: u32) -> Self {
        self.minimum_commits = minimum_commits;
        self
    }
}

/// Bounded current-file co-change query.
pub struct FileCochangeQuery<'query> {
    project_id: &'query ProjectId,
    path: &'query NormalizedPath,
    minimum_commits: u32,
    limit: u16,
}

impl<'query> FileCochangeQuery<'query> {
    #[must_use]
    /// Creates a validated file cochange query.
    pub const fn new(
        project_id: &'query ProjectId,
        path: &'query NormalizedPath,
        limit: u16,
    ) -> Self {
        Self {
            project_id,
            path,
            minimum_commits: 0,
            limit,
        }
    }

    #[must_use]
    /// Sets the minimum commits and returns the updated value.
    pub const fn with_minimum_commits(mut self, minimum_commits: u32) -> Self {
        self.minimum_commits = minimum_commits;
        self
    }
}

/// Durable refresh counts and exact Git provenance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRefreshReport {
    head_commit: String,
    shallow_history: bool,
    commits_scanned: u64,
    truncated: bool,
    oversized_commits_skipped: u64,
    files_written: u64,
    cochanges_written: u64,
}

/// One persisted path-level churn row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryRecord {
    path: String,
    head_commit: String,
    commit_count: u64,
    author_count: u64,
    insertions: u64,
    deletions: u64,
    last_touched_at: Option<String>,
    shallow_history: bool,
}

/// One co-changing partner with symmetric and anchor-relative confidence.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCochangeRecord {
    path: String,
    shared_commits: u64,
    jaccard: f32,
    anchor_ratio: f32,
    partner_ratio: f32,
    anchor_commits: u64,
    partner_commits: u64,
}

impl FileCochangeRecord {
    /// Current-generation partner path.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Number of retained commits in which the pair changed together.
    #[must_use]
    pub const fn shared_commits(&self) -> u64 {
        self.shared_commits
    }

    /// Pairwise Jaccard similarity across retained commits.
    #[must_use]
    pub const fn jaccard(&self) -> f32 {
        self.jaccard
    }

    /// Fraction of the anchor file's retained commits shared with this partner.
    #[must_use]
    pub const fn anchor_ratio(&self) -> f32 {
        self.anchor_ratio
    }
}

struct HistoryReadInput<'query> {
    statement: String,
    project_id: &'query ProjectId,
    operation: &'static str,
}

struct HistoryChunkInput<'chunk> {
    schema: &'chunk str,
    project_id: &'chunk ProjectId,
    head_commit: &'chunk str,
    shallow_history: bool,
    chunk: &'chunk [FileHistoryFact],
}

struct CochangeChunkInput<'chunk> {
    schema: &'chunk str,
    project_id: &'chunk ProjectId,
    chunk: &'chunk [FileCochangeFact],
}

impl CartographDatabase {
    /// Atomically replace file churn and co-change evidence under one project lock.
    /// # Errors
    ///
    /// Returns an error if the project lock/timeout fails or atomic deletion,
    /// chunked insertion, and commit of history/co-change rows cannot complete.
    pub async fn replace_file_history(
        &self,
        request: HistoryRefreshRequest,
    ) -> Result<HistoryRefreshReport, StorageError> {
        let schema = quoted_schema(&self.schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("history-begin"))?;
        set_local_statement_timeout(&mut transaction, HISTORY_WRITE_TIMEOUT)
            .await
            .map_err(|()| database_error("history-timeout"))?;
        let lock_key = format!("cartograph:history:{}", request.project_id.as_str());
        query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(lock_key)
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("history-lock"))?;
        let delete_pairs = format!(
            r#"DELETE FROM {schema}."file_cochanges" WHERE project_id = CAST($1 AS uuid)"#,
        );
        query(AssertSqlSafe(delete_pairs))
            .bind(request.project_id.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("history-delete-cochanges"))?;
        let delete_files =
            format!(r#"DELETE FROM {schema}."file_history" WHERE project_id = CAST($1 AS uuid)"#);
        query(AssertSqlSafe(delete_files))
            .bind(request.project_id.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("history-delete-files"))?;
        for chunk in request.files.chunks(HISTORY_INSERT_CHUNK) {
            insert_history_chunk(
                &mut transaction,
                HistoryChunkInput {
                    schema: &schema,
                    project_id: &request.project_id,
                    head_commit: &request.head_commit,
                    shallow_history: request.shallow_history,
                    chunk,
                },
            )
            .await?;
        }
        for chunk in request.cochanges.chunks(HISTORY_INSERT_CHUNK) {
            insert_cochange_chunk(
                &mut transaction,
                CochangeChunkInput {
                    schema: &schema,
                    project_id: &request.project_id,
                    chunk,
                },
            )
            .await?;
        }
        transaction
            .commit()
            .await
            .map_err(|_| database_error("history-commit"))?;
        Ok(HistoryRefreshReport {
            head_commit: request.head_commit,
            shallow_history: request.shallow_history,
            commits_scanned: request.commits_scanned,
            truncated: request.truncated,
            oversized_commits_skipped: request.oversized_commits_skipped,
            files_written: u64::try_from(request.files.len()).unwrap_or(u64::MAX),
            cochanges_written: u64::try_from(request.cochanges.len()).unwrap_or(u64::MAX),
        })
    }

    /// Atomically remove durable churn and co-change evidence when both
    /// project analysis channels are disabled. This prevents stale rows from
    /// surviving a configuration change.
    /// # Errors
    ///
    /// Returns an error if the project lock/timeout fails or both history
    /// relation deletes cannot commit atomically.
    pub async fn clear_file_history(&self, project_id: &ProjectId) -> Result<(), StorageError> {
        let schema = quoted_schema(&self.schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("history-clear-begin"))?;
        set_local_statement_timeout(&mut transaction, HISTORY_WRITE_TIMEOUT)
            .await
            .map_err(|()| database_error("history-clear-timeout"))?;
        let lock_key = format!("cartograph:history:{}", project_id.as_str());
        query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(lock_key)
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("history-clear-lock"))?;
        for (relation, operation) in [
            ("file_cochanges", "history-clear-cochanges"),
            ("file_history", "history-clear-files"),
        ] {
            let statement =
                format!("DELETE FROM {schema}.\"{relation}\" WHERE project_id = CAST($1 AS uuid)");
            query(AssertSqlSafe(statement))
                .bind(project_id.as_str())
                .execute(&mut *transaction)
                .await
                .map_err(|_| database_error(operation))?;
        }
        transaction
            .commit()
            .await
            .map_err(|_| database_error("history-clear-commit"))
    }

    /// Read persisted churn for current indexed files, hottest first.
    /// # Errors
    ///
    /// Returns an error if the row limit is invalid or current-file churn rows
    /// cannot be queried or decoded.
    pub async fn current_file_history(
        &self,
        request: FileHistoryQuery<'_>,
    ) -> Result<Vec<FileHistoryRecord>, StorageError> {
        validate_query_limit(request.limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT history.normalized_path, history.head_commit,
                       history.commit_count, history.author_count,
                       history.insertions, history.deletions,
                       history.last_touched_at::text, history.shallow_history
                FROM {schema}."file_history" AS history
                JOIN current ON true
                WHERE history.project_id = CAST($1 AS uuid)
                  AND ($2::text IS NULL OR history.normalized_path = $2)
                  AND history.commit_count >= $3
                  AND EXISTS (
                      SELECT 1 FROM {schema}."files" AS files
                      WHERE files.project_id = history.project_id
                        AND files.generation_id = current.generation_id
                        AND files.normalized_path = history.normalized_path
                  )
                ORDER BY history.commit_count DESC,
                         history.last_touched_at DESC NULLS LAST,
                         history.normalized_path
                LIMIT $4"#,
        );
        let rows = self
            .history_read(
                HistoryReadInput {
                    statement,
                    project_id: request.project_id,
                    operation: "current-file-history",
                },
                |statement| {
                    statement
                        .bind(request.path.map(NormalizedPath::as_str))
                        .bind(i64::from(request.minimum_commits))
                        .bind(i64::from(request.limit))
                },
            )
            .await?;
        rows.iter().map(decode_history).collect()
    }

    /// Read current-file co-change partners for one exact anchor path.
    /// # Errors
    ///
    /// Returns an error if the result limit is invalid or anchor co-change
    /// partners and normalized confidence values cannot be queried or decoded.
    pub async fn current_file_cochanges(
        &self,
        request: FileCochangeQuery<'_>,
    ) -> Result<Vec<FileCochangeRecord>, StorageError> {
        validate_query_limit(request.limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), pairs AS (
                    SELECT CASE WHEN path_a = $2 THEN path_b ELSE path_a END AS partner,
                           commit_count, confidence
                    FROM {schema}."file_cochanges"
                    WHERE project_id = CAST($1 AS uuid)
                      AND (path_a = $2 OR path_b = $2)
                      AND commit_count >= $3
                )
                SELECT pairs.partner, pairs.commit_count, pairs.confidence,
                       pairs.commit_count::real / GREATEST(anchor.commit_count, 1)::real,
                       pairs.commit_count::real / GREATEST(partner.commit_count, 1)::real,
                       anchor.commit_count, partner.commit_count
                FROM pairs
                JOIN current ON true
                JOIN {schema}."file_history" AS anchor
                  ON anchor.project_id = CAST($1 AS uuid)
                 AND anchor.normalized_path = $2
                JOIN {schema}."file_history" AS partner
                  ON partner.project_id = CAST($1 AS uuid)
                 AND partner.normalized_path = pairs.partner
                WHERE EXISTS (
                    SELECT 1 FROM {schema}."files" AS files
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND files.generation_id = current.generation_id
                      AND files.normalized_path = pairs.partner
                )
                ORDER BY pairs.commit_count DESC, pairs.confidence DESC, pairs.partner
                LIMIT $4"#,
        );
        let rows = self
            .history_read(
                HistoryReadInput {
                    statement,
                    project_id: request.project_id,
                    operation: "current-file-cochanges",
                },
                |statement| {
                    statement
                        .bind(request.path.as_str())
                        .bind(i64::from(request.minimum_commits))
                        .bind(i64::from(request.limit))
                },
            )
            .await?;
        rows.iter().map(decode_cochange).collect()
    }

    async fn history_read<'query, Bind>(
        &self,
        input: HistoryReadInput<'_>,
        bind: Bind,
    ) -> Result<Vec<sqlx_postgres::PgRow>, StorageError>
    where
        Bind: FnOnce(
            sqlx_core::query::Query<'query, sqlx_postgres::Postgres, sqlx_postgres::PgArguments>,
        ) -> sqlx_core::query::Query<
            'query,
            sqlx_postgres::Postgres,
            sqlx_postgres::PgArguments,
        >,
    {
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error(input.operation))?;
        query("SET TRANSACTION READ ONLY")
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error(input.operation))?;
        set_local_statement_timeout(&mut transaction, HISTORY_READ_TIMEOUT)
            .await
            .map_err(|()| database_error(input.operation))?;
        let rows = bind(query(AssertSqlSafe(input.statement)).bind(input.project_id.as_str()))
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| database_error(input.operation))?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error(input.operation))?;
        Ok(rows)
    }
}

async fn insert_history_chunk(
    transaction: &mut sqlx_postgres::PgTransaction<'_>,
    input: HistoryChunkInput<'_>,
) -> Result<(), StorageError> {
    let paths = input
        .chunk
        .iter()
        .map(|fact| fact.path.as_str())
        .collect::<Vec<_>>();
    let commits = counts(input.chunk, |fact| fact.commit_count)?;
    let authors = counts(input.chunk, |fact| fact.author_count)?;
    let insertions = counts(input.chunk, |fact| fact.insertions)?;
    let deletions = counts(input.chunk, |fact| fact.deletions)?;
    let touched = input
        .chunk
        .iter()
        .map(|fact| {
            fact.last_touched_at
                .map(|value| i64::try_from(value).map_err(|_| invalid_count()))
                .transpose()
        })
        .collect::<Result<Vec<_>, _>>()?;
    let schema = input.schema;
    let statement = format!(
        r#"INSERT INTO {schema}."file_history" (
                project_id, normalized_path, head_commit, commit_count,
                author_count, insertions, deletions, last_touched_at, shallow_history
            )
            SELECT CAST($1 AS uuid), rows.path, $2, rows.commits, rows.authors,
                   rows.insertions, rows.deletions,
                   CASE WHEN rows.touched IS NULL THEN NULL
                        ELSE to_timestamp(rows.touched) END,
                   $3
            FROM UNNEST(
                $4::text[], $5::bigint[], $6::bigint[], $7::bigint[],
                $8::bigint[], $9::bigint[]
            ) AS rows(path, commits, authors, insertions, deletions, touched)"#,
    );
    query(AssertSqlSafe(statement))
        .bind(input.project_id.as_str())
        .bind(input.head_commit)
        .bind(input.shallow_history)
        .bind(paths)
        .bind(commits)
        .bind(authors)
        .bind(insertions)
        .bind(deletions)
        .bind(touched)
        .execute(&mut **transaction)
        .await
        .map_err(|_| database_error("history-insert-files"))?;
    Ok(())
}

async fn insert_cochange_chunk(
    transaction: &mut sqlx_postgres::PgTransaction<'_>,
    input: CochangeChunkInput<'_>,
) -> Result<(), StorageError> {
    let path_a = input
        .chunk
        .iter()
        .map(|fact| fact.path_a.as_str())
        .collect::<Vec<_>>();
    let path_b = input
        .chunk
        .iter()
        .map(|fact| fact.path_b.as_str())
        .collect::<Vec<_>>();
    let commits = counts(input.chunk, |fact| fact.commit_count)?;
    let confidence = input
        .chunk
        .iter()
        .map(|fact| fact.confidence)
        .collect::<Vec<_>>();
    let schema = input.schema;
    let statement = format!(
        r#"INSERT INTO {schema}."file_cochanges" (
                project_id, path_a, path_b, commit_count, confidence
            )
            SELECT CAST($1 AS uuid), rows.path_a, rows.path_b,
                   rows.commits, rows.confidence
            FROM UNNEST(
                $2::text[], $3::text[], $4::bigint[], $5::real[]
            ) AS rows(path_a, path_b, commits, confidence)"#,
    );
    query(AssertSqlSafe(statement))
        .bind(input.project_id.as_str())
        .bind(path_a)
        .bind(path_b)
        .bind(commits)
        .bind(confidence)
        .execute(&mut **transaction)
        .await
        .map_err(|_| database_error("history-insert-cochanges"))?;
    Ok(())
}

fn counts<T>(chunk: &[T], pick: impl Fn(&T) -> u64) -> Result<Vec<i64>, StorageError> {
    chunk
        .iter()
        .map(|fact| i64::try_from(pick(fact)).map_err(|_| invalid_count()))
        .collect()
}

fn valid_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_query_limit(limit: u16) -> Result<(), StorageError> {
    if limit == 0 || limit > MAX_HISTORY_QUERY_LIMIT {
        Err(StorageError::InvalidInput { field: "limit" })
    } else {
        Ok(())
    }
}

const HISTORY_AUTHOR_COUNT_COLUMN: usize = 3;
const HISTORY_INSERTIONS_COLUMN: usize = 4;
const HISTORY_DELETIONS_COLUMN: usize = 5;
const HISTORY_LAST_TOUCHED_COLUMN: usize = 6;
const HISTORY_SHALLOW_COLUMN: usize = 7;
const COCHANGE_ANCHOR_RATIO_COLUMN: usize = 3;
const COCHANGE_PARTNER_RATIO_COLUMN: usize = 4;
const COCHANGE_ANCHOR_COMMITS_COLUMN: usize = 5;
const COCHANGE_PARTNER_COMMITS_COLUMN: usize = 6;

fn decode_history(row: &sqlx_postgres::PgRow) -> Result<FileHistoryRecord, StorageError> {
    Ok(FileHistoryRecord {
        path: text(row, 0)?,
        head_commit: text(row, 1)?,
        commit_count: nonnegative(row, 2)?,
        author_count: nonnegative(row, HISTORY_AUTHOR_COUNT_COLUMN)?,
        insertions: nonnegative(row, HISTORY_INSERTIONS_COLUMN)?,
        deletions: nonnegative(row, HISTORY_DELETIONS_COLUMN)?,
        last_touched_at: row
            .try_get(HISTORY_LAST_TOUCHED_COLUMN)
            .map_err(|_| corrupt())?,
        shallow_history: row.try_get(HISTORY_SHALLOW_COLUMN).map_err(|_| corrupt())?,
    })
}

fn decode_cochange(row: &sqlx_postgres::PgRow) -> Result<FileCochangeRecord, StorageError> {
    Ok(FileCochangeRecord {
        path: text(row, 0)?,
        shared_commits: nonnegative(row, 1)?,
        jaccard: row.try_get(2).map_err(|_| corrupt())?,
        anchor_ratio: row
            .try_get(COCHANGE_ANCHOR_RATIO_COLUMN)
            .map_err(|_| corrupt())?,
        partner_ratio: row
            .try_get(COCHANGE_PARTNER_RATIO_COLUMN)
            .map_err(|_| corrupt())?,
        anchor_commits: nonnegative(row, COCHANGE_ANCHOR_COMMITS_COLUMN)?,
        partner_commits: nonnegative(row, COCHANGE_PARTNER_COMMITS_COLUMN)?,
    })
}

fn text(row: &sqlx_postgres::PgRow, index: usize) -> Result<String, StorageError> {
    row.try_get(index).map_err(|_| corrupt())
}

fn nonnegative(row: &sqlx_postgres::PgRow, index: usize) -> Result<u64, StorageError> {
    row.try_get::<i64, _>(index)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(corrupt)
}

const fn invalid_count() -> StorageError {
    StorageError::InvalidInput {
        field: "history_count",
    }
}

const fn corrupt() -> StorageError {
    StorageError::CorruptStoredValue { field: "history" }
}

const fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cochanges_require_canonical_order_nonzero_count_and_probability() {
        let metrics = |commit_count, confidence| FileCochangeMetrics {
            commit_count,
            confidence,
        };
        let a = NormalizedPath::parse("src/a.rs")
            .unwrap_or_else(|error| panic!("path a failed: {error}"));
        let b = NormalizedPath::parse("src/b.rs")
            .unwrap_or_else(|error| panic!("path b failed: {error}"));
        assert!(FileCochangeFact::new(a.clone(), b.clone(), metrics(2, 0.5)).is_ok());
        assert!(FileCochangeFact::new(b, a.clone(), metrics(2, 0.5)).is_err());
        assert!(FileCochangeFact::new(a.clone(), a.clone(), metrics(2, 0.5)).is_err());
        assert!(FileCochangeFact::new(a.clone(), a, metrics(0, 1.5)).is_err());

        let punctuation = NormalizedPath::parse(".github/workflows/check.ts")
            .unwrap_or_else(|error| panic!("punctuation path failed: {error}"));
        let uppercase = NormalizedPath::parse("ACKNOWLEDGEMENTS.ts")
            .unwrap_or_else(|error| panic!("uppercase path failed: {error}"));
        assert!(
            FileCochangeFact::new(punctuation.clone(), uppercase.clone(), metrics(1, 1.0)).is_ok()
        );
        assert!(FileCochangeFact::new(uppercase, punctuation, metrics(1, 1.0)).is_err());
    }
}
