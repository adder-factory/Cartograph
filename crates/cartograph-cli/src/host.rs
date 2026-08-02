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

pub(crate) struct ProjectDiscoveryRequest<'root> {
    active_root: &'root Path,
    requested_root: Option<&'root str>,
    max_depth: u8,
    cancellation: ProjectCancellation,
}

impl<'root> ProjectDiscoveryRequest<'root> {
    pub(crate) const fn new(
        active_root: &'root Path,
        max_depth: u8,
        cancellation: ProjectCancellation,
    ) -> Self {
        Self {
            active_root,
            requested_root: None,
            max_depth,
            cancellation,
        }
    }

    pub(crate) const fn with_requested_root(mut self, requested_root: Option<&'root str>) -> Self {
        self.requested_root = requested_root;
        self
    }
}

struct ProjectDiscoveryWork {
    root: PathBuf,
    active_root: PathBuf,
    max_depth: u8,
    cancellation: ProjectCancellation,
}

struct DiscoveryDirectoryInput<'input> {
    directory: &'input Path,
    depth: u8,
    max_depth: u8,
    active_root: &'input Path,
    projects: &'input mut Vec<DiscoveredProject>,
}

fn discovery_children(
    input: &mut DiscoveryDirectoryInput<'_>,
) -> Result<Vec<PathBuf>, HostInspectionError> {
    let Ok(entries) = fs::read_dir(input.directory) else {
        return Ok(Vec::new());
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
            input.projects.push(DiscoveredProject {
                path: path_text(input.directory)?,
                active: input.directory == input.active_root,
                config_present: config.is_some(),
                postgres_configured: config.as_ref().is_some_and(postgres_configured),
            });
            continue;
        }
        if input.depth >= input.max_depth
            || name.starts_with('.')
            || SKIPPED_DIRECTORY_NAMES.contains(&name.as_ref())
        {
            continue;
        }
        children.push(path);
    }
    children.sort();
    children.reverse();
    Ok(children)
}

pub(crate) async fn discover_projects(
    request: ProjectDiscoveryRequest<'_>,
) -> Result<DiscoveryReport, HostInspectionError> {
    let ProjectDiscoveryRequest {
        active_root,
        requested_root,
        max_depth,
        cancellation,
    } = request;
    if max_depth == 0 || max_depth > MAX_DISCOVERY_DEPTH {
        return Err(HostInspectionError::InvalidOptions);
    }
    let root = requested_root.map_or_else(|| active_root.to_path_buf(), PathBuf::from);
    let root = fs::canonicalize(root).map_err(|_| HostInspectionError::RootUnavailable)?;
    if !root.is_dir() {
        return Err(HostInspectionError::RootUnavailable);
    }
    let active_root = active_root.to_path_buf();
    let work = ProjectDiscoveryWork {
        root,
        active_root,
        max_depth,
        cancellation,
    };
    tokio::task::spawn_blocking(move || discover_projects_blocking(work))
        .await
        .map_err(|_| HostInspectionError::WorkerFailed)?
}

fn discover_projects_blocking(
    work: ProjectDiscoveryWork,
) -> Result<DiscoveryReport, HostInspectionError> {
    let ProjectDiscoveryWork {
        root,
        active_root,
        max_depth,
        cancellation,
    } = work;
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
        let children = discovery_children(&mut DiscoveryDirectoryInput {
            directory: &directory,
            depth,
            max_depth,
            active_root: &active_root,
            projects: &mut projects,
        })?;
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
    pub(crate) target: &'static str,
    pub(crate) location: &'static str,
    pub(crate) config_present: bool,
    pub(crate) config_valid: bool,
    pub(crate) cartograph_configured: bool,
    pub(crate) config_path: &'static str,
    pub(crate) command_state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) managed_database_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repin_command: Option<String>,
}

#[derive(Clone, Copy)]
struct HostConfigTarget<'path> {
    target: &'static str,
    location: &'static str,
    path: &'path Path,
    config_path: &'static str,
}

impl<'path> HostConfigTarget<'path> {
    const fn local(target: &'static str, path: &'path Path, config_path: &'static str) -> Self {
        Self {
            target,
            location: "local",
            path,
            config_path,
        }
    }

    const fn global(target: &'static str, path: &'path Path, config_path: &'static str) -> Self {
        Self {
            target,
            location: "global",
            path,
            config_path,
        }
    }
}

pub(crate) fn detect_install_targets(
    project_root: &Path,
    location: DiagnosticLocation,
    selected_executable: Option<&Path>,
) -> Vec<InstallTargetDetection> {
    let home = host_home();
    let mut detections = Vec::new();
    if matches!(
        location,
        DiagnosticLocation::Local | DiagnosticLocation::Both
    ) {
        detections.push(detect_toml(
            &HostConfigTarget::local(
                "codex",
                &project_root.join(".codex/config.toml"),
                ".codex/config.toml",
            ),
            selected_executable,
        ));
        detections.push(detect_json(
            &JsonHostConfigTarget {
                config: HostConfigTarget::local(
                    "cursor",
                    &project_root.join(".cursor/mcp.json"),
                    ".cursor/mcp.json",
                ),
                mode: JsonDetection::TopLevel,
                project_root,
            },
            selected_executable,
        ));
        if let Some(home) = home.as_ref() {
            detections.push(detect_json(
                &JsonHostConfigTarget {
                    config: HostConfigTarget::local(
                        "claude",
                        &home.join(".claude.json"),
                        "~/.claude.json (project entry)",
                    ),
                    mode: JsonDetection::ClaudeProject,
                    project_root,
                },
                selected_executable,
            ));
        }
    }
    if matches!(
        location,
        DiagnosticLocation::Global | DiagnosticLocation::Both
    ) && let Some(home) = home.as_ref()
    {
        detections.push(detect_toml(
            &HostConfigTarget::global(
                "codex",
                &home.join(".codex/config.toml"),
                "~/.codex/config.toml",
            ),
            selected_executable,
        ));
        detections.push(detect_json(
            &JsonHostConfigTarget {
                config: HostConfigTarget::global(
                    "cursor",
                    &home.join(".cursor/mcp.json"),
                    "~/.cursor/mcp.json",
                ),
                mode: JsonDetection::TopLevel,
                project_root,
            },
            selected_executable,
        ));
        detections.push(detect_json(
            &JsonHostConfigTarget {
                config: HostConfigTarget::global(
                    "claude",
                    &home.join(".claude.json"),
                    "~/.claude.json",
                ),
                mode: JsonDetection::TopLevel,
                project_root,
            },
            selected_executable,
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
    config: &HostConfigTarget<'_>,
    selected_executable: Option<&Path>,
) -> InstallTargetDetection {
    let HostConfigTarget {
        target,
        location,
        path,
        config_path,
    } = *config;
    let text = bounded_text(path);
    let parsed = text
        .as_deref()
        .and_then(|text| text.parse::<DocumentMut>().ok());
    let configured_command = parsed.as_ref().and_then(|document| {
        document
            .get("mcp_servers")
            .and_then(toml_edit::Item::as_table)
            .and_then(|servers| servers.get("cartograph"))
            .and_then(toml_edit::Item::as_table)
            .and_then(|cartograph| cartograph.get("command"))
            .and_then(toml_edit::Item::as_str)
    });
    let cartograph_configured = configured_command.is_some()
        || parsed.as_ref().is_some_and(|document| {
            document
                .get("mcp_servers")
                .and_then(toml_edit::Item::as_table)
                .is_some_and(|servers| servers.contains_key("cartograph"))
        });
    let managed_database_port = parsed.as_ref().and_then(|document| {
        document
            .get("mcp_servers")
            .and_then(toml_edit::Item::as_table)
            .and_then(|servers| servers.get("cartograph"))
            .and_then(toml_edit::Item::as_table)
            .and_then(|cartograph| cartograph.get("args"))
            .and_then(toml_edit::Item::as_array)
            .and_then(|args| {
                managed_database_port_from_args(args.iter().filter_map(|arg| arg.as_str()))
            })
    });
    registration_detection(&RegistrationDetectionInput {
        target,
        location,
        config_present: text.is_some(),
        config_valid: parsed.is_some(),
        cartograph_configured,
        config_path,
        configured_command,
        managed_database_port,
        selected_executable,
    })
}

#[derive(Clone, Copy)]
enum JsonDetection {
    TopLevel,
    ClaudeProject,
}

#[derive(Clone, Copy)]
struct JsonHostConfigTarget<'path> {
    config: HostConfigTarget<'path>,
    mode: JsonDetection,
    project_root: &'path Path,
}

fn detect_json(
    config: &JsonHostConfigTarget<'_>,
    selected_executable: Option<&Path>,
) -> InstallTargetDetection {
    let JsonHostConfigTarget {
        config:
            HostConfigTarget {
                target,
                location,
                path,
                config_path,
            },
        mode,
        project_root,
    } = *config;
    let text = bounded_text(path);
    let parsed = text
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let project_key = project_root.to_str();
    let configured_value = parsed.as_ref().and_then(|value| match mode {
        JsonDetection::TopLevel => value.pointer("/mcpServers/cartograph"),
        JsonDetection::ClaudeProject => project_key.and_then(|key| {
            value
                .get("projects")
                .and_then(Value::as_object)
                .and_then(|projects| projects.get(key))
                .and_then(|project| project.pointer("/mcpServers/cartograph"))
        }),
    });
    let configured_command = configured_value
        .and_then(Value::as_object)
        .and_then(|entry| entry.get("command"))
        .and_then(Value::as_str);
    let managed_database_port = configured_value
        .and_then(Value::as_object)
        .and_then(|entry| entry.get("args"))
        .and_then(Value::as_array)
        .and_then(|args| managed_database_port_from_args(args.iter().filter_map(Value::as_str)));
    registration_detection(&RegistrationDetectionInput {
        target,
        location,
        config_present: text.is_some(),
        config_valid: parsed.is_some(),
        cartograph_configured: configured_value.is_some(),
        config_path,
        configured_command,
        managed_database_port,
        selected_executable,
    })
}

struct RegistrationDetectionInput<'input> {
    target: &'static str,
    location: &'static str,
    config_present: bool,
    config_valid: bool,
    cartograph_configured: bool,
    config_path: &'static str,
    configured_command: Option<&'input str>,
    managed_database_port: Option<u16>,
    selected_executable: Option<&'input Path>,
}

fn registration_detection(input: &RegistrationDetectionInput<'_>) -> InstallTargetDetection {
    let command_state = registration_command_state(input);
    let repin_command = (command_state == "stale_absolute").then(|| {
        let managed_port = input.managed_database_port.map_or_else(String::new, |port| {
            format!(" --managed-database-port {port}")
        });
        format!(
            "cartograph install --yes --target {} --location {}{managed_port} --project-path <path>",
            input.target, input.location,
        )
    });
    InstallTargetDetection {
        target: input.target,
        location: input.location,
        config_present: input.config_present,
        config_valid: input.config_valid,
        cartograph_configured: input.cartograph_configured,
        config_path: input.config_path,
        command_state,
        managed_database_port: input.managed_database_port,
        repin_command,
    }
}

fn managed_database_port_from_args<'arg>(args: impl IntoIterator<Item = &'arg str>) -> Option<u16> {
    let mut args = args.into_iter();
    while let Some(argument) = args.next() {
        let value = if argument == "--managed-database-port" {
            args.next()
        } else {
            argument.strip_prefix("--managed-database-port=")
        };
        if let Some(port) = value
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port > 0)
        {
            return Some(port);
        }
    }
    None
}

fn registration_command_state(input: &RegistrationDetectionInput<'_>) -> &'static str {
    if !input.config_valid {
        return "unavailable";
    }
    if !input.cartograph_configured {
        return "not_configured";
    }
    let Some(command) = input.configured_command else {
        return "missing_command";
    };
    let command_path = Path::new(command);
    if !command_path.is_absolute() {
        return "path_lookup";
    }
    let Some(selected) = input.selected_executable else {
        return "absolute_unchecked";
    };
    let configured = fs::canonicalize(command_path).unwrap_or_else(|_| command_path.to_path_buf());
    let selected = fs::canonicalize(selected).unwrap_or_else(|_| selected.to_path_buf());
    if configured == selected {
        "current_absolute"
    } else {
        "stale_absolute"
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
        let report = discover_projects_blocking(ProjectDiscoveryWork {
            root: root.path().to_path_buf(),
            active_root: project.clone(),
            max_depth: 4,
            cancellation: ProjectCancellation::new(),
        })
        .unwrap_or_else(|error| panic!("discovery failed: {error}"));
        assert_eq!(report.projects.len(), 1);
        assert_eq!(report.projects[0].path, project.to_string_lossy());
        assert!(report.projects[0].active);
        assert!(!report.truncated);
    }

    #[tokio::test]
    async fn async_discovery_rejects_invalid_roots_depths_and_cancellation() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        assert_eq!(
            discover_projects(ProjectDiscoveryRequest::new(
                root.path(),
                0,
                ProjectCancellation::new(),
            ))
            .await,
            Err(HostInspectionError::InvalidOptions)
        );
        assert_eq!(
            discover_projects(
                ProjectDiscoveryRequest::new(root.path(), 1, ProjectCancellation::new())
                    .with_requested_root(Some("missing-host-root")),
            )
            .await,
            Err(HostInspectionError::RootUnavailable)
        );
        let cancellation = ProjectCancellation::new();
        cancellation.cancel();
        assert_eq!(
            discover_projects(ProjectDiscoveryRequest::new(root.path(), 1, cancellation)).await,
            Err(HostInspectionError::Cancelled)
        );

        fs::create_dir_all(root.path().join("project/.cartograph"))
            .unwrap_or_else(|error| panic!("project marker failed: {error}"));
        fs::write(
            root.path().join("project/.cartograph/config.json"),
            br#"{"database":{"provider":"postgresql"}}"#,
        )
        .unwrap_or_else(|error| panic!("project config failed: {error}"));
        let report = discover_projects(ProjectDiscoveryRequest::new(
            root.path(),
            MAX_DISCOVERY_DEPTH,
            ProjectCancellation::new(),
        ))
        .await
        .unwrap_or_else(|error| panic!("async discovery failed: {error}"));
        assert_eq!(report.projects.len(), 1);
        assert!(report.projects[0].config_present);
        assert!(report.projects[0].postgres_configured);
        assert_eq!(
            report.stats_scope,
            "active_project_status_is_returned_separately; sibling_database_connections_are_not_opened"
        );
    }

    #[test]
    fn host_config_detection_distinguishes_missing_invalid_and_configured_targets() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let codex = root.path().join("config.toml");
        let missing = detect_toml(
            &HostConfigTarget::local("codex", &codex, ".codex/config.toml"),
            None,
        );
        assert!(!missing.config_present);
        assert!(!missing.config_valid);
        assert!(!missing.cartograph_configured);

        fs::write(&codex, "not = [valid")
            .unwrap_or_else(|error| panic!("invalid TOML fixture failed: {error}"));
        let invalid = detect_toml(
            &HostConfigTarget::local("codex", &codex, ".codex/config.toml"),
            None,
        );
        assert!(invalid.config_present);
        assert!(!invalid.config_valid);
        assert!(!invalid.cartograph_configured);

        fs::write(
            &codex,
            "[mcp_servers.cartograph]\ncommand = '/usr/local/bin/cartograph'\nargs = ['serve', '--mcp', '--managed-database-port', '55435']\n",
        )
        .unwrap_or_else(|error| panic!("valid TOML fixture failed: {error}"));
        let configured = detect_toml(
            &HostConfigTarget::local("codex", &codex, ".codex/config.toml"),
            Some(&codex),
        );
        assert!(configured.config_valid);
        assert!(configured.cartograph_configured);
        assert_eq!(configured.command_state, "stale_absolute");
        assert_eq!(configured.managed_database_port, Some(55_435));
        assert!(configured.repin_command.is_some());
        assert!(bounded_text(&codex).is_some());

        let cursor = root.path().join("mcp.json");
        fs::write(
            &cursor,
            br#"{"mcpServers":{"cartograph":{"command":"cartograph","args":["serve","--mcp","--managed-database-port=55436"]}}}"#,
        )
        .unwrap_or_else(|error| panic!("cursor fixture failed: {error}"));
        let cursor_detection = detect_json(
            &JsonHostConfigTarget {
                config: HostConfigTarget::local("cursor", &cursor, ".cursor/mcp.json"),
                mode: JsonDetection::TopLevel,
                project_root: root.path(),
            },
            None,
        );
        assert!(cursor_detection.config_present);
        assert!(cursor_detection.config_valid);
        assert!(cursor_detection.cartograph_configured);
        assert_eq!(cursor_detection.managed_database_port, Some(55_436));

        let claude = root.path().join("claude.json");
        let project_key = root.path().to_string_lossy().into_owned();
        fs::write(
            &claude,
            serde_json::to_vec(&serde_json::json!({
                "projects": {
                    (project_key): {
                        "mcpServers": {"cartograph": {"command": "cartograph"}}
                    }
                }
            }))
            .unwrap_or_else(|error| panic!("Claude fixture encode failed: {error}")),
        )
        .unwrap_or_else(|error| panic!("Claude fixture failed: {error}"));
        let claude_detection = detect_json(
            &JsonHostConfigTarget {
                config: HostConfigTarget::local(
                    "claude",
                    &claude,
                    "~/.claude.json (project entry)",
                ),
                mode: JsonDetection::ClaudeProject,
                project_root: root.path(),
            },
            None,
        );
        assert!(claude_detection.config_valid);
        assert!(claude_detection.cartograph_configured);

        fs::create_dir(root.path().join("not-a-config"))
            .unwrap_or_else(|error| panic!("unsafe config fixture failed: {error}"));
        assert!(bounded_text(&root.path().join("not-a-config")).is_none());
        assert!(bounded_config(&root.path().join("not-a-config")).is_none());
        assert!(host_home().is_some());
    }
}
