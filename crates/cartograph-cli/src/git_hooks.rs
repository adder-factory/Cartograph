use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read as _, Write as _},
    path::{Component, Path, PathBuf},
    process::Command,
};

use tempfile::NamedTempFile;

const SUPPORTED_HOOKS: &[&str] = &["post-merge", "post-checkout", "post-rewrite"];
const BEGIN_MARKER: &str = "# >>> cartograph install-hooks >>>";
const END_MARKER: &str = "# <<< cartograph install-hooks <<<";
const MAXIMUM_HOOK_BYTES: u64 = 1024 * 1024;

pub(super) struct InstallHooksRequest {
    pub project_path: PathBuf,
    pub hooks: Option<String>,
    pub command: Option<String>,
    pub remove: bool,
    pub dry_run: bool,
}

struct HooksTarget {
    directory: PathBuf,
    source: &'static str,
    note: Option<String>,
}

struct HookChange {
    hook: String,
    path: PathBuf,
    status: &'static str,
}

pub(super) fn run_install_hooks(request: &InstallHooksRequest) -> Result<String, String> {
    let hooks = parse_hooks(request.hooks.as_deref())?;
    let command = validate_command(request.command.as_deref())?;
    let root =
        git_path(&request.project_path, &["rev-parse", "--show-toplevel"]).ok_or_else(|| {
            "no Git working tree was found; run this command inside a repository".to_owned()
        })?;
    let root = canonical_directory(Path::new(&root), "Git working tree")?;
    let target = resolve_hooks_target(&root)?;
    if target.source != "default" {
        require_safe_redirected_target(&root, &target.directory)?;
    }
    let mut changes = Vec::new();
    for hook in &hooks {
        changes.push(change_hook(&HookChangeRequest {
            directory: &target.directory,
            hook,
            command: &command,
            remove: request.remove,
            dry_run: request.dry_run,
        })?);
    }

    let default_directory = default_hooks_directory(&root)?;
    if target.source != "default" && default_directory != target.directory {
        for hook in &hooks {
            let cleanup = change_hook(&HookChangeRequest {
                directory: &default_directory,
                hook,
                command: &command,
                remove: true,
                dry_run: request.dry_run,
            })?;
            if cleanup.status == "removed" {
                changes.push(cleanup);
            }
        }
    }

    let verb = if request.dry_run {
        "would change"
    } else if request.remove {
        "updated"
    } else {
        "installed"
    };
    let mut lines = vec![format!("Git hooks {verb} for {}:", root.display())];
    for change in changes {
        lines.push(format!(
            "- {}: {} ({})",
            change.hook,
            change.status,
            change.path.display()
        ));
    }
    if let Some(note) = target.note {
        lines.push(format!("Note: {note}"));
    }
    Ok(format!("{}\n", lines.join("\n")))
}

fn resolve_hooks_target(root: &Path) -> Result<HooksTarget, String> {
    let Some(configured) = git_path(root, &["config", "--path", "--get", "core.hooksPath"]) else {
        return Ok(HooksTarget {
            directory: default_hooks_directory(root)?,
            source: "default",
            note: None,
        });
    };
    let configured_path = Path::new(&configured);
    let absolute = if configured_path.is_absolute() {
        lexical_normalize(configured_path)
    } else {
        lexical_normalize(&root.join(configured_path))
    };
    if absolute.file_name().and_then(|name| name.to_str()) == Some("_")
        && absolute
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some(".husky")
    {
        let directory = absolute
            .parent()
            .ok_or_else(|| "could not resolve Husky hooks directory".to_owned())?
            .to_path_buf();
        return Ok(HooksTarget {
            directory: directory.clone(),
            source: "husky",
            note: Some(format!(
                "core.hooksPath={configured} uses Husky; managed blocks target {}",
                directory.display()
            )),
        });
    }
    Ok(HooksTarget {
        directory: absolute.clone(),
        source: "core.hooksPath",
        note: Some(format!(
            "core.hooksPath={configured}; Git ignores .git/hooks while this is set"
        )),
    })
}

fn default_hooks_directory(root: &Path) -> Result<PathBuf, String> {
    let common = git_path(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .or_else(|| git_path(root, &["rev-parse", "--git-common-dir"]))
    .ok_or_else(|| "could not resolve the Git common directory".to_owned())?;
    let path = Path::new(&common);
    let common = if path.is_absolute() {
        lexical_normalize(path)
    } else {
        lexical_normalize(&root.join(path))
    };
    Ok(common.join("hooks"))
}

fn require_safe_redirected_target(root: &Path, target: &Path) -> Result<(), String> {
    if !target.starts_with(root) {
        return Err(format!(
            "core.hooksPath resolves outside this repository ({}); refusing to write executable hooks",
            target.display()
        ));
    }
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "could not validate the hooks path".to_owned())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "hooks path traverses a symbolic link ({}); refusing to write executable hooks",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err("could not validate the hooks path".to_owned()),
        }
    }
    Ok(())
}

struct HookChangeRequest<'a> {
    directory: &'a Path,
    hook: &'a str,
    command: &'a str,
    remove: bool,
    dry_run: bool,
}

fn change_hook(input: &HookChangeRequest<'_>) -> Result<HookChange, String> {
    let &HookChangeRequest {
        directory,
        hook,
        command,
        remove,
        dry_run,
    } = input;
    let path = directory.join(hook);
    let existing = read_hook(&path)?;
    let (next, status) = if remove {
        match existing.as_deref() {
            None => (None, "missing"),
            Some(existing) => {
                let (stripped, removed) = strip_managed_blocks(existing);
                if removed {
                    (Some(format!("{}\n", stripped.trim_end())), "removed")
                } else {
                    (None, "missing")
                }
            }
        }
    } else {
        let next = compose_hook(existing.as_deref(), command);
        let status = match existing.as_deref() {
            None => "installed",
            Some(value) if value == next => "unchanged",
            Some(_) => "updated",
        };
        (Some(next), status)
    };
    if !dry_run
        && let Some(next) = next
        && existing.as_deref() != Some(next.as_str())
    {
        atomic_write_hook(directory, &path, next.as_bytes())?;
    }
    Ok(HookChange {
        hook: hook.to_owned(),
        path,
        status,
    })
}

fn read_hook(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(format!("could not inspect hook {}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "hook path is not a regular file ({}); refusing to replace it",
            path.display()
        ));
    }
    if metadata.len() > MAXIMUM_HOOK_BYTES {
        return Err(format!(
            "hook exceeds the 1 MiB safety bound ({})",
            path.display()
        ));
    }
    let mut content = String::new();
    File::open(path)
        .and_then(|mut file| file.read_to_string(&mut content))
        .map_err(|_| format!("could not read hook {}", path.display()))?;
    Ok(Some(content))
}

fn atomic_write_hook(directory: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|_| format!("could not create hooks directory {}", directory.display()))?;
    let mut temporary = NamedTempFile::new_in(directory)
        .map_err(|_| format!("could not stage hook {}", path.display()))?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| format!("could not stage hook {}", path.display()))?;
    set_executable(temporary.as_file())?;
    temporary
        .persist(path)
        .map_err(|_| format!("could not install hook {}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn set_executable(file: &File) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(fs::Permissions::from_mode(0o700))
        .map_err(|_| "could not make a Git hook executable".to_owned())
}

#[cfg(not(unix))]
fn set_executable(_file: &File) -> Result<(), String> {
    Ok(())
}

fn compose_hook(existing: Option<&str>, command: &str) -> String {
    let stripped = strip_managed_blocks(existing.unwrap_or_default()).0;
    let prefix = if stripped.trim().is_empty() {
        "#!/bin/sh".to_owned()
    } else {
        stripped.trim_end().to_owned()
    };
    format!("{prefix}\n\n{}\n", render_hook_block(command))
}

fn render_hook_block(command: &str) -> String {
    format!(
        "{BEGIN_MARKER}\ncartograph_command={}\ncartograph_root=\"$(git rev-parse --show-toplevel 2>/dev/null || true)\"\nif [ -n \"$cartograph_root\" ] && [ -d \"$cartograph_root/.cartograph\" ]; then\n  \"$cartograph_command\" sync-if-dirty \"$cartograph_root\" --quiet >/dev/null 2>&1 &\nfi\n{END_MARKER}",
        shell_quote(command)
    )
}

fn strip_managed_blocks(content: &str) -> (String, bool) {
    let mut current = content.to_owned();
    let mut removed = false;
    while let Some(start) = current.find(BEGIN_MARKER) {
        let Some(relative_end) = current[start..].find(END_MARKER) else {
            break;
        };
        let end = start + relative_end + END_MARKER.len();
        let before = current[..start].trim_end_matches([' ', '\t', '\n']);
        let after = current[end..].trim_start_matches('\n');
        current = match (before.is_empty(), after.is_empty()) {
            (true, true) => String::new(),
            (true, false) => after.to_owned(),
            (false, true) => before.to_owned(),
            (false, false) => format!("{before}\n{after}"),
        };
        removed = true;
    }
    (current, removed)
}

fn parse_hooks(raw: Option<&str>) -> Result<Vec<String>, String> {
    let values = raw.map_or_else(
        || {
            SUPPORTED_HOOKS
                .iter()
                .map(|hook| (*hook).to_owned())
                .collect()
        },
        |raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|hook| !hook.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        },
    );
    let values = values.into_iter().collect::<BTreeSet<_>>();
    if values.is_empty()
        || values
            .iter()
            .any(|hook| !SUPPORTED_HOOKS.contains(&hook.as_str()))
    {
        return Err(format!(
            "--hooks must be a comma-separated subset of {}",
            SUPPORTED_HOOKS.join(", ")
        ));
    }
    Ok(values.into_iter().collect())
}

fn validate_command(raw: Option<&str>) -> Result<String, String> {
    let command = raw.unwrap_or("cartograph").trim();
    if command.is_empty() || command.contains(['\0', '\r', '\n']) {
        Err("--command must be one executable name or path".to_owned())
    } else {
        Ok(command.to_owned())
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn git_path(root: &Path, arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() > 16 * 1024 {
        return None;
    }
    let value = std::str::from_utf8(&output.stdout).ok()?.trim();
    (!value.is_empty() && !value.contains('\0')).then(|| value.to_owned())
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|_| format!("could not resolve {label}"))?;
    if path.is_dir() {
        Ok(path)
    } else {
        Err(format!("{label} is not a directory"))
    }
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_block_is_idempotent_and_preserves_foreign_hook_content() {
        let foreign = "#!/bin/sh\necho foreign\n";
        let installed = compose_hook(Some(foreign), "/tmp/cartograph binary");
        let reinstalled = compose_hook(Some(&installed), "/tmp/cartograph binary");
        assert_eq!(installed, reinstalled);
        assert!(installed.contains("echo foreign"));
        assert!(installed.contains("sync-if-dirty"));
        assert!(installed.contains("'/tmp/cartograph binary'"));
        let (removed, did_remove) = strip_managed_blocks(&installed);
        assert!(did_remove);
        assert_eq!(removed.trim(), foreign.trim());
    }

    #[test]
    fn hook_and_command_inputs_fail_closed() {
        assert!(parse_hooks(Some("post-merge,pre-commit")).is_err());
        assert!(validate_command(Some("cartograph\nrm -rf / ")).is_err());
        assert_eq!(
            parse_hooks(None).unwrap_or_else(|error| panic!("default hooks failed: {error}")),
            vec!["post-checkout", "post-merge", "post-rewrite"]
        );
    }
}
