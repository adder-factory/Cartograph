use std::{collections::BTreeMap, time::UNIX_EPOCH};

use cartograph_db::{IndexedFileFingerprint, StorageError};
use cartograph_domain::{GenerationId, ProjectId};
use cartograph_extract::{DiscoveryPolicy, SourceDiscoveryOptions, SourceReadOptions, SourceRoot};
use serde::Serialize;
use thiserror::Error;

use crate::{ProjectCancellation, ProjectRuntime, discovery_limits};

const DEFAULT_BUCKET_LIMIT: u16 = 100;
const MAXIMUM_BUCKET_LIMIT: u16 = 500;
/// JavaScript Date's exact accepted millisecond range, retained for v1 input parity.
pub const MAXIMUM_UNIX_MILLISECONDS: u64 = 8_640_000_000_000_000;

/// Validated file-drift comparison policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileDriftOptions {
    threshold_unix_ms: Option<u64>,
    bucket_limit: u16,
}

impl FileDriftOptions {
    /// Compare exact current file mtimes against a caller-supplied threshold.
    /// # Errors
    ///
    /// Returns [`FileDriftError::InvalidOptions`] when the timestamp exceeds
    /// JavaScript Date's exact accepted millisecond range.
    pub const fn since(threshold_unix_ms: u64) -> Result<Self, FileDriftError> {
        if threshold_unix_ms > MAXIMUM_UNIX_MILLISECONDS {
            return Err(FileDriftError::InvalidOptions);
        }
        Ok(Self {
            threshold_unix_ms: Some(threshold_unix_ms),
            bucket_limit: DEFAULT_BUCKET_LIMIT,
        })
    }

    /// Override the retained rows per added/modified/deleted bucket.
    /// # Errors
    ///
    /// Returns [`FileDriftError::InvalidOptions`] when `limit` is zero or
    /// exceeds the retained rows allowed for each drift bucket.
    pub const fn with_bucket_limit(mut self, limit: u16) -> Result<Self, FileDriftError> {
        if limit == 0 || limit > MAXIMUM_BUCKET_LIMIT {
            return Err(FileDriftError::InvalidOptions);
        }
        self.bucket_limit = limit;
        Ok(self)
    }
}

impl Default for FileDriftOptions {
    fn default() -> Self {
        Self {
            threshold_unix_ms: None,
            bucket_limit: DEFAULT_BUCKET_LIMIT,
        }
    }
}

/// Stable meaning of the modified-file bucket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileDriftBasis {
    /// Represents the indexed content hash file drift basis.
    IndexedContentHash,
    /// Represents the modification time file drift basis.
    ModificationTime,
}

/// Complete counts plus bounded deterministic path lists for source drift.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDriftReport {
    project_id: ProjectId,
    generation_id: GenerationId,
    basis: FileDriftBasis,
    threshold_unix_ms: Option<u64>,
    indexed_files: u64,
    live_files: u64,
    added_count: u64,
    modified_count: u64,
    deleted_count: u64,
    added: Vec<String>,
    modified: Vec<String>,
    deleted: Vec<String>,
    added_truncated: bool,
    modified_truncated: bool,
    deleted_truncated: bool,
}

/// Credential- and path-safe file-drift failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum FileDriftError {
    #[error("file drift options are invalid")]
    /// Supplied options violate a documented bound or invariant.
    InvalidOptions,
    #[error("file drift requires a published project generation")]
    /// No current indexed generation is available.
    NotIndexed,
    #[error("file drift database evidence is unavailable")]
    /// The required durable storage operation could not complete.
    StorageUnavailable,
    #[error("file drift source evidence is unavailable")]
    /// Required source evidence could not be read safely.
    SourceUnavailable,
    #[error("the current generation changed during file drift analysis")]
    /// The current generation changed before the operation completed.
    GenerationChanged,
    #[error("file drift analysis was cancelled")]
    /// The caller requested cancellation before the bounded operation completed.
    Cancelled,
}

impl ProjectRuntime {
    /// Compare supported live source with the current PostgreSQL manifest.
    /// Without a threshold, modified means an exact digest mismatch; with a
    /// threshold it means only that the live mtime is newer than that instant.
    /// # Errors
    ///
    /// Returns an error when no current generation exists, database
    /// fingerprints or live source cannot be read safely, cancellation wins,
    /// or the current generation changes before the comparison is fenced.
    pub async fn file_drift(
        &self,
        options: FileDriftOptions,
        cancellation: ProjectCancellation,
    ) -> Result<FileDriftReport, FileDriftError> {
        let before = self
            .database()
            .project_snapshot_by_root(self.root_identity())
            .await
            .map_err(|_| FileDriftError::StorageUnavailable)?
            .ok_or(FileDriftError::NotIndexed)?;
        let current = before.current.as_ref().ok_or(FileDriftError::NotIndexed)?;
        let fingerprints = self
            .database()
            .current_file_fingerprints(&before.project_id)
            .await
            .map_err(|error| map_storage_error(&error))?;
        let permit = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(FileDriftError::Cancelled),
            result = self.source_scan_permits.clone().acquire_owned() => {
                result.map_err(|_| FileDriftError::SourceUnavailable)?
            }
        };
        let source_policy = crate::project_source_policy(&self.root)
            .map_err(|_| FileDriftError::SourceUnavailable)?;
        let root = self.root.clone();
        let worker_cancellation = cancellation.clone();
        let scan = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            scan_file_drift(DriftScanRequest {
                root: &root,
                fingerprints,
                options,
                discovery_policy: source_policy.discovery,
                maximum_source_bytes: source_policy
                    .maximum_file_bytes
                    .unwrap_or(crate::DEFAULT_MAX_SOURCE_BYTES),
                cancelled: || worker_cancellation.is_cancelled(),
            })
        })
        .await
        .map_err(|_| FileDriftError::SourceUnavailable)??;
        if cancellation.is_cancelled() {
            return Err(FileDriftError::Cancelled);
        }
        let after = self
            .database()
            .project_snapshot_by_root(self.root_identity())
            .await
            .map_err(|_| FileDriftError::StorageUnavailable)?;
        let unchanged = after.as_ref().is_some_and(|snapshot| {
            snapshot.project_id == before.project_id
                && snapshot.current.as_ref().is_some_and(|observed| {
                    observed.generation_id == current.generation_id
                        && observed.source_revision == current.source_revision
                })
        });
        if !unchanged {
            return Err(FileDriftError::GenerationChanged);
        }
        Ok(scan.finish(before.project_id, current.generation_id.clone(), options))
    }
}

struct DriftScan {
    indexed_files: u64,
    live_files: u64,
    added: PathBucket,
    modified: PathBucket,
    deleted: PathBucket,
}

impl DriftScan {
    fn finish(
        self,
        project_id: ProjectId,
        generation_id: GenerationId,
        options: FileDriftOptions,
    ) -> FileDriftReport {
        FileDriftReport {
            project_id,
            generation_id,
            basis: if options.threshold_unix_ms.is_some() {
                FileDriftBasis::ModificationTime
            } else {
                FileDriftBasis::IndexedContentHash
            },
            threshold_unix_ms: options.threshold_unix_ms,
            indexed_files: self.indexed_files,
            live_files: self.live_files,
            added_count: self.added.count,
            modified_count: self.modified.count,
            deleted_count: self.deleted.count,
            added_truncated: self.added.truncated(),
            modified_truncated: self.modified.truncated(),
            deleted_truncated: self.deleted.truncated(),
            added: self.added.paths,
            modified: self.modified.paths,
            deleted: self.deleted.paths,
        }
    }
}

struct PathBucket {
    count: u64,
    limit: usize,
    paths: Vec<String>,
}

impl PathBucket {
    fn new(limit: u16) -> Self {
        Self {
            count: 0,
            limit: usize::from(limit),
            paths: Vec::new(),
        }
    }

    fn push(&mut self, path: &str) {
        self.count = self.count.saturating_add(1);
        if self.paths.len() < self.limit {
            self.paths.push(path.to_owned());
        }
    }

    fn truncated(&self) -> bool {
        self.count > u64::try_from(self.paths.len()).unwrap_or(u64::MAX)
    }
}

struct DriftScanRequest<'a, Cancel> {
    root: &'a std::path::Path,
    fingerprints: Vec<IndexedFileFingerprint>,
    options: FileDriftOptions,
    discovery_policy: DiscoveryPolicy,
    maximum_source_bytes: usize,
    cancelled: Cancel,
}

fn scan_file_drift<Cancel>(input: DriftScanRequest<'_, Cancel>) -> Result<DriftScan, FileDriftError>
where
    Cancel: FnMut() -> bool,
{
    let DriftScanRequest {
        root,
        fingerprints,
        options,
        discovery_policy,
        maximum_source_bytes,
        mut cancelled,
    } = input;
    let source_root = SourceRoot::open_with_policy(root, discovery_policy)
        .map_err(|_| FileDriftError::SourceUnavailable)?;
    let discovery = discovery_limits().map_err(|_| FileDriftError::SourceUnavailable)?;
    let read_limits = crate::source_limits_with_max(maximum_source_bytes)
        .map_err(|_| FileDriftError::SourceUnavailable)?;
    let files = source_root
        .discover_with_cancellation(SourceDiscoveryOptions::new(discovery, &mut cancelled))
        .map_err(|_| FileDriftError::SourceUnavailable)?;
    let indexed_files = u64::try_from(fingerprints.len()).unwrap_or(u64::MAX);
    let live_files = u64::try_from(files.len()).unwrap_or(u64::MAX);
    let mut indexed = fingerprints
        .into_iter()
        .map(|fingerprint| {
            (
                fingerprint.path().as_str().to_owned(),
                fingerprint.content_hash().clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut added = PathBucket::new(options.bucket_limit);
    let mut modified = PathBucket::new(options.bucket_limit);
    for file in files {
        if cancelled() {
            return Err(FileDriftError::Cancelled);
        }
        let path = file.path().as_str();
        let Some(indexed_hash) = indexed.remove(path) else {
            added.push(path);
            continue;
        };
        let changed = if let Some(threshold) = options.threshold_unix_ms {
            let metadata = std::fs::metadata(root.join(path))
                .map_err(|_| FileDriftError::SourceUnavailable)?;
            modification_milliseconds(&metadata) > threshold
        } else {
            let snapshot = source_root
                .read_with_cancellation(
                    file.path(),
                    SourceReadOptions::new(read_limits, &mut cancelled),
                )
                .map_err(|_| FileDriftError::SourceUnavailable)?;
            snapshot.content_hash() != &indexed_hash
        };
        if changed {
            modified.push(path);
        }
    }
    let mut deleted = PathBucket::new(options.bucket_limit);
    for path in indexed.keys() {
        deleted.push(path);
    }
    Ok(DriftScan {
        indexed_files,
        live_files,
        added,
        modified,
        deleted,
    })
}

fn modification_milliseconds(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn map_storage_error(error: &StorageError) -> FileDriftError {
    match error {
        StorageError::CurrentGenerationChanged => FileDriftError::GenerationChanged,
        _ => FileDriftError::StorageUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drift_options_reject_out_of_range_inputs() {
        assert_eq!(
            FileDriftOptions::since(MAXIMUM_UNIX_MILLISECONDS.saturating_add(1)),
            Err(FileDriftError::InvalidOptions)
        );
        assert_eq!(
            FileDriftOptions::default().with_bucket_limit(0),
            Err(FileDriftError::InvalidOptions)
        );
    }
}
