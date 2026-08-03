use blake3::Hasher;
use cartograph_domain::{ContentDigest, GenerationDigestVersion};

use super::model::{
    CanonicalSearchDocument, EdgeInput, FileInput, NumericalSiteInput, ReferenceInput, SymbolInput,
    ValidatedFactTables,
};

const DIGEST_V1_TO_V6_DOMAIN: &[u8] = b"cartograph-v2-logical-generation-v4";
const DIGEST_V7_DOMAIN: &[u8] = b"cartograph-v2-logical-generation-v5";
const DIGEST_V8_DOMAIN: &[u8] = b"cartograph-v2-logical-generation-v6";
const DIGEST_V9_DOMAIN: &[u8] = b"cartograph-v2-logical-generation-v7";
const DIGEST_V10_DOMAIN: &[u8] = b"cartograph-v2-logical-generation-v8";

pub(super) fn logical_digest<Cancel>(
    facts: &ValidatedFactTables,
    version: GenerationDigestVersion,
    mut cancelled: Cancel,
) -> Result<ContentDigest, ()>
where
    Cancel: FnMut() -> bool,
{
    let domain = match version {
        GenerationDigestVersion::V10 => DIGEST_V10_DOMAIN,
        GenerationDigestVersion::V9 => DIGEST_V9_DOMAIN,
        GenerationDigestVersion::V8 => DIGEST_V8_DOMAIN,
        GenerationDigestVersion::V7 => DIGEST_V7_DOMAIN,
        _ => DIGEST_V1_TO_V6_DOMAIN,
    };
    let mut digest = CanonicalDigest::new(domain);
    digest_files(&mut digest, &facts.files, &mut cancelled)?;
    digest_symbols(&mut digest, &facts.symbols, &mut cancelled)?;
    digest_edges(&mut digest, &facts.edges, &mut cancelled)?;
    digest_references(&mut digest, &facts.references, &mut cancelled)?;
    if matches!(
        version,
        GenerationDigestVersion::V7
            | GenerationDigestVersion::V8
            | GenerationDigestVersion::V9
            | GenerationDigestVersion::V10
    ) {
        digest_numerical_sites(&mut digest, &facts.numerical_sites, &mut cancelled)?;
    }
    digest_documents(&mut digest, &facts.documents, &mut cancelled)?;
    if cancelled() {
        Err(())
    } else {
        Ok(digest.finish())
    }
}

fn digest_numerical_sites<Cancel>(
    digest: &mut CanonicalDigest,
    sites: &[NumericalSiteInput],
    cancelled: &mut Cancel,
) -> Result<(), ()>
where
    Cancel: FnMut() -> bool,
{
    digest.section("numerical_sites", sites.len());
    for site in sites {
        if cancelled() {
            return Err(());
        }
        digest.text(site.site_id.as_str());
        digest.text(site.file_id.as_str());
        digest.optional_text(
            site.owner_symbol_id
                .as_ref()
                .map(cartograph_domain::SymbolId::as_str),
        );
        digest.u64(site.start_byte);
        digest.u64(site.end_byte);
        digest.u32(site.start_line);
        digest.u32(site.end_line);
        digest.text(&site.operation);
        digest.text(&site.hazard);
        digest.text(&site.precision);
        digest.text(site.expression_digest.as_str());
        digest.u32(site.confidence_ppm);
        digest.text(&site.provenance);
        digest.text(&site.evidence_level);
        digest.text(&site.unknowns);
    }
    Ok(())
}

fn digest_files<Cancel>(
    digest: &mut CanonicalDigest,
    files: &[FileInput],
    cancelled: &mut Cancel,
) -> Result<(), ()>
where
    Cancel: FnMut() -> bool,
{
    digest.section("files", files.len());
    for file in files {
        if cancelled() {
            return Err(());
        }
        digest.text(file.file_id.as_str());
        digest.text(&file.normalized_path);
        digest.text(&file.language);
        digest.text(file.content_hash.as_str());
        digest.u64(file.byte_size);
        digest.text(file.parse_status.as_str());
    }
    Ok(())
}

fn digest_symbols<Cancel>(
    digest: &mut CanonicalDigest,
    symbols: &[SymbolInput],
    cancelled: &mut Cancel,
) -> Result<(), ()>
where
    Cancel: FnMut() -> bool,
{
    digest.section("symbols", symbols.len());
    for symbol in symbols {
        if cancelled() {
            return Err(());
        }
        digest.text(symbol.symbol_id.as_str());
        digest.text(symbol.file_id.as_str());
        digest.text(&symbol.symbol_kind);
        digest.text(&symbol.qualified_name);
        digest.text(&symbol.signature);
        digest.u64(symbol.start_byte);
        digest.u64(symbol.end_byte);
        digest.u32(symbol.start_line);
        digest.u32(symbol.end_line);
        digest.text(symbol.structural_digest.as_str());
        digest.optional_text(symbol.visibility.map(cartograph_domain::Visibility::as_str));
        digest.boolean(symbol.export.exported);
        digest.boolean(symbol.export.default_export);
        digest.boolean(symbol.execution.async_symbol);
        digest.boolean(symbol.execution.static_member);
        digest.boolean(symbol.declaration_only);
    }
    Ok(())
}

fn digest_edges<Cancel>(
    digest: &mut CanonicalDigest,
    edges: &[EdgeInput],
    cancelled: &mut Cancel,
) -> Result<(), ()>
where
    Cancel: FnMut() -> bool,
{
    digest.section("edges", edges.len());
    for edge in edges {
        if cancelled() {
            return Err(());
        }
        digest.text(edge.source_symbol_id.as_str());
        digest.text(edge.target_symbol_id.as_str());
        digest.text(edge.kind.as_str());
        digest.u32(edge.confidence.to_bits());
        digest.text(&edge.provenance);
        digest.u32(edge.site_count);
    }
    Ok(())
}

fn digest_references<Cancel>(
    digest: &mut CanonicalDigest,
    references: &[ReferenceInput],
    cancelled: &mut Cancel,
) -> Result<(), ()>
where
    Cancel: FnMut() -> bool,
{
    digest.section("references", references.len());
    for reference in references {
        if cancelled() {
            return Err(());
        }
        digest.text(reference.file_id.as_str());
        digest.optional_text(
            reference
                .owner_symbol_id
                .as_ref()
                .map(cartograph_domain::SymbolId::as_str),
        );
        digest.optional_text(
            reference
                .target_symbol_id
                .as_ref()
                .map(cartograph_domain::SymbolId::as_str),
        );
        digest.text(&reference.reference_name);
        digest.text(&reference.reference_kind);
        digest.u64(reference.start_byte);
        digest.u64(reference.end_byte);
        digest.u32(reference.confidence.to_bits());
        digest.text(&reference.resolution_provenance);
        digest.u32(reference.site_count);
        digest.text(reference.span_precision.as_str());
    }
    Ok(())
}

fn digest_documents<Cancel>(
    digest: &mut CanonicalDigest,
    documents: &[CanonicalSearchDocument],
    cancelled: &mut Cancel,
) -> Result<(), ()>
where
    Cancel: FnMut() -> bool,
{
    digest.section("search_documents", documents.len());
    for document in documents {
        if cancelled() {
            return Err(());
        }
        digest.text(document.document_id.as_str());
        digest.optional_text(
            document
                .file_id
                .as_ref()
                .map(cartograph_domain::FileId::as_str),
        );
        digest.optional_text(
            document
                .symbol_id
                .as_ref()
                .map(cartograph_domain::SymbolId::as_str),
        );
        digest.text(&document.path);
        digest.text(&document.language);
        digest.text(document.kind.as_str());
        digest.text(&document.qualified_name);
        digest.text(&document.code);
        digest.text(&document.natural_text);
        digest.text(&document.metadata_json);
    }
    Ok(())
}

struct CanonicalDigest {
    hasher: Hasher,
}

impl CanonicalDigest {
    fn new(domain: &[u8]) -> Self {
        let mut hasher = Hasher::new();
        hasher.update(domain);
        Self { hasher }
    }

    fn section(&mut self, name: &str, count: usize) {
        self.text(name);
        self.text(&count.to_string());
    }

    fn text(&mut self, value: &str) {
        self.hasher.update(value.len().to_string().as_bytes());
        self.hasher.update(&[0]);
        self.hasher.update(value.as_bytes());
    }

    fn optional_text(&mut self, value: Option<&str>) {
        match value {
            Some(value) => {
                self.hasher.update(&[1]);
                self.text(value);
            }
            None => {
                self.hasher.update(&[0]);
            }
        }
    }

    fn u64(&mut self, value: u64) {
        self.hasher.update(&value.to_be_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.hasher.update(&value.to_be_bytes());
    }

    fn boolean(&mut self, value: bool) {
        self.hasher.update(&[u8::from(value)]);
    }

    fn finish(self) -> ContentDigest {
        ContentDigest::from_bytes(*self.hasher.finalize().as_bytes())
    }
}
