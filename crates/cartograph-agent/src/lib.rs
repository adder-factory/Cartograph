//! Stable project runtime for the Rust/PostgreSQL Cartograph product.
//!
//! This crate owns project identity, freshness, bounded worker selection, and
//! the complete source-to-publication operation. CLI and MCP adapters consume
//! this public service instead of reaching into database or indexer internals.

use std::{
    path::{Path, PathBuf},
    process,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use cartograph_config::DatabaseSettings;
use cartograph_db::{
    CartographDatabase, GenerationContents, NewGeneration, NewProject, ProjectSnapshot,
};
use cartograph_domain::{ContentDigest, ProjectId, ProjectOperation};
use cartograph_extract::{DiscoveryLimits, SourceLimits, SourceRoot};
use cartograph_indexer::{
    IndexerSupervisor, NativePipelineConfig, NativePipelineDeadlines, NativePipelineLimits,
    NativePipelineParallelism, NativePipelineReport, NativeRetainedLimits, PipelineFailure,
    PipelineStage, StageCapacity, SupervisorConfig, SupervisorRequest, build_native_generation,
};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::oneshot;

const PROJECT_IDENTITY_DOMAIN: &[u8] = b"cartograph-v2-project-root-v1";
const SOURCE_REVISION_DOMAIN: &[u8] = b"cartograph-v2-source-revision-v1";
const PROCESS_OWNER_DOMAIN: &[u8] = b"cartograph-v2-process-owner-v1";

const DEFAULT_MAX_FILES: usize = 250_000;
const DEFAULT_MAX_PATH_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_MAX_GENERATION_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_MAX_SUPERVISOR_BYTES: u64 = 6 * 1024 * 1024 * 1024;
const DEFAULT_MAX_SUPERVISOR_TASKS: usize = 128;
const MAX_CONFIGURED_WORKERS: u16 = 16;
const DEFAULT_ITEM_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const DEFAULT_STAGE_TIMEOUT: Duration = Duration::from_secs(90 * 60);
const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const DEFAULT_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_PROGRESS_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DEFAULT_CANCELLATION_GRACE: Duration = Duration::from_secs(10);
const DEFAULT_COPY_TIMEOUT: Duration = Duration::from_secs(3 * 60);
const DEFAULT_LEASE_DURATION: Duration = Duration::from_secs(5 * 60);

/// User-controlled bounds for one full source index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndexOptions {
    max_workers: u16,
    force: bool,
}

impl Default for IndexOptions {
    fn default() -> Self {
        Self {
            max_workers: MAX_CONFIGURED_WORKERS,
            force: false,
        }
    }
}

impl IndexOptions {
    /// Cap the corpus-aware worker selector at a validated value in 1..=16.
    pub const fn with_max_workers(mut self, value: u16) -> Result<Self, ProjectError> {
        if value == 0 || value > MAX_CONFIGURED_WORKERS {
            return Err(ProjectError::InvalidOptions);
        }
        self.max_workers = value;
        Ok(self)
    }

    /// Rebuild and publish even when the exact source manifest is already current.
    #[must_use]
    pub const fn with_force(mut self, force: bool) -> Self {
        self.force = force;
        self
    }
}

/// Fixed-size evidence from the native extraction pipeline.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct NativeIndexMetrics {
    /// Supported files in the indexed source manifest.
    pub files: u64,
    /// Exact bytes read and hashed.
    pub source_bytes: u64,
    /// Extracted code symbols.
    pub symbols: u64,
    /// References resolved to one exact symbol.
    pub resolved_references: u64,
    /// Explicit unresolved evidence retained without guessing.
    pub unresolved_references: u64,
    /// Recoverable parser diagnostics.
    pub diagnostics: u64,
    /// Conservative retained canonical-generation bytes.
    pub modeled_generation_bytes: u64,
}

impl From<NativePipelineReport> for NativeIndexMetrics {
    fn from(report: NativePipelineReport) -> Self {
        Self {
            files: report.discovered_files(),
            source_bytes: report.source_bytes(),
            symbols: report.symbols(),
            resolved_references: report.resolved_references(),
            unresolved_references: report.unresolved_references(),
            diagnostics: report.diagnostics(),
            modeled_generation_bytes: report.modeled_generation_bytes(),
        }
    }
}

/// Terminal result for an index request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IndexReport {
    /// Stable project identity.
    pub project_id: ProjectId,
    /// Visible immutable generation identity.
    pub generation_id: cartograph_domain::GenerationId,
    /// Source-manifest digest used for freshness checks.
    pub source_revision: ContentDigest,
    /// Complete logical generation digest.
    pub content_digest: ContentDigest,
    /// Number of workers selected from the bounded corpus policy.
    pub workers: u16,
    /// False when an identical current source revision made the request a no-op.
    pub published: bool,
    /// Native pipeline metrics, absent for a no-op publication.
    pub native: Option<NativeIndexMetrics>,
}

/// Read-only project state with an honest live-source freshness decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectStatus {
    /// Durable project/generation state, absent before first registration.
    pub snapshot: Option<ProjectSnapshot>,
    /// Current supported-source manifest digest.
    pub live_source_revision: ContentDigest,
    /// True only when the durable generation recorded this exact manifest.
    pub fresh: bool,
}

/// PostgreSQL-backed service for one canonical project root.
pub struct ProjectRuntime {
    root: PathBuf,
    root_identity: String,
    repository_fingerprint: ContentDigest,
    database: CartographDatabase,
}

impl ProjectRuntime {
    /// Open a project and apply the append-only v2 schema after capability proof.
    pub async fn connect(
        project_root: impl AsRef<Path>,
        settings: &DatabaseSettings,
    ) -> Result<Self, ProjectError> {
        let root = std::fs::canonicalize(project_root.as_ref())
            .map_err(|_| ProjectError::ProjectRootUnavailable)?;
        if !root.is_dir() {
            return Err(ProjectError::ProjectRootUnavailable);
        }
        let repository_fingerprint = project_identity_digest(&root);
        let root_identity = format!("project:{}", repository_fingerprint.as_str());
        let pool = cartograph_db::connect(settings)
            .await
            .map_err(|_| ProjectError::DatabaseUnavailable)?;
        let database = CartographDatabase::new(pool, settings.schema().clone());
        database
            .migrate()
            .await
            .map_err(|_| ProjectError::MigrationFailed)?;
        Ok(Self {
            root,
            root_identity,
            repository_fingerprint,
            database,
        })
    }

    /// Public database service for graph/search adapters; SQL internals stay private.
    #[must_use]
    pub const fn database(&self) -> &CartographDatabase {
        &self.database
    }

    /// Privacy-preserving stable identity stored instead of the absolute checkout path.
    #[must_use]
    pub fn root_identity(&self) -> &str {
        &self.root_identity
    }

    /// Inspect durable state and compare it with a complete live source manifest.
    pub async fn status(&self) -> Result<ProjectStatus, ProjectError> {
        let source = source_revision(&self.root)?;
        let snapshot = self
            .database
            .project_snapshot_by_root(&self.root_identity)
            .await
            .map_err(|_| ProjectError::StatusFailed)?;
        let fresh = snapshot
            .as_ref()
            .and_then(|project| project.current.as_ref())
            .is_some_and(|current| current.source_revision == source.digest.as_str());
        Ok(ProjectStatus {
            snapshot,
            live_source_revision: source.digest,
            fresh,
        })
    }

    /// Build and atomically publish one complete generation, or return an exact no-op.
    pub async fn index(&self, options: IndexOptions) -> Result<IndexReport, ProjectError> {
        let source = source_revision(&self.root)?;
        let prior = self
            .database
            .project_snapshot_by_root(&self.root_identity)
            .await
            .map_err(|_| ProjectError::StatusFailed)?;
        if !options.force
            && let Some(current) = prior.as_ref().and_then(|project| project.current.as_ref())
            && current.source_revision == source.digest.as_str()
        {
            return Ok(IndexReport {
                project_id: prior
                    .as_ref()
                    .map(|project| project.project_id.clone())
                    .ok_or(ProjectError::StatusFailed)?,
                generation_id: current.generation_id.clone(),
                source_revision: source.digest,
                content_digest: current.content_digest.clone(),
                workers: select_worker_count(source.files, options.max_workers),
                published: false,
                native: None,
            });
        }

        let workers = select_worker_count(source.files, options.max_workers);
        let project_id = self
            .database
            .register_project(NewProject::new(
                self.root_identity.clone(),
                self.repository_fingerprint.clone(),
            ))
            .await
            .map_err(|_| ProjectError::RegisterFailed)?;
        let staged = self
            .database
            .begin_generation(NewGeneration::new(
                project_id.clone(),
                source.digest.as_str(),
                workers,
            ))
            .await
            .map_err(|_| ProjectError::BeginGenerationFailed)?;
        let generation_id = staged.generation_id().clone();
        let target = cartograph_db::LeaseTarget::new(
            project_id.clone(),
            ProjectOperation::Index,
            Some(generation_id.clone()),
        );
        let supervisor = IndexerSupervisor::new(self.database.clone(), supervisor_config());
        let request = SupervisorRequest::new(target, process_owner(), DEFAULT_LEASE_DURATION);
        let source_root =
            SourceRoot::open(&self.root).map_err(|_| ProjectError::ProjectRootUnavailable)?;
        let pipeline = pipeline_config(workers)?;
        let (report_sender, report_receiver) = oneshot::channel();
        let current = supervisor
            .run(request, move |context| async move {
                let native = build_native_generation(&context.stages(), source_root, pipeline)
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Reduce))?;
                let report = native.report();
                let (facts, _) = native.into_parts();
                report_sender
                    .send(report)
                    .map_err(|_| PipelineFailure::new(PipelineStage::Reduce))?;
                context
                    .progress()
                    .begin_stage(PipelineStage::Copy)
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))?;
                context
                    .prepare_generation(GenerationContents::new(staged, facts))
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
            })
            .await
            .map_err(|_| ProjectError::IndexFailed)?;
        let native = report_receiver
            .await
            .map_err(|_| ProjectError::IndexFailed)?;
        Ok(IndexReport {
            project_id,
            generation_id,
            source_revision: source.digest,
            content_digest: current.content_digest().clone(),
            workers,
            published: true,
            native: Some(native.into()),
        })
    }

    /// Close all PostgreSQL connections owned by this project runtime.
    pub async fn close(self) {
        self.database.close().await;
    }
}

struct SourceRevision {
    digest: ContentDigest,
    files: usize,
}

fn source_revision(root: &Path) -> Result<SourceRevision, ProjectError> {
    let source_root = SourceRoot::open(root).map_err(|_| ProjectError::ProjectRootUnavailable)?;
    let discovery = discovery_limits()?;
    let source_limits = source_limits()?;
    let files = source_root
        .discover(discovery)
        .map_err(|_| ProjectError::SourceScanFailed)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(SOURCE_REVISION_DOMAIN);
    hash_length(&mut hasher, files.len())?;
    for file in &files {
        let snapshot = source_root
            .read(file.path(), source_limits)
            .map_err(|_| ProjectError::SourceScanFailed)?;
        hash_text(&mut hasher, file.path().as_str())?;
        hash_text(&mut hasher, snapshot.content_hash().as_str())?;
    }
    Ok(SourceRevision {
        digest: ContentDigest::from_bytes(*hasher.finalize().as_bytes()),
        files: files.len(),
    })
}

fn project_identity_digest(root: &Path) -> ContentDigest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(PROJECT_IDENTITY_DOMAIN);
    hasher.update(root.as_os_str().as_encoded_bytes());
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

fn process_owner() -> cartograph_db::LeaseOwner {
    static MARKER: OnceLock<String> = OnceLock::new();
    let marker = MARKER.get_or_init(|| {
        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_nanos();
        let mut hasher = blake3::Hasher::new();
        hasher.update(PROCESS_OWNER_DOMAIN);
        hasher.update(&process::id().to_le_bytes());
        hasher.update(&started.to_le_bytes());
        hasher.finalize().to_hex().to_string()
    });
    cartograph_db::LeaseOwner::new(process::id(), marker.clone())
}

fn select_worker_count(files: usize, maximum: u16) -> u16 {
    let corpus = match files {
        0..=32 => 1,
        33..=256 => 2,
        257..=4_096 => 4,
        4_097..=16_384 => 8,
        _ => 16,
    };
    let hardware = std::thread::available_parallelism()
        .ok()
        .and_then(|value| u16::try_from(value.get()).ok())
        .unwrap_or(1);
    corpus.min(maximum).min(hardware.max(1))
}

fn discovery_limits() -> Result<DiscoveryLimits, ProjectError> {
    DiscoveryLimits::new(DEFAULT_MAX_FILES, DEFAULT_MAX_PATH_BYTES)
        .map_err(|_| ProjectError::InvalidOptions)
}

fn source_limits() -> Result<SourceLimits, ProjectError> {
    SourceLimits::new(DEFAULT_MAX_SOURCE_BYTES).map_err(|_| ProjectError::InvalidOptions)
}

fn pipeline_config(workers: u16) -> Result<NativePipelineConfig, ProjectError> {
    let retained =
        NativeRetainedLimits::new(DEFAULT_MAX_MANIFEST_BYTES, DEFAULT_MAX_GENERATION_BYTES)
            .map_err(|_| ProjectError::InvalidOptions)?;
    let queue = usize::from(workers)
        .checked_mul(2)
        .ok_or(ProjectError::InvalidOptions)?;
    let capacity = StageCapacity::new(usize::from(workers), queue);
    let parallelism = NativePipelineParallelism::new(capacity, capacity)
        .map_err(|_| ProjectError::InvalidOptions)?;
    let deadlines = NativePipelineDeadlines::new(
        DEFAULT_ITEM_TIMEOUT,
        DEFAULT_STAGE_TIMEOUT,
        DEFAULT_CANCELLATION_GRACE,
    )
    .map_err(|_| ProjectError::InvalidOptions)?;
    Ok(NativePipelineConfig::new(
        NativePipelineLimits::new(discovery_limits()?, source_limits()?, retained),
        parallelism,
        deadlines,
    ))
}

fn supervisor_config() -> SupervisorConfig {
    SupervisorConfig::new(DEFAULT_OPERATION_TIMEOUT)
        .with_heartbeat_interval(DEFAULT_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(DEFAULT_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(DEFAULT_PROGRESS_TIMEOUT)
        .with_cancellation_grace(DEFAULT_CANCELLATION_GRACE)
        .with_copy_timeout(DEFAULT_COPY_TIMEOUT)
        .with_max_worker_tasks(DEFAULT_MAX_SUPERVISOR_TASKS)
        .with_max_worker_bytes(DEFAULT_MAX_SUPERVISOR_BYTES)
}

fn hash_text(hasher: &mut blake3::Hasher, value: &str) -> Result<(), ProjectError> {
    hash_length(hasher, value.len())?;
    hasher.update(value.as_bytes());
    Ok(())
}

fn hash_length(hasher: &mut blake3::Hasher, value: usize) -> Result<(), ProjectError> {
    let length = u64::try_from(value).map_err(|_| ProjectError::SourceScanFailed)?;
    hasher.update(&length.to_le_bytes());
    Ok(())
}

/// Credential-safe project service failures.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum ProjectError {
    /// Project root is missing, inaccessible, or not a directory.
    #[error("Cartograph project root is unavailable")]
    ProjectRootUnavailable,
    /// Database URL/settings did not yield a live PostgreSQL connection.
    #[error("Cartograph PostgreSQL database is unavailable")]
    DatabaseUnavailable,
    /// Required capabilities or append-only migrations failed.
    #[error("Cartograph PostgreSQL migration failed")]
    MigrationFailed,
    /// A project identity could not be registered safely.
    #[error("Cartograph project registration failed")]
    RegisterFailed,
    /// A generation could not be opened for staging.
    #[error("Cartograph index generation could not start")]
    BeginGenerationFailed,
    /// Live source discovery or hashing failed closed.
    #[error("Cartograph could not build a complete supported-source manifest")]
    SourceScanFailed,
    /// Durable project status could not be read.
    #[error("Cartograph project status is unavailable")]
    StatusFailed,
    /// A bounded extraction/COPY/publication stage failed.
    #[error("Cartograph index operation failed; the previous generation remains visible")]
    IndexFailed,
    /// A caller supplied a zero, overflowing, or unsupported bound.
    #[error("Cartograph index options are invalid")]
    InvalidOptions,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_selector_is_corpus_aware_bounded_and_monotonic() {
        let hardware = std::thread::available_parallelism()
            .ok()
            .and_then(|value| u16::try_from(value.get()).ok())
            .unwrap_or(1)
            .max(1);
        let cases = [(0, 1), (32, 1), (33, 2), (257, 4), (4_097, 8), (16_385, 16)];
        let mut prior = 0;
        for (files, requested) in cases {
            let selected = select_worker_count(files, 16);
            assert_eq!(selected, requested.min(hardware));
            assert!(selected >= prior);
            prior = selected;
        }
        assert_eq!(select_worker_count(1_000_000, 3), 3_u16.min(hardware));
    }

    #[test]
    fn project_identity_is_stable_distinct_and_does_not_expose_the_path() {
        let first = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let second = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let first_path = std::fs::canonicalize(first.path())
            .unwrap_or_else(|error| panic!("canonicalize failed: {error}"));
        let second_path = std::fs::canonicalize(second.path())
            .unwrap_or_else(|error| panic!("canonicalize failed: {error}"));
        let identity = project_identity_digest(&first_path);
        assert_eq!(identity, project_identity_digest(&first_path));
        assert_ne!(identity, project_identity_digest(&second_path));
        assert!(
            !identity
                .as_str()
                .contains(&first_path.to_string_lossy().to_string())
        );
    }

    #[test]
    fn source_revision_changes_with_supported_content_and_ignores_local_state() {
        let directory =
            tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let source = directory.path().join("service.ts");
        std::fs::write(&source, "export const value = 1;\n")
            .unwrap_or_else(|error| panic!("source write failed: {error}"));
        let first = source_revision(directory.path())
            .unwrap_or_else(|error| panic!("source revision failed: {error}"));
        std::fs::create_dir(directory.path().join(".cartograph"))
            .unwrap_or_else(|error| panic!("state dir failed: {error}"));
        std::fs::write(directory.path().join(".cartograph/cache"), "private state")
            .unwrap_or_else(|error| panic!("state write failed: {error}"));
        let ignored = source_revision(directory.path())
            .unwrap_or_else(|error| panic!("source revision failed: {error}"));
        assert_eq!(first.digest, ignored.digest);
        std::fs::write(&source, "export const value = 2;\n")
            .unwrap_or_else(|error| panic!("source write failed: {error}"));
        let changed = source_revision(directory.path())
            .unwrap_or_else(|error| panic!("source revision failed: {error}"));
        assert_ne!(first.digest, changed.digest);
        assert_eq!(changed.files, 1);
    }

    #[test]
    fn invalid_worker_caps_fail_before_any_database_or_source_work() {
        assert_eq!(
            IndexOptions::default().with_max_workers(0),
            Err(ProjectError::InvalidOptions)
        );
        assert_eq!(
            IndexOptions::default().with_max_workers(17),
            Err(ProjectError::InvalidOptions)
        );
    }
}
