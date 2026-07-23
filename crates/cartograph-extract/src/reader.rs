use std::{
    fmt,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

use cartograph_domain::NormalizedPath;
use thiserror::Error;

use crate::{SnapshotError, SourceLimits, SourceSnapshot, snapshot::StreamedSource};

const READ_CHUNK_BYTES: usize = 64 * 1024;
const MAX_UTF8_CARRY_BYTES: usize = 3;

/// Canonical project root used for symlink-aware bounded source reads.
#[derive(Clone)]
pub struct SourceRoot {
    canonical: Arc<PathBuf>,
}

/// Validated size policy plus a caller-owned cooperative read-cancellation probe.
pub struct SourceReadOptions<Cancel> {
    limits: SourceLimits,
    cancelled: Cancel,
}

impl<Cancel> SourceReadOptions<Cancel> {
    /// Bind source-size and cancellation policy for one bounded read.
    pub const fn new(limits: SourceLimits, cancelled: Cancel) -> Self {
        Self { limits, cancelled }
    }
}

impl SourceRoot {
    /// Resolve and validate one directory root before any project-relative reads.
    pub fn open(root: &Path) -> Result<Self, SourceReadError> {
        let canonical = fs::canonicalize(root).map_err(|_| SourceReadError::RootUnavailable)?;
        let metadata = fs::metadata(&canonical).map_err(|_| SourceReadError::RootUnavailable)?;
        if !metadata.is_dir() {
            return Err(SourceReadError::RootUnavailable);
        }
        Ok(Self {
            canonical: Arc::new(canonical),
        })
    }

    /// Read one supported source file under the configured root.
    pub fn read(
        &self,
        path: &NormalizedPath,
        limits: SourceLimits,
    ) -> Result<SourceSnapshot, SourceReadError> {
        self.read_with_cancellation(path, SourceReadOptions::new(limits, || false))
    }

    /// Read in bounded chunks while polling a supervisor-owned cancellation probe.
    pub fn read_with_cancellation<Cancel>(
        &self,
        path: &NormalizedPath,
        options: SourceReadOptions<Cancel>,
    ) -> Result<SourceSnapshot, SourceReadError>
    where
        Cancel: FnMut() -> bool,
    {
        let SourceReadOptions {
            limits,
            mut cancelled,
        } = options;
        if cancelled() {
            return Err(SourceReadError::Cancelled);
        }
        if !SourceSnapshot::supports_path(path) {
            return Err(SourceReadError::InvalidSnapshot);
        }
        let target = self.resolve_target(path)?;
        let target_metadata =
            fs::metadata(&target).map_err(|_| SourceReadError::FileUnavailable)?;
        if !target_metadata.is_file() {
            return Err(SourceReadError::NotRegularFile);
        }
        let mut file = File::open(&target).map_err(|_| SourceReadError::FileUnavailable)?;
        let metadata = file
            .metadata()
            .map_err(|_| SourceReadError::FileUnavailable)?;
        if !metadata.is_file() {
            return Err(SourceReadError::NotRegularFile);
        }
        let max_source_bytes = u64::try_from(limits.max_source_bytes())
            .map_err(|_| SourceReadError::SourceTooLarge)?;
        if metadata.len() > max_source_bytes {
            return Err(SourceReadError::SourceTooLarge);
        }

        let capacity = usize::try_from(metadata.len())
            .unwrap_or(limits.max_source_bytes())
            .min(limits.max_source_bytes());
        let mut utf8 = Utf8Accumulator::with_capacity(capacity)?;
        let mut hasher = blake3::Hasher::new();
        let mut byte_size = 0_usize;
        let mut chunk = [0_u8; READ_CHUNK_BYTES];
        loop {
            if cancelled() {
                return Err(SourceReadError::Cancelled);
            }
            let read = file
                .read(&mut chunk)
                .map_err(|_| SourceReadError::FileUnavailable)?;
            if read == 0 {
                break;
            }
            let next_size = byte_size
                .checked_add(read)
                .ok_or(SourceReadError::SourceTooLarge)?;
            if next_size > limits.max_source_bytes() {
                return Err(SourceReadError::SourceTooLarge);
            }
            hasher.update(&chunk[..read]);
            utf8.push(&chunk[..read])?;
            byte_size = next_size;
        }
        if cancelled() {
            return Err(SourceReadError::Cancelled);
        }
        let source = utf8.finish()?;
        let content_hash =
            cartograph_domain::ContentDigest::from_bytes(*hasher.finalize().as_bytes());
        SourceSnapshot::from_streamed_source(
            path.as_str(),
            StreamedSource::new(source, content_hash),
            limits,
        )
        .map_err(map_snapshot_error)
    }

    fn resolve_target(&self, path: &NormalizedPath) -> Result<PathBuf, SourceReadError> {
        let candidate = self.canonical.join(path.as_str());
        let target = fs::canonicalize(candidate).map_err(|_| SourceReadError::FileUnavailable)?;
        if !target.starts_with(self.canonical.as_path()) {
            return Err(SourceReadError::OutsideRoot);
        }
        Ok(target)
    }
}

impl fmt::Debug for SourceRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SourceRoot")
            .field("canonical", &"<redacted>")
            .finish()
    }
}

/// Credential-safe project-root or bounded source-read failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum SourceReadError {
    /// The configured root could not be canonicalized as a directory.
    #[error("native source root is unavailable")]
    RootUnavailable,
    /// The requested source could not be opened as a canonical path.
    #[error("native source file is unavailable")]
    FileUnavailable,
    /// A symlink or canonical path escaped the configured project root.
    #[error("native source path escapes the project root")]
    OutsideRoot,
    /// The canonical target was not a regular file.
    #[error("native source target is not a regular file")]
    NotRegularFile,
    /// Metadata or streamed bytes exceeded the configured bound.
    #[error("native source exceeds the configured size limit")]
    SourceTooLarge,
    /// Parent, sibling, or deadline cancellation interrupted the read.
    #[error("native source read was cancelled")]
    Cancelled,
    /// A bounded source buffer could not be reserved without aborting the process.
    #[error("native source buffer could not be reserved")]
    ResourceLimit,
    /// The bounded bytes failed path, language, or UTF-8 snapshot validation.
    #[error("native source snapshot is invalid")]
    InvalidSnapshot,
}

fn map_snapshot_error(error: SnapshotError) -> SourceReadError {
    match error {
        SnapshotError::SourceTooLarge => SourceReadError::SourceTooLarge,
        SnapshotError::InvalidPath
        | SnapshotError::UnsupportedLanguage
        | SnapshotError::InvalidUtf8 => SourceReadError::InvalidSnapshot,
        SnapshotError::ResourceLimit => SourceReadError::ResourceLimit,
    }
}

struct Utf8Accumulator {
    source: String,
    window: Vec<u8>,
    carry: Vec<u8>,
}

impl Utf8Accumulator {
    fn with_capacity(capacity: usize) -> Result<Self, SourceReadError> {
        let mut source = String::new();
        source
            .try_reserve(capacity)
            .map_err(|_| SourceReadError::ResourceLimit)?;
        let mut window = Vec::new();
        window
            .try_reserve(READ_CHUNK_BYTES.saturating_add(MAX_UTF8_CARRY_BYTES))
            .map_err(|_| SourceReadError::ResourceLimit)?;
        let mut carry = Vec::new();
        carry
            .try_reserve(MAX_UTF8_CARRY_BYTES)
            .map_err(|_| SourceReadError::ResourceLimit)?;
        Ok(Self {
            source,
            window,
            carry,
        })
    }

    fn push(&mut self, chunk: &[u8]) -> Result<(), SourceReadError> {
        self.window.clear();
        self.window.extend_from_slice(&self.carry);
        self.window.extend_from_slice(chunk);
        self.carry.clear();
        match std::str::from_utf8(&self.window) {
            Ok(valid) => {
                self.source
                    .try_reserve(valid.len())
                    .map_err(|_| SourceReadError::ResourceLimit)?;
                self.source.push_str(valid);
            }
            Err(error) if error.error_len().is_some() => {
                return Err(SourceReadError::InvalidSnapshot);
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                let valid = std::str::from_utf8(&self.window[..valid_up_to])
                    .map_err(|_| SourceReadError::InvalidSnapshot)?;
                self.source
                    .try_reserve(valid.len())
                    .map_err(|_| SourceReadError::ResourceLimit)?;
                self.source.push_str(valid);
                self.carry.extend_from_slice(&self.window[valid_up_to..]);
                if self.carry.len() > MAX_UTF8_CARRY_BYTES {
                    return Err(SourceReadError::InvalidSnapshot);
                }
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<String, SourceReadError> {
        if self.carry.is_empty() {
            Ok(self.source)
        } else {
            Err(SourceReadError::InvalidSnapshot)
        }
    }
}
