use std::{collections::BTreeSet, path::Path};

use cartograph_domain::NormalizedPath;
use futures_util::{StreamExt as _, TryStreamExt as _, stream};
use serde::Serialize;

use crate::{ProjectRuntime, ReviewError, review::run_git};

const MAX_HISTORY_COMMITS: u16 = 500;
const MAX_BLAME_LINES: u32 = 500;
const MAX_SOURCE_LINE: u32 = 10_000_000;
const MAX_TRACE_BYTES: usize = 200_000;
const MAX_TRACE_FRAMES: u16 = 50;
const TRACE_BLAME_CONCURRENCY: usize = 8;
const MAX_METADATA_BYTES: usize = 1_024;
const MAX_COMMIT_PATH_REQUESTS: usize = 52;
const MAX_PATHS_PER_COMMIT: u16 = 500;
const COMMIT_PATH_CONCURRENCY: usize = 8;

/// One path-filtered Git commit ordered newest-first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryCommit {
    commit: String,
    unix_seconds: u64,
    author: String,
    summary: String,
}

/// Bounded path history with exact ref provenance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPathHistory {
    path: NormalizedPath,
    commits: Vec<GitHistoryCommit>,
    truncated: bool,
}

/// Bounded line-range history from `git log -L`, ordered newest-first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLineHistory {
    path: NormalizedPath,
    start_line: u32,
    end_line: u32,
    commits: Vec<GitHistoryCommit>,
    truncated: bool,
}

/// Inclusive source-line range in one canonical project-relative path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitLineRange {
    path: NormalizedPath,
    start_line: u32,
    end_line: u32,
}

impl GitLineRange {
    #[must_use]
    pub const fn new(path: NormalizedPath, start_line: u32, end_line: u32) -> Self {
        Self {
            path,
            start_line,
            end_line,
        }
    }
}

/// Bounded line-log request for one exact source range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitLineHistoryRequest {
    range: GitLineRange,
    limit: u16,
}

impl GitLineHistoryRequest {
    #[must_use]
    pub const fn new(range: GitLineRange, limit: u16) -> Self {
        Self { range, limit }
    }
}

/// Rename-aware file-history evidence used to label `git log -L` limitations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRenameEvidence {
    renamed: bool,
    distinct_paths: u64,
    earliest_unix_seconds: Option<u64>,
}

/// Current commit's bounded changed-path set, suitable for graph attribution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPathSet {
    commit: String,
    paths: Vec<NormalizedPath>,
    total_paths: u64,
    truncated: bool,
}

/// One blamed source line without returning source contents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    path: NormalizedPath,
    line: u32,
    commit: String,
    unix_seconds: u64,
    author: String,
    summary: String,
    uncommitted: bool,
}

/// Bounded trace frame with exact blame evidence when the file/line resolved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceCulprit {
    path: NormalizedPath,
    line: u32,
    blame: Option<GitBlameLine>,
}

/// Parallel trace-to-blame report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceCulpritReport {
    frames: Vec<TraceCulprit>,
    unique_commits: Vec<String>,
    truncated: bool,
}

impl GitPathHistory {
    /// Newest-first bounded commit records.
    #[must_use]
    pub fn commits(&self) -> &[GitHistoryCommit] {
        &self.commits
    }
}

impl GitHistoryCommit {
    /// Canonical full commit identity.
    #[must_use]
    pub fn commit(&self) -> &str {
        &self.commit
    }

    /// Commit timestamp in Unix seconds.
    #[must_use]
    pub const fn unix_seconds(&self) -> u64 {
        self.unix_seconds
    }

    /// Sanitized author display name.
    #[must_use]
    pub fn author(&self) -> &str {
        &self.author
    }
}

impl GitLineHistory {
    /// Newest-first bounded commits that touched the exact current line range.
    #[must_use]
    pub fn commits(&self) -> &[GitHistoryCommit] {
        &self.commits
    }

    /// Whether an overflow-probe commit was omitted.
    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

impl GitRenameEvidence {
    /// True only when rename-aware history exposed more than one path.
    #[must_use]
    pub const fn renamed(&self) -> bool {
        self.renamed
    }

    /// Oldest reachable file-history timestamp.
    #[must_use]
    pub const fn earliest_unix_seconds(&self) -> Option<u64> {
        self.earliest_unix_seconds
    }
}

impl GitCommitPathSet {
    /// Commit identity that produced this path set.
    #[must_use]
    pub fn commit(&self) -> &str {
        &self.commit
    }

    /// Bounded normalized project-relative paths.
    #[must_use]
    pub fn paths(&self) -> &[NormalizedPath] {
        &self.paths
    }

    /// Complete path count before the caller limit.
    #[must_use]
    pub const fn total_paths(&self) -> u64 {
        self.total_paths
    }

    /// Whether the bounded path list omitted a suffix.
    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

impl TraceCulpritReport {
    /// Stable path/line-ordered trace frames.
    #[must_use]
    pub fn frames(&self) -> &[TraceCulprit] {
        &self.frames
    }
}

impl ProjectRuntime {
    /// Read bounded path history without shell interpretation or diff output.
    pub async fn git_history(
        &self,
        path: NormalizedPath,
        limit: u16,
    ) -> Result<GitPathHistory, ReviewError> {
        if limit == 0 || limit > MAX_HISTORY_COMMITS {
            return Err(ReviewError::InvalidOptions);
        }
        discover_git_history(&self.root, path, limit).await
    }

    /// Attribute an inclusive bounded source-line range to Git commits.
    pub async fn git_blame(&self, range: GitLineRange) -> Result<Vec<GitBlameLine>, ReviewError> {
        discover_git_blame(&self.root, range).await
    }

    /// Read a bounded symbol/range history through Git's line-log engine.
    pub async fn git_line_history(
        &self,
        request: GitLineHistoryRequest,
    ) -> Result<GitLineHistory, ReviewError> {
        discover_git_line_history(&self.root, request).await
    }

    /// Detect whether rename-aware file history predates a line-log timeline.
    pub async fn git_rename_evidence(
        &self,
        path: NormalizedPath,
    ) -> Result<GitRenameEvidence, ReviewError> {
        discover_git_rename_evidence(&self.root, path).await
    }

    /// Resolve changed paths for a bounded list of canonical commits in parallel.
    pub async fn git_commit_paths(
        &self,
        commits: &[String],
        per_commit_limit: u16,
    ) -> Result<Vec<GitCommitPathSet>, ReviewError> {
        discover_git_commit_paths(&self.root, commits, per_commit_limit).await
    }

    /// Extract project-relative path:line frames and blame up to eight in parallel.
    pub async fn trace_to_culprits(&self, trace: &str) -> Result<TraceCulpritReport, ReviewError> {
        self.trace_to_culprits_with_limit(trace, MAX_TRACE_FRAMES)
            .await
    }

    /// Extract and blame a caller-bounded number of unique project trace frames.
    pub async fn trace_to_culprits_with_limit(
        &self,
        trace: &str,
        limit: u16,
    ) -> Result<TraceCulpritReport, ReviewError> {
        trace_git_culprits_with_limit(&self.root, trace, limit).await
    }
}

/// Read bounded path history from an explicit Git worktree.
pub async fn discover_git_history(
    root: impl AsRef<Path>,
    path: NormalizedPath,
    limit: u16,
) -> Result<GitPathHistory, ReviewError> {
    if limit == 0 || limit > MAX_HISTORY_COMMITS {
        return Err(ReviewError::InvalidOptions);
    }
    let root = canonical_root(root.as_ref())?;
    history_for_path(&root, path, limit).await
}

/// Attribute an inclusive bounded line range in an explicit Git worktree.
pub async fn discover_git_blame(
    root: impl AsRef<Path>,
    range: GitLineRange,
) -> Result<Vec<GitBlameLine>, ReviewError> {
    validate_line_range(range.start_line, range.end_line)?;
    let root = canonical_root(root.as_ref())?;
    blame_path(&root, range).await
}

/// Read bounded line-range history in an explicit Git worktree.
pub async fn discover_git_line_history(
    root: impl AsRef<Path>,
    request: GitLineHistoryRequest,
) -> Result<GitLineHistory, ReviewError> {
    validate_line_range(request.range.start_line, request.range.end_line)?;
    if request.limit == 0 || request.limit > MAX_HISTORY_COMMITS {
        return Err(ReviewError::InvalidOptions);
    }
    let root = canonical_root(root.as_ref())?;
    line_history_for_path(&root, request).await
}

/// Inspect rename-aware path/timestamp evidence in an explicit worktree.
pub async fn discover_git_rename_evidence(
    root: impl AsRef<Path>,
    path: NormalizedPath,
) -> Result<GitRenameEvidence, ReviewError> {
    let root = canonical_root(root.as_ref())?;
    rename_evidence_for_path(&root, path).await
}

/// Resolve bounded changed paths for multiple commits with fixed concurrency.
pub async fn discover_git_commit_paths(
    root: impl AsRef<Path>,
    commits: &[String],
    per_commit_limit: u16,
) -> Result<Vec<GitCommitPathSet>, ReviewError> {
    if commits.is_empty()
        || commits.len() > MAX_COMMIT_PATH_REQUESTS
        || per_commit_limit == 0
        || per_commit_limit > MAX_PATHS_PER_COMMIT
    {
        return Err(ReviewError::InvalidOptions);
    }
    let root = canonical_root(root.as_ref())?;
    let commits = commits
        .iter()
        .map(|commit| normalize_commit(commit))
        .collect::<Result<Vec<_>, _>>()?;
    let mut rows = stream::iter(commits.into_iter().enumerate())
        .map(|(index, commit)| {
            let root = root.clone();
            async move {
                commit_paths(&root, commit, per_commit_limit)
                    .await
                    .map(|paths| (index, paths))
            }
        })
        .buffer_unordered(COMMIT_PATH_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    rows.sort_by_key(|(index, _)| *index);
    Ok(rows.into_iter().map(|(_, paths)| paths).collect())
}

/// Resolve stack-trace path:line frames and blame up to eight concurrently.
pub async fn trace_git_culprits(
    root: impl AsRef<Path>,
    trace: &str,
) -> Result<TraceCulpritReport, ReviewError> {
    trace_git_culprits_with_limit(root, trace, MAX_TRACE_FRAMES).await
}

/// Resolve stack-trace evidence with an explicit hard frame bound.
pub async fn trace_git_culprits_with_limit(
    root: impl AsRef<Path>,
    trace: &str,
    limit: u16,
) -> Result<TraceCulpritReport, ReviewError> {
    if trace.trim().is_empty() || trace.len() > MAX_TRACE_BYTES || trace.contains('\0') {
        return Err(ReviewError::InvalidOptions);
    }
    let limit = usize::from(limit);
    if limit == 0 || limit > usize::from(MAX_TRACE_FRAMES) {
        return Err(ReviewError::InvalidOptions);
    }
    let root = canonical_root(root.as_ref())?;
    let (locations, truncated) = extract_trace_locations(&root, trace, limit)?;
    let tasks_root = root.clone();
    let mut frames = stream::iter(locations)
        .map(|(path, line)| {
            let root = tasks_root.clone();
            async move {
                let blamed = blame_path(&root, GitLineRange::new(path.clone(), line, line)).await;
                match blamed {
                    Ok(mut rows) => Ok(TraceCulprit {
                        path,
                        line,
                        blame: rows.pop(),
                    }),
                    Err(ReviewError::GitCommandFailed | ReviewError::GitRefNotFound) => {
                        Ok(TraceCulprit {
                            path,
                            line,
                            blame: None,
                        })
                    }
                    Err(error) => Err(error),
                }
            }
        })
        .buffer_unordered(TRACE_BLAME_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    frames.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.line.cmp(&right.line))
    });
    let unique_commits = frames
        .iter()
        .filter_map(|frame| frame.blame.as_ref())
        .filter(|blame| !blame.uncommitted)
        .map(|blame| blame.commit.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(TraceCulpritReport {
        frames,
        unique_commits,
        truncated,
    })
}

fn canonical_root(root: &Path) -> Result<std::path::PathBuf, ReviewError> {
    let root = std::fs::canonicalize(root).map_err(|_| ReviewError::ProjectRootUnavailable)?;
    root.is_dir()
        .then_some(root)
        .ok_or(ReviewError::ProjectRootUnavailable)
}

async fn history_for_path(
    root: &Path,
    path: NormalizedPath,
    limit: u16,
) -> Result<GitPathHistory, ReviewError> {
    let requested = limit.saturating_add(1);
    let count = requested.to_string();
    let output = run_git(
        root,
        &[
            "log",
            "-z",
            "--follow",
            "--format=%H%x00%ct%x00%an%x00%s%x00",
            "-n",
            &count,
            "--",
            path.as_str(),
        ],
    )
    .await?;
    if !output.success {
        return Err(ReviewError::GitCommandFailed);
    }
    let mut commits = parse_history(&output.stdout)?;
    let truncated = commits.len() > usize::from(limit);
    commits.truncate(usize::from(limit));
    Ok(GitPathHistory {
        path,
        commits,
        truncated,
    })
}

async fn line_history_for_path(
    root: &Path,
    request: GitLineHistoryRequest,
) -> Result<GitLineHistory, ReviewError> {
    let requested = request.limit.saturating_add(1);
    let count = requested.to_string();
    let range = format!(
        "{},{}:{}",
        request.range.start_line,
        request.range.end_line,
        request.range.path.as_str()
    );
    let output = run_git(
        root,
        &[
            "log",
            "-z",
            "--format=%H%x00%ct%x00%an%x00%s%x00",
            "-n",
            &count,
            "-L",
            &range,
            "--no-patch",
        ],
    )
    .await?;
    if !output.success {
        return Err(ReviewError::GitCommandFailed);
    }
    let mut commits = parse_history(&output.stdout)?;
    let truncated = commits.len() > usize::from(request.limit);
    commits.truncate(usize::from(request.limit));
    Ok(GitLineHistory {
        path: request.range.path,
        start_line: request.range.start_line,
        end_line: request.range.end_line,
        commits,
        truncated,
    })
}

async fn rename_evidence_for_path(
    root: &Path,
    path: NormalizedPath,
) -> Result<GitRenameEvidence, ReviewError> {
    let timestamp_arguments = ["log", "--follow", "--format=%ct", "--", path.as_str()];
    let path_arguments = [
        "log",
        "--follow",
        "--format=",
        "--name-only",
        "-z",
        "--",
        path.as_str(),
    ];
    let timestamps = run_git(root, &timestamp_arguments);
    let paths = run_git(root, &path_arguments);
    let (timestamps, paths) = tokio::join!(timestamps, paths);
    let timestamps = timestamps?;
    let paths = paths?;
    if !timestamps.success || !paths.success {
        return Err(ReviewError::GitCommandFailed);
    }
    let timestamps =
        std::str::from_utf8(&timestamps.stdout).map_err(|_| ReviewError::GitOutputInvalid)?;
    let earliest_unix_seconds = timestamps
        .lines()
        .filter_map(|line| line.trim().parse::<u64>().ok())
        .min();
    let distinct_paths = parse_nul_paths(&paths.stdout)?;
    Ok(GitRenameEvidence {
        renamed: distinct_paths.len() > 1,
        distinct_paths: u64::try_from(distinct_paths.len()).unwrap_or(u64::MAX),
        earliest_unix_seconds,
    })
}

async fn commit_paths(
    root: &Path,
    commit: String,
    limit: u16,
) -> Result<GitCommitPathSet, ReviewError> {
    let output = run_git(
        root,
        &[
            "diff-tree",
            "--root",
            "-m",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            &commit,
            "--",
        ],
    )
    .await?;
    if !output.success {
        return Err(ReviewError::GitCommandFailed);
    }
    let paths = parse_nul_paths(&output.stdout)?;
    let total_paths = u64::try_from(paths.len()).unwrap_or(u64::MAX);
    let truncated = paths.len() > usize::from(limit);
    Ok(GitCommitPathSet {
        commit,
        paths: paths.into_iter().take(usize::from(limit)).collect(),
        total_paths,
        truncated,
    })
}

fn parse_nul_paths(output: &[u8]) -> Result<BTreeSet<NormalizedPath>, ReviewError> {
    output
        .split(|byte| *byte == 0)
        .filter_map(|field| {
            let field = crate::trim_ascii_bytes(field);
            (!field.is_empty()).then_some(field)
        })
        .map(|field| {
            let path = std::str::from_utf8(field).map_err(|_| ReviewError::GitOutputInvalid)?;
            NormalizedPath::parse(path).map_err(|_| ReviewError::GitOutputInvalid)
        })
        .collect()
}

fn parse_history(output: &[u8]) -> Result<Vec<GitHistoryCommit>, ReviewError> {
    if output.is_empty() {
        return Ok(Vec::new());
    }
    let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut commits = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        while index < fields.len() && crate::trim_ascii_bytes(fields[index]).is_empty() {
            index += 1;
        }
        if index == fields.len() {
            break;
        }
        let commit = parse_commit_field(fields.get(index).copied())?;
        let unix_seconds = parse_u64_field(fields.get(index + 1).copied())?;
        let author = parse_metadata_field(fields.get(index + 2).copied())?;
        let summary = parse_metadata_field(fields.get(index + 3).copied())?;
        commits.push(GitHistoryCommit {
            commit,
            unix_seconds,
            author,
            summary,
        });
        index += 4;
    }
    Ok(commits)
}

async fn blame_path(root: &Path, range: GitLineRange) -> Result<Vec<GitBlameLine>, ReviewError> {
    validate_line_range(range.start_line, range.end_line)?;
    let line_range = format!("{},{}", range.start_line, range.end_line);
    let output = run_git(
        root,
        &[
            "blame",
            "--line-porcelain",
            "-L",
            &line_range,
            "--",
            range.path.as_str(),
        ],
    )
    .await?;
    if !output.success {
        return Err(ReviewError::GitCommandFailed);
    }
    parse_blame(&output.stdout, &range.path)
}

fn parse_blame(output: &[u8], path: &NormalizedPath) -> Result<Vec<GitBlameLine>, ReviewError> {
    let text = std::str::from_utf8(output).map_err(|_| ReviewError::GitOutputInvalid)?;
    let mut lines = text.lines();
    let mut result = Vec::new();
    while let Some(header) = lines.next() {
        if header.is_empty() {
            continue;
        }
        let mut header_fields = header.split_ascii_whitespace();
        let raw_commit = header_fields.next().ok_or(ReviewError::GitOutputInvalid)?;
        let commit = normalize_commit(raw_commit)?;
        let _original_line = header_fields
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or(ReviewError::GitOutputInvalid)?;
        let final_line = header_fields
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or(ReviewError::GitOutputInvalid)?;
        let mut author = String::new();
        let mut unix_seconds = 0;
        let mut summary = String::new();
        let mut saw_source = false;
        for metadata in lines.by_ref() {
            if metadata.starts_with('\t') {
                saw_source = true;
                break;
            }
            if let Some(value) = metadata.strip_prefix("author ") {
                author = clean_metadata(value)?;
            } else if let Some(value) = metadata.strip_prefix("author-time ") {
                unix_seconds = value
                    .parse::<u64>()
                    .map_err(|_| ReviewError::GitOutputInvalid)?;
            } else if let Some(value) = metadata.strip_prefix("summary ") {
                summary = clean_metadata(value)?;
            }
        }
        if !saw_source || author.is_empty() {
            return Err(ReviewError::GitOutputInvalid);
        }
        let uncommitted = commit.bytes().all(|byte| byte == b'0');
        result.push(GitBlameLine {
            path: path.clone(),
            line: final_line,
            commit,
            unix_seconds,
            author,
            summary,
            uncommitted,
        });
    }
    Ok(result)
}

fn extract_trace_locations(
    root: &Path,
    trace: &str,
    limit: usize,
) -> Result<(Vec<(NormalizedPath, u32)>, bool), ReviewError> {
    let root = root.to_string_lossy();
    let mut locations = BTreeSet::new();
    let mut truncated = false;
    for line in trace.lines() {
        let bytes = line.as_bytes();
        for colon in bytes
            .iter()
            .enumerate()
            .filter_map(|(index, byte)| (*byte == b':').then_some(index))
        {
            let digit_start = colon + 1;
            if digit_start >= bytes.len() || !bytes[digit_start].is_ascii_digit() {
                continue;
            }
            let digit_end = bytes[digit_start..]
                .iter()
                .position(|byte| !byte.is_ascii_digit())
                .map_or(bytes.len(), |offset| digit_start + offset);
            let Ok(number) = line[digit_start..digit_end].parse::<u32>() else {
                continue;
            };
            if number == 0 || number > MAX_SOURCE_LINE {
                continue;
            }
            let mut start = colon;
            while start > 0 && trace_path_byte(bytes[start - 1]) {
                start -= 1;
            }
            let raw_path = line[start..colon].trim_start_matches(['(', '[']);
            if !raw_path
                .chars()
                .any(|character| matches!(character, '.' | '/' | '\\'))
            {
                continue;
            }
            let relative = raw_path
                .strip_prefix(root.as_ref())
                .and_then(|value| value.strip_prefix('/'))
                .unwrap_or(raw_path);
            let Ok(path) = NormalizedPath::parse(relative) else {
                continue;
            };
            if locations.len() == limit {
                truncated = true;
                break;
            }
            locations.insert((path, number));
        }
        if truncated {
            break;
        }
    }
    Ok((locations.into_iter().collect(), truncated))
}

fn validate_line_range(start_line: u32, end_line: u32) -> Result<(), ReviewError> {
    let count = end_line.saturating_sub(start_line).saturating_add(1);
    if start_line == 0
        || end_line < start_line
        || end_line > MAX_SOURCE_LINE
        || count > MAX_BLAME_LINES
    {
        Err(ReviewError::InvalidOptions)
    } else {
        Ok(())
    }
}

fn normalize_commit(value: &str) -> Result<String, ReviewError> {
    let value = value.strip_prefix('^').unwrap_or(value);
    let valid =
        matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    valid
        .then(|| value.to_ascii_lowercase())
        .ok_or(ReviewError::GitOutputInvalid)
}

fn parse_commit_field(value: Option<&[u8]>) -> Result<String, ReviewError> {
    let value = value.ok_or(ReviewError::GitOutputInvalid)?;
    let value = std::str::from_utf8(crate::trim_ascii_bytes(value))
        .map_err(|_| ReviewError::GitOutputInvalid)?;
    normalize_commit(value)
}

fn parse_u64_field(value: Option<&[u8]>) -> Result<u64, ReviewError> {
    let value = value.ok_or(ReviewError::GitOutputInvalid)?;
    std::str::from_utf8(crate::trim_ascii_bytes(value))
        .ok()
        .and_then(|value| value.parse().ok())
        .ok_or(ReviewError::GitOutputInvalid)
}

fn parse_metadata_field(value: Option<&[u8]>) -> Result<String, ReviewError> {
    let value = value.ok_or(ReviewError::GitOutputInvalid)?;
    let value = std::str::from_utf8(crate::trim_ascii_bytes(value))
        .map_err(|_| ReviewError::GitOutputInvalid)?;
    clean_metadata(value)
}

fn clean_metadata(value: &str) -> Result<String, ReviewError> {
    if value.len() > MAX_METADATA_BYTES || value.contains('\0') {
        return Err(ReviewError::GitOutputInvalid);
    }
    Ok(value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect())
}

const fn trace_path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/' | b'\\' | b'@')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_location_parser_deduplicates_and_bounds_project_paths() {
        let root = Path::new("/workspace/project");
        let trace = "at run (/workspace/project/src/main.rs:42:5)\nsrc/lib.rs:9\nsrc/lib.rs:9";
        let (locations, truncated) = extract_trace_locations(root, trace, 50)
            .unwrap_or_else(|error| panic!("trace did not parse: {error}"));
        assert_eq!(
            locations,
            vec![
                (
                    NormalizedPath::parse("src/lib.rs")
                        .unwrap_or_else(|error| panic!("path failed: {error}")),
                    9
                ),
                (
                    NormalizedPath::parse("src/main.rs")
                        .unwrap_or_else(|error| panic!("path failed: {error}")),
                    42
                )
            ]
        );
        assert!(!truncated);
    }

    #[test]
    fn history_parser_handles_nul_delimited_git_records() {
        let output = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x001700000000\x00Agent\x00Change thing\x00\x00";
        let rows =
            parse_history(output).unwrap_or_else(|error| panic!("history did not parse: {error}"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].unix_seconds, 1_700_000_000);
    }
}
