use cartograph_domain::{
    ContentDigest, FileId, FileParseStatus, NormalizedPath, ReferenceKind, SourceLanguage,
    SourceSpan, SymbolId, SymbolKind, Visibility,
};
use serde::{Deserialize, Serialize};

/// Internal lookup marker for bounded same-file dynamic-dispatch references.
///
/// The persisted reference keeps the source-visible target name; the indexer removes this marker
/// before lookup and records lower-confidence dispatch provenance on the resolved edge.
#[doc(hidden)]
pub const DYNAMIC_DISPATCH_RESOLUTION_PREFIX: &str = "cartograph.dynamic-dispatch::";

/// Internal marker for a Rust macro invocation whose declaration would require expansion.
///
/// The persisted reference keeps the source-visible macro name. The indexer removes this marker
/// before lookup and records explicit unexpanded-macro provenance instead of treating expected
/// macro-expansion uncertainty as a missing project call target.
#[doc(hidden)]
pub const RUST_MACRO_RESOLUTION_PREFIX: &str = "cartograph.rust-macro::";

/// Internal lookup marker for a static SQL-literal table reference.
///
/// The suffix is `<operation>::<qualified-table>`. The persisted reference keeps only the
/// source-visible table name; the indexer uses the marker to require a SQL table target and to
/// retain read/write/DDL provenance on the resulting graph edge.
#[doc(hidden)]
pub const EMBEDDED_SQL_RESOLUTION_PREFIX: &str = "cartograph.embedded-sql::";

/// Complete storage-independent output for one native source-file extraction.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedFile {
    /// Stable file identity derived from the canonical path.
    pub file_id: FileId,
    /// Canonical project-relative path.
    pub path: NormalizedPath,
    /// Native grammar used for this file.
    pub language: SourceLanguage,
    /// Digest of the exact original UTF-8 bytes.
    pub content_hash: ContentDigest,
    /// Original source size before parsing.
    pub byte_size: u64,
    /// Exact one-based source line count.
    pub line_count: u32,
    /// Complete, recoverably partial, or failed parse state.
    pub parse_status: FileParseStatus,
    /// Source-ordered declarations.
    pub symbols: Vec<ExtractedSymbol>,
    /// Source-ordered lexical containment relationships.
    pub containments: Vec<Containment>,
    /// Source-ordered unresolved structural references.
    pub references: Vec<ExtractedReference>,
    /// Source-ordered ES module bindings used by project-wide resolution.
    pub import_bindings: Vec<ExtractedImportBinding>,
    /// Whether this source contains an AST-confirmed inline test declaration.
    pub has_inline_tests: bool,
    /// Bounded test-suite/case titles and test declaration names for BM25 intent lookup.
    pub test_search_text: String,
    /// Whether the per-file test-name search text hit its byte ceiling.
    pub test_search_truncated: bool,
    /// Bounded, credential-safe parse diagnostics.
    pub diagnostics: Vec<ExtractionDiagnostic>,
}

/// One normalized declaration emitted by a native language extractor.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedSymbol {
    /// Stable line-independent identity.
    pub id: SymbolId,
    /// Declaration category.
    pub kind: SymbolKind,
    /// Local declaration name.
    pub name: String,
    /// Scope-qualified declaration name.
    pub qualified_name: String,
    /// Exact source range.
    pub span: SourceSpan,
    /// Deterministic declaration signature when present.
    pub signature: Option<String>,
    /// Human-authored JSDoc immediately preceding the declaration.
    pub docstring: Option<String>,
    /// Bounded identifier/keyword text from the implementation with literals omitted.
    pub body_search_text: String,
    /// Whether implementation search text stopped at its per-symbol byte ceiling.
    pub body_search_truncated: bool,
    /// Privacy-safe structural and agent-prone detector counters computed from the body AST/text.
    pub health: SymbolHealthMetrics,
    /// Whether this declaration has no implementation body, such as an overload signature.
    pub declaration_only: bool,
    /// Whether this declaration is owned by an inline test scope or test attribute.
    pub test_symbol: bool,
    /// Explicit module export state.
    pub exported: bool,
    /// Explicit default-export state.
    pub default_export: bool,
    /// Language async modifier.
    pub async_symbol: bool,
    /// Class static modifier.
    pub static_member: bool,
    /// Explicit declaration visibility.
    pub visibility: Option<Visibility>,
    /// Whitespace/comment-independent concrete-syntax digest.
    pub structural_digest: ContentDigest,
    /// Identifier/literal-normalized AST-shape digest for Type-2 clone detection.
    pub clone_shape_digest: ContentDigest,
    /// Bounded identifier-preserving leaf-token multiset for Type-3 clone detection.
    ///
    /// Token text is never retained: each token is represented by a domain-separated
    /// fingerprint and occurrence count. `None` means this extractor could not produce a
    /// complete profile within the per-symbol safety bound; exact and Type-2 detection remain
    /// available in that case.
    pub clone_token_profile: Option<CloneTokenProfile>,
}

/// One privacy-safe token occurrence entry in a Type-3 clone profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloneTokenCount(pub u64, pub u32);

/// Complete bounded multiset used for exact SourcererCC-style overlap comparisons.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloneTokenProfile {
    counts: Vec<CloneTokenCount>,
    total_tokens: u32,
}

impl CloneTokenProfile {
    pub(crate) fn new(counts: Vec<CloneTokenCount>, total_tokens: u32) -> Self {
        Self {
            counts,
            total_tokens,
        }
    }

    /// Sorted token fingerprints and their occurrence counts.
    #[must_use]
    pub fn counts(&self) -> &[CloneTokenCount] {
        &self.counts
    }

    /// Number of tokens in the original leaf stream, including repeats.
    #[must_use]
    pub const fn total_tokens(&self) -> u32 {
        self.total_tokens
    }

    /// Retained heap bytes charged to the native extraction budget.
    #[must_use]
    pub const fn retained_bytes(&self) -> usize {
        self.counts.capacity() * std::mem::size_of::<CloneTokenCount>()
    }
}

/// Bounded per-symbol metrics retained without source literals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolHealthMetrics {
    /// Distinct source rows containing owned syntax, with comments and opaque literals collapsed.
    pub code_lines: u32,
    pub parameter_count: u16,
    pub cyclomatic: u16,
    pub max_nesting: u16,
    pub max_conditional_operands: u16,
    /// Bytes covered by outermost string and numeric literals inside the symbol body.
    pub literal_bytes: u32,
    pub magic_numbers: u16,
    pub hardcoded_urls: u16,
    /// Credential/PII handling confidence on a bounded integer 0-100 scale.
    pub secrets_score: u16,
    /// Bit-set of the privacy-safe secret-signal categories contributing to the score.
    pub secrets_signal_mask: u16,
    /// Count of documented numeric claims disjoint from a constant's current value.
    pub stale_doc_numbers: u16,
    pub accidental_quadratic: u16,
    pub empty_catches: u16,
    pub sync_io_in_async: u16,
    pub sequential_await_loops: u16,
    pub ts_any_casts: u16,
    pub ts_suppressions: u16,
    pub debug_logs: u16,
    pub incomplete_markers: u16,
    pub dynamic_eval: u16,
    pub insecure_hash: u16,
    pub insecure_random: u16,
    pub http_without_timeout: u16,
    pub sql_string_concatenation: u16,
    pub unsafe_json_parse: u16,
    pub unvalidated_env: u16,
    pub empty_body: u16,
}

/// Lexical parent-child relationship between two extracted symbols.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Containment {
    /// Enclosing declaration.
    pub parent: SymbolId,
    /// Directly enclosed declaration.
    pub child: SymbolId,
}

/// One unresolved source reference with its closest extracted owner.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedReference {
    /// Closest function, method, class, interface, enum, or binding owner.
    pub owner: Option<SymbolId>,
    /// Normalized target name or module specifier.
    pub name: String,
    /// Optional framework-qualified lookup identity while retaining the source-visible name.
    pub resolution_name: Option<String>,
    /// Structural relationship requested from resolution.
    pub kind: ReferenceKind,
    /// Exact source range recorded for the reference expression.
    pub span: SourceSpan,
}

/// Source import/binding category with explicit module and visibility semantics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportBindingKind {
    /// `import Name from './module'`.
    Default,
    /// `import { Name as Local } from './module'`.
    Named,
    /// `import * as Local from './module'`.
    Namespace,
    /// `export * from './module'`, expanded after project-wide module resolution.
    ReExportAll,
    /// `export * as Local from './module'`, retaining the exported namespace owner.
    ReExportNamespace,
    /// C-family `#include "project/header.h"` resolved against project files.
    IncludeQuoted,
    /// C-family `#include <system/header.h>` retained but never guessed as a project file.
    IncludeSystem,
}

/// One source-level module/include binding retained for exact project resolution.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedImportBinding {
    /// Binding/include semantics.
    pub kind: ImportBindingKind,
    /// Original bounded module specifier without quotes.
    pub module_specifier: String,
    /// Exported name, `default`, or `*` for a namespace/include binding.
    pub imported_name: String,
    /// Identifier visible in the importing file, or `*` for an include.
    pub local_name: String,
    /// Span of the imported name for named imports, otherwise the local identifier.
    pub span: SourceSpan,
}

/// Stable category for a recoverable extraction diagnostic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    /// Tree-sitter recovered through one or more syntax-error nodes.
    SyntaxError,
}

/// Bounded diagnostic that never embeds source text or project paths.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractionDiagnostic {
    /// Stable machine-readable category.
    pub code: DiagnosticCode,
    /// Error-node range when it was non-empty and representable.
    pub span: Option<SourceSpan>,
}
