use cartograph_domain::{
    ContentDigest, DocumentId, DocumentKind, EdgeKind, FileId, FileParseStatus, SymbolId,
};
use serde_json::Value;

/// One source-file fact staged into an immutable generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileInput {
    /// Stable identity derived independently of worker scheduling.
    pub file_id: FileId,
    /// Project-normalized source path.
    pub normalized_path: String,
    /// Normalized language identifier.
    pub language: String,
    /// Digest of the complete source bytes.
    pub content_hash: ContentDigest,
    /// Original source size in bytes.
    pub byte_size: u64,
    /// Parser/extractor outcome.
    pub parse_status: FileParseStatus,
}

/// One code-symbol fact tied to a staged file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolInput {
    /// Stable structural symbol identity.
    pub symbol_id: SymbolId,
    /// File containing the symbol.
    pub file_id: FileId,
    /// Extractor-defined bounded symbol category.
    pub symbol_kind: String,
    /// Fully qualified display/search name.
    pub qualified_name: String,
    /// Deterministic declaration signature.
    pub signature: String,
    /// Inclusive start byte in the source file.
    pub start_byte: u64,
    /// Exclusive end byte in the source file.
    pub end_byte: u64,
    /// One-based inclusive start line.
    pub start_line: u32,
    /// One-based inclusive end line.
    pub end_line: u32,
    /// Digest of the normalized structural representation.
    pub structural_digest: ContentDigest,
}

/// One resolved structural graph edge.
#[derive(Clone, Debug, PartialEq)]
pub struct EdgeInput {
    /// Origin symbol.
    pub source_symbol_id: SymbolId,
    /// Destination symbol.
    pub target_symbol_id: SymbolId,
    /// Typed relationship.
    pub kind: EdgeKind,
    /// Calibrated confidence in the inclusive range 0 through 1.
    pub confidence: f32,
    /// Bounded resolver/extractor provenance.
    pub provenance: String,
}

/// One source span that refers to an optional resolved symbol.
#[derive(Clone, Debug, PartialEq)]
pub struct ReferenceInput {
    /// File containing the reference.
    pub file_id: FileId,
    /// Resolved target when available.
    pub target_symbol_id: Option<SymbolId>,
    /// Extractor-defined bounded reference category.
    pub reference_kind: String,
    /// Inclusive start byte in the source file.
    pub start_byte: u64,
    /// Exclusive end byte in the source file.
    pub end_byte: u64,
    /// Calibrated confidence in the inclusive range 0 through 1.
    pub confidence: f32,
}

/// Search document staged as part of one immutable generation.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchDocumentInput {
    /// Stable logical identity, independent of ParadeDB's bigint key field.
    pub document_id: DocumentId,
    /// Owning file when the structural file row is available.
    pub file_id: Option<FileId>,
    /// Owning symbol for symbol-level evidence.
    pub symbol_id: Option<SymbolId>,
    /// Project-normalized source path.
    pub path: String,
    /// Normalized language identifier.
    pub language: String,
    /// Intent-routing document category.
    pub kind: DocumentKind,
    /// Code-aware symbol or declaration name.
    pub qualified_name: String,
    /// Source text indexed with `pdb.source_code`.
    pub code: String,
    /// Documentation and summaries indexed as natural language.
    pub natural_text: String,
    /// Bounded structured ranking/filter metadata.
    pub metadata: Value,
}

/// Complete unordered worker output for one logical generation.
///
/// Validation sorts, canonicalizes, and deduplicates these facts before COPY.
#[derive(Clone, Debug, Default)]
pub struct GenerationFacts {
    /// Source-file facts.
    pub files: Vec<FileInput>,
    /// Symbol facts.
    pub symbols: Vec<SymbolInput>,
    /// Graph-edge facts.
    pub edges: Vec<EdgeInput>,
    /// Reference-span facts.
    pub references: Vec<ReferenceInput>,
    /// BM25 search documents.
    pub documents: Vec<SearchDocumentInput>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ValidatedSearchDocument {
    pub(super) document_id: DocumentId,
    pub(super) file_id: Option<FileId>,
    pub(super) symbol_id: Option<SymbolId>,
    pub(super) path: String,
    pub(super) language: String,
    pub(super) kind: DocumentKind,
    pub(super) qualified_name: String,
    pub(super) code: String,
    pub(super) natural_text: String,
    pub(super) metadata_json: String,
}

pub(super) struct ValidatedFactTables {
    pub(super) files: Vec<FileInput>,
    pub(super) symbols: Vec<SymbolInput>,
    pub(super) edges: Vec<EdgeInput>,
    pub(super) references: Vec<ReferenceInput>,
    pub(super) documents: Vec<ValidatedSearchDocument>,
}

pub(crate) struct ValidatedGenerationFacts {
    pub(super) tables: ValidatedFactTables,
    pub(crate) digest: ContentDigest,
}
