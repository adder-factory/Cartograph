use std::collections::{BTreeMap, BTreeSet};

use cartograph_db::{CurrentSymbolRecord, FileCochangeQuery};
use cartograph_domain::{NormalizedPath, ProjectId, SymbolId};
use cartograph_search::{
    DeterministicRetriever, IndexFreshness, ReviewBudget, ReviewPacket, ReviewRequest,
    ReviewRequestOptions, SourceRangeQuery, SourceRangeQueryInput, SourceRangeResult,
    TraversalBudget, TraversalNode, TraversalRequest,
};
use serde::Serialize;
use thiserror::Error;

use crate::{ProjectCancellation, ProjectError};

const MAX_DIFF_BYTES: usize = 1_048_576;
const DEFAULT_MAX_CHANGED_FILES: u16 = 200;
const MAX_CHANGED_FILES: u16 = 512;
const DEFAULT_CALLERS_PER_SYMBOL: u16 = 5;
const DEFAULT_CALLEES_PER_SYMBOL: u16 = 5;
const MAX_CALLERS_CALLEES_PER_SYMBOL: u16 = 50;
const DEFAULT_COCHANGE_WARNINGS_PER_FILE: u16 = 3;
const MAX_COCHANGE_WARNINGS_PER_FILE: u16 = 20;
const DEFAULT_MIN_COCHANGE_JACCARD: f32 = 0.4;
const MIN_COCHANGE_ANCHOR_RATIO: f32 = 0.3;
const DEFAULT_MIN_DIFF_MAGNITUDE: u32 = 10;
const MAX_DIFF_MAGNITUDE: u32 = 100_000;
const MAX_HUNKS_PER_FILE: usize = 256;
const MAX_CONTEXT_HUNKS: usize = 512;
const MAX_CONTEXT_SYMBOLS: usize = 256;
const SYMBOLS_PER_HUNK: u16 = 50;
const MAX_SOURCE_RANGE_LINES: u32 = 100_000;

/// User-controlled bounds for one supplied unified-diff review.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DiffReviewOptions {
    max_changed_files: u16,
    callers_per_symbol: u16,
    callees_per_symbol: u16,
    cochange_warnings_per_file: u16,
    minimum_cochange_jaccard: f32,
    minimum_diff_magnitude: u32,
    evidence_budget: ReviewBudget,
}

impl Default for DiffReviewOptions {
    fn default() -> Self {
        Self {
            max_changed_files: DEFAULT_MAX_CHANGED_FILES,
            callers_per_symbol: DEFAULT_CALLERS_PER_SYMBOL,
            callees_per_symbol: DEFAULT_CALLEES_PER_SYMBOL,
            cochange_warnings_per_file: DEFAULT_COCHANGE_WARNINGS_PER_FILE,
            minimum_cochange_jaccard: DEFAULT_MIN_COCHANGE_JACCARD,
            minimum_diff_magnitude: DEFAULT_MIN_DIFF_MAGNITUDE,
            evidence_budget: ReviewBudget::default(),
        }
    }
}

impl DiffReviewOptions {
    /// Bound retained changed-file metadata.
    /// # Errors
    ///
    /// Returns [`DiffReviewError::InvalidOptions`] when `value` is zero or
    /// exceeds the retained changed-file ceiling.
    pub const fn with_max_changed_files(mut self, value: u16) -> Result<Self, DiffReviewError> {
        if value == 0 || value > MAX_CHANGED_FILES {
            return Err(DiffReviewError::InvalidOptions);
        }
        self.max_changed_files = value;
        Ok(self)
    }

    /// Bound immediate incoming call evidence per hunk-overlapping symbol. Zero disables it.
    /// # Errors
    ///
    /// Returns [`DiffReviewError::InvalidOptions`] when `value` exceeds the
    /// per-symbol caller ceiling. Zero is accepted and disables this evidence.
    pub const fn with_callers_per_symbol(mut self, value: u16) -> Result<Self, DiffReviewError> {
        if value > MAX_CALLERS_CALLEES_PER_SYMBOL {
            return Err(DiffReviewError::InvalidOptions);
        }
        self.callers_per_symbol = value;
        Ok(self)
    }

    /// Bound immediate outgoing call evidence per hunk-overlapping symbol. Zero disables it.
    /// # Errors
    ///
    /// Returns [`DiffReviewError::InvalidOptions`] when `value` exceeds the
    /// per-symbol callee ceiling. Zero is accepted and disables this evidence.
    pub const fn with_callees_per_symbol(mut self, value: u16) -> Result<Self, DiffReviewError> {
        if value > MAX_CALLERS_CALLEES_PER_SYMBOL {
            return Err(DiffReviewError::InvalidOptions);
        }
        self.callees_per_symbol = value;
        Ok(self)
    }

    /// Bound historical partners surfaced for each changed file. Zero disables the lens.
    /// # Errors
    ///
    /// Returns [`DiffReviewError::InvalidOptions`] when `value` exceeds the
    /// per-file warning ceiling. Zero is accepted and disables the lens.
    pub const fn with_cochange_warnings_per_file(
        mut self,
        value: u16,
    ) -> Result<Self, DiffReviewError> {
        if value > MAX_COCHANGE_WARNINGS_PER_FILE {
            return Err(DiffReviewError::InvalidOptions);
        }
        self.cochange_warnings_per_file = value;
        Ok(self)
    }

    /// Set the pairwise Jaccard floor used by the co-change lens.
    /// # Errors
    ///
    /// Returns [`DiffReviewError::InvalidOptions`] when `value` is non-finite
    /// or outside the inclusive probability range `0.0..=1.0`.
    pub const fn with_minimum_cochange_jaccard(
        mut self,
        value: f32,
    ) -> Result<Self, DiffReviewError> {
        if !value.is_finite() || value < 0.0 || value > 1.0 {
            return Err(DiffReviewError::InvalidOptions);
        }
        self.minimum_cochange_jaccard = value;
        Ok(self)
    }

    /// Suppress co-change noise for diffs below this added-plus-removed-line magnitude.
    /// # Errors
    ///
    /// Returns [`DiffReviewError::InvalidOptions`] when `value` exceeds the
    /// maximum accepted added-plus-removed-line magnitude.
    pub const fn with_minimum_diff_magnitude(
        mut self,
        value: u32,
    ) -> Result<Self, DiffReviewError> {
        if value > MAX_DIFF_MAGNITUDE {
            return Err(DiffReviewError::InvalidOptions);
        }
        self.minimum_diff_magnitude = value;
        Ok(self)
    }

    /// Override the deterministic graph/evidence budget shared with Git review.
    #[must_use]
    pub const fn with_evidence_budget(mut self, value: ReviewBudget) -> Self {
        self.evidence_budget = value;
        self
    }
}

/// Caller-supplied patch, bounds, and cooperative cancellation for one review.
pub struct DiffReviewInput<'review> {
    diff: &'review str,
    options: DiffReviewOptions,
    cancellation: ProjectCancellation,
}

impl<'review> DiffReviewInput<'review> {
    #[must_use]
    /// Creates a validated diff review input.
    pub const fn new(
        diff: &'review str,
        options: DiffReviewOptions,
        cancellation: ProjectCancellation,
    ) -> Self {
        Self {
            diff,
            options,
            cancellation,
        }
    }
}

/// Credential-safe supplied-diff review failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum DiffReviewError {
    /// One configured bound is outside its documented range.
    #[error("Unified-diff review options are invalid")]
    InvalidOptions,
    /// The caller supplied more than the hard one-megabyte transport bound.
    #[error("Unified diff exceeds the one-megabyte input limit")]
    DiffTooLarge,
    /// Headers, hunk coordinates, paths, or quoted bytes are malformed or unsafe.
    #[error("Unified diff is malformed")]
    InvalidDiff,
    /// Fresh project/generation state could not be established.
    #[error("Unified-diff review project state is unavailable")]
    ProjectStateUnavailable,
    /// Current graph or range evidence could not be read.
    #[error("Unified-diff review evidence is unavailable")]
    RetrievalUnavailable,
    /// The request was cancelled cooperatively.
    #[error("Unified-diff review was cancelled")]
    Cancelled,
}

/// Stable file classification parsed from a supplied patch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffFileKind {
    /// File introduced by the compared revision.
    Added,
    /// Existing file whose contents changed.
    Modified,
    /// File removed by the compared revision.
    Deleted,
    /// File moved or renamed by the compared revision.
    Renamed,
}

/// One unified-diff hunk with both old and new coordinates and exact changed-line counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDiffHunk {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    added_lines: u32,
    removed_lines: u32,
}

/// One bounded file entry parsed from a supplied unified diff.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDiffFile {
    path: NormalizedPath,
    old_path: Option<NormalizedPath>,
    kind: DiffFileKind,
    binary: bool,
    hunks: Vec<UnifiedDiffHunk>,
    hunks_truncated: bool,
}

impl UnifiedDiffFile {
    /// Current path, or the former path for a deletion.
    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    /// Parsed file-level change kind.
    #[must_use]
    pub const fn kind(&self) -> DiffFileKind {
        self.kind
    }
}

/// Privacy-safe metadata extracted from a supplied patch. Diff bodies are not retained.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDiffComparison {
    files: Vec<UnifiedDiffFile>,
    diff_bytes: usize,
    added_lines: u64,
    removed_lines: u64,
    files_truncated: bool,
    hunks_truncated: bool,
}

impl UnifiedDiffComparison {
    /// Stable input-order file entries retained under the configured bound.
    #[must_use]
    pub fn files(&self) -> &[UnifiedDiffFile] {
        &self.files
    }

    /// Added plus removed body lines, excluding unchanged hunk context.
    #[must_use]
    pub const fn magnitude(&self) -> u64 {
        self.added_lines.saturating_add(self.removed_lines)
    }
}

/// Exact indexed symbols overlapping one supplied diff hunk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunkContext {
    path: NormalizedPath,
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    query_start_line: u32,
    query_end_line: u32,
    symbol_ids: Vec<SymbolId>,
    symbols_truncated: bool,
    range_truncated: bool,
}

/// Immediate call-graph context for one unique hunk-overlapping symbol.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSymbolContext {
    symbol: CurrentSymbolRecord,
    callers: Vec<TraversalNode>,
    callees: Vec<TraversalNode>,
    callers_truncated: bool,
    callees_truncated: bool,
}

/// Historical partner absent from the supplied change set.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffCochangeWarning {
    changed_file: NormalizedPath,
    expected_to_change: String,
    shared_commits: u64,
    jaccard: f32,
    anchor_ratio: f32,
}

/// Supplied-diff metadata plus hunk-precise, graph, test, and historical evidence.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffReviewReport {
    comparison: UnifiedDiffComparison,
    packet: ReviewPacket,
    hunks: Vec<DiffHunkContext>,
    symbols: Vec<DiffSymbolContext>,
    cochange_warnings: Vec<DiffCochangeWarning>,
    context_truncated: bool,
    cochange_available: bool,
}

#[derive(Default)]
struct PendingDiffFile {
    old_path: Option<NormalizedPath>,
    new_path: Option<NormalizedPath>,
    kind_hint: Option<DiffFileKind>,
    binary: bool,
    hunks: Vec<UnifiedDiffHunk>,
    hunks_truncated: bool,
    saw_new_header: bool,
}

impl PendingDiffFile {
    fn has_metadata(&self) -> bool {
        self.old_path.is_some()
            || self.new_path.is_some()
            || self.kind_hint.is_some()
            || self.binary
            || !self.hunks.is_empty()
    }
}

struct PendingFinalizeInput<'pending> {
    files: &'pending mut Vec<UnifiedDiffFile>,
    pending: &'pending mut PendingDiffFile,
    max_changed_files: u16,
    files_truncated: &'pending mut bool,
    hunks_truncated: &'pending mut bool,
}

struct DiffCochangeInput<'input> {
    project_id: &'input ProjectId,
    comparison: &'input UnifiedDiffComparison,
    options: DiffReviewOptions,
    cancellation: &'input ProjectCancellation,
}

struct SymbolGraphContextInput<'input> {
    retriever: &'input DeterministicRetriever,
    project_id: &'input ProjectId,
    symbol: CurrentSymbolRecord,
    options: DiffReviewOptions,
}

struct CallTraversalInput<'input> {
    retriever: &'input DeterministicRetriever,
    project_id: &'input ProjectId,
    symbol_id: &'input SymbolId,
    limit: u16,
    incoming: bool,
}

struct UnifiedDiffParser {
    files: Vec<UnifiedDiffFile>,
    pending: PendingDiffFile,
    active_hunk: Option<usize>,
    max_changed_files: u16,
    files_truncated: bool,
    hunks_truncated: bool,
    added_lines: u64,
    removed_lines: u64,
}

impl UnifiedDiffParser {
    fn new(max_changed_files: u16) -> Self {
        Self {
            files: Vec::new(),
            pending: PendingDiffFile::default(),
            active_hunk: None,
            max_changed_files,
            files_truncated: false,
            hunks_truncated: false,
            added_lines: 0,
            removed_lines: 0,
        }
    }

    fn consume_line(&mut self, line: &str) -> Result<(), DiffReviewError> {
        if self.consume_file_header(line)? || self.consume_file_metadata(line)? {
            return Ok(());
        }
        self.consume_hunk_line(line)
    }

    fn consume_file_header(&mut self, line: &str) -> Result<bool, DiffReviewError> {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            self.finalize_pending()?;
            self.pending = PendingDiffFile::default();
            if let Some((old, new)) = split_git_header_paths(rest)? {
                self.pending.old_path = decode_diff_path(&old)?;
                self.pending.new_path = decode_diff_path(&new)?;
            }
            self.active_hunk = None;
            return Ok(true);
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            if self.pending.saw_new_header {
                self.finalize_pending()?;
                self.pending = PendingDiffFile::default();
            }
            self.pending.old_path = decode_diff_path(rest)?;
            self.active_hunk = None;
            return Ok(true);
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            self.pending.new_path = decode_diff_path(rest)?;
            self.pending.saw_new_header = true;
            self.active_hunk = None;
            return Ok(true);
        }
        Ok(false)
    }

    fn consume_file_metadata(&mut self, line: &str) -> Result<bool, DiffReviewError> {
        if let Some(rest) = line.strip_prefix("rename from ") {
            self.pending.old_path = decode_diff_path(rest)?;
            self.pending.kind_hint = Some(DiffFileKind::Renamed);
        } else if let Some(rest) = line.strip_prefix("rename to ") {
            self.pending.new_path = decode_diff_path(rest)?;
            self.pending.kind_hint = Some(DiffFileKind::Renamed);
        } else if line.starts_with("new file mode ") {
            self.pending.kind_hint = Some(DiffFileKind::Added);
        } else if line.starts_with("deleted file mode ") {
            self.pending.kind_hint = Some(DiffFileKind::Deleted);
        } else if let Some(rest) = line.strip_prefix("Binary files ") {
            self.pending.binary = true;
            if let Some((old, new)) = rest.strip_suffix(" differ").and_then(split_binary_paths) {
                self.pending.old_path = decode_diff_path(old)?;
                self.pending.new_path = decode_diff_path(new)?;
            }
            self.active_hunk = None;
        } else {
            return Ok(false);
        }
        Ok(true)
    }

    fn consume_hunk_line(&mut self, line: &str) -> Result<(), DiffReviewError> {
        if let Some(hunk) = parse_hunk_header(line)? {
            if self.pending.hunks.len() < MAX_HUNKS_PER_FILE {
                self.pending.hunks.push(hunk);
                self.active_hunk = Some(self.pending.hunks.len().saturating_sub(1));
            } else {
                self.pending.hunks_truncated = true;
                self.active_hunk = None;
            }
            return Ok(());
        }
        let Some(index) = self.active_hunk else {
            return Ok(());
        };
        let hunk = self
            .pending
            .hunks
            .get_mut(index)
            .ok_or(DiffReviewError::InvalidDiff)?;
        if line.starts_with('+') && !line.starts_with("+++") {
            hunk.added_lines = hunk.added_lines.saturating_add(1);
            self.added_lines = self.added_lines.saturating_add(1);
        } else if line.starts_with('-') && !line.starts_with("---") {
            hunk.removed_lines = hunk.removed_lines.saturating_add(1);
            self.removed_lines = self.removed_lines.saturating_add(1);
        }
        Ok(())
    }

    fn finalize_pending(&mut self) -> Result<(), DiffReviewError> {
        finalize_pending(PendingFinalizeInput {
            files: &mut self.files,
            pending: &mut self.pending,
            max_changed_files: self.max_changed_files,
            files_truncated: &mut self.files_truncated,
            hunks_truncated: &mut self.hunks_truncated,
        })
    }

    fn finish(mut self, diff: &str) -> Result<UnifiedDiffComparison, DiffReviewError> {
        self.finalize_pending()?;
        if !diff.trim().is_empty() && self.files.is_empty() && !self.files_truncated {
            return Err(DiffReviewError::InvalidDiff);
        }
        Ok(UnifiedDiffComparison {
            files: self.files,
            diff_bytes: diff.len(),
            added_lines: self.added_lines,
            removed_lines: self.removed_lines,
            files_truncated: self.files_truncated,
            hunks_truncated: self.hunks_truncated,
        })
    }
}

impl crate::ProjectRuntime {
    /// Review caller-supplied unified-diff text without persisting its source body.
    /// # Errors
    ///
    /// Returns an error when the diff is oversized, malformed, or contains an
    /// unsafe path; project freshness cannot be established; bounded graph or
    /// range evidence is unavailable; or cancellation wins.
    pub async fn review_diff_with_cancellation(
        &self,
        input: DiffReviewInput<'_>,
    ) -> Result<DiffReviewReport, DiffReviewError> {
        let comparison = parse_unified_diff(input.diff, input.options.max_changed_files)?;
        let status = self
            .status_with_cancellation(input.cancellation.clone())
            .await
            .map_err(map_project_error)?;
        let (project_id, freshness) = match status.snapshot {
            Some(snapshot) if snapshot.current.is_some() => (
                Some(snapshot.project_id),
                if status.fresh {
                    IndexFreshness::Current
                } else {
                    IndexFreshness::Stale
                },
            ),
            _ => (None, IndexFreshness::Unknown),
        };
        let request = ReviewRequest::new(
            project_id.clone(),
            comparison.files.iter().map(|file| file.path.clone()),
            ReviewRequestOptions::new(freshness, input.options.evidence_budget)
                .with_changed_files_truncated(comparison.files_truncated),
        )
        .map_err(|_| DiffReviewError::RetrievalUnavailable)?;
        let retriever = DeterministicRetriever::new(self.database.clone());
        let packet = retriever
            .review_packet(&request)
            .await
            .map_err(|_| DiffReviewError::RetrievalUnavailable)?;
        let Some(project_id) = project_id else {
            return Ok(DiffReviewReport {
                comparison,
                packet,
                hunks: Vec::new(),
                symbols: Vec::new(),
                cochange_warnings: Vec::new(),
                context_truncated: false,
                cochange_available: true,
            });
        };
        let (hunks, symbols, context_truncated) = collect_hunk_context(HunkContextRequest {
            retriever: &retriever,
            project_id: &project_id,
            comparison: &comparison,
            options: input.options,
            cancellation: &input.cancellation,
        })
        .await?;
        let (cochange_warnings, cochange_available) = self
            .collect_diff_cochanges(DiffCochangeInput {
                project_id: &project_id,
                comparison: &comparison,
                options: input.options,
                cancellation: &input.cancellation,
            })
            .await?;
        Ok(DiffReviewReport {
            comparison,
            packet,
            hunks,
            symbols,
            cochange_warnings,
            context_truncated,
            cochange_available,
        })
    }

    async fn collect_diff_cochanges(
        &self,
        input: DiffCochangeInput<'_>,
    ) -> Result<(Vec<DiffCochangeWarning>, bool), DiffReviewError> {
        if input.options.cochange_warnings_per_file == 0
            || input.comparison.magnitude() < u64::from(input.options.minimum_diff_magnitude)
        {
            return Ok((Vec::new(), true));
        }
        let changed = input
            .comparison
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<BTreeSet<_>>();
        let mut warnings = Vec::new();
        for file in input
            .comparison
            .files
            .iter()
            .filter(|file| file.kind != DiffFileKind::Deleted)
        {
            require_not_cancelled(input.cancellation)?;
            let query_limit = input
                .options
                .cochange_warnings_per_file
                .saturating_mul(3)
                .max(1);
            let Ok(partners) = self
                .database
                .current_file_cochanges(
                    FileCochangeQuery::new(input.project_id, &file.path, query_limit)
                        .with_minimum_commits(2),
                )
                .await
            else {
                return Ok((warnings, false));
            };
            let mut retained = 0_u16;
            for partner in partners {
                if changed.contains(partner.path())
                    || (partner.jaccard() < input.options.minimum_cochange_jaccard
                        && partner.anchor_ratio() < MIN_COCHANGE_ANCHOR_RATIO)
                {
                    continue;
                }
                warnings.push(DiffCochangeWarning {
                    changed_file: file.path.clone(),
                    expected_to_change: partner.path().to_owned(),
                    shared_commits: partner.shared_commits(),
                    jaccard: partner.jaccard(),
                    anchor_ratio: partner.anchor_ratio(),
                });
                retained = retained.saturating_add(1);
                if retained == input.options.cochange_warnings_per_file {
                    break;
                }
            }
        }
        Ok((warnings, true))
    }
}

struct HunkContextRequest<'request> {
    retriever: &'request DeterministicRetriever,
    project_id: &'request ProjectId,
    comparison: &'request UnifiedDiffComparison,
    options: DiffReviewOptions,
    cancellation: &'request ProjectCancellation,
}

#[derive(Clone, Copy)]
struct HunkRangeInput<'hunk> {
    file: &'hunk UnifiedDiffFile,
    hunk: &'hunk UnifiedDiffHunk,
    query_start_line: u32,
    query_end_line: u32,
    range_truncated: bool,
}

struct HunkContextAccumulator {
    hunks: Vec<DiffHunkContext>,
    unique_symbols: BTreeMap<SymbolId, CurrentSymbolRecord>,
    truncated: bool,
}

impl HunkContextAccumulator {
    fn new(truncated: bool) -> Self {
        Self {
            hunks: Vec::new(),
            unique_symbols: BTreeMap::new(),
            truncated,
        }
    }

    fn at_capacity(&self) -> bool {
        self.hunks.len() == MAX_CONTEXT_HUNKS
    }

    fn push(&mut self, input: HunkRangeInput<'_>, range: Option<SourceRangeResult>) {
        let mut symbol_ids = Vec::new();
        let mut symbols_truncated = false;
        if let Some(range) = range {
            symbols_truncated = range.truncated();
            for symbol in range.symbols() {
                if !self.unique_symbols.contains_key(symbol.symbol_id())
                    && self.unique_symbols.len() == MAX_CONTEXT_SYMBOLS
                {
                    self.truncated = true;
                    symbols_truncated = true;
                    continue;
                }
                self.unique_symbols
                    .entry(symbol.symbol_id().clone())
                    .or_insert_with(|| symbol.clone());
                symbol_ids.push(symbol.symbol_id().clone());
            }
        }
        self.hunks.push(DiffHunkContext {
            path: input.file.path.clone(),
            old_start: input.hunk.old_start,
            old_lines: input.hunk.old_lines,
            new_start: input.hunk.new_start,
            new_lines: input.hunk.new_lines,
            query_start_line: input.query_start_line,
            query_end_line: input.query_end_line,
            symbol_ids,
            symbols_truncated,
            range_truncated: input.range_truncated,
        });
    }
}

async fn collect_hunk_context(
    request: HunkContextRequest<'_>,
) -> Result<(Vec<DiffHunkContext>, Vec<DiffSymbolContext>, bool), DiffReviewError> {
    let mut accumulator = HunkContextAccumulator::new(request.comparison.hunks_truncated);
    'files: for file in request
        .comparison
        .files
        .iter()
        .filter(|file| file.kind != DiffFileKind::Deleted)
    {
        for hunk in &file.hunks {
            require_not_cancelled(request.cancellation)?;
            if accumulator.at_capacity() {
                accumulator.truncated = true;
                break 'files;
            }
            let (query_start_line, query_end_line, range_truncated) = hunk_query_range(hunk);
            let query = SourceRangeQuery::new(SourceRangeQueryInput {
                path: file.path.clone(),
                start_line: query_start_line,
                end_line: query_end_line,
                limit: SYMBOLS_PER_HUNK,
            })
            .map_err(|_| DiffReviewError::InvalidDiff)?;
            let range = request
                .retriever
                .symbols_at_range(request.project_id, &query)
                .await
                .map_err(|_| DiffReviewError::RetrievalUnavailable)?;
            accumulator.push(
                HunkRangeInput {
                    file,
                    hunk,
                    query_start_line,
                    query_end_line,
                    range_truncated,
                },
                range,
            );
        }
    }
    let mut symbols = Vec::with_capacity(accumulator.unique_symbols.len());
    for symbol in accumulator.unique_symbols.into_values() {
        require_not_cancelled(request.cancellation)?;
        symbols.push(
            collect_symbol_graph_context(SymbolGraphContextInput {
                retriever: request.retriever,
                project_id: request.project_id,
                symbol,
                options: request.options,
            })
            .await?,
        );
    }
    Ok((accumulator.hunks, symbols, accumulator.truncated))
}

async fn collect_symbol_graph_context(
    input: SymbolGraphContextInput<'_>,
) -> Result<DiffSymbolContext, DiffReviewError> {
    let incoming_calls = traverse_calls(CallTraversalInput {
        retriever: input.retriever,
        project_id: input.project_id,
        symbol_id: input.symbol.symbol_id(),
        limit: input.options.callers_per_symbol,
        incoming: true,
    });
    let outgoing_calls = traverse_calls(CallTraversalInput {
        retriever: input.retriever,
        project_id: input.project_id,
        symbol_id: input.symbol.symbol_id(),
        limit: input.options.callees_per_symbol,
        incoming: false,
    });
    let (incoming_result, outgoing_result) = tokio::try_join!(incoming_calls, outgoing_calls)?;
    Ok(DiffSymbolContext {
        symbol: input.symbol,
        callers: incoming_result.0,
        callees: outgoing_result.0,
        callers_truncated: incoming_result.1,
        callees_truncated: outgoing_result.1,
    })
}

async fn traverse_calls(
    input: CallTraversalInput<'_>,
) -> Result<(Vec<TraversalNode>, bool), DiffReviewError> {
    if input.limit == 0 {
        return Ok((Vec::new(), false));
    }
    let budget =
        TraversalBudget::new(1, input.limit).map_err(|_| DiffReviewError::RetrievalUnavailable)?;
    let request = TraversalRequest::new(
        input.project_id.clone(),
        vec![input.symbol_id.clone()],
        budget,
    )
    .map_err(|_| DiffReviewError::RetrievalUnavailable)?;
    let result = if input.incoming {
        input.retriever.callers(&request).await
    } else {
        input.retriever.callees(&request).await
    }
    .map_err(|_| DiffReviewError::RetrievalUnavailable)?;
    Ok((result.nodes().to_vec(), result.truncated()))
}

fn hunk_query_range(hunk: &UnifiedDiffHunk) -> (u32, u32, bool) {
    let start = hunk.new_start.max(1);
    let requested_lines = hunk.new_lines.max(1);
    let retained_lines = requested_lines.min(MAX_SOURCE_RANGE_LINES);
    let end = start.saturating_add(retained_lines.saturating_sub(1));
    (start, end, retained_lines != requested_lines)
}

fn require_not_cancelled(cancellation: &ProjectCancellation) -> Result<(), DiffReviewError> {
    if cancellation.is_cancelled() {
        Err(DiffReviewError::Cancelled)
    } else {
        Ok(())
    }
}

const fn map_project_error(error: ProjectError) -> DiffReviewError {
    match error {
        ProjectError::RequestCancelled => DiffReviewError::Cancelled,
        _ => DiffReviewError::ProjectStateUnavailable,
    }
}

/// Parse bounded Git/GitHub unified-diff text without retaining source body lines.
/// # Errors
///
/// Returns [`DiffReviewError::DiffTooLarge`] for input above one megabyte,
/// [`DiffReviewError::InvalidOptions`] for an invalid file bound, or
/// [`DiffReviewError::InvalidDiff`] for malformed headers, coordinates, or paths.
pub fn parse_unified_diff(
    diff: &str,
    max_changed_files: u16,
) -> Result<UnifiedDiffComparison, DiffReviewError> {
    if diff.len() > MAX_DIFF_BYTES {
        return Err(DiffReviewError::DiffTooLarge);
    }
    if max_changed_files == 0 || max_changed_files > MAX_CHANGED_FILES {
        return Err(DiffReviewError::InvalidOptions);
    }
    let mut parser = UnifiedDiffParser::new(max_changed_files);
    for line in diff.lines() {
        parser.consume_line(line)?;
    }
    parser.finish(diff)
}

fn finalize_pending(input: PendingFinalizeInput<'_>) -> Result<(), DiffReviewError> {
    let PendingFinalizeInput {
        files,
        pending,
        max_changed_files,
        files_truncated,
        hunks_truncated,
    } = input;
    if !pending.has_metadata() {
        return Ok(());
    }
    let old_path = pending.old_path.clone();
    let new_path = pending.new_path.clone();
    let kind = pending.kind_hint.unwrap_or(match (&old_path, &new_path) {
        (None, Some(_)) => DiffFileKind::Added,
        (Some(_), None) => DiffFileKind::Deleted,
        (Some(old), Some(new)) if old != new => DiffFileKind::Renamed,
        (Some(_), Some(_)) => DiffFileKind::Modified,
        (None, None) => return Err(DiffReviewError::InvalidDiff),
    });
    let path = match kind {
        DiffFileKind::Deleted => old_path.clone(),
        _ => new_path.clone().or_else(|| old_path.clone()),
    }
    .ok_or(DiffReviewError::InvalidDiff)?;
    *hunks_truncated |= pending.hunks_truncated;
    if files.len() < usize::from(max_changed_files) {
        files.push(UnifiedDiffFile {
            path,
            old_path: old_path.filter(|old| new_path.as_ref() != Some(old)),
            kind,
            binary: pending.binary,
            hunks: std::mem::take(&mut pending.hunks),
            hunks_truncated: pending.hunks_truncated,
        });
    } else {
        *files_truncated = true;
    }
    *pending = PendingDiffFile::default();
    Ok(())
}

fn parse_hunk_header(line: &str) -> Result<Option<UnifiedDiffHunk>, DiffReviewError> {
    let Some(rest) = line.strip_prefix("@@ -") else {
        return Ok(None);
    };
    let (old, rest) = rest.split_once(" +").ok_or(DiffReviewError::InvalidDiff)?;
    let (new, _) = rest.split_once(" @@").ok_or(DiffReviewError::InvalidDiff)?;
    let (old_start, old_lines) = parse_hunk_range(old)?;
    let (new_start, new_lines) = parse_hunk_range(new)?;
    Ok(Some(UnifiedDiffHunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        added_lines: 0,
        removed_lines: 0,
    }))
}

fn parse_hunk_range(value: &str) -> Result<(u32, u32), DiffReviewError> {
    let (start, lines) = value.split_once(',').unwrap_or((value, "1"));
    let start = start
        .parse::<u32>()
        .map_err(|_| DiffReviewError::InvalidDiff)?;
    let lines = lines
        .parse::<u32>()
        .map_err(|_| DiffReviewError::InvalidDiff)?;
    if start == 0 && lines != 0 {
        return Err(DiffReviewError::InvalidDiff);
    }
    Ok((start, lines))
}

fn split_git_header_paths(value: &str) -> Result<Option<(String, String)>, DiffReviewError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(DiffReviewError::InvalidDiff);
    }
    if value.starts_with('"') {
        let (old, remaining) = take_quoted_token(value)?;
        let (new, tail) = take_quoted_token(remaining.trim_start())?;
        if !tail.trim().is_empty() {
            return Err(DiffReviewError::InvalidDiff);
        }
        return Ok(Some((old, new)));
    }
    let Some(separator) = value.rfind(" b/") else {
        return Ok(None);
    };
    let old = value[..separator].to_owned();
    let new = value[separator.saturating_add(1)..].to_owned();
    Ok(Some((old, new)))
}

fn split_binary_paths(value: &str) -> Option<(&str, &str)> {
    value.rsplit_once(" and ")
}

fn decode_diff_path(value: &str) -> Result<Option<NormalizedPath>, DiffReviewError> {
    let value = value.trim();
    if value == "/dev/null" {
        return Ok(None);
    }
    let decoded = if value.starts_with('"') {
        let (decoded, tail) = take_quoted_token(value)?;
        if !tail.trim().is_empty() {
            return Err(DiffReviewError::InvalidDiff);
        }
        decoded
    } else {
        value.to_owned()
    };
    let normalized = decoded
        .strip_prefix("a/")
        .or_else(|| decoded.strip_prefix("b/"))
        .unwrap_or(&decoded);
    NormalizedPath::parse(normalized)
        .map(Some)
        .map_err(|_| DiffReviewError::InvalidDiff)
}

fn take_quoted_token(value: &str) -> Result<(String, &str), DiffReviewError> {
    let bytes = value.as_bytes();
    if bytes.first() != Some(&b'"') {
        return Err(DiffReviewError::InvalidDiff);
    }
    let mut output = Vec::new();
    let mut index = 1;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let decoded =
                    String::from_utf8(output).map_err(|_| DiffReviewError::InvalidDiff)?;
                return Ok((decoded, &value[index.saturating_add(1)..]));
            }
            b'\\' => {
                index = index.saturating_add(1);
                let escaped = *bytes.get(index).ok_or(DiffReviewError::InvalidDiff)?;
                match escaped {
                    b'"' | b'\\' => output.push(escaped),
                    b't' => output.push(b'\t'),
                    b'n' => output.push(b'\n'),
                    b'r' => output.push(b'\r'),
                    b'0'..=b'7' => {
                        let mut octal = u32::from(escaped - b'0');
                        for _ in 0..2 {
                            let Some(next @ b'0'..=b'7') =
                                bytes.get(index.saturating_add(1)).copied()
                            else {
                                break;
                            };
                            index = index.saturating_add(1);
                            octal = octal
                                .saturating_mul(8)
                                .saturating_add(u32::from(next - b'0'));
                        }
                        output.push(u8::try_from(octal).map_err(|_| DiffReviewError::InvalidDiff)?);
                    }
                    _ => return Err(DiffReviewError::InvalidDiff),
                }
            }
            byte => output.push(byte),
        }
        index = index.saturating_add(1);
    }
    Err(DiffReviewError::InvalidDiff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_add_modify_delete_rename_and_exact_body_magnitude() {
        let diff = r"diff --git a/src/old.rs b/src/new.rs
similarity index 80%
rename from src/old.rs
rename to src/new.rs
--- a/src/old.rs
+++ b/src/new.rs
@@ -2,2 +2,3 @@
 same
-old
+new
+extra
diff --git a/src/added.rs b/src/added.rs
new file mode 100644
--- /dev/null
+++ b/src/added.rs
@@ -0,0 +1 @@
+added
diff --git a/src/deleted.rs b/src/deleted.rs
deleted file mode 100644
--- a/src/deleted.rs
+++ /dev/null
@@ -1 +0,0 @@
-deleted
";
        let parsed = parse_unified_diff(diff, 10)
            .unwrap_or_else(|error| panic!("diff parse failed: {error}"));
        assert_eq!(parsed.files().len(), 3);
        assert_eq!(parsed.files()[0].kind(), DiffFileKind::Renamed);
        assert_eq!(parsed.files()[0].path().as_str(), "src/new.rs");
        assert_eq!(parsed.files()[1].kind(), DiffFileKind::Added);
        assert_eq!(parsed.files()[2].kind(), DiffFileKind::Deleted);
        assert_eq!(parsed.magnitude(), 5);
        assert_eq!(parsed.added_lines, 3);
        assert_eq!(parsed.removed_lines, 2);
    }

    #[test]
    fn parses_spaces_and_git_octal_quoted_utf8_paths() {
        let diff = "diff --git \"a/src/hello world-\\303\\251.rs\" \"b/src/hello world-\\303\\251.rs\"\n--- \"a/src/hello world-\\303\\251.rs\"\n+++ \"b/src/hello world-\\303\\251.rs\"\n@@ -1 +1 @@\n-old\n+new\n";
        let parsed = parse_unified_diff(diff, 10)
            .unwrap_or_else(|error| panic!("quoted diff parse failed: {error}"));
        assert_eq!(
            parsed.files()[0].path().as_str(),
            "src/hello world-\u{e9}.rs"
        );
    }

    #[test]
    fn rejects_unsafe_paths_malformed_hunks_and_unbounded_inputs() {
        assert_eq!(
            parse_unified_diff("--- a/../secret\n+++ b/../secret\n", 10),
            Err(DiffReviewError::InvalidDiff)
        );
        assert_eq!(
            parse_unified_diff("--- a/src/a.rs\n+++ b/src/a.rs\n@@ -x +1 @@\n", 10),
            Err(DiffReviewError::InvalidDiff)
        );
        assert_eq!(
            parse_unified_diff(&"x".repeat(MAX_DIFF_BYTES.saturating_add(1)), 10),
            Err(DiffReviewError::DiffTooLarge)
        );
    }

    #[test]
    fn file_and_hunk_limits_report_truncation_without_retaining_patch_bodies() {
        let diff = "--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-a\n+b\n--- a/src/b.rs\n+++ b/src/b.rs\n@@ -1 +1 @@\n-a\n+b\n";
        let parsed = parse_unified_diff(diff, 1)
            .unwrap_or_else(|error| panic!("bounded diff parse failed: {error}"));
        assert_eq!(parsed.files().len(), 1);
        assert!(parsed.files_truncated);
        let serialized = serde_json::to_string(&parsed)
            .unwrap_or_else(|error| panic!("diff metadata serialization failed: {error}"));
        assert!(!serialized.contains("-a"));
        assert!(!serialized.contains("+b"));
    }
}
