use std::collections::{BTreeMap, BTreeSet};

use cartograph_db::{
    EdgeInput, GenerationFacts, ReferenceInput, ReferenceSpanPrecision, SearchDocumentInput,
    SymbolInput,
};
use cartograph_domain::{
    ContentDigest, DocumentId, DocumentKind, EdgeKind, FileId, NormalizedPath, SymbolId, SymbolKind,
};
use serde::Serialize;
use serde_json::json;

use crate::{
    codec::decode_scip_index,
    model::{
        SYMBOL_ROLE_DEFINITION, ScipDocument, ScipError, ScipOccurrence, ScipRelationship,
        ScipSymbolInformation,
    },
    symbol::{DescriptorSuffix, descriptors_to_qualified_name, parse_scip_symbol},
};

const SCIP_SYMBOL_ID_DOMAIN: &[u8] = b"cartograph-v2-scip-symbol-v1";
const SCIP_DOCUMENT_ID_DOMAIN: &[u8] = b"cartograph-v2-scip-document-v1";
const SCIP_STRUCTURAL_DIGEST_DOMAIN: &[u8] = b"cartograph-v2-scip-structural-v1";
const SCIP_OVERLAY_PROVENANCE: &str = "scip-overlay-exact";
const SCIP_FOREIGN_PROVENANCE: &str = "scip-overlay-foreign";
const SCIP_UNRESOLVED_PROVENANCE: &str = "scip-overlay-unresolved";
const MAXIMUM_OVERLAY_ROWS: usize = 10_000_000;
const MAXIMUM_QUALIFIED_NAME_BYTES: usize = 2_048;
const MAXIMUM_REFERENCE_NAME_BYTES: usize = 4_096;
const MAXIMUM_NATURAL_TEXT_BYTES: usize = 1_024 * 1_024;
const MAXIMUM_SITE_COUNT: u32 = 100_000_000;
const MAXIMUM_PROVENANCE_BYTES: usize = 256;
const SCIP_PROVENANCE_PREFIX: &str = "scip-overlay:";

/// Accounting for a per-file SCIP replacement overlay.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScipOverlayReport {
    covered_documents: u64,
    skipped_documents: u64,
    replaced_native_symbols: u64,
    imported_symbols: u64,
    imported_edges: u64,
    imported_references: u64,
    exact_typed_edges: u64,
    unresolved_links: u64,
}

impl ScipOverlayReport {
    /// Number of source files whose native symbol facts were replaced.
    #[must_use]
    pub const fn covered_documents(self) -> u64 {
        self.covered_documents
    }

    /// Number of invalid, stale, duplicate, or non-project documents skipped.
    #[must_use]
    pub const fn skipped_documents(self) -> u64 {
        self.skipped_documents
    }

    /// Number of native non-file symbols evicted from covered files.
    #[must_use]
    pub const fn replaced_native_symbols(self) -> u64 {
        self.replaced_native_symbols
    }

    /// Number of SCIP symbol facts admitted.
    #[must_use]
    pub const fn imported_symbols(self) -> u64 {
        self.imported_symbols
    }

    /// Number of resolved typed graph edges admitted.
    #[must_use]
    pub const fn imported_edges(self) -> u64 {
        self.imported_edges
    }

    /// Number of exact source occurrences admitted as references.
    #[must_use]
    pub const fn imported_references(self) -> u64 {
        self.imported_references
    }

    /// Number of edges recovered from Cartograph's forward-compatible extension.
    #[must_use]
    pub const fn exact_typed_edges(self) -> u64 {
        self.exact_typed_edges
    }

    /// Number of relationship or occurrence targets not present in this project overlay.
    #[must_use]
    pub const fn unresolved_links(self) -> u64 {
        self.unresolved_links
    }
}

struct PreparedDocument<'a> {
    document: &'a ScipDocument,
    path: String,
    file_id: FileId,
    language: String,
    source: Vec<u8>,
    line_starts: Vec<usize>,
}

#[derive(Clone)]
struct ImportedSymbolSpan {
    symbol_id: SymbolId,
    start_byte: u64,
    end_byte: u64,
    span_size: u64,
}

struct ImportAccumulator {
    symbols: Vec<SymbolInput>,
    documents: Vec<SearchDocumentInput>,
    references: Vec<ReferenceInput>,
    edges: BTreeMap<(SymbolId, SymbolId, String, String), EdgeInput>,
    symbol_by_key: BTreeMap<String, SymbolId>,
    kind_by_id: BTreeMap<SymbolId, SymbolKind>,
    spans_by_path: BTreeMap<String, Vec<ImportedSymbolSpan>>,
    exact_edge_keys: BTreeSet<(SymbolId, SymbolId, String)>,
    report: ScipOverlayReport,
}

impl ImportAccumulator {
    fn new(skipped_documents: u64) -> Self {
        Self {
            symbols: Vec::new(),
            documents: Vec::new(),
            references: Vec::new(),
            edges: BTreeMap::new(),
            symbol_by_key: BTreeMap::new(),
            kind_by_id: BTreeMap::new(),
            spans_by_path: BTreeMap::new(),
            exact_edge_keys: BTreeSet::new(),
            report: ScipOverlayReport {
                skipped_documents,
                ..ScipOverlayReport::default()
            },
        }
    }

    fn unresolved(&mut self) -> Result<(), ScipError> {
        self.report.unresolved_links = self
            .report
            .unresolved_links
            .checked_add(1)
            .ok_or(ScipError::LimitExceeded)?;
        Ok(())
    }

    fn push_edge(&mut self, edge: EdgeInput, exact: bool) -> Result<(), ScipError> {
        if edge.site_count == 0
            || edge.site_count > MAXIMUM_SITE_COUNT
            || !edge.confidence.is_finite()
            || !(0.0..=1.0).contains(&edge.confidence)
            || edge.provenance.is_empty()
            || edge.provenance.len() > MAXIMUM_PROVENANCE_BYTES
        {
            return Err(ScipError::InvalidData);
        }
        let relation_key = (
            edge.source_symbol_id.clone(),
            edge.target_symbol_id.clone(),
            edge.kind.as_str().to_owned(),
        );
        if exact {
            self.exact_edge_keys.insert(relation_key.clone());
        } else if self.exact_edge_keys.contains(&relation_key) {
            return Ok(());
        }
        let key = (
            relation_key.0,
            relation_key.1,
            relation_key.2,
            edge.provenance.clone(),
        );
        match self.edges.get_mut(&key) {
            Some(existing) if exact => {
                existing.site_count = existing
                    .site_count
                    .checked_add(edge.site_count)
                    .filter(|count| *count <= MAXIMUM_SITE_COUNT)
                    .ok_or(ScipError::LimitExceeded)?;
                existing.confidence = existing.confidence.max(edge.confidence);
            }
            Some(_) => {}
            None => {
                self.edges.insert(key, edge);
            }
        }
        Ok(())
    }
}

/// Replace native facts only for matching project files covered by one bounded SCIP index.
pub fn apply_scip_overlay<ReadSource>(
    facts: &mut GenerationFacts,
    bytes: &[u8],
    maximum_rows: usize,
    read_source: ReadSource,
) -> Result<ScipOverlayReport, ScipError>
where
    ReadSource: FnMut(&str) -> Option<Vec<u8>>,
{
    apply_scip_overlay_with_cancellation(facts, bytes, maximum_rows, read_source, || false)
}

/// Apply a SCIP overlay while cooperatively polling between bounded records.
pub fn apply_scip_overlay_with_cancellation<ReadSource, Cancel>(
    facts: &mut GenerationFacts,
    bytes: &[u8],
    maximum_rows: usize,
    mut read_source: ReadSource,
    mut cancelled: Cancel,
) -> Result<ScipOverlayReport, ScipError>
where
    ReadSource: FnMut(&str) -> Option<Vec<u8>>,
    Cancel: FnMut() -> bool,
{
    poll(&mut cancelled)?;
    if maximum_rows == 0 || maximum_rows > MAXIMUM_OVERLAY_ROWS {
        return Err(ScipError::LimitExceeded);
    }
    let index = decode_scip_index(bytes)?;
    let row_count = index
        .documents
        .iter()
        .try_fold(index.documents.len(), |total, document| {
            let rows = total
                .checked_add(document.symbols.len())
                .and_then(|value| value.checked_add(document.occurrences.len()))
                .ok_or(ScipError::LimitExceeded)?;
            document.symbols.iter().try_fold(rows, |rows, symbol| {
                rows.checked_add(symbol.relationships.len())
                    .and_then(|value| value.checked_add(symbol.cartograph_edges.len()))
                    .ok_or(ScipError::LimitExceeded)
            })
        })?;
    if row_count > maximum_rows {
        return Err(ScipError::LimitExceeded);
    }

    let file_by_path = facts
        .files
        .iter()
        .map(|file| (file.normalized_path.clone(), file))
        .collect::<BTreeMap<_, _>>();
    let file_symbol_by_id = facts
        .symbols
        .iter()
        .filter(|symbol| symbol.symbol_kind == SymbolKind::File.as_str())
        .map(|symbol| (symbol.file_id.clone(), symbol.symbol_id.clone()))
        .collect::<BTreeMap<_, _>>();
    let native_symbol_candidates = native_symbol_candidates(facts);
    let (prepared, skipped) = prepare_documents(
        &index.documents,
        &file_by_path,
        &mut read_source,
        &mut cancelled,
    )?;
    let mut imported = ImportAccumulator::new(skipped);
    build_symbols(
        &prepared,
        &file_symbol_by_id,
        &native_symbol_candidates,
        &mut imported,
        &mut cancelled,
    )?;
    build_edges_and_references(&prepared, &file_symbol_by_id, &mut imported, &mut cancelled)?;
    poll(&mut cancelled)?;
    apply_replacement(facts, &prepared, &file_symbol_by_id, &mut imported)?;
    Ok(imported.report)
}

fn prepare_documents<'a, ReadSource, Cancel>(
    documents: &'a [ScipDocument],
    file_by_path: &BTreeMap<String, &cartograph_db::FileInput>,
    read_source: &mut ReadSource,
    cancelled: &mut Cancel,
) -> Result<(Vec<PreparedDocument<'a>>, u64), ScipError>
where
    ReadSource: FnMut(&str) -> Option<Vec<u8>>,
    Cancel: FnMut() -> bool,
{
    let mut prepared = Vec::new();
    let mut seen = BTreeSet::new();
    let mut skipped = 0_u64;
    for document in documents {
        poll(cancelled)?;
        let Some(path) = NormalizedPath::parse(&document.relative_path)
            .ok()
            .map(NormalizedPath::into_string)
        else {
            skipped = checked_increment(skipped)?;
            continue;
        };
        let Some(file) = file_by_path.get(&path) else {
            skipped = checked_increment(skipped)?;
            continue;
        };
        let Some(source) = read_source(&path) else {
            skipped = checked_increment(skipped)?;
            continue;
        };
        if !seen.insert(path.clone())
            || std::str::from_utf8(&source).is_err()
            || ContentDigest::from_bytes(*blake3::hash(&source).as_bytes()) != file.content_hash
        {
            skipped = checked_increment(skipped)?;
            continue;
        }
        let line_starts = source_line_starts(&source)?;
        prepared.push(PreparedDocument {
            document,
            path,
            file_id: file.file_id.clone(),
            language: if document.language.is_empty() {
                file.language.clone()
            } else {
                bounded_text(&document.language, 64)
            },
            source,
            line_starts,
        });
    }
    Ok((prepared, skipped))
}

type NativeSymbolCandidates = BTreeMap<(FileId, String, String), Vec<SymbolId>>;

fn native_symbol_candidates(facts: &GenerationFacts) -> NativeSymbolCandidates {
    let mut candidates = NativeSymbolCandidates::new();
    for symbol in &facts.symbols {
        if symbol.symbol_kind != SymbolKind::File.as_str() {
            candidates
                .entry((
                    symbol.file_id.clone(),
                    symbol.symbol_kind.clone(),
                    symbol.qualified_name.clone(),
                ))
                .or_default()
                .push(symbol.symbol_id.clone());
        }
    }
    for symbols in candidates.values_mut() {
        symbols.sort();
    }
    candidates
}

fn build_symbols<Cancel>(
    documents: &[PreparedDocument<'_>],
    file_symbol_by_id: &BTreeMap<FileId, SymbolId>,
    native_candidates: &NativeSymbolCandidates,
    imported: &mut ImportAccumulator,
    cancelled: &mut Cancel,
) -> Result<(), ScipError>
where
    Cancel: FnMut() -> bool,
{
    for prepared in documents {
        poll(cancelled)?;
        let Some(file_symbol_id) = file_symbol_by_id.get(&prepared.file_id) else {
            return Err(ScipError::OverlayFailed);
        };
        let definitions = definition_occurrences(prepared);
        for symbol in &prepared.document.symbols {
            poll(cancelled)?;
            if symbol.symbol.is_empty() {
                imported.unresolved()?;
                continue;
            }
            let key = scoped_symbol_key(&prepared.path, &symbol.symbol);
            let kind = symbol_kind(symbol);
            if kind == SymbolKind::File {
                imported.symbol_by_key.insert(key, file_symbol_id.clone());
                imported
                    .kind_by_id
                    .insert(file_symbol_id.clone(), SymbolKind::File);
                continue;
            }
            if imported.symbol_by_key.contains_key(&key) {
                imported.unresolved()?;
                continue;
            }
            let qualified_name = qualified_name(symbol);
            let span = definitions
                .get(&key)
                .and_then(|occurrence| definition_span(prepared, occurrence))
                .unwrap_or_else(|| fallback_span(prepared));
            let candidate_key = (
                prepared.file_id.clone(),
                kind.as_str().to_owned(),
                qualified_name.clone(),
            );
            let symbol_id = native_candidates
                .get(&candidate_key)
                .filter(|candidates| candidates.len() == 1)
                .and_then(|candidates| candidates.first())
                .cloned()
                .unwrap_or_else(|| deterministic_symbol_id(&key));
            imported
                .symbol_by_key
                .insert(key.clone(), symbol_id.clone());
            imported.kind_by_id.insert(symbol_id.clone(), kind);
            imported
                .spans_by_path
                .entry(prepared.path.clone())
                .or_default()
                .push(ImportedSymbolSpan {
                    symbol_id: symbol_id.clone(),
                    start_byte: span.start_byte,
                    end_byte: span.end_byte,
                    span_size: span.end_byte.saturating_sub(span.start_byte),
                });
            imported.symbols.push(SymbolInput {
                symbol_id: symbol_id.clone(),
                file_id: prepared.file_id.clone(),
                symbol_kind: kind.as_str().to_owned(),
                qualified_name: qualified_name.clone(),
                signature: String::new(),
                start_byte: span.start_byte,
                end_byte: span.end_byte,
                start_line: span.start_line,
                end_line: span.end_line,
                structural_digest: structural_digest(&key, kind, &span),
                visibility: None,
                exported: false,
                default_export: false,
                async_symbol: false,
                static_member: false,
                declaration_only: false,
                betweenness_ppb: None,
                pagerank_ppb: None,
            });
            imported.documents.push(SearchDocumentInput {
                document_id: deterministic_document_id(&key),
                file_id: Some(prepared.file_id.clone()),
                symbol_id: Some(symbol_id),
                path: prepared.path.clone(),
                language: prepared.language.clone(),
                kind: document_kind(&prepared.path),
                qualified_name: qualified_name.clone(),
                code: qualified_name,
                natural_text: bounded_documentation(&symbol.documentation),
                metadata: json!({
                    "interchange": "scip",
                    "positionEncoding": "utf8",
                }),
            });
        }
        if let Some(spans) = imported.spans_by_path.get_mut(&prepared.path) {
            spans.sort_by(|left, right| {
                left.start_byte
                    .cmp(&right.start_byte)
                    .then_with(|| left.span_size.cmp(&right.span_size))
                    .then_with(|| left.symbol_id.cmp(&right.symbol_id))
            });
        }
    }
    Ok(())
}

fn build_edges_and_references<Cancel>(
    documents: &[PreparedDocument<'_>],
    file_symbol_by_id: &BTreeMap<FileId, SymbolId>,
    imported: &mut ImportAccumulator,
    cancelled: &mut Cancel,
) -> Result<(), ScipError>
where
    Cancel: FnMut() -> bool,
{
    for prepared in documents {
        poll(cancelled)?;
        let Some(file_symbol_id) = file_symbol_by_id.get(&prepared.file_id) else {
            return Err(ScipError::OverlayFailed);
        };
        for symbol in &prepared.document.symbols {
            poll(cancelled)?;
            let source_key = scoped_symbol_key(&prepared.path, &symbol.symbol);
            let Some(source_id) = imported.symbol_by_key.get(&source_key).cloned() else {
                continue;
            };
            add_custom_edges(prepared, symbol, &source_id, imported, cancelled)?;
            add_enclosing_edge(prepared, symbol, file_symbol_id, &source_id, imported)?;
            add_standard_relationships(prepared, symbol, &source_id, imported)?;
        }
        for occurrence in &prepared.document.occurrences {
            poll(cancelled)?;
            if occurrence.symbol_roles & SYMBOL_ROLE_DEFINITION != 0 {
                continue;
            }
            add_reference_occurrence(prepared, occurrence, file_symbol_id, imported)?;
        }
    }
    imported.report.imported_edges = usize_to_u64(imported.edges.len());
    Ok(())
}

fn add_custom_edges<Cancel>(
    prepared: &PreparedDocument<'_>,
    symbol: &ScipSymbolInformation,
    source_id: &SymbolId,
    imported: &mut ImportAccumulator,
    cancelled: &mut Cancel,
) -> Result<(), ScipError>
where
    Cancel: FnMut() -> bool,
{
    for edge in &symbol.cartograph_edges {
        poll(cancelled)?;
        let target_key = scoped_symbol_key(&prepared.path, &edge.target_symbol);
        let Some(target_id) = imported.symbol_by_key.get(&target_key).cloned() else {
            imported.unresolved()?;
            continue;
        };
        let Some(kind) = edge_kind(&edge.edge_kind) else {
            imported.unresolved()?;
            continue;
        };
        let provenance = imported_provenance(&edge.provenance)?;
        imported.push_edge(
            EdgeInput {
                source_symbol_id: source_id.clone(),
                target_symbol_id: target_id,
                kind,
                confidence: f32::from_bits(edge.confidence_bits),
                provenance,
                site_count: edge.site_count,
            },
            true,
        )?;
        imported.report.exact_typed_edges = checked_increment(imported.report.exact_typed_edges)?;
    }
    Ok(())
}

fn add_enclosing_edge(
    prepared: &PreparedDocument<'_>,
    symbol: &ScipSymbolInformation,
    file_symbol_id: &SymbolId,
    source_id: &SymbolId,
    imported: &mut ImportAccumulator,
) -> Result<(), ScipError> {
    if symbol_kind(symbol) == SymbolKind::File {
        return Ok(());
    }
    let parent_id = if symbol.enclosing_symbol.is_empty() {
        Some(file_symbol_id.clone())
    } else {
        let parent_key = scoped_symbol_key(&prepared.path, &symbol.enclosing_symbol);
        imported.symbol_by_key.get(&parent_key).cloned()
    };
    let Some(parent_id) = parent_id else {
        imported.unresolved()?;
        return Ok(());
    };
    if parent_id != *source_id {
        imported.push_edge(
            EdgeInput {
                source_symbol_id: parent_id,
                target_symbol_id: source_id.clone(),
                kind: EdgeKind::Contains,
                confidence: 1.0,
                provenance: SCIP_FOREIGN_PROVENANCE.to_owned(),
                site_count: 1,
            },
            false,
        )?;
    }
    Ok(())
}

fn add_standard_relationships(
    prepared: &PreparedDocument<'_>,
    symbol: &ScipSymbolInformation,
    source_id: &SymbolId,
    imported: &mut ImportAccumulator,
) -> Result<(), ScipError> {
    for relationship in &symbol.relationships {
        let target_key = scoped_symbol_key(&prepared.path, &relationship.symbol);
        let Some(target_id) = imported.symbol_by_key.get(&target_key).cloned() else {
            imported.unresolved()?;
            continue;
        };
        let Some(kind) = relationship_edge_kind(
            relationship,
            imported.kind_by_id.get(source_id).copied(),
            imported.kind_by_id.get(&target_id).copied(),
        ) else {
            continue;
        };
        imported.push_edge(
            EdgeInput {
                source_symbol_id: source_id.clone(),
                target_symbol_id: target_id,
                kind,
                confidence: 1.0,
                provenance: SCIP_FOREIGN_PROVENANCE.to_owned(),
                site_count: 1,
            },
            false,
        )?;
    }
    Ok(())
}

fn add_reference_occurrence(
    prepared: &PreparedDocument<'_>,
    occurrence: &ScipOccurrence,
    file_symbol_id: &SymbolId,
    imported: &mut ImportAccumulator,
) -> Result<(), ScipError> {
    let target_key = scoped_symbol_key(&prepared.path, &occurrence.symbol);
    let Some(target_id) = imported.symbol_by_key.get(&target_key).cloned() else {
        imported.unresolved()?;
        return Ok(());
    };
    let Some(span) = occurrence_span(prepared, occurrence) else {
        imported.unresolved()?;
        return Ok(());
    };
    let owner_id = smallest_owner(imported.spans_by_path.get(&prepared.path), span.start_byte)
        .unwrap_or_else(|| file_symbol_id.clone());
    let kind = exact_edge_kind(imported, &owner_id, &target_id).unwrap_or(EdgeKind::References);
    imported.references.push(ReferenceInput {
        file_id: prepared.file_id.clone(),
        owner_symbol_id: Some(owner_id.clone()),
        target_symbol_id: Some(target_id.clone()),
        reference_name: bounded_text(&reference_name(occurrence), MAXIMUM_REFERENCE_NAME_BYTES),
        reference_kind: kind.as_str().to_owned(),
        start_byte: span.start_byte,
        end_byte: span.end_byte,
        confidence: 1.0,
        resolution_provenance: SCIP_OVERLAY_PROVENANCE.to_owned(),
        site_count: 1,
        span_precision: ReferenceSpanPrecision::Exact,
    });
    imported.push_edge(
        EdgeInput {
            source_symbol_id: owner_id,
            target_symbol_id: target_id,
            kind,
            confidence: 1.0,
            provenance: SCIP_FOREIGN_PROVENANCE.to_owned(),
            site_count: 1,
        },
        false,
    )?;
    Ok(())
}

fn apply_replacement(
    facts: &mut GenerationFacts,
    prepared: &[PreparedDocument<'_>],
    file_symbol_by_id: &BTreeMap<FileId, SymbolId>,
    imported: &mut ImportAccumulator,
) -> Result<(), ScipError> {
    let covered = prepared
        .iter()
        .map(|document| document.file_id.clone())
        .collect::<BTreeSet<_>>();
    let removed = facts
        .symbols
        .iter()
        .filter(|symbol| {
            covered.contains(&symbol.file_id) && symbol.symbol_kind != SymbolKind::File.as_str()
        })
        .map(|symbol| symbol.symbol_id.clone())
        .collect::<BTreeSet<_>>();
    let imported_ids = imported
        .symbols
        .iter()
        .map(|symbol| symbol.symbol_id.clone())
        .collect::<BTreeSet<_>>();
    let file_symbol_ids = file_symbol_by_id.values().cloned().collect::<BTreeSet<_>>();
    let retained_targets = imported_ids
        .iter()
        .cloned()
        .chain(file_symbol_ids.iter().cloned())
        .collect::<BTreeSet<_>>();

    facts.symbols.retain(|symbol| {
        !covered.contains(&symbol.file_id) || symbol.symbol_kind == SymbolKind::File.as_str()
    });
    facts.documents.retain(|document| {
        document
            .file_id
            .as_ref()
            .is_none_or(|file_id| !covered.contains(file_id))
            || document
                .symbol_id
                .as_ref()
                .is_some_and(|symbol_id| file_symbol_ids.contains(symbol_id))
    });
    facts.references.retain_mut(|reference| {
        if covered.contains(&reference.file_id) {
            return false;
        }
        if reference
            .target_symbol_id
            .as_ref()
            .is_some_and(|target| removed.contains(target) && !retained_targets.contains(target))
        {
            reference.target_symbol_id = None;
            reference.confidence = 0.0;
            reference.resolution_provenance = SCIP_UNRESOLVED_PROVENANCE.to_owned();
        }
        true
    });
    facts.edges.retain(|edge| {
        !removed.contains(&edge.source_symbol_id)
            && (!removed.contains(&edge.target_symbol_id)
                || retained_targets.contains(&edge.target_symbol_id))
    });

    imported.report.covered_documents = usize_to_u64(covered.len());
    imported.report.replaced_native_symbols = usize_to_u64(removed.len());
    imported.report.imported_symbols = usize_to_u64(imported.symbols.len());
    imported.report.imported_references = usize_to_u64(imported.references.len());
    facts.symbols.append(&mut imported.symbols);
    facts.documents.append(&mut imported.documents);
    facts.references.append(&mut imported.references);
    facts
        .edges
        .extend(std::mem::take(&mut imported.edges).into_values());
    Ok(())
}

fn definition_occurrences(prepared: &PreparedDocument<'_>) -> BTreeMap<String, ScipOccurrence> {
    let mut definitions = BTreeMap::new();
    for occurrence in &prepared.document.occurrences {
        if occurrence.symbol_roles & SYMBOL_ROLE_DEFINITION != 0 {
            definitions
                .entry(scoped_symbol_key(&prepared.path, &occurrence.symbol))
                .or_insert_with(|| occurrence.clone());
        }
    }
    definitions
}

#[derive(Clone, Copy)]
struct ImportedSpan {
    start_byte: u64,
    end_byte: u64,
    start_line: u32,
    end_line: u32,
}

fn definition_span(
    prepared: &PreparedDocument<'_>,
    occurrence: &ScipOccurrence,
) -> Option<ImportedSpan> {
    scip_range_to_span(
        if occurrence.enclosing_range.is_empty() {
            &occurrence.range
        } else {
            &occurrence.enclosing_range
        },
        &prepared.source,
        &prepared.line_starts,
    )
}

fn occurrence_span(
    prepared: &PreparedDocument<'_>,
    occurrence: &ScipOccurrence,
) -> Option<ImportedSpan> {
    scip_range_to_span(&occurrence.range, &prepared.source, &prepared.line_starts)
}

fn scip_range_to_span(range: &[u32], source: &[u8], line_starts: &[usize]) -> Option<ImportedSpan> {
    let (start_line, start_column, end_line, end_column) = match range {
        [line, start, end] => (*line, *start, *line, *end),
        [start_line, start, end_line, end] => (*start_line, *start, *end_line, *end),
        _ => return None,
    };
    let start = line_column_to_byte(source, line_starts, start_line, start_column)?;
    let end = line_column_to_byte(source, line_starts, end_line, end_column)?;
    if start >= end {
        return None;
    }
    Some(ImportedSpan {
        start_byte: u64::try_from(start).ok()?,
        end_byte: u64::try_from(end).ok()?,
        start_line: start_line.checked_add(1)?,
        end_line: end_line.checked_add(1)?,
    })
}

fn source_line_starts(source: &[u8]) -> Result<Vec<usize>, ScipError> {
    let mut starts = vec![0];
    for (index, byte) in source.iter().enumerate() {
        if *byte == b'\n' && index + 1 < source.len() {
            starts.push(index + 1);
        }
    }
    Ok(starts)
}

fn line_column_to_byte(
    source: &[u8],
    line_starts: &[usize],
    line: u32,
    column: u32,
) -> Option<usize> {
    let line = usize::try_from(line).ok()?;
    let column = usize::try_from(column).ok()?;
    let start = *line_starts.get(line)?;
    let next_line = line_starts
        .get(line.checked_add(1)?)
        .copied()
        .unwrap_or(source.len());
    let line_end = if next_line > start && source.get(next_line - 1) == Some(&b'\n') {
        next_line - 1
    } else {
        next_line
    };
    let position = start.checked_add(column)?;
    if position > line_end || !std::str::from_utf8(source).ok()?.is_char_boundary(position) {
        return None;
    }
    Some(position)
}

fn fallback_span(prepared: &PreparedDocument<'_>) -> ImportedSpan {
    ImportedSpan {
        start_byte: 0,
        end_byte: usize_to_u64(prepared.source.len()),
        start_line: 1,
        end_line: u32::try_from(prepared.line_starts.len()).unwrap_or(u32::MAX),
    }
}

fn smallest_owner(spans: Option<&Vec<ImportedSymbolSpan>>, position: u64) -> Option<SymbolId> {
    spans?
        .iter()
        .filter(|span| span.start_byte <= position && position < span.end_byte)
        .min_by(|left, right| {
            left.span_size
                .cmp(&right.span_size)
                .then_with(|| left.symbol_id.cmp(&right.symbol_id))
        })
        .map(|span| span.symbol_id.clone())
}

fn exact_edge_kind(
    imported: &ImportAccumulator,
    source: &SymbolId,
    target: &SymbolId,
) -> Option<EdgeKind> {
    const PRIORITY: [EdgeKind; 14] = [
        EdgeKind::Calls,
        EdgeKind::Instantiates,
        EdgeKind::Imports,
        EdgeKind::Tests,
        EdgeKind::Implements,
        EdgeKind::Extends,
        EdgeKind::Overrides,
        EdgeKind::TypeOf,
        EdgeKind::Returns,
        EdgeKind::FieldAccess,
        EdgeKind::Decorates,
        EdgeKind::DefUse,
        EdgeKind::Exports,
        EdgeKind::References,
    ];
    PRIORITY.into_iter().find(|kind| {
        imported.exact_edge_keys.contains(&(
            source.clone(),
            target.clone(),
            kind.as_str().to_owned(),
        ))
    })
}

fn symbol_kind(symbol: &ScipSymbolInformation) -> SymbolKind {
    scip_kind_to_symbol_kind(symbol.kind).unwrap_or_else(|| {
        parse_scip_symbol(&symbol.symbol)
            .and_then(|parsed| {
                parsed
                    .descriptors
                    .last()
                    .map(|descriptor| descriptor.suffix)
            })
            .map(suffix_to_symbol_kind)
            .unwrap_or(SymbolKind::Variable)
    })
}

fn scip_kind_to_symbol_kind(kind: u32) -> Option<SymbolKind> {
    match kind {
        7 => Some(SymbolKind::Class),
        8 => Some(SymbolKind::Constant),
        9 | 18 | 26 | 45 | 66 | 72 | 76 | 80 => Some(SymbolKind::Method),
        11 => Some(SymbolKind::Enum),
        12 => Some(SymbolKind::EnumMember),
        15 | 77 | 79 => Some(SymbolKind::Field),
        16 => Some(SymbolKind::File),
        17 | 25 => Some(SymbolKind::Function),
        21 => Some(SymbolKind::Interface),
        29 | 35 => Some(SymbolKind::Module),
        30 => Some(SymbolKind::Namespace),
        33 => Some(SymbolKind::Class),
        37 | 44 => Some(SymbolKind::Parameter),
        41 | 81 => Some(SymbolKind::Property),
        42 => Some(SymbolKind::Protocol),
        49 => Some(SymbolKind::Struct),
        53 => Some(SymbolKind::Trait),
        54 | 55 | 58 => Some(SymbolKind::TypeAlias),
        61 | 82 => Some(SymbolKind::Variable),
        _ => None,
    }
}

fn suffix_to_symbol_kind(suffix: DescriptorSuffix) -> SymbolKind {
    match suffix {
        DescriptorSuffix::Namespace => SymbolKind::Module,
        DescriptorSuffix::Type => SymbolKind::Class,
        DescriptorSuffix::Method => SymbolKind::Method,
        DescriptorSuffix::Parameter | DescriptorSuffix::TypeParameter => SymbolKind::Parameter,
        DescriptorSuffix::Macro => SymbolKind::Function,
        DescriptorSuffix::Term | DescriptorSuffix::Meta => SymbolKind::Variable,
    }
}

fn edge_kind(value: &str) -> Option<EdgeKind> {
    match value {
        "calls" => Some(EdgeKind::Calls),
        "imports" => Some(EdgeKind::Imports),
        "references" => Some(EdgeKind::References),
        "implements" => Some(EdgeKind::Implements),
        "extends" => Some(EdgeKind::Extends),
        "tests" => Some(EdgeKind::Tests),
        "type_of" => Some(EdgeKind::TypeOf),
        "returns" => Some(EdgeKind::Returns),
        "instantiates" => Some(EdgeKind::Instantiates),
        "overrides" => Some(EdgeKind::Overrides),
        "decorates" => Some(EdgeKind::Decorates),
        "field_access" => Some(EdgeKind::FieldAccess),
        "def_use" => Some(EdgeKind::DefUse),
        "exports" => Some(EdgeKind::Exports),
        "contains" => Some(EdgeKind::Contains),
        _ => None,
    }
}

fn relationship_edge_kind(
    relationship: &ScipRelationship,
    source_kind: Option<SymbolKind>,
    target_kind: Option<SymbolKind>,
) -> Option<EdgeKind> {
    if relationship.is_implementation {
        match (source_kind, target_kind) {
            (
                Some(SymbolKind::Class | SymbolKind::Struct),
                Some(SymbolKind::Interface | SymbolKind::Trait | SymbolKind::Protocol),
            ) => Some(EdgeKind::Implements),
            _ => Some(EdgeKind::Extends),
        }
    } else if relationship.is_type_definition {
        Some(EdgeKind::TypeOf)
    } else if relationship.is_reference || relationship.is_definition {
        Some(EdgeKind::References)
    } else {
        None
    }
}

fn qualified_name(symbol: &ScipSymbolInformation) -> String {
    let parsed = parse_scip_symbol(&symbol.symbol)
        .map(|parsed| descriptors_to_qualified_name(&parsed.descriptors))
        .unwrap_or_default();
    let value = if parsed.is_empty() {
        if symbol.display_name.is_empty() {
            "(anonymous)"
        } else {
            &symbol.display_name
        }
    } else {
        &parsed
    };
    bounded_text(value, MAXIMUM_QUALIFIED_NAME_BYTES)
}

fn reference_name(occurrence: &ScipOccurrence) -> String {
    parse_scip_symbol(&occurrence.symbol)
        .map(|parsed| descriptors_to_qualified_name(&parsed.descriptors))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| occurrence.symbol.clone())
}

fn scoped_symbol_key(path: &str, symbol: &str) -> String {
    if symbol.starts_with("local ") {
        format!("{path}\0{symbol}")
    } else {
        symbol.to_owned()
    }
}

fn deterministic_symbol_id(key: &str) -> SymbolId {
    SymbolId::from_uuid_v8(uuid_hash(SCIP_SYMBOL_ID_DOMAIN, key))
}

fn deterministic_document_id(key: &str) -> DocumentId {
    DocumentId::from_uuid_v8(uuid_hash(SCIP_DOCUMENT_ID_DOMAIN, key))
}

fn structural_digest(key: &str, kind: SymbolKind, span: &ImportedSpan) -> ContentDigest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(SCIP_STRUCTURAL_DIGEST_DOMAIN);
    hash_text(&mut hasher, key);
    hash_text(&mut hasher, kind.as_str());
    hasher.update(&span.start_byte.to_be_bytes());
    hasher.update(&span.end_byte.to_be_bytes());
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

fn uuid_hash(domain: &[u8], value: &str) -> [u8; 16] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(domain);
    hash_text(&mut hasher, value);
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest.as_bytes()[..16]);
    bytes
}

fn hash_text(hasher: &mut blake3::Hasher, value: &str) {
    hasher.update(&usize_to_u64(value.len()).to_be_bytes());
    hasher.update(value.as_bytes());
}

fn bounded_documentation(values: &[String]) -> String {
    let joined = values.join("\n\n");
    bounded_text(&joined, MAXIMUM_NATURAL_TEXT_BYTES)
}

fn bounded_text(value: &str, maximum: usize) -> String {
    let mut end = value.len().min(maximum);
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    value[..end].to_owned()
}

fn imported_provenance(value: &str) -> Result<String, ScipError> {
    if value.is_empty() {
        return Ok(SCIP_OVERLAY_PROVENANCE.to_owned());
    }
    if value.starts_with(SCIP_PROVENANCE_PREFIX) {
        return (value.len() <= MAXIMUM_PROVENANCE_BYTES)
            .then(|| value.to_owned())
            .ok_or(ScipError::InvalidData);
    }
    let length = SCIP_PROVENANCE_PREFIX
        .len()
        .checked_add(value.len())
        .ok_or(ScipError::LimitExceeded)?;
    if length > MAXIMUM_PROVENANCE_BYTES {
        return Err(ScipError::InvalidData);
    }
    let mut provenance = String::with_capacity(length);
    provenance.push_str(SCIP_PROVENANCE_PREFIX);
    provenance.push_str(value);
    Ok(provenance)
}

fn document_kind(path: &str) -> DocumentKind {
    let lower = path.to_ascii_lowercase();
    if lower.contains("test") || lower.contains("spec") {
        DocumentKind::Test
    } else {
        DocumentKind::Symbol
    }
}

fn checked_increment(value: u64) -> Result<u64, ScipError> {
    value.checked_add(1).ok_or(ScipError::LimitExceeded)
}

fn poll(cancelled: &mut impl FnMut() -> bool) -> Result<(), ScipError> {
    if cancelled() {
        Err(ScipError::Cancelled)
    } else {
        Ok(())
    }
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use cartograph_db::{FileInput, GenerationValidationLimits, validate_generation_facts};
    use cartograph_domain::{FileParseStatus, GenerationId};

    use crate::{ScipExportOptions, export_snapshot};

    use super::*;

    fn native_facts(source: &[u8]) -> GenerationFacts {
        let file_id = FileId::from_uuid_v8([1; 16]);
        let file_symbol = SymbolId::from_uuid_v8([2; 16]);
        GenerationFacts {
            files: vec![FileInput {
                file_id: file_id.clone(),
                normalized_path: "src/lib.rs".to_owned(),
                language: "rust".to_owned(),
                content_hash: ContentDigest::from_bytes(*blake3::hash(source).as_bytes()),
                byte_size: usize_to_u64(source.len()),
                parse_status: FileParseStatus::Parsed,
            }],
            symbols: vec![SymbolInput {
                symbol_id: file_symbol.clone(),
                file_id: file_id.clone(),
                symbol_kind: "file".to_owned(),
                qualified_name: "src/lib.rs".to_owned(),
                signature: String::new(),
                start_byte: 0,
                end_byte: usize_to_u64(source.len()),
                start_line: 1,
                end_line: 2,
                structural_digest: ContentDigest::from_bytes(*blake3::hash(source).as_bytes()),
                visibility: None,
                exported: false,
                default_export: false,
                async_symbol: false,
                static_member: false,
                declaration_only: false,
                betweenness_ppb: None,
                pagerank_ppb: None,
            }],
            documents: vec![SearchDocumentInput {
                document_id: DocumentId::from_uuid_v8([3; 16]),
                file_id: Some(file_id),
                symbol_id: Some(file_symbol),
                path: "src/lib.rs".to_owned(),
                language: "rust".to_owned(),
                kind: DocumentKind::File,
                qualified_name: String::new(),
                code: "src/lib.rs".to_owned(),
                natural_text: String::new(),
                metadata: json!({}),
            }],
            ..GenerationFacts::default()
        }
    }

    #[test]
    fn cartograph_round_trip_preserves_exact_call_kind_and_site_count() {
        let source = b"fn caller() { callee(); }\nfn callee() {}\n".to_vec();
        let file_id = FileId::from_uuid_v8([1; 16]);
        let caller = SymbolId::from_uuid_v8([4; 16]);
        let callee = SymbolId::from_uuid_v8([5; 16]);
        let snapshot = cartograph_db::InterchangeSnapshot {
            generation_id: GenerationId::from_uuid_v8([6; 16]),
            files: vec![cartograph_db::InterchangeFile {
                file_id: file_id.clone(),
                path: "src/lib.rs".to_owned(),
                language: "rust".to_owned(),
                content_hash: blake3::hash(&source).to_hex().to_string(),
                byte_size: usize_to_u64(source.len()),
            }],
            symbols: vec![
                cartograph_db::InterchangeSymbol {
                    symbol_id: caller.clone(),
                    file_id: file_id.clone(),
                    symbol_kind: "function".to_owned(),
                    qualified_name: "caller".to_owned(),
                    signature: String::new(),
                    code: "caller".to_owned(),
                    natural_text: String::new(),
                    start_byte: 0,
                    end_byte: 25,
                    start_line: 1,
                    end_line: 1,
                },
                cartograph_db::InterchangeSymbol {
                    symbol_id: callee.clone(),
                    file_id,
                    symbol_kind: "function".to_owned(),
                    qualified_name: "callee".to_owned(),
                    signature: String::new(),
                    code: "callee".to_owned(),
                    natural_text: String::new(),
                    start_byte: 26,
                    end_byte: 40,
                    start_line: 2,
                    end_line: 2,
                },
            ],
            edges: vec![cartograph_db::InterchangeEdge {
                source_symbol_id: caller,
                target_symbol_id: callee,
                edge_kind: "calls".to_owned(),
                confidence: 0.9,
                provenance: "native-exact-project".to_owned(),
                site_count: 7,
            }],
            references: Vec::new(),
        };
        let options = ScipExportOptions::new("demo", "1", "2", "cartograph://demo")
            .unwrap_or_else(|error| panic!("options failed: {error}"));
        let export = export_snapshot(&snapshot, &options, |_| Some(source.clone()))
            .unwrap_or_else(|error| panic!("export failed: {error}"));
        let mut facts = native_facts(&source);
        let report = apply_scip_overlay(&mut facts, export.bytes(), 100, |_| Some(source.clone()))
            .unwrap_or_else(|error| panic!("overlay failed: {error}"));
        assert_eq!(report.exact_typed_edges(), 1);
        let imported_edge = facts
            .edges
            .iter()
            .find(|edge| edge.kind == EdgeKind::Calls && edge.site_count == 7)
            .unwrap_or_else(|| panic!("exact imported call edge was not retained"));
        assert_eq!(imported_edge.confidence, 0.9);
        assert_eq!(
            imported_edge.provenance,
            "scip-overlay:native-exact-project"
        );
        let limits = GenerationValidationLimits::new(64 * 1024 * 1024, 256 * 1024 * 1024)
            .unwrap_or_else(|error| panic!("limits failed: {error}"));
        validate_generation_facts(facts, limits, || false)
            .unwrap_or_else(|error| panic!("validation failed: {error}"));
    }

    #[test]
    fn stale_source_is_skipped_without_replacing_native_facts() {
        let source = b"fn current() {}\n".to_vec();
        let mut facts = native_facts(&source);
        let before = facts.symbols.clone();
        let index = crate::ScipIndex {
            tool_name: "foreign".to_owned(),
            tool_version: "1".to_owned(),
            project_root: String::new(),
            documents: vec![ScipDocument {
                relative_path: "src/lib.rs".to_owned(),
                language: "rust".to_owned(),
                occurrences: Vec::new(),
                symbols: Vec::new(),
            }],
        };
        let bytes = crate::encode_scip_index(&index)
            .unwrap_or_else(|error| panic!("encode failed: {error}"));
        let report = apply_scip_overlay(&mut facts, &bytes, 10, |_| Some(b"stale".to_vec()))
            .unwrap_or_else(|error| panic!("overlay failed: {error}"));
        assert_eq!(report.skipped_documents(), 1);
        assert_eq!(facts.symbols, before);
    }
}
