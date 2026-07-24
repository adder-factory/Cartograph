use std::{fs, mem::size_of, path::Path};

use cartograph_domain::NormalizedPath;
use ignore::{DirEntry, WalkBuilder};
use thiserror::Error;

use crate::{SourceRoot, SourceSnapshot};

const CARTOGRAPH_DIRECTORY: &str = ".cartograph";
const CARTOGRAPH_IGNORE_MARKER: &str = ".cartographignore";
const GIT_DIRECTORY: &str = ".git";
const MAX_CONFIGURED_SOURCE_FILES: usize = 10_000_000;
const MAX_CONFIGURED_PATH_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// One deterministic project-relative native source candidate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredSource {
    path: NormalizedPath,
    byte_size: u64,
}

impl DiscoveredSource {
    /// Bind a validated path to the size observed during project discovery.
    #[must_use]
    pub const fn new(path: NormalizedPath, byte_size: u64) -> Self {
        Self { path, byte_size }
    }

    /// Canonical project-relative path.
    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    /// File size observed without opening or retaining source bytes.
    #[must_use]
    pub const fn byte_size(&self) -> u64 {
        self.byte_size
    }

    /// Conservative retained bytes for this path/size manifest record.
    #[must_use]
    pub fn modeled_retained_bytes(&self) -> u64 {
        u64::try_from(size_of::<Self>())
            .unwrap_or(u64::MAX)
            .saturating_mul(2)
            .saturating_add(u64::try_from(self.path.as_str().len()).unwrap_or(u64::MAX))
    }
}

/// Hard discovery bounds independent of source-file contents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiscoveryLimits {
    max_files: usize,
    max_retained_path_bytes: u64,
}

impl DiscoveryLimits {
    /// Validate maximum file count and retained manifest bytes.
    pub const fn new(
        max_files: usize,
        max_retained_path_bytes: u64,
    ) -> Result<Self, DiscoveryLimitsError> {
        if max_files == 0 || max_files > MAX_CONFIGURED_SOURCE_FILES {
            return Err(DiscoveryLimitsError::InvalidFileLimit);
        }
        if max_retained_path_bytes == 0 || max_retained_path_bytes > MAX_CONFIGURED_PATH_BYTES {
            return Err(DiscoveryLimitsError::InvalidPathByteLimit);
        }
        Ok(Self {
            max_files,
            max_retained_path_bytes,
        })
    }

    /// Maximum supported native files returned by one discovery.
    #[must_use]
    pub const fn max_files(self) -> usize {
        self.max_files
    }

    /// Maximum modeled manifest memory retained by one discovery.
    #[must_use]
    pub const fn max_retained_path_bytes(self) -> u64 {
        self.max_retained_path_bytes
    }
}

/// A configured discovery bound was zero or exceeded its hard ceiling.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum DiscoveryLimitsError {
    /// File-count policy was empty or unreasonably large.
    #[error("native discovery file limit is invalid")]
    InvalidFileLimit,
    /// Retained path-manifest policy was empty or unreasonably large.
    #[error("native discovery path-byte limit is invalid")]
    InvalidPathByteLimit,
}

/// Discovery policy plus a caller-owned cooperative cancellation probe.
pub struct SourceDiscoveryOptions<Cancel> {
    limits: DiscoveryLimits,
    cancelled: Cancel,
}

impl<Cancel> SourceDiscoveryOptions<Cancel> {
    /// Bind hard manifest limits and cooperative cancellation.
    pub const fn new(limits: DiscoveryLimits, cancelled: Cancel) -> Self {
        Self { limits, cancelled }
    }
}

impl SourceRoot {
    /// Discover supported native sources under Git-compatible ignore rules.
    pub fn discover(
        &self,
        limits: DiscoveryLimits,
    ) -> Result<Vec<DiscoveredSource>, SourceDiscoveryError> {
        self.discover_with_cancellation(SourceDiscoveryOptions::new(limits, || false))
    }

    /// Walk without following symlinks while polling cancellation between entries.
    pub fn discover_with_cancellation<Cancel>(
        &self,
        options: SourceDiscoveryOptions<Cancel>,
    ) -> Result<Vec<DiscoveredSource>, SourceDiscoveryError>
    where
        Cancel: FnMut() -> bool,
    {
        let SourceDiscoveryOptions {
            limits,
            mut cancelled,
        } = options;
        if cancelled() {
            return Err(SourceDiscoveryError::Cancelled);
        }
        let root = self.canonical_path();
        if root.join(CARTOGRAPH_IGNORE_MARKER).is_file() {
            return Ok(Vec::new());
        }

        let mut builder = WalkBuilder::new(root);
        builder
            .standard_filters(true)
            .hidden(false)
            .follow_links(false)
            .sort_by_file_name(|left, right| left.cmp(right))
            .filter_entry(include_entry);

        let mut sources = Vec::new();
        let mut retained_bytes = 0_u64;
        for entry in builder.build() {
            if cancelled() {
                return Err(SourceDiscoveryError::Cancelled);
            }
            let entry = entry.map_err(|_| SourceDiscoveryError::Walk)?;
            let Some(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| SourceDiscoveryError::Walk)?;
            let raw = relative.to_str().ok_or(SourceDiscoveryError::NonUtf8Path)?;
            let path = NormalizedPath::parse(raw).map_err(|_| SourceDiscoveryError::InvalidPath)?;
            if !SourceSnapshot::supports_path(&path) {
                continue;
            }
            let metadata = entry.metadata().map_err(|_| SourceDiscoveryError::Walk)?;
            let source = DiscoveredSource::new(path, metadata.len());
            let next_retained = retained_bytes
                .checked_add(source.modeled_retained_bytes())
                .ok_or(SourceDiscoveryError::Limit)?;
            if sources.len() >= limits.max_files || next_retained > limits.max_retained_path_bytes {
                return Err(SourceDiscoveryError::Limit);
            }
            sources
                .try_reserve(1)
                .map_err(|_| SourceDiscoveryError::ResourceLimit)?;
            sources.push(source);
            retained_bytes = next_retained;
        }
        sources.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        Ok(sources)
    }
}

/// Credential-safe project discovery failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum SourceDiscoveryError {
    /// Parent, sibling, or deadline cancellation interrupted the walk.
    #[error("native source discovery was cancelled")]
    Cancelled,
    /// An entry could not be read safely and a partial index was refused.
    #[error("native source discovery could not read the project tree")]
    Walk,
    /// A source path could not be represented as UTF-8.
    #[error("native source discovery found a non-UTF-8 path")]
    NonUtf8Path,
    /// A path escaped canonical project-relative normalization.
    #[error("native source discovery found an invalid project path")]
    InvalidPath,
    /// File-count or retained path-memory policy was exceeded.
    #[error("native source discovery exceeded its configured limit")]
    Limit,
    /// The bounded discovery vector could not grow without aborting the process.
    #[error("native source discovery could not reserve bounded memory")]
    ResourceLimit,
}

fn include_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let name = entry.file_name();
    if name == GIT_DIRECTORY || name == CARTOGRAPH_DIRECTORY {
        return false;
    }
    if entry
        .file_type()
        .is_some_and(|file_type| file_type.is_dir())
    {
        return !has_ignore_marker(entry.path());
    }
    true
}

fn has_ignore_marker(directory: &Path) -> bool {
    fs::metadata(directory.join(CARTOGRAPH_IGNORE_MARKER)).is_ok_and(|metadata| metadata.is_file())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use tempfile::tempdir;

    use super::*;

    const DISCOVERY_FILES: usize = 32;
    const DISCOVERY_PATH_BYTES: u64 = 64 * 1024;

    fn limits() -> DiscoveryLimits {
        match DiscoveryLimits::new(DISCOVERY_FILES, DISCOVERY_PATH_BYTES) {
            Ok(limits) => limits,
            Err(error) => panic!("test discovery limits were invalid: {error}"),
        }
    }

    #[test]
    fn discovery_is_sorted_gitignore_aware_and_honors_cartograph_markers() {
        let directory = match tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create discovery fixture: {error}"),
        };
        let root = directory.path();
        assert!(fs::create_dir(root.join(".git")).is_ok());
        assert!(fs::create_dir_all(root.join("src/ignored-tree")).is_ok());
        assert!(fs::create_dir_all(root.join("src/marker-tree")).is_ok());
        assert!(fs::create_dir_all(root.join(".cartograph")).is_ok());
        assert!(fs::write(root.join(".gitignore"), "src/ignored-tree/\n").is_ok());
        assert!(fs::write(root.join("src/z.ts"), "export const z = 1;\n").is_ok());
        assert!(fs::write(root.join("src/a.tsx"), "export const A = () => <div />;\n").is_ok());
        assert!(fs::write(root.join("src/readme.md"), "not native yet\n").is_ok());
        assert!(fs::write(root.join("src/ignored-tree/no.ts"), "ignored\n").is_ok());
        assert!(fs::write(root.join("src/marker-tree/.cartographignore"), "\n").is_ok());
        assert!(fs::write(root.join("src/marker-tree/no.js"), "ignored\n").is_ok());
        assert!(fs::write(root.join(".cartograph/secret.ts"), "ignored\n").is_ok());

        let source_root = match SourceRoot::open(root) {
            Ok(source_root) => source_root,
            Err(error) => panic!("could not open discovery root: {error}"),
        };
        let sources = match source_root.discover(limits()) {
            Ok(sources) => sources,
            Err(error) => panic!("discovery failed: {error}"),
        };
        let paths = sources
            .iter()
            .map(|source| source.path().as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, ["src/a.tsx", "src/z.ts"]);
        assert!(sources.iter().all(|source| source.byte_size() > 0));
    }

    #[test]
    fn discovery_fails_closed_on_limits_and_cancellation() {
        let directory = match tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create discovery fixture: {error}"),
        };
        assert!(fs::write(directory.path().join("one.ts"), "const one = 1;\n").is_ok());
        assert!(fs::write(directory.path().join("two.ts"), "const two = 2;\n").is_ok());
        let source_root = match SourceRoot::open(directory.path()) {
            Ok(source_root) => source_root,
            Err(error) => panic!("could not open discovery root: {error}"),
        };
        let one_file = match DiscoveryLimits::new(1, DISCOVERY_PATH_BYTES) {
            Ok(limits) => limits,
            Err(error) => panic!("test discovery limits were invalid: {error}"),
        };
        assert_eq!(
            source_root.discover(one_file),
            Err(SourceDiscoveryError::Limit)
        );

        let polls = AtomicUsize::new(0);
        let result = source_root
            .discover_with_cancellation(SourceDiscoveryOptions::new(limits(), || {
                polls.fetch_add(1, Ordering::AcqRel) > 0
            }));
        assert_eq!(result, Err(SourceDiscoveryError::Cancelled));
    }

    #[test]
    fn root_marker_opts_the_entire_project_out() {
        let directory = match tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create discovery fixture: {error}"),
        };
        assert!(fs::write(directory.path().join(CARTOGRAPH_IGNORE_MARKER), "\n").is_ok());
        assert!(fs::write(directory.path().join("visible.ts"), "const value = 1;\n").is_ok());
        let source_root = match SourceRoot::open(directory.path()) {
            Ok(source_root) => source_root,
            Err(error) => panic!("could not open discovery root: {error}"),
        };
        assert_eq!(source_root.discover(limits()), Ok(Vec::new()));
    }
}
