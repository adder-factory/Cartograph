use std::{
    fs,
    path::{Path, PathBuf},
};

use cartograph_agent::ProjectCancellation;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use toml_edit::DocumentMut;

const MAX_DISCOVERY_DEPTH: u8 = 10;
const MAX_DISCOVERY_DIRECTORIES: usize = 50_000;
const MAX_DISCOVERED_PROJECTS: usize = 1_000;
const MAX_HOST_CONFIG_BYTES: u64 = 1024 * 1024;

const SKIPPED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    "vendor",
    "__tests__",
    "__mocks__",
    "fixtures",
    "fixture",
    "test-beds",
    "test-bed",
];

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum HostInspectionError {
    #[error("host inspection options are invalid")]
    InvalidOptions,
    #[error("host inspection root is unavailable")]
    RootUnavailable,
    #[error("host inspection worker failed")]
    WorkerFailed,
    #[error("host inspection was cancelled")]
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveredProject {
    path: String,
    active: bool,
    config_present: bool,
    postgres_configured: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryReport {
    root: String,
    max_depth: u8,
    directories_visited: usize,
    projects: Vec<DiscoveredProject>,
    truncated: bool,
    stats_scope: &'static str,
}

pub(crate) async fn discover_projects(
    active_root: &Path,
    requested_root: Option<&str>,
    max_depth: u8,
    cancellation: ProjectCancellation,
) -> Result<DiscoveryReport, HostInspectionError> {
    if max_depth == 0 || max_depth > MAX_DISCOVERY_DEPTH {
        return Err(HostInspectionError::InvalidOptions);
    }
    let root = requested_root.map_or_else(|| active_root.to_path_buf(), PathBuf::from);
    let root = fs::canonicalize(root).map_err(|_| HostInspectionError::RootUnavailable)?;
    if !root.is_dir() {
        return Err(HostInspectionError::RootUnavailable);
    }
    let active_root = active_root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        discover_projects_blocking(root, active_root, max_depth, cancellation)
    })
    .await
    .map_err(|_| HostInspectionError::WorkerFailed)?
}

fn discover_projects_blocking(
    root: PathBuf,
    active_root: PathBuf,
    max_depth: u8,
    cancellation: ProjectCancellation,
) -> Result<DiscoveryReport, HostInspectionError> {
    let mut stack = vec![(root.clone(), 0_u8)];
    let mut projects = Vec::new();
    let mut visited = 0_usize;
    let mut truncated = false;
    while let Some((directory, depth)) = stack.pop() {
        if cancellation.is_cancelled() {
            return Err(HostInspectionError::Cancelled);
        }
        if visited >= MAX_DISCOVERY_DIRECTORIES || projects.len() >= MAX_DISCOVERED_PROJECTS {
            truncated = true;
            break;
        }
        visited = visited.saturating_add(1);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        let mut children = Vec::new();
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let path = entry.path();
            if name == ".cartograph" {
                let config = bounded_config(&path.join("config.json"));
                projects.push(DiscoveredProject {
                    path: path_text(&directory)?,
                    active: directory == active_root,
                    config_present: config.is_some(),
                    postgres_configured: config.as_ref().is_some_and(postgres_configured),
                });
                continue;
            }
            if depth >= max_depth
                || name.starts_with('.')
                || SKIPPED_DIRECTORY_NAMES.contains(&name.as_ref())
            {
                continue;
            }
            children.push(path);
        }
        children.sort();
        children.reverse();
        for child in children {
            stack.push((child, depth.saturating_add(1)));
        }
    }
    projects.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(DiscoveryReport {
        root: path_text(&root)?,
        max_depth,
        directories_visited: visited,
        projects,
        truncated,
        stats_scope: "active_project_status_is_returned_separately; sibling_database_connections_are_not_opened",
    })
}

fn bounded_config(path: &Path) -> Option<Value> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_HOST_CONFIG_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn postgres_configured(value: &Value) -> bool {
    matches!(
        value.pointer("/database/provider").and_then(Value::as_str),
        Some("postgres" | "postgresql")
    )
}

fn path_text(path: &Path) -> Result<String, HostInspectionError> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or(HostInspectionError::RootUnavailable)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiagnosticLocation {
    Global,
    Local,
    Both,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallTargetDetection {
    target: &'static str,
    location: &'static str,
    config_present: bool,
    config_valid: bool,
    cartograph_configured: bool,
    config_path: &'static str,
}

pub(crate) fn detect_install_targets(
    project_root: &Path,
    location: DiagnosticLocation,
) -> Vec<InstallTargetDetection> {
    let home = host_home();
    let mut detections = Vec::new();
    if matches!(
        location,
        DiagnosticLocation::Local | DiagnosticLocation::Both
    ) {
        detections.push(detect_toml(
            "codex",
            "local",
            &project_root.join(".codex/config.toml"),
            ".codex/config.toml",
        ));
        detections.push(detect_json(
            "cursor",
            "local",
            &project_root.join(".cursor/mcp.json"),
            ".cursor/mcp.json",
            JsonDetection::TopLevel,
            project_root,
        ));
        if let Some(home) = home.as_ref() {
            detections.push(detect_json(
                "claude",
                "local",
                &home.join(".claude.json"),
                "~/.claude.json (project entry)",
                JsonDetection::ClaudeProject,
                project_root,
            ));
        }
    }
    if matches!(
        location,
        DiagnosticLocation::Global | DiagnosticLocation::Both
    ) && let Some(home) = home.as_ref()
    {
        detections.push(detect_toml(
            "codex",
            "global",
            &home.join(".codex/config.toml"),
            "~/.codex/config.toml",
        ));
        detections.push(detect_json(
            "cursor",
            "global",
            &home.join(".cursor/mcp.json"),
            "~/.cursor/mcp.json",
            JsonDetection::TopLevel,
            project_root,
        ));
        detections.push(detect_json(
            "claude",
            "global",
            &home.join(".claude.json"),
            "~/.claude.json",
            JsonDetection::TopLevel,
            project_root,
        ));
    }
    detections
}

fn host_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .and_then(|path| fs::canonicalize(path).ok())
        .filter(|path| path.is_dir())
}

fn bounded_text(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_HOST_CONFIG_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn detect_toml(
    target: &'static str,
    location: &'static str,
    path: &Path,
    config_path: &'static str,
) -> InstallTargetDetection {
    let text = bounded_text(path);
    let parsed = text
        .as_deref()
        .and_then(|text| text.parse::<DocumentMut>().ok());
    InstallTargetDetection {
        target,
        location,
        config_present: text.is_some(),
        config_valid: parsed.is_some(),
        cartograph_configured: parsed.as_ref().is_some_and(|document| {
            document
                .get("mcp_servers")
                .and_then(toml_edit::Item::as_table)
                .is_some_and(|servers| servers.contains_key("cartograph"))
        }),
        config_path,
    }
}

#[derive(Clone, Copy)]
enum JsonDetection {
    TopLevel,
    ClaudeProject,
}

fn detect_json(
    target: &'static str,
    location: &'static str,
    path: &Path,
    config_path: &'static str,
    mode: JsonDetection,
    project_root: &Path,
) -> InstallTargetDetection {
    let text = bounded_text(path);
    let parsed = text
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let project_key = project_root.to_str();
    let configured = parsed.as_ref().is_some_and(|value| match mode {
        JsonDetection::TopLevel => value.pointer("/mcpServers/cartograph").is_some(),
        JsonDetection::ClaudeProject => project_key.is_some_and(|key| {
            value
                .get("projects")
                .and_then(Value::as_object)
                .and_then(|projects| projects.get(key))
                .and_then(|project| project.pointer("/mcpServers/cartograph"))
                .is_some()
        }),
    });
    InstallTargetDetection {
        target,
        location,
        config_present: text.is_some(),
        config_valid: parsed.is_some(),
        cartograph_configured: configured,
        config_path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_config_detection_never_needs_a_database_secret() {
        assert!(postgres_configured(&serde_json::json!({
            "database": {"provider": "postgres"}
        })));
        assert!(!postgres_configured(&serde_json::json!({})));
    }

    #[test]
    fn discovery_is_bounded_and_skips_fixture_projects() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let project = root.path().join("apps/real");
        let fixture = root.path().join("fixtures/not-real");
        fs::create_dir_all(project.join(".cartograph"))
            .unwrap_or_else(|error| panic!("project marker failed: {error}"));
        fs::create_dir_all(fixture.join(".cartograph"))
            .unwrap_or_else(|error| panic!("fixture marker failed: {error}"));
        let report = discover_projects_blocking(
            root.path().to_path_buf(),
            project.clone(),
            4,
            ProjectCancellation::new(),
        )
        .unwrap_or_else(|error| panic!("discovery failed: {error}"));
        assert_eq!(report.projects.len(), 1);
        assert_eq!(report.projects[0].path, project.to_string_lossy());
        assert!(report.projects[0].active);
        assert!(!report.truncated);
    }
}
