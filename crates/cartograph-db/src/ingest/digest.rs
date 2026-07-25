use blake3::Hasher;
use cartograph_domain::ContentDigest;

use super::model::ValidatedFactTables;

const DIGEST_DOMAIN: &[u8] = b"cartograph-v2-logical-generation-v4";

pub(super) fn logical_digest<Cancel>(
    facts: &ValidatedFactTables,
    mut cancelled: Cancel,
) -> Result<ContentDigest, ()>
where
    Cancel: FnMut() -> bool,
{
    let mut digest = CanonicalDigest::new();
    digest.section("files", facts.files.len());
    for file in &facts.files {
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
    digest.section("symbols", facts.symbols.len());
    for symbol in &facts.symbols {
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
        digest.optional_text(symbol.visibility.map(|visibility| visibility.as_str()));
        digest.boolean(symbol.exported);
        digest.boolean(symbol.default_export);
        digest.boolean(symbol.async_symbol);
        digest.boolean(symbol.static_member);
        digest.boolean(symbol.declaration_only);
    }
    digest.section("edges", facts.edges.len());
    for edge in &facts.edges {
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
    digest.section("references", facts.references.len());
    for reference in &facts.references {
        if cancelled() {
            return Err(());
        }
        digest.text(reference.file_id.as_str());
        digest.optional_text(reference.owner_symbol_id.as_ref().map(|id| id.as_str()));
        digest.optional_text(reference.target_symbol_id.as_ref().map(|id| id.as_str()));
        digest.text(&reference.reference_name);
        digest.text(&reference.reference_kind);
        digest.u64(reference.start_byte);
        digest.u64(reference.end_byte);
        digest.u32(reference.confidence.to_bits());
        digest.text(&reference.resolution_provenance);
        digest.u32(reference.site_count);
        digest.text(reference.span_precision.as_str());
    }
    digest.section("search_documents", facts.documents.len());
    for document in &facts.documents {
        if cancelled() {
            return Err(());
        }
        digest.text(document.document_id.as_str());
        digest.optional_text(document.file_id.as_ref().map(|id| id.as_str()));
        digest.optional_text(document.symbol_id.as_ref().map(|id| id.as_str()));
        digest.text(&document.path);
        digest.text(&document.language);
        digest.text(document.kind.as_str());
        digest.text(&document.qualified_name);
        digest.text(&document.code);
        digest.text(&document.natural_text);
        digest.text(&document.metadata_json);
    }
    if cancelled() {
        Err(())
    } else {
        Ok(digest.finish())
    }
}

struct CanonicalDigest {
    hasher: Hasher,
}

impl CanonicalDigest {
    fn new() -> Self {
        let mut hasher = Hasher::new();
        hasher.update(DIGEST_DOMAIN);
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
