use std::{
    cmp::Ordering,
    env, fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    time::Duration,
};

use futures_util::StreamExt as _;
use reqwest::Client;
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use tempfile::{NamedTempFile, TempPath};
use tokio::process::Command;

const REMOTE: &str = "https://github.com/adder-factory/cartograph.git";
const RELEASE_BASE: &str = "https://github.com/adder-factory/cartograph/releases/download";
const RELEASES_URL: &str = "https://github.com/adder-factory/cartograph/releases";
const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/adder-factory/cartograph/releases/latest";
const MAXIMUM_TAG_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAXIMUM_CHECKSUM_BYTES: usize = 1024 * 1024;
const MAXIMUM_BINARY_BYTES: usize = 200 * 1024 * 1024;
const LOWER_HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";
const HIGH_NIBBLE_SHIFT: u8 = 4;
const LOW_NIBBLE_MASK: u8 = 0x0f;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpgradeReport {
    status: &'static str,
    current_version: String,
    latest_version: Option<String>,
    apply_requested: bool,
    applied: bool,
    message: String,
    next_steps: Vec<String>,
}

pub(super) fn render(report: &UpgradeReport) -> String {
    let mut output = format!("{}\n", report.message);
    for step in &report.next_steps {
        output.push_str("- ");
        output.push_str(step);
        output.push('\n');
    }
    output
}

pub(super) fn succeeded(report: &UpgradeReport) -> bool {
    report.status != "blocked" && report.status != "unknown"
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<PrereleasePart>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PrereleasePart {
    Numeric(u64),
    Text(String),
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
            .then_with(|| compare_prerelease(&self.prerelease, &other.prerelease))
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub(super) async fn run_upgrade(apply: bool) -> UpgradeReport {
    let current_text = env!("CARGO_PKG_VERSION").to_owned();
    let Some(current) = parse_version(&current_text) else {
        return report_unknown(current_text, apply, "running version is not valid semver");
    };
    let latest_text = match latest_version().await {
        Ok(version) => version,
        Err(message) => return report_unknown(current_text, apply, &message),
    };
    let Some(latest) = parse_version(&latest_text) else {
        return report_unknown(current_text, apply, "published version is not valid semver");
    };
    if current >= latest {
        return UpgradeReport {
            status: "current",
            current_version: current_text.clone(),
            latest_version: Some(latest_text),
            apply_requested: apply,
            applied: false,
            message: format!("Cartograph {current_text} is current."),
            next_steps: vec!["No update action is needed.".to_owned()],
        };
    }
    if !apply {
        return UpgradeReport {
            status: "update_available",
            current_version: current_text.clone(),
            latest_version: Some(latest_text.clone()),
            apply_requested: false,
            applied: false,
            message: format!("Cartograph {current_text} -> {latest_text} is available."),
            next_steps: vec![
                "Run `cartograph upgrade --apply` to install the verified native release."
                    .to_owned(),
                "Restart MCP clients after updating so they stop using the old process.".to_owned(),
            ],
        };
    }
    match apply_release(&latest_text).await {
        Ok(path) => UpgradeReport {
            status: "updated",
            current_version: current_text,
            latest_version: Some(latest_text.clone()),
            apply_requested: true,
            applied: true,
            message: format!(
                "Installed the checksum-verified Cartograph {latest_text} binary at {}.",
                path.display()
            ),
            next_steps: vec![
                "Re-run `cartograph install` in registered projects to repin MCP hosts.".to_owned(),
                "Restart MCP clients so every connection uses the new binary.".to_owned(),
                "Run `cartograph --version` from a new process to verify the update.".to_owned(),
            ],
        },
        Err(message) => UpgradeReport {
            status: "blocked",
            current_version: current_text,
            latest_version: Some(latest_text),
            apply_requested: true,
            applied: false,
            message,
            next_steps: vec![
                "Download the matching native asset and SHA256SUMS from the GitHub release."
                    .to_owned(),
                "Verify the checksum before replacing the current executable.".to_owned(),
            ],
        },
    }
}

fn report_unknown(current: String, apply: bool, reason: &str) -> UpgradeReport {
    UpgradeReport {
        status: "unknown",
        current_version: current,
        latest_version: None,
        apply_requested: apply,
        applied: false,
        message: format!("Could not resolve the latest Cartograph release: {reason}."),
        next_steps: vec![format!("Check {RELEASES_URL} manually.")],
    }
}

async fn latest_version() -> Result<String, String> {
    match latest_git_tag().await {
        Ok(version) => Ok(version),
        Err(git_error) => latest_release_api().await.map_err(|api_error| {
            format!("git tag lookup failed ({git_error}); GitHub API failed ({api_error})")
        }),
    }
}

async fn latest_git_tag() -> Result<String, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new("git")
            .args(["ls-remote", "--tags", "--refs", REMOTE, "v*"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "git ls-remote timed out".to_owned())?
    .map_err(|_| "git ls-remote could not start".to_owned())?;
    if !output.status.success() || output.stdout.len() > MAXIMUM_TAG_OUTPUT_BYTES {
        return Err("git ls-remote failed or exceeded its output bound".to_owned());
    }
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| "git ls-remote returned non-UTF-8 output".to_owned())?;
    text.lines()
        .filter_map(|line| line.split_once("refs/tags/v").map(|(_, version)| version))
        .filter_map(|version| parse_version(version).map(|parsed| (parsed, version.to_owned())))
        .max_by(|left, right| left.0.cmp(&right.0))
        .map(|(_, version)| version)
        .ok_or_else(|| "git ls-remote returned no semver release tags".to_owned())
}

async fn latest_release_api() -> Result<String, String> {
    let client = http_client()?;
    let bytes = fetch_bounded(&client, LATEST_RELEASE_API, MAXIMUM_CHECKSUM_BYTES).await?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "GitHub API returned invalid JSON".to_owned())?;
    let tag = value
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .and_then(|tag| tag.strip_prefix('v'))
        .ok_or_else(|| "GitHub API response has no release tag".to_owned())?;
    parse_version(tag)
        .map(|_| tag.to_owned())
        .ok_or_else(|| "GitHub release tag is not semver".to_owned())
}

async fn apply_release(version: &str) -> Result<PathBuf, String> {
    let executable =
        env::current_exe().map_err(|_| "could not resolve the running executable".to_owned())?;
    let executable = fs::canonicalize(&executable)
        .map_err(|_| "could not resolve the running executable".to_owned())?;
    let asset = asset_name()?;
    let client = http_client()?;
    let checksums_url = format!("{RELEASE_BASE}/v{version}/SHA256SUMS");
    let asset_url = format!("{RELEASE_BASE}/v{version}/{asset}");
    let checksums = fetch_bounded(&client, &checksums_url, MAXIMUM_CHECKSUM_BYTES).await?;
    let expected = checksum_for_asset(&checksums, asset)?;
    let binary = fetch_bounded(&client, &asset_url, MAXIMUM_BINARY_BYTES).await?;
    let actual = sha256_hex(&binary);
    if actual != expected {
        return Err("downloaded native binary failed SHA-256 verification".to_owned());
    }
    install_binary(&executable, &binary, version)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push(char::from(
            LOWER_HEX_DIGITS[usize::from(byte >> HIGH_NIBBLE_SHIFT)],
        ));
        output.push(char::from(
            LOWER_HEX_DIGITS[usize::from(byte & LOW_NIBBLE_MASK)],
        ));
    }
    output
}

fn http_client() -> Result<Client, String> {
    cartograph_llm::ensure_tls_crypto_provider()
        .map_err(|_| "could not initialize the HTTPS client".to_owned())?;
    Client::builder()
        .user_agent(format!("cartograph/{}", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(2 * 60))
        .build()
        .map_err(|_| "could not initialize the HTTPS client".to_owned())
}

async fn fetch_bounded(client: &Client, url: &str, maximum: usize) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "release download failed".to_owned())?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > maximum as u64)
    {
        return Err("release download was unavailable or exceeded its size bound".to_owned());
    }
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "release download failed".to_owned())?;
        let next = output
            .len()
            .checked_add(chunk.len())
            .filter(|length| *length <= maximum)
            .ok_or_else(|| "release download exceeded its size bound".to_owned())?;
        output
            .try_reserve(next.saturating_sub(output.len()))
            .map_err(|_| "release download exceeded local memory limits".to_owned())?;
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn checksum_for_asset(checksums: &[u8], asset: &str) -> Result<String, String> {
    let text = std::str::from_utf8(checksums).map_err(|_| "SHA256SUMS is not UTF-8".to_owned())?;
    let matches = text
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let digest = fields.next()?;
            let name = fields.next()?.trim_start_matches('*');
            (name == asset && fields.next().is_none()).then_some(digest)
        })
        .collect::<Vec<_>>();
    if matches.len() != 1
        || matches[0].len() != 64
        || !matches[0].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("SHA256SUMS has no unique valid entry for this platform".to_owned());
    }
    Ok(matches[0].to_ascii_lowercase())
}

fn install_binary(executable: &Path, bytes: &[u8], version: &str) -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        let launcher_path = env::var_os("PATH");
        install_binary_unix(InstallBinaryInput {
            executable,
            bytes,
            version,
            launcher_path: launcher_path.as_deref(),
        })
    }

    #[cfg(not(unix))]
    {
        install_binary_in_place(executable, bytes, version)?;
        Ok(executable.to_path_buf())
    }
}

#[cfg(unix)]
struct InstallBinaryInput<'input> {
    executable: &'input Path,
    bytes: &'input [u8],
    version: &'input str,
    launcher_path: Option<&'input std::ffi::OsStr>,
}

#[cfg(unix)]
fn install_binary_unix(input: InstallBinaryInput<'_>) -> Result<PathBuf, String> {
    if let Some(layout) = VersionedInstallLayout::detect(input.executable, input.version)? {
        return layout.install(input);
    }

    let InstallBinaryInput {
        executable,
        bytes,
        version,
        ..
    } = input;
    install_binary_in_place(executable, bytes, version)?;
    Ok(executable.to_path_buf())
}

fn install_binary_in_place(executable: &Path, bytes: &[u8], version: &str) -> Result<(), String> {
    let directory = executable
        .parent()
        .ok_or_else(|| "running executable has no parent directory".to_owned())?;
    let mut staged = NamedTempFile::new_in(directory)
        .map_err(|_| "could not stage the native update beside the executable".to_owned())?;
    staged
        .write_all(bytes)
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|_| "could not write the staged native update".to_owned())?;
    set_executable(staged.as_file())?;
    let staged = staged.into_temp_path();
    verify_staged_binary(staged.as_ref(), version)?;
    replace_executable(staged, executable)
}

#[cfg(unix)]
struct VersionedInstallLayout {
    install_root: PathBuf,
    release_name: String,
    release_root: PathBuf,
    executable: PathBuf,
}

#[cfg(unix)]
impl VersionedInstallLayout {
    fn detect(executable: &Path, version: &str) -> Result<Option<Self>, String> {
        let Some(bin_directory) = executable.parent() else {
            return Ok(None);
        };
        let Some(previous_release) = bin_directory.parent() else {
            return Ok(None);
        };
        let Some(versions_directory) = previous_release.parent() else {
            return Ok(None);
        };
        let Some(install_root) = versions_directory.parent() else {
            return Ok(None);
        };
        let is_versioned_layout = bin_directory.file_name().is_some_and(|name| name == "bin")
            && versions_directory
                .file_name()
                .is_some_and(|name| name == "versions")
            && previous_release
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.strip_prefix('v').and_then(parse_version).is_some());
        if !is_versioned_layout {
            return Ok(None);
        }
        let release_name = version_release_directory(version)?;
        let release_root = versions_directory.join(&release_name);
        let executable = release_root.join("bin").join(
            executable
                .file_name()
                .ok_or_else(|| "running executable has no file name".to_owned())?,
        );
        Ok(Some(Self {
            install_root: install_root.to_path_buf(),
            release_name,
            release_root,
            executable,
        }))
    }

    fn install(self, input: InstallBinaryInput<'_>) -> Result<PathBuf, String> {
        let InstallBinaryInput {
            executable: prior_executable,
            bytes,
            version,
            launcher_path,
        } = input;
        ensure_real_directory(&self.release_root)?;
        let bin_directory = self
            .executable
            .parent()
            .ok_or_else(|| "versioned executable has no parent directory".to_owned())?;
        ensure_real_directory(bin_directory)?;
        install_binary_in_place(&self.executable, bytes, version)?;

        let current_target = Path::new("versions").join(&self.release_name);
        atomic_repoint_symlink(
            &self.install_root.join("current"),
            &current_target,
            "current release",
        )?;
        let launcher_target = self.install_root.join("current/bin/cartograph");
        if let Some(path) = launcher_path {
            repoint_matching_path_launchers_in(path, prior_executable, &launcher_target)?;
        }
        Ok(self.executable)
    }
}

#[cfg(unix)]
fn version_release_directory(version: &str) -> Result<String, String> {
    let version = version.strip_prefix('v').unwrap_or(version);
    if version.is_empty()
        || version.len() > 128
        || parse_version(version).is_none()
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err("published version is not a safe install directory name".to_owned());
    }
    Ok(format!("v{version}"))
}

#[cfg(unix)]
fn ensure_real_directory(directory: &Path) -> Result<(), String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("versioned update destination is not a real directory".to_owned());
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err("could not inspect the versioned update destination".to_owned());
        }
        Err(_) => {}
    }
    fs::create_dir_all(directory)
        .map_err(|_| "could not create the versioned update destination".to_owned())?;
    let metadata = fs::symlink_metadata(directory)
        .map_err(|_| "could not inspect the versioned update destination".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("versioned update destination is not a real directory".to_owned());
    }
    Ok(())
}

#[cfg(unix)]
fn repoint_matching_path_launchers_in(
    path: &std::ffi::OsStr,
    prior_executable: &Path,
    launcher_target: &Path,
) -> Result<(), String> {
    const MAXIMUM_PATH_DIRECTORIES: usize = 128;
    let prior_executable = fs::canonicalize(prior_executable)
        .map_err(|_| "could not resolve the prior Cartograph executable".to_owned())?;
    for directory in env::split_paths(&path).take(MAXIMUM_PATH_DIRECTORIES) {
        let launcher = directory.join("cartograph");
        let Ok(metadata) = fs::symlink_metadata(&launcher) else {
            continue;
        };
        if !metadata.file_type().is_symlink()
            || fs::canonicalize(&launcher).ok().as_deref() != Some(prior_executable.as_path())
        {
            continue;
        }
        atomic_repoint_symlink(&launcher, launcher_target, "Cartograph launcher")?;
    }
    Ok(())
}

#[cfg(unix)]
fn atomic_repoint_symlink(link: &Path, target: &Path, label: &str) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    if let Ok(metadata) = fs::symlink_metadata(link)
        && !metadata.file_type().is_symlink()
    {
        return Err(format!("{label} path is not a symbolic link"));
    }
    let parent = link
        .parent()
        .ok_or_else(|| format!("{label} path has no parent directory"))?;
    let staging = tempfile::Builder::new()
        .prefix(".cartograph-link-")
        .tempdir_in(parent)
        .map_err(|_| format!("could not stage the {label} link"))?;
    let staged_link = staging.path().join("link");
    symlink(target, &staged_link).map_err(|_| format!("could not stage the {label} link"))?;
    fs::rename(&staged_link, link).map_err(|_| format!("could not replace the {label} link"))
}

fn verify_staged_binary(path: &Path, version: &str) -> Result<(), String> {
    let output = ProcessCommand::new(path)
        .arg("--version")
        .output()
        .map_err(|_| "downloaded native binary could not start".to_owned())?;
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or_default();
    if output.status.success() && stdout.split_whitespace().any(|part| part == version) {
        Ok(())
    } else {
        Err("downloaded native binary did not report the expected version".to_owned())
    }
}

#[cfg(unix)]
fn set_executable(file: &fs::File) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(fs::Permissions::from_mode(0o755))
        .map_err(|_| "could not mark the native update executable".to_owned())
}

#[cfg(not(unix))]
fn set_executable(_file: &fs::File) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn replace_executable(staged: TempPath, executable: &Path) -> Result<(), String> {
    staged
        .persist(executable)
        .map_err(|_| "could not atomically replace the running executable".to_owned())
}

#[cfg(windows)]
fn replace_executable(staged: TempPath, executable: &Path) -> Result<(), String> {
    let backup = executable.with_extension("exe.cartograph-old");
    let _ = fs::remove_file(&backup);
    fs::rename(executable, &backup)
        .map_err(|_| "could not move the running executable aside".to_owned())?;
    match staged.persist(executable) {
        Ok(_) => Ok(()),
        Err(_) => {
            let _ = fs::rename(&backup, executable);
            Err(
                "could not replace the running executable; the prior binary was restored"
                    .to_owned(),
            )
        }
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const fn asset_name() -> Result<&'static str, String> {
    Ok("cartograph-darwin-arm64")
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const fn asset_name() -> Result<&'static str, String> {
    Ok("cartograph-darwin-x64")
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const fn asset_name() -> Result<&'static str, String> {
    Ok("cartograph-linux-arm64")
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const fn asset_name() -> Result<&'static str, String> {
    Ok("cartograph-linux-x64")
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const fn asset_name() -> Result<&'static str, String> {
    Ok("cartograph-windows-x64.exe")
}

#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
fn asset_name() -> Result<&'static str, String> {
    Err("no native release asset exists for this operating system and architecture".to_owned())
}

fn parse_version(raw: &str) -> Option<Version> {
    let raw = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
    let raw = raw.split_once('+').map_or(raw, |(core, _)| core);
    let (core, prerelease) = raw.split_once('-').map_or((raw, ""), |parts| parts);
    let mut numbers = core.split('.');
    let major = numbers.next()?.parse().ok()?;
    let minor = numbers.next()?.parse().ok()?;
    let patch = numbers.next()?.parse().ok()?;
    if numbers.next().is_some() {
        return None;
    }
    let prerelease = if prerelease.is_empty() {
        Vec::new()
    } else {
        prerelease
            .split('.')
            .map(|part| {
                part.parse::<u64>()
                    .map(PrereleasePart::Numeric)
                    .unwrap_or_else(|_| PrereleasePart::Text(part.to_ascii_lowercase()))
            })
            .collect()
    };
    Some(Version {
        major,
        minor,
        patch,
        prerelease,
    })
}

fn compare_prerelease(left: &[PrereleasePart], right: &[PrereleasePart]) -> Ordering {
    match (left.is_empty(), right.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (false, false) => {}
    }
    for (left, right) in left.iter().zip(right) {
        let ordering = match (left, right) {
            (PrereleasePart::Numeric(left), PrereleasePart::Numeric(right)) => left.cmp(right),
            (PrereleasePart::Numeric(_), PrereleasePart::Text(_)) => Ordering::Less,
            (PrereleasePart::Text(_), PrereleasePart::Numeric(_)) => Ordering::Greater,
            (PrereleasePart::Text(left), PrereleasePart::Text(right)) => left.cmp(right),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read as _, Write as _},
        net::TcpListener,
        thread,
        time::Duration,
    };

    use super::*;

    const FIXTURE_REQUEST_BYTES: usize = 8 * 1_024;

    #[test]
    fn semver_ordering_handles_stable_and_prerelease_tags() {
        let parse = |value| {
            parse_version(value).unwrap_or_else(|| panic!("invalid version fixture: {value}"))
        };
        assert!(parse("2.0.0") > parse("2.0.0-rc.2"));
        assert!(parse("2.0.0-rc.10") > parse("2.0.0-rc.2"));
        assert!(parse("2.0.0-alpha.1") > parse("1.1.33"));
        assert!(parse("2.1.0") > parse("2.0.99"));
    }

    #[test]
    fn checksum_parser_requires_one_exact_asset_entry() {
        let sums = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  cartograph-darwin-arm64\n";
        assert_eq!(
            checksum_for_asset(sums, "cartograph-darwin-arm64"),
            Ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned())
        );
        assert!(checksum_for_asset(sums, "cartograph-linux-x64").is_err());
        let duplicate = [sums.as_slice(), sums.as_slice()].concat();
        assert!(checksum_for_asset(&duplicate, "cartograph-darwin-arm64").is_err());
        assert!(checksum_for_asset(b"not utf8: \xff", "cartograph-darwin-arm64").is_err());
        assert_eq!(
            sha256_hex(b"cartograph"),
            "122eee0b90506d8a158a312f2f45814f50cb70d98668ba27289764d98af85141"
        );
    }

    #[test]
    fn report_and_semver_failures_remain_actionable_without_claiming_success() {
        let report = report_unknown("2.0.0".to_owned(), true, "fixture lookup failed");
        assert!(!succeeded(&report));
        let rendered = render(&report);
        assert!(rendered.contains("fixture lookup failed"));
        assert!(rendered.contains(RELEASES_URL));

        for invalid in ["", "2", "2.0", "2.0.0.1", "two.0.0"] {
            assert!(parse_version(invalid).is_none(), "accepted {invalid}");
        }
        let parse = |value| {
            parse_version(value).unwrap_or_else(|| panic!("invalid version fixture: {value}"))
        };
        assert_eq!(parse("v2.0.0+build.7"), parse("2.0.0"));
        assert!(parse("2.0.0-alpha") > parse("2.0.0-1"));
        assert!(parse("2.0.0-alpha.2") > parse("2.0.0-alpha.1"));
        assert!(parse("2.0.0-alpha.1") > parse("2.0.0-alpha"));
        assert!(asset_name().is_ok());
    }

    #[tokio::test]
    async fn release_download_is_status_content_length_and_stream_bounded() {
        let (url, request) = spawn_http_fixture(
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata".to_owned(),
        );
        let client = http_client().unwrap_or_else(|error| panic!("HTTP client failed: {error}"));
        assert_eq!(
            fetch_bounded(&client, &url, 4)
                .await
                .unwrap_or_else(|error| panic!("bounded fetch failed: {error}")),
            b"data"
        );
        request
            .join()
            .unwrap_or_else(|_| panic!("download fixture panicked"));

        for response in [
            "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n",
        ] {
            let (url, request) = spawn_http_fixture(response.to_owned());
            assert!(fetch_bounded(&client, &url, 4).await.is_err());
            request
                .join()
                .unwrap_or_else(|_| panic!("rejected download fixture panicked"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn staged_native_update_is_executable_verified_and_atomically_replaced() {
        use std::os::unix::fs::PermissionsExt as _;

        let root =
            tempfile::tempdir().unwrap_or_else(|error| panic!("upgrade fixture failed: {error}"));
        let executable = root.path().join("cartograph");
        fs::write(&executable, "#!/bin/sh\necho 'cartograph 1.0.0'\n")
            .unwrap_or_else(|error| panic!("old executable fixture failed: {error}"));
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .unwrap_or_else(|error| panic!("old executable chmod failed: {error}"));
        let replacement = b"#!/bin/sh\necho 'cartograph 9.9.9'\n";
        install_binary(&executable, replacement, "9.9.9")
            .unwrap_or_else(|error| panic!("atomic install failed: {error}"));
        assert_eq!(
            fs::read(&executable)
                .unwrap_or_else(|error| panic!("installed executable read failed: {error}")),
            replacement
        );
        assert!(verify_staged_binary(&executable, "9.9.9").is_ok());
        assert!(verify_staged_binary(&executable, "1.0.0").is_err());
        let mode = fs::metadata(&executable)
            .unwrap_or_else(|error| panic!("installed executable metadata failed: {error}"))
            .permissions()
            .mode();
        assert_ne!(mode & 0o111, 0);
    }

    #[cfg(unix)]
    #[test]
    fn versioned_native_update_installs_a_new_release_and_preserves_the_prior_binary() {
        use std::os::unix::fs::{PermissionsExt as _, symlink};

        let root =
            tempfile::tempdir().unwrap_or_else(|error| panic!("upgrade fixture failed: {error}"));
        let install_root = root.path().join(".cartograph-cli");
        let old_release = install_root.join("versions/v2.0.7");
        let old_executable = old_release.join("bin/cartograph");
        fs::create_dir_all(
            old_executable
                .parent()
                .unwrap_or_else(|| panic!("old executable fixture has no parent")),
        )
        .unwrap_or_else(|error| panic!("old release fixture failed: {error}"));
        let old_bytes = b"#!/bin/sh\necho 'cartograph 2.0.7'\n";
        fs::write(&old_executable, old_bytes)
            .unwrap_or_else(|error| panic!("old executable fixture failed: {error}"));
        fs::set_permissions(&old_executable, fs::Permissions::from_mode(0o755))
            .unwrap_or_else(|error| panic!("old executable chmod failed: {error}"));
        symlink("versions/v2.0.7", install_root.join("current"))
            .unwrap_or_else(|error| panic!("current release fixture failed: {error}"));
        let launcher_directory = root.path().join("bin");
        fs::create_dir(&launcher_directory)
            .unwrap_or_else(|error| panic!("launcher directory fixture failed: {error}"));
        let launcher = launcher_directory.join("cartograph");
        symlink(&old_executable, &launcher)
            .unwrap_or_else(|error| panic!("launcher fixture failed: {error}"));

        let launcher_path = env::join_paths([&launcher_directory])
            .unwrap_or_else(|error| panic!("launcher PATH fixture failed: {error}"));
        let replacement = b"#!/bin/sh\necho 'cartograph 2.0.8'\n";
        install_binary_unix(InstallBinaryInput {
            executable: &old_executable,
            bytes: replacement,
            version: "2.0.8",
            launcher_path: Some(&launcher_path),
        })
        .unwrap_or_else(|error| panic!("versioned install failed: {error}"));

        let new_release = install_root.join("versions/v2.0.8");
        let new_executable = new_release.join("bin/cartograph");
        assert_eq!(
            fs::read(&old_executable)
                .unwrap_or_else(|error| panic!("prior executable read failed: {error}")),
            old_bytes
        );
        assert_eq!(
            fs::read(&new_executable)
                .unwrap_or_else(|error| panic!("new executable read failed: {error}")),
            replacement
        );
        assert_eq!(
            fs::canonicalize(install_root.join("current"))
                .unwrap_or_else(|error| panic!("current release resolve failed: {error}")),
            fs::canonicalize(new_release)
                .unwrap_or_else(|error| panic!("new release resolve failed: {error}"))
        );
        assert_eq!(
            fs::canonicalize(launcher)
                .unwrap_or_else(|error| panic!("launcher resolve failed: {error}")),
            fs::canonicalize(new_executable)
                .unwrap_or_else(|error| panic!("new executable resolve failed: {error}"))
        );
    }

    fn spawn_http_fixture(response: String) -> (String, thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .unwrap_or_else(|error| panic!("upgrade fixture bind failed: {error}"));
        let address = listener
            .local_addr()
            .unwrap_or_else(|error| panic!("upgrade fixture address failed: {error}"));
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener
                .accept()
                .unwrap_or_else(|error| panic!("upgrade fixture accept failed: {error}"));
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap_or_else(|error| panic!("upgrade fixture timeout failed: {error}"));
            let mut request = vec![0_u8; FIXTURE_REQUEST_BYTES];
            let read = stream
                .read(&mut request)
                .unwrap_or_else(|error| panic!("upgrade fixture read failed: {error}"));
            request.truncate(read);
            stream
                .write_all(response.as_bytes())
                .and_then(|()| stream.flush())
                .unwrap_or_else(|error| panic!("upgrade fixture response failed: {error}"));
            request
        });
        (format!("http://{address}/release"), handle)
    }
}
