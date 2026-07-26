use std::{collections::BTreeSet, fmt};

use cartograph_domain::{ContentDigest, GenerationId, NormalizedPath, ProjectId};
use serde::Serialize;

use super::{
    AffectedTest, ContextGraphDirection, DEFAULT_REVIEW_AFFECTED_TESTS, DEFAULT_REVIEW_EVIDENCE,
    DEFAULT_REVIEW_GRAPH_NODES, DEFAULT_REVIEW_ROOTS, DEFAULT_REVIEW_SYMBOLS_PER_FILE,
    EvidenceItem, HybridSearchPacket, IndexFreshness, MAX_REVIEW_CHANGED_PATHS, RedactedCount,
    RetrievalError, TaskIntent, TraversalBudget, WORKING_TREE_OVERLAY_MAXIMUM_EXCERPT_BYTES,
    WORKING_TREE_OVERLAY_MAXIMUM_RESULTS, WORKING_TREE_OVERLAY_MAXIMUM_TERM_BYTES,
    WORKING_TREE_OVERLAY_MAXIMUM_TERMS, invalid, validate_review_budget,
};

/// Published-generation provenance attached to every packet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GenerationEvidence {
    generation_id: GenerationId,
    sequence: u64,
}

impl GenerationEvidence {
    pub(crate) const fn new(generation_id: GenerationId, sequence: u64) -> Self {
        Self {
            generation_id,
            sequence,
        }
    }

    /// Immutable generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Monotonic project generation sequence.
    #[must_use]
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }
}

/// Explainable packet-level confidence, not a probability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalConfidence {
    /// No usable evidence exists.
    None,
    /// Evidence is stale, freshness is unknown, or only weak structural context exists.
    Low,
    /// Current BM25 or graph evidence exists without an exact anchor.
    Medium,
    /// A current exact name/path/reference anchor exists.
    High,
}

/// Explicit reason consumers should not treat the packet as sufficient context.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextAbstention {
    /// The project has no atomically published generation.
    NoCurrentGeneration,
    /// The published generation produced no relevant evidence.
    NoRelevantEvidence,
    /// The caller reported a stale index.
    StaleIndex,
    /// The caller could not verify index freshness.
    UnknownFreshness,
}

/// Git-level state of one live source file admitted to the context overlay.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkingTreeChangeKind {
    Added,
    Modified,
    TypeChanged,
    Untracked,
}

/// Whether working-tree source was checked and contributed live evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkingTreeOverlayStatus {
    /// The search-only service did not have a project checkout to inspect.
    NotChecked,
    /// Git proved there were no live changes relative to `HEAD`.
    Clean,
    /// Live changes existed, but none matched the bounded task terms.
    NoMatches,
    /// One or more changed live files contributed bounded evidence.
    Used,
    /// Git or the project root could not be inspected safely.
    Unavailable,
}

/// One query-matching excerpt read from changed or untracked live source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkingTreeEvidence {
    path: NormalizedPath,
    change_kind: WorkingTreeChangeKind,
    content_digest: ContentDigest,
    start_line: u32,
    end_line: u32,
    excerpt: String,
    matched_terms: Vec<String>,
}

/// Validated input for one bounded live-source overlay result.
pub struct WorkingTreeEvidenceInput {
    pub path: NormalizedPath,
    pub change_kind: WorkingTreeChangeKind,
    pub content_digest: ContentDigest,
    pub start_line: u32,
    pub end_line: u32,
    pub excerpt: String,
    pub matched_terms: Vec<String>,
}

impl WorkingTreeEvidence {
    /// Validate one live excerpt before it crosses the agent-facing boundary.
    pub fn new(input: WorkingTreeEvidenceInput) -> Result<Self, RetrievalError> {
        if input.start_line == 0
            || input.end_line < input.start_line
            || input.excerpt.is_empty()
            || input.excerpt.len() > WORKING_TREE_OVERLAY_MAXIMUM_EXCERPT_BYTES
            || input.matched_terms.is_empty()
            || input.matched_terms.len() > WORKING_TREE_OVERLAY_MAXIMUM_TERMS
            || input
                .matched_terms
                .iter()
                .any(|term| term.is_empty() || term.len() > WORKING_TREE_OVERLAY_MAXIMUM_TERM_BYTES)
        {
            return Err(invalid("working_tree_evidence"));
        }
        Ok(Self {
            path: input.path,
            change_kind: input.change_kind,
            content_digest: input.content_digest,
            start_line: input.start_line,
            end_line: input.end_line,
            excerpt: input.excerpt,
            matched_terms: input.matched_terms,
        })
    }

    /// Changed project-relative path.
    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    /// Number of distinct task terms represented by the live excerpt.
    #[must_use]
    pub fn match_count(&self) -> usize {
        self.matched_terms.len()
    }
}

/// Live working-tree evidence kept separate from immutable-generation evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkingTreeOverlay {
    status: WorkingTreeOverlayStatus,
    changed_file_count: usize,
    considered_file_count: usize,
    unreadable_file_count: usize,
    files: Vec<WorkingTreeEvidence>,
    truncated: bool,
}

/// Validated aggregate counts and evidence for one completed overlay scan.
pub struct WorkingTreeOverlayInput {
    pub changed_file_count: usize,
    pub considered_file_count: usize,
    pub unreadable_file_count: usize,
    pub files: Vec<WorkingTreeEvidence>,
    pub truncated: bool,
}

impl WorkingTreeOverlay {
    pub(crate) const fn not_checked() -> Self {
        Self {
            status: WorkingTreeOverlayStatus::NotChecked,
            changed_file_count: 0,
            considered_file_count: 0,
            unreadable_file_count: 0,
            files: Vec::new(),
            truncated: false,
        }
    }

    /// Report a clean checkout without fabricating live evidence.
    #[must_use]
    pub const fn clean() -> Self {
        Self {
            status: WorkingTreeOverlayStatus::Clean,
            changed_file_count: 0,
            considered_file_count: 0,
            unreadable_file_count: 0,
            files: Vec::new(),
            truncated: false,
        }
    }

    /// Report that safe Git/source inspection was unavailable.
    #[must_use]
    pub const fn unavailable() -> Self {
        Self {
            status: WorkingTreeOverlayStatus::Unavailable,
            changed_file_count: 0,
            considered_file_count: 0,
            unreadable_file_count: 0,
            files: Vec::new(),
            truncated: false,
        }
    }

    /// Build a completed bounded scan, deriving `used` versus `no_matches`.
    pub fn completed(input: WorkingTreeOverlayInput) -> Result<Self, RetrievalError> {
        if input.changed_file_count == 0
            || input.considered_file_count > input.changed_file_count
            || input.unreadable_file_count > input.considered_file_count
            || input.files.len() > WORKING_TREE_OVERLAY_MAXIMUM_RESULTS
        {
            return Err(invalid("working_tree_overlay"));
        }
        let status = if input.files.is_empty() {
            WorkingTreeOverlayStatus::NoMatches
        } else {
            WorkingTreeOverlayStatus::Used
        };
        Ok(Self {
            status,
            changed_file_count: input.changed_file_count,
            considered_file_count: input.considered_file_count,
            unreadable_file_count: input.unreadable_file_count,
            files: input.files,
            truncated: input.truncated,
        })
    }

    /// Whether and how live source participated in this packet.
    #[must_use]
    pub const fn status(&self) -> WorkingTreeOverlayStatus {
        self.status
    }

    /// Bounded live files ordered by task-term relevance then path.
    #[must_use]
    pub fn files(&self) -> &[WorkingTreeEvidence] {
        &self.files
    }

    /// Whether a file or byte/result bound omitted live candidates.
    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

/// Compact deterministic context packet suitable for a later AI boundary.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ContextPacket {
    #[serde(flatten)]
    pub(crate) details: ContextPacketDetails,
}

/// Evidence policy that selected a primary edit candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditCandidateBasis {
    /// A caller-supplied exact name, path, or reference anchor selected the file.
    ExactAnchor,
    /// The file had the strongest distinct task-term concentration in retrieval evidence.
    TaskTerms,
}

/// One bounded primary file candidate for a coding change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCandidate {
    path: String,
    basis: EditCandidateBasis,
    matched_term_count: u16,
    best_rank: Option<u16>,
    qualified_names: Vec<String>,
}

impl EditCandidate {
    pub(crate) fn new(
        path: String,
        basis: EditCandidateBasis,
        matched_term_count: u16,
        best_rank: Option<u16>,
        qualified_names: Vec<String>,
    ) -> Self {
        Self {
            path,
            basis,
            matched_term_count,
            best_rank,
            qualified_names,
        }
    }

    /// Canonical project-relative path.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Deterministic evidence policy that admitted this file.
    #[must_use]
    pub const fn basis(&self) -> EditCandidateBasis {
        self.basis
    }

    /// Number of distinct normalized task terms matched by the strongest evidence in this file.
    #[must_use]
    pub const fn matched_term_count(&self) -> u16 {
        self.matched_term_count
    }

    /// Best fused retrieval rank contributing to this file, if it came from a search channel.
    #[must_use]
    pub const fn best_rank(&self) -> Option<u16> {
        self.best_rank
    }

    /// Bounded qualified declarations supporting this candidate.
    #[must_use]
    pub fn qualified_names(&self) -> &[String] {
        &self.qualified_names
    }
}

/// Bounded primary edit surface with explicit omission provenance.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCandidateSet {
    candidates: Vec<EditCandidate>,
    truncated: bool,
}

impl EditCandidateSet {
    pub(crate) const fn new(candidates: Vec<EditCandidate>, truncated: bool) -> Self {
        Self {
            candidates,
            truncated,
        }
    }

    /// Primary edit candidates ordered by evidence strength then path.
    #[must_use]
    pub fn candidates(&self) -> &[EditCandidate] {
        &self.candidates
    }

    /// Whether equally strong primary candidates exceeded the packet bound.
    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ContextPacketDetails {
    pub(crate) generation: Option<GenerationEvidence>,
    pub(crate) intent: TaskIntent,
    pub(crate) graph_direction: Option<ContextGraphDirection>,
    pub(crate) freshness: IndexFreshness,
    pub(crate) confidence: RetrievalConfidence,
    pub(crate) abstention: Option<ContextAbstention>,
    pub(crate) retrieval: HybridSearchPacket,
    pub(crate) evidence: Vec<EvidenceItem>,
    pub(crate) edit_candidates: EditCandidateSet,
    pub(crate) affected_tests: Vec<AffectedTest>,
    pub(crate) working_tree_overlay: WorkingTreeOverlay,
    pub(crate) truncated: bool,
}

/// Hard bounds for one compare-to-ref evidence packet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ReviewBudget {
    symbols_per_file: u16,
    root_limit: u16,
    traversal: TraversalBudget,
    evidence_limit: u16,
    affected_test_limit: u16,
}

/// Named input for compare-to-ref bounds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReviewBudgetInput {
    /// Maximum declarations read from each changed file.
    pub symbols_per_file: u16,
    /// Maximum unique traversal roots across changed files.
    pub root_limit: u16,
    /// Structural traversal bounds.
    pub traversal: TraversalBudget,
    /// Maximum compact evidence items emitted.
    pub evidence_limit: u16,
    /// Maximum affected tests emitted.
    pub affected_test_limit: u16,
}

impl Default for ReviewBudgetInput {
    fn default() -> Self {
        Self {
            symbols_per_file: DEFAULT_REVIEW_SYMBOLS_PER_FILE,
            root_limit: DEFAULT_REVIEW_ROOTS,
            traversal: TraversalBudget {
                max_depth: 3,
                max_nodes: DEFAULT_REVIEW_GRAPH_NODES,
            },
            evidence_limit: DEFAULT_REVIEW_EVIDENCE,
            affected_test_limit: DEFAULT_REVIEW_AFFECTED_TESTS,
        }
    }
}

impl ReviewBudget {
    /// Build a fully bounded review budget.
    pub fn new(input: ReviewBudgetInput) -> Result<Self, RetrievalError> {
        validate_review_budget(&input)?;
        Ok(input.into())
    }

    pub(crate) const fn symbols_per_file(self) -> u16 {
        self.symbols_per_file
    }

    pub(crate) const fn root_limit(self) -> u16 {
        self.root_limit
    }

    pub(crate) const fn traversal(self) -> TraversalBudget {
        self.traversal
    }

    pub(crate) const fn evidence_limit(self) -> u16 {
        self.evidence_limit
    }

    pub(crate) const fn affected_test_limit(self) -> u16 {
        self.affected_test_limit
    }
}

impl From<ReviewBudgetInput> for ReviewBudget {
    fn from(input: ReviewBudgetInput) -> Self {
        Self {
            symbols_per_file: input.symbols_per_file,
            root_limit: input.root_limit,
            traversal: input.traversal,
            evidence_limit: input.evidence_limit,
            affected_test_limit: input.affected_test_limit,
        }
    }
}

impl Default for ReviewBudget {
    fn default() -> Self {
        let input = ReviewBudgetInput::default();
        Self {
            symbols_per_file: input.symbols_per_file,
            root_limit: input.root_limit,
            traversal: input.traversal,
            evidence_limit: input.evidence_limit,
            affected_test_limit: input.affected_test_limit,
        }
    }
}

/// Bounded review request built from deterministic Git change discovery.
pub struct ReviewRequest {
    project_id: Option<ProjectId>,
    changed_paths: Vec<NormalizedPath>,
    freshness: IndexFreshness,
    budget: ReviewBudget,
    changed_files_truncated: bool,
}

/// Non-sensitive compare-to-ref execution options.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReviewRequestOptions {
    freshness: IndexFreshness,
    budget: ReviewBudget,
    changed_files_truncated: bool,
}

impl ReviewRequestOptions {
    /// Bind freshness and hard bounds before adding truncation provenance.
    #[must_use]
    pub const fn new(freshness: IndexFreshness, budget: ReviewBudget) -> Self {
        Self {
            freshness,
            budget,
            changed_files_truncated: false,
        }
    }

    /// Record that Git path discovery omitted changed paths.
    #[must_use]
    pub const fn with_changed_files_truncated(mut self, truncated: bool) -> Self {
        self.changed_files_truncated = truncated;
        self
    }
}

impl ReviewRequest {
    /// Validate, deduplicate, and sort changed paths before database work.
    pub fn new(
        project_id: Option<ProjectId>,
        changed_paths: impl IntoIterator<Item = NormalizedPath>,
        options: ReviewRequestOptions,
    ) -> Result<Self, RetrievalError> {
        let changed_paths = changed_paths.into_iter().collect::<BTreeSet<_>>();
        if changed_paths.len() > MAX_REVIEW_CHANGED_PATHS {
            return Err(invalid("changed_paths"));
        }
        Ok(Self {
            project_id,
            changed_paths: changed_paths.into_iter().collect(),
            freshness: options.freshness,
            budget: options.budget,
            changed_files_truncated: options.changed_files_truncated,
        })
    }

    pub(crate) const fn project_id(&self) -> Option<&ProjectId> {
        self.project_id.as_ref()
    }

    pub(crate) fn changed_paths(&self) -> &[NormalizedPath] {
        &self.changed_paths
    }

    pub(crate) const fn freshness(&self) -> IndexFreshness {
        self.freshness
    }

    pub(crate) const fn budget(&self) -> ReviewBudget {
        self.budget
    }

    pub(crate) const fn changed_files_truncated(&self) -> bool {
        self.changed_files_truncated
    }
}

impl fmt::Debug for ReviewRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReviewRequest")
            .field("project_id", &self.project_id)
            .field("changed_paths", &RedactedCount(self.changed_paths.len()))
            .field("freshness", &self.freshness)
            .field("budget", &self.budget)
            .field("changed_files_truncated", &self.changed_files_truncated)
            .finish()
    }
}

/// Why a compare-to-ref packet should not be treated as a complete review.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAbstention {
    /// No current immutable generation exists for graph lookup.
    NoCurrentGeneration,
    /// Git found no differences from the requested base commit.
    NoChangedFiles,
    /// Changed paths had no records in the current generation.
    NoIndexedChangedFiles,
    /// The published generation differs from the live supported-source manifest.
    StaleIndex,
    /// The caller could not establish source freshness.
    UnknownFreshness,
}

/// Per-stage review bounds that omitted candidates.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ReviewTruncation {
    pub(crate) changed_files: bool,
    pub(crate) symbol_roots: bool,
    pub(crate) graph: bool,
    pub(crate) affected_tests: bool,
    pub(crate) evidence: bool,
}

impl ReviewTruncation {
    pub(crate) const fn with_evidence(mut self, evidence: bool) -> Self {
        self.evidence = evidence;
        self
    }

    /// Whether the changed-file bound omitted paths.
    #[must_use]
    pub const fn changed_files(self) -> bool {
        self.changed_files
    }

    /// Whether per-file or total graph-root bounds omitted symbols.
    #[must_use]
    pub const fn symbol_roots(self) -> bool {
        self.symbol_roots
    }

    /// Whether graph breadth/depth bounds omitted impact nodes.
    #[must_use]
    pub const fn graph(self) -> bool {
        self.graph
    }

    /// Whether the affected-test limit omitted candidates.
    #[must_use]
    pub const fn affected_tests(self) -> bool {
        self.affected_tests
    }

    /// Whether the compact evidence limit omitted candidates.
    #[must_use]
    pub const fn evidence(self) -> bool {
        self.evidence
    }

    /// Whether any stage reported explicit truncation.
    #[must_use]
    pub const fn any(self) -> bool {
        self.changed_files
            || self.symbol_roots
            || self.graph
            || self.affected_tests
            || self.evidence
    }
}

/// Deterministic index, graph-impact, and affected-test evidence for a Git comparison.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReviewPacket {
    #[serde(flatten)]
    pub(crate) details: ReviewPacketDetails,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ReviewPacketDetails {
    pub(crate) generation: Option<GenerationEvidence>,
    pub(crate) freshness: IndexFreshness,
    pub(crate) confidence: RetrievalConfidence,
    pub(crate) abstention: Option<ReviewAbstention>,
    pub(crate) indexed_changed_files: Vec<NormalizedPath>,
    pub(crate) evidence: Vec<EvidenceItem>,
    pub(crate) affected_tests: Vec<AffectedTest>,
    pub(crate) truncation: ReviewTruncation,
}

impl ReviewPacket {
    /// Published generation provenance, absent before the first index.
    #[must_use]
    pub const fn generation(&self) -> Option<&GenerationEvidence> {
        self.details.generation.as_ref()
    }

    /// Live-source relationship supplied by the project runtime.
    #[must_use]
    pub const fn freshness(&self) -> IndexFreshness {
        self.details.freshness
    }

    /// Explainable review confidence.
    #[must_use]
    pub const fn confidence(&self) -> RetrievalConfidence {
        self.details.confidence
    }

    /// Explicit insufficiency reason.
    #[must_use]
    pub const fn abstention(&self) -> Option<ReviewAbstention> {
        self.details.abstention
    }

    /// Changed paths found in the current immutable generation.
    #[must_use]
    pub fn indexed_changed_files(&self) -> &[NormalizedPath] {
        &self.details.indexed_changed_files
    }

    /// Exact changed-file and bounded graph-impact evidence.
    #[must_use]
    pub fn evidence(&self) -> &[EvidenceItem] {
        &self.details.evidence
    }

    /// Bounded reverse-impact test candidates.
    #[must_use]
    pub fn affected_tests(&self) -> &[AffectedTest] {
        &self.details.affected_tests
    }

    /// Explicit per-stage truncation flags.
    #[must_use]
    pub const fn truncation(&self) -> ReviewTruncation {
        self.details.truncation
    }
}

impl ContextPacket {
    /// Published generation provenance, absent when no current pointer exists.
    #[must_use]
    pub const fn generation(&self) -> Option<&GenerationEvidence> {
        self.details.generation.as_ref()
    }

    /// Deterministic coding-task policy used to assemble this packet.
    #[must_use]
    pub const fn intent(&self) -> TaskIntent {
        self.details.intent
    }

    /// Caller/callee policy used for graph-bearing context, when applicable.
    #[must_use]
    pub const fn graph_direction(&self) -> Option<ContextGraphDirection> {
        self.details.graph_direction
    }

    /// Attach caller-verified changed-source evidence to an immutable packet.
    #[must_use]
    pub fn with_working_tree_overlay(mut self, overlay: WorkingTreeOverlay) -> Self {
        self.details.working_tree_overlay = overlay;
        self
    }

    /// Caller-owned working-tree freshness assessment.
    #[must_use]
    pub const fn freshness(&self) -> IndexFreshness {
        self.details.freshness
    }

    /// Explainable packet confidence.
    #[must_use]
    pub const fn confidence(&self) -> RetrievalConfidence {
        self.details.confidence
    }

    /// Explicit abstention reason, if consumers should seek more context.
    #[must_use]
    pub const fn abstention(&self) -> Option<ContextAbstention> {
        self.details.abstention
    }

    /// Deterministic or hybrid channel result and its fallback provenance.
    #[must_use]
    pub const fn retrieval(&self) -> &HybridSearchPacket {
        &self.details.retrieval
    }

    /// Compact, deterministically ordered evidence.
    #[must_use]
    pub fn evidence(&self) -> &[EvidenceItem] {
        &self.details.evidence
    }

    /// Deterministic primary files suggested for the coding task.
    #[must_use]
    pub const fn edit_candidates(&self) -> &EditCandidateSet {
        &self.details.edit_candidates
    }

    /// Reverse-impact test candidates.
    #[must_use]
    pub fn affected_tests(&self) -> &[AffectedTest] {
        &self.details.affected_tests
    }

    /// Live changed/untracked source evidence, isolated from durable generation facts.
    #[must_use]
    pub const fn working_tree_overlay(&self) -> &WorkingTreeOverlay {
        &self.details.working_tree_overlay
    }

    /// Whether any explicit result bound omitted candidates.
    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.details.truncated
    }
}
