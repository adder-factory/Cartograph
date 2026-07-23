use std::fmt::Display;

use cartograph_config::DatabaseSchema;
use cartograph_domain::{GenerationId, ProjectId};
use sqlx_core::error::Error as SqlxError;
use sqlx_postgres::{PgConnection, PgCopyIn};

use crate::{StorageError, database::quoted_schema};

use super::model::{
    EdgeInput, FileInput, ReferenceInput, SymbolInput, ValidatedGenerationFacts,
    ValidatedSearchDocument,
};

const COPY_CHUNK_BYTES: usize = 1024 * 1024;
const COPY_ABORT_MESSAGE: &str = "Cartograph v2 COPY stream aborted";
const ASCII_BACKSPACE: u8 = 0x08;
const ASCII_VERTICAL_TAB: u8 = 0x0b;
const ASCII_FORM_FEED: u8 = 0x0c;

/// Validated schema and generation identity repeated in every copied row.
#[derive(Clone, Copy)]
pub(crate) struct CopyGenerationContext<'a> {
    pub(crate) schema: &'a DatabaseSchema,
    pub(crate) project_id: &'a ProjectId,
    pub(crate) generation_id: &'a GenerationId,
}

struct CopyTableSpec {
    statement: String,
    expected_rows: usize,
    operation: &'static str,
}

pub(crate) async fn copy_generation_facts(
    connection: &mut PgConnection,
    context: CopyGenerationContext<'_>,
    facts: &ValidatedGenerationFacts,
) -> Result<(), StorageError> {
    let schema = quoted_schema(context.schema);
    let tables = &facts.tables;
    copy_text_rows(
        connection,
        CopyTableSpec {
            statement: format!(
                r#"COPY {schema}."files" (
                    project_id, generation_id, file_id, normalized_path, language,
                    content_hash, byte_size, parse_status
                ) FROM STDIN WITH (FORMAT text)"#
            ),
            expected_rows: tables.files.len(),
            operation: "copy-files",
        },
        tables.files.iter().map(|file| encode_file(context, file)),
    )
    .await?;
    copy_text_rows(
        connection,
        CopyTableSpec {
            statement: format!(
                r#"COPY {schema}."symbols" (
                    project_id, generation_id, symbol_id, file_id, symbol_kind,
                    qualified_name, signature, start_byte, end_byte, start_line,
                    end_line, structural_digest
                ) FROM STDIN WITH (FORMAT text)"#
            ),
            expected_rows: tables.symbols.len(),
            operation: "copy-symbols",
        },
        tables
            .symbols
            .iter()
            .map(|symbol| encode_symbol(context, symbol)),
    )
    .await?;
    copy_text_rows(
        connection,
        CopyTableSpec {
            statement: format!(
                r#"COPY {schema}."edges" (
                    project_id, generation_id, source_symbol_id, target_symbol_id,
                    edge_kind, confidence, provenance
                ) FROM STDIN WITH (FORMAT text)"#
            ),
            expected_rows: tables.edges.len(),
            operation: "copy-edges",
        },
        tables.edges.iter().map(|edge| encode_edge(context, edge)),
    )
    .await?;
    copy_text_rows(
        connection,
        CopyTableSpec {
            statement: format!(
                r#"COPY {schema}."references" (
                    project_id, generation_id, file_id, target_symbol_id,
                    reference_kind, start_byte, end_byte, confidence
                ) FROM STDIN WITH (FORMAT text)"#
            ),
            expected_rows: tables.references.len(),
            operation: "copy-references",
        },
        tables
            .references
            .iter()
            .map(|reference| encode_reference(context, reference)),
    )
    .await?;
    copy_text_rows(
        connection,
        CopyTableSpec {
            statement: format!(
                r#"COPY {schema}."search_documents" (
                    project_id, generation_id, document_id, file_id, symbol_id,
                    path, language, document_kind, qualified_name, code,
                    natural_text, metadata
                ) FROM STDIN WITH (FORMAT text)"#
            ),
            expected_rows: tables.documents.len(),
            operation: "copy-search-documents",
        },
        tables
            .documents
            .iter()
            .map(|document| encode_document(context, document)),
    )
    .await
}

async fn copy_text_rows<I>(
    connection: &mut PgConnection,
    spec: CopyTableSpec,
    rows: I,
) -> Result<(), StorageError>
where
    I: IntoIterator<Item = Vec<u8>>,
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
    I: IntoIterator<Item = Vec<u8>>,
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

fn encode_file(context: CopyGenerationContext<'_>, file: &FileInput) -> Vec<u8> {
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

fn encode_symbol(context: CopyGenerationContext<'_>, symbol: &SymbolInput) -> Vec<u8> {
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
    row.finish()
}

fn encode_edge(context: CopyGenerationContext<'_>, edge: &EdgeInput) -> Vec<u8> {
    let mut row = TextRow::new();
    row.text(context.project_id.as_str());
    row.text(context.generation_id.as_str());
    row.text(edge.source_symbol_id.as_str());
    row.text(edge.target_symbol_id.as_str());
    row.text(edge.kind.as_str());
    row.number(edge.confidence);
    row.text(&edge.provenance);
    row.finish()
}

fn encode_reference(context: CopyGenerationContext<'_>, reference: &ReferenceInput) -> Vec<u8> {
    let mut row = TextRow::new();
    row.text(context.project_id.as_str());
    row.text(context.generation_id.as_str());
    row.text(reference.file_id.as_str());
    row.optional_text(
        reference
            .target_symbol_id
            .as_ref()
            .map(|symbol| symbol.as_str()),
    );
    row.text(&reference.reference_kind);
    row.number(reference.start_byte);
    row.number(reference.end_byte);
    row.number(reference.confidence);
    row.finish()
}

fn encode_document(
    context: CopyGenerationContext<'_>,
    document: &ValidatedSearchDocument,
) -> Vec<u8> {
    let mut row = TextRow::new();
    row.text(context.project_id.as_str());
    row.text(context.generation_id.as_str());
    row.text(document.document_id.as_str());
    row.optional_text(document.file_id.as_ref().map(|file| file.as_str()));
    row.optional_text(document.symbol_id.as_ref().map(|symbol| symbol.as_str()));
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
        match value {
            Some(value) => self.text(value),
            None => {
                self.delimiter();
                self.bytes.extend_from_slice(br"\N");
            }
        }
    }

    fn number(&mut self, value: impl Display) {
        self.text(&value.to_string());
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
