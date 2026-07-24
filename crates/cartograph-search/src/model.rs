use std::{collections::BTreeSet, fmt};

use cartograph_db::{
    CurrentFileRecord, CurrentReferenceRecord, CurrentSymbolRecord, SearchComponent, SearchHit,
    StorageError,
};
use cartograph_domain::{DocumentId, FileId, GenerationId, NormalizedPath, ProjectId, SymbolId};
use serde::Serialize;
use thiserror::Error;

const MAX_QUERY_BYTES: usize = 1_024;
const MAX_ANCHORS: usize = 16;
const MAX_ROOTS: usize = 32;
const MAX_DEPTH: u8 = 8;
const MAX_GRAPH_NODES: u16 = 500;
const MAX_CANDIDATES: u16 = 100;
const MAX_EXACT_RESULTS: u16 = 500;
const MAX_PACKET_EVIDENCE: u16 = 100;
const MAX_AFFECTED_TESTS: u16 = 100;
const MAX_REVIEW_CHANGED_PATHS: usize = 512;
const MAX_REVIEW_ROOTS: u16 = 32;

/// Credential- and query-safe deterministic retrieval failure.
#[derive(Debug, Error)]
pub enum RetrievalError {
    /// A caller supplied an invalid bounded field. The field value is omitted.
    #[error("invalid {field} in deterministic retrieval request")]
    InvalidInput {
        /// Stable field name.
        field: &'static str,
    },
    /// PostgreSQL retrieval failed with Cartograph's redacted storage error.
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// Caller-owned assessment of whether the index matches the working tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexFreshness {
    /// The caller verified that the published generation matches current source.
    Current,
    /// The caller knows that source has changed since the generation was published.
    Stale,
    /// The caller could not establish the relationship to current source.
    Unknown,
}

/// Hard breadth/depth limits for one structural traversal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct TraversalBudget {
    max_depth: u8,
    max_nodes: u16,
}

impl TraversalBudget {
    /// Validate a traversal budget. Depth and node count must both be non-zero.
    pub const fn new(max_depth: u8, max_nodes: u16) -> Result<Self, RetrievalError> {
        if max_depth == 0 || max_depth > MAX_DEPTH {
            return Err(invalid("max_depth"));
        }
        if max_nodes == 0 || max_nodes > MAX_GRAPH_NODES {
            return Err(invalid("max_nodes"));
        }
        Ok(Self {
            max_depth,
            max_nodes,
        })
    }

    /// Maximum number of graph hops.
    #[must_use]
    pub const fn max_depth(self) -> u8 {
        self.max_depth
    }

    /// Maximum number of non-root symbols returned.
    #[must_use]
    pub const fn max_nodes(self) -> u16 {
        self.max_nodes
    }
}

impl Default for TraversalBudget {
    fn default() -> Self {
        Self {
            max_depth: 2,
            max_nodes: 100,
        }
    }
}

/// Bounded candidate and output limits for a compact evidence packet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ContextBudget {
    candidate_limit: u16,
    exact_limit: u16,
    traversal: TraversalBudget,
    evidence_limit: u16,
    affected_test_limit: u16,
}

impl ContextBudget {
    /// Build a fully bounded packet budget.
    pub const fn new(
        candidate_limit: u16,
        exact_limit: u16,
        traversal: TraversalBudget,
        evidence_limit: u16,
        affected_test_limit: u16,
    ) -> Result<Self, RetrievalError> {
        if candidate_limit == 0 || candidate_limit > MAX_CANDIDATES {
            return Err(invalid("candidate_limit"));
        }
        if exact_limit == 0 || exact_limit > MAX_EXACT_RESULTS {
            return Err(invalid("exact_limit"));
        }
        if evidence_limit == 0 || evidence_limit > MAX_PACKET_EVIDENCE {
            return Err(invalid("evidence_limit"));
        }
        if affected_test_limit == 0 || affected_test_limit > MAX_AFFECTED_TESTS {
            return Err(invalid("affected_test_limit"));
        }
        Ok(Self {
            candidate_limit,
            exact_limit,
            traversal,
            evidence_limit,
            affected_test_limit,
        })
    }

    pub(crate) const fn candidate_limit(self) -> u16 {
        self.candidate_limit
    }

    pub(crate) const fn exact_limit(self) -> u16 {
        self.exact_limit
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

impl Default for ContextBudget {
    fn default() -> Self {
        Self {
            candidate_limit: 20,
            exact_limit: 50,
            traversal: TraversalBudget {
                max_depth: 2,
                max_nodes: 100,
            },
            evidence_limit: 30,
            affected_test_limit: 20,
        }
    }
}

/// Explicit exact evidence requested in addition to the task's BM25 query.
#[derive(Clone, PartialEq, Eq)]
pub enum ContextAnchor {
    /// Exact fully qualified declaration name.
    ExactName(String),
    /// Exact canonical project-relative path.
    ExactPath(NormalizedPath),
    /// Exact source reference text, including unresolved references.
    ExactReference(String),
}

impl fmt::Debug for ContextAnchor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let variant = match self {
            Self::ExactName(_) => "ExactName",
            Self::ExactPath(_) => "ExactPath",
            Self::ExactReference(_) => "ExactReference",
        };
        write!(formatter, "{variant}(<redacted>)")
    }
}

/// One packet request. Its debug form intentionally redacts query and anchors.
pub struct ContextRequest {
    project_id: ProjectId,
    query: String,
    freshness: IndexFreshness,
    budget: ContextBudget,
    anchors: Vec<ContextAnchor>,
}

impl ContextRequest {
    /// Create a bounded context request.
    pub fn new(
        project_id: ProjectId,
        query: impl Into<String>,
        freshness: IndexFreshness,
        budget: ContextBudget,
    ) -> Result<Self, RetrievalError> {
        let query = validate_query(query.into())?;
        Ok(Self {
            project_id,
            query,
            freshness,
            budget,
            anchors: Vec::new(),
        })
    }

    /// Add one exact lookup anchor while preserving the request bounds.
    pub fn with_anchor(mut self, anchor: ContextAnchor) -> Result<Self, RetrievalError> {
        if self.anchors.len() >= MAX_ANCHORS {
            return Err(invalid("anchors"));
        }
        validate_anchor(&anchor)?;
        self.anchors.push(anchor);
        Ok(self)
    }

    pub(crate) const fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    pub(crate) fn query(&self) -> &str {
        &self.query
    }

    pub(crate) const fn freshness(&self) -> IndexFreshness {
        self.freshness
    }

    pub(crate) const fn budget(&self) -> ContextBudget {
        self.budget
    }

    pub(crate) fn anchors(&self) -> &[ContextAnchor] {
        &self.anchors
    }
}

impl fmt::Debug for ContextRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContextRequest")
            .field("project_id", &self.project_id)
            .field("query", &Redacted)
            .field("freshness", &self.freshness)
            .field("budget", &self.budget)
            .field("anchors", &RedactedCount(self.anchors.len()))
            .finish()
    }
}

struct Redacted;

impl fmt::Debug for Redacted {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

struct RedactedCount(usize);

impl fmt::Debug for RedactedCount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "<redacted:{}>", self.0)
    }
}

/// Direction used by the public graph result and evidence provenance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TraversalDirection {
    /// Source to target.
    Outgoing,
    /// Target back to source.
    Incoming,
}

/// Bounded graph request rooted at one or more symbols.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraversalRequest {
    project_id: ProjectId,
    roots: Vec<SymbolId>,
    budget: TraversalBudget,
}

impl TraversalRequest {
    /// Validate roots and normalize their order before any database work.
    pub fn new(
        project_id: ProjectId,
        roots: impl IntoIterator<Item = SymbolId>,
        budget: TraversalBudget,
    ) -> Result<Self, RetrievalError> {
        let roots = roots.into_iter().collect::<BTreeSet<_>>();
        if roots.is_empty() || roots.len() > MAX_ROOTS {
            return Err(invalid("roots"));
        }
        Ok(Self {
            project_id,
            roots: roots.into_iter().collect(),
            budget,
        })
    }

    pub(crate) const fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    /// Deterministically sorted graph roots.
    #[must_use]
    pub fn roots(&self) -> &[SymbolId] {
        &self.roots
    }

    pub(crate) const fn budget(&self) -> TraversalBudget {
        self.budget
    }
}

/// Exact path result, including declarations when the file has any.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ExactPathResult {
    file: CurrentFileRecord,
    symbols: Vec<CurrentSymbolRecord>,
}

impl ExactPathResult {
    pub(crate) const fn new(file: CurrentFileRecord, symbols: Vec<CurrentSymbolRecord>) -> Self {
        Self { file, symbols }
    }

    /// Exact current-generation file.
    #[must_use]
    pub const fn file(&self) -> &CurrentFileRecord {
        &self.file
    }

    /// Declarations ordered by source position.
    #[must_use]
    pub fn symbols(&self) -> &[CurrentSymbolRecord] {
        &self.symbols
    }
}

/// One graph hop that justified including a symbol.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TraversalHop {
    from_symbol_id: SymbolId,
    to_symbol_id: SymbolId,
    edge_kind: String,
    confidence: f32,
    provenance: String,
}

impl TraversalHop {
    pub(crate) fn new(
        from_symbol_id: SymbolId,
        to_symbol_id: SymbolId,
        edge_kind: String,
        confidence: f32,
        provenance: String,
    ) -> Self {
        Self {
            from_symbol_id,
            to_symbol_id,
            edge_kind,
            confidence,
            provenance,
        }
    }

    /// Symbol at the preceding depth.
    #[must_use]
    pub const fn from_symbol_id(&self) -> &SymbolId {
        &self.from_symbol_id
    }

    /// Newly discovered symbol.
    #[must_use]
    pub const fn to_symbol_id(&self) -> &SymbolId {
        &self.to_symbol_id
    }

    /// Stable relation name.
    #[must_use]
    pub fn edge_kind(&self) -> &str {
        &self.edge_kind
    }

    /// Extractor confidence for this relation.
    #[must_use]
    pub const fn confidence(&self) -> f32 {
        self.confidence
    }

    /// Stable extractor provenance label.
    #[must_use]
    pub fn provenance(&self) -> &str {
        &self.provenance
    }
}

/// Hydrated symbol reached by a structural traversal.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TraversalNode {
    symbol: CurrentSymbolRecord,
    depth: u8,
    via: TraversalHop,
}

impl TraversalNode {
    pub(crate) const fn new(symbol: CurrentSymbolRecord, depth: u8, via: TraversalHop) -> Self {
        Self { symbol, depth, via }
    }

    /// Current-generation symbol.
    #[must_use]
    pub const fn symbol(&self) -> &CurrentSymbolRecord {
        &self.symbol
    }

    /// One-based graph distance from the nearest root.
    #[must_use]
    pub const fn depth(&self) -> u8 {
        self.depth
    }

    /// First deterministic hop that discovered this symbol.
    #[must_use]
    pub const fn via(&self) -> &TraversalHop {
        &self.via
    }
}

/// Deterministic bounded callers, callees, or impact result.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TraversalResult {
    direction: TraversalDirection,
    roots: Vec<SymbolId>,
    nodes: Vec<TraversalNode>,
    truncated: bool,
}

impl TraversalResult {
    pub(crate) const fn new(
        direction: TraversalDirection,
        roots: Vec<SymbolId>,
        nodes: Vec<TraversalNode>,
        truncated: bool,
    ) -> Self {
        Self {
            direction,
            roots,
            nodes,
            truncated,
        }
    }

    /// Traversal direction.
    #[must_use]
    pub const fn direction(&self) -> TraversalDirection {
        self.direction
    }

    /// Sorted root identities.
    #[must_use]
    pub fn roots(&self) -> &[SymbolId] {
        &self.roots
    }

    /// Nodes ordered by distance, path, position, and identity.
    #[must_use]
    pub fn nodes(&self) -> &[TraversalNode] {
        &self.nodes
    }

    /// Whether an edge or node bound cut off candidates.
    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

/// One test declaration affected through reverse structural traversal.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AffectedTest {
    symbol: CurrentSymbolRecord,
    distance: u8,
    reason: String,
}

/// Bounded affected-test discovery result with explicit truncation.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AffectedTestsResult {
    tests: Vec<AffectedTest>,
    truncated: bool,
}

impl AffectedTestsResult {
    pub(crate) const fn new(tests: Vec<AffectedTest>, truncated: bool) -> Self {
        Self { tests, truncated }
    }

    /// Deterministically ordered test candidates.
    #[must_use]
    pub fn tests(&self) -> &[AffectedTest] {
        &self.tests
    }

    /// Whether the traversal or output limit omitted candidates.
    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

impl AffectedTest {
    pub(crate) fn new(symbol: CurrentSymbolRecord, distance: u8, reason: String) -> Self {
        Self {
            symbol,
            distance,
            reason,
        }
    }

    /// Test symbol/file evidence.
    #[must_use]
    pub const fn symbol(&self) -> &CurrentSymbolRecord {
        &self.symbol
    }

    /// Graph distance from the changed root.
    #[must_use]
    pub const fn distance(&self) -> u8 {
        self.distance
    }

    /// Stable relation or path-classification reason.
    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

/// Why an evidence item was admitted to a packet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceReason {
    /// Exact symbol-name anchor.
    ExactName,
    /// Exact canonical-path anchor.
    ExactPath,
    /// Exact source-reference anchor.
    ExactReference,
    /// Current-generation ParadeDB BM25 candidate.
    Bm25,
    /// Bounded structural expansion from an anchored candidate.
    Graph,
}

/// Compact serializable evidence with explicit component provenance.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EvidenceItem {
    generation_id: GenerationId,
    file_id: Option<FileId>,
    symbol_id: Option<SymbolId>,
    document_id: Option<DocumentId>,
    path: String,
    qualified_name: String,
    start_line: Option<u32>,
    end_line: Option<u32>,
    reasons: Vec<EvidenceReason>,
    bm25_rank: Option<u16>,
    bm25_components: Vec<SearchComponent>,
    graph_depth: Option<u8>,
    graph_edge_kind: Option<String>,
}

impl EvidenceItem {
    pub(crate) fn from_symbol(symbol: &CurrentSymbolRecord, reason: EvidenceReason) -> Self {
        Self {
            generation_id: symbol.generation_id().clone(),
            file_id: Some(symbol.file_id().clone()),
            symbol_id: Some(symbol.symbol_id().clone()),
            document_id: None,
            path: symbol.path().as_str().to_owned(),
            qualified_name: symbol.qualified_name().to_owned(),
            start_line: Some(symbol.start_line()),
            end_line: Some(symbol.end_line()),
            reasons: vec![reason],
            bm25_rank: None,
            bm25_components: Vec::new(),
            graph_depth: None,
            graph_edge_kind: None,
        }
    }

    pub(crate) fn from_file(file: &CurrentFileRecord) -> Self {
        Self {
            generation_id: file.generation_id().clone(),
            file_id: Some(file.file_id().clone()),
            symbol_id: None,
            document_id: None,
            path: file.path().as_str().to_owned(),
            qualified_name: String::new(),
            start_line: None,
            end_line: None,
            reasons: vec![EvidenceReason::ExactPath],
            bm25_rank: None,
            bm25_components: Vec::new(),
            graph_depth: None,
            graph_edge_kind: None,
        }
    }

    pub(crate) fn from_reference(reference: &CurrentReferenceRecord) -> Self {
        Self {
            generation_id: reference.generation_id().clone(),
            file_id: Some(reference.file_id().clone()),
            symbol_id: reference
                .target_symbol_id()
                .or(reference.owner_symbol_id())
                .cloned(),
            document_id: None,
            path: reference.path().as_str().to_owned(),
            qualified_name: reference.reference_name().to_owned(),
            start_line: None,
            end_line: None,
            reasons: vec![EvidenceReason::ExactReference],
            bm25_rank: None,
            bm25_components: Vec::new(),
            graph_depth: None,
            graph_edge_kind: None,
        }
    }

    pub(crate) fn from_search_hit(hit: &SearchHit, rank: u16) -> Self {
        Self {
            generation_id: hit.generation_id().clone(),
            file_id: hit.file_id().cloned(),
            symbol_id: hit.symbol_id().cloned(),
            document_id: Some(hit.document_id().clone()),
            path: hit.path().to_owned(),
            qualified_name: hit.qualified_name().to_owned(),
            start_line: None,
            end_line: None,
            reasons: vec![EvidenceReason::Bm25],
            bm25_rank: Some(rank),
            bm25_components: hit.components().to_vec(),
            graph_depth: None,
            graph_edge_kind: None,
        }
    }

    pub(crate) fn from_traversal_node(node: &TraversalNode) -> Self {
        let mut item = Self::from_symbol(node.symbol(), EvidenceReason::Graph);
        item.graph_depth = Some(node.depth());
        item.graph_edge_kind = Some(node.via().edge_kind().to_owned());
        item
    }

    /// Published generation identity.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Canonical project-relative path.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Declaration/reference name when available.
    #[must_use]
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    /// Ordered admission reasons.
    #[must_use]
    pub fn reasons(&self) -> &[EvidenceReason] {
        &self.reasons
    }

    /// One-based BM25 rank within this packet's candidate channel.
    #[must_use]
    pub const fn bm25_rank(&self) -> Option<u16> {
        self.bm25_rank
    }

    /// Qualified-name/code/natural-text fields contributing to BM25 matching.
    #[must_use]
    pub fn bm25_components(&self) -> &[SearchComponent] {
        &self.bm25_components
    }

    /// Symbol identity when this is symbol-backed evidence.
    #[must_use]
    pub const fn symbol_id(&self) -> Option<&SymbolId> {
        self.symbol_id.as_ref()
    }

    /// Search-document identity when this came from BM25.
    #[must_use]
    pub const fn document_id(&self) -> Option<&DocumentId> {
        self.document_id.as_ref()
    }

    /// File identity when this is file-backed evidence.
    #[must_use]
    pub const fn file_id(&self) -> Option<&FileId> {
        self.file_id.as_ref()
    }

    pub(crate) fn start_line(&self) -> Option<u32> {
        self.start_line
    }

    pub(crate) fn priority(&self) -> u8 {
        self.reasons
            .iter()
            .map(|reason| match reason {
                EvidenceReason::ExactName => 0,
                EvidenceReason::ExactPath => 1,
                EvidenceReason::ExactReference => 2,
                EvidenceReason::Bm25 => 3,
                EvidenceReason::Graph => 4,
            })
            .min()
            .unwrap_or(u8::MAX)
    }

    pub(crate) fn merge(&mut self, mut other: Self) {
        self.reasons.append(&mut other.reasons);
        self.reasons.sort_unstable();
        self.reasons.dedup();
        self.bm25_components.append(&mut other.bm25_components);
        self.bm25_components.sort_unstable();
        self.bm25_components.dedup();
        self.bm25_rank = match (self.bm25_rank, other.bm25_rank) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left @ Some(_), None) => left,
            (None, right) => right,
        };
        self.graph_depth = match (self.graph_depth, other.graph_depth) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left @ Some(_), None) => left,
            (None, right) => right,
        };
        if self.graph_edge_kind.is_none() {
            self.graph_edge_kind = other.graph_edge_kind;
        }
        if self.document_id.is_none() {
            self.document_id = other.document_id;
        }
    }

    pub(crate) fn key(&self) -> String {
        if let Some(symbol_id) = &self.symbol_id {
            return format!("symbol:{symbol_id}");
        }
        if let Some(document_id) = &self.document_id {
            return format!("document:{document_id}");
        }
        if let Some(file_id) = &self.file_id {
            return format!("file:{file_id}:{}", self.qualified_name);
        }
        format!("path:{}:{}", self.path, self.qualified_name)
    }

    #[cfg(test)]
    pub(crate) fn fixture(path: &str, qualified_name: &str, reason: EvidenceReason) -> Self {
        let generation_id = match GenerationId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
            Ok(value) => value,
            Err(error) => panic!("fixture generation id is invalid: {error}"),
        };
        Self {
            generation_id,
            file_id: None,
            symbol_id: None,
            document_id: None,
            path: path.to_owned(),
            qualified_name: qualified_name.to_owned(),
            start_line: None,
            end_line: None,
            reasons: vec![reason],
            bm25_rank: None,
            bm25_components: Vec::new(),
            graph_depth: None,
            graph_edge_kind: None,
        }
    }
}

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

/// Compact deterministic context packet suitable for a later AI boundary.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ContextPacket {
    generation: Option<GenerationEvidence>,
    freshness: IndexFreshness,
    confidence: RetrievalConfidence,
    abstention: Option<ContextAbstention>,
    evidence: Vec<EvidenceItem>,
    affected_tests: Vec<AffectedTest>,
    truncated: bool,
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

impl ReviewBudget {
    /// Build a fully bounded review budget.
    pub const fn new(
        symbols_per_file: u16,
        root_limit: u16,
        traversal: TraversalBudget,
        evidence_limit: u16,
        affected_test_limit: u16,
    ) -> Result<Self, RetrievalError> {
        if symbols_per_file == 0 || symbols_per_file > MAX_EXACT_RESULTS {
            return Err(invalid("symbols_per_file"));
        }
        if root_limit == 0 || root_limit > MAX_REVIEW_ROOTS {
            return Err(invalid("root_limit"));
        }
        if evidence_limit == 0 || evidence_limit > MAX_PACKET_EVIDENCE {
            return Err(invalid("evidence_limit"));
        }
        if affected_test_limit == 0 || affected_test_limit > MAX_AFFECTED_TESTS {
            return Err(invalid("affected_test_limit"));
        }
        Ok(Self {
            symbols_per_file,
            root_limit,
            traversal,
            evidence_limit,
            affected_test_limit,
        })
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

impl Default for ReviewBudget {
    fn default() -> Self {
        Self {
            symbols_per_file: 100,
            root_limit: 32,
            traversal: TraversalBudget {
                max_depth: 3,
                max_nodes: 200,
            },
            evidence_limit: 50,
            affected_test_limit: 50,
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

impl ReviewRequest {
    /// Validate, deduplicate, and sort changed paths before database work.
    pub fn new(
        project_id: Option<ProjectId>,
        changed_paths: impl IntoIterator<Item = NormalizedPath>,
        freshness: IndexFreshness,
        budget: ReviewBudget,
        changed_files_truncated: bool,
    ) -> Result<Self, RetrievalError> {
        let changed_paths = changed_paths.into_iter().collect::<BTreeSet<_>>();
        if changed_paths.len() > MAX_REVIEW_CHANGED_PATHS {
            return Err(invalid("changed_paths"));
        }
        Ok(Self {
            project_id,
            changed_paths: changed_paths.into_iter().collect(),
            freshness,
            budget,
            changed_files_truncated,
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
    changed_files: bool,
    symbol_roots: bool,
    graph: bool,
    affected_tests: bool,
    evidence: bool,
}

impl ReviewTruncation {
    pub(crate) const fn new(
        changed_files: bool,
        symbol_roots: bool,
        graph: bool,
        affected_tests: bool,
    ) -> Self {
        Self {
            changed_files,
            symbol_roots,
            graph,
            affected_tests,
            evidence: false,
        }
    }

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
    generation: Option<GenerationEvidence>,
    freshness: IndexFreshness,
    confidence: RetrievalConfidence,
    abstention: Option<ReviewAbstention>,
    indexed_changed_files: Vec<NormalizedPath>,
    evidence: Vec<EvidenceItem>,
    affected_tests: Vec<AffectedTest>,
    truncation: ReviewTruncation,
}

impl ReviewPacket {
    pub(crate) const fn new(
        generation: Option<GenerationEvidence>,
        freshness: IndexFreshness,
        decision: (RetrievalConfidence, Option<ReviewAbstention>),
        indexed_changed_files: Vec<NormalizedPath>,
        evidence: Vec<EvidenceItem>,
        affected_tests: Vec<AffectedTest>,
        truncation: ReviewTruncation,
    ) -> Self {
        let (confidence, abstention) = decision;
        Self {
            generation,
            freshness,
            confidence,
            abstention,
            indexed_changed_files,
            evidence,
            affected_tests,
            truncation,
        }
    }

    /// Published generation provenance, absent before the first index.
    #[must_use]
    pub const fn generation(&self) -> Option<&GenerationEvidence> {
        self.generation.as_ref()
    }

    /// Live-source relationship supplied by the project runtime.
    #[must_use]
    pub const fn freshness(&self) -> IndexFreshness {
        self.freshness
    }

    /// Explainable review confidence.
    #[must_use]
    pub const fn confidence(&self) -> RetrievalConfidence {
        self.confidence
    }

    /// Explicit insufficiency reason.
    #[must_use]
    pub const fn abstention(&self) -> Option<ReviewAbstention> {
        self.abstention
    }

    /// Changed paths found in the current immutable generation.
    #[must_use]
    pub fn indexed_changed_files(&self) -> &[NormalizedPath] {
        &self.indexed_changed_files
    }

    /// Exact changed-file and bounded graph-impact evidence.
    #[must_use]
    pub fn evidence(&self) -> &[EvidenceItem] {
        &self.evidence
    }

    /// Bounded reverse-impact test candidates.
    #[must_use]
    pub fn affected_tests(&self) -> &[AffectedTest] {
        &self.affected_tests
    }

    /// Explicit per-stage truncation flags.
    #[must_use]
    pub const fn truncation(&self) -> ReviewTruncation {
        self.truncation
    }
}

impl ContextPacket {
    pub(crate) const fn new(
        generation: Option<GenerationEvidence>,
        freshness: IndexFreshness,
        confidence: RetrievalConfidence,
        abstention: Option<ContextAbstention>,
        evidence: Vec<EvidenceItem>,
        affected_tests: Vec<AffectedTest>,
        truncated: bool,
    ) -> Self {
        Self {
            generation,
            freshness,
            confidence,
            abstention,
            evidence,
            affected_tests,
            truncated,
        }
    }

    /// Published generation provenance, absent when no current pointer exists.
    #[must_use]
    pub const fn generation(&self) -> Option<&GenerationEvidence> {
        self.generation.as_ref()
    }

    /// Caller-owned working-tree freshness assessment.
    #[must_use]
    pub const fn freshness(&self) -> IndexFreshness {
        self.freshness
    }

    /// Explainable packet confidence.
    #[must_use]
    pub const fn confidence(&self) -> RetrievalConfidence {
        self.confidence
    }

    /// Explicit abstention reason, if consumers should seek more context.
    #[must_use]
    pub const fn abstention(&self) -> Option<ContextAbstention> {
        self.abstention
    }

    /// Compact, deterministically ordered evidence.
    #[must_use]
    pub fn evidence(&self) -> &[EvidenceItem] {
        &self.evidence
    }

    /// Reverse-impact test candidates.
    #[must_use]
    pub fn affected_tests(&self) -> &[AffectedTest] {
        &self.affected_tests
    }

    /// Whether any explicit result bound omitted candidates.
    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

fn validate_query(query: String) -> Result<String, RetrievalError> {
    let query = query.trim().to_owned();
    if query.is_empty() || query.len() > MAX_QUERY_BYTES || query.contains('\0') {
        return Err(invalid("query"));
    }
    Ok(query)
}

fn validate_anchor(anchor: &ContextAnchor) -> Result<(), RetrievalError> {
    let value = match anchor {
        ContextAnchor::ExactName(value) | ContextAnchor::ExactReference(value) => value,
        ContextAnchor::ExactPath(_) => return Ok(()),
    };
    if value.trim().is_empty() || value.len() > 4_096 || value.contains('\0') {
        return Err(invalid("anchor"));
    }
    Ok(())
}

const fn invalid(field: &'static str) -> RetrievalError {
    RetrievalError::InvalidInput { field }
}
