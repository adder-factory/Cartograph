//! Stable, storage-independent contracts for Cartograph v2.
//!
//! Identifier constructors canonicalize UUID text at the boundary. Their
//! fields remain private so raw strings cannot accidentally cross between
//! project, generation, file, symbol, document, model, and task identities.

use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

mod source;

pub use source::{
    FileParseStatus, InvalidNormalizedPath, InvalidSourceSpan, NormalizedPath, ReferenceKind,
    SourceLanguage, SourcePosition, SourceSpan, SymbolKind, Visibility,
};

const UUID_TEXT_LENGTH: usize = 36;
const UUID_BYTE_LENGTH: usize = 16;
const UUID_HYPHEN_OFFSETS: [usize; 4] = [8, 13, 18, 23];
const UUID_BYTE_HYPHEN_OFFSETS: [usize; 4] = [4, 6, 8, 10];
const NIL_UUID: &str = "00000000-0000-0000-0000-000000000000";
const BLAKE3_HEX_LENGTH: usize = 64;
const BLAKE3_BYTE_LENGTH: usize = BLAKE3_HEX_LENGTH / 2;
const UPPER_NIBBLE_SHIFT: u8 = 4;
const NIBBLE_MASK: u8 = 0x0f;
const UUID_VERSION_INDEX: usize = 6;
const UUID_VARIANT_INDEX: usize = 8;
const UUID_V8_PREFIX: u8 = 0x80;
const UUID_RFC_VARIANT_PREFIX: u8 = 0x80;
const UUID_VERSION_MASK: u8 = 0x0f;
const UUID_VARIANT_MASK: u8 = 0x3f;
const HEX_DIGITS: &[u8] = b"0123456789abcdef";

/// A supplied branded identifier was not a canonicalizable, non-nil UUID.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidId;

impl fmt::Display for InvalidId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("identifier must be a non-nil UUID")
    }
}

impl std::error::Error for InvalidId {}

macro_rules! define_id {
    ($name:ident, $description:literal) => {
        #[doc = $description]
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String")]
        pub struct $name(String);

        impl $name {
            /// Parse and normalize a UUID without losing the identifier brand.
            pub fn parse(raw: &str) -> Result<Self, InvalidId> {
                normalize_uuid(raw).map(Self)
            }

            /// Return the canonical lowercase UUID text used at storage boundaries.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// Build a deterministic RFC 9562 UUIDv8 from caller-owned hash bytes.
            #[must_use]
            pub fn from_uuid_v8(bytes: [u8; UUID_BYTE_LENGTH]) -> Self {
                Self(format_uuid_v8(bytes))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = InvalidId;

            fn from_str(raw: &str) -> Result<Self, Self::Err> {
                Self::parse(raw)
            }
        }

        impl TryFrom<String> for $name {
            type Error = InvalidId;

            fn try_from(raw: String) -> Result<Self, Self::Error> {
                Self::parse(&raw)
            }
        }
    };
}

define_id!(ProjectId, "A stable Cartograph project identity.");
define_id!(FileId, "A stable source-file identity.");
define_id!(SymbolId, "A stable code-symbol identity.");
define_id!(GenerationId, "An immutable index-generation identity.");
define_id!(DocumentId, "A stable logical search-document identity.");
define_id!(ModelId, "A registered embedding-model identity.");
define_id!(TaskId, "A persisted coding-task identity.");
define_id!(LeaseId, "An observable project-operation lease identity.");

/// A deterministic BLAKE3 digest used to compare complete logical generations.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct ContentDigest(String);

impl ContentDigest {
    /// Parse a 32-byte digest rendered as hexadecimal text.
    pub fn parse(raw: &str) -> Result<Self, InvalidDigest> {
        let canonical = raw.to_ascii_lowercase();
        let valid = canonical.len() == BLAKE3_HEX_LENGTH
            && canonical.bytes().all(|byte| byte.is_ascii_hexdigit());
        valid.then_some(Self(canonical)).ok_or(InvalidDigest)
    }

    /// Render an exact 32-byte digest without a fallible text round trip.
    #[must_use]
    pub fn from_bytes(bytes: [u8; BLAKE3_BYTE_LENGTH]) -> Self {
        let mut encoded = String::with_capacity(BLAKE3_HEX_LENGTH);
        for byte in bytes {
            encoded.push(char::from(
                HEX_DIGITS[usize::from(byte >> UPPER_NIBBLE_SHIFT)],
            ));
            encoded.push(char::from(HEX_DIGITS[usize::from(byte & NIBBLE_MASK)]));
        }
        Self(encoded)
    }

    /// Return the canonical lowercase hexadecimal digest.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ContentDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ContentDigest {
    type Err = InvalidDigest;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        Self::parse(raw)
    }
}

impl TryFrom<String> for ContentDigest {
    type Error = InvalidDigest;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        Self::parse(&raw)
    }
}

/// A supplied deterministic digest was not 32-byte hexadecimal BLAKE3 text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidDigest;

impl fmt::Display for InvalidDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("content digest must contain 64 hexadecimal characters")
    }
}

impl std::error::Error for InvalidDigest {}

/// Mutating project operation serialized by an observable database lease.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectOperation {
    /// Full or incremental code indexing.
    Index,
    /// Explicit synchronization of changed project state.
    Sync,
    /// Hook-triggered indexing or synchronization.
    Hook,
    /// Schema or storage migration.
    Migration,
    /// Derived BM25/vector index rebuild.
    Rebuild,
}

impl ProjectOperation {
    /// Parse the stable PostgreSQL representation.
    pub fn parse(raw: &str) -> Result<Self, InvalidProjectOperation> {
        match raw {
            "index" => Ok(Self::Index),
            "sync" => Ok(Self::Sync),
            "hook" => Ok(Self::Hook),
            "migration" => Ok(Self::Migration),
            "rebuild" => Ok(Self::Rebuild),
            _ => Err(InvalidProjectOperation),
        }
    }

    /// Stable PostgreSQL representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Index => "index",
            Self::Sync => "sync",
            Self::Hook => "hook",
            Self::Migration => "migration",
            Self::Rebuild => "rebuild",
        }
    }
}

/// An unknown durable project-operation value was encountered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidProjectOperation;

impl fmt::Display for InvalidProjectOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("project operation is not recognized")
    }
}

impl std::error::Error for InvalidProjectOperation {}

/// Durable lifecycle state for one immutable index generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationState {
    /// Structural and search facts are still being staged.
    Staging,
    /// Every required stage finished and the generation may be published.
    Ready,
    /// This is the one complete generation visible to project readers.
    Current,
    /// A newer complete generation replaced this one.
    Superseded,
    /// Indexing terminated without producing a publishable generation.
    Failed,
}

impl GenerationState {
    /// Stable PostgreSQL representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::Ready => "ready",
            Self::Current => "current",
            Self::Superseded => "superseded",
            Self::Failed => "failed",
        }
    }
}

/// Search-document category used for intent routing and field boosts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    /// One extracted code symbol.
    Symbol,
    /// File-level structural and summary evidence.
    File,
    /// Human-authored documentation.
    Documentation,
    /// Test code or test-case evidence.
    Test,
    /// Build, deployment, or tool configuration.
    Configuration,
}

impl DocumentKind {
    /// Stable PostgreSQL representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Symbol => "symbol",
            Self::File => "file",
            Self::Documentation => "documentation",
            Self::Test => "test",
            Self::Configuration => "configuration",
        }
    }
}

/// Structural graph relationship between two symbols.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// The source invokes the target.
    Calls,
    /// The source imports the target's module or package.
    Imports,
    /// The source contains a resolved reference to the target.
    References,
    /// The source implements the target contract.
    Implements,
    /// The source extends or inherits from the target.
    Extends,
    /// The source test exercises the target.
    Tests,
    /// The source lexical scope contains the target.
    Contains,
}

impl EdgeKind {
    /// Stable PostgreSQL representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Calls => "calls",
            Self::Imports => "imports",
            Self::References => "references",
            Self::Implements => "implements",
            Self::Extends => "extends",
            Self::Tests => "tests",
            Self::Contains => "contains",
        }
    }
}

fn format_uuid_v8(mut bytes: [u8; UUID_BYTE_LENGTH]) -> String {
    bytes[UUID_VERSION_INDEX] = (bytes[UUID_VERSION_INDEX] & UUID_VERSION_MASK) | UUID_V8_PREFIX;
    bytes[UUID_VARIANT_INDEX] =
        (bytes[UUID_VARIANT_INDEX] & UUID_VARIANT_MASK) | UUID_RFC_VARIANT_PREFIX;
    let mut encoded = String::with_capacity(UUID_TEXT_LENGTH);
    for (index, byte) in bytes.into_iter().enumerate() {
        if UUID_BYTE_HYPHEN_OFFSETS.contains(&index) {
            encoded.push('-');
        }
        encoded.push(char::from(
            HEX_DIGITS[usize::from(byte >> UPPER_NIBBLE_SHIFT)],
        ));
        encoded.push(char::from(HEX_DIGITS[usize::from(byte & NIBBLE_MASK)]));
    }
    encoded
}

fn normalize_uuid(raw: &str) -> Result<String, InvalidId> {
    if raw.len() != UUID_TEXT_LENGTH || !raw.is_ascii() {
        return Err(InvalidId);
    }
    for (offset, byte) in raw.bytes().enumerate() {
        let expects_hyphen = UUID_HYPHEN_OFFSETS.contains(&offset);
        if (expects_hyphen && byte != b'-') || (!expects_hyphen && !byte.is_ascii_hexdigit()) {
            return Err(InvalidId);
        }
    }
    let canonical = raw.to_ascii_lowercase();
    if canonical == NIL_UUID {
        return Err(InvalidId);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::{
        BLAKE3_BYTE_LENGTH, BLAKE3_HEX_LENGTH, ContentDigest, DocumentKind, FileId,
        FileParseStatus, GenerationId, GenerationState, LeaseId, ProjectId, ProjectOperation,
        SymbolId, UUID_BYTE_LENGTH,
    };

    const UPPERCASE_UUID: &str = "4EACCC79-2ED5-4E22-8D77-A8E66D13C345";
    const CANONICAL_UUID: &str = "4eaccc79-2ed5-4e22-8d77-a8e66d13c345";
    const TEST_DIGEST_BYTE: u8 = 0xab;
    const TEST_UUID_V8_BYTE: u8 = 0x11;
    const EXPECTED_TEST_UUID_V8: &str = "11111111-1111-8111-9111-111111111111";

    #[test]
    fn branded_ids_canonicalize_and_validate_deserialized_values() {
        let project = ProjectId::parse(UPPERCASE_UUID);
        let project = match project {
            Ok(project) => project,
            Err(error) => panic!("valid project UUID was rejected: {error}"),
        };

        assert_eq!(project.as_str(), CANONICAL_UUID);
        assert_eq!(
            serde_json::to_string(&project).ok().as_deref(),
            Some("\"4eaccc79-2ed5-4e22-8d77-a8e66d13c345\"")
        );
        assert!(serde_json::from_str::<GenerationId>("\"not-a-uuid\"").is_err());
        assert!(ProjectId::parse("00000000-0000-0000-0000-000000000000").is_err());
    }

    #[test]
    fn lifecycle_and_document_kinds_have_stable_database_values() {
        assert_eq!(GenerationState::Staging.as_str(), "staging");
        assert_eq!(GenerationState::Current.as_str(), "current");
        assert_eq!(DocumentKind::Symbol.as_str(), "symbol");
        assert_eq!(DocumentKind::Documentation.as_str(), "documentation");
        assert_eq!(FileParseStatus::Parsed.as_str(), "parsed");
        assert_eq!(FileParseStatus::Skipped.as_str(), "skipped");
    }

    #[test]
    fn generation_digests_canonicalize_but_reject_malformed_content() {
        let uppercase = "A".repeat(BLAKE3_HEX_LENGTH);
        let digest = ContentDigest::parse(&uppercase);
        assert!(matches!(digest, Ok(value) if value.as_str() == "a".repeat(BLAKE3_HEX_LENGTH)));
        assert!(ContentDigest::parse("abc").is_err());
        assert!(ContentDigest::parse(&"z".repeat(BLAKE3_HEX_LENGTH)).is_err());
        assert_eq!(
            ContentDigest::from_bytes([TEST_DIGEST_BYTE; BLAKE3_BYTE_LENGTH]).as_str(),
            "ab".repeat(BLAKE3_BYTE_LENGTH)
        );
    }

    #[test]
    fn operation_and_lease_contracts_have_stable_storage_values() {
        assert_eq!(ProjectOperation::Index.as_str(), "index");
        assert_eq!(ProjectOperation::Hook.as_str(), "hook");
        assert_eq!(ProjectOperation::Rebuild.as_str(), "rebuild");
        assert!(LeaseId::parse(CANONICAL_UUID).is_ok());
    }

    #[test]
    fn deterministic_uuid_bytes_preserve_identifier_brands() {
        let file = FileId::from_uuid_v8([TEST_UUID_V8_BYTE; UUID_BYTE_LENGTH]);
        let symbol = SymbolId::from_uuid_v8([TEST_UUID_V8_BYTE; UUID_BYTE_LENGTH]);
        assert_eq!(file.as_str(), EXPECTED_TEST_UUID_V8);
        assert_eq!(symbol.as_str(), file.as_str());
    }
}
