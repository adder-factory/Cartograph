use std::{
    fmt::Display,
    time::{Duration, Instant},
};

use cartograph_config::DatabaseSchema;
use cartograph_domain::{GenerationId, ProjectId};
use sqlx_core::error::Error as SqlxError;
use sqlx_postgres::{PgConnection, PgCopyIn};

use crate::{StorageError, database::quoted_schema};

use super::model::{
    CanonicalGenerationFacts, CanonicalSearchDocument, EdgeInput, FileInput, ReferenceInput,
    SymbolInput, ValidatedFactTables,
};

const COPY_CHUNK_BYTES: usize = 1024 * 1024;
const COPY_ABORT_MESSAGE: &str = "Cartograph v2 COPY stream aborted";
const ASCII_BACKSPACE: u8 = 0x08;
const ASCII_VERTICAL_TAB: u8 = 0x0b;
const ASCII_FORM_FEED: u8 = 0x0c;

/// Validated schema and generation identity repeated in every copied row.
#[derive(Clone)]
pub(crate) struct CopyGenerationContext {
    pub(crate) schema: DatabaseSchema,
    pub(crate) project_id: ProjectId,
    pub(crate) generation_id: GenerationId,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CopyTableDurations {
    pub(crate) files: Duration,
    pub(crate) symbols: Duration,
    pub(crate) edges: Duration,
    pub(crate) references: Duration,
    pub(crate) documents: Duration,
}

pub(crate) struct CopyGenerationAttempt {
    pub(crate) durations: CopyTableDurations,
    pub(crate) result: Result<(), StorageError>,
}

#[derive(Clone, Copy)]
enum CopiedTable {
    Files,
    Symbols,
    Edges,
    References,
    Documents,
}

struct CopyGenerationProgress<'a> {
    connection: &'a mut PgConnection,
    context: CopyGenerationContext,
    durations: CopyTableDurations,
    result: Result<(), StorageError>,
}

struct CopyTableRequest<T, Encode> {
    rows: Vec<T>,
    layout: CopyTableLayout,
    encode: Encode,
}

impl<T, Encode> CopyTableRequest<T, Encode> {
    fn new(rows: Vec<T>, layout: CopyTableLayout, encode: Encode) -> Self {
        Self {
            rows,
            layout,
            encode,
        }
    }
}

impl CopyTableDurations {
    fn record(&mut self, table: CopiedTable, duration: Duration) {
        match table {
            CopiedTable::Files => self.files = duration,
            CopiedTable::Symbols => self.symbols = duration,
            CopiedTable::Edges => self.edges = duration,
            CopiedTable::References => self.references = duration,
            CopiedTable::Documents => self.documents = duration,
        }
    }
}

impl<'a> CopyGenerationProgress<'a> {
    fn new(connection: &'a mut PgConnection, context: CopyGenerationContext) -> Self {
        Self {
            connection,
            context,
            durations: CopyTableDurations::default(),
            result: Ok(()),
        }
    }

    async fn copy<T, Encode>(&mut self, request: CopyTableRequest<T, Encode>)
    where
        T: Send,
        Encode: Fn(&CopyGenerationContext, &T) -> Vec<u8> + Copy + Send,
    {
        if self.result.is_err() {
            return;
        }
        let CopyTableRequest {
            rows,
            layout,
            encode,
        } = request;
        let table = layout.copied_table;
        let plan = CopyTablePlan {
            batch: CopyBatch {
                context: self.context.clone(),
                rows,
            },
            layout,
            encode,
        };
        let (duration, result) = timed_copy_table(self.connection, plan).await;
        self.durations.record(table, duration);
        if let Err(error) = result {
            self.result = Err(error);
        }
    }

    fn finish(self) -> CopyGenerationAttempt {
        CopyGenerationAttempt {
            durations: self.durations,
            result: self.result,
        }
    }
}

struct CopyTableSpec {
    statement: String,
    expected_rows: usize,
    operation: &'static str,
}

#[derive(Clone, Copy)]
struct CopyTableLayout {
    copied_table: CopiedTable,
    table: &'static str,
    columns: &'static str,
    operation: &'static str,
}

const FILES_LAYOUT: CopyTableLayout = CopyTableLayout {
    copied_table: CopiedTable::Files,
    table: "files",
    columns: "project_id, generation_id, file_id, normalized_path, language, content_hash, byte_size, parse_status",
    operation: "copy-files",
};
const SYMBOLS_LAYOUT: CopyTableLayout = CopyTableLayout {
    copied_table: CopiedTable::Symbols,
    table: "symbols",
    columns: "project_id, generation_id, symbol_id, file_id, symbol_kind, qualified_name, signature, start_byte, end_byte, start_line, end_line, structural_digest, visibility, exported, default_export, async_symbol, static_member, declaration_only, betweenness, pagerank",
    operation: "copy-symbols",
};
const EDGES_LAYOUT: CopyTableLayout = CopyTableLayout {
    copied_table: CopiedTable::Edges,
    table: "edges",
    columns: "project_id, generation_id, source_symbol_id, target_symbol_id, edge_kind, confidence, provenance, site_count",
    operation: "copy-edges",
};
const REFERENCES_LAYOUT: CopyTableLayout = CopyTableLayout {
    copied_table: CopiedTable::References,
    table: "references",
    columns: "project_id, generation_id, file_id, owner_symbol_id, target_symbol_id, reference_name, reference_kind, start_byte, end_byte, confidence, resolution_provenance, site_count, span_precision",
    operation: "copy-references",
};
const DOCUMENTS_LAYOUT: CopyTableLayout = CopyTableLayout {
    copied_table: CopiedTable::Documents,
    table: "search_documents",
    columns: "project_id, generation_id, document_id, file_id, symbol_id, path, language, document_kind, qualified_name, code, natural_text, metadata",
    operation: "copy-search-documents",
};

struct CopyBatch<T> {
    context: CopyGenerationContext,
    rows: Vec<T>,
}

struct CopyTablePlan<T, Encode> {
    batch: CopyBatch<T>,
    layout: CopyTableLayout,
    encode: Encode,
}

pub(crate) async fn copy_generation_facts(
    connection: &mut PgConnection,
    context: CopyGenerationContext,
    facts: CanonicalGenerationFacts,
) -> CopyGenerationAttempt {
    let ValidatedFactTables {
        files,
        symbols,
        edges,
        references,
        documents,
    } = facts.tables;
    let mut progress = CopyGenerationProgress::new(connection, context);
    progress
        .copy(CopyTableRequest::new(files, FILES_LAYOUT, encode_file))
        .await;
    progress
        .copy(CopyTableRequest::new(
            symbols,
            SYMBOLS_LAYOUT,
            encode_symbol,
        ))
        .await;
    progress
        .copy(CopyTableRequest::new(edges, EDGES_LAYOUT, encode_edge))
        .await;
    progress
        .copy(CopyTableRequest::new(
            references,
            REFERENCES_LAYOUT,
            encode_reference,
        ))
        .await;
    progress
        .copy(CopyTableRequest::new(
            documents,
            DOCUMENTS_LAYOUT,
            encode_document,
        ))
        .await;
    progress.finish()
}

async fn timed_copy_table<T, Encode>(
    connection: &mut PgConnection,
    plan: CopyTablePlan<T, Encode>,
) -> (Duration, Result<(), StorageError>)
where
    T: Send,
    Encode: Fn(&CopyGenerationContext, &T) -> Vec<u8> + Copy + Send,
{
    let started = Instant::now();
    let result = copy_table(connection, plan).await;
    (started.elapsed(), result)
}

async fn copy_table<T, Encode>(
    connection: &mut PgConnection,
    plan: CopyTablePlan<T, Encode>,
) -> Result<(), StorageError>
where
    T: Send,
    Encode: Fn(&CopyGenerationContext, &T) -> Vec<u8> + Copy + Send,
{
    let CopyTablePlan {
        batch,
        layout,
        encode,
    } = plan;
    let schema = quoted_schema(&batch.context.schema);
    let expected_rows = batch.rows.len();
    let context = batch.context;
    let table = layout.table;
    let columns = layout.columns;
    copy_text_rows(
        connection,
        CopyTableSpec {
            statement: format!(
                r#"COPY {schema}."{table}" ({columns}) FROM STDIN WITH (FORMAT text)"#
            ),
            expected_rows,
            operation: layout.operation,
        },
        batch
            .rows
            .into_iter()
            .map(move |row| encode(&context, &row)),
    )
    .await
}

async fn copy_text_rows<I>(
    connection: &mut PgConnection,
    spec: CopyTableSpec,
    rows: I,
) -> Result<(), StorageError>
where
    I: IntoIterator<Item = Vec<u8>> + Send,
    I::IntoIter: Send,
{
    if spec.expected_rows == 0 {
        return Ok(());
    }
    // The only dynamic identifier is a validated, double-quoted
    // DatabaseSchema; table names and column lists are compile-time literals.
    let mut copy = connection
        .copy_in_raw(&spec.statement)
        .await
        .map_err(|_| database_error(spec.operation))?;
    if stream_rows(&mut copy, rows).await.is_err() {
        let _ = copy.abort(COPY_ABORT_MESSAGE).await;
        return Err(database_error(spec.operation));
    }
    let copied = copy
        .finish()
        .await
        .map_err(|_| database_error(spec.operation))?;
    let expected =
        u64::try_from(spec.expected_rows).map_err(|_| database_error("copy-row-count-overflow"))?;
    if copied != expected {
        return Err(database_error("copy-row-count-mismatch"));
    }
    Ok(())
}

async fn stream_rows<I>(copy: &mut PgCopyIn<&mut PgConnection>, rows: I) -> Result<(), SqlxError>
where
    I: IntoIterator<Item = Vec<u8>> + Send,
    I::IntoIter: Send,
{
    let mut chunk = Vec::with_capacity(COPY_CHUNK_BYTES);
    for row in rows {
        if !chunk.is_empty() && chunk.len().saturating_add(row.len()) > COPY_CHUNK_BYTES {
            copy.send(chunk.as_slice()).await?;
            chunk.clear();
        }
        if row.len() > COPY_CHUNK_BYTES {
            copy.send(row.as_slice()).await?;
        } else {
            chunk.extend_from_slice(&row);
        }
    }
    if !chunk.is_empty() {
        copy.send(chunk.as_slice()).await?;
    }
    Ok(())
}

fn encode_file(context: &CopyGenerationContext, file: &FileInput) -> Vec<u8> {
    let mut row = TextRow::new();
    row.text(context.project_id.as_str());
    row.text(context.generation_id.as_str());
    row.text(file.file_id.as_str());
    row.text(&file.normalized_path);
    row.text(&file.language);
    row.text(file.content_hash.as_str());
    row.number(file.byte_size);
    row.text(file.parse_status.as_str());
    row.finish()
}

fn encode_symbol(context: &CopyGenerationContext, symbol: &SymbolInput) -> Vec<u8> {
    let mut row = TextRow::new();
    row.text(context.project_id.as_str());
    row.text(context.generation_id.as_str());
    row.text(symbol.symbol_id.as_str());
    row.text(symbol.file_id.as_str());
    row.text(&symbol.symbol_kind);
    row.text(&symbol.qualified_name);
    row.text(&symbol.signature);
    row.number(symbol.start_byte);
    row.number(symbol.end_byte);
    row.number(symbol.start_line);
    row.number(symbol.end_line);
    row.text(symbol.structural_digest.as_str());
    row.optional_text(symbol.visibility.map(cartograph_domain::Visibility::as_str));
    row.number(symbol.export.exported);
    row.number(symbol.export.default_export);
    row.number(symbol.execution.async_symbol);
    row.number(symbol.execution.static_member);
    row.number(symbol.declaration_only);
    row.optional_number(
        symbol
            .betweenness_ppb
            .map(|score| f64::from(score) / 1_000_000_000.0),
    );
    row.optional_number(
        symbol
            .pagerank_ppb
            .map(|score| f64::from(score) / 1_000_000_000.0),
    );
    row.finish()
}

fn encode_edge(context: &CopyGenerationContext, edge: &EdgeInput) -> Vec<u8> {
    let mut row = TextRow::new();
    row.text(context.project_id.as_str());
    row.text(context.generation_id.as_str());
    row.text(edge.source_symbol_id.as_str());
    row.text(edge.target_symbol_id.as_str());
    row.text(edge.kind.as_str());
    row.number(edge.confidence);
    row.text(&edge.provenance);
    row.number(edge.site_count);
    row.finish()
}

fn encode_reference(context: &CopyGenerationContext, reference: &ReferenceInput) -> Vec<u8> {
    let mut row = TextRow::new();
    row.text(context.project_id.as_str());
    row.text(context.generation_id.as_str());
    row.text(reference.file_id.as_str());
    row.optional_text(
        reference
            .owner_symbol_id
            .as_ref()
            .map(cartograph_domain::SymbolId::as_str),
    );
    row.optional_text(
        reference
            .target_symbol_id
            .as_ref()
            .map(cartograph_domain::SymbolId::as_str),
    );
    row.text(&reference.reference_name);
    row.text(&reference.reference_kind);
    row.number(reference.start_byte);
    row.number(reference.end_byte);
    row.number(reference.confidence);
    row.text(&reference.resolution_provenance);
    row.number(reference.site_count);
    row.text(reference.span_precision.as_str());
    row.finish()
}

fn encode_document(context: &CopyGenerationContext, document: &CanonicalSearchDocument) -> Vec<u8> {
    let mut row = TextRow::new();
    row.text(context.project_id.as_str());
    row.text(context.generation_id.as_str());
    row.text(document.document_id.as_str());
    row.optional_text(
        document
            .file_id
            .as_ref()
            .map(cartograph_domain::FileId::as_str),
    );
    row.optional_text(
        document
            .symbol_id
            .as_ref()
            .map(cartograph_domain::SymbolId::as_str),
    );
    row.text(&document.path);
    row.text(&document.language);
    row.text(document.kind.as_str());
    row.text(&document.qualified_name);
    row.text(&document.code);
    row.text(&document.natural_text);
    row.text(&document.metadata_json);
    row.finish()
}

struct TextRow {
    bytes: Vec<u8>,
    needs_delimiter: bool,
}

impl TextRow {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            needs_delimiter: false,
        }
    }

    fn text(&mut self, value: &str) {
        self.delimiter();
        escape_text(value, &mut self.bytes);
    }

    fn optional_text(&mut self, value: Option<&str>) {
        if let Some(value) = value {
            self.text(value);
        } else {
            self.delimiter();
            self.bytes.extend_from_slice(br"\N");
        }
    }

    fn number(&mut self, value: impl Display) {
        self.text(&value.to_string());
    }

    fn optional_number(&mut self, value: Option<impl Display>) {
        if let Some(value) = value {
            self.number(value);
        } else {
            self.delimiter();
            self.bytes.extend_from_slice(br"\N");
        }
    }

    fn delimiter(&mut self) {
        if self.needs_delimiter {
            self.bytes.push(b'\t');
        }
        self.needs_delimiter = true;
    }

    fn finish(mut self) -> Vec<u8> {
        self.bytes.push(b'\n');
        self.bytes
    }
}

fn escape_text(value: &str, output: &mut Vec<u8>) {
    for byte in value.bytes() {
        match byte {
            b'\\' => output.extend_from_slice(br"\\"),
            b'\t' => output.extend_from_slice(br"\t"),
            b'\n' => output.extend_from_slice(br"\n"),
            b'\r' => output.extend_from_slice(br"\r"),
            ASCII_BACKSPACE => output.extend_from_slice(br"\b"),
            ASCII_VERTICAL_TAB => output.extend_from_slice(br"\v"),
            ASCII_FORM_FEED => output.extend_from_slice(br"\f"),
            _ => output.push(byte),
        }
    }
}

const fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_copy_encoding_distinguishes_null_and_escaped_data() {
        let mut row = TextRow::new();
        row.text("plain");
        row.text("tab\tline\nreturn\rslash\\null-marker\\N");
        row.optional_text(None);
        row.optional_text(Some(""));

        assert_eq!(
            row.finish(),
            b"plain\ttab\\tline\\nreturn\\rslash\\\\null-marker\\\\N\t\\N\t\n"
        );
    }
}
