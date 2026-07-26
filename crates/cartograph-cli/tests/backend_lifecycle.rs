#![cfg(unix)]

use std::{
    fs,
    net::TcpListener,
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use serde_json::Value;
use tempfile::tempdir;

struct ManagedProcessGuard {
    pid: Option<u32>,
}

impl ManagedProcessGuard {
    fn track(&mut self, pid: u32) {
        self.pid = Some(pid);
    }

    fn disarm(&mut self) {
        self.pid = None;
    }
}

impl Drop for ManagedProcessGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

fn run_backend(project: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cartograph"))
        .arg("backend")
        .args(arguments)
        .current_dir(project)
        .output()
        .unwrap_or_else(|error| panic!("backend command failed to execute: {error}"))
}

fn assert_success(output: &Output, action: &str) {
    assert!(
        output.status.success(),
        "backend {action} failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_failure(output: &Output, action: &str) {
    assert!(
        !output.status.success(),
        "backend {action} unexpectedly succeeded: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn parse_json(output: &Output, action: &str) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "backend {action} emitted invalid JSON: {error}; stdout={}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

fn state_file(project: &Path) -> PathBuf {
    fs::read_dir(project.join(".cartograph/backends"))
        .unwrap_or_else(|error| panic!("backend state directory failed: {error}"))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .unwrap_or_else(|| panic!("backend pid state file was missing"))
}

fn state_pid(project: &Path) -> u32 {
    let state = fs::read(state_file(project))
        .unwrap_or_else(|error| panic!("backend pid state failed: {error}"));
    let state: Value = serde_json::from_slice(&state)
        .unwrap_or_else(|error| panic!("backend pid state JSON failed: {error}"));
    state["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .unwrap_or_else(|| panic!("backend pid state had no valid pid"))
}

fn process_is_runnable(pid: u32) -> bool {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "pid=,stat="])
        .stdin(Stdio::null())
        .output()
        .unwrap_or_else(|error| panic!("backend process inspection failed: {error}"));
    if !output.status.success() {
        return false;
    }
    let rendered = String::from_utf8_lossy(&output.stdout);
    let mut fields = rendered.split_whitespace();
    fields.next() == Some(pid.to_string().as_str())
        && fields.next().is_some_and(|state| !state.starts_with('Z'))
        && fields.next().is_none()
}

#[test]
fn managed_backend_cli_lifecycle_is_identity_checked_and_auditable() {
    let root = tempdir().unwrap_or_else(|error| panic!("fixture root failed: {error}"));
    let marker = root.path().join(".cartograph");
    fs::create_dir(&marker).unwrap_or_else(|error| panic!("fixture marker failed: {error}"));
    let model = root.path().join("fixture.gguf");
    fs::write(&model, b"fixture model")
        .unwrap_or_else(|error| panic!("model fixture failed: {error}"));
    let listener = TcpListener::bind("127.0.0.1:0")
        .unwrap_or_else(|error| panic!("fixture port reservation failed: {error}"));
    let port = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("fixture port lookup failed: {error}"))
        .port();
    drop(listener);

    let binary = root.path().join("fake-llama-server");
    fs::write(
        &binary,
        b"#!/bin/sh\ntrap 'exit 0' TERM INT\nprintf 'fixture backend started\\n'\nwhile :; do sleep 1; done\n",
    )
    .unwrap_or_else(|error| panic!("fixture binary failed: {error}"));
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700))
        .unwrap_or_else(|error| panic!("fixture binary permissions failed: {error}"));
    let config = serde_json::json!({
        "llm": {
            "summarizeLlm": {
                "provider": "openai-compat",
                "endpoint": format!("http://127.0.0.1:{port}/v1"),
                "model": model,
                "concurrency": 2,
                "llamaServerArgs": ["--cache-ram", "64"]
            }
        }
    });
    fs::write(
        marker.join("config.json"),
        serde_json::to_vec(&config)
            .unwrap_or_else(|error| panic!("config fixture encode failed: {error}")),
    )
    .unwrap_or_else(|error| panic!("config fixture write failed: {error}"));
    let project = root.path().to_string_lossy().into_owned();
    let binary = binary.to_string_lossy().into_owned();
    let mut guard = ManagedProcessGuard { pid: None };

    let dry_start = run_backend(
        root.path(),
        &["start", &project, "--bin", &binary, "--dry-run", "--json"],
    );
    assert_success(&dry_start, "start dry-run");
    let dry_start = parse_json(&dry_start, "start dry-run");
    assert_eq!(dry_start["dryRun"], true);
    assert_eq!(dry_start["changed"][0]["reason"], "would start");
    assert!(!marker.join("backends").exists());

    let start = run_backend(root.path(), &["start", &project, "--bin", &binary]);
    assert_success(&start, "start");
    assert!(String::from_utf8_lossy(&start.stdout).contains("started pid"));
    let first_pid = state_pid(root.path());
    guard.track(first_pid);
    assert!(process_is_runnable(first_pid));
    let state_directory = marker.join("backends");
    assert_eq!(
        fs::metadata(&state_directory)
            .unwrap_or_else(|error| panic!("state directory metadata failed: {error}"))
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    let status = run_backend(root.path(), &["status", &project, "--json"]);
    assert_success(&status, "status");
    let status = parse_json(&status, "status");
    assert_eq!(status["rows"][0]["state"], "starting");
    assert_eq!(status["rows"][0]["pidAlive"], true);
    assert_eq!(status["rows"][0]["configDrift"], true);

    let logs = run_backend(
        root.path(),
        &["logs", &project, "--tier", "summarize", "--lines", "10"],
    );
    assert_success(&logs, "logs");
    assert!(String::from_utf8_lossy(&logs.stdout).contains("fixture backend started"));

    let duplicate = run_backend(
        root.path(),
        &["start", &project, "--bin", &binary, "--json"],
    );
    assert_failure(&duplicate, "duplicate start");
    let duplicate = parse_json(&duplicate, "duplicate start");
    assert!(
        duplicate["skipped"][0]["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("already running as pid"))
    );

    let dry_restart = run_backend(
        root.path(),
        &[
            "restart",
            &project,
            "--bin",
            &binary,
            "--tier",
            "summarize",
            "--dry-run",
            "--json",
        ],
    );
    assert_success(&dry_restart, "restart dry-run");
    assert_eq!(
        parse_json(&dry_restart, "restart dry-run")["changed"][0]["reason"],
        "would restart"
    );

    let restart = run_backend(
        root.path(),
        &["restart", &project, "--bin", &binary, "--tier", "summarize"],
    );
    assert_success(&restart, "restart");
    assert!(String::from_utf8_lossy(&restart.stdout).contains("restarted as pid"));
    let second_pid = state_pid(root.path());
    assert_ne!(first_pid, second_pid);
    assert!(!process_is_runnable(first_pid));
    guard.track(second_pid);
    assert!(process_is_runnable(second_pid));

    let stop = run_backend(root.path(), &["stop", &project, "--json"]);
    assert_success(&stop, "stop");
    assert!(
        parse_json(&stop, "stop")["changed"][0]["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("stopped pid"))
    );
    assert!(!process_is_runnable(second_pid));
    guard.disarm();
    assert!(
        !state_directory
            .read_dir()
            .unwrap_or_else(|error| panic!("state directory read failed: {error}"))
            .filter_map(Result::ok)
            .any(|entry| entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json"))
    );

    let stopped = run_backend(root.path(), &["status", &project]);
    assert_success(&stopped, "stopped status");
    assert!(String::from_utf8_lossy(&stopped.stdout).contains("Stopped"));
    let missing_tier = run_backend(
        root.path(),
        &["logs", &project, "--tier", "ask", "--lines", "10"],
    );
    assert_failure(&missing_tier, "missing-tier logs");
    assert!(
        String::from_utf8_lossy(&missing_tier.stdout)
            .contains("No backend matched the requested tier")
    );

    let early_exit = run_backend(
        root.path(),
        &["start", &project, "--bin", "/usr/bin/false", "--json"],
    );
    assert_failure(&early_exit, "early-exit start");
    assert!(
        parse_json(&early_exit, "early-exit start")["skipped"][0]["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("exited during startup"))
    );
}
