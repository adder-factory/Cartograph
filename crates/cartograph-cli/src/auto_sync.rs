use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use cartograph_agent::PipelineStage;
use cartograph_agent::{IndexOptions, ProjectError, ProjectRuntime, ProjectWatchFilter};
use cartograph_domain::ContentDigest;
use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use thiserror::Error;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{Instant, MissedTickBehavior},
};

use crate::error_codes::pipeline_stage_failure_code;

const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(750);
const MINIMUM_DEBOUNCE_MILLIS: u64 = 50;
const MAXIMUM_DEBOUNCE_MILLIS: u64 = 60_000;
const RECONCILIATION_INTERVAL: Duration = Duration::from_secs(30);
const STARTUP_RECONCILIATION_DELAY: Duration = Duration::from_secs(2);
const FALLBACK_POLL_INTERVAL: Duration = Duration::from_secs(2);
const WATCH_CHANNEL_CAPACITY: usize = 1;
const CONFIG_RELATIVE_PATH: &str = ".cartograph/config.json";
const SCIP_OVERLAY_RELATIVE_PATH: &str = ".cartograph/scip/overlay.scip";
const WATCH_DEBOUNCE_ENV: &str = "CARTOGRAPH_WATCH_DEBOUNCE_MS";
const INITIAL_RETRY_INTERVAL: Duration = Duration::from_secs(30);
const MAXIMUM_RETRY_INTERVAL: Duration = Duration::from_mins(15);
const MAXIMUM_AUTOMATIC_ATTEMPTS_PER_REVISION: u8 = 5;

/// Live filesystem watcher plus periodic missed-event reconciliation for one project runtime.
pub(crate) struct ProjectAutoSync {
    watcher: AutoSyncWatcher,
    cancellation: watch::Sender<bool>,
    task: JoinHandle<()>,
    state: Arc<AutoSyncState>,
}

impl ProjectAutoSync {
    pub(crate) fn start(
        runtime: Arc<ProjectRuntime>,
        startup_reconciliation_enabled: bool,
    ) -> Result<Self, AutoSyncError> {
        let root = runtime.project_root_for_host_operations().to_path_buf();
        let (events, receiver) = mpsc::channel(WATCH_CHANNEL_CAPACITY);
        let (cancellation, cancellation_receiver) = watch::channel(false);
        let state = Arc::new(AutoSyncState::default());
        let filter = Arc::new(RwLock::new(
            ProjectWatchFilter::load(&root).map_err(|_| AutoSyncError::InvalidProjectPolicy)?,
        ));
        state.active.store(true, Ordering::Release);
        let watcher = start_watcher(&WatcherContext {
            root,
            events,
            state: state.clone(),
            filter,
        })?;
        let task_state = state.clone();
        let task = tokio::spawn(run_auto_sync(AutoSyncTask {
            runtime,
            events: receiver,
            cancellation: cancellation_receiver,
            debounce: debounce_from_env(),
            state: task_state,
            startup_reconciliation_enabled,
        }));
        Ok(Self {
            watcher,
            cancellation,
            task,
            state,
        })
    }

    pub(crate) fn status(&self) -> AutoSyncStatus {
        let failure = self.state.failure_status();
        AutoSyncStatus {
            active: self.state.active.load(Ordering::Acquire),
            backend: self.watcher.backend(),
            events: self.state.events.load(Ordering::Acquire),
            reconciliations: self.state.reconciliations.load(Ordering::Acquire),
            sync_attempts: self.state.sync_attempts.load(Ordering::Acquire),
            publications: self.state.publications.load(Ordering::Acquire),
            noops: self.state.noops.load(Ordering::Acquire),
            errors: self.state.errors.load(Ordering::Acquire),
            last_success_unix_millis: nonzero(
                self.state.last_success_unix_millis.load(Ordering::Acquire),
            ),
            last_error_code: failure.last_error_code,
            last_failure_at: failure.last_failure_at,
            next_retry_at: failure.next_retry_at,
            failed_revision_attempts: failure.attempts,
            retry_suppressed: failure.retry_suppressed,
        }
    }
}

impl Drop for ProjectAutoSync {
    fn drop(&mut self) {
        self.state.active.store(false, Ordering::Release);
        let _ = self.cancellation.send(true);
        self.task.abort();
    }
}

#[derive(Default)]
struct AutoSyncState {
    active: AtomicBool,
    events: AtomicU64,
    reconciliations: AtomicU64,
    sync_attempts: AtomicU64,
    publications: AtomicU64,
    noops: AtomicU64,
    errors: AtomicU64,
    last_success_unix_millis: AtomicU64,
    failure: RwLock<AutoSyncFailureState>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct AutoSyncFailureStatus {
    last_error_code: Option<&'static str>,
    last_failure_at: Option<u64>,
    next_retry_at: Option<u64>,
    attempts: u8,
    retry_suppressed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct AutoSyncFailureState {
    failed_revision: Option<ContentDigest>,
    status: AutoSyncFailureStatus,
}

impl AutoSyncState {
    fn failure_status(&self) -> AutoSyncFailureStatus {
        self.failure.read().map_or_else(
            |_| AutoSyncFailureStatus::default(),
            |failure| failure.status,
        )
    }

    fn automatic_attempt_allowed(&self, revision: &ContentDigest, now: u64) -> bool {
        self.failure.read().map_or(true, |failure| {
            if failure.failed_revision.as_ref() != Some(revision) {
                return true;
            }
            !failure.status.retry_suppressed
                && failure
                    .status
                    .next_retry_at
                    .is_none_or(|deadline| now >= deadline)
        })
    }

    fn record_index_success(&self) {
        if let Ok(mut failure) = self.failure.write() {
            *failure = AutoSyncFailureState::default();
        }
    }

    fn record_index_failure(&self, revision: ContentDigest, error: ProjectError, now: u64) {
        self.errors.fetch_add(1, Ordering::AcqRel);
        let Ok(mut failure) = self.failure.write() else {
            return;
        };
        let attempts = if failure.failed_revision.as_ref() == Some(&revision) {
            failure.status.attempts.saturating_add(1)
        } else {
            1
        };
        let retry_suppressed = attempts >= MAXIMUM_AUTOMATIC_ATTEMPTS_PER_REVISION;
        let next_retry_at = (!retry_suppressed).then(|| {
            now.saturating_add(
                retry_interval(attempts)
                    .as_millis()
                    .try_into()
                    .unwrap_or(u64::MAX),
            )
        });
        *failure = AutoSyncFailureState {
            failed_revision: Some(revision),
            status: AutoSyncFailureStatus {
                last_error_code: Some(project_error_code(error)),
                last_failure_at: Some(now),
                next_retry_at,
                attempts,
                retry_suppressed,
            },
        };
    }
}

/// Privacy-safe watcher health exposed through status without project paths.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoSyncStatus {
    pub active: bool,
    pub backend: &'static str,
    pub events: u64,
    pub reconciliations: u64,
    pub sync_attempts: u64,
    pub publications: u64,
    pub noops: u64,
    pub errors: u64,
    pub last_success_unix_millis: Option<u64>,
    /// Stable credential-safe code for the latest failed automatic index.
    pub last_error_code: Option<&'static str>,
    /// Unix-millisecond timestamp of the latest failed automatic index.
    pub last_failure_at: Option<u64>,
    /// Unix-millisecond deadline for the next automatic retry of this revision.
    pub next_retry_at: Option<u64>,
    /// Automatic attempts made for the unchanged failed source revision.
    pub failed_revision_attempts: u8,
    /// True after the bounded retry budget is exhausted until source changes.
    pub retry_suppressed: bool,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum AutoSyncError {
    #[error("Cartograph native auto-sync watcher is unavailable")]
    WatcherUnavailable,
    #[error("Cartograph project source policy is invalid")]
    InvalidProjectPolicy,
}

enum AutoSyncWatcher {
    Native(RecommendedWatcher),
    Poll(PollWatcher),
}

#[derive(Clone)]
struct WatcherContext {
    root: PathBuf,
    events: mpsc::Sender<()>,
    state: Arc<AutoSyncState>,
    filter: Arc<RwLock<ProjectWatchFilter>>,
}

impl AutoSyncWatcher {
    fn backend(&self) -> &'static str {
        match self {
            Self::Native(watcher) => {
                let _retained_watcher_bytes = std::mem::size_of_val(watcher);
                "native_events"
            }
            Self::Poll(watcher) => {
                let _retained_watcher_bytes = std::mem::size_of_val(watcher);
                "poll_fallback"
            }
        }
    }
}

fn start_watcher(context: &WatcherContext) -> Result<AutoSyncWatcher, AutoSyncError> {
    let native_config = Config::default().with_follow_symlinks(false);
    if let Ok(mut watcher) =
        RecommendedWatcher::new(watcher_handler((*context).clone()), native_config)
        && watcher
            .watch(&context.root, RecursiveMode::Recursive)
            .is_ok()
    {
        return Ok(AutoSyncWatcher::Native(watcher));
    }
    let poll_config = Config::default()
        .with_follow_symlinks(false)
        .with_poll_interval(FALLBACK_POLL_INTERVAL);
    let mut watcher = PollWatcher::new(watcher_handler((*context).clone()), poll_config)
        .map_err(|_| AutoSyncError::WatcherUnavailable)?;
    watcher
        .watch(&context.root, RecursiveMode::Recursive)
        .map_err(|_| AutoSyncError::WatcherUnavailable)?;
    Ok(AutoSyncWatcher::Poll(watcher))
}

fn watcher_handler(context: WatcherContext) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    let WatcherContext {
        root,
        events,
        state,
        filter,
    } = context;
    move |result| match result {
        Ok(event) if event_relevant(&root, &event, &filter) => {
            if event_changes_config(&root, &event) {
                match ProjectWatchFilter::load(&root) {
                    Ok(reloaded) => match filter.write() {
                        Ok(mut current) => *current = reloaded,
                        Err(_) => {
                            state.errors.fetch_add(1, Ordering::AcqRel);
                        }
                    },
                    Err(_) => {
                        state.errors.fetch_add(1, Ordering::AcqRel);
                    }
                }
            }
            state.events.fetch_add(1, Ordering::AcqRel);
            let _ = events.try_send(());
        }
        Ok(_) => {}
        Err(_) => {
            state.errors.fetch_add(1, Ordering::AcqRel);
            let _ = events.try_send(());
        }
    }
}

struct AutoSyncTask {
    runtime: Arc<ProjectRuntime>,
    events: mpsc::Receiver<()>,
    cancellation: watch::Receiver<bool>,
    debounce: Duration,
    state: Arc<AutoSyncState>,
    startup_reconciliation_enabled: bool,
}

async fn run_auto_sync(input: AutoSyncTask) {
    let AutoSyncTask {
        runtime,
        mut events,
        mut cancellation,
        debounce,
        state,
        startup_reconciliation_enabled,
    } = input;
    let mut reconciliation = tokio::time::interval(RECONCILIATION_INTERVAL);
    reconciliation.set_missed_tick_behavior(MissedTickBehavior::Delay);
    reconciliation.tick().await;
    let startup_reconciliation = tokio::time::sleep(STARTUP_RECONCILIATION_DELAY);
    tokio::pin!(startup_reconciliation);
    let mut startup_reconciliation_pending = startup_reconciliation_enabled;
    loop {
        tokio::select! {
            biased;
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    break;
                }
            }
            event = events.recv() => {
                if event.is_none() || debounce_events(&mut events, &mut cancellation, debounce).await {
                    break;
                }
                synchronize_if_stale(&runtime, &state).await;
            }
            () = &mut startup_reconciliation, if startup_reconciliation_pending => {
                startup_reconciliation_pending = false;
                reconcile(&runtime, &state).await;
            }
            _ = reconciliation.tick() => {
                reconcile(&runtime, &state).await;
            }
        }
    }
    state.active.store(false, Ordering::Release);
}

async fn reconcile(runtime: &ProjectRuntime, state: &AutoSyncState) {
    state.reconciliations.fetch_add(1, Ordering::AcqRel);
    synchronize_if_stale(runtime, state).await;
}

async fn synchronize_if_stale(runtime: &ProjectRuntime, state: &AutoSyncState) {
    match runtime.status().await {
        Ok(status)
            if !status.fresh
                && state.automatic_attempt_allowed(&status.live_source_revision, unix_millis()) =>
        {
            synchronize(runtime, state, status.live_source_revision).await;
        }
        Ok(_) => {}
        Err(_) => {
            state.errors.fetch_add(1, Ordering::AcqRel);
        }
    }
}

async fn debounce_events(
    events: &mut mpsc::Receiver<()>,
    cancellation: &mut watch::Receiver<bool>,
    debounce: Duration,
) -> bool {
    let deadline = tokio::time::sleep(debounce);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    return true;
                }
            }
            () = &mut deadline => return false,
            event = events.recv() => {
                if event.is_none() {
                    return true;
                }
                deadline.as_mut().reset(Instant::now() + debounce);
            }
        }
    }
}

async fn synchronize(runtime: &ProjectRuntime, state: &AutoSyncState, revision: ContentDigest) {
    state.sync_attempts.fetch_add(1, Ordering::AcqRel);
    match runtime.index(IndexOptions::default()).await {
        Ok(report) => {
            if report.published {
                state.publications.fetch_add(1, Ordering::AcqRel);
            } else {
                state.noops.fetch_add(1, Ordering::AcqRel);
            }
            state
                .last_success_unix_millis
                .store(unix_millis(), Ordering::Release);
            state.record_index_success();
        }
        Err(error) => {
            state.record_index_failure(revision, error, unix_millis());
        }
    }
}

fn retry_interval(attempts: u8) -> Duration {
    let exponent = u32::from(attempts.saturating_sub(1)).min(31);
    let multiplier = 1_u32.checked_shl(exponent).unwrap_or(u32::MAX);
    INITIAL_RETRY_INTERVAL
        .saturating_mul(multiplier)
        .min(MAXIMUM_RETRY_INTERVAL)
}

const fn project_error_code(error: ProjectError) -> &'static str {
    match error {
        ProjectError::BeginGenerationFailed => "generation_start_failed",
        ProjectError::SourceScanFailed => "source_scan_failed",
        ProjectError::IndexStageFailed { stage } => pipeline_stage_failure_code(stage),
        ProjectError::IndexLeaseFailed => "lease_failed",
        ProjectError::IndexPublicationFailed => "publication_failed",
        ProjectError::IndexCleanupFailed => "index_cleanup_failed",
        ProjectError::ScipOverlayInvalid => "scip_overlay_invalid",
        ProjectError::RequestCancelled => "request_cancelled",
        _ => "index_failed",
    }
}

fn event_relevant(root: &Path, event: &Event, filter: &RwLock<ProjectWatchFilter>) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event
        .paths
        .iter()
        .filter_map(|path| path.strip_prefix(root).ok())
        .any(|path| relevant_relative_path(path, filter))
}

fn relevant_relative_path(path: &Path, filter: &RwLock<ProjectWatchFilter>) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() {
        return true;
    }
    if normalized == CONFIG_RELATIVE_PATH || normalized == SCIP_OVERLAY_RELATIVE_PATH {
        return true;
    }
    if normalized.starts_with(".cartograph/") {
        return false;
    }
    filter
        .read()
        .map_or(true, |current| current.relevant_relative_path(path))
}

fn event_changes_config(root: &Path, event: &Event) -> bool {
    event.paths.iter().any(|path| {
        path.strip_prefix(root)
            .ok()
            .is_some_and(|relative| relative == Path::new(CONFIG_RELATIVE_PATH))
    })
}

fn debounce_from_env() -> Duration {
    std::env::var(WATCH_DEBOUNCE_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (MINIMUM_DEBOUNCE_MILLIS..=MAXIMUM_DEBOUNCE_MILLIS).contains(value))
        .map_or(DEFAULT_DEBOUNCE, Duration::from_millis)
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(1)
}

const fn nonzero(value: u64) -> Option<u64> {
    if value == 0 { None } else { Some(value) }
}

#[cfg(test)]
mod tests {
    use std::{env, process, time::SystemTime};

    use cartograph_config::DatabaseSettings;
    use notify::event::AccessKind;
    use sqlx_core::{query::query, sql_str::AssertSqlSafe};

    use super::*;

    #[test]
    fn event_filter_ignores_reads_internal_churn_and_default_excludes() {
        let fixture = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("watch filter tempdir failed: {error}"));
        let root = fixture.path().to_path_buf();
        let filter = RwLock::new(
            ProjectWatchFilter::load(&root)
                .unwrap_or_else(|error| panic!("watch filter load failed: {error}")),
        );
        let event = |kind, relative: &str| Event {
            kind,
            paths: vec![root.join(relative)],
            attrs: notify::event::EventAttributes::new(),
        };
        assert!(!event_relevant(
            &root,
            &event(EventKind::Access(AccessKind::Any), "src/lib.rs"),
            &filter,
        ));
        assert!(!event_relevant(
            &root,
            &event(EventKind::Any, ".cartograph/private-state"),
            &filter,
        ));
        assert!(!event_relevant(
            &root,
            &event(EventKind::Any, "target/debug/cartograph"),
            &filter,
        ));
        assert!(!event_relevant(
            &root,
            &event(EventKind::Any, "node_modules/package/index.js"),
            &filter,
        ));
        assert!(event_relevant(
            &root,
            &event(EventKind::Any, CONFIG_RELATIVE_PATH),
            &filter,
        ));
        assert!(event_changes_config(
            &root,
            &event(EventKind::Any, CONFIG_RELATIVE_PATH)
        ));
        assert!(event_relevant(
            &root,
            &event(EventKind::Any, "src/lib.rs"),
            &filter,
        ));
        assert!(event_relevant(
            &root,
            &event(EventKind::Any, "src"),
            &filter,
        ));
    }

    #[test]
    fn invalid_debounce_values_fall_back_without_panicking() {
        assert_eq!(nonzero(0), None);
        assert_eq!(nonzero(1), Some(1));
        assert!(
            (MINIMUM_DEBOUNCE_MILLIS..=MAXIMUM_DEBOUNCE_MILLIS)
                .contains(&u64::try_from(DEFAULT_DEBOUNCE.as_millis()).unwrap_or_default())
        );
    }

    #[test]
    fn unchanged_failed_revision_uses_bounded_backoff_and_new_source_resets_it() {
        let state = AutoSyncState::default();
        let first_revision = ContentDigest::from_bytes([1_u8; 32]);
        let next_revision = ContentDigest::from_bytes([2_u8; 32]);
        let mut now = 1_000_u64;

        assert!(state.automatic_attempt_allowed(&first_revision, now));
        state.record_index_failure(
            first_revision.clone(),
            ProjectError::IndexStageFailed {
                stage: PipelineStage::Reduce,
            },
            now,
        );
        let first = state.failure_status();
        assert_eq!(first.last_error_code, Some("reduce_failed"));
        assert_eq!(first.last_failure_at, Some(now));
        assert_eq!(first.attempts, 1);
        assert!(!first.retry_suppressed);
        assert!(!state.automatic_attempt_allowed(&first_revision, now));
        now = first
            .next_retry_at
            .unwrap_or_else(|| panic!("first retry deadline was missing"));
        assert!(state.automatic_attempt_allowed(&first_revision, now));

        for expected_attempts in 2..=MAXIMUM_AUTOMATIC_ATTEMPTS_PER_REVISION {
            state.record_index_failure(
                first_revision.clone(),
                ProjectError::IndexStageFailed {
                    stage: PipelineStage::Copy,
                },
                now,
            );
            let status = state.failure_status();
            assert_eq!(status.attempts, expected_attempts);
            assert_eq!(status.last_error_code, Some("copy_failed"));
            if expected_attempts < MAXIMUM_AUTOMATIC_ATTEMPTS_PER_REVISION {
                now = status
                    .next_retry_at
                    .unwrap_or_else(|| panic!("retry deadline was missing"));
            }
        }
        let exhausted = state.failure_status();
        assert!(exhausted.retry_suppressed);
        assert_eq!(exhausted.next_retry_at, None);
        assert!(!state.automatic_attempt_allowed(&first_revision, u64::MAX));
        assert!(state.automatic_attempt_allowed(&next_revision, now));

        state.record_index_success();
        assert_eq!(state.failure_status(), AutoSyncFailureStatus::default());
        assert!(state.automatic_attempt_allowed(&first_revision, now));
    }

    #[test]
    fn project_error_codes_are_stage_specific_and_credential_safe() {
        let stage_codes = [
            (PipelineStage::Discover, "discover_failed"),
            (PipelineStage::Read, "read_failed"),
            (PipelineStage::Parse, "parse_failed"),
            (PipelineStage::Resolve, "resolve_failed"),
            (PipelineStage::Overlay, "overlay_failed"),
            (PipelineStage::Reduce, "reduce_failed"),
            (PipelineStage::Copy, "copy_failed"),
            (PipelineStage::RelationalMerge, "relational_merge_failed"),
            (PipelineStage::Bm25, "bm25_failed"),
            (PipelineStage::Vector, "vector_failed"),
            (PipelineStage::Publish, "publication_failed"),
        ];
        for (stage, expected) in stage_codes {
            assert_eq!(
                project_error_code(ProjectError::IndexStageFailed { stage }),
                expected
            );
        }

        let error_codes = [
            (
                ProjectError::BeginGenerationFailed,
                "generation_start_failed",
            ),
            (ProjectError::SourceScanFailed, "source_scan_failed"),
            (ProjectError::IndexLeaseFailed, "lease_failed"),
            (ProjectError::IndexPublicationFailed, "publication_failed"),
            (ProjectError::IndexCleanupFailed, "index_cleanup_failed"),
            (ProjectError::ScipOverlayInvalid, "scip_overlay_invalid"),
            (ProjectError::RequestCancelled, "request_cancelled"),
            (ProjectError::InvalidOptions, "index_failed"),
        ];
        for (error, expected) in error_codes {
            assert_eq!(project_error_code(error), expected);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
    async fn native_watcher_debounces_an_edit_and_publishes_a_fresh_generation() {
        let url = env::var("CARTOGRAPH_TEST_DATABASE_URL")
            .unwrap_or_else(|_| panic!("live watcher database is not configured"));
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let schema = format!("cg_watcher_{}_{}", process::id(), nanos);
        let _schema_guard = cartograph_test_support::TestSchemaGuard::new(&url, schema.clone())
            .unwrap_or_else(|error| panic!("watcher schema guard failed: {error}"));
        let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
            .and_then(|settings| settings.with_schema(&schema))
            .unwrap_or_else(|error| panic!("watcher settings failed: {error}"));
        let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let source = project.path().join("service.rs");
        std::fs::write(&source, "pub fn value() -> u32 { 1 }\n")
            .unwrap_or_else(|error| panic!("watcher fixture failed: {error}"));
        let runtime = Arc::new(
            ProjectRuntime::connect(project.path(), &settings)
                .await
                .unwrap_or_else(|error| panic!("watcher runtime failed: {error}")),
        );
        let first = runtime
            .index(IndexOptions::default().with_history_refresh(false))
            .await
            .unwrap_or_else(|error| panic!("watcher initial index failed: {error}"));
        let watcher = ProjectAutoSync::start(runtime.clone(), true)
            .unwrap_or_else(|error| panic!("watcher start failed: {error}"));
        std::fs::write(&source, "pub fn value() -> u32 { 2 }\n")
            .unwrap_or_else(|error| panic!("watcher edit failed: {error}"));
        let refreshed = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let status = runtime
                    .status()
                    .await
                    .unwrap_or_else(|error| panic!("watcher status failed: {error}"));
                if status.fresh
                    && status.snapshot.as_ref().and_then(|snapshot| {
                        snapshot
                            .current
                            .as_ref()
                            .map(|current| current.generation_id.clone())
                    }) != Some(first.generation_id.clone())
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(
            refreshed.is_ok(),
            "watcher did not refresh within its bound"
        );
        let watcher_status = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let status = watcher.status();
                if status.publications > 0 || status.noops > 0 || status.errors > 0 {
                    break status;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("watcher did not record its terminal outcome within its bound"));
        assert!(watcher_status.active);
        assert!(watcher_status.events >= 1 || watcher_status.reconciliations >= 1);
        assert!(watcher_status.sync_attempts >= 1);
        assert!(
            watcher_status.publications >= 1,
            "watcher did not record its publication: {watcher_status:?}"
        );
        assert_eq!(watcher_status.errors, 0);
        drop(watcher);
        drop(runtime);

        let pool = cartograph_db::connect(&settings)
            .await
            .unwrap_or_else(|error| panic!("watcher cleanup connection failed: {error}"));
        query(AssertSqlSafe(format!(
            "DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"
        )))
        .execute(&pool)
        .await
        .unwrap_or_else(|_| panic!("watcher cleanup failed"));
        pool.close().await;
    }
}
