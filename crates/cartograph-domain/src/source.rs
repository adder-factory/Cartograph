//! Storage-independent source-code contracts shared by extraction and indexing.

use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

const MAX_NORMALIZED_PATH_BYTES: usize = 4_096;

macro_rules! impl_stable_as_str {
    ($type:ty, $($variant:pat => $value:literal),+ $(,)?) => {
        impl $type {
            /// Stable storage, search, and protocol representation.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $($variant => $value),+
                }
            }
        }
    };
}

/// Parser outcome recorded for one source file in an immutable generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileParseStatus {
    /// The complete file was parsed and extracted.
    Parsed,
    /// Useful facts were extracted despite recoverable parse gaps.
    Partial,
    /// Parsing failed and no structural facts are trusted.
    Failed,
    /// Project policy deliberately excluded the file from parsing.
    Skipped,
}

impl FileParseStatus {
    /// Stable PostgreSQL representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Parsed => "parsed",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

/// Canonical language identifiers currently accepted by the first native extractor slice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceLanguage {
    /// TypeScript parsed with the native TypeScript grammar.
    #[serde(rename = "typescript")]
    TypeScript,
    /// TypeScript with JSX syntax parsed with the native TSX grammar.
    Tsx,
    /// JavaScript parsed with the native JavaScript grammar.
    #[serde(rename = "javascript")]
    JavaScript,
    /// JavaScript with JSX syntax parsed with the native JavaScript grammar.
    Jsx,
}

impl SourceLanguage {
    /// Stable storage and search representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::JavaScript => "javascript",
            Self::Jsx => "jsx",
        }
    }
}

/// A canonical project-relative source path with forward-slash separators.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct NormalizedPath(String);

impl NormalizedPath {
    /// Normalize a relative path while rejecting absolute and parent-escaping forms.
    pub fn parse(raw: &str) -> Result<Self, InvalidNormalizedPath> {
        if raw.is_empty()
            || raw.contains('\0')
            || raw.starts_with(['/', '\\'])
            || has_windows_drive_prefix(raw)
        {
            return Err(InvalidNormalizedPath);
        }

        let mut components = Vec::new();
        for component in raw.split(['/', '\\']) {
            match component {
                "" | "." => {}
                ".." => return Err(InvalidNormalizedPath),
                value => components.push(value),
            }
        }
        let canonical = components.join("/");
        if canonical.is_empty() || canonical.len() > MAX_NORMALIZED_PATH_BYTES {
            return Err(InvalidNormalizedPath);
        }
        Ok(Self(canonical))
    }

    /// Canonical project-relative path text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for NormalizedPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for NormalizedPath {
    type Err = InvalidNormalizedPath;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        Self::parse(raw)
    }
}

impl TryFrom<String> for NormalizedPath {
    type Error = InvalidNormalizedPath;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        Self::parse(&raw)
    }
}

/// A path was not a bounded canonical project-relative source path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidNormalizedPath;

impl fmt::Display for InvalidNormalizedPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("source path must be a bounded project-relative path")
    }
}

impl std::error::Error for InvalidNormalizedPath {}

/// Exact byte and human-facing line/column location for one source fact.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "SourcePositionValue")]
pub struct SourcePosition {
    byte: u64,
    line: u32,
    column: u32,
}

#[derive(Deserialize)]
struct SourcePositionValue {
    byte: u64,
    line: u32,
    column: u32,
}

impl SourcePosition {
    /// Validate a byte location with a one-based line and zero-based byte column.
    pub const fn new(byte: u64, line: u32, column: u32) -> Result<Self, InvalidSourceSpan> {
        if line == 0 {
            return Err(InvalidSourceSpan);
        }
        Ok(Self { byte, line, column })
    }
}

impl TryFrom<SourcePositionValue> for SourcePosition {
    type Error = InvalidSourceSpan;

    fn try_from(value: SourcePositionValue) -> Result<Self, Self::Error> {
        Self::new(value.byte, value.line, value.column)
    }
}

/// Exact non-empty half-open source range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "SourceSpanValue")]
pub struct SourceSpan {
    start: SourcePosition,
    end: SourcePosition,
}

#[derive(Deserialize)]
struct SourceSpanValue {
    start: SourcePosition,
    end: SourcePosition,
}

impl SourceSpan {
    /// Validate ordered start/end positions.
    pub const fn new(
        start: SourcePosition,
        end: SourcePosition,
    ) -> Result<Self, InvalidSourceSpan> {
        let invalid = start.byte >= end.byte
            || end.line < start.line
            || (start.line == end.line && end.column < start.column);
        if invalid {
            return Err(InvalidSourceSpan);
        }
        Ok(Self { start, end })
    }

    /// Inclusive first source byte.
    #[must_use]
    pub const fn start_byte(self) -> u64 {
        self.start.byte
    }

    /// Exclusive last source byte.
    #[must_use]
    pub const fn end_byte(self) -> u64 {
        self.end.byte
    }

    /// One-based inclusive first line.
    #[must_use]
    pub const fn start_line(self) -> u32 {
        self.start.line
    }

    /// One-based line containing the exclusive end position.
    #[must_use]
    pub const fn end_line(self) -> u32 {
        self.end.line
    }

    /// Zero-based first byte column.
    #[must_use]
    pub const fn start_column(self) -> u32 {
        self.start.column
    }

    /// Zero-based exclusive last byte column.
    #[must_use]
    pub const fn end_column(self) -> u32 {
        self.end.column
    }
}

impl TryFrom<SourceSpanValue> for SourceSpan {
    type Error = InvalidSourceSpan;

    fn try_from(value: SourceSpanValue) -> Result<Self, Self::Error> {
        Self::new(value.start, value.end)
    }
}

/// A source range was empty, reversed, or used invalid line coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidSourceSpan;

impl fmt::Display for InvalidSourceSpan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("source span is invalid")
    }
}

impl std::error::Error for InvalidSourceSpan {}

/// Storage-independent code-symbol category.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    /// Source module or namespace container.
    Module,
    /// Class declaration.
    Class,
    /// Struct or record declaration.
    Struct,
    /// Interface declaration.
    Interface,
    /// Trait declaration.
    Trait,
    /// Protocol declaration.
    Protocol,
    /// Free or nested function.
    Function,
    /// Class/interface method.
    Method,
    /// Property declaration.
    Property,
    /// Field declaration.
    Field,
    /// Mutable or non-constant binding.
    Variable,
    /// Constant binding.
    Constant,
    /// Enum declaration.
    Enum,
    /// Enum member.
    EnumMember,
    /// Type alias.
    TypeAlias,
    /// Namespace declaration.
    Namespace,
    /// Function or method parameter.
    Parameter,
    /// Import declaration.
    Import,
    /// Explicit export declaration.
    Export,
    /// Framework route or command.
    Route,
    /// UI component.
    Component,
    /// Database table declaration.
    Table,
    /// Framework or deployment resource.
    Resource,
}

impl_stable_as_str!(
    SymbolKind,
    Self::Module => "module",
    Self::Class => "class",
    Self::Struct => "struct",
    Self::Interface => "interface",
    Self::Trait => "trait",
    Self::Protocol => "protocol",
    Self::Function => "function",
    Self::Method => "method",
    Self::Property => "property",
    Self::Field => "field",
    Self::Variable => "variable",
    Self::Constant => "constant",
    Self::Enum => "enum",
    Self::EnumMember => "enum_member",
    Self::TypeAlias => "type_alias",
    Self::Namespace => "namespace",
    Self::Parameter => "parameter",
    Self::Import => "import",
    Self::Export => "export",
    Self::Route => "route",
    Self::Component => "component",
    Self::Table => "table",
    Self::Resource => "resource",
);

/// Language-level declaration visibility.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    /// Publicly accessible declaration.
    Public,
    /// Class-private declaration.
    Private,
    /// Subclass-visible declaration.
    Protected,
    /// Package or assembly internal declaration.
    Internal,
}

impl Visibility {
    /// Stable storage and protocol representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Private => "private",
            Self::Protected => "protected",
            Self::Internal => "internal",
        }
    }
}

/// Unresolved structural relationship emitted before project-wide resolution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    /// The owner invokes the target.
    Calls,
    /// The file imports the target module.
    Imports,
    /// The owner contains a general symbol reference.
    References,
    /// The owner implements the target contract.
    Implements,
    /// The owner extends or inherits from the target.
    Extends,
    /// The owner test exercises the target.
    Tests,
    /// The owner exports the target.
    Exports,
    /// The owner has or consumes the target type.
    TypeOf,
    /// The owner returns the target type.
    Returns,
    /// The owner constructs the target.
    Instantiates,
    /// The owner overrides the target.
    Overrides,
    /// The owner is decorated by the target.
    Decorates,
    /// The owner accesses a target field.
    FieldAccess,
    /// The owner defines and subsequently uses the target binding.
    DefUse,
}

impl_stable_as_str!(
    ReferenceKind,
    Self::Calls => "calls",
    Self::Imports => "imports",
    Self::References => "references",
    Self::Implements => "implements",
    Self::Extends => "extends",
    Self::Tests => "tests",
    Self::Exports => "exports",
    Self::TypeOf => "type_of",
    Self::Returns => "returns",
    Self::Instantiates => "instantiates",
    Self::Overrides => "overrides",
    Self::Decorates => "decorates",
    Self::FieldAccess => "field_access",
    Self::DefUse => "def_use",
);

fn has_windows_drive_prefix(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[cfg(test)]
mod tests {
    use super::{
        NormalizedPath, ReferenceKind, SourceLanguage, SourcePosition, SourceSpan, SymbolKind,
    };

    const SPAN_START_BYTE: u64 = 7;
    const SPAN_END_BYTE: u64 = 19;
    const SPAN_START_LINE: u32 = 2;
    const SPAN_END_LINE: u32 = 3;
    const SPAN_START_COLUMN: u32 = 4;
    const SPAN_END_COLUMN: u32 = 1;

    #[test]
    fn paths_canonicalize_and_spans_reject_escaping_coordinates() {
        let canonical = NormalizedPath::parse(r"src\feature\.\service.ts");
        assert!(matches!(canonical, Ok(path) if path.as_str() == "src/feature/service.ts"));
        assert!(NormalizedPath::parse("../secret.ts").is_err());
        assert!(NormalizedPath::parse("/absolute.ts").is_err());
        assert!(NormalizedPath::parse("C:\\absolute.ts").is_err());

        let start = position(SPAN_START_BYTE, SPAN_START_LINE, SPAN_START_COLUMN);
        let end = position(SPAN_END_BYTE, SPAN_END_LINE, SPAN_END_COLUMN);
        assert!(SourceSpan::new(start, end).is_ok());
        assert!(SourceSpan::new(end, start).is_err());
        assert!(SourcePosition::new(SPAN_START_BYTE, 0, SPAN_START_COLUMN).is_err());
        let reversed_line_end = position(SPAN_END_BYTE, SPAN_START_LINE, SPAN_END_COLUMN);
        let reversed_line_start = position(SPAN_START_BYTE, SPAN_END_LINE, SPAN_START_COLUMN);
        assert!(SourceSpan::new(reversed_line_start, reversed_line_end).is_err());
        let reversed_column_end = position(SPAN_END_BYTE, SPAN_START_LINE, SPAN_END_COLUMN);
        assert!(SourceSpan::new(start, reversed_column_end).is_err());
    }

    #[test]
    fn extraction_enums_have_stable_values() {
        assert_eq!(SourceLanguage::TypeScript.as_str(), "typescript");
        assert_eq!(SourceLanguage::Tsx.as_str(), "tsx");
        assert_eq!(SourceLanguage::JavaScript.as_str(), "javascript");
        assert_eq!(SourceLanguage::Jsx.as_str(), "jsx");
        assert_eq!(SymbolKind::TypeAlias.as_str(), "type_alias");
        assert_eq!(SymbolKind::EnumMember.as_str(), "enum_member");
        assert_eq!(ReferenceKind::TypeOf.as_str(), "type_of");
        assert_eq!(ReferenceKind::FieldAccess.as_str(), "field_access");
    }

    #[test]
    fn serde_preserves_stable_languages_and_rejects_invalid_source_coordinates() {
        assert_eq!(
            serde_json::to_string(&SourceLanguage::TypeScript)
                .ok()
                .as_deref(),
            Some("\"typescript\"")
        );
        assert_eq!(
            serde_json::to_string(&SourceLanguage::JavaScript)
                .ok()
                .as_deref(),
            Some("\"javascript\"")
        );
        assert!(
            serde_json::from_str::<SourcePosition>(r#"{"byte":0,"line":0,"column":0}"#).is_err()
        );
        assert!(
            serde_json::from_str::<SourceSpan>(
                r#"{"start":{"byte":1,"line":2,"column":0},"end":{"byte":2,"line":1,"column":0}}"#,
            )
            .is_err()
        );
    }

    fn position(byte: u64, line: u32, column: u32) -> SourcePosition {
        match SourcePosition::new(byte, line, column) {
            Ok(position) => position,
            Err(error) => panic!("test source position was invalid: {error}"),
        }
    }
}
