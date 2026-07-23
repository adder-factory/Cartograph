use std::{
    collections::{BTreeMap, btree_map::Entry},
    io::{self, Write},
};

use cartograph_domain::{FileId, FileParseStatus, SymbolId};
use serde_json::Value;

use crate::StorageError;

use super::{
    digest::logical_digest,
    model::{
        EdgeInput, FileInput, GenerationFacts, ReferenceInput, SearchDocumentInput, SymbolInput,
        ValidatedFactTables, ValidatedGenerationFacts, ValidatedSearchDocument,
    },
};

const MAX_PATH_BYTES: usize = 4_096;
const MAX_LANGUAGE_BYTES: usize = 64;
const MAX_SYMBOL_KIND_BYTES: usize = 64;
const MAX_QUALIFIED_NAME_BYTES: usize = 2_048;
const MAX_SIGNATURE_BYTES: usize = 64 * 1_024;
const MAX_PROVENANCE_BYTES: usize = 256;
const MAX_REFERENCE_KIND_BYTES: usize = 64;
const MAX_CODE_BYTES: usize = 8 * 1_024 * 1_024;
const MAX_NATURAL_TEXT_BYTES: usize = 1_024 * 1_024;
const MAX_METADATA_BYTES: usize = 64 * 1_024;
const MAX_METADATA_DEPTH: usize = 64;
const MIN_CANONICAL_OBJECT_ENTRY_BYTES: usize = 4;
const MAX_DATABASE_BIGINT: u64 = i64::MAX.unsigned_abs();
const MAX_DATABASE_INTEGER: u32 = i32::MAX.unsigned_abs();

pub(crate) fn validate_and_reduce(
    facts: GenerationFacts,
) -> Result<ValidatedGenerationFacts, StorageError> {
    let tables = ValidatedFactTables {
        files: reduce_files(facts.files)?,
        symbols: reduce_symbols(facts.symbols)?,
        edges: reduce_edges(facts.edges)?,
        references: reduce_references(facts.references)?,
        documents: reduce_documents(facts.documents)?,
    };
    validate_relations(&tables)?;
    let digest = logical_digest(&tables);
    Ok(ValidatedGenerationFacts { tables, digest })
}

fn reduce_files(files: Vec<FileInput>) -> Result<Vec<FileInput>, StorageError> {
    let mut by_id = BTreeMap::<String, FileInput>::new();
    let mut paths = BTreeMap::<String, String>::new();
    for file in files {
        validate_project_path(&file.normalized_path, "normalized_path")?;
        validate_language(&file.language)?;
        if file.byte_size > MAX_DATABASE_BIGINT {
            return Err(invalid("byte_size"));
        }
        let id = file.file_id.as_str().to_owned();
        match by_id.entry(id.clone()) {
            Entry::Occupied(entry) if entry.get() != &file => {
                return Err(invalid("duplicate_file_id"));
            }
            Entry::Occupied(_) => continue,
            Entry::Vacant(_) => {}
        }
        match paths.entry(file.normalized_path.clone()) {
            Entry::Occupied(entry) if entry.get() != &id => {
                return Err(invalid("duplicate_normalized_path"));
            }
            Entry::Occupied(_) => {}
            Entry::Vacant(entry) => {
                entry.insert(id.clone());
            }
        }
        by_id.insert(id, file);
    }
    Ok(by_id.into_values().collect())
}

fn reduce_symbols(symbols: Vec<SymbolInput>) -> Result<Vec<SymbolInput>, StorageError> {
    let mut by_id = BTreeMap::<String, SymbolInput>::new();
    for symbol in symbols {
        validate_bounded_text(&symbol.symbol_kind, "symbol_kind", MAX_SYMBOL_KIND_BYTES)?;
        validate_bounded_text(
            &symbol.qualified_name,
            "qualified_name",
            MAX_QUALIFIED_NAME_BYTES,
        )?;
        validate_optional_text(&symbol.signature, "signature", MAX_SIGNATURE_BYTES)?;
        validate_span(symbol.start_byte, symbol.end_byte, "symbol_byte_span")?;
        validate_lines(symbol.start_line, symbol.end_line)?;
        insert_unique(
            &mut by_id,
            UniqueInput {
                key: symbol.symbol_id.as_str().to_owned(),
                value: symbol,
                field: "duplicate_symbol_id",
            },
        )?;
    }
    Ok(by_id.into_values().collect())
}

fn reduce_edges(edges: Vec<EdgeInput>) -> Result<Vec<EdgeInput>, StorageError> {
    let mut by_key = BTreeMap::<(String, String, String, String), EdgeInput>::new();
    for mut edge in edges {
        edge.confidence = validate_confidence(edge.confidence)?;
        validate_bounded_text(&edge.provenance, "provenance", MAX_PROVENANCE_BYTES)?;
        let key = (
            edge.source_symbol_id.as_str().to_owned(),
            edge.target_symbol_id.as_str().to_owned(),
            edge.kind.as_str().to_owned(),
            edge.provenance.clone(),
        );
        insert_unique(
            &mut by_key,
            UniqueInput {
                key,
                value: edge,
                field: "duplicate_edge",
            },
        )?;
    }
    Ok(by_key.into_values().collect())
}

fn reduce_references(references: Vec<ReferenceInput>) -> Result<Vec<ReferenceInput>, StorageError> {
    let mut by_key = BTreeMap::<(String, Option<String>, String, u64, u64), ReferenceInput>::new();
    for mut reference in references {
        validate_bounded_text(
            &reference.reference_kind,
            "reference_kind",
            MAX_REFERENCE_KIND_BYTES,
        )?;
        validate_span(
            reference.start_byte,
            reference.end_byte,
            "reference_byte_span",
        )?;
        reference.confidence = validate_confidence(reference.confidence)?;
        let key = (
            reference.file_id.as_str().to_owned(),
            reference
                .target_symbol_id
                .as_ref()
                .map(|symbol| symbol.as_str().to_owned()),
            reference.reference_kind.clone(),
            reference.start_byte,
            reference.end_byte,
        );
        insert_unique(
            &mut by_key,
            UniqueInput {
                key,
                value: reference,
                field: "duplicate_reference",
            },
        )?;
    }
    Ok(by_key.into_values().collect())
}

fn reduce_documents(
    documents: Vec<SearchDocumentInput>,
) -> Result<Vec<ValidatedSearchDocument>, StorageError> {
    let mut by_id = BTreeMap::<String, ValidatedSearchDocument>::new();
    for document in documents {
        let validated = validate_document(document)?;
        insert_unique(
            &mut by_id,
            UniqueInput {
                key: validated.document_id.as_str().to_owned(),
                value: validated,
                field: "duplicate_document_id",
            },
        )?;
    }
    Ok(by_id.into_values().collect())
}

fn validate_document(
    document: SearchDocumentInput,
) -> Result<ValidatedSearchDocument, StorageError> {
    validate_project_path(&document.path, "path")?;
    validate_language(&document.language)?;
    validate_optional_text(
        &document.qualified_name,
        "qualified_name",
        MAX_QUALIFIED_NAME_BYTES,
    )?;
    validate_optional_text(&document.code, "code", MAX_CODE_BYTES)?;
    validate_optional_text(
        &document.natural_text,
        "natural_text",
        MAX_NATURAL_TEXT_BYTES,
    )?;
    if document.qualified_name.is_empty()
        && document.code.is_empty()
        && document.natural_text.is_empty()
    {
        return Err(invalid("searchable_text"));
    }
    if !document.metadata.is_object() {
        return Err(invalid("metadata"));
    }
    let metadata_json = canonical_json(&document.metadata)?;
    if metadata_json.len() > MAX_METADATA_BYTES || metadata_json.contains('\0') {
        return Err(invalid("metadata"));
    }
    Ok(ValidatedSearchDocument {
        document_id: document.document_id,
        file_id: document.file_id,
        symbol_id: document.symbol_id,
        path: document.path,
        language: document.language,
        kind: document.kind,
        qualified_name: document.qualified_name,
        code: document.code,
        natural_text: document.natural_text,
        metadata_json,
    })
}

fn validate_relations(facts: &ValidatedFactTables) -> Result<(), StorageError> {
    let files = facts
        .files
        .iter()
        .map(|file| (file.file_id.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let symbols = facts
        .symbols
        .iter()
        .map(|symbol| (symbol.symbol_id.as_str(), symbol))
        .collect::<BTreeMap<_, _>>();
    for symbol in &facts.symbols {
        let file = require_file(&files, &symbol.file_id, "symbol_file_id")?;
        require_structural_file(file, "symbol_file_parse_status")?;
        require_within_file(symbol.end_byte, file, "symbol_byte_span")?;
    }
    for edge in &facts.edges {
        require_symbol(&symbols, &edge.source_symbol_id, "edge_source_symbol_id")?;
        require_symbol(&symbols, &edge.target_symbol_id, "edge_target_symbol_id")?;
    }
    for reference in &facts.references {
        let file = require_file(&files, &reference.file_id, "reference_file_id")?;
        require_structural_file(file, "reference_file_parse_status")?;
        require_within_file(reference.end_byte, file, "reference_byte_span")?;
        if let Some(symbol) = &reference.target_symbol_id {
            require_symbol(&symbols, symbol, "reference_target_symbol_id")?;
        }
    }
    for document in &facts.documents {
        validate_document_relations(document, &files, &symbols)?;
    }
    Ok(())
}

fn validate_document_relations(
    document: &ValidatedSearchDocument,
    files: &BTreeMap<&str, &FileInput>,
    symbols: &BTreeMap<&str, &SymbolInput>,
) -> Result<(), StorageError> {
    let explicit_file = document
        .file_id
        .as_ref()
        .map(|file| require_file(files, file, "document_file_id"))
        .transpose()?;
    let symbol_file = document
        .symbol_id
        .as_ref()
        .map(|symbol| {
            require_symbol(symbols, symbol, "document_symbol_id")
                .and_then(|symbol| require_file(files, &symbol.file_id, "document_symbol_file"))
        })
        .transpose()?;
    if let (Some(explicit), Some(symbol)) = (explicit_file, symbol_file)
        && explicit.file_id != symbol.file_id
    {
        return Err(invalid("document_symbol_file"));
    }
    if let Some(file) = explicit_file.or(symbol_file) {
        if document.path != file.normalized_path {
            return Err(invalid("document_path"));
        }
        if document.language != file.language {
            return Err(invalid("document_language"));
        }
    }
    Ok(())
}

fn require_file<'a>(
    files: &BTreeMap<&str, &'a FileInput>,
    file_id: &FileId,
    field: &'static str,
) -> Result<&'a FileInput, StorageError> {
    files.get(file_id.as_str()).copied().ok_or(invalid(field))
}

fn require_symbol<'a>(
    symbols: &BTreeMap<&str, &'a SymbolInput>,
    symbol_id: &SymbolId,
    field: &'static str,
) -> Result<&'a SymbolInput, StorageError> {
    symbols
        .get(symbol_id.as_str())
        .copied()
        .ok_or(invalid(field))
}

fn require_within_file(
    end_byte: u64,
    file: &FileInput,
    field: &'static str,
) -> Result<(), StorageError> {
    if end_byte <= file.byte_size {
        Ok(())
    } else {
        Err(invalid(field))
    }
}

fn require_structural_file(file: &FileInput, field: &'static str) -> Result<(), StorageError> {
    match file.parse_status {
        FileParseStatus::Parsed | FileParseStatus::Partial => Ok(()),
        FileParseStatus::Failed | FileParseStatus::Skipped => Err(invalid(field)),
    }
}

fn insert_unique<K, V>(
    values: &mut BTreeMap<K, V>,
    input: UniqueInput<K, V>,
) -> Result<(), StorageError>
where
    K: Ord,
    V: PartialEq,
{
    match values.entry(input.key) {
        Entry::Occupied(entry) if entry.get() != &input.value => Err(invalid(input.field)),
        Entry::Occupied(_) => Ok(()),
        Entry::Vacant(entry) => {
            entry.insert(input.value);
            Ok(())
        }
    }
}

struct UniqueInput<K, V> {
    key: K,
    value: V,
    field: &'static str,
}

fn validate_project_path(value: &str, field: &'static str) -> Result<(), StorageError> {
    validate_bounded_text(value, field, MAX_PATH_BYTES)?;
    let has_drive_prefix = value.as_bytes().get(1).copied() == Some(b':');
    let invalid_segment = value
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."));
    if value.starts_with('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || has_drive_prefix
        || invalid_segment
    {
        return Err(invalid(field));
    }
    Ok(())
}

fn validate_language(value: &str) -> Result<(), StorageError> {
    validate_bounded_text(value, "language", MAX_LANGUAGE_BYTES)?;
    if value.bytes().all(|byte| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'_' | b'+' | b'.' | b'-')
    }) {
        Ok(())
    } else {
        Err(invalid("language"))
    }
}

fn validate_span(start: u64, end: u64, field: &'static str) -> Result<(), StorageError> {
    if start > MAX_DATABASE_BIGINT || end > MAX_DATABASE_BIGINT || end < start {
        Err(invalid(field))
    } else {
        Ok(())
    }
}

fn validate_lines(start: u32, end: u32) -> Result<(), StorageError> {
    if start == 0 || end < start || end > MAX_DATABASE_INTEGER {
        Err(invalid("symbol_line_span"))
    } else {
        Ok(())
    }
}

fn validate_confidence(confidence: f32) -> Result<f32, StorageError> {
    if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
        return Err(invalid("confidence"));
    }
    Ok(if confidence == 0.0 { 0.0 } else { confidence })
}

fn validate_bounded_text(
    value: &str,
    field: &'static str,
    maximum: usize,
) -> Result<(), StorageError> {
    if value.trim().is_empty() || value.len() > maximum || value.contains('\0') {
        Err(invalid(field))
    } else {
        Ok(())
    }
}

fn validate_optional_text(
    value: &str,
    field: &'static str,
    maximum: usize,
) -> Result<(), StorageError> {
    if value.len() > maximum || value.contains('\0') {
        Err(invalid(field))
    } else {
        Ok(())
    }
}

fn canonical_json(value: &Value) -> Result<String, StorageError> {
    let mut output = BoundedJsonWriter::new();
    write_canonical_json(value, &mut output, 0)?;
    String::from_utf8(output.into_bytes()).map_err(|_| invalid("metadata"))
}

fn write_canonical_json(
    value: &Value,
    output: &mut BoundedJsonWriter,
    depth: usize,
) -> Result<(), StorageError> {
    if depth > MAX_METADATA_DEPTH {
        return Err(invalid("metadata_depth"));
    }
    match value {
        Value::Null => write_fragment(output, b"null")?,
        Value::Bool(boolean) => {
            write_fragment(output, if *boolean { b"true" } else { b"false" })?;
        }
        Value::Number(number) => write_json_value(output, number)?,
        Value::String(string) => write_json_value(output, string)?,
        Value::Array(values) => {
            write_fragment(output, b"[")?;
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    write_fragment(output, b",")?;
                }
                write_canonical_json(value, output, depth + 1)?;
            }
            write_fragment(output, b"]")?;
        }
        Value::Object(values) => {
            let maximum_entries = MAX_METADATA_BYTES / MIN_CANONICAL_OBJECT_ENTRY_BYTES;
            if values.len() > maximum_entries {
                return Err(invalid("metadata"));
            }
            write_fragment(output, b"{")?;
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    write_fragment(output, b",")?;
                }
                write_json_value(output, key)?;
                write_fragment(output, b":")?;
                write_canonical_json(value, output, depth + 1)?;
            }
            write_fragment(output, b"}")?;
        }
    }
    Ok(())
}

fn write_json_value<T: serde::Serialize + ?Sized>(
    output: &mut BoundedJsonWriter,
    value: &T,
) -> Result<(), StorageError> {
    serde_json::to_writer(output, value).map_err(|_| invalid("metadata"))
}

fn write_fragment(output: &mut BoundedJsonWriter, fragment: &[u8]) -> Result<(), StorageError> {
    output.write_all(fragment).map_err(|_| invalid("metadata"))
}

struct BoundedJsonWriter {
    bytes: Vec<u8>,
}

impl BoundedJsonWriter {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

impl Write for BoundedJsonWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > MAX_METADATA_BYTES {
            return Err(io::Error::other(
                "canonical metadata exceeds its byte budget",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

const fn invalid(field: &'static str) -> StorageError {
    StorageError::InvalidInput { field }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cartograph_domain::{ContentDigest, DocumentId, DocumentKind, FileParseStatus};

    const TEST_DIGEST_BYTE: u8 = 0x11;
    const TEST_DIGEST_LENGTH: usize = 32;
    const TEST_FILE_SIZE: u64 = 10;
    const TEST_SYMBOL_END: u64 = TEST_FILE_SIZE;

    fn digest() -> ContentDigest {
        ContentDigest::from_bytes([TEST_DIGEST_BYTE; TEST_DIGEST_LENGTH])
    }

    fn file() -> FileInput {
        FileInput {
            file_id: file_id(),
            normalized_path: "src/lib.rs".to_owned(),
            language: "rust".to_owned(),
            content_hash: digest(),
            byte_size: TEST_FILE_SIZE,
            parse_status: FileParseStatus::Parsed,
        }
    }

    fn file_id() -> FileId {
        match FileId::parse("11111111-1111-4111-8111-111111111111") {
            Ok(id) => id,
            Err(error) => panic!("fixture file ID is invalid: {error}"),
        }
    }

    fn document_id() -> cartograph_domain::DocumentId {
        match DocumentId::parse("22222222-2222-4222-8222-222222222222") {
            Ok(id) => id,
            Err(error) => panic!("fixture document ID is invalid: {error}"),
        }
    }

    fn symbol_id() -> SymbolId {
        match SymbolId::parse("33333333-3333-4333-8333-333333333333") {
            Ok(id) => id,
            Err(error) => panic!("fixture symbol ID is invalid: {error}"),
        }
    }

    fn symbol() -> SymbolInput {
        SymbolInput {
            symbol_id: symbol_id(),
            file_id: file_id(),
            symbol_kind: "function".to_owned(),
            qualified_name: "fixture::symbol".to_owned(),
            signature: "fn symbol()".to_owned(),
            start_byte: 0,
            end_byte: TEST_SYMBOL_END,
            start_line: 1,
            end_line: 1,
            structural_digest: digest(),
        }
    }

    fn reference() -> ReferenceInput {
        ReferenceInput {
            file_id: file_id(),
            target_symbol_id: None,
            reference_kind: "call".to_owned(),
            start_byte: 0,
            end_byte: TEST_FILE_SIZE,
            confidence: 1.0,
        }
    }

    fn document() -> SearchDocumentInput {
        SearchDocumentInput {
            document_id: document_id(),
            file_id: Some(file_id()),
            symbol_id: None,
            path: "src/lib.rs".to_owned(),
            language: "rust".to_owned(),
            kind: DocumentKind::File,
            qualified_name: String::new(),
            code: "fn main() {}".to_owned(),
            natural_text: String::new(),
            metadata: serde_json::json!({"z": 1, "a": {"y": 2, "b": 3}}),
        }
    }

    #[test]
    fn reduction_deduplicates_equal_facts_but_rejects_conflicting_identity() {
        let base = file();
        let equal = base.clone();
        let facts = GenerationFacts {
            files: vec![base.clone(), equal],
            ..GenerationFacts::default()
        };
        assert!(matches!(
            validate_and_reduce(facts),
            Ok(facts) if facts.tables.files.len() == 1
        ));

        let mut conflicting = base.clone();
        conflicting.normalized_path = "src/other.rs".to_owned();
        let facts = GenerationFacts {
            files: vec![base, conflicting],
            ..GenerationFacts::default()
        };
        assert!(matches!(
            validate_and_reduce(facts),
            Err(StorageError::InvalidInput {
                field: "duplicate_file_id"
            })
        ));
    }

    #[test]
    fn validation_rejects_unresolved_relations_and_canonicalizes_metadata() {
        let document = document();
        let missing_file = GenerationFacts {
            documents: vec![document.clone()],
            ..GenerationFacts::default()
        };
        assert!(matches!(
            validate_and_reduce(missing_file),
            Err(StorageError::InvalidInput {
                field: "document_file_id"
            })
        ));

        let facts = GenerationFacts {
            files: vec![file()],
            documents: vec![document],
            ..GenerationFacts::default()
        };
        let validated = match validate_and_reduce(facts) {
            Ok(validated) => validated,
            Err(error) => panic!("valid fact set was rejected: {error}"),
        };
        assert_eq!(
            validated.tables.documents[0].metadata_json,
            r#"{"a":{"b":3,"y":2},"z":1}"#
        );
    }

    #[test]
    fn validation_rejects_spans_outside_the_owning_file() {
        let mut outside_symbol = symbol();
        outside_symbol.end_byte = TEST_FILE_SIZE + 1;
        let facts = GenerationFacts {
            files: vec![file()],
            symbols: vec![outside_symbol],
            ..GenerationFacts::default()
        };
        assert!(matches!(
            validate_and_reduce(facts),
            Err(StorageError::InvalidInput {
                field: "symbol_byte_span"
            })
        ));

        let facts = GenerationFacts {
            files: vec![file()],
            references: vec![ReferenceInput {
                end_byte: TEST_FILE_SIZE + 1,
                ..reference()
            }],
            ..GenerationFacts::default()
        };
        assert!(matches!(
            validate_and_reduce(facts),
            Err(StorageError::InvalidInput {
                field: "reference_byte_span"
            })
        ));
    }

    #[test]
    fn validation_rejects_structural_facts_for_unparsed_files() {
        let mut failed = file();
        failed.parse_status = FileParseStatus::Failed;
        let facts = GenerationFacts {
            files: vec![failed],
            symbols: vec![symbol()],
            ..GenerationFacts::default()
        };
        assert!(matches!(
            validate_and_reduce(facts),
            Err(StorageError::InvalidInput {
                field: "symbol_file_parse_status"
            })
        ));

        let mut skipped = file();
        skipped.parse_status = FileParseStatus::Skipped;
        let facts = GenerationFacts {
            files: vec![skipped],
            references: vec![reference()],
            ..GenerationFacts::default()
        };
        assert!(matches!(
            validate_and_reduce(facts),
            Err(StorageError::InvalidInput {
                field: "reference_file_parse_status"
            })
        ));

        let mut partial = file();
        partial.parse_status = FileParseStatus::Partial;
        let facts = GenerationFacts {
            files: vec![partial],
            symbols: vec![symbol()],
            references: vec![reference()],
            ..GenerationFacts::default()
        };
        assert!(validate_and_reduce(facts).is_ok());
    }

    #[test]
    fn validation_rejects_document_identity_that_contradicts_its_file() {
        let mut wrong_path = document();
        wrong_path.path = "src/other.rs".to_owned();
        let facts = GenerationFacts {
            files: vec![file()],
            documents: vec![wrong_path],
            ..GenerationFacts::default()
        };
        assert!(matches!(
            validate_and_reduce(facts),
            Err(StorageError::InvalidInput {
                field: "document_path"
            })
        ));

        let mut symbol_document = document();
        symbol_document.file_id = None;
        symbol_document.symbol_id = Some(symbol_id());
        symbol_document.language = "typescript".to_owned();
        let facts = GenerationFacts {
            files: vec![file()],
            symbols: vec![symbol()],
            documents: vec![symbol_document],
            ..GenerationFacts::default()
        };
        assert!(matches!(
            validate_and_reduce(facts),
            Err(StorageError::InvalidInput {
                field: "document_language"
            })
        ));
    }

    #[test]
    fn search_document_validation_preserves_bounded_searchable_contract() {
        let mut non_object = document();
        non_object.metadata = serde_json::json!(["not", "an", "object"]);
        assert!(matches!(
            validate_document(non_object),
            Err(StorageError::InvalidInput { field: "metadata" })
        ));

        let mut unbounded = document();
        unbounded.code = "x".repeat(MAX_CODE_BYTES + 1);
        assert!(matches!(
            validate_document(unbounded),
            Err(StorageError::InvalidInput { field: "code" })
        ));

        let mut oversized_metadata = document();
        oversized_metadata.metadata = serde_json::json!({"large": "x".repeat(MAX_METADATA_BYTES)});
        assert!(matches!(
            validate_document(oversized_metadata),
            Err(StorageError::InvalidInput { field: "metadata" })
        ));

        let mut wide = serde_json::Map::new();
        let excessive_entries = MAX_METADATA_BYTES / MIN_CANONICAL_OBJECT_ENTRY_BYTES + 1;
        for index in 0..excessive_entries {
            wide.insert(index.to_string(), Value::Null);
        }
        let mut wide_metadata = document();
        wide_metadata.metadata = Value::Object(wide);
        assert!(matches!(
            validate_document(wide_metadata),
            Err(StorageError::InvalidInput { field: "metadata" })
        ));

        let mut empty = document();
        empty.code.clear();
        assert!(matches!(
            validate_document(empty),
            Err(StorageError::InvalidInput {
                field: "searchable_text"
            })
        ));
    }
}
