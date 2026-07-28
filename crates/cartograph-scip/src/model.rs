use serde::Serialize;
use thiserror::Error;

/// SCIP occurrence role bit identifying a symbol definition.
pub const SYMBOL_ROLE_DEFINITION: u32 = 1;
pub(crate) const POSITION_ENCODING_UTF8: u32 = 1;
pub(crate) const TEXT_ENCODING_UTF8: u32 = 1;
pub(crate) const CARTOGRAPH_EDGES_FIELD: u32 = 1_000;
pub(crate) const MAXIMUM_SCIP_BYTES: usize = 256 * 1_024 * 1_024;
pub(crate) const MAXIMUM_DOCUMENTS: usize = 250_000;
pub(crate) const MAXIMUM_SYMBOLS: usize = 5_000_000;
pub(crate) const MAXIMUM_OCCURRENCES: usize = 10_000_000;
pub(crate) const MAXIMUM_RELATIONSHIPS: usize = 10_000_000;
pub(crate) const MAXIMUM_STRING_BYTES: usize = 65_536;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub(crate) enum ScipSymbolKind {
    Unspecified = 0,
    Class = 7,
    Constant = 8,
    Constructor = 9,
    Enum = 11,
    EnumMember = 12,
    Field = 15,
    File = 16,
    Function = 17,
    Getter = 18,
    Interface = 21,
    Macro = 25,
    Method = 26,
    Module = 29,
    Namespace = 30,
    Object = 33,
    Package = 35,
    Parameter = 37,
    Property = 41,
    Protocol = 42,
    SelfParameter = 44,
    Setter = 45,
    Struct = 49,
    Trait = 53,
    Type = 54,
    TypeAlias = 55,
    TypeParameter = 58,
    Variable = 61,
    AbstractMethod = 66,
    Accessor = 72,
    SingletonMethod = 76,
    StaticDataMember = 77,
    StaticField = 79,
    StaticMethod = 80,
    StaticProperty = 81,
    StaticVariable = 82,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScipRelationship {
    pub symbol: String,
    pub is_reference: bool,
    pub is_implementation: bool,
    pub is_type_definition: bool,
    pub is_definition: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CartographScipEdge {
    pub target_symbol: String,
    pub edge_kind: String,
    pub site_count: u32,
    pub provenance: String,
    pub confidence_bits: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScipSymbolInformation {
    pub symbol: String,
    pub display_name: String,
    pub kind: u32,
    pub documentation: Vec<String>,
    pub relationships: Vec<ScipRelationship>,
    pub enclosing_symbol: String,
    pub cartograph_edges: Vec<CartographScipEdge>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScipOccurrence {
    pub range: Vec<u32>,
    pub symbol: String,
    pub symbol_roles: u32,
    pub enclosing_range: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScipDocument {
    pub relative_path: String,
    pub language: String,
    pub occurrences: Vec<ScipOccurrence>,
    pub symbols: Vec<ScipSymbolInformation>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScipIndex {
    pub tool_name: String,
    pub tool_version: String,
    pub project_root: String,
    pub documents: Vec<ScipDocument>,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScipError {
    #[error("SCIP input or output exceeds its bounded contract")]
    LimitExceeded,
    #[error("SCIP protobuf wire data is malformed")]
    InvalidWireData,
    #[error("SCIP contains invalid UTF-8 or domain values")]
    InvalidData,
    #[error("SCIP overlay could not be reconciled with the native generation")]
    OverlayFailed,
    #[error("SCIP operation was cancelled")]
    Cancelled,
    #[error("SCIP source bytes no longer match the immutable graph snapshot")]
    SourceChanged,
}
