use cartograph_domain::{
    ContentDigest, FileId, FileParseStatus, NormalizedPath, ReferenceKind, SourceLanguage,
    SourceSpan, SymbolId, SymbolKind, Visibility,
};

/// Complete storage-independent output for one native source-file extraction.
#[derive(Debug, PartialEq, Eq)]
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
    /// Bounded, credential-safe parse diagnostics.
    pub diagnostics: Vec<ExtractionDiagnostic>,
}

/// One normalized declaration emitted by a native language extractor.
#[derive(Debug, PartialEq, Eq)]
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
    /// Whether this declaration has no implementation body, such as an overload signature.
    pub declaration_only: bool,
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
}

/// Lexical parent-child relationship between two extracted symbols.
#[derive(Debug, PartialEq, Eq)]
pub struct Containment {
    /// Enclosing declaration.
    pub parent: SymbolId,
    /// Directly enclosed declaration.
    pub child: SymbolId,
}

/// One unresolved source reference with its closest extracted owner.
#[derive(Debug, PartialEq, Eq)]
pub struct ExtractedReference {
    /// Closest function, method, class, interface, enum, or binding owner.
    pub owner: Option<SymbolId>,
    /// Normalized target name or module specifier.
    pub name: String,
    /// Structural relationship requested from resolution.
    pub kind: ReferenceKind,
    /// Exact source range recorded for the reference expression.
    pub span: SourceSpan,
}

/// ES module binding category with explicit target and local-name semantics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportBindingKind {
    /// `import Name from './module'`.
    Default,
    /// `import { Name as Local } from './module'`.
    Named,
    /// `import * as Local from './module'`.
    Namespace,
}

/// One source-level ES module binding retained for exact project resolution.
#[derive(Debug, PartialEq, Eq)]
pub struct ExtractedImportBinding {
    /// Default, named, or namespace binding semantics.
    pub kind: ImportBindingKind,
    /// Original bounded module specifier without quotes.
    pub module_specifier: String,
    /// Exported name, `default`, or `*` for a namespace binding.
    pub imported_name: String,
    /// Identifier visible in the importing file.
    pub local_name: String,
    /// Span of the imported name for named imports, otherwise the local identifier.
    pub span: SourceSpan,
}

/// Stable category for a recoverable extraction diagnostic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticCode {
    /// Tree-sitter recovered through one or more syntax-error nodes.
    SyntaxError,
}

/// Bounded diagnostic that never embeds source text or project paths.
#[derive(Debug, PartialEq, Eq)]
pub struct ExtractionDiagnostic {
    /// Stable machine-readable category.
    pub code: DiagnosticCode,
    /// Error-node range when it was non-empty and representable.
    pub span: Option<SourceSpan>,
}
