use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use cartograph_agent::{IndexOptions, ProjectRuntime};
use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use thiserror::Error;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{Instant, MissedTickBehavior},
};

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

/// Live filesystem watcher plus periodic missed-event reconciliation for one project runtime.
pub(crate) struct ProjectAutoSync {
    watcher: AutoSyncWatcher,
    cancellation: watch::Sender<bool>,
    task: JoinHandle<()>,
    state: Arc<AutoSyncState>,
}

impl ProjectAutoSync {
    pub(crate) fn start(runtime: Arc<ProjectRuntime>) -> Result<Self, AutoSyncError> {
        let root = runtime.project_root_for_host_operations().to_path_buf();
        let (events, receiver) = mpsc::channel(WATCH_CHANNEL_CAPACITY);
        let (cancellation, cancellation_receiver) = watch::channel(false);
        let state = Arc::new(AutoSyncState::default());
        state.active.store(true, Ordering::Release);
        let watcher = start_watcher(&root, events, state.clone())?;
        let task_state = state.clone();
        let task = tokio::spawn(run_auto_sync(
            runtime,
            receiver,
            cancellation_receiver,
            debounce_from_env(),
            task_state,
        ));
        Ok(Self {
            watcher,
            cancellation,
            task,
            state,
        })
    }

    pub(crate) fn status(&self) -> AutoSyncStatus {
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
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum AutoSyncError {
    #[error("Cartograph native auto-sync watcher is unavailable")]
    WatcherUnavailable,
}

enum AutoSyncWatcher {
    Native(RecommendedWatcher),
    Poll(PollWatcher),
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

fn start_watcher(
    root: &Path,
    events: mpsc::Sender<()>,
    state: Arc<AutoSyncState>,
) -> Result<AutoSyncWatcher, AutoSyncError> {
    let native_config = Config::default().with_follow_symlinks(false);
    if let Ok(mut watcher) = RecommendedWatcher::new(
        watcher_handler(root.to_path_buf(), events.clone(), state.clone()),
        native_config,
    ) && watcher.watch(root, RecursiveMode::Recursive).is_ok()
    {
        return Ok(AutoSyncWatcher::Native(watcher));
    }
    let poll_config = Config::default()
        .with_follow_symlinks(false)
        .with_poll_interval(FALLBACK_POLL_INTERVAL);
    let mut watcher = PollWatcher::new(
        watcher_handler(root.to_path_buf(), events, state),
        poll_config,
    )
    .map_err(|_| AutoSyncError::WatcherUnavailable)?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|_| AutoSyncError::WatcherUnavailable)?;
    Ok(AutoSyncWatcher::Poll(watcher))
}

fn watcher_handler(
    root: PathBuf,
    events: mpsc::Sender<()>,
    state: Arc<AutoSyncState>,
) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    move |result| match result {
        Ok(event) if event_relevant(&root, &event) => {
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

async fn run_auto_sync(
    runtime: Arc<ProjectRuntime>,
    mut events: mpsc::Receiver<()>,
    mut cancellation: watch::Receiver<bool>,
    debounce: Duration,
    state: Arc<AutoSyncState>,
) {
    let mut reconciliation = tokio::time::interval(RECONCILIATION_INTERVAL);
    reconciliation.set_missed_tick_behavior(MissedTickBehavior::Delay);
    reconciliation.tick().await;
    let startup_reconciliation = tokio::time::sleep(STARTUP_RECONCILIATION_DELAY);
    tokio::pin!(startup_reconciliation);
    let mut startup_reconciliation_pending = true;
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
                synchronize(&runtime, &state).await;
            }
            _ = &mut startup_reconciliation, if startup_reconciliation_pending => {
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
    match runtime.status().await {
        Ok(status) if !status.fresh => synchronize(runtime, state).await,
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
            _ = &mut deadline => return false,
            event = events.recv() => {
                if event.is_none() {
                    return true;
                }
                deadline.as_mut().reset(Instant::now() + debounce);
            }
        }
    }
}

async fn synchronize(runtime: &ProjectRuntime, state: &AutoSyncState) {
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
        }
        Err(_) => {
            state.errors.fetch_add(1, Ordering::AcqRel);
        }
    }
}

fn event_relevant(root: &Path, event: &Event) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event
        .paths
        .iter()
        .filter_map(|path| path.strip_prefix(root).ok())
        .any(relevant_relative_path)
}

fn relevant_relative_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() {
        return true;
    }
    if normalized == CONFIG_RELATIVE_PATH || normalized == SCIP_OVERLAY_RELATIVE_PATH {
        return true;
    }
    !normalized.starts_with(".cartograph/")
}

fn debounce_from_env() -> Duration {
    std::env::var(WATCH_DEBOUNCE_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (MINIMUM_DEBOUNCE_MILLIS..=MAXIMUM_DEBOUNCE_MILLIS).contains(value))
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_DEBOUNCE)
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
    use std::{env, path::PathBuf, process, time::SystemTime};

    use cartograph_config::DatabaseSettings;
    use notify::event::AccessKind;
    use sqlx_core::{query::query, sql_str::AssertSqlSafe};

    use super::*;

    #[test]
    fn event_filter_ignores_reads_and_internal_database_churn_but_keeps_config_and_source() {
        let root = PathBuf::from("/tmp/cartograph-watch-fixture");
        let event = |kind, relative: &str| Event {
            kind,
            paths: vec![root.join(relative)],
            attrs: notify::event::EventAttributes::new(),
        };
        assert!(!event_relevant(
            &root,
            &event(EventKind::Access(AccessKind::Any), "src/lib.rs")
        ));
        assert!(!event_relevant(
            &root,
            &event(EventKind::Any, ".cartograph/private-state")
        ));
        assert!(event_relevant(
            &root,
            &event(EventKind::Any, CONFIG_RELATIVE_PATH)
        ));
        assert!(event_relevant(&root, &event(EventKind::Any, "src/lib.rs")));
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
        let watcher = ProjectAutoSync::start(runtime.clone())
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
        let watcher_status = watcher.status();
        assert!(watcher_status.active);
        assert!(watcher_status.events >= 1 || watcher_status.reconciliations >= 1);
        assert!(watcher_status.sync_attempts >= 1);
        assert!(watcher_status.publications >= 1);
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
