use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read as _, Seek as _, SeekFrom},
    path::{Path, PathBuf},
    process::{Command as ProcessCommand, ExitCode, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use cartograph_llm::{
    ProjectLlmTier, ProjectLlmTierConfig, load_exact_project_llm_tier,
    probe_openai_compatible_endpoint,
};
use clap::{Args, Subcommand, ValueEnum};
use futures_util::{StreamExt as _, stream};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tempfile::NamedTempFile;
use url::Url;

const STATE_DIRECTORY: &str = "backends";
const PID_SCHEMA_VERSION: u8 = 2;
const MAXIMUM_STATE_FILE_BYTES: u64 = 1024 * 1024;
const MAXIMUM_STATE_ENTRIES: usize = 256;
const MAXIMUM_LOG_TAIL_BYTES: u64 = 512 * 1024;
const DEFAULT_LOG_LINES: u16 = 80;
const STOP_GRACE: Duration = Duration::from_secs(3);
const STOP_POLL: Duration = Duration::from_millis(100);
const START_CONFIRMATION: Duration = Duration::from_millis(250);
const ENDPOINT_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(any(unix, windows))]
const MAXIMUM_PROCESS_OUTPUT_BYTES: usize = 128 * 1024;

#[derive(Debug, Subcommand)]
pub(super) enum BackendCommand {
    /// Show configured local llama-server backend status.
    Status(StatusArguments),
    /// Start eligible configured local llama-server processes in the background.
    Start(StartArguments),
    /// Restart managed processes so model/concurrency/argument changes take effect.
    Restart(RestartArguments),
    /// Stop only processes recorded and identity-checked by Cartograph.
    Stop(StopArguments),
    /// Tail bounded local logs for configured or orphaned managed processes.
    Logs(LogsArguments),
}

#[derive(Debug, Args)]
pub(super) struct StatusArguments {
    #[arg(default_value = ".")]
    path: PathBuf,
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
pub(super) struct StartArguments {
    #[arg(default_value = ".")]
    path: PathBuf,
    /// llama-server executable path.
    #[arg(long = "bin", default_value = "llama-server")]
    binary: String,
    /// Report eligible processes without spawning them.
    #[arg(long)]
    dry_run: bool,
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
pub(super) struct RestartArguments {
    #[arg(default_value = ".")]
    path: PathBuf,
    #[arg(long = "bin", default_value = "llama-server")]
    binary: String,
    /// Restrict the operation to one stable tier label.
    #[arg(long, value_enum)]
    tier: Option<BackendTier>,
    /// Force-kill a verified managed process after the graceful deadline.
    #[arg(long)]
    force: bool,
    /// Report eligible processes without changing them.
    #[arg(long)]
    dry_run: bool,
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
pub(super) struct StopArguments {
    #[arg(default_value = ".")]
    path: PathBuf,
    /// Force-kill a verified managed process after the graceful deadline.
    #[arg(long)]
    force: bool,
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
pub(super) struct LogsArguments {
    #[arg(default_value = ".")]
    path: PathBuf,
    #[arg(long, value_enum)]
    tier: Option<BackendTier>,
    #[arg(long, default_value_t = DEFAULT_LOG_LINES, value_parser = clap::value_parser!(u16).range(1..=10_000))]
    lines: u16,
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum BackendTier {
    Embed,
    Summarize,
    Local,
    Ask,
    Classify,
    Rerank,
}

impl BackendTier {
    const fn label(self) -> &'static str {
        match self {
            Self::Embed => "embed",
            Self::Summarize => "summarize",
            Self::Local => "local",
            Self::Ask => "ask",
            Self::Classify => "classify",
            Self::Rerank => "rerank",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendSpec {
    id: String,
    labels: Vec<String>,
    endpoint: String,
    model_path: PathBuf,
    host: String,
    port: u16,
    parallel: u16,
    command: String,
    args: Vec<String>,
    externally_managed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum BackendOrigin {
    Config,
    Orphan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum BackendState {
    Running,
    Starting,
    External,
    Stopped,
    MissingModel,
    InvalidState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendPidRecord {
    schema_version: u8,
    pid: u32,
    started_at_unix_ms: u64,
    command: String,
    args: Vec<String>,
    endpoint: String,
    model_path: PathBuf,
    labels: Vec<String>,
    log_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendRow {
    spec: BackendSpec,
    origin: BackendOrigin,
    pid_file_path: PathBuf,
    log_path: PathBuf,
    pid_record: Option<BackendPidRecord>,
    pid_alive: bool,
    endpoint_reachable: bool,
    model_exists: bool,
    state: BackendState,
    state_error: Option<String>,
    config_drift: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendStatusReport {
    project_path: PathBuf,
    state_directory: PathBuf,
    rows: Vec<BackendRow>,
    warnings: Vec<String>,
    unmanaged_reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionDisposition {
    labels: Vec<String>,
    endpoint: String,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendActionReport {
    status: BackendStatusReport,
    changed: Vec<ActionDisposition>,
    skipped: Vec<ActionDisposition>,
    dry_run: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendLogEntry {
    labels: Vec<String>,
    path: PathBuf,
    exists: bool,
    content: String,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendLogsReport {
    status: BackendStatusReport,
    logs: Vec<BackendLogEntry>,
}

enum PidState {
    Missing,
    Valid(BackendPidRecord),
    Invalid(String),
}

struct StatePaths {
    project: PathBuf,
    directory: PathBuf,
}

pub(super) async fn run(command: BackendCommand) -> Result<ExitCode, String> {
    match command {
        BackendCommand::Status(arguments) => {
            let status = backend_status(&arguments.path, "llama-server").await?;
            render_status(&status, arguments.json)?;
            Ok(ExitCode::SUCCESS)
        }
        BackendCommand::Start(arguments) => run_start(arguments).await,
        BackendCommand::Restart(arguments) => run_restart(arguments).await,
        BackendCommand::Stop(arguments) => run_stop(arguments).await,
        BackendCommand::Logs(arguments) => run_logs(arguments).await,
    }
}

fn state_paths(project: &Path) -> Result<StatePaths, String> {
    let project =
        fs::canonicalize(project).map_err(|_| "backend project path is unavailable".to_owned())?;
    let marker = project.join(".cartograph");
    let marker_metadata = fs::symlink_metadata(&marker)
        .map_err(|_| "project is not initialized; .cartograph is missing".to_owned())?;
    if !marker_metadata.is_dir() || marker_metadata.file_type().is_symlink() {
        return Err("project .cartograph path is not a safe directory".to_owned());
    }
    let directory = marker.join(STATE_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err("backend state path is not a safe directory".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("backend state path is unavailable".to_owned()),
    }
    Ok(StatePaths { project, directory })
}

fn ensure_state_directory(paths: &StatePaths) -> Result<(), String> {
    if !paths.directory.exists() {
        fs::create_dir(&paths.directory)
            .map_err(|_| "could not create the backend state directory".to_owned())?;
    }
    let metadata = fs::symlink_metadata(&paths.directory)
        .map_err(|_| "backend state directory is unavailable".to_owned())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("backend state path is not a safe directory".to_owned());
    }
    set_private_directory(&paths.directory)
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "could not secure the backend state directory".to_owned())
}

#[cfg(not(unix))]
fn set_private_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn build_specs(project: &Path, binary: &str) -> Result<Vec<BackendSpec>, String> {
    validate_binary(binary)?;
    let tiers = [
        (ProjectLlmTier::Summarize, "summarize"),
        (ProjectLlmTier::Local, "local"),
        (ProjectLlmTier::Ask, "ask"),
        (ProjectLlmTier::Classify, "classify"),
        (ProjectLlmTier::Embedding, "embed"),
        (ProjectLlmTier::Reranker, "rerank"),
    ];
    let mut specs = BTreeMap::<String, BackendSpec>::new();
    for (tier, label) in tiers {
        let Some(config) =
            load_exact_project_llm_tier(project, tier).map_err(|error| error.to_string())?
        else {
            continue;
        };
        let Some((key, mut spec)) = build_tier_spec(tier, label, &config, binary)? else {
            continue;
        };
        if let Some(existing) = specs.get_mut(&key) {
            if existing.model_path != spec.model_path
                || existing.args != spec.args
                || existing.command != spec.command
            {
                return Err(format!(
                    "LLM tiers sharing {} disagree on model, concurrency, or llamaServerArgs",
                    existing.endpoint
                ));
            }
            existing.labels.append(&mut spec.labels);
            existing.externally_managed |= spec.externally_managed;
        } else {
            specs.insert(key, spec);
        }
    }
    Ok(specs.into_values().collect())
}

fn build_tier_spec(
    tier: ProjectLlmTier,
    label: &str,
    config: &ProjectLlmTierConfig,
    binary: &str,
) -> Result<Option<(String, BackendSpec)>, String> {
    let model_path = PathBuf::from(config.model());
    if !model_path.is_absolute() {
        return Ok(None);
    }
    let Some((endpoint, host, port)) = local_endpoint(config.endpoint())? else {
        return Ok(None);
    };
    validate_passthrough(config.llama_server_args())?;
    let mode_args: &[&str] = match tier {
        ProjectLlmTier::Embedding => &[
            "--embeddings",
            "--batch-size",
            "512",
            "--ubatch-size",
            "512",
        ],
        ProjectLlmTier::Reranker => &["--reranking"],
        ProjectLlmTier::Summarize
        | ProjectLlmTier::Local
        | ProjectLlmTier::Ask
        | ProjectLlmTier::Classify => &[],
    };
    let parallel = config.concurrency().unwrap_or(match tier {
        ProjectLlmTier::Embedding => 4,
        ProjectLlmTier::Ask => 1,
        ProjectLlmTier::Reranker => 2,
        ProjectLlmTier::Summarize | ProjectLlmTier::Local | ProjectLlmTier::Classify => 2,
    });
    let mut args = vec![
        "-m".to_owned(),
        model_path.to_string_lossy().into_owned(),
        "--host".to_owned(),
        host.clone(),
        "--port".to_owned(),
        port.to_string(),
    ];
    args.extend(mode_args.iter().map(|argument| (*argument).to_owned()));
    if !has_parallel_flag(config.llama_server_args()) {
        args.extend(["--parallel".to_owned(), parallel.to_string()]);
    }
    args.extend(config.llama_server_args().iter().cloned());
    let mode = mode_args.join("\0");
    let key = format!("{endpoint}\0{mode}");
    let id = format!("llama-{}", short_hash(&key));
    Ok(Some((
        key,
        BackendSpec {
            id,
            labels: vec![label.to_owned()],
            endpoint,
            model_path,
            host,
            port,
            parallel,
            command: binary.to_owned(),
            args,
            externally_managed: config.externally_managed(),
        },
    )))
}

fn validate_binary(binary: &str) -> Result<(), String> {
    if binary.trim().is_empty() || binary.len() > 4_096 || binary.chars().any(char::is_control) {
        Err("--bin is invalid".to_owned())
    } else {
        Ok(())
    }
}

fn validate_passthrough(arguments: &[String]) -> Result<(), String> {
    const OWNED: &[&str] = &[
        "-m",
        "--model",
        "--model-url",
        "--host",
        "--port",
        "--embeddings",
        "--embedding",
        "--rerank",
        "--reranking",
    ];
    if arguments.iter().any(|argument| {
        OWNED.iter().any(|owned| {
            argument == owned
                || argument
                    .strip_prefix(owned)
                    .is_some_and(|tail| tail.starts_with('='))
        })
    }) {
        Err(
            "llamaServerArgs cannot override Cartograph-owned model, endpoint, or mode flags"
                .to_owned(),
        )
    } else {
        Ok(())
    }
}

fn has_parallel_flag(arguments: &[String]) -> bool {
    arguments.iter().any(|argument| {
        matches!(argument.as_str(), "--parallel" | "-np")
            || argument.starts_with("--parallel=")
            || argument.starts_with("-np=")
    })
}

fn local_endpoint(raw: &str) -> Result<Option<(String, String, u16)>, String> {
    let url = Url::parse(raw).map_err(|_| "configured LLM endpoint is invalid".to_owned())?;
    if url.scheme() != "http" {
        return Ok(None);
    }
    let Some(host) = url.host_str() else {
        return Err("configured LLM endpoint has no host".to_owned());
    };
    if !is_loopback(host) {
        return Ok(None);
    }
    let port = url.port().unwrap_or(80);
    let display_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Ok(Some((
        format!("http://{display_host}:{port}"),
        host.to_owned(),
        port,
    )))
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut output = String::with_capacity(12);
    for byte in digest.iter().take(6) {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

async fn backend_status(project: &Path, binary: &str) -> Result<BackendStatusReport, String> {
    let paths = state_paths(project)?;
    let config_specs = build_specs(&paths.project, binary)?;
    let known = config_specs
        .iter()
        .map(|spec| spec.id.as_str())
        .collect::<BTreeSet<_>>();
    let (orphans, mut warnings) = discover_orphans(&paths.directory, &known)?;
    let config_count = config_specs.len();
    let all = config_specs.into_iter().chain(orphans).collect::<Vec<_>>();
    let directory = paths.directory.clone();
    let mut rows = stream::iter(all.into_iter().enumerate())
        .map(|(index, spec)| {
            let directory = directory.clone();
            async move {
                build_status_row(
                    spec,
                    if index < config_count {
                        BackendOrigin::Config
                    } else {
                        BackendOrigin::Orphan
                    },
                    &directory,
                )
                .await
            }
        })
        .buffer_unordered(16)
        .collect::<Vec<_>>()
        .await;
    rows.sort_by(|left, right| left.spec.id.cmp(&right.spec.id));
    warnings.sort();
    let unmanaged_reason = rows.is_empty().then(|| {
        "No manageable local llama-server tiers. Only loopback openai-compat tiers with absolute GGUF model paths are process-managed.".to_owned()
    });
    Ok(BackendStatusReport {
        project_path: paths.project,
        state_directory: paths.directory,
        rows,
        warnings,
        unmanaged_reason,
    })
}

async fn build_status_row(
    spec: BackendSpec,
    origin: BackendOrigin,
    directory: &Path,
) -> BackendRow {
    let pid_file_path = directory.join(format!("{}.json", spec.id));
    let log_path = directory.join(format!("{}.log", spec.id));
    let pid_state = read_pid_record(&pid_file_path);
    let (pid_record, state_error) = match pid_state {
        PidState::Missing => (None, None),
        PidState::Valid(record) => (Some(record), None),
        PidState::Invalid(message) => (None, Some(message)),
    };
    let pid_alive = pid_record
        .as_ref()
        .is_some_and(|record| process_alive(record.pid));
    let endpoint_reachable =
        probe_openai_compatible_endpoint(&spec.endpoint, ENDPOINT_PROBE_TIMEOUT)
            .await
            .is_ok_and(|probe| probe.openai_compatible);
    let model_exists = safe_regular_file(&spec.model_path);
    let config_drift = pid_record
        .as_ref()
        .is_some_and(|record| record.command != spec.command || record.args != spec.args);
    let state = if state_error.is_some() {
        BackendState::InvalidState
    } else if spec.externally_managed {
        BackendState::External
    } else if !model_exists {
        BackendState::MissingModel
    } else if pid_alive && endpoint_reachable {
        BackendState::Running
    } else if pid_alive {
        BackendState::Starting
    } else if endpoint_reachable {
        BackendState::External
    } else {
        BackendState::Stopped
    };
    BackendRow {
        spec,
        origin,
        pid_file_path,
        log_path,
        pid_record,
        pid_alive,
        endpoint_reachable,
        model_exists,
        state,
        state_error,
        config_drift,
    }
}

fn discover_orphans(
    directory: &Path,
    known: &BTreeSet<&str>,
) -> Result<(Vec<BackendSpec>, Vec<String>), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), Vec::new()));
        }
        Err(_) => return Err("backend state directory cannot be read".to_owned()),
    };
    let mut orphans = Vec::new();
    let mut warnings = Vec::new();
    let mut seen = 0_usize;
    for entry in entries.take(MAXIMUM_STATE_ENTRIES + 1) {
        seen = seen.saturating_add(1);
        if seen > MAXIMUM_STATE_ENTRIES {
            warnings.push(format!(
                "backend state directory exceeds the {}-entry inspection bound",
                MAXIMUM_STATE_ENTRIES
            ));
            break;
        }
        let entry = entry.map_err(|_| "backend state directory cannot be read".to_owned())?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if known.contains(id) {
            continue;
        }
        match read_pid_record(&entry.path()) {
            PidState::Valid(record) => match orphan_spec(id, &record) {
                Ok(spec) => orphans.push(spec),
                Err(message) => warnings.push(format!("ignored orphan state {name}: {message}")),
            },
            PidState::Invalid(message) => {
                warnings.push(format!("invalid backend state {name}: {message}"));
            }
            PidState::Missing => {}
        }
    }
    Ok((orphans, warnings))
}

fn orphan_spec(id: &str, record: &BackendPidRecord) -> Result<BackendSpec, String> {
    let Some((endpoint, host, port)) = local_endpoint(&record.endpoint)? else {
        return Err("orphan endpoint is not loopback HTTP".to_owned());
    };
    Ok(BackendSpec {
        id: id.to_owned(),
        labels: record.labels.clone(),
        endpoint,
        model_path: record.model_path.clone(),
        host,
        port,
        parallel: 0,
        command: record.command.clone(),
        args: record.args.clone(),
        externally_managed: false,
    })
}

fn read_pid_record(path: &Path) -> PidState {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return PidState::Missing,
        Err(_) => return PidState::Invalid("state file is unavailable".to_owned()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAXIMUM_STATE_FILE_BYTES
    {
        return PidState::Invalid("state file is unsafe or oversized".to_owned());
    }
    let mut bytes = Vec::new();
    let result = File::open(path).and_then(|file| {
        file.take(MAXIMUM_STATE_FILE_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)
    });
    if result.is_err() || u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAXIMUM_STATE_FILE_BYTES
    {
        return PidState::Invalid("state file cannot be read safely".to_owned());
    }
    let Ok(record) = serde_json::from_slice::<BackendPidRecord>(&bytes) else {
        return PidState::Invalid("state file is malformed".to_owned());
    };
    if !valid_pid_record(&record) {
        return PidState::Invalid("state file fields are invalid".to_owned());
    }
    PidState::Valid(record)
}

fn valid_pid_record(record: &BackendPidRecord) -> bool {
    record.schema_version == PID_SCHEMA_VERSION
        && record.pid > 0
        && !record.command.is_empty()
        && record.command.len() <= 4_096
        && record.args.len() <= 256
        && record.args.iter().all(|argument| {
            !argument.is_empty()
                && argument.len() <= 4_096
                && !argument.chars().any(char::is_control)
        })
        && !record.endpoint.is_empty()
        && record.labels.len() <= 16
        && !record.labels.is_empty()
        && record.labels.iter().all(|label| {
            !label.is_empty() && label.len() <= 64 && !label.chars().any(char::is_control)
        })
        && record.model_path.is_absolute()
        && record.log_path.is_absolute()
}

fn safe_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        ProcessCommand::new("ps")
            .args(["-p", &pid.to_string(), "-o", "pid="])
            .stdin(Stdio::null())
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && output.stdout.len() <= 64
                    && String::from_utf8_lossy(&output.stdout).trim() == pid.to_string()
            })
    }
    #[cfg(windows)]
    {
        ProcessCommand::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .stdin(Stdio::null())
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && output.stdout.len() <= MAXIMUM_PROCESS_OUTPUT_BYTES
                    && String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
            })
    }
}

fn disposition(row: &BackendRow, reason: impl Into<String>) -> ActionDisposition {
    ActionDisposition {
        labels: row.spec.labels.clone(),
        endpoint: row.spec.endpoint.clone(),
        reason: reason.into(),
    }
}

async fn run_start(arguments: StartArguments) -> Result<ExitCode, String> {
    let before = backend_status(&arguments.path, &arguments.binary).await?;
    let paths = state_paths(&arguments.path)?;
    let mut changed = Vec::new();
    let mut skipped = Vec::new();
    if !arguments.dry_run {
        ensure_state_directory(&paths)?;
    }
    let mut eligible = Vec::new();
    for row in &before.rows {
        if let Some(reason) = start_skip_reason(row) {
            skipped.push(disposition(row, reason));
            continue;
        }
        if arguments.dry_run {
            changed.push(disposition(row, "would start"));
            continue;
        }
        eligible.push(row.clone());
    }
    let started = stream::iter(eligible)
        .map(|row| async move {
            let result = spawn_row(&row).await;
            (row, result)
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    for (row, result) in started {
        match result {
            Ok(pid) => changed.push(disposition(&row, format!("started pid {pid}"))),
            Err(error) => skipped.push(disposition(&row, error)),
        }
    }
    let status = if arguments.dry_run {
        before
    } else {
        backend_status(&arguments.path, &arguments.binary).await?
    };
    let failed = no_usable_backends(&status) || (!arguments.dry_run && changed.is_empty());
    let report = BackendActionReport {
        status,
        changed,
        skipped,
        dry_run: arguments.dry_run,
    };
    render_action("start", &report, arguments.json)?;
    Ok(if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

fn start_skip_reason(row: &BackendRow) -> Option<String> {
    if row.origin == BackendOrigin::Orphan {
        return Some("orphaned state must be reclaimed with backend stop".to_owned());
    }
    if row.state_error.is_some() {
        return Some("invalid pid state must be inspected manually".to_owned());
    }
    if row.spec.externally_managed {
        return Some("tier is explicitly externally managed".to_owned());
    }
    if !row.model_exists {
        return Some("configured GGUF model is missing or unsafe".to_owned());
    }
    if row.pid_alive {
        return Some(format!(
            "already running as pid {}",
            row.pid_record.as_ref().map_or(0, |record| record.pid)
        ));
    }
    if row.endpoint_reachable {
        return Some("endpoint is already held by an external process".to_owned());
    }
    None
}

async fn spawn_row(row: &BackendRow) -> Result<u32, String> {
    let log = open_log_file(&row.log_path)?;
    let stderr = log
        .try_clone()
        .map_err(|_| "could not clone backend log handle".to_owned())?;
    let mut command = ProcessCommand::new(&row.spec.command);
    command
        .args(&row.spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    let mut child = command
        .spawn()
        .map_err(|_| "llama-server process could not be started".to_owned())?;
    let pid = child.id();
    tokio::time::sleep(START_CONFIRMATION).await;
    if let Some(status) = child
        .try_wait()
        .map_err(|_| "could not confirm llama-server startup".to_owned())?
    {
        return Err(format!(
            "llama-server exited during startup with status {status}"
        ));
    }
    if let Err(error) = write_pid_record(row, pid) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(pid)
}

fn open_log_file(path: &Path) -> Result<File, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err("backend log target is not a safe regular file".to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("backend log target is unavailable".to_owned()),
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "backend log cannot be opened".to_owned())
}

fn write_pid_record(row: &BackendRow, pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Err("child process did not report a valid pid".to_owned());
    }
    if fs::symlink_metadata(&row.pid_file_path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err("backend pid target is unsafe".to_owned());
    }
    let record = BackendPidRecord {
        schema_version: PID_SCHEMA_VERSION,
        pid,
        started_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0),
        command: row.spec.command.clone(),
        args: row.spec.args.clone(),
        endpoint: row.spec.endpoint.clone(),
        model_path: row.spec.model_path.clone(),
        labels: row.spec.labels.clone(),
        log_path: row.log_path.clone(),
    };
    let mut bytes = serde_json::to_vec_pretty(&record)
        .map_err(|_| "backend pid state could not be serialized".to_owned())?;
    bytes.push(b'\n');
    let mut temporary = NamedTempFile::new_in(
        row.pid_file_path
            .parent()
            .ok_or_else(|| "backend pid target has no parent".to_owned())?,
    )
    .map_err(|_| "backend pid state could not be staged".to_owned())?;
    use std::io::Write as _;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| "backend pid state could not be written".to_owned())?;
    set_private_file(temporary.as_file())?;
    temporary
        .persist(&row.pid_file_path)
        .map(|_| ())
        .map_err(|_| "backend pid state could not be published".to_owned())
}

#[cfg(unix)]
fn set_private_file(file: &File) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "backend state permissions could not be secured".to_owned())
}

#[cfg(not(unix))]
fn set_private_file(_file: &File) -> Result<(), String> {
    Ok(())
}

async fn run_stop(arguments: StopArguments) -> Result<ExitCode, String> {
    let before = backend_status(&arguments.path, "llama-server").await?;
    let mut changed = Vec::new();
    let mut skipped = Vec::new();
    for row in &before.rows {
        match stop_row(row, arguments.force).await {
            Ok(Some(reason)) => changed.push(disposition(row, reason)),
            Ok(None) => skipped.push(disposition(row, "not managed or not running")),
            Err(error) => skipped.push(disposition(row, error)),
        }
    }
    let status = backend_status(&arguments.path, "llama-server").await?;
    let report = BackendActionReport {
        status,
        changed,
        skipped,
        dry_run: false,
    };
    render_action("stop", &report, arguments.json)?;
    Ok(ExitCode::SUCCESS)
}

async fn stop_row(row: &BackendRow, force: bool) -> Result<Option<String>, String> {
    if row.spec.externally_managed {
        return Ok(None);
    }
    if row.state_error.is_some() {
        return Err("invalid pid state; refusing to signal an unverified process".to_owned());
    }
    let Some(record) = &row.pid_record else {
        return Ok(None);
    };
    if !row.pid_alive {
        remove_pid_file(&row.pid_file_path)?;
        return Ok(Some(format!("removed stale pid state for {}", record.pid)));
    }
    if !process_identity_matches(record) {
        return Err(format!(
            "pid {} is alive but its command identity does not match the recorded backend",
            record.pid
        ));
    }
    signal_process(record.pid, false)?;
    let mut exited = wait_for_exit(record.pid, STOP_GRACE).await;
    if !exited && force {
        signal_process(record.pid, true)?;
        exited = wait_for_exit(record.pid, STOP_GRACE).await;
    }
    if !exited {
        return Err(format!(
            "pid {} did not exit; retry with --force or inspect it manually",
            record.pid
        ));
    }
    remove_pid_file(&row.pid_file_path)?;
    Ok(Some(format!("stopped pid {}", record.pid)))
}

fn process_identity_matches(record: &BackendPidRecord) -> bool {
    let Some(command_line) = process_command_line(record.pid) else {
        return false;
    };
    let binary = Path::new(&record.command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&record.command);
    command_line.contains(binary)
        && command_line.contains(&record.model_path.to_string_lossy().into_owned())
        && Url::parse(&record.endpoint)
            .ok()
            .and_then(|url| url.port_or_known_default())
            .is_some_and(|port| command_line.contains(&port.to_string()))
}

fn process_command_line(pid: u32) -> Option<String> {
    #[cfg(unix)]
    let output = ProcessCommand::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    #[cfg(windows)]
    let output = ProcessCommand::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine"),
        ])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() > MAXIMUM_PROCESS_OUTPUT_BYTES {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .filter(|line| !line.trim().is_empty())
}

fn signal_process(pid: u32, force: bool) -> Result<(), String> {
    #[cfg(unix)]
    let status = ProcessCommand::new("kill")
        .args([if force { "-KILL" } else { "-TERM" }, &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(windows)]
    let status = {
        let mut command = ProcessCommand::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T"]);
        if force {
            command.arg("/F");
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };
    if status.is_ok_and(|status| status.success()) {
        Ok(())
    } else {
        Err(format!("could not signal verified backend pid {pid}"))
    }
}

async fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !process_alive(pid) {
            return true;
        }
        tokio::time::sleep(STOP_POLL).await;
    }
    !process_alive(pid)
}

fn remove_pid_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "backend pid state cannot be inspected".to_owned())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("backend pid state is unsafe; refusing removal".to_owned());
    }
    fs::remove_file(path).map_err(|_| "backend pid state cannot be removed".to_owned())
}

async fn run_restart(arguments: RestartArguments) -> Result<ExitCode, String> {
    let before = backend_status(&arguments.path, &arguments.binary).await?;
    let paths = state_paths(&arguments.path)?;
    let mut changed = Vec::new();
    let mut skipped = Vec::new();
    if !arguments.dry_run {
        ensure_state_directory(&paths)?;
    }
    for row in before.rows.iter().filter(|row| {
        arguments
            .tier
            .is_none_or(|tier| row.spec.labels.iter().any(|label| label == tier.label()))
    }) {
        if row.origin == BackendOrigin::Orphan {
            skipped.push(disposition(
                row,
                "orphaned state must be reclaimed with backend stop",
            ));
            continue;
        }
        if row.spec.externally_managed || (row.endpoint_reachable && row.pid_record.is_none()) {
            skipped.push(disposition(
                row,
                format!(
                    "external process; relaunch manually with {}",
                    render_command(&row.spec)
                ),
            ));
            continue;
        }
        if !row.model_exists || row.state_error.is_some() {
            skipped.push(disposition(row, "backend model or pid state is invalid"));
            continue;
        }
        if arguments.dry_run {
            changed.push(disposition(row, "would restart"));
            continue;
        }
        if row.pid_record.is_some()
            && let Err(error) = stop_row(row, arguments.force).await
        {
            skipped.push(disposition(row, error));
            continue;
        }
        match spawn_row(row).await {
            Ok(pid) => changed.push(disposition(row, format!("restarted as pid {pid}"))),
            Err(error) => skipped.push(disposition(row, error)),
        }
    }
    let status = if arguments.dry_run {
        before
    } else {
        backend_status(&arguments.path, &arguments.binary).await?
    };
    let failed = no_usable_backends(&status) || changed.is_empty();
    let report = BackendActionReport {
        status,
        changed,
        skipped,
        dry_run: arguments.dry_run,
    };
    render_action("restart", &report, arguments.json)?;
    Ok(if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

async fn run_logs(arguments: LogsArguments) -> Result<ExitCode, String> {
    let status = backend_status(&arguments.path, "llama-server").await?;
    let selected = status.rows.iter().filter(|row| {
        arguments
            .tier
            .is_none_or(|tier| row.spec.labels.iter().any(|label| label == tier.label()))
    });
    let logs = selected
        .map(|row| match tail_log(&row.log_path, arguments.lines) {
            Ok(Some(content)) => BackendLogEntry {
                labels: row.spec.labels.clone(),
                path: row.log_path.clone(),
                exists: true,
                content,
                error: None,
            },
            Ok(None) => BackendLogEntry {
                labels: row.spec.labels.clone(),
                path: row.log_path.clone(),
                exists: false,
                content: String::new(),
                error: None,
            },
            Err(error) => BackendLogEntry {
                labels: row.spec.labels.clone(),
                path: row.log_path.clone(),
                exists: false,
                content: String::new(),
                error: Some(error),
            },
        })
        .collect::<Vec<_>>();
    let failed = arguments.tier.is_some() && logs.is_empty();
    let report = BackendLogsReport { status, logs };
    if arguments.json {
        print_json(&report)?;
    } else {
        render_logs(&report);
    }
    Ok(if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

fn tail_log(path: &Path, lines: u16) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("log file is unavailable".to_owned()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("log path is not a safe regular file".to_owned());
    }
    let start = metadata.len().saturating_sub(MAXIMUM_LOG_TAIL_BYTES);
    let mut file = File::open(path).map_err(|_| "log file cannot be opened".to_owned())?;
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "log file cannot be seeked".to_owned())?;
    let mut bytes = Vec::new();
    file.take(MAXIMUM_LOG_TAIL_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| "log file cannot be read".to_owned())?;
    if start > 0
        && let Some(newline) = bytes.iter().position(|byte| *byte == b'\n')
    {
        bytes.drain(..=newline);
    }
    let text = String::from_utf8_lossy(&bytes);
    let selected = text
        .lines()
        .rev()
        .take(usize::from(lines))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Some(selected))
}

fn no_usable_backends(status: &BackendStatusReport) -> bool {
    status.rows.is_empty()
        || status.rows.iter().all(|row| {
            matches!(
                row.state,
                BackendState::MissingModel | BackendState::InvalidState
            )
        })
}

fn render_status(status: &BackendStatusReport, json: bool) -> Result<(), String> {
    if json {
        return print_json(status);
    }
    println!("## cartograph backend status\n");
    render_rows(status);
    Ok(())
}

fn render_action(action: &str, report: &BackendActionReport, json: bool) -> Result<(), String> {
    if json {
        return print_json(report);
    }
    println!("## cartograph backend {action}\n");
    if report.dry_run {
        println!("_Dry run: no process state changed._\n");
    }
    for changed in &report.changed {
        println!(
            "✓ {} at {} — {}",
            changed.labels.join("/"),
            changed.endpoint,
            changed.reason
        );
    }
    for skipped in &report.skipped {
        println!(
            "○ {} at {} — {}",
            skipped.labels.join("/"),
            skipped.endpoint,
            skipped.reason
        );
    }
    if !report.changed.is_empty() || !report.skipped.is_empty() {
        println!();
    }
    render_rows(&report.status);
    Ok(())
}

fn render_rows(status: &BackendStatusReport) {
    if status.rows.is_empty() {
        println!(
            "_No managed backend processes._ {}",
            status.unmanaged_reason.as_deref().unwrap_or_default()
        );
    }
    for row in &status.rows {
        let marker = match row.state {
            BackendState::Running | BackendState::External => "✓",
            BackendState::MissingModel | BackendState::InvalidState => "✗",
            BackendState::Starting | BackendState::Stopped => "○",
        };
        let pid = row
            .pid_record
            .as_ref()
            .map(|record| format!(" pid={}", record.pid))
            .unwrap_or_default();
        println!(
            "{marker} **{}** — {:?} at {}{pid}",
            row.spec.labels.join("/"),
            row.state,
            row.spec.endpoint
        );
        println!("  model: {}", row.spec.model_path.display());
        println!("  log: {}", row.log_path.display());
        println!("  command: {}", render_command(&row.spec));
        if row.config_drift {
            println!("  ⚠ running arguments differ from current config; use backend restart");
        }
        if let Some(error) = &row.state_error {
            println!("  ✗ state: {error}");
        }
    }
    for warning in &status.warnings {
        println!("⚠ {warning}");
    }
}

fn render_logs(report: &BackendLogsReport) {
    println!("## cartograph backend logs\n");
    if report.logs.is_empty() {
        println!("_No backend matched the requested tier._");
    }
    for entry in &report.logs {
        println!(
            "### {} — {}\n",
            entry.labels.join("/"),
            entry.path.display()
        );
        if let Some(error) = &entry.error {
            println!("_Could not read log: {error}_\n");
        } else if !entry.exists || entry.content.is_empty() {
            println!("_No log output yet._\n");
        } else {
            println!("```text\n{}\n```\n", entry.content);
        }
    }
}

fn render_command(spec: &BackendSpec) -> String {
    std::iter::once(spec.command.as_str())
        .chain(spec.args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(value: &str) -> String {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"_./:=+-".contains(&byte))
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', r"'\''"))
    }
}

fn print_json(value: &impl Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .map_err(|_| "backend report could not be serialized".to_owned())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn managed_passthrough_cannot_override_identity_flags() {
        assert!(validate_passthrough(&["--cache-ram".to_owned(), "1024".to_owned()]).is_ok());
        assert!(validate_passthrough(&["--port=9999".to_owned()]).is_err());
        assert!(validate_passthrough(&["-m".to_owned(), "other.gguf".to_owned()]).is_err());
    }

    #[test]
    fn shell_rendering_is_diagnostic_only_and_quotes_spaces() {
        assert_eq!(shell_quote("llama-server"), "llama-server");
        assert_eq!(shell_quote("model one.gguf"), "'model one.gguf'");
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
    }

    #[test]
    fn shared_chat_tiers_merge_and_any_external_declaration_wins() {
        let root = tempdir().unwrap_or_else(|error| panic!("fixture root failed: {error}"));
        let marker = root.path().join(".cartograph");
        fs::create_dir(&marker).unwrap_or_else(|error| panic!("fixture marker failed: {error}"));
        let chat_model = root.path().join("chat.gguf");
        let embed_model = root.path().join("embed.gguf");
        fs::write(&chat_model, b"fixture")
            .unwrap_or_else(|error| panic!("chat model fixture failed: {error}"));
        fs::write(&embed_model, b"fixture")
            .unwrap_or_else(|error| panic!("embed model fixture failed: {error}"));
        let config = serde_json::json!({
            "llm": {
                "summarizeLlm": {
                    "provider": "openai-compat",
                    "endpoint": "http://127.0.0.1:8081",
                    "model": chat_model,
                    "concurrency": 2
                },
                "localLlm": {
                    "provider": "openai-compat",
                    "endpoint": "http://127.0.0.1:8081",
                    "model": chat_model,
                    "concurrency": 2,
                    "externallyManaged": true
                },
                "embeddingLlm": {
                    "provider": "openai-compat",
                    "endpoint": "http://127.0.0.1:8080",
                    "model": embed_model,
                    "concurrency": 4
                }
            }
        });
        fs::write(
            marker.join("config.json"),
            serde_json::to_vec(&config)
                .unwrap_or_else(|error| panic!("config fixture encode failed: {error}")),
        )
        .unwrap_or_else(|error| panic!("config fixture write failed: {error}"));

        let specs = build_specs(root.path(), "llama-server")
            .unwrap_or_else(|error| panic!("backend specs failed: {error}"));
        assert_eq!(specs.len(), 2);
        let chat = specs
            .iter()
            .find(|spec| spec.port == 8081)
            .unwrap_or_else(|| panic!("chat spec missing"));
        assert_eq!(chat.labels, ["summarize", "local"]);
        assert!(chat.externally_managed);
        let embedding = specs
            .iter()
            .find(|spec| spec.port == 8080)
            .unwrap_or_else(|| panic!("embedding spec missing"));
        assert!(
            embedding
                .args
                .iter()
                .any(|argument| argument == "--embeddings")
        );
    }
}
