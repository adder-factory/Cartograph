use std::{fmt, str};

use cartograph_domain::{ContentDigest, FileId, NormalizedPath, SourceLanguage};
use thiserror::Error;

use crate::identity::file_id;

const MAX_CONFIGURED_SOURCE_BYTES: usize = 512 * 1024 * 1024;

/// Validated per-file source-size policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceLimits {
    max_source_bytes: usize,
}

impl SourceLimits {
    /// Require a nonzero source bound no larger than the hard parser ceiling.
    pub const fn new(max_source_bytes: usize) -> Result<Self, SourceLimitsError> {
        if max_source_bytes == 0 || max_source_bytes > MAX_CONFIGURED_SOURCE_BYTES {
            return Err(SourceLimitsError);
        }
        Ok(Self { max_source_bytes })
    }

    /// Maximum accepted exact source bytes.
    #[must_use]
    pub const fn max_source_bytes(self) -> usize {
        self.max_source_bytes
    }
}

/// A configured source-size policy was zero or exceeded the hard ceiling.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[error("native source-size limit is invalid")]
pub struct SourceLimitsError;

/// Safe immutable input to one native parser invocation.
#[derive(PartialEq, Eq)]
pub struct SourceSnapshot {
    path: NormalizedPath,
    language: SourceLanguage,
    file_id: FileId,
    content_hash: ContentDigest,
    byte_size: u64,
    source: Box<str>,
}

struct ValidatedSource {
    path: NormalizedPath,
    language: SourceLanguage,
    byte_size: u64,
}

pub(crate) struct StreamedSource {
    source: String,
    content_hash: ContentDigest,
}

impl StreamedSource {
    pub(crate) const fn new(source: String, content_hash: ContentDigest) -> Self {
        Self {
            source,
            content_hash,
        }
    }
}

impl SourceSnapshot {
    pub(crate) fn supports_path(path: &NormalizedPath) -> bool {
        classify_path(path).is_some()
    }

    /// Validate path, extension, size, and UTF-8 before any parser is invoked.
    pub fn from_bytes(
        raw_path: &str,
        bytes: &[u8],
        limits: SourceLimits,
    ) -> Result<Self, SnapshotError> {
        let validated = validate_source(raw_path, bytes.len(), limits)?;
        let validated_utf8 = str::from_utf8(bytes).map_err(|_| SnapshotError::InvalidUtf8)?;
        let mut source = String::new();
        source
            .try_reserve(validated_utf8.len())
            .map_err(|_| SnapshotError::ResourceLimit)?;
        source.push_str(validated_utf8);
        let content_hash = ContentDigest::from_bytes(*blake3::hash(bytes).as_bytes());
        Ok(Self::build(
            validated,
            content_hash,
            source.into_boxed_str(),
        ))
    }

    pub(crate) fn from_streamed_source(
        raw_path: &str,
        streamed: StreamedSource,
        limits: SourceLimits,
    ) -> Result<Self, SnapshotError> {
        let validated = validate_source(raw_path, streamed.source.len(), limits)?;
        Ok(Self::build(
            validated,
            streamed.content_hash,
            streamed.source.into_boxed_str(),
        ))
    }

    fn build(validated: ValidatedSource, content_hash: ContentDigest, source: Box<str>) -> Self {
        let file_id = file_id(&validated.path);
        Self {
            path: validated.path,
            language: validated.language,
            file_id,
            content_hash,
            byte_size: validated.byte_size,
            source,
        }
    }

    /// Canonical project-relative path.
    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    /// Native grammar selected from the canonical extension.
    #[must_use]
    pub const fn language(&self) -> SourceLanguage {
        self.language
    }

    /// Stable path-derived file identity.
    #[must_use]
    pub const fn file_id(&self) -> &FileId {
        &self.file_id
    }

    /// Digest of exact original source bytes.
    #[must_use]
    pub const fn content_hash(&self) -> &ContentDigest {
        &self.content_hash
    }

    /// Original source size.
    #[must_use]
    pub const fn byte_size(&self) -> u64 {
        self.byte_size
    }

    /// Validated UTF-8 source, byte-identical to the hashed input.
    #[must_use]
    pub const fn source(&self) -> &str {
        &self.source
    }
}

impl fmt::Debug for SourceSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SourceSnapshot")
            .field("language", &self.language)
            .field("file_id", &self.file_id)
            .field("content_hash", &self.content_hash)
            .field("byte_size", &self.byte_size)
            .finish_non_exhaustive()
    }
}

fn validate_source(
    raw_path: &str,
    byte_length: usize,
    limits: SourceLimits,
) -> Result<ValidatedSource, SnapshotError> {
    let path = NormalizedPath::parse(raw_path).map_err(|_| SnapshotError::InvalidPath)?;
    let language = classify_path(&path).ok_or(SnapshotError::UnsupportedLanguage)?;
    if byte_length > limits.max_source_bytes() {
        return Err(SnapshotError::SourceTooLarge);
    }
    let byte_size = u64::try_from(byte_length).map_err(|_| SnapshotError::SourceTooLarge)?;
    Ok(ValidatedSource {
        path,
        language,
        byte_size,
    })
}

/// Source bytes were unsafe or unsupported for the first native extractor slice.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum SnapshotError {
    /// The path was absolute, escaping, empty, or oversized.
    #[error("native source path is invalid")]
    InvalidPath,
    /// The extension is not owned by the native TypeScript/JavaScript slice.
    #[error("native source language is unsupported")]
    UnsupportedLanguage,
    /// Exact input bytes exceeded the configured bound.
    #[error("native source exceeds the configured size limit")]
    SourceTooLarge,
    /// The first native parser slice accepts UTF-8 source only.
    #[error("native source is not valid UTF-8")]
    InvalidUtf8,
    /// A bounded snapshot buffer could not be reserved without aborting the process.
    #[error("native source snapshot buffer could not be reserved")]
    ResourceLimit,
}

/// True when a supported source path uses a test directory or test/spec filename marker.
#[must_use]
pub fn is_test_source_path(path: &str) -> bool {
    if classify_extension(path).is_none() {
        return false;
    }
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        if components.peek().is_some()
            && matches_ignore_ascii_case(component, &["test", "tests", "__tests__"])
        {
            return true;
        }
        if components.peek().is_none() {
            let stem = component
                .rsplit_once('.')
                .map_or(component, |(stem, _)| stem);
            let lower = stem.to_ascii_lowercase();
            return lower.ends_with(".test") || lower.ends_with(".spec");
        }
    }
    false
}

fn matches_ignore_ascii_case(value: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
}

fn classify_path(path: &NormalizedPath) -> Option<SourceLanguage> {
    classify_extension(path.as_str())
}

fn classify_extension(path: &str) -> Option<SourceLanguage> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    match extension.as_str() {
        "ts" | "mts" | "cts" => Some(SourceLanguage::TypeScript),
        "tsx" => Some(SourceLanguage::Tsx),
        "js" | "mjs" | "cjs" | "xsjs" | "xsjslib" => Some(SourceLanguage::JavaScript),
        "jsx" => Some(SourceLanguage::Jsx),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_routing_covers_supported_extensions_directories_and_case() {
        for value in [
            "tests/root.ts",
            "test/root.mts",
            "src/__tests__/nested.cts",
            "src/component.test.tsx",
            "src/module.spec.js",
            "src/module.test.mjs",
            "src/module.spec.cjs",
            "src/module.test.jsx",
            "src/module.spec.xsjs",
            "src/module.test.xsjslib",
            "SRC/TESTS/Mixed.SPEC.TS",
        ] {
            assert!(is_test_source_path(value), "{value}");
        }
        assert!(!is_test_source_path("src/contest.ts"));
        assert!(!is_test_source_path("src/unit.test.md"));
    }
}
