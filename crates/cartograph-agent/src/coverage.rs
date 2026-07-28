use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use cartograph_db::{
    CoverageCount, CoverageLoadInput, CoverageLoadReport, CoverageLoadRequest, CoverageTarget,
    SymbolCoverageFact,
};
use cartograph_domain::{ContentDigest, NormalizedPath};
use serde::Serialize;
use thiserror::Error;

use crate::{ProjectCancellation, ProjectRuntime};

const MAX_REPORT_BYTES: u64 = 64 * 1_024 * 1_024;
const MAX_TOTAL_REPORT_BYTES: u64 = 128 * 1_024 * 1_024;
const MAX_LCOV_FILES: usize = 250_000;
const MAX_LCOV_LINES: usize = 10_000_000;
const MAX_SOURCE_LINE: u32 = 10_000_000;
const MAX_COVERAGE_WORKERS: usize = 16;

/// User-facing LCOV load options.
#[derive(Clone, Debug)]
pub struct LcovLoadOptions {
    report_paths: Vec<PathBuf>,
    source: String,
}

impl LcovLoadOptions {
    pub fn new(
        report_paths: Vec<PathBuf>,
        source: impl Into<String>,
    ) -> Result<Self, CoverageError> {
        let source = source.into();
        if report_paths.is_empty()
            || source.is_empty()
            || source.len() > 256
            || source.contains('\0')
        {
            return Err(CoverageError::InvalidOptions);
        }
        Ok(Self {
            report_paths,
            source,
        })
    }
}

/// Parsed/matched counters wrapped around the atomic database report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LcovLoadReport {
    reports: usize,
    report_files: usize,
    line_observations: usize,
    matched_symbols: usize,
    database: CoverageLoadReport,
}

/// Safe LCOV ingest failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum CoverageError {
    #[error("coverage options are invalid")]
    InvalidOptions,
    #[error("coverage project root is unavailable")]
    ProjectRootUnavailable,
    #[error("coverage report was not found inside the project")]
    ReportNotFound,
    #[error("coverage report exceeds the byte limit")]
    ReportTooLarge,
    #[error("coverage report is malformed or exceeds structural limits")]
    InvalidReport,
    #[error("coverage operation was cancelled")]
    Cancelled,
    #[error("no conventional LCOV report was found")]
    NoReportFound,
    #[error("the current generation has no symbols")]
    CurrentGenerationUnavailable,
    #[error("LCOV paths did not match current indexed source")]
    NoMatchingSymbols,
    #[error("coverage persistence failed")]
    StorageUnavailable,
}

impl ProjectRuntime {
    /// Load one or more explicit LCOV reports, joining symbol spans in parallel.
    pub async fn load_lcov(
        &self,
        options: LcovLoadOptions,
        cancellation: ProjectCancellation,
    ) -> Result<LcovLoadReport, CoverageError> {
        if cancellation.is_cancelled() {
            return Err(CoverageError::Cancelled);
        }
        let root = self.root.clone();
        let reports = read_reports(&root, &options.report_paths).await?;
        let report_count = reports.len();
        let parse_root = root.clone();
        let parse_cancellation = cancellation.clone();
        let parsed = tokio::task::spawn_blocking(move || {
            parse_reports(&parse_root, reports, &parse_cancellation)
        })
        .await
        .map_err(|_| CoverageError::InvalidReport)??;
        let targets = self
            .database()
            .current_coverage_targets(&current_project_id(self).await?)
            .await
            .map_err(|_| CoverageError::StorageUnavailable)?;
        let generation_id = targets
            .first()
            .map(CoverageTarget::generation_id)
            .cloned()
            .ok_or(CoverageError::CurrentGenerationUnavailable)?;
        let report_files = parsed.lines.len();
        let line_observations = parsed.lines.values().map(BTreeMap::len).sum::<usize>();
        let data = Arc::new(parsed.lines);
        let join_cancellation = cancellation.clone();
        let facts = tokio::task::spawn_blocking(move || {
            join_targets_parallel(targets, data, join_cancellation)
        })
        .await
        .map_err(|_| CoverageError::StorageUnavailable)??;
        if facts.is_empty() {
            return Err(CoverageError::NoMatchingSymbols);
        }
        let matched_symbols = facts.len();
        let project_id = current_project_id(self).await?;
        let request = CoverageLoadRequest::new(
            CoverageLoadInput {
                project_id,
                generation_id,
                source_label: options.source,
                report_digest: parsed.digest,
            },
            facts,
        )
        .and_then(|request| {
            request.with_metadata(serde_json::json!({
                "reports": report_count,
                "files": report_files,
                "lineObservations": line_observations
            }))
        })
        .map_err(|_| CoverageError::InvalidOptions)?;
        let database = self
            .database()
            .replace_current_symbol_coverage(request)
            .await
            .map_err(|_| CoverageError::StorageUnavailable)?;
        Ok(LcovLoadReport {
            reports: report_count,
            report_files,
            line_observations,
            matched_symbols,
            database,
        })
    }

    /// Discover conventional root/workspace LCOV paths and load them as one source.
    pub async fn refresh_lcov(
        &self,
        source: impl Into<String>,
        cancellation: ProjectCancellation,
    ) -> Result<LcovLoadReport, CoverageError> {
        let paths = discover_reports(&self.root)?;
        if paths.is_empty() {
            return Err(CoverageError::NoReportFound);
        }
        self.load_lcov(LcovLoadOptions::new(paths, source)?, cancellation)
            .await
    }
}

struct ParsedCoverage {
    lines: BTreeMap<NormalizedPath, BTreeMap<u32, u64>>,
    digest: ContentDigest,
}

async fn current_project_id(
    runtime: &ProjectRuntime,
) -> Result<cartograph_domain::ProjectId, CoverageError> {
    runtime
        .database()
        .project_snapshot_by_root(runtime.root_identity())
        .await
        .map_err(|_| CoverageError::StorageUnavailable)?
        .filter(|snapshot| snapshot.current.is_some())
        .map(|snapshot| snapshot.project_id)
        .ok_or(CoverageError::CurrentGenerationUnavailable)
}

async fn read_reports(
    root: &Path,
    paths: &[PathBuf],
) -> Result<Vec<(PathBuf, Vec<u8>)>, CoverageError> {
    let canonical_root =
        std::fs::canonicalize(root).map_err(|_| CoverageError::ProjectRootUnavailable)?;
    let mut total = 0_u64;
    let mut reports = BTreeMap::new();
    for path in paths {
        let path = if path.is_absolute() {
            path.clone()
        } else {
            canonical_root.join(path)
        };
        let canonical = std::fs::canonicalize(&path).map_err(|_| CoverageError::ReportNotFound)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(CoverageError::ReportNotFound);
        }
        let relative = canonical
            .strip_prefix(&canonical_root)
            .map_err(|_| CoverageError::ReportNotFound)?
            .to_path_buf();
        if reports.contains_key(&relative) {
            continue;
        }
        let metadata = tokio::fs::metadata(&canonical)
            .await
            .map_err(|_| CoverageError::ReportNotFound)?;
        if !metadata.is_file() || metadata.len() > MAX_REPORT_BYTES {
            return Err(CoverageError::ReportTooLarge);
        }
        total = total
            .checked_add(metadata.len())
            .filter(|value| *value <= MAX_TOTAL_REPORT_BYTES)
            .ok_or(CoverageError::ReportTooLarge)?;
        let bytes = tokio::fs::read(&canonical)
            .await
            .map_err(|_| CoverageError::ReportNotFound)?;
        reports.insert(relative, bytes);
    }
    Ok(reports.into_iter().collect())
}

fn parse_reports(
    root: &Path,
    reports: Vec<(PathBuf, Vec<u8>)>,
    cancellation: &ProjectCancellation,
) -> Result<ParsedCoverage, CoverageError> {
    let mut lines = BTreeMap::<NormalizedPath, BTreeMap<u32, u64>>::new();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"cartograph-v2-lcov-v1");
    for (path, bytes) in reports {
        if cancellation.is_cancelled() {
            return Err(CoverageError::Cancelled);
        }
        hasher.update(&(path.as_os_str().as_encoded_bytes().len() as u64).to_le_bytes());
        hasher.update(path.as_os_str().as_encoded_bytes());
        hasher.update(&(bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
        parse_report(CoverageReportInput {
            root,
            bytes: &bytes,
            output: &mut lines,
            cancellation,
        })?;
    }
    Ok(ParsedCoverage {
        lines,
        digest: ContentDigest::from_bytes(*hasher.finalize().as_bytes()),
    })
}

struct CoverageReportInput<'a> {
    root: &'a Path,
    bytes: &'a [u8],
    output: &'a mut BTreeMap<NormalizedPath, BTreeMap<u32, u64>>,
    cancellation: &'a ProjectCancellation,
}

fn parse_report(input: CoverageReportInput<'_>) -> Result<(), CoverageError> {
    let CoverageReportInput {
        root,
        bytes,
        output,
        cancellation,
    } = input;
    let source = std::str::from_utf8(bytes).map_err(|_| CoverageError::InvalidReport)?;
    let mut current = None;
    let mut total_lines = output.values().map(BTreeMap::len).sum::<usize>();
    for (index, line) in source.lines().enumerate() {
        if index % 1_024 == 0 && cancellation.is_cancelled() {
            return Err(CoverageError::Cancelled);
        }
        if let Some(path) = line.strip_prefix("SF:") {
            current = normalize_lcov_path(root, path);
        } else if let Some(observation) = line.strip_prefix("DA:") {
            let Some(path) = current.as_ref() else {
                return Err(CoverageError::InvalidReport);
            };
            let mut fields = observation.split(',');
            let line_number = fields
                .next()
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|value| (1..=MAX_SOURCE_LINE).contains(value))
                .ok_or(CoverageError::InvalidReport)?;
            let hits = fields
                .next()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or(CoverageError::InvalidReport)?;
            let file = output.entry(path.clone()).or_default();
            match file.entry(line_number) {
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    *entry.get_mut() = (*entry.get()).max(hits);
                }
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(hits);
                    total_lines = total_lines.saturating_add(1);
                }
            }
            if output.len() > MAX_LCOV_FILES || total_lines > MAX_LCOV_LINES {
                return Err(CoverageError::InvalidReport);
            }
        } else if line == "end_of_record" {
            current = None;
        }
    }
    Ok(())
}

fn normalize_lcov_path(root: &Path, raw: &str) -> Option<NormalizedPath> {
    if raw.is_empty() || raw.contains('\0') {
        return None;
    }
    let path = Path::new(raw);
    let relative = if path.is_absolute() {
        path.strip_prefix(root).ok()?
    } else {
        path.strip_prefix("./").unwrap_or(path)
    };
    NormalizedPath::parse(relative.to_string_lossy().as_ref()).ok()
}

fn join_targets_parallel(
    targets: Vec<CoverageTarget>,
    data: Arc<BTreeMap<NormalizedPath, BTreeMap<u32, u64>>>,
    cancellation: ProjectCancellation,
) -> Result<Vec<SymbolCoverageFact>, CoverageError> {
    let workers = std::thread::available_parallelism()
        .map(std::num::NonZero::get)
        .unwrap_or(1)
        .min(MAX_COVERAGE_WORKERS)
        .min(targets.len().max(1));
    let chunk_size = targets.len().div_ceil(workers).max(1);
    let chunks = std::thread::scope(|scope| {
        targets
            .chunks(chunk_size)
            .map(|chunk| {
                let data = data.clone();
                let cancellation = cancellation.clone();
                scope.spawn(move || join_target_chunk(chunk, &data, &cancellation))
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| CoverageError::StorageUnavailable)?
            })
            .collect::<Result<Vec<_>, CoverageError>>()
    })?;
    Ok(chunks.into_iter().flatten().collect())
}

fn join_target_chunk(
    targets: &[CoverageTarget],
    data: &BTreeMap<NormalizedPath, BTreeMap<u32, u64>>,
    cancellation: &ProjectCancellation,
) -> Result<Vec<SymbolCoverageFact>, CoverageError> {
    let mut facts = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        if index % 1_024 == 0 && cancellation.is_cancelled() {
            return Err(CoverageError::Cancelled);
        }
        let Some(lines) = data.get(target.path()) else {
            continue;
        };
        let mut found = 0_u64;
        let mut hit = 0_u64;
        for (_, count) in lines.range(target.start_line()..=target.end_line()) {
            found += 1;
            hit += u64::from(*count > 0);
        }
        let lines = CoverageCount::new(found, hit).map_err(|_| CoverageError::InvalidReport)?;
        facts.push(SymbolCoverageFact::new(
            target.symbol_id().clone(),
            lines,
            CoverageCount::ZERO,
        ));
    }
    Ok(facts)
}

fn discover_reports(root: &Path) -> Result<Vec<PathBuf>, CoverageError> {
    let candidates = [
        root.join("coverage/lcov.info"),
        root.join("lcov.info"),
        root.join("target/coverage/lcov.info"),
    ];
    let mut reports = candidates
        .into_iter()
        .filter(|path| path.is_file())
        .collect::<BTreeSet<_>>();
    for parent in [root.to_path_buf(), root.join("packages"), root.join("apps")] {
        let Ok(entries) = std::fs::read_dir(parent) else {
            continue;
        };
        for entry in entries.flatten().take(10_000) {
            let path = entry.path().join("coverage/lcov.info");
            if path.is_file() {
                reports.insert(path);
            }
        }
    }
    Ok(reports.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lcov_parser_unions_duplicate_lines_and_rejects_orphan_da_records() {
        let root = Path::new("/workspace");
        let cancellation = ProjectCancellation::new();
        let mut output = BTreeMap::new();
        parse_report(CoverageReportInput {
            root,
            bytes: b"SF:/workspace/src/lib.rs\nDA:2,0\nDA:2,3\nDA:3,1\nend_of_record\n",
            output: &mut output,
            cancellation: &cancellation,
        })
        .unwrap_or_else(|error| panic!("LCOV fixture failed: {error}"));
        let path = NormalizedPath::parse("src/lib.rs")
            .unwrap_or_else(|error| panic!("fixture path failed: {error}"));
        assert_eq!(output[&path][&2], 3);
        assert!(
            parse_report(CoverageReportInput {
                root,
                bytes: b"DA:1,1\n",
                output: &mut output,
                cancellation: &cancellation,
            })
            .is_err()
        );
    }

    #[test]
    fn report_discovery_is_conventional_and_bounded() {
        let directory =
            tempfile::tempdir().unwrap_or_else(|error| panic!("fixture directory failed: {error}"));
        std::fs::create_dir_all(directory.path().join("coverage"))
            .unwrap_or_else(|error| panic!("coverage directory failed: {error}"));
        std::fs::write(directory.path().join("coverage/lcov.info"), "TN:\n")
            .unwrap_or_else(|error| panic!("coverage fixture failed: {error}"));
        assert_eq!(
            discover_reports(directory.path())
                .unwrap_or_else(|error| panic!("discovery failed: {error}"))
                .len(),
            1
        );
    }
}
