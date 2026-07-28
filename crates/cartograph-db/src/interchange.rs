use std::time::Duration;

use cartograph_domain::{FileId, GenerationId, ProjectId, SymbolId};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use thiserror::Error;

use crate::CartographDatabase;

const MAXIMUM_INTERCHANGE_ROWS: u64 = 5_000_000;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterchangeFile {
    pub file_id: FileId,
    pub path: String,
    pub language: String,
    pub content_hash: String,
    pub byte_size: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterchangeSymbol {
    pub symbol_id: SymbolId,
    pub file_id: FileId,
    pub symbol_kind: String,
    pub qualified_name: String,
    pub signature: String,
    pub code: String,
    pub natural_text: String,
    pub start_byte: u64,
    pub end_byte: u64,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterchangeEdge {
    pub source_symbol_id: SymbolId,
    pub target_symbol_id: SymbolId,
    pub edge_kind: String,
    pub confidence: f32,
    pub provenance: String,
    pub site_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterchangeReference {
    pub file_id: FileId,
    pub owner_symbol_id: Option<SymbolId>,
    pub target_symbol_id: Option<SymbolId>,
    pub reference_name: String,
    pub reference_kind: String,
    pub start_byte: u64,
    pub end_byte: u64,
    pub site_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterchangeSnapshot {
    pub generation_id: GenerationId,
    pub files: Vec<InterchangeFile>,
    pub symbols: Vec<InterchangeSymbol>,
    pub edges: Vec<InterchangeEdge>,
    pub references: Vec<InterchangeReference>,
}

/// Bounded, deadline-scoped export of one project's current generation.
pub struct InterchangeSnapshotRequest<'request> {
    pub project_id: &'request ProjectId,
    pub maximum_rows: u64,
    pub statement_timeout: Duration,
}

#[derive(Clone, Copy)]
struct InterchangeGeneration<'generation> {
    schema: &'generation str,
    project_id: &'generation ProjectId,
    generation_id: &'generation GenerationId,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum InterchangeSnapshotError {
    #[error("invalid Cartograph interchange snapshot bounds")]
    InvalidBounds,
    #[error("Cartograph has no current generation to export")]
    CurrentGenerationUnavailable,
    #[error("Cartograph interchange snapshot exceeds its row bound")]
    RowBoundExceeded,
    #[error("Cartograph interchange snapshot contains corrupt stored data")]
    CorruptStoredValue,
    #[error("Cartograph PostgreSQL interchange snapshot failed")]
    DatabaseOperation,
}

impl CartographDatabase {
    /// Load one immutable, exactly bounded graph snapshot for interchange.
    pub async fn current_interchange_snapshot(
        &self,
        request: InterchangeSnapshotRequest<'_>,
    ) -> Result<InterchangeSnapshot, InterchangeSnapshotError> {
        if request.maximum_rows == 0
            || request.maximum_rows > MAXIMUM_INTERCHANGE_ROWS
            || request.statement_timeout.is_zero()
        {
            return Err(InterchangeSnapshotError::InvalidBounds);
        }
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| InterchangeSnapshotError::DatabaseOperation)?;
        query("SET TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *transaction)
            .await
            .map_err(|_| InterchangeSnapshotError::DatabaseOperation)?;
        crate::database::set_local_statement_timeout(&mut transaction, request.statement_timeout)
            .await
            .map_err(|()| InterchangeSnapshotError::InvalidBounds)?;
        let schema = crate::database::quoted_schema(&self.schema);
        let generation_sql = format!(
            r#"SELECT current_generation_id::text AS generation_id
                FROM {schema}."projects"
                WHERE project_id = CAST($1 AS uuid)
                  AND current_generation_id IS NOT NULL"#
        );
        let generation = query(AssertSqlSafe(generation_sql))
            .bind(request.project_id.as_str())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| InterchangeSnapshotError::DatabaseOperation)?
            .ok_or(InterchangeSnapshotError::CurrentGenerationUnavailable)?
            .try_get::<String, _>("generation_id")
            .ok()
            .and_then(|value| GenerationId::parse(&value).ok())
            .ok_or(InterchangeSnapshotError::CorruptStoredValue)?;
        let count_sql = format!(
            r#"SELECT
                  (SELECT count(*) FROM {schema}."files"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {schema}."symbols"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {schema}."edges"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid))
                + (SELECT count(*) FROM {schema}."references"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid))
                AS rows"#
        );
        let rows = query(AssertSqlSafe(count_sql))
            .bind(request.project_id.as_str())
            .bind(generation.as_str())
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| InterchangeSnapshotError::DatabaseOperation)?
            .try_get::<i64, _>("rows")
            .ok()
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(InterchangeSnapshotError::CorruptStoredValue)?;
        if rows > request.maximum_rows {
            return Err(InterchangeSnapshotError::RowBoundExceeded);
        }
        let generation_scope = InterchangeGeneration {
            schema: &schema,
            project_id: request.project_id,
            generation_id: &generation,
        };
        let files = load_files(&mut transaction, generation_scope).await?;
        let symbols = load_symbols(&mut transaction, generation_scope).await?;
        let edges = load_edges(&mut transaction, generation_scope).await?;
        let references = load_references(&mut transaction, generation_scope).await?;
        transaction
            .commit()
            .await
            .map_err(|_| InterchangeSnapshotError::DatabaseOperation)?;
        Ok(InterchangeSnapshot {
            generation_id: generation,
            files,
            symbols,
            edges,
            references,
        })
    }
}

async fn load_files(
    connection: &mut sqlx_postgres::PgConnection,
    generation: InterchangeGeneration<'_>,
) -> Result<Vec<InterchangeFile>, InterchangeSnapshotError> {
    let sql = format!(
        r#"SELECT file_id::text, normalized_path, language, content_hash, byte_size
            FROM {}."files"
            WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)
            ORDER BY normalized_path, file_id"#,
        generation.schema
    );
    query(AssertSqlSafe(sql))
        .bind(generation.project_id.as_str())
        .bind(generation.generation_id.as_str())
        .fetch_all(connection)
        .await
        .map_err(|_| InterchangeSnapshotError::DatabaseOperation)?
        .iter()
        .map(|row| {
            Ok(InterchangeFile {
                file_id: parse_file_id(row, 0)?,
                path: text(row, 1)?,
                language: text(row, 2)?,
                content_hash: text(row, 3)?,
                byte_size: nonnegative_u64(row, 4)?,
            })
        })
        .collect()
}

async fn load_symbols(
    connection: &mut sqlx_postgres::PgConnection,
    generation: InterchangeGeneration<'_>,
) -> Result<Vec<InterchangeSymbol>, InterchangeSnapshotError> {
    let sql = format!(
        r#"SELECT symbols.symbol_id::text, symbols.file_id::text, symbols.symbol_kind,
                   symbols.qualified_name, symbols.signature,
                   COALESCE(documents.code, ''), COALESCE(documents.natural_text, ''),
                   symbols.start_byte, symbols.end_byte, symbols.start_line, symbols.end_line
            FROM {}."symbols" AS symbols
            LEFT JOIN {}."search_documents" AS documents
              ON documents.project_id = symbols.project_id
             AND documents.generation_id = symbols.generation_id
             AND documents.symbol_id = symbols.symbol_id
             AND documents.document_kind = 'symbol'
            WHERE symbols.project_id = CAST($1 AS uuid)
              AND symbols.generation_id = CAST($2 AS uuid)
            ORDER BY symbols.file_id, symbols.start_line, symbols.start_byte, symbols.symbol_id"#,
        generation.schema, generation.schema
    );
    query(AssertSqlSafe(sql))
        .bind(generation.project_id.as_str())
        .bind(generation.generation_id.as_str())
        .fetch_all(connection)
        .await
        .map_err(|_| InterchangeSnapshotError::DatabaseOperation)?
        .iter()
        .map(|row| {
            Ok(InterchangeSymbol {
                symbol_id: parse_symbol_id(row, 0)?,
                file_id: parse_file_id(row, 1)?,
                symbol_kind: text(row, 2)?,
                qualified_name: text(row, 3)?,
                signature: text(row, 4)?,
                code: text(row, 5)?,
                natural_text: text(row, 6)?,
                start_byte: nonnegative_u64(row, 7)?,
                end_byte: nonnegative_u64(row, 8)?,
                start_line: positive_i32_u32(row, 9)?,
                end_line: positive_i32_u32(row, 10)?,
            })
        })
        .collect()
}

async fn load_edges(
    connection: &mut sqlx_postgres::PgConnection,
    generation: InterchangeGeneration<'_>,
) -> Result<Vec<InterchangeEdge>, InterchangeSnapshotError> {
    let sql = format!(
        r#"SELECT source_symbol_id::text, target_symbol_id::text, edge_kind,
                   confidence, provenance, site_count
            FROM {}."edges"
            WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)
            ORDER BY source_symbol_id, target_symbol_id, edge_kind"#,
        generation.schema
    );
    query(AssertSqlSafe(sql))
        .bind(generation.project_id.as_str())
        .bind(generation.generation_id.as_str())
        .fetch_all(connection)
        .await
        .map_err(|_| InterchangeSnapshotError::DatabaseOperation)?
        .iter()
        .map(|row| {
            Ok(InterchangeEdge {
                source_symbol_id: parse_symbol_id(row, 0)?,
                target_symbol_id: parse_symbol_id(row, 1)?,
                edge_kind: text(row, 2)?,
                confidence: confidence(row, 3)?,
                provenance: text(row, 4)?,
                site_count: positive_i64_u32(row, 5)?,
            })
        })
        .collect()
}

async fn load_references(
    connection: &mut sqlx_postgres::PgConnection,
    generation: InterchangeGeneration<'_>,
) -> Result<Vec<InterchangeReference>, InterchangeSnapshotError> {
    let sql = format!(
        r#"SELECT file_id::text, owner_symbol_id::text, target_symbol_id::text,
                   reference_name, reference_kind, start_byte, end_byte, site_count
            FROM {}."references"
            WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)
            ORDER BY file_id, start_byte, reference_id"#,
        generation.schema
    );
    query(AssertSqlSafe(sql))
        .bind(generation.project_id.as_str())
        .bind(generation.generation_id.as_str())
        .fetch_all(connection)
        .await
        .map_err(|_| InterchangeSnapshotError::DatabaseOperation)?
        .iter()
        .map(|row| {
            Ok(InterchangeReference {
                file_id: parse_file_id(row, 0)?,
                owner_symbol_id: optional_symbol_id(row, 1)?,
                target_symbol_id: optional_symbol_id(row, 2)?,
                reference_name: text(row, 3)?,
                reference_kind: text(row, 4)?,
                start_byte: nonnegative_u64(row, 5)?,
                end_byte: nonnegative_u64(row, 6)?,
                site_count: positive_i64_u32(row, 7)?,
            })
        })
        .collect()
}

fn text(row: &sqlx_postgres::PgRow, index: usize) -> Result<String, InterchangeSnapshotError> {
    row.try_get(index)
        .map_err(|_| InterchangeSnapshotError::CorruptStoredValue)
}

fn nonnegative_u64(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<u64, InterchangeSnapshotError> {
    row.try_get::<i64, _>(index)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(InterchangeSnapshotError::CorruptStoredValue)
}

fn positive_i32_u32(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<u32, InterchangeSnapshotError> {
    row.try_get::<i32, _>(index)
        .ok()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or(InterchangeSnapshotError::CorruptStoredValue)
}

fn positive_i64_u32(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<u32, InterchangeSnapshotError> {
    row.try_get::<i64, _>(index)
        .ok()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or(InterchangeSnapshotError::CorruptStoredValue)
}

fn confidence(row: &sqlx_postgres::PgRow, index: usize) -> Result<f32, InterchangeSnapshotError> {
    row.try_get::<f32, _>(index)
        .ok()
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        .ok_or(InterchangeSnapshotError::CorruptStoredValue)
}

fn parse_file_id(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<FileId, InterchangeSnapshotError> {
    FileId::parse(&text(row, index)?).map_err(|_| InterchangeSnapshotError::CorruptStoredValue)
}

fn parse_symbol_id(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<SymbolId, InterchangeSnapshotError> {
    SymbolId::parse(&text(row, index)?).map_err(|_| InterchangeSnapshotError::CorruptStoredValue)
}

fn optional_symbol_id(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<Option<SymbolId>, InterchangeSnapshotError> {
    row.try_get::<Option<String>, _>(index)
        .map_err(|_| InterchangeSnapshotError::CorruptStoredValue)?
        .map(|value| {
            SymbolId::parse(&value).map_err(|_| InterchangeSnapshotError::CorruptStoredValue)
        })
        .transpose()
}
