use cartograph_domain::{FileId, GenerationId, NormalizedPath, ProjectId, SymbolId};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{CartographDatabase, StorageError};

const MAX_EXACT_TEXT_BYTES: usize = 4_096;
const MAX_LOOKUP_LIMIT: u16 = 500;
const MAX_FRONTIER_SYMBOLS: usize = 500;
const MAX_EDGE_LIMIT: u16 = 2_000;

/// Identity of the immutable generation currently published for a project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CurrentGenerationRecord {
    generation_id: GenerationId,
    sequence: u64,
}

impl CurrentGenerationRecord {
    /// Published generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Monotonic generation sequence within the project.
    #[must_use]
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }
}

/// One file from the current published generation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CurrentFileRecord {
    generation_id: GenerationId,
    file_id: FileId,
    path: NormalizedPath,
    language: String,
}

impl CurrentFileRecord {
    /// Published generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Stable file identity.
    #[must_use]
    pub const fn file_id(&self) -> &FileId {
        &self.file_id
    }

    /// Canonical project-relative path.
    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    /// Stable indexed language name.
    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }
}

/// One symbol from the current published generation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CurrentSymbolRecord {
    generation_id: GenerationId,
    symbol_id: SymbolId,
    file_id: FileId,
    path: NormalizedPath,
    language: String,
    symbol_kind: String,
    qualified_name: String,
    signature: String,
    start_line: u32,
    end_line: u32,
}

impl CurrentSymbolRecord {
    /// Published generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Stable symbol identity.
    #[must_use]
    pub const fn symbol_id(&self) -> &SymbolId {
        &self.symbol_id
    }

    /// Stable file identity.
    #[must_use]
    pub const fn file_id(&self) -> &FileId {
        &self.file_id
    }

    /// Canonical project-relative path.
    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    /// Stable indexed language name.
    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }

    /// Stable symbol-kind name.
    #[must_use]
    pub fn symbol_kind(&self) -> &str {
        &self.symbol_kind
    }

    /// Fully qualified declaration name.
    #[must_use]
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    /// Source signature captured by the extractor.
    #[must_use]
    pub fn signature(&self) -> &str {
        &self.signature
    }

    /// One-based first source line.
    #[must_use]
    pub const fn start_line(&self) -> u32 {
        self.start_line
    }

    /// One-based last source line.
    #[must_use]
    pub const fn end_line(&self) -> u32 {
        self.end_line
    }
}

/// Exact unresolved or resolved reference evidence from the current generation.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CurrentReferenceRecord {
    reference_id: u64,
    generation_id: GenerationId,
    file_id: FileId,
    path: NormalizedPath,
    owner_symbol_id: Option<SymbolId>,
    target_symbol_id: Option<SymbolId>,
    reference_name: String,
    reference_kind: String,
    start_byte: u64,
    end_byte: u64,
    confidence: f32,
    provenance: String,
}

impl CurrentReferenceRecord {
    /// Stable row identity within the configured schema.
    #[must_use]
    pub const fn reference_id(&self) -> u64 {
        self.reference_id
    }

    /// Published generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// File containing the reference.
    #[must_use]
    pub const fn file_id(&self) -> &FileId {
        &self.file_id
    }

    /// Canonical path containing the reference.
    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    /// Symbol whose body owns the reference, when known.
    #[must_use]
    pub const fn owner_symbol_id(&self) -> Option<&SymbolId> {
        self.owner_symbol_id.as_ref()
    }

    /// Resolved target symbol, when known.
    #[must_use]
    pub const fn target_symbol_id(&self) -> Option<&SymbolId> {
        self.target_symbol_id.as_ref()
    }

    /// Exact name observed in source.
    #[must_use]
    pub fn reference_name(&self) -> &str {
        &self.reference_name
    }

    /// Stable reference-kind name.
    #[must_use]
    pub fn reference_kind(&self) -> &str {
        &self.reference_kind
    }

    /// Inclusive source byte offset.
    #[must_use]
    pub const fn start_byte(&self) -> u64 {
        self.start_byte
    }

    /// Exclusive source byte offset.
    #[must_use]
    pub const fn end_byte(&self) -> u64 {
        self.end_byte
    }

    /// Extractor confidence in the reference resolution.
    #[must_use]
    pub const fn confidence(&self) -> f32 {
        self.confidence
    }

    /// Stable extractor provenance label.
    #[must_use]
    pub fn provenance(&self) -> &str {
        &self.provenance
    }
}

/// Direction in which a bounded graph frontier is expanded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphDirection {
    /// Follow source symbols to their targets.
    Outgoing,
    /// Follow target symbols back to their sources.
    Incoming,
}

/// One structural edge from the current published generation.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CurrentGraphEdge {
    generation_id: GenerationId,
    source_symbol_id: SymbolId,
    target_symbol_id: SymbolId,
    edge_kind: String,
    confidence: f32,
    provenance: String,
}

impl CurrentGraphEdge {
    /// Published generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Edge source.
    #[must_use]
    pub const fn source_symbol_id(&self) -> &SymbolId {
        &self.source_symbol_id
    }

    /// Edge target.
    #[must_use]
    pub const fn target_symbol_id(&self) -> &SymbolId {
        &self.target_symbol_id
    }

    /// Stable structural relation name.
    #[must_use]
    pub fn edge_kind(&self) -> &str {
        &self.edge_kind
    }

    /// Extractor confidence for the relation.
    #[must_use]
    pub const fn confidence(&self) -> f32 {
        self.confidence
    }

    /// Stable extractor provenance label.
    #[must_use]
    pub fn provenance(&self) -> &str {
        &self.provenance
    }
}

impl CartographDatabase {
    /// Resolve the current generation pointer without observing staging rows.
    pub async fn current_generation_record(
        &self,
        project_id: &ProjectId,
    ) -> Result<Option<CurrentGenerationRecord>, StorageError> {
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"SELECT generations.generation_id::text, generations.generation_sequence
                FROM {schema}."projects" AS projects
                INNER JOIN {schema}."index_generations" AS generations
                    ON generations.project_id = projects.project_id
                   AND generations.generation_id = projects.current_generation_id
                   AND generations.state = 'current'
                WHERE projects.project_id = CAST($1 AS uuid)"#
        );
        let row = query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("current-generation-read"))?;
        row.as_ref().map(decode_generation).transpose()
    }

    /// Resolve one exact canonical path in the current generation.
    pub async fn exact_current_file_by_path(
        &self,
        project_id: &ProjectId,
        path: &NormalizedPath,
    ) -> Result<Option<CurrentFileRecord>, StorageError> {
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"SELECT files.generation_id::text, files.file_id::text,
                       files.normalized_path, files.language
                FROM {schema}."files" AS files
                INNER JOIN {schema}."projects" AS projects
                    ON projects.project_id = files.project_id
                   AND projects.current_generation_id = files.generation_id
                WHERE files.project_id = CAST($1 AS uuid)
                  AND files.normalized_path = $2
                ORDER BY files.file_id
                LIMIT 1"#
        );
        let row = query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .bind(path.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("exact-path-lookup"))?;
        row.as_ref().map(decode_file).transpose()
    }

    /// Resolve an exact qualified declaration name in the current generation.
    pub async fn exact_current_symbols_by_name(
        &self,
        project_id: &ProjectId,
        name: &str,
        limit: u16,
    ) -> Result<Vec<CurrentSymbolRecord>, StorageError> {
        let name = validate_exact_text(name, "name")?;
        validate_limit(limit, MAX_LOOKUP_LIMIT)?;
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"SELECT symbols.generation_id::text, symbols.symbol_id::text,
                       symbols.file_id::text, files.normalized_path, files.language,
                       symbols.symbol_kind, symbols.qualified_name, symbols.signature,
                       symbols.start_line, symbols.end_line
                FROM {schema}."symbols" AS symbols
                INNER JOIN {schema}."projects" AS projects
                    ON projects.project_id = symbols.project_id
                   AND projects.current_generation_id = symbols.generation_id
                INNER JOIN {schema}."files" AS files
                    ON files.project_id = symbols.project_id
                   AND files.generation_id = symbols.generation_id
                   AND files.file_id = symbols.file_id
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND (
                    symbols.qualified_name = $2
                    OR right(symbols.qualified_name, char_length($2) + 2) = '::' || $2
                  )
                ORDER BY (symbols.qualified_name = $2) DESC,
                         files.normalized_path, symbols.start_line, symbols.symbol_id
                LIMIT $3"#
        );
        let rows = query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .bind(name)
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .map_err(|_| database_error("exact-name-lookup"))?;
        rows.iter().map(decode_symbol).collect()
    }

    /// Resolve symbols owned by one exact current-generation file.
    pub async fn current_symbols_by_file(
        &self,
        project_id: &ProjectId,
        file_id: &FileId,
        limit: u16,
    ) -> Result<Vec<CurrentSymbolRecord>, StorageError> {
        validate_limit(limit, MAX_LOOKUP_LIMIT)?;
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = symbol_select(&schema, "symbols.file_id = CAST($2 AS uuid)");
        let rows = query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .bind(file_id.as_str())
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .map_err(|_| database_error("symbols-by-file"))?;
        rows.iter().map(decode_symbol).collect()
    }

    /// Hydrate a bounded set of symbol identities from only the current generation.
    pub async fn current_symbols_by_ids(
        &self,
        project_id: &ProjectId,
        symbol_ids: &[SymbolId],
    ) -> Result<Vec<CurrentSymbolRecord>, StorageError> {
        validate_symbol_set(symbol_ids)?;
        if symbol_ids.is_empty() {
            return Ok(Vec::new());
        }
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = symbol_select(&schema, "symbols.symbol_id = ANY(CAST($2 AS uuid[]))");
        let ids = symbol_ids
            .iter()
            .map(|symbol_id| symbol_id.as_str().to_owned())
            .collect::<Vec<_>>();
        let rows = query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .bind(ids)
            .bind(i64::try_from(symbol_ids.len()).map_err(|_| invalid("symbol_ids"))?)
            .fetch_all(&self.pool)
            .await
            .map_err(|_| database_error("symbols-by-id"))?;
        rows.iter().map(decode_symbol).collect()
    }

    /// Resolve exact reference text, including unresolved evidence, in the current generation.
    pub async fn exact_current_references_by_name(
        &self,
        project_id: &ProjectId,
        name: &str,
        limit: u16,
    ) -> Result<Vec<CurrentReferenceRecord>, StorageError> {
        let name = validate_exact_text(name, "reference_name")?;
        validate_limit(limit, MAX_LOOKUP_LIMIT)?;
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = exact_reference_sql(&schema);
        let rows = query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .bind(name)
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .map_err(|_| database_error("exact-reference-lookup"))?;
        rows.iter().map(decode_reference).collect()
    }

    /// Read a bounded incoming or outgoing structural frontier from only the
    /// current generation. Callers own breadth/depth policy.
    pub async fn current_graph_edges(
        &self,
        project_id: &ProjectId,
        frontier: &[SymbolId],
        direction: GraphDirection,
        limit: u16,
    ) -> Result<Vec<CurrentGraphEdge>, StorageError> {
        validate_symbol_set(frontier)?;
        validate_limit(limit, MAX_EDGE_LIMIT)?;
        if frontier.is_empty() {
            return Ok(Vec::new());
        }
        let predicate = match direction {
            GraphDirection::Outgoing => "edges.source_symbol_id = ANY(CAST($2 AS uuid[]))",
            GraphDirection::Incoming => "edges.target_symbol_id = ANY(CAST($2 AS uuid[]))",
        };
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"SELECT edges.generation_id::text, edges.source_symbol_id::text,
                       edges.target_symbol_id::text, edges.edge_kind,
                       edges.confidence, edges.provenance
                FROM {schema}."edges" AS edges
                INNER JOIN {schema}."projects" AS projects
                    ON projects.project_id = edges.project_id
                   AND projects.current_generation_id = edges.generation_id
                WHERE edges.project_id = CAST($1 AS uuid)
                  AND {predicate}
                ORDER BY edges.source_symbol_id, edges.target_symbol_id,
                         edges.edge_kind, edges.provenance
                LIMIT $3"#
        );
        let ids = frontier
            .iter()
            .map(|symbol_id| symbol_id.as_str().to_owned())
            .collect::<Vec<_>>();
        let rows = query(AssertSqlSafe(sql))
            .bind(project_id.as_str())
            .bind(ids)
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .map_err(|_| database_error("graph-frontier-read"))?;
        rows.iter().map(decode_edge).collect()
    }
}

fn exact_reference_sql(schema: &str) -> String {
    format!(
        r#"SELECT refs.reference_id, refs.generation_id::text,
                   refs.file_id::text, files.normalized_path,
                   refs.owner_symbol_id::text,
                   refs.target_symbol_id::text,
                   refs.reference_name, refs.reference_kind,
                   refs.start_byte, refs.end_byte,
                   refs.confidence, refs.resolution_provenance
                FROM {schema}."references" AS refs
                INNER JOIN {schema}."projects" AS projects
                    ON projects.project_id = refs.project_id
                   AND projects.current_generation_id = refs.generation_id
                INNER JOIN {schema}."files" AS files
                    ON files.project_id = refs.project_id
                   AND files.generation_id = refs.generation_id
                   AND files.file_id = refs.file_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.reference_name = $2
                ORDER BY files.normalized_path, refs.start_byte,
                         refs.reference_id
                LIMIT $3"#
    )
}

fn symbol_select(schema: &str, predicate: &str) -> String {
    format!(
        r#"SELECT symbols.generation_id::text, symbols.symbol_id::text,
                   symbols.file_id::text, files.normalized_path, files.language,
                   symbols.symbol_kind, symbols.qualified_name, symbols.signature,
                   symbols.start_line, symbols.end_line
            FROM {schema}."symbols" AS symbols
            INNER JOIN {schema}."projects" AS projects
                ON projects.project_id = symbols.project_id
               AND projects.current_generation_id = symbols.generation_id
            INNER JOIN {schema}."files" AS files
                ON files.project_id = symbols.project_id
               AND files.generation_id = symbols.generation_id
               AND files.file_id = symbols.file_id
            WHERE symbols.project_id = CAST($1 AS uuid)
              AND {predicate}
            ORDER BY files.normalized_path, symbols.start_line, symbols.symbol_id
            LIMIT $3"#
    )
}

fn validate_exact_text<'a>(value: &'a str, field: &'static str) -> Result<&'a str, StorageError> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_EXACT_TEXT_BYTES || value.contains('\0') {
        return Err(invalid(field));
    }
    Ok(value)
}

const fn validate_limit(limit: u16, maximum: u16) -> Result<(), StorageError> {
    if limit == 0 || limit > maximum {
        return Err(invalid("limit"));
    }
    Ok(())
}

fn validate_symbol_set(symbol_ids: &[SymbolId]) -> Result<(), StorageError> {
    if symbol_ids.len() > MAX_FRONTIER_SYMBOLS {
        return Err(invalid("symbol_ids"));
    }
    Ok(())
}

fn decode_generation(row: &sqlx_postgres::PgRow) -> Result<CurrentGenerationRecord, StorageError> {
    let sequence = read_i64(row, 1, "generation_sequence")?;
    Ok(CurrentGenerationRecord {
        generation_id: parse_generation_id(row, 0)?,
        sequence: u64::try_from(sequence).map_err(|_| corrupt("generation_sequence"))?,
    })
}

fn decode_file(row: &sqlx_postgres::PgRow) -> Result<CurrentFileRecord, StorageError> {
    Ok(CurrentFileRecord {
        generation_id: parse_generation_id(row, 0)?,
        file_id: parse_file_id(row, 1)?,
        path: parse_path(row, 2)?,
        language: read_string(row, 3, "language")?,
    })
}

fn decode_symbol(row: &sqlx_postgres::PgRow) -> Result<CurrentSymbolRecord, StorageError> {
    Ok(CurrentSymbolRecord {
        generation_id: parse_generation_id(row, 0)?,
        symbol_id: parse_symbol_id(row, 1)?,
        file_id: parse_file_id(row, 2)?,
        path: parse_path(row, 3)?,
        language: read_string(row, 4, "language")?,
        symbol_kind: read_string(row, 5, "symbol_kind")?,
        qualified_name: read_string(row, 6, "qualified_name")?,
        signature: read_string(row, 7, "signature")?,
        start_line: read_u32(row, 8, "start_line")?,
        end_line: read_u32(row, 9, "end_line")?,
    })
}

fn decode_reference(row: &sqlx_postgres::PgRow) -> Result<CurrentReferenceRecord, StorageError> {
    let reference_id = read_i64(row, 0, "reference_id")?;
    let start_byte = read_i64(row, 8, "start_byte")?;
    let end_byte = read_i64(row, 9, "end_byte")?;
    Ok(CurrentReferenceRecord {
        reference_id: u64::try_from(reference_id).map_err(|_| corrupt("reference_id"))?,
        generation_id: parse_generation_id(row, 1)?,
        file_id: parse_file_id(row, 2)?,
        path: parse_path(row, 3)?,
        owner_symbol_id: parse_optional_symbol_id(row, 4, "owner_symbol_id")?,
        target_symbol_id: parse_optional_symbol_id(row, 5, "target_symbol_id")?,
        reference_name: read_string(row, 6, "reference_name")?,
        reference_kind: read_string(row, 7, "reference_kind")?,
        start_byte: u64::try_from(start_byte).map_err(|_| corrupt("start_byte"))?,
        end_byte: u64::try_from(end_byte).map_err(|_| corrupt("end_byte"))?,
        confidence: read_confidence(row, 10)?,
        provenance: read_string(row, 11, "resolution_provenance")?,
    })
}

fn decode_edge(row: &sqlx_postgres::PgRow) -> Result<CurrentGraphEdge, StorageError> {
    Ok(CurrentGraphEdge {
        generation_id: parse_generation_id(row, 0)?,
        source_symbol_id: parse_symbol_id(row, 1)?,
        target_symbol_id: parse_symbol_id(row, 2)?,
        edge_kind: read_string(row, 3, "edge_kind")?,
        confidence: read_confidence(row, 4)?,
        provenance: read_string(row, 5, "provenance")?,
    })
}

fn parse_generation_id(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<GenerationId, StorageError> {
    let raw = read_string(row, index, "generation_id")?;
    GenerationId::parse(&raw).map_err(|_| corrupt("generation_id"))
}

fn parse_file_id(row: &sqlx_postgres::PgRow, index: usize) -> Result<FileId, StorageError> {
    let raw = read_string(row, index, "file_id")?;
    FileId::parse(&raw).map_err(|_| corrupt("file_id"))
}

fn parse_symbol_id(row: &sqlx_postgres::PgRow, index: usize) -> Result<SymbolId, StorageError> {
    let raw = read_string(row, index, "symbol_id")?;
    SymbolId::parse(&raw).map_err(|_| corrupt("symbol_id"))
}

fn parse_optional_symbol_id(
    row: &sqlx_postgres::PgRow,
    index: usize,
    field: &'static str,
) -> Result<Option<SymbolId>, StorageError> {
    let raw = row
        .try_get::<Option<String>, _>(index)
        .map_err(|_| corrupt(field))?;
    raw.map(|value| SymbolId::parse(&value).map_err(|_| corrupt(field)))
        .transpose()
}

fn parse_path(row: &sqlx_postgres::PgRow, index: usize) -> Result<NormalizedPath, StorageError> {
    let raw = read_string(row, index, "normalized_path")?;
    NormalizedPath::parse(&raw).map_err(|_| corrupt("normalized_path"))
}

fn read_string(
    row: &sqlx_postgres::PgRow,
    index: usize,
    field: &'static str,
) -> Result<String, StorageError> {
    row.try_get::<String, _>(index).map_err(|_| corrupt(field))
}

fn read_i64(
    row: &sqlx_postgres::PgRow,
    index: usize,
    field: &'static str,
) -> Result<i64, StorageError> {
    row.try_get::<i64, _>(index).map_err(|_| corrupt(field))
}

fn read_u32(
    row: &sqlx_postgres::PgRow,
    index: usize,
    field: &'static str,
) -> Result<u32, StorageError> {
    let value = row.try_get::<i32, _>(index).map_err(|_| corrupt(field))?;
    u32::try_from(value).map_err(|_| corrupt(field))
}

fn read_confidence(row: &sqlx_postgres::PgRow, index: usize) -> Result<f32, StorageError> {
    let value = row
        .try_get::<f32, _>(index)
        .map_err(|_| corrupt("confidence"))?;
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(corrupt("confidence"));
    }
    Ok(value)
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
    fn exact_text_and_graph_bounds_are_fail_closed() {
        assert_eq!(
            validate_exact_text(" ", "name"),
            Err(StorageError::InvalidInput { field: "name" })
        );
        assert_eq!(
            validate_exact_text(&"x".repeat(MAX_EXACT_TEXT_BYTES + 1), "name"),
            Err(StorageError::InvalidInput { field: "name" })
        );
        assert_eq!(
            validate_limit(0, MAX_LOOKUP_LIMIT),
            Err(StorageError::InvalidInput { field: "limit" })
        );
        assert_eq!(
            validate_limit(MAX_EDGE_LIMIT + 1, MAX_EDGE_LIMIT),
            Err(StorageError::InvalidInput { field: "limit" })
        );
    }

    #[test]
    fn public_validation_errors_do_not_render_input_values() {
        let secret = "postgres://private-user:private-password@database/private-query";
        let error = validate_exact_text(&format!("{secret}\0"), "reference_name")
            .err()
            .unwrap_or(StorageError::InvalidInput {
                field: "test-fixture",
            });
        let rendered = error.to_string();
        assert!(!rendered.contains(secret));
        assert!(!rendered.contains("private-password"));
    }

    #[test]
    fn exact_reference_sql_uses_a_non_keyword_alias() {
        let sql = exact_reference_sql("\"fixture\"");
        assert!(sql.contains("AS refs"));
        assert!(!sql.contains("AS references"));
        assert!(sql.contains("refs.target_symbol_id::text"));
    }
}
