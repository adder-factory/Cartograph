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
/// Decoded SCIP relationship with validated bounded fields.
pub struct ScipRelationship {
    /// Symbol for this record.
    pub symbol: String,
    /// Roles for this record.
    pub roles: ScipRelationshipRoles,
}

/// Typed set of independent roles carried by one SCIP relationship.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScipRelationshipRoles {
    bits: u8,
}

impl ScipRelationshipRoles {
    const REFERENCE: u8 = 1 << 0;
    const IMPLEMENTATION: u8 = 1 << 1;
    const TYPE_DEFINITION: u8 = 1 << 2;
    const DEFINITION: u8 = 1 << 3;

    const fn with_role(mut self, role: u8, enabled: bool) -> Self {
        if enabled {
            self.bits |= role;
        } else {
            self.bits &= !role;
        }
        self
    }

    /// Record whether the relationship is a reference.
    #[must_use]
    pub const fn with_reference(self, enabled: bool) -> Self {
        self.with_role(Self::REFERENCE, enabled)
    }

    /// Record whether the relationship describes implementation inheritance.
    #[must_use]
    pub const fn with_implementation(self, enabled: bool) -> Self {
        self.with_role(Self::IMPLEMENTATION, enabled)
    }

    /// Record whether the target is the relationship's type definition.
    #[must_use]
    pub const fn with_type_definition(self, enabled: bool) -> Self {
        self.with_role(Self::TYPE_DEFINITION, enabled)
    }

    /// Record whether the target is a definition.
    #[must_use]
    pub const fn with_definition(self, enabled: bool) -> Self {
        self.with_role(Self::DEFINITION, enabled)
    }

    /// Whether the relationship is a reference.
    #[must_use]
    pub const fn reference(self) -> bool {
        self.bits & Self::REFERENCE != 0
    }

    /// Whether the relationship describes implementation inheritance.
    #[must_use]
    pub const fn implementation(self) -> bool {
        self.bits & Self::IMPLEMENTATION != 0
    }

    /// Whether the target is the relationship's type definition.
    #[must_use]
    pub const fn type_definition(self) -> bool {
        self.bits & Self::TYPE_DEFINITION != 0
    }

    /// Whether the target is a definition.
    #[must_use]
    pub const fn definition(self) -> bool {
        self.bits & Self::DEFINITION != 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Cartograph typed-edge extension attached to a SCIP relationship.
pub struct CartographScipEdge {
    /// Target symbol for this record.
    pub target_symbol: String,
    /// Edge kind for this record.
    pub edge_kind: String,
    /// Number of site entries.
    pub site_count: u32,
    /// Provenance for this record.
    pub provenance: String,
    /// Raw IEEE-754 confidence bits retained for deterministic round trips.
    pub confidence_bits: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Decoded SCIP symbol information with validated bounded fields.
pub struct ScipSymbolInformation {
    /// Symbol for this record.
    pub symbol: String,
    /// Display name for this record.
    pub display_name: String,
    /// SCIP symbol-kind numeric value.
    pub kind: u32,
    /// Bounded documentation included in this result.
    pub documentation: Vec<String>,
    /// Bounded relationships included in this result.
    pub relationships: Vec<ScipRelationship>,
    /// Enclosing symbol for this record.
    pub enclosing_symbol: String,
    /// Bounded cartograph edges included in this result.
    pub cartograph_edges: Vec<CartographScipEdge>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Decoded SCIP occurrence with validated bounded fields.
pub struct ScipOccurrence {
    /// Zero-based SCIP source range.
    pub range: Vec<u32>,
    /// Symbol for this record.
    pub symbol: String,
    /// Number of symbol roles.
    pub symbol_roles: u32,
    /// Optional zero-based range of the enclosing declaration.
    pub enclosing_range: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Decoded SCIP document with validated bounded fields.
pub struct ScipDocument {
    /// Project-relative relative path for this record.
    pub relative_path: String,
    /// Language for this record.
    pub language: String,
    /// Bounded occurrences included in this result.
    pub occurrences: Vec<ScipOccurrence>,
    /// Bounded symbols included in this result.
    pub symbols: Vec<ScipSymbolInformation>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Decoded SCIP index with validated bounded fields.
pub struct ScipIndex {
    /// Tool name for this record.
    pub tool_name: String,
    /// Tool version for this record.
    pub tool_version: String,
    /// Project root for this record.
    pub project_root: String,
    /// Bounded documents included in this result.
    pub documents: Vec<ScipDocument>,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
/// Errors produced while processing SCIP.
pub enum ScipError {
    #[error("SCIP input or output exceeds its bounded contract")]
    /// Input or output exceeded a documented hard limit.
    LimitExceeded,
    #[error("SCIP protobuf wire data is malformed")]
    /// Encoded SCIP bytes violate the wire-format contract.
    InvalidWireData,
    #[error("SCIP contains invalid UTF-8 or domain values")]
    /// Decoded data violates the typed interchange contract.
    InvalidData,
    #[error("SCIP overlay could not be reconciled with the native generation")]
    /// SCIP overlay facts could not be reconciled safely.
    OverlayFailed,
    #[error("SCIP operation was cancelled")]
    /// The caller requested cancellation before the bounded operation completed.
    Cancelled,
    #[error("SCIP source bytes no longer match the immutable graph snapshot")]
    /// Live source no longer matches the generation or digest fence.
    SourceChanged,
}
