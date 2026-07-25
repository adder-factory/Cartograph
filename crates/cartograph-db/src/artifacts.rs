use std::{collections::BTreeMap, time::Duration};

use cartograph_domain::{
    ContentDigest, GenerationId, ModelId, NormalizedPath, ProjectId, SymbolId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, StorageError,
    database::{quoted_schema, set_local_statement_timeout},
};

const ARTIFACT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ARTIFACT_BODY_BYTES: usize = 65_536;
const MAX_ARTIFACT_KEY_BYTES: usize = 4_096;
const MAX_ARTIFACT_METADATA_BYTES: usize = 65_536;
const MAX_ARTIFACT_LIMIT: u16 = 500;
const MAX_INLINE_FILE_SUMMARIES: usize = 80;
const MAX_SUMMARY_BATCH: u16 = 40;
const MAX_STRUCTURAL_SUMMARY_BATCH: u16 = 320;
const MAX_NEIGHBOR_SUMMARY_BATCH: u16 = 320;
const MAX_NEIGHBOR_SUMMARY_SOURCES: usize = 2_560;
const MAX_FILE_SUMMARY_BATCH: u16 = 200;
const MAX_SUMMARY_ROLLUP_ITEMS: u16 = 50;
const MAX_MODULE_SUMMARY_ROLLUP_ITEMS: u16 = 30;
const MIN_MODULE_SUMMARY_SYMBOLS: u64 = 3;
const MAX_ROLE_BATCH: u16 = 320;
const SUMMARY_SOURCE_MAXIMUM_CHARACTERS: i32 = 2_048;
const SUMMARY_SIGNATURE_MAXIMUM_CHARACTERS: i32 = 1_024;
const SUMMARY_ROLLUP_ITEM_MAXIMUM_CHARACTERS: i32 = 600;
const ROLE_EVIDENCE_MAXIMUM_CHARACTERS: i32 = 2_048;
const DEFAULT_SUMMARY_MINIMUM_BODY_LINES: u32 = 4;
const DEFAULT_SUMMARY_DOCSTRING_THRESHOLD: u32 = 20;
const MAX_SUMMARY_MINIMUM_BODY_LINES: u32 = 1_000_000;
const MAX_SUMMARY_KIND_OVERRIDES: usize = 128;
const MAX_SUMMARY_KIND_BYTES: usize = 64;

/// Exact candidate policy shared by summary backlog and readiness queries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SummaryCandidatePolicy {
    minimum_body_lines: u32,
    minimum_body_lines_by_kind: BTreeMap<String, u32>,
    existing_docstring_char_threshold: u32,
}

impl Default for SummaryCandidatePolicy {
    fn default() -> Self {
        Self {
            minimum_body_lines: DEFAULT_SUMMARY_MINIMUM_BODY_LINES,
            minimum_body_lines_by_kind: BTreeMap::from([("route".to_owned(), 1)]),
            existing_docstring_char_threshold: DEFAULT_SUMMARY_DOCSTRING_THRESHOLD,
        }
    }
}

impl SummaryCandidatePolicy {
    pub fn new(
        minimum_body_lines: u32,
        minimum_body_lines_by_kind: BTreeMap<String, u32>,
    ) -> Result<Self, StorageError> {
        if minimum_body_lines > MAX_SUMMARY_MINIMUM_BODY_LINES
            || minimum_body_lines_by_kind.len() > MAX_SUMMARY_KIND_OVERRIDES
            || minimum_body_lines_by_kind.iter().any(|(kind, floor)| {
                kind.is_empty()
                    || kind.len() > MAX_SUMMARY_KIND_BYTES
                    || kind.chars().any(char::is_control)
                    || *floor > MAX_SUMMARY_MINIMUM_BODY_LINES
            })
        {
            return Err(StorageError::InvalidInput {
                field: "summary_candidate_policy",
            });
        }
        Ok(Self {
            minimum_body_lines,
            minimum_body_lines_by_kind,
            existing_docstring_char_threshold: DEFAULT_SUMMARY_DOCSTRING_THRESHOLD,
        })
    }

    fn minimum_body_lines_json(&self) -> Result<String, StorageError> {
        serde_json::to_string(&self.minimum_body_lines_by_kind).map_err(|_| {
            StorageError::InvalidInput {
                field: "summary_candidate_policy",
            }
        })
    }
}

/// Durable agent-memory family.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentArtifactKind {
    Note,
    Role,
    Summary,
    Session,
}

impl AgentArtifactKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Role => "role",
            Self::Summary => "summary",
            Self::Session => "session",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "note" => Some(Self::Note),
            "role" => Some(Self::Role),
            "summary" => Some(Self::Summary),
            "session" => Some(Self::Session),
            _ => None,
        }
    }
}

/// Stable scope axis for notes, summaries, roles, and sessions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentArtifactScope {
    Project,
    Module,
    File,
    Symbol,
    Session,
}

impl AgentArtifactScope {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Module => "module",
            Self::File => "file",
            Self::Symbol => "symbol",
            Self::Session => "session",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "project" => Some(Self::Project),
            "module" => Some(Self::Module),
            "file" => Some(Self::File),
            "symbol" => Some(Self::Symbol),
            "session" => Some(Self::Session),
            _ => None,
        }
    }
}

/// Lifecycle for one durable artifact.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentArtifactState {
    Pending,
    Active,
    Complete,
    Stale,
    Archived,
}

impl AgentArtifactState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Complete => "complete",
            Self::Stale => "stale",
            Self::Archived => "archived",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "active" => Some(Self::Active),
            "complete" => Some(Self::Complete),
            "stale" => Some(Self::Stale),
            "archived" => Some(Self::Archived),
            _ => None,
        }
    }
}

/// Validated write payload for a PostgreSQL-backed agent artifact.
#[derive(Clone, Debug)]
pub struct NewAgentArtifact {
    kind: AgentArtifactKind,
    scope: AgentArtifactScope,
    scope_key: String,
    body: String,
    metadata: Value,
    generation_id: Option<GenerationId>,
    source_digest: Option<ContentDigest>,
    state: AgentArtifactState,
}

impl NewAgentArtifact {
    /// Create a bounded active artifact without generation coupling.
    pub fn new(
        kind: AgentArtifactKind,
        scope: AgentArtifactScope,
        scope_key: impl Into<String>,
        body: impl Into<String>,
    ) -> Result<Self, StorageError> {
        let scope_key = scope_key.into();
        let body = body.into();
        validate_scope_key(&scope_key)?;
        validate_body(&body, AgentArtifactState::Active)?;
        Ok(Self {
            kind,
            scope,
            scope_key,
            body,
            metadata: Value::Object(serde_json::Map::new()),
            generation_id: None,
            source_digest: None,
            state: AgentArtifactState::Active,
        })
    }

    /// Attach bounded JSON-object provenance.
    pub fn with_metadata(mut self, metadata: Value) -> Result<Self, StorageError> {
        validate_metadata(&metadata)?;
        self.metadata = metadata;
        Ok(self)
    }

    /// Bind the artifact to one immutable generation.
    #[must_use]
    pub fn with_generation(mut self, generation_id: GenerationId) -> Self {
        self.generation_id = Some(generation_id);
        self
    }

    /// Record the source digest used to produce the artifact.
    #[must_use]
    pub fn with_source_digest(mut self, source_digest: ContentDigest) -> Self {
        self.source_digest = Some(source_digest);
        self
    }

    /// Select an explicit lifecycle state.
    pub fn with_state(mut self, state: AgentArtifactState) -> Result<Self, StorageError> {
        validate_body(&self.body, state)?;
        self.state = state;
        Ok(self)
    }
}

/// Bounded durable artifact listing filters.
#[derive(Clone, Copy, Debug)]
pub struct AgentArtifactQuery<'query> {
    kind: Option<AgentArtifactKind>,
    scope: Option<AgentArtifactScope>,
    scope_key: Option<&'query str>,
    body_equals: Option<&'query str>,
    note_kind: Option<&'query str>,
    since_unix_ms: Option<f64>,
    current_generation_only: bool,
    state: Option<AgentArtifactState>,
    limit: u16,
}

impl<'query> AgentArtifactQuery<'query> {
    /// Create an unfiltered bounded listing.
    pub fn new(limit: u16) -> Result<Self, StorageError> {
        validate_limit(limit, MAX_ARTIFACT_LIMIT)?;
        Ok(Self {
            kind: None,
            scope: None,
            scope_key: None,
            body_equals: None,
            note_kind: None,
            since_unix_ms: None,
            current_generation_only: false,
            state: None,
            limit,
        })
    }

    #[must_use]
    pub const fn with_kind(mut self, kind: AgentArtifactKind) -> Self {
        self.kind = Some(kind);
        self
    }

    #[must_use]
    pub const fn with_scope(mut self, scope: AgentArtifactScope) -> Self {
        self.scope = Some(scope);
        self
    }

    pub fn with_scope_key(mut self, scope_key: &'query str) -> Result<Self, StorageError> {
        validate_scope_key(scope_key)?;
        self.scope_key = Some(scope_key);
        Ok(self)
    }

    /// Filter exact bounded body labels, used for role listings.
    pub fn with_body(mut self, body: &'query str) -> Result<Self, StorageError> {
        if body.is_empty() || body.len() > 256 || body.contains('\0') {
            return Err(StorageError::InvalidInput {
                field: "artifact_body_filter",
            });
        }
        self.body_equals = Some(body);
        Ok(self)
    }

    /// Filter a note subtype stored in validated metadata.
    pub fn with_note_kind(mut self, note_kind: &'query str) -> Result<Self, StorageError> {
        if !matches!(note_kind, "note" | "question" | "followup" | "bookmark") {
            return Err(StorageError::InvalidInput { field: "note_kind" });
        }
        self.note_kind = Some(note_kind);
        Ok(self)
    }

    /// Restrict results to artifacts written at or after a Unix-millisecond instant.
    pub fn since_unix_ms(mut self, since_unix_ms: f64) -> Result<Self, StorageError> {
        if !since_unix_ms.is_finite() || since_unix_ms < 0.0 {
            return Err(StorageError::InvalidInput { field: "since" });
        }
        self.since_unix_ms = Some(since_unix_ms);
        Ok(self)
    }

    /// Restrict generation-coupled artifacts to the published generation.
    #[must_use]
    pub const fn current_generation_only(mut self) -> Self {
        self.current_generation_only = true;
        self
    }

    #[must_use]
    pub const fn with_state(mut self, state: AgentArtifactState) -> Self {
        self.state = Some(state);
        self
    }
}

/// One durable PostgreSQL-backed artifact.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentArtifactRecord {
    id: u64,
    artifact_id: String,
    kind: AgentArtifactKind,
    scope: AgentArtifactScope,
    scope_key: String,
    body: String,
    metadata: Value,
    generation_id: Option<String>,
    source_digest: Option<String>,
    state: AgentArtifactState,
    created_at: String,
    updated_at: String,
}

/// One symbol whose structural digest has no matching complete summary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSummarySymbol {
    generation_id: String,
    symbol_id: String,
    path: String,
    language: String,
    symbol_kind: String,
    qualified_name: String,
    signature: String,
    start_line: u32,
    end_line: u32,
    content_hash: String,
    code: String,
    code_truncated: bool,
    priority: bool,
}

/// One bounded outgoing edge used by deterministic summary rules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSummaryEdge {
    edge_kind: String,
    target_symbol_id: String,
    target_kind: String,
    target_name: String,
    target_qualified_name: String,
    target_path: String,
    target_summary: Option<String>,
}

/// One current thin symbol whose exact structural digest has no cached summary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingStructuralSummary {
    generation_id: String,
    symbol_id: String,
    path: String,
    symbol_kind: String,
    name: String,
    qualified_name: String,
    signature: String,
    code: String,
    start_line: u32,
    end_line: u32,
    content_hash: String,
    declaration_only: bool,
    edges: Vec<StructuralSummaryEdge>,
}

/// One current embedded symbol with no digest-compatible summary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingNeighborSummary {
    generation_id: String,
    symbol_id: String,
    symbol_kind: String,
    name: String,
    content_hash: String,
}

/// One exact non-propagated current summary eligible as neighbor evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborSummarySource {
    symbol_id: String,
    symbol_kind: String,
    name: String,
    summary: String,
    model: String,
}

/// One summarized symbol used as bounded evidence for a file roll-up.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRollupItem {
    symbol_id: String,
    qualified_name: String,
    symbol_kind: String,
    summary: String,
}

/// One current file whose symbol-summary roll-up is missing or stale.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFileSummary {
    generation_id: String,
    path: String,
    file_content_hash: String,
    content_hash: String,
    summarized_symbols: u64,
    items: Vec<SummaryRollupItem>,
    items_truncated: bool,
}

/// Digest-fenced file-summary publication request.
pub struct FileSummarySaveRequest<'a> {
    path: &'a NormalizedPath,
    expected_digest: &'a ContentDigest,
    anchor_digest: &'a ContentDigest,
    summary: &'a str,
    model: &'a str,
    item_limit: u16,
    generation_mode: &'static str,
}

/// Exact semantic-neighbor publication request. The database revalidates the
/// source summary, same-kind relation, current generation, and target digest.
pub struct NeighborSummarySaveRequest<'a> {
    symbol_id: &'a SymbolId,
    source_digest: &'a ContentDigest,
    neighbor_symbol_id: &'a SymbolId,
    neighbor_summary: &'a str,
    summary: &'a str,
    embedding_model_id: &'a ModelId,
    similarity: f64,
}

impl<'a> NeighborSummarySaveRequest<'a> {
    pub fn new(
        symbol_id: &'a SymbolId,
        source_digest: &'a ContentDigest,
        neighbor_symbol_id: &'a SymbolId,
        neighbor_summary: &'a str,
        summary: &'a str,
        embedding_model_id: &'a ModelId,
        similarity: f64,
    ) -> Result<Self, StorageError> {
        if symbol_id == neighbor_symbol_id
            || !similarity.is_finite()
            || !(0.0..=1.0).contains(&similarity)
        {
            return Err(StorageError::InvalidInput {
                field: "neighbor_summary",
            });
        }
        validate_body(summary, AgentArtifactState::Complete)?;
        Ok(Self {
            symbol_id,
            source_digest,
            neighbor_symbol_id,
            neighbor_summary,
            summary,
            embedding_model_id,
            similarity,
        })
    }
}

/// One summarized symbol used as bounded evidence for a directory roll-up.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSummaryRollupItem {
    symbol_id: String,
    path: String,
    qualified_name: String,
    symbol_kind: String,
    summary: String,
}

/// One immediate source directory whose module paragraph is missing or stale.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingModuleSummary {
    generation_id: String,
    directory: String,
    content_hash: String,
    summarized_symbols: u64,
    tool_export_constants: u64,
    items: Vec<ModuleSummaryRollupItem>,
    items_truncated: bool,
}

/// Digest-fenced module-summary publication request.
pub struct ModuleSummarySaveRequest<'a> {
    directory: &'a NormalizedPath,
    expected_digest: &'a ContentDigest,
    anchor_digest: &'a ContentDigest,
    summary: &'a str,
    model: &'a str,
    item_limit: u16,
    generation_mode: &'static str,
}

impl<'a> ModuleSummarySaveRequest<'a> {
    pub fn new(
        directory: &'a NormalizedPath,
        expected_digest: &'a ContentDigest,
        anchor_digest: &'a ContentDigest,
        summary: &'a str,
        model: &'a str,
        item_limit: u16,
    ) -> Result<Self, StorageError> {
        validate_body(summary, AgentArtifactState::Complete)?;
        validate_model(model)?;
        validate_limit(item_limit, MAX_MODULE_SUMMARY_ROLLUP_ITEMS)?;
        Ok(Self {
            directory,
            expected_digest,
            anchor_digest,
            summary,
            model,
            item_limit,
            generation_mode: "llm",
        })
    }

    pub fn with_generation_mode(
        mut self,
        generation_mode: &'static str,
    ) -> Result<Self, StorageError> {
        if !matches!(generation_mode, "llm" | "structural_rule") {
            return Err(StorageError::InvalidInput {
                field: "summary_generation_mode",
            });
        }
        self.generation_mode = generation_mode;
        Ok(self)
    }
}

impl<'a> FileSummarySaveRequest<'a> {
    pub fn new(
        path: &'a NormalizedPath,
        expected_digest: &'a ContentDigest,
        anchor_digest: &'a ContentDigest,
        summary: &'a str,
        model: &'a str,
        item_limit: u16,
    ) -> Result<Self, StorageError> {
        validate_body(summary, AgentArtifactState::Complete)?;
        validate_model(model)?;
        validate_limit(item_limit, MAX_SUMMARY_ROLLUP_ITEMS)?;
        Ok(Self {
            path,
            expected_digest,
            anchor_digest,
            summary,
            model,
            item_limit,
            generation_mode: "llm",
        })
    }

    pub fn with_generation_mode(
        mut self,
        generation_mode: &'static str,
    ) -> Result<Self, StorageError> {
        if !matches!(generation_mode, "llm" | "structural_rule") {
            return Err(StorageError::InvalidInput {
                field: "summary_generation_mode",
            });
        }
        self.generation_mode = generation_mode;
        Ok(self)
    }
}

/// One current symbol without a digest/model-compatible role classification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRoleSymbol {
    symbol_id: String,
    path: String,
    language: String,
    symbol_kind: String,
    qualified_name: String,
    signature: String,
    description: String,
    code: String,
    exported: bool,
}

/// Persisted role-classification count.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoleCount {
    role: String,
    symbols: u64,
}

/// Exact current-generation summary coverage with durable model provenance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryCoverageStats {
    eligible_symbols: u64,
    summarized_symbols: u64,
    pending_symbols: u64,
    by_model: BTreeMap<String, u64>,
}

/// One current cached module paragraph.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentModuleSummary {
    directory: String,
    summary: String,
    metadata: Value,
}

/// Exact module-summary total plus one bounded path-ordered page.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentModuleSummaryPage {
    summaries: Vec<CurrentModuleSummary>,
    total: u64,
    truncated: bool,
}

impl CurrentModuleSummaryPage {
    #[must_use]
    pub fn summaries(&self) -> &[CurrentModuleSummary] {
        &self.summaries
    }

    #[must_use]
    pub const fn total(&self) -> u64 {
        self.total
    }

    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }
}

impl CurrentModuleSummary {
    #[must_use]
    pub fn directory(&self) -> &str {
        &self.directory
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.summary
    }

    #[must_use]
    pub const fn metadata(&self) -> &Value {
        &self.metadata
    }
}

impl AgentArtifactRecord {
    /// Monotonic project-visible identity retained for v1 note compatibility.
    #[must_use]
    pub const fn id(&self) -> u64 {
        self.id
    }

    /// Stable public artifact identity used by delete/resume workflows.
    #[must_use]
    pub fn artifact_id(&self) -> &str {
        &self.artifact_id
    }

    /// Artifact scope key, such as a symbol UUID or session label.
    #[must_use]
    pub fn scope_key(&self) -> &str {
        &self.scope_key
    }

    /// Bounded artifact content.
    #[must_use]
    pub fn body(&self) -> &str {
        &self.body
    }

    /// Structured provenance and subtype metadata.
    #[must_use]
    pub const fn metadata(&self) -> &Value {
        &self.metadata
    }
}

impl PendingSummarySymbol {
    /// Exact current-generation symbol identity.
    #[must_use]
    pub fn symbol_id(&self) -> &str {
        &self.symbol_id
    }

    /// Structural digest that must be echoed when saving a summary.
    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    /// Exact immutable generation containing this symbol.
    #[must_use]
    pub fn generation_id(&self) -> &str {
        &self.generation_id
    }

    /// Project-relative path used as summary context.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Indexed source language.
    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }

    /// Extracted symbol kind.
    #[must_use]
    pub fn symbol_kind(&self) -> &str {
        &self.symbol_kind
    }

    /// Extracted qualified name.
    #[must_use]
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    /// Bounded extracted declaration signature.
    #[must_use]
    pub fn signature(&self) -> &str {
        &self.signature
    }

    /// Bounded indexed implementation evidence, never live working-tree text.
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    /// Whether the indexed implementation exceeded the prompt-safe excerpt.
    #[must_use]
    pub const fn code_truncated(&self) -> bool {
        self.code_truncated
    }

    /// Whether a no-hit intent lookup explicitly requested this symbol.
    #[must_use]
    pub const fn priority(&self) -> bool {
        self.priority
    }
}

impl StructuralSummaryEdge {
    #[must_use]
    pub fn edge_kind(&self) -> &str {
        &self.edge_kind
    }

    #[must_use]
    pub fn target_symbol_id(&self) -> &str {
        &self.target_symbol_id
    }

    #[must_use]
    pub fn target_kind(&self) -> &str {
        &self.target_kind
    }

    #[must_use]
    pub fn target_name(&self) -> &str {
        &self.target_name
    }

    #[must_use]
    pub fn target_qualified_name(&self) -> &str {
        &self.target_qualified_name
    }

    #[must_use]
    pub fn target_path(&self) -> &str {
        &self.target_path
    }

    #[must_use]
    pub fn target_summary(&self) -> Option<&str> {
        self.target_summary.as_deref()
    }
}

impl PendingStructuralSummary {
    #[must_use]
    pub fn generation_id(&self) -> &str {
        &self.generation_id
    }

    #[must_use]
    pub fn symbol_id(&self) -> &str {
        &self.symbol_id
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub fn symbol_kind(&self) -> &str {
        &self.symbol_kind
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    #[must_use]
    pub fn signature(&self) -> &str {
        &self.signature
    }

    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    #[must_use]
    pub const fn start_line(&self) -> u32 {
        self.start_line
    }

    #[must_use]
    pub const fn end_line(&self) -> u32 {
        self.end_line
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    #[must_use]
    pub const fn declaration_only(&self) -> bool {
        self.declaration_only
    }

    #[must_use]
    pub fn edges(&self) -> &[StructuralSummaryEdge] {
        &self.edges
    }
}

impl PendingNeighborSummary {
    #[must_use]
    pub fn generation_id(&self) -> &str {
        &self.generation_id
    }

    #[must_use]
    pub fn symbol_id(&self) -> &str {
        &self.symbol_id
    }

    #[must_use]
    pub fn symbol_kind(&self) -> &str {
        &self.symbol_kind
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }
}

impl NeighborSummarySource {
    #[must_use]
    pub fn symbol_id(&self) -> &str {
        &self.symbol_id
    }

    #[must_use]
    pub fn symbol_kind(&self) -> &str {
        &self.symbol_kind
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.summary
    }

    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }
}

impl PendingFileSummary {
    #[must_use]
    pub fn generation_id(&self) -> &str {
        &self.generation_id
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    #[must_use]
    pub fn file_content_hash(&self) -> &str {
        &self.file_content_hash
    }

    #[must_use]
    pub const fn summarized_symbols(&self) -> u64 {
        self.summarized_symbols
    }

    #[must_use]
    pub fn items(&self) -> &[SummaryRollupItem] {
        &self.items
    }

    #[must_use]
    pub const fn items_truncated(&self) -> bool {
        self.items_truncated
    }
}

impl PendingModuleSummary {
    #[must_use]
    pub fn generation_id(&self) -> &str {
        &self.generation_id
    }

    #[must_use]
    pub fn directory(&self) -> &str {
        &self.directory
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    #[must_use]
    pub const fn summarized_symbols(&self) -> u64 {
        self.summarized_symbols
    }

    #[must_use]
    pub const fn tool_export_constants(&self) -> u64 {
        self.tool_export_constants
    }

    #[must_use]
    pub fn items(&self) -> &[ModuleSummaryRollupItem] {
        &self.items
    }

    #[must_use]
    pub const fn items_truncated(&self) -> bool {
        self.items_truncated
    }
}

impl ModuleSummaryRollupItem {
    #[must_use]
    pub fn symbol_id(&self) -> &str {
        &self.symbol_id
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    #[must_use]
    pub fn symbol_kind(&self) -> &str {
        &self.symbol_kind
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.summary
    }
}

impl SummaryRollupItem {
    #[must_use]
    pub fn symbol_id(&self) -> &str {
        &self.symbol_id
    }

    #[must_use]
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    #[must_use]
    pub fn symbol_kind(&self) -> &str {
        &self.symbol_kind
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.summary
    }
}

impl PendingRoleSymbol {
    #[must_use]
    pub fn symbol_id(&self) -> &str {
        &self.symbol_id
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }

    #[must_use]
    pub fn symbol_kind(&self) -> &str {
        &self.symbol_kind
    }

    #[must_use]
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    #[must_use]
    pub fn signature(&self) -> &str {
        &self.signature
    }

    #[must_use]
    pub fn description(&self) -> &str {
        &self.description
    }

    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    #[must_use]
    pub const fn exported(&self) -> bool {
        self.exported
    }
}

impl CartographDatabase {
    /// Append a note/session artifact. Roles and summaries use replacement semantics below.
    pub async fn create_agent_artifact(
        &self,
        project_id: &ProjectId,
        artifact: &NewAgentArtifact,
    ) -> Result<AgentArtifactRecord, StorageError> {
        self.write_artifact(project_id, artifact, false).await
    }

    /// Replace the current role or summary for one exact scope.
    pub async fn replace_scoped_agent_artifact(
        &self,
        project_id: &ProjectId,
        artifact: &NewAgentArtifact,
    ) -> Result<AgentArtifactRecord, StorageError> {
        if !matches!(
            artifact.kind,
            AgentArtifactKind::Role | AgentArtifactKind::Summary
        ) || artifact.state == AgentArtifactState::Archived
        {
            return Err(StorageError::InvalidInput {
                field: "artifact_kind",
            });
        }
        self.write_artifact(project_id, artifact, true).await
    }

    async fn write_artifact(
        &self,
        project_id: &ProjectId,
        artifact: &NewAgentArtifact,
        replace_scope: bool,
    ) -> Result<AgentArtifactRecord, StorageError> {
        validate_artifact(artifact)?;
        let schema = quoted_schema(&self.schema);
        let conflict = if replace_scope {
            r#"ON CONFLICT (project_id, artifact_kind, scope_kind, scope_key)
               WHERE artifact_kind IN ('role', 'summary') AND state <> 'archived'
               DO UPDATE SET body = EXCLUDED.body,
                             metadata = EXCLUDED.metadata,
                             generation_id = EXCLUDED.generation_id,
                             source_digest = EXCLUDED.source_digest,
                             state = EXCLUDED.state,
                             updated_at = clock_timestamp()"#
        } else {
            ""
        };
        let statement = format!(
            r#"INSERT INTO {schema}."agent_artifacts" (
                    project_id, artifact_kind, scope_kind, scope_key, body, metadata,
                    generation_id, source_digest, state
                ) VALUES (
                    CAST($1 AS uuid), $2, $3, $4, $5, CAST($6 AS jsonb),
                    CAST($7 AS uuid), $8, $9
                )
                {conflict}
                RETURNING id, artifact_id::text, artifact_kind, scope_kind, scope_key,
                          body, metadata::text, generation_id::text, source_digest,
                          state, created_at::text, updated_at::text"#,
        );
        let metadata =
            serde_json::to_string(&artifact.metadata).map_err(|_| StorageError::InvalidInput {
                field: "artifact_metadata",
            })?;
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(artifact.kind.as_str())
            .bind(artifact.scope.as_str())
            .bind(&artifact.scope_key)
            .bind(&artifact.body)
            .bind(metadata)
            .bind(artifact.generation_id.as_ref().map(GenerationId::as_str))
            .bind(artifact.source_digest.as_ref().map(ContentDigest::as_str))
            .bind(artifact.state.as_str())
            .fetch_one(&self.pool)
            .await
            .map_err(|_| database_error("write-agent-artifact"))?;
        decode_artifact(&row)
    }

    /// List artifacts newest-first under bounded optional filters.
    pub async fn list_agent_artifacts(
        &self,
        project_id: &ProjectId,
        request: AgentArtifactQuery<'_>,
    ) -> Result<Vec<AgentArtifactRecord>, StorageError> {
        validate_limit(request.limit, MAX_ARTIFACT_LIMIT)?;
        if let Some(scope_key) = request.scope_key {
            validate_scope_key(scope_key)?;
        }
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT id, artifact_id::text, artifact_kind, scope_kind, scope_key,
                      body, metadata::text, generation_id::text, source_digest,
                      state, created_at::text, updated_at::text
                FROM {schema}."agent_artifacts"
                WHERE project_id = CAST($1 AS uuid)
                  AND ($2::text IS NULL OR artifact_kind = $2)
                  AND ($3::text IS NULL OR scope_kind = $3)
                  AND ($4::text IS NULL OR scope_key = $4)
                  AND ($5::text IS NULL OR state = $5)
                  AND ($6::text IS NULL OR body = $6)
                  AND ($7::text IS NULL OR metadata ->> 'noteKind' = $7)
                  AND ($8::double precision IS NULL OR updated_at >= to_timestamp($8 / 1000.0))
                  AND (
                      NOT $9::boolean
                      OR (
                          artifact_kind IN ('role', 'summary')
                          AND scope_kind = 'symbol'
                          AND source_digest IS NOT NULL
                          AND EXISTS (
                              SELECT 1
                              FROM {schema}."projects" AS projects
                              JOIN {schema}."symbols" AS symbols
                                ON symbols.project_id = projects.project_id
                               AND symbols.generation_id = projects.current_generation_id
                              WHERE projects.project_id = CAST($1 AS uuid)
                                AND symbols.symbol_id::text = scope_key
                                AND symbols.structural_digest = source_digest
                          )
                      )
                      OR (
                          artifact_kind = 'summary'
                          AND scope_kind IN ('file', 'module', 'project')
                          AND source_digest IS NOT NULL
                          AND generation_id = (
                              SELECT current_generation_id
                              FROM {schema}."projects"
                              WHERE project_id = CAST($1 AS uuid)
                          )
                      )
                      OR (
                          artifact_kind NOT IN ('role', 'summary')
                          AND generation_id = (
                              SELECT current_generation_id
                              FROM {schema}."projects"
                              WHERE project_id = CAST($1 AS uuid)
                          )
                      )
                  )
                ORDER BY updated_at DESC, id DESC
                LIMIT $10"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| {
                    statement
                        .bind(request.kind.map(AgentArtifactKind::as_str))
                        .bind(request.scope.map(AgentArtifactScope::as_str))
                        .bind(request.scope_key)
                        .bind(request.state.map(AgentArtifactState::as_str))
                        .bind(request.body_equals)
                        .bind(request.note_kind)
                        .bind(request.since_unix_ms)
                        .bind(request.current_generation_only)
                        .bind(i64::from(request.limit))
                },
                project_id,
                "list-agent-artifacts",
            )
            .await?;
        rows.iter().map(decode_artifact).collect()
    }

    /// Batch-read current file paragraphs for one small rendered listing.
    pub async fn current_file_summary_texts(
        &self,
        project_id: &ProjectId,
        paths: &[String],
    ) -> Result<BTreeMap<String, String>, StorageError> {
        if paths.is_empty() || paths.len() > MAX_INLINE_FILE_SUMMARIES {
            return Err(StorageError::InvalidInput {
                field: "file_summary_paths",
            });
        }
        for path in paths {
            NormalizedPath::parse(path).map_err(|_| StorageError::InvalidInput {
                field: "file_summary_paths",
            })?;
        }
        let encoded = serde_json::to_string(paths).map_err(|_| StorageError::InvalidInput {
            field: "file_summary_paths",
        })?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH requested AS (
                    SELECT jsonb_array_elements_text(CAST($2 AS jsonb)) AS path
                )
                SELECT artifacts.scope_key, artifacts.body
                FROM {schema}."agent_artifacts" AS artifacts
                JOIN {schema}."projects" AS projects
                  ON projects.project_id = artifacts.project_id
                 AND projects.current_generation_id = artifacts.generation_id
                JOIN requested ON requested.path = artifacts.scope_key
                WHERE artifacts.project_id = CAST($1 AS uuid)
                  AND artifacts.artifact_kind = 'summary'
                  AND artifacts.scope_kind = 'file'
                  AND artifacts.state = 'complete'
                ORDER BY artifacts.scope_key"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| statement.bind(encoded),
                project_id,
                "current-file-summary-texts",
            )
            .await?;
        rows.iter()
            .map(|row| Ok((text(row, 0)?, text(row, 1)?)))
            .collect()
    }

    /// Read one exact module paragraph or a bounded path-ordered module page.
    pub async fn current_module_summaries(
        &self,
        project_id: &ProjectId,
        directory: Option<&NormalizedPath>,
        limit: u16,
    ) -> Result<CurrentModuleSummaryPage, StorageError> {
        validate_limit(limit, MAX_ARTIFACT_LIMIT)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT artifacts.scope_key, artifacts.body, artifacts.metadata::text,
                       COUNT(*) OVER ()::bigint
                FROM {schema}."agent_artifacts" AS artifacts
                JOIN {schema}."projects" AS projects
                  ON projects.project_id = artifacts.project_id
                 AND projects.current_generation_id = artifacts.generation_id
                WHERE artifacts.project_id = CAST($1 AS uuid)
                  AND artifacts.artifact_kind = 'summary'
                  AND artifacts.scope_kind = 'module'
                  AND artifacts.state = 'complete'
                  AND ($2::text IS NULL OR artifacts.scope_key = $2)
                ORDER BY artifacts.scope_key
                LIMIT $3"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| {
                    statement
                        .bind(directory.map(NormalizedPath::as_str))
                        .bind(i64::from(limit))
                },
                project_id,
                "current-module-summaries",
            )
            .await?;
        let total = rows.first().map_or(Ok(0), |row| nonnegative_u64(row, 3))?;
        let summaries = rows
            .iter()
            .map(|row| {
                let metadata = serde_json::from_str(&text(row, 2)?).map_err(|_| {
                    StorageError::CorruptStoredValue {
                        field: "module_summary",
                    }
                })?;
                Ok(CurrentModuleSummary {
                    directory: text(row, 0)?,
                    summary: text(row, 1)?,
                    metadata,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(CurrentModuleSummaryPage {
            truncated: total
                > u64::try_from(summaries.len()).map_err(|_| StorageError::CorruptStoredValue {
                    field: "module_summary",
                })?,
            summaries,
            total,
        })
    }

    /// Delete one exact project-owned artifact. Returns false when it was absent.
    pub async fn delete_agent_artifact(
        &self,
        project_id: &ProjectId,
        artifact_id: &str,
    ) -> Result<bool, StorageError> {
        if !canonical_uuid(artifact_id) {
            return Err(StorageError::InvalidInput {
                field: "artifact_id",
            });
        }
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"DELETE FROM {schema}."agent_artifacts"
                WHERE project_id = CAST($1 AS uuid)
                  AND artifact_id = CAST($2 AS uuid)"#,
        );
        let result = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(artifact_id)
            .execute(&self.pool)
            .await
            .map_err(|_| database_error("delete-agent-artifact"))?;
        Ok(result.rows_affected() == 1)
    }

    /// Delete one exact project-owned artifact by its monotonic compatibility identity.
    pub async fn delete_agent_artifact_by_id(
        &self,
        project_id: &ProjectId,
        artifact_id: u64,
    ) -> Result<bool, StorageError> {
        let artifact_id = i64::try_from(artifact_id)
            .ok()
            .filter(|artifact_id| *artifact_id > 0)
            .ok_or(StorageError::InvalidInput {
                field: "artifact_id",
            })?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"DELETE FROM {schema}."agent_artifacts"
                WHERE project_id = CAST($1 AS uuid)
                  AND id = $2"#,
        );
        let result = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(artifact_id)
            .execute(&self.pool)
            .await
            .map_err(|_| database_error("delete-agent-artifact-by-id"))?;
        Ok(result.rows_affected() == 1)
    }

    /// Aggregate current persisted symbol-role labels without a row limit.
    pub async fn agent_role_distribution(
        &self,
        project_id: &ProjectId,
    ) -> Result<Vec<AgentRoleCount>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT artifacts.body, COUNT(*)::bigint
                FROM {schema}."agent_artifacts" AS artifacts
                JOIN {schema}."projects" AS projects
                  ON projects.project_id = artifacts.project_id
                JOIN {schema}."symbols" AS symbols
                  ON symbols.project_id = projects.project_id
                 AND symbols.generation_id = projects.current_generation_id
                 AND symbols.symbol_id::text = artifacts.scope_key
                 AND symbols.structural_digest = artifacts.source_digest
                WHERE artifacts.project_id = CAST($1 AS uuid)
                  AND artifacts.artifact_kind = 'role'
                  AND artifacts.scope_kind = 'symbol'
                  AND artifacts.state IN ('active', 'complete')
                GROUP BY artifacts.body
                ORDER BY COUNT(*) DESC, artifacts.body"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| statement,
                project_id,
                "agent-role-distribution",
            )
            .await?;
        rows.iter()
            .map(|row| {
                Ok(AgentRoleCount {
                    role: text(row, 0)?,
                    symbols: nonnegative_u64(row, 1)?,
                })
            })
            .collect()
    }

    /// Aggregate summary coverage without a page-size blind spot.
    ///
    /// A summary counts only when it belongs to the visible generation and
    /// echoes the symbol's current structural digest. Stale artifacts remain
    /// durable for auditability but never inflate readiness.
    pub async fn current_summary_coverage(
        &self,
        project_id: &ProjectId,
    ) -> Result<SummaryCoverageStats, StorageError> {
        self.current_summary_coverage_with_policy(project_id, &SummaryCandidatePolicy::default())
            .await
    }

    /// Aggregate summary coverage under the exact configured candidate floor.
    pub async fn current_summary_coverage_with_policy(
        &self,
        project_id: &ProjectId,
        policy: &SummaryCandidatePolicy,
    ) -> Result<SummaryCoverageStats, StorageError> {
        let body_lines_by_kind = policy.minimum_body_lines_json()?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), eligible AS (
                    SELECT symbols.symbol_id, symbols.generation_id,
                           symbols.structural_digest
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    LEFT JOIN {schema}."search_documents" AS documents
                      ON documents.project_id = symbols.project_id
                     AND documents.generation_id = symbols.generation_id
                     AND documents.symbol_id = symbols.symbol_id
                     AND documents.document_kind = 'symbol'
                    WHERE symbols.project_id = CAST($1 AS uuid)
                      AND symbols.symbol_kind IN (
                          'class', 'function', 'method', 'interface', 'struct',
                          'trait', 'protocol', 'enum', 'type_alias', 'component', 'route'
                      )
                      AND (symbols.end_line - symbols.start_line + 1) >= COALESCE(
                          CAST(NULLIF(CAST($2 AS jsonb) ->> symbols.symbol_kind, '') AS integer),
                          $3
                      )
                      AND length(COALESCE(documents.natural_text, '')) < $4
                ), matched AS (
                    SELECT eligible.symbol_id, summaries.id,
                           COALESCE(NULLIF(summaries.metadata ->> 'model', ''), 'unknown') AS model
                    FROM eligible
                    LEFT JOIN {schema}."agent_artifacts" AS summaries
                      ON summaries.project_id = CAST($1 AS uuid)
                     AND summaries.artifact_kind = 'summary'
                     AND summaries.scope_kind = 'symbol'
                     AND summaries.scope_key = eligible.symbol_id::text
                     AND summaries.source_digest = eligible.structural_digest
                     AND summaries.state = 'complete'
                ), by_model AS (
                    SELECT model, COUNT(*)::bigint AS symbols
                    FROM matched
                    WHERE id IS NOT NULL
                    GROUP BY model
                )
                SELECT COUNT(*)::bigint,
                       COUNT(id)::bigint,
                       (COUNT(*) - COUNT(id))::bigint,
                       COALESCE((
                           SELECT jsonb_object_agg(model, symbols ORDER BY model)::text
                           FROM by_model
                       ), '{{}}')
                FROM matched"#,
        );
        let mut rows = self
            .artifact_read(
                statement,
                |statement| {
                    statement
                        .bind(body_lines_by_kind)
                        .bind(i64::from(policy.minimum_body_lines))
                        .bind(i64::from(policy.existing_docstring_char_threshold))
                },
                project_id,
                "current-summary-coverage",
            )
            .await?;
        let row = rows.pop().ok_or(StorageError::CorruptStoredValue {
            field: "summary_coverage",
        })?;
        let by_model = serde_json::from_str(&text(&row, 3)?).map_err(|_| {
            StorageError::CorruptStoredValue {
                field: "summary_coverage",
            }
        })?;
        Ok(SummaryCoverageStats {
            eligible_symbols: nonnegative_u64(&row, 0)?,
            summarized_symbols: nonnegative_u64(&row, 1)?,
            pending_symbols: nonnegative_u64(&row, 2)?,
            by_model,
        })
    }

    /// Pull a deterministic bounded batch of missing or stale symbol summaries.
    pub async fn pending_symbol_summaries(
        &self,
        project_id: &ProjectId,
        limit: u16,
    ) -> Result<Vec<PendingSummarySymbol>, StorageError> {
        self.pending_symbol_summaries_with_policy(
            project_id,
            limit,
            &SummaryCandidatePolicy::default(),
        )
        .await
    }

    /// Pull a bounded deterministic page for the no-model structural summary pass.
    ///
    /// A digest-compatible complete summary from any producer wins. This lets an
    /// LLM or agent race safely with the structural pass without being downgraded.
    pub async fn pending_structural_summaries(
        &self,
        project_id: &ProjectId,
        after_symbol_id: Option<&SymbolId>,
        limit: u16,
        policy: &SummaryCandidatePolicy,
    ) -> Result<Vec<PendingStructuralSummary>, StorageError> {
        validate_limit(limit, MAX_STRUCTURAL_SUMMARY_BATCH)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), candidates AS MATERIALIZED (
                    SELECT symbols.generation_id, symbols.symbol_id,
                           files.normalized_path, symbols.symbol_kind,
                           COALESCE(NULLIF(documents.metadata ->> 'name', ''),
                                    symbols.qualified_name) AS name,
                           symbols.qualified_name, symbols.signature, documents.code,
                           symbols.start_line, symbols.end_line,
                           symbols.structural_digest, symbols.declaration_only
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    JOIN {schema}."files" AS files
                      ON files.project_id = symbols.project_id
                     AND files.generation_id = symbols.generation_id
                     AND files.file_id = symbols.file_id
                    LEFT JOIN {schema}."search_documents" AS documents
                      ON documents.project_id = symbols.project_id
                     AND documents.generation_id = symbols.generation_id
                     AND documents.symbol_id = symbols.symbol_id
                     AND documents.document_kind = 'symbol'
                    LEFT JOIN {schema}."agent_artifacts" AS cached
                      ON cached.project_id = symbols.project_id
                     AND cached.artifact_kind = 'summary'
                     AND cached.scope_kind = 'symbol'
                     AND cached.scope_key = symbols.symbol_id::text
                     AND cached.state = 'complete'
                     AND cached.source_digest = symbols.structural_digest
                    WHERE symbols.project_id = CAST($1 AS uuid)
                      AND symbols.symbol_kind IN (
                          'class', 'function', 'method', 'interface', 'struct',
                          'trait', 'protocol', 'enum', 'type_alias', 'component', 'route'
                      )
                      AND length(COALESCE(documents.natural_text, '')) < $7
                      AND cached.id IS NULL
                      AND ($2::uuid IS NULL OR symbols.symbol_id > $2::uuid)
                    ORDER BY symbols.symbol_id
                    LIMIT $3
                )
                SELECT candidates.generation_id::text,
                       candidates.symbol_id::text,
                       candidates.normalized_path,
                       candidates.symbol_kind,
                       candidates.name,
                       candidates.qualified_name,
                       left(candidates.signature, $4),
                       left(candidates.code, $6),
                       candidates.start_line,
                       candidates.end_line,
                       candidates.structural_digest,
                       candidates.declaration_only,
                       COALESCE((
                           SELECT jsonb_agg(
                               jsonb_build_object(
                                   'edgeKind', edges.edge_kind,
                                   'targetSymbolId', targets.symbol_id::text,
                                   'targetKind', targets.symbol_kind,
                                   'targetName', COALESCE(
                                       NULLIF(target_docs.metadata ->> 'name', ''),
                                       targets.qualified_name
                                   ),
                                   'targetQualifiedName', targets.qualified_name,
                                   'targetPath', target_files.normalized_path,
                                   'targetSummary', COALESCE(
                                       left(target_summaries.body, $5),
                                       NULLIF(left(target_docs.natural_text, $5), '')
                                   )
                               ) ORDER BY edges.edge_kind, targets.qualified_name,
                                          targets.symbol_id
                           )
                           FROM {schema}."edges" AS edges
                           JOIN {schema}."symbols" AS targets
                             ON targets.project_id = edges.project_id
                            AND targets.generation_id = edges.generation_id
                            AND targets.symbol_id = edges.target_symbol_id
                           JOIN {schema}."files" AS target_files
                             ON target_files.project_id = targets.project_id
                            AND target_files.generation_id = targets.generation_id
                            AND target_files.file_id = targets.file_id
                           LEFT JOIN {schema}."agent_artifacts" AS target_summaries
                             ON target_summaries.project_id = targets.project_id
                            AND target_summaries.artifact_kind = 'summary'
                            AND target_summaries.scope_kind = 'symbol'
                            AND target_summaries.scope_key = targets.symbol_id::text
                            AND target_summaries.state = 'complete'
                            AND target_summaries.source_digest = targets.structural_digest
                           LEFT JOIN LATERAL (
                               SELECT documents.natural_text, documents.metadata
                               FROM {schema}."search_documents" AS documents
                               WHERE documents.project_id = targets.project_id
                                 AND documents.generation_id = targets.generation_id
                                 AND documents.symbol_id = targets.symbol_id
                                 AND documents.document_kind = 'symbol'
                               ORDER BY documents.id
                               LIMIT 1
                           ) AS target_docs ON true
                           WHERE edges.project_id = CAST($1 AS uuid)
                             AND edges.generation_id = candidates.generation_id
                             AND edges.source_symbol_id = candidates.symbol_id
                       ), '[]'::jsonb)::text
                FROM candidates
                ORDER BY candidates.symbol_id"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| {
                    statement
                        .bind(after_symbol_id.map(SymbolId::as_str))
                        .bind(i64::from(limit))
                        .bind(SUMMARY_SIGNATURE_MAXIMUM_CHARACTERS)
                        .bind(SUMMARY_ROLLUP_ITEM_MAXIMUM_CHARACTERS)
                        .bind(SUMMARY_SOURCE_MAXIMUM_CHARACTERS)
                        .bind(i64::from(policy.existing_docstring_char_threshold))
                },
                project_id,
                "pending-structural-summaries",
            )
            .await?;
        rows.iter().map(decode_pending_structural_summary).collect()
    }

    /// Page current embedded symbols which still lack an exact summary.
    pub async fn pending_neighbor_summaries(
        &self,
        project_id: &ProjectId,
        expected_generation_id: &GenerationId,
        model_id: &ModelId,
        after_symbol_id: Option<&SymbolId>,
        limit: u16,
    ) -> Result<Vec<PendingNeighborSummary>, StorageError> {
        validate_limit(limit, MAX_NEIGHBOR_SUMMARY_BATCH)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                      AND current_generation_id = CAST($2 AS uuid)
                )
                SELECT symbols.generation_id::text, symbols.symbol_id::text,
                       symbols.symbol_kind,
                       COALESCE(NULLIF(documents.metadata ->> 'name', ''),
                                symbols.qualified_name),
                       symbols.structural_digest
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."search_documents" AS documents
                  ON documents.project_id = symbols.project_id
                 AND documents.generation_id = symbols.generation_id
                 AND documents.symbol_id = symbols.symbol_id
                JOIN {schema}."document_embeddings" AS embeddings
                  ON embeddings.project_id = documents.project_id
                 AND embeddings.generation_id = documents.generation_id
                 AND embeddings.document_id = documents.document_id
                 AND embeddings.model_id = CAST($3 AS uuid)
                LEFT JOIN {schema}."agent_artifacts" AS summaries
                  ON summaries.project_id = symbols.project_id
                 AND summaries.artifact_kind = 'summary'
                 AND summaries.scope_kind = 'symbol'
                 AND summaries.scope_key = symbols.symbol_id::text
                 AND summaries.state = 'complete'
                 AND summaries.source_digest = symbols.structural_digest
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind IN (
                      'class', 'function', 'method', 'interface', 'struct',
                      'trait', 'protocol', 'enum', 'type_alias', 'component', 'route'
                  )
                  AND summaries.id IS NULL
                  AND ($4::uuid IS NULL OR symbols.symbol_id > $4::uuid)
                ORDER BY symbols.symbol_id
                LIMIT $5"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| {
                    statement
                        .bind(expected_generation_id.as_str())
                        .bind(model_id.as_str())
                        .bind(after_symbol_id.map(SymbolId::as_str))
                        .bind(i64::from(limit))
                },
                project_id,
                "pending-neighbor-summaries",
            )
            .await?;
        rows.iter().map(decode_pending_neighbor_summary).collect()
    }

    /// Read exact current summaries for a bounded semantic-neighbor candidate set.
    /// Summaries already produced by neighbor propagation are excluded to prevent
    /// transitive semantic drift.
    pub async fn neighbor_summary_sources(
        &self,
        project_id: &ProjectId,
        expected_generation_id: &GenerationId,
        symbol_ids: &[SymbolId],
    ) -> Result<Vec<NeighborSummarySource>, StorageError> {
        if symbol_ids.is_empty() || symbol_ids.len() > MAX_NEIGHBOR_SUMMARY_SOURCES {
            return Err(StorageError::InvalidInput {
                field: "neighbor_summary_sources",
            });
        }
        let mut ids = symbol_ids
            .iter()
            .map(|symbol_id| symbol_id.as_str().to_owned())
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                      AND current_generation_id = CAST($2 AS uuid)
                )
                SELECT symbols.symbol_id::text, symbols.symbol_kind,
                       COALESCE(NULLIF(documents.metadata ->> 'name', ''),
                                symbols.qualified_name),
                       summaries.body,
                       COALESCE(NULLIF(summaries.metadata ->> 'model', ''), 'agent')
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."search_documents" AS documents
                  ON documents.project_id = symbols.project_id
                 AND documents.generation_id = symbols.generation_id
                 AND documents.symbol_id = symbols.symbol_id
                JOIN {schema}."agent_artifacts" AS summaries
                  ON summaries.project_id = symbols.project_id
                 AND summaries.artifact_kind = 'summary'
                 AND summaries.scope_kind = 'symbol'
                 AND summaries.scope_key = symbols.symbol_id::text
                 AND summaries.state = 'complete'
                 AND summaries.source_digest = symbols.structural_digest
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_id = ANY(CAST($3 AS uuid[]))
                  AND COALESCE(summaries.metadata ->> 'model', '') NOT LIKE 'neighbor:%'
                ORDER BY symbols.symbol_id"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| statement.bind(expected_generation_id.as_str()).bind(ids),
                project_id,
                "neighbor-summary-sources",
            )
            .await?;
        rows.iter().map(decode_neighbor_summary_source).collect()
    }

    /// Pull a deterministic bounded batch under the configured summary floor.
    pub async fn pending_symbol_summaries_with_policy(
        &self,
        project_id: &ProjectId,
        limit: u16,
        policy: &SummaryCandidatePolicy,
    ) -> Result<Vec<PendingSummarySymbol>, StorageError> {
        self.pending_symbol_summaries_internal(project_id, None, limit, policy)
            .await
    }

    /// Pull candidates whose structural digest and exact model do not both match.
    pub async fn pending_symbol_summaries_for_model_with_policy(
        &self,
        project_id: &ProjectId,
        model: &str,
        limit: u16,
        policy: &SummaryCandidatePolicy,
    ) -> Result<Vec<PendingSummarySymbol>, StorageError> {
        validate_model(model)?;
        self.pending_symbol_summaries_internal(project_id, Some(model), limit, policy)
            .await
    }

    async fn pending_symbol_summaries_internal(
        &self,
        project_id: &ProjectId,
        model: Option<&str>,
        limit: u16,
        policy: &SummaryCandidatePolicy,
    ) -> Result<Vec<PendingSummarySymbol>, StorageError> {
        validate_limit(limit, MAX_SUMMARY_BATCH)?;
        let body_lines_by_kind = policy.minimum_body_lines_json()?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT symbols.generation_id::text,
                       symbols.symbol_id::text,
                       files.normalized_path,
                       files.language,
                       symbols.symbol_kind,
                       symbols.qualified_name,
                       left(symbols.signature, $3),
                       symbols.start_line,
                       symbols.end_line,
                       symbols.structural_digest,
                       COALESCE(left(documents.code, $4), ''),
                       COALESCE(length(documents.code) > $4, false),
                       priority.symbol_id IS NOT NULL
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                LEFT JOIN {schema}."search_documents" AS documents
                  ON documents.project_id = symbols.project_id
                 AND documents.generation_id = symbols.generation_id
                 AND documents.symbol_id = symbols.symbol_id
                 AND documents.document_kind = 'symbol'
                LEFT JOIN {schema}."agent_artifacts" AS summaries
                  ON summaries.project_id = symbols.project_id
                 AND summaries.artifact_kind = 'summary'
                 AND summaries.scope_kind = 'symbol'
                 AND summaries.scope_key = symbols.symbol_id::text
                 AND summaries.source_digest = symbols.structural_digest
                 AND summaries.state = 'complete'
                 AND (
                      ($8::text IS NULL AND COALESCE(summaries.metadata ->> 'model', '') NOT LIKE 'structural:%')
                      OR summaries.metadata ->> 'model' = $8
                 )
                LEFT JOIN {schema}."summary_priority_queue" AS priority
                  ON priority.project_id = symbols.project_id
                 AND priority.generation_id = symbols.generation_id
                 AND priority.symbol_id = symbols.symbol_id
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind IN (
                      'class', 'function', 'method', 'interface', 'struct',
                      'trait', 'protocol', 'enum', 'type_alias', 'component', 'route'
                  )
                  AND (symbols.end_line - symbols.start_line + 1) >= COALESCE(
                      CAST(NULLIF(CAST($5 AS jsonb) ->> symbols.symbol_kind, '') AS integer),
                      $6
                  )
                  AND length(COALESCE(documents.natural_text, '')) < $7
                  AND summaries.id IS NULL
                ORDER BY (priority.symbol_id IS NOT NULL) DESC,
                         priority.enqueued_at DESC NULLS LAST,
                         priority.requested_count DESC NULLS LAST,
                         symbols.exported DESC,
                         (symbols.visibility = 'public') DESC,
                         symbols.pagerank DESC NULLS LAST,
                         files.normalized_path,
                         symbols.start_line,
                         symbols.symbol_id
                LIMIT $2"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| {
                    statement
                        .bind(i64::from(limit))
                        .bind(SUMMARY_SIGNATURE_MAXIMUM_CHARACTERS)
                        .bind(SUMMARY_SOURCE_MAXIMUM_CHARACTERS)
                        .bind(body_lines_by_kind)
                        .bind(i64::from(policy.minimum_body_lines))
                        .bind(i64::from(policy.existing_docstring_char_threshold))
                        .bind(model)
                },
                project_id,
                "pending-symbol-summaries",
            )
            .await?;
        rows.iter().map(decode_pending_summary).collect()
    }

    /// Pull current files whose bounded symbol-summary roll-up has no exact
    /// model, source, anchor, and evidence-compatible cached paragraph.
    pub async fn pending_file_summaries(
        &self,
        project_id: &ProjectId,
        model: &str,
        anchor_digest: &ContentDigest,
        after_path: Option<&str>,
        limit: u16,
        item_limit: u16,
    ) -> Result<Vec<PendingFileSummary>, StorageError> {
        validate_model(model)?;
        validate_limit(limit, MAX_FILE_SUMMARY_BATCH)?;
        validate_limit(item_limit, MAX_SUMMARY_ROLLUP_ITEMS)?;
        if let Some(path) = after_path {
            NormalizedPath::parse(path).map_err(|_| StorageError::InvalidInput {
                field: "after_path",
            })?;
        }
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), ranked AS (
                    SELECT files.generation_id,
                           files.normalized_path,
                           files.content_hash,
                           symbols.symbol_id,
                           symbols.qualified_name,
                           symbols.symbol_kind,
                           left(summaries.body, $6) AS summary,
                           summaries.updated_at,
                           COUNT(*) OVER (PARTITION BY files.file_id) AS summarized_symbols,
                           ROW_NUMBER() OVER (
                               PARTITION BY files.file_id
                               ORDER BY symbols.exported DESC,
                                        (symbols.visibility = 'public') DESC,
                                        symbols.pagerank DESC NULLS LAST,
                                        symbols.start_line,
                                        symbols.symbol_id
                           ) AS evidence_rank
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = files.project_id
                     AND symbols.generation_id = files.generation_id
                     AND symbols.file_id = files.file_id
                    JOIN {schema}."agent_artifacts" AS summaries
                      ON summaries.project_id = symbols.project_id
                     AND summaries.artifact_kind = 'summary'
                     AND summaries.scope_kind = 'symbol'
                     AND summaries.scope_key = symbols.symbol_id::text
                     AND summaries.source_digest = symbols.structural_digest
                     AND summaries.state = 'complete'
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND ($3::text IS NULL OR files.normalized_path > $3)
                ), rollups AS (
                    SELECT generation_id,
                           normalized_path,
                           content_hash,
                           MAX(summarized_symbols)::bigint AS summarized_symbols,
                           MAX(updated_at) AS latest_symbol_summary_at,
                           jsonb_agg(
                               jsonb_build_object(
                                   'symbolId', symbol_id::text,
                                   'qualifiedName', qualified_name,
                                   'symbolKind', symbol_kind,
                                   'summary', summary
                               ) ORDER BY evidence_rank
                           ) FILTER (WHERE evidence_rank <= $5) AS items
                    FROM ranked
                    GROUP BY generation_id, normalized_path, content_hash
                )
                SELECT rollups.generation_id::text,
                       rollups.normalized_path,
                       rollups.content_hash,
                       rollups.summarized_symbols,
                       rollups.items::text,
                       rollups.summarized_symbols > $5
                FROM rollups
                LEFT JOIN {schema}."agent_artifacts" AS cached
                  ON cached.project_id = CAST($1 AS uuid)
                 AND cached.artifact_kind = 'summary'
                 AND cached.scope_kind = 'file'
                 AND cached.scope_key = rollups.normalized_path
                 AND cached.state = 'complete'
                WHERE cached.id IS NULL
                   OR cached.generation_id IS DISTINCT FROM rollups.generation_id
                   OR (
                        $2 <> 'structural:v2'
                        AND cached.metadata ->> 'model' IS DISTINCT FROM $2
                   )
                   OR cached.metadata ->> 'anchorDigest' IS DISTINCT FROM $7
                   OR cached.metadata ->> 'fileContentHash' IS DISTINCT FROM rollups.content_hash
                   OR cached.metadata ->> 'summarizedSymbols'
                        IS DISTINCT FROM rollups.summarized_symbols::text
                   OR cached.metadata ->> 'rollupDigest' IS DISTINCT FROM cached.source_digest
                   OR cached.updated_at < rollups.latest_symbol_summary_at
                ORDER BY rollups.normalized_path
                LIMIT $4"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| {
                    statement
                        .bind(model)
                        .bind(after_path)
                        .bind(i64::from(limit))
                        .bind(i64::from(item_limit))
                        .bind(SUMMARY_ROLLUP_ITEM_MAXIMUM_CHARACTERS)
                        .bind(anchor_digest.as_str())
                },
                project_id,
                "pending-file-summaries",
            )
            .await?;
        rows.iter()
            .map(|row| decode_pending_file_summary(row, anchor_digest))
            .collect()
    }

    /// Pull immediate source directories whose bounded symbol roll-up has no
    /// exact model, anchor, generation, and evidence-compatible paragraph.
    pub async fn pending_module_summaries(
        &self,
        project_id: &ProjectId,
        model: &str,
        anchor_digest: &ContentDigest,
        after_directory: Option<&str>,
        limit: u16,
        item_limit: u16,
    ) -> Result<Vec<PendingModuleSummary>, StorageError> {
        validate_model(model)?;
        validate_limit(limit, MAX_FILE_SUMMARY_BATCH)?;
        validate_limit(item_limit, MAX_MODULE_SUMMARY_ROLLUP_ITEMS)?;
        if let Some(directory) = after_directory {
            NormalizedPath::parse(directory).map_err(|_| StorageError::InvalidInput {
                field: "after_directory",
            })?;
        }
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), summarized AS (
                    SELECT files.generation_id,
                           regexp_replace(files.normalized_path, '/[^/]+$', '') AS directory,
                           files.normalized_path,
                           symbols.symbol_id,
                           symbols.qualified_name,
                           symbols.symbol_kind,
                           symbols.exported,
                           symbols.visibility,
                           symbols.pagerank,
                           symbols.start_line,
                           left(summaries.body, $6) AS summary,
                           summaries.updated_at
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = files.project_id
                     AND symbols.generation_id = files.generation_id
                     AND symbols.file_id = files.file_id
                    JOIN {schema}."agent_artifacts" AS summaries
                      ON summaries.project_id = symbols.project_id
                     AND summaries.artifact_kind = 'summary'
                     AND summaries.scope_kind = 'symbol'
                     AND summaries.scope_key = symbols.symbol_id::text
                     AND summaries.source_digest = symbols.structural_digest
                     AND summaries.state = 'complete'
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND POSITION('/' IN files.normalized_path) > 0
                ), tool_counts AS (
                    SELECT files.generation_id,
                           regexp_replace(files.normalized_path, '/[^/]+$', '') AS directory,
                           COUNT(*)::bigint AS tool_export_constants
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = files.project_id
                     AND symbols.generation_id = files.generation_id
                     AND symbols.file_id = files.file_id
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND POSITION('/' IN files.normalized_path) > 0
                      AND symbols.symbol_kind = 'constant'
                      AND symbols.qualified_name ~ '_TOOL$'
                    GROUP BY files.generation_id, directory
                ), ranked AS (
                    SELECT summarized.*,
                           COUNT(*) OVER (PARTITION BY directory) AS summarized_symbols,
                           ROW_NUMBER() OVER (
                               PARTITION BY directory
                               ORDER BY exported DESC,
                                        (visibility = 'public') DESC,
                                        pagerank DESC NULLS LAST,
                                        normalized_path,
                                        start_line,
                                        symbol_id
                           ) AS evidence_rank
                    FROM summarized
                    WHERE ($3::text IS NULL OR directory > $3)
                ), rollups AS (
                    SELECT generation_id,
                           directory,
                           MAX(summarized_symbols)::bigint AS summarized_symbols,
                           MAX(updated_at) AS latest_symbol_summary_at,
                           jsonb_agg(
                               jsonb_build_object(
                                   'symbolId', symbol_id::text,
                                   'path', normalized_path,
                                   'qualifiedName', qualified_name,
                                   'symbolKind', symbol_kind,
                                   'summary', summary
                               ) ORDER BY evidence_rank
                           ) FILTER (WHERE evidence_rank <= $5) AS items
                    FROM ranked
                    GROUP BY generation_id, directory
                    HAVING MAX(summarized_symbols) >= $8
                )
                SELECT rollups.generation_id::text,
                       rollups.directory,
                       rollups.summarized_symbols,
                       COALESCE(tool_counts.tool_export_constants, 0),
                       rollups.items::text,
                       rollups.summarized_symbols > $5
                FROM rollups
                LEFT JOIN tool_counts
                  ON tool_counts.generation_id = rollups.generation_id
                 AND tool_counts.directory = rollups.directory
                LEFT JOIN {schema}."agent_artifacts" AS cached
                  ON cached.project_id = CAST($1 AS uuid)
                 AND cached.artifact_kind = 'summary'
                 AND cached.scope_kind = 'module'
                 AND cached.scope_key = rollups.directory
                 AND cached.state = 'complete'
                WHERE cached.id IS NULL
                   OR cached.generation_id IS DISTINCT FROM rollups.generation_id
                   OR (
                        $2 <> 'structural:v2'
                        AND cached.metadata ->> 'model' IS DISTINCT FROM $2
                   )
                   OR cached.metadata ->> 'anchorDigest' IS DISTINCT FROM $7
                   OR cached.metadata ->> 'summarizedSymbols'
                        IS DISTINCT FROM rollups.summarized_symbols::text
                   OR cached.metadata ->> 'toolExportConstants'
                        IS DISTINCT FROM COALESCE(tool_counts.tool_export_constants, 0)::text
                   OR cached.metadata ->> 'rollupDigest' IS DISTINCT FROM cached.source_digest
                   OR cached.updated_at < rollups.latest_symbol_summary_at
                ORDER BY rollups.directory
                LIMIT $4"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| {
                    statement
                        .bind(model)
                        .bind(after_directory)
                        .bind(i64::from(limit))
                        .bind(i64::from(item_limit))
                        .bind(SUMMARY_ROLLUP_ITEM_MAXIMUM_CHARACTERS)
                        .bind(anchor_digest.as_str())
                        .bind(i64::try_from(MIN_MODULE_SUMMARY_SYMBOLS).unwrap_or(i64::MAX))
                },
                project_id,
                "pending-module-summaries",
            )
            .await?;
        rows.iter()
            .map(|row| decode_pending_module_summary(row, anchor_digest))
            .collect()
    }

    /// Pull a deterministic batch whose current structural digest has neither
    /// a high-confidence structural role nor a role from this exact model.
    pub async fn pending_symbol_roles(
        &self,
        project_id: &ProjectId,
        model: &str,
        limit: u16,
    ) -> Result<Vec<PendingRoleSymbol>, StorageError> {
        validate_limit(limit, MAX_ROLE_BATCH)?;
        if model.is_empty() || model.len() > 256 || model.contains('\0') {
            return Err(StorageError::InvalidInput { field: "model" });
        }
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT symbols.symbol_id::text,
                       files.normalized_path,
                       files.language,
                       symbols.symbol_kind,
                       symbols.qualified_name,
                       left(symbols.signature, $4),
                       COALESCE(NULLIF(summaries.body, ''), left(documents.natural_text, $5), ''),
                       COALESCE(left(documents.code, $5), ''),
                       symbols.exported
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                LEFT JOIN {schema}."search_documents" AS documents
                  ON documents.project_id = symbols.project_id
                 AND documents.generation_id = symbols.generation_id
                 AND documents.symbol_id = symbols.symbol_id
                 AND documents.document_kind = 'symbol'
                LEFT JOIN {schema}."agent_artifacts" AS summaries
                  ON summaries.project_id = symbols.project_id
                 AND summaries.artifact_kind = 'summary'
                 AND summaries.scope_kind = 'symbol'
                 AND summaries.scope_key = symbols.symbol_id::text
                 AND summaries.source_digest = symbols.structural_digest
                 AND summaries.state = 'complete'
                LEFT JOIN {schema}."agent_artifacts" AS roles
                  ON roles.project_id = symbols.project_id
                 AND roles.artifact_kind = 'role'
                 AND roles.scope_kind = 'symbol'
                 AND roles.scope_key = symbols.symbol_id::text
                 AND roles.source_digest = symbols.structural_digest
                 AND roles.state = 'complete'
                 AND (
                      roles.metadata->>'via' IN ('structural_rule', 'rule')
                      OR (
                          roles.metadata->>'via' = 'structural_fallback'
                          AND $2 = 'cartograph-structural-role-v2-1'
                      )
                      OR (
                          roles.metadata->>'via' = 'llm'
                          AND roles.metadata->>'model' = $2
                      )
                 )
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
                  AND roles.id IS NULL
                ORDER BY symbols.exported DESC,
                         (symbols.visibility = 'public') DESC,
                         files.normalized_path,
                         symbols.start_line,
                         symbols.symbol_id
                LIMIT $3"#,
        );
        let rows = self
            .artifact_read(
                statement,
                |statement| {
                    statement
                        .bind(model)
                        .bind(i64::from(limit))
                        .bind(SUMMARY_SIGNATURE_MAXIMUM_CHARACTERS)
                        .bind(ROLE_EVIDENCE_MAXIMUM_CHARACTERS)
                },
                project_id,
                "pending-symbol-roles",
            )
            .await?;
        rows.iter().map(decode_pending_role).collect()
    }

    /// Save a summary only when its echoed structural digest still matches current source.
    pub async fn save_symbol_summary(
        &self,
        project_id: &ProjectId,
        symbol_id: &SymbolId,
        source_digest: &ContentDigest,
        summary: &str,
        model: &str,
    ) -> Result<AgentArtifactRecord, StorageError> {
        validate_body(summary, AgentArtifactState::Complete)?;
        validate_model(model)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH saved AS (
                INSERT INTO {schema}."agent_artifacts" (
                    project_id, artifact_kind, scope_kind, scope_key, body, metadata,
                    generation_id, source_digest, state
                )
                SELECT symbols.project_id, 'summary', 'symbol', symbols.symbol_id::text,
                       $4, jsonb_build_object('model', $5::text),
                       symbols.generation_id, symbols.structural_digest, 'complete'
                FROM {schema}."symbols" AS symbols
                JOIN {schema}."projects" AS projects
                  ON projects.project_id = symbols.project_id
                 AND projects.current_generation_id = symbols.generation_id
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_id = CAST($2 AS uuid)
                  AND symbols.structural_digest = $3
                ON CONFLICT (project_id, artifact_kind, scope_kind, scope_key)
                WHERE artifact_kind IN ('role', 'summary') AND state <> 'archived'
                DO UPDATE SET body = EXCLUDED.body,
                              metadata = EXCLUDED.metadata,
                              generation_id = EXCLUDED.generation_id,
                              source_digest = EXCLUDED.source_digest,
                              state = EXCLUDED.state,
                              updated_at = clock_timestamp()
                RETURNING id, artifact_id::text, artifact_kind, scope_kind, scope_key,
                          body, metadata::text, generation_id::text, source_digest,
                          state, created_at::text, updated_at::text,
                          project_id AS saved_project_id,
                          generation_id AS saved_generation_id
                ), cleared AS (
                    DELETE FROM {schema}."summary_priority_queue" AS priority
                    USING saved
                    WHERE priority.project_id = saved.saved_project_id
                      AND priority.generation_id = saved.saved_generation_id
                      AND priority.symbol_id = CAST(saved.scope_key AS uuid)
                    RETURNING priority.symbol_id
                ), invalidated AS (
                    DELETE FROM {schema}."document_embeddings" AS embeddings
                    USING {schema}."search_documents" AS documents, saved
                    WHERE documents.project_id = saved.saved_project_id
                      AND documents.generation_id = saved.saved_generation_id
                      AND documents.symbol_id = CAST(saved.scope_key AS uuid)
                      AND embeddings.project_id = documents.project_id
                      AND embeddings.generation_id = documents.generation_id
                      AND embeddings.document_id = documents.document_id
                    RETURNING embeddings.document_id
                )
                SELECT id, artifact_id, artifact_kind, scope_kind, scope_key,
                       body, metadata, generation_id, source_digest,
                       state, created_at, updated_at,
                       (SELECT COUNT(*) FROM cleared),
                       (SELECT COUNT(*) FROM invalidated)
                FROM saved"#,
        );
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(symbol_id.as_str())
            .bind(source_digest.as_str())
            .bind(summary)
            .bind(model)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("save-symbol-summary"))?
            .ok_or(StorageError::CurrentGenerationChanged)?;
        decode_artifact(&row)
    }

    /// Publish a deterministic structural fallback without replacing a
    /// digest-compatible summary produced by an LLM or agent. `None` means
    /// either the source generation changed or a higher-quality writer won.
    pub async fn save_structural_symbol_summary(
        &self,
        project_id: &ProjectId,
        symbol_id: &SymbolId,
        source_digest: &ContentDigest,
        summary: &str,
    ) -> Result<Option<AgentArtifactRecord>, StorageError> {
        validate_body(summary, AgentArtifactState::Complete)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH saved AS (
                INSERT INTO {schema}."agent_artifacts" AS existing (
                    project_id, artifact_kind, scope_kind, scope_key, body, metadata,
                    generation_id, source_digest, state
                )
                SELECT symbols.project_id, 'summary', 'symbol', symbols.symbol_id::text,
                       $4, jsonb_build_object(
                           'model', 'structural:v2',
                           'generationMode', 'structural_rule'
                       ), symbols.generation_id, symbols.structural_digest, 'complete'
                FROM {schema}."symbols" AS symbols
                JOIN {schema}."projects" AS projects
                  ON projects.project_id = symbols.project_id
                 AND projects.current_generation_id = symbols.generation_id
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_id = CAST($2 AS uuid)
                  AND symbols.structural_digest = $3
                ON CONFLICT (project_id, artifact_kind, scope_kind, scope_key)
                WHERE artifact_kind IN ('role', 'summary') AND state <> 'archived'
                DO UPDATE SET body = EXCLUDED.body,
                              metadata = EXCLUDED.metadata,
                              generation_id = EXCLUDED.generation_id,
                              source_digest = EXCLUDED.source_digest,
                              state = EXCLUDED.state,
                              updated_at = clock_timestamp()
                WHERE existing.source_digest IS DISTINCT FROM EXCLUDED.source_digest
                   OR COALESCE(existing.metadata ->> 'model', '') LIKE 'structural:%'
                RETURNING id, artifact_id::text, artifact_kind, scope_kind, scope_key,
                          body, metadata::text, generation_id::text, source_digest,
                          state, created_at::text, updated_at::text,
                          project_id AS saved_project_id,
                          generation_id AS saved_generation_id
                ), invalidated AS (
                    DELETE FROM {schema}."document_embeddings" AS embeddings
                    USING {schema}."search_documents" AS documents, saved
                    WHERE documents.project_id = saved.saved_project_id
                      AND documents.generation_id = saved.saved_generation_id
                      AND documents.symbol_id = CAST(saved.scope_key AS uuid)
                      AND embeddings.project_id = documents.project_id
                      AND embeddings.generation_id = documents.generation_id
                      AND embeddings.document_id = documents.document_id
                    RETURNING embeddings.document_id
                )
                SELECT id, artifact_id, artifact_kind, scope_kind, scope_key,
                       body, metadata, generation_id, source_digest,
                       state, created_at, updated_at,
                       (SELECT COUNT(*) FROM invalidated)
                FROM saved"#,
        );
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(symbol_id.as_str())
            .bind(source_digest.as_str())
            .bind(summary)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("save-structural-symbol-summary"))?;
        row.as_ref().map(decode_artifact).transpose()
    }

    /// Publish one transparent semantic-neighbor fallback under exact source,
    /// target, generation, kind, and summary-body fences. A current summary
    /// from any producer wins the race and yields `None`.
    pub async fn save_neighbor_symbol_summary(
        &self,
        project_id: &ProjectId,
        request: NeighborSummarySaveRequest<'_>,
    ) -> Result<Option<AgentArtifactRecord>, StorageError> {
        let model = format!("neighbor:v2:{}", request.embedding_model_id.as_str());
        validate_model(&model)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH saved AS (
                INSERT INTO {schema}."agent_artifacts" AS existing (
                    project_id, artifact_kind, scope_kind, scope_key, body, metadata,
                    generation_id, source_digest, state
                )
                SELECT targets.project_id, 'summary', 'symbol', targets.symbol_id::text,
                       $6, jsonb_build_object(
                           'model', $7::text,
                           'generationMode', 'semantic_neighbor',
                           'sourceSymbolId', sources.symbol_id::text,
                           'sourceModel', COALESCE(
                               NULLIF(source_summaries.metadata ->> 'model', ''), 'agent'
                           ),
                           'embeddingModelId', $8::text,
                           'similarity', $9::float8
                       ), targets.generation_id, targets.structural_digest, 'complete'
                FROM {schema}."symbols" AS targets
                JOIN {schema}."projects" AS projects
                  ON projects.project_id = targets.project_id
                 AND projects.current_generation_id = targets.generation_id
                JOIN {schema}."symbols" AS sources
                  ON sources.project_id = targets.project_id
                 AND sources.generation_id = targets.generation_id
                 AND sources.symbol_id = CAST($4 AS uuid)
                 AND sources.symbol_kind = targets.symbol_kind
                JOIN {schema}."agent_artifacts" AS source_summaries
                  ON source_summaries.project_id = sources.project_id
                 AND source_summaries.artifact_kind = 'summary'
                 AND source_summaries.scope_kind = 'symbol'
                 AND source_summaries.scope_key = sources.symbol_id::text
                 AND source_summaries.state = 'complete'
                 AND source_summaries.source_digest = sources.structural_digest
                 AND source_summaries.body = $5
                 AND COALESCE(source_summaries.metadata ->> 'model', '') NOT LIKE 'neighbor:%'
                WHERE targets.project_id = CAST($1 AS uuid)
                  AND targets.symbol_id = CAST($2 AS uuid)
                  AND targets.structural_digest = $3
                  AND targets.symbol_id <> sources.symbol_id
                ON CONFLICT (project_id, artifact_kind, scope_kind, scope_key)
                WHERE artifact_kind IN ('role', 'summary') AND state <> 'archived'
                DO UPDATE SET body = EXCLUDED.body,
                              metadata = EXCLUDED.metadata,
                              generation_id = EXCLUDED.generation_id,
                              source_digest = EXCLUDED.source_digest,
                              state = EXCLUDED.state,
                              updated_at = clock_timestamp()
                WHERE existing.source_digest IS DISTINCT FROM EXCLUDED.source_digest
                RETURNING id, artifact_id::text, artifact_kind, scope_kind, scope_key,
                          body, metadata::text, generation_id::text, source_digest,
                          state, created_at::text, updated_at::text,
                          project_id AS saved_project_id,
                          generation_id AS saved_generation_id
                ), cleared AS (
                    DELETE FROM {schema}."summary_priority_queue" AS priority
                    USING saved
                    WHERE priority.project_id = saved.saved_project_id
                      AND priority.generation_id = saved.saved_generation_id
                      AND priority.symbol_id = CAST(saved.scope_key AS uuid)
                    RETURNING priority.symbol_id
                )
                SELECT id, artifact_id, artifact_kind, scope_kind, scope_key,
                       body, metadata, generation_id, source_digest,
                       state, created_at, updated_at,
                       (SELECT COUNT(*) FROM cleared)
                FROM saved"#,
        );
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(request.symbol_id.as_str())
            .bind(request.source_digest.as_str())
            .bind(request.neighbor_symbol_id.as_str())
            .bind(request.neighbor_summary)
            .bind(request.summary)
            .bind(&model)
            .bind(request.embedding_model_id.as_str())
            .bind(request.similarity)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("save-neighbor-symbol-summary"))?;
        row.as_ref().map(decode_artifact).transpose()
    }

    /// Save a file roll-up only if its exact bounded source evidence is still current.
    pub async fn save_file_summary(
        &self,
        project_id: &ProjectId,
        request: FileSummarySaveRequest<'_>,
    ) -> Result<Option<AgentArtifactRecord>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("save-file-summary"))?;
        set_local_statement_timeout(&mut transaction, ARTIFACT_TIMEOUT)
            .await
            .map_err(|_| database_error("save-file-summary"))?;
        let lock = format!(
            r#"SELECT current_generation_id::text
                FROM {schema}."projects"
                WHERE project_id = CAST($1 AS uuid)
                FOR SHARE"#,
        );
        let generation_id = query(AssertSqlSafe(lock))
            .bind(project_id.as_str())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| database_error("save-file-summary"))?
            .and_then(|row| row.try_get::<Option<String>, _>(0).ok().flatten())
            .ok_or(StorageError::CurrentGenerationChanged)?;
        let evidence = file_summary_evidence_statement(&schema);
        let rows = query(AssertSqlSafe(evidence))
            .bind(project_id.as_str())
            .bind(&generation_id)
            .bind(request.path.as_str())
            .bind(i64::from(request.item_limit))
            .bind(SUMMARY_ROLLUP_ITEM_MAXIMUM_CHARACTERS)
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| database_error("save-file-summary"))?;
        let pending = pending_file_summary_from_evidence_rows(&rows, request.anchor_digest)?
            .ok_or(StorageError::CurrentGenerationChanged)?;
        if pending.content_hash() != request.expected_digest.as_str() {
            return Err(StorageError::CurrentGenerationChanged);
        }
        let metadata = serde_json::to_string(&serde_json::json!({
            "model": request.model,
            "anchorDigest": request.anchor_digest.as_str(),
            "fileContentHash": pending.file_content_hash(),
            "summarizedSymbols": pending.summarized_symbols(),
            "evidenceItems": pending.items().len(),
            "itemsTruncated": pending.items_truncated(),
            "rollupDigest": request.expected_digest.as_str(),
            "generationMode": request.generation_mode,
            "protocol": "symbol_to_file_v2",
        }))
        .map_err(|_| StorageError::InvalidInput {
            field: "artifact_metadata",
        })?;
        let upsert =
            scoped_summary_upsert_statement(&schema, request.generation_mode == "structural_rule");
        let row = query(AssertSqlSafe(upsert))
            .bind(project_id.as_str())
            .bind(AgentArtifactScope::File.as_str())
            .bind(request.path.as_str())
            .bind(request.summary)
            .bind(metadata)
            .bind(&generation_id)
            .bind(request.expected_digest.as_str())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| database_error("save-file-summary"))?;
        let Some(row) = row else {
            transaction
                .commit()
                .await
                .map_err(|_| database_error("save-file-summary"))?;
            return Ok(None);
        };
        let artifact = decode_artifact(&row)?;
        let invalidate = format!(
            r#"DELETE FROM {schema}."document_embeddings" AS embeddings
                USING {schema}."search_documents" AS documents,
                      {schema}."symbols" AS symbols
                WHERE documents.project_id = CAST($1 AS uuid)
                  AND documents.generation_id = CAST($2 AS uuid)
                  AND documents.path = $3
                  AND symbols.project_id = documents.project_id
                  AND symbols.generation_id = documents.generation_id
                  AND symbols.symbol_id = documents.symbol_id
                  AND symbols.symbol_kind = 'file'
                  AND embeddings.project_id = documents.project_id
                  AND embeddings.generation_id = documents.generation_id
                  AND embeddings.document_id = documents.document_id"#,
        );
        query(AssertSqlSafe(invalidate))
            .bind(project_id.as_str())
            .bind(&generation_id)
            .bind(request.path.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("save-file-summary"))?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error("save-file-summary"))?;
        Ok(Some(artifact))
    }

    /// Save a module roll-up only if its exact immediate-directory evidence is current.
    pub async fn save_module_summary(
        &self,
        project_id: &ProjectId,
        request: ModuleSummarySaveRequest<'_>,
    ) -> Result<Option<AgentArtifactRecord>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("save-module-summary"))?;
        set_local_statement_timeout(&mut transaction, ARTIFACT_TIMEOUT)
            .await
            .map_err(|_| database_error("save-module-summary"))?;
        let lock = format!(
            r#"SELECT current_generation_id::text
                FROM {schema}."projects"
                WHERE project_id = CAST($1 AS uuid)
                FOR SHARE"#,
        );
        let generation_id = query(AssertSqlSafe(lock))
            .bind(project_id.as_str())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| database_error("save-module-summary"))?
            .and_then(|row| row.try_get::<Option<String>, _>(0).ok().flatten())
            .ok_or(StorageError::CurrentGenerationChanged)?;
        let evidence = module_summary_evidence_statement(&schema);
        let rows = query(AssertSqlSafe(evidence))
            .bind(project_id.as_str())
            .bind(&generation_id)
            .bind(request.directory.as_str())
            .bind(i64::from(request.item_limit))
            .bind(SUMMARY_ROLLUP_ITEM_MAXIMUM_CHARACTERS)
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| database_error("save-module-summary"))?;
        let pending = pending_module_summary_from_evidence_rows(&rows, request.anchor_digest)?
            .filter(|pending| pending.summarized_symbols() >= MIN_MODULE_SUMMARY_SYMBOLS)
            .ok_or(StorageError::CurrentGenerationChanged)?;
        if pending.content_hash() != request.expected_digest.as_str() {
            return Err(StorageError::CurrentGenerationChanged);
        }
        let metadata = serde_json::to_string(&serde_json::json!({
            "model": request.model,
            "anchorDigest": request.anchor_digest.as_str(),
            "summarizedSymbols": pending.summarized_symbols(),
            "toolExportConstants": pending.tool_export_constants(),
            "generationMode": request.generation_mode,
            "evidenceItems": pending.items().len(),
            "itemsTruncated": pending.items_truncated(),
            "rollupDigest": request.expected_digest.as_str(),
            "protocol": "symbol_to_module_v2",
        }))
        .map_err(|_| StorageError::InvalidInput {
            field: "artifact_metadata",
        })?;
        let upsert =
            scoped_summary_upsert_statement(&schema, request.generation_mode == "structural_rule");
        let row = query(AssertSqlSafe(upsert))
            .bind(project_id.as_str())
            .bind(AgentArtifactScope::Module.as_str())
            .bind(request.directory.as_str())
            .bind(request.summary)
            .bind(metadata)
            .bind(&generation_id)
            .bind(request.expected_digest.as_str())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| database_error("save-module-summary"))?;
        let Some(row) = row else {
            transaction
                .commit()
                .await
                .map_err(|_| database_error("save-module-summary"))?;
            return Ok(None);
        };
        let artifact = decode_artifact(&row)?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error("save-module-summary"))?;
        Ok(Some(artifact))
    }

    /// Save one role classification only when the symbol is still current.
    ///
    /// The structural digest is persisted with the role so publication can
    /// carry the classification forward without another model call when the
    /// declaration is unchanged. A changed declaration intentionally leaves
    /// the old artifact generation-bound and pending reclassification.
    pub async fn save_symbol_role(
        &self,
        project_id: &ProjectId,
        symbol_id: &SymbolId,
        role: &str,
        metadata: serde_json::Value,
    ) -> Result<AgentArtifactRecord, StorageError> {
        validate_body(role, AgentArtifactState::Complete)?;
        validate_metadata(&metadata)?;
        let metadata =
            serde_json::to_string(&metadata).map_err(|_| StorageError::InvalidInput {
                field: "artifact_metadata",
            })?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"INSERT INTO {schema}."agent_artifacts" (
                    project_id, artifact_kind, scope_kind, scope_key, body, metadata,
                    generation_id, source_digest, state
                )
                SELECT symbols.project_id, 'role', 'symbol', symbols.symbol_id::text,
                       $3, CAST($4 AS jsonb), symbols.generation_id,
                       symbols.structural_digest, 'complete'
                FROM {schema}."symbols" AS symbols
                JOIN {schema}."projects" AS projects
                  ON projects.project_id = symbols.project_id
                 AND projects.current_generation_id = symbols.generation_id
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_id = CAST($2 AS uuid)
                ON CONFLICT (project_id, artifact_kind, scope_kind, scope_key)
                WHERE artifact_kind IN ('role', 'summary') AND state <> 'archived'
                DO UPDATE SET body = EXCLUDED.body,
                              metadata = EXCLUDED.metadata,
                              generation_id = EXCLUDED.generation_id,
                              source_digest = EXCLUDED.source_digest,
                              state = EXCLUDED.state,
                              updated_at = clock_timestamp()
                RETURNING id, artifact_id::text, artifact_kind, scope_kind, scope_key,
                          body, metadata::text, generation_id::text, source_digest,
                          state, created_at::text, updated_at::text"#,
        );
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(symbol_id.as_str())
            .bind(role)
            .bind(metadata)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("save-symbol-role"))?
            .ok_or(StorageError::CurrentGenerationChanged)?;
        decode_artifact(&row)
    }

    async fn artifact_read<'query, Bind>(
        &self,
        statement: String,
        bind: Bind,
        project_id: &ProjectId,
        operation: &'static str,
    ) -> Result<Vec<sqlx_postgres::PgRow>, StorageError>
    where
        Bind: FnOnce(
            sqlx_core::query::Query<'query, sqlx_postgres::Postgres, sqlx_postgres::PgArguments>,
        ) -> sqlx_core::query::Query<
            'query,
            sqlx_postgres::Postgres,
            sqlx_postgres::PgArguments,
        >,
    {
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error(operation))?;
        query("SET TRANSACTION READ ONLY")
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error(operation))?;
        set_local_statement_timeout(&mut transaction, ARTIFACT_TIMEOUT)
            .await
            .map_err(|_| database_error(operation))?;
        let statement = query(AssertSqlSafe(statement)).bind(project_id.as_str());
        let rows = bind(statement)
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| database_error(operation))?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error(operation))?;
        Ok(rows)
    }
}

fn file_summary_evidence_statement(schema: &str) -> String {
    format!(
        r#"SELECT files.generation_id::text,
                   files.normalized_path,
                   files.content_hash,
                   symbols.symbol_id::text,
                   symbols.qualified_name,
                   symbols.symbol_kind,
                   left(summaries.body, $5),
                   COUNT(*) OVER ()::bigint
            FROM {schema}."files" AS files
            JOIN {schema}."symbols" AS symbols
              ON symbols.project_id = files.project_id
             AND symbols.generation_id = files.generation_id
             AND symbols.file_id = files.file_id
            JOIN {schema}."agent_artifacts" AS summaries
              ON summaries.project_id = symbols.project_id
             AND summaries.artifact_kind = 'summary'
             AND summaries.scope_kind = 'symbol'
             AND summaries.scope_key = symbols.symbol_id::text
             AND summaries.source_digest = symbols.structural_digest
             AND summaries.state = 'complete'
            WHERE files.project_id = CAST($1 AS uuid)
              AND files.generation_id = CAST($2 AS uuid)
              AND files.normalized_path = $3
            ORDER BY symbols.exported DESC,
                     (symbols.visibility = 'public') DESC,
                     symbols.pagerank DESC NULLS LAST,
                     symbols.start_line,
                     symbols.symbol_id
            LIMIT $4"#,
    )
}

fn module_summary_evidence_statement(schema: &str) -> String {
    format!(
        r#"SELECT files.generation_id::text,
                   files.normalized_path,
                   symbols.symbol_id::text,
                   symbols.qualified_name,
                   symbols.symbol_kind,
                   left(summaries.body, $5),
                   COUNT(*) OVER ()::bigint,
                   (
                       SELECT COUNT(*)::bigint
                       FROM {schema}."files" AS tool_files
                       JOIN {schema}."symbols" AS tool_symbols
                         ON tool_symbols.project_id = tool_files.project_id
                        AND tool_symbols.generation_id = tool_files.generation_id
                        AND tool_symbols.file_id = tool_files.file_id
                       WHERE tool_files.project_id = CAST($1 AS uuid)
                         AND tool_files.generation_id = CAST($2 AS uuid)
                         AND LEFT(tool_files.normalized_path, char_length($3) + 1) = $3 || '/'
                         AND POSITION('/' IN SUBSTRING(
                               tool_files.normalized_path FROM char_length($3) + 2
                             )) = 0
                         AND tool_symbols.symbol_kind = 'constant'
                         AND tool_symbols.qualified_name ~ '_TOOL$'
                   )
            FROM {schema}."files" AS files
            JOIN {schema}."symbols" AS symbols
              ON symbols.project_id = files.project_id
             AND symbols.generation_id = files.generation_id
             AND symbols.file_id = files.file_id
            JOIN {schema}."agent_artifacts" AS summaries
              ON summaries.project_id = symbols.project_id
             AND summaries.artifact_kind = 'summary'
             AND summaries.scope_kind = 'symbol'
             AND summaries.scope_key = symbols.symbol_id::text
             AND summaries.source_digest = symbols.structural_digest
             AND summaries.state = 'complete'
            WHERE files.project_id = CAST($1 AS uuid)
              AND files.generation_id = CAST($2 AS uuid)
              AND LEFT(files.normalized_path, char_length($3) + 1) = $3 || '/'
              AND POSITION('/' IN SUBSTRING(
                    files.normalized_path FROM char_length($3) + 2
                  )) = 0
            ORDER BY symbols.exported DESC,
                     (symbols.visibility = 'public') DESC,
                     symbols.pagerank DESC NULLS LAST,
                     files.normalized_path,
                     symbols.start_line,
                     symbols.symbol_id
            LIMIT $4"#,
    )
}

fn scoped_summary_upsert_statement(schema: &str, preserve_higher_quality: bool) -> String {
    let guard = if preserve_higher_quality {
        "WHERE existing.generation_id IS DISTINCT FROM EXCLUDED.generation_id\n               OR existing.source_digest IS DISTINCT FROM EXCLUDED.source_digest\n               OR COALESCE(existing.metadata ->> 'generationMode', '') = 'structural_rule'\n               OR COALESCE(existing.metadata ->> 'model', '') LIKE 'structural:%'"
    } else {
        ""
    };
    format!(
        r#"INSERT INTO {schema}."agent_artifacts" AS existing (
                project_id, artifact_kind, scope_kind, scope_key, body, metadata,
                generation_id, source_digest, state
            ) VALUES (
                CAST($1 AS uuid), 'summary', $2, $3, $4, CAST($5 AS jsonb),
                CAST($6 AS uuid), $7, 'complete'
            )
            ON CONFLICT (project_id, artifact_kind, scope_kind, scope_key)
            WHERE artifact_kind IN ('role', 'summary') AND state <> 'archived'
            DO UPDATE SET body = EXCLUDED.body,
                          metadata = EXCLUDED.metadata,
                          generation_id = EXCLUDED.generation_id,
                          source_digest = EXCLUDED.source_digest,
                          state = EXCLUDED.state,
                          updated_at = clock_timestamp()
            {guard}
            RETURNING id, artifact_id::text, artifact_kind, scope_kind, scope_key,
                      body, metadata::text, generation_id::text, source_digest,
                      state, created_at::text, updated_at::text"#,
    )
}

fn pending_file_summary_from_evidence_rows(
    rows: &[sqlx_postgres::PgRow],
    anchor_digest: &ContentDigest,
) -> Result<Option<PendingFileSummary>, StorageError> {
    let Some(first) = rows.first() else {
        return Ok(None);
    };
    let generation_id = text(first, 0)?;
    let path = text(first, 1)?;
    let file_content_hash = text(first, 2)?;
    let summarized_symbols = nonnegative_u64(first, 7)?;
    let items = rows
        .iter()
        .map(|row| {
            if text(row, 0)? != generation_id
                || text(row, 1)? != path
                || text(row, 2)? != file_content_hash
                || nonnegative_u64(row, 7)? != summarized_symbols
            {
                return Err(StorageError::CorruptStoredValue {
                    field: "file_summary_evidence",
                });
            }
            Ok(SummaryRollupItem {
                symbol_id: text(row, 3)?,
                qualified_name: text(row, 4)?,
                symbol_kind: text(row, 5)?,
                summary: text(row, 6)?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let content_hash = summary_rollup_digest(
        "cartograph:file-summary:v2",
        &path,
        &file_content_hash,
        summarized_symbols,
        &items,
        anchor_digest,
    );
    Ok(Some(PendingFileSummary {
        generation_id,
        path,
        file_content_hash,
        content_hash: content_hash.as_str().to_owned(),
        summarized_symbols,
        items_truncated: summarized_symbols
            > u64::try_from(items.len()).map_err(|_| StorageError::CorruptStoredValue {
                field: "file_summary_evidence",
            })?,
        items,
    }))
}

fn pending_module_summary_from_evidence_rows(
    rows: &[sqlx_postgres::PgRow],
    anchor_digest: &ContentDigest,
) -> Result<Option<PendingModuleSummary>, StorageError> {
    let Some(first) = rows.first() else {
        return Ok(None);
    };
    let generation_id = text(first, 0)?;
    let first_path = text(first, 1)?;
    let directory =
        immediate_parent_directory(&first_path).ok_or(StorageError::CorruptStoredValue {
            field: "module_summary_evidence",
        })?;
    let summarized_symbols = nonnegative_u64(first, 6)?;
    let tool_export_constants = nonnegative_u64(first, 7)?;
    let items = rows
        .iter()
        .map(|row| {
            let path = text(row, 1)?;
            if text(row, 0)? != generation_id
                || immediate_parent_directory(&path).as_deref() != Some(directory.as_str())
                || nonnegative_u64(row, 6)? != summarized_symbols
                || nonnegative_u64(row, 7)? != tool_export_constants
            {
                return Err(StorageError::CorruptStoredValue {
                    field: "module_summary_evidence",
                });
            }
            Ok(ModuleSummaryRollupItem {
                symbol_id: text(row, 2)?,
                path,
                qualified_name: text(row, 3)?,
                symbol_kind: text(row, 4)?,
                summary: text(row, 5)?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let content_hash = module_summary_rollup_digest(
        &directory,
        summarized_symbols,
        tool_export_constants,
        &items,
        anchor_digest,
    );
    Ok(Some(PendingModuleSummary {
        generation_id,
        directory,
        content_hash: content_hash.as_str().to_owned(),
        summarized_symbols,
        tool_export_constants,
        items_truncated: summarized_symbols
            > u64::try_from(items.len()).map_err(|_| StorageError::CorruptStoredValue {
                field: "module_summary_evidence",
            })?,
        items,
    }))
}

fn decode_pending_file_summary(
    row: &sqlx_postgres::PgRow,
    anchor_digest: &ContentDigest,
) -> Result<PendingFileSummary, StorageError> {
    let generation_id = text(row, 0)?;
    let path = text(row, 1)?;
    let file_content_hash = text(row, 2)?;
    let summarized_symbols = nonnegative_u64(row, 3)?;
    let items = serde_json::from_str::<Vec<SummaryRollupItem>>(&text(row, 4)?).map_err(|_| {
        StorageError::CorruptStoredValue {
            field: "file_summary_evidence",
        }
    })?;
    if items.is_empty()
        || items.len() > usize::from(MAX_SUMMARY_ROLLUP_ITEMS)
        || items.iter().any(|item| {
            item.symbol_id.is_empty()
                || item.qualified_name.is_empty()
                || item.symbol_kind.is_empty()
                || item.summary.is_empty()
                || item.summary.len()
                    > usize::try_from(SUMMARY_ROLLUP_ITEM_MAXIMUM_CHARACTERS).unwrap_or(usize::MAX)
        })
    {
        return Err(StorageError::CorruptStoredValue {
            field: "file_summary_evidence",
        });
    }
    let items_truncated =
        row.try_get::<bool, _>(5)
            .map_err(|_| StorageError::CorruptStoredValue {
                field: "file_summary_evidence",
            })?;
    let content_hash = summary_rollup_digest(
        "cartograph:file-summary:v2",
        &path,
        &file_content_hash,
        summarized_symbols,
        &items,
        anchor_digest,
    );
    Ok(PendingFileSummary {
        generation_id,
        path,
        file_content_hash,
        content_hash: content_hash.as_str().to_owned(),
        summarized_symbols,
        items,
        items_truncated,
    })
}

fn decode_pending_module_summary(
    row: &sqlx_postgres::PgRow,
    anchor_digest: &ContentDigest,
) -> Result<PendingModuleSummary, StorageError> {
    let generation_id = text(row, 0)?;
    let directory = text(row, 1)?;
    NormalizedPath::parse(&directory).map_err(|_| StorageError::CorruptStoredValue {
        field: "module_summary_evidence",
    })?;
    let summarized_symbols = nonnegative_u64(row, 2)?;
    let tool_export_constants = nonnegative_u64(row, 3)?;
    let items =
        serde_json::from_str::<Vec<ModuleSummaryRollupItem>>(&text(row, 4)?).map_err(|_| {
            StorageError::CorruptStoredValue {
                field: "module_summary_evidence",
            }
        })?;
    if summarized_symbols < MIN_MODULE_SUMMARY_SYMBOLS
        || items.is_empty()
        || items.len() > usize::from(MAX_MODULE_SUMMARY_ROLLUP_ITEMS)
        || items.iter().any(|item| {
            immediate_parent_directory(&item.path).as_deref() != Some(directory.as_str())
                || item.symbol_id.is_empty()
                || item.qualified_name.is_empty()
                || item.symbol_kind.is_empty()
                || item.summary.is_empty()
                || item.summary.len()
                    > usize::try_from(SUMMARY_ROLLUP_ITEM_MAXIMUM_CHARACTERS).unwrap_or(usize::MAX)
        })
    {
        return Err(StorageError::CorruptStoredValue {
            field: "module_summary_evidence",
        });
    }
    let items_truncated =
        row.try_get::<bool, _>(5)
            .map_err(|_| StorageError::CorruptStoredValue {
                field: "module_summary_evidence",
            })?;
    let content_hash = module_summary_rollup_digest(
        &directory,
        summarized_symbols,
        tool_export_constants,
        &items,
        anchor_digest,
    );
    Ok(PendingModuleSummary {
        generation_id,
        directory,
        content_hash: content_hash.as_str().to_owned(),
        summarized_symbols,
        tool_export_constants,
        items,
        items_truncated,
    })
}

fn summary_rollup_digest(
    domain: &str,
    scope_key: &str,
    source_hash: &str,
    total_items: u64,
    items: &[SummaryRollupItem],
    anchor_digest: &ContentDigest,
) -> ContentDigest {
    let mut hasher = blake3::Hasher::new();
    for field in [domain, scope_key, source_hash, anchor_digest.as_str()] {
        hash_rollup_field(&mut hasher, field.as_bytes());
    }
    hash_rollup_field(&mut hasher, &total_items.to_be_bytes());
    for item in items {
        for field in [
            item.symbol_id.as_str(),
            item.qualified_name.as_str(),
            item.symbol_kind.as_str(),
            item.summary.as_str(),
        ] {
            hash_rollup_field(&mut hasher, field.as_bytes());
        }
    }
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

fn module_summary_rollup_digest(
    directory: &str,
    total_items: u64,
    tool_export_constants: u64,
    items: &[ModuleSummaryRollupItem],
    anchor_digest: &ContentDigest,
) -> ContentDigest {
    let mut hasher = blake3::Hasher::new();
    for field in [
        "cartograph:module-summary:v2",
        directory,
        anchor_digest.as_str(),
    ] {
        hash_rollup_field(&mut hasher, field.as_bytes());
    }
    hash_rollup_field(&mut hasher, &total_items.to_be_bytes());
    hash_rollup_field(&mut hasher, &tool_export_constants.to_be_bytes());
    for item in items {
        for field in [
            item.symbol_id.as_str(),
            item.path.as_str(),
            item.qualified_name.as_str(),
            item.symbol_kind.as_str(),
            item.summary.as_str(),
        ] {
            hash_rollup_field(&mut hasher, field.as_bytes());
        }
    }
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

fn immediate_parent_directory(path: &str) -> Option<String> {
    let (directory, file) = path.rsplit_once('/')?;
    (!directory.is_empty() && !file.is_empty()).then(|| directory.to_owned())
}

fn hash_rollup_field(hasher: &mut blake3::Hasher, value: &[u8]) {
    hasher.update(&u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn validate_artifact(artifact: &NewAgentArtifact) -> Result<(), StorageError> {
    validate_scope_key(&artifact.scope_key)?;
    validate_body(&artifact.body, artifact.state)?;
    validate_metadata(&artifact.metadata)
}

fn validate_model(model: &str) -> Result<(), StorageError> {
    if model.is_empty() || model.len() > 256 || model.contains('\0') {
        Err(StorageError::InvalidInput { field: "model" })
    } else {
        Ok(())
    }
}

fn validate_scope_key(value: &str) -> Result<(), StorageError> {
    if value.is_empty() || value.len() > MAX_ARTIFACT_KEY_BYTES || value.contains('\0') {
        Err(StorageError::InvalidInput {
            field: "artifact_scope_key",
        })
    } else {
        Ok(())
    }
}

fn validate_body(value: &str, state: AgentArtifactState) -> Result<(), StorageError> {
    if value.len() > MAX_ARTIFACT_BODY_BYTES
        || value.contains('\0')
        || (value.is_empty() && state != AgentArtifactState::Pending)
    {
        Err(StorageError::InvalidInput {
            field: "artifact_body",
        })
    } else {
        Ok(())
    }
}

fn validate_metadata(value: &Value) -> Result<(), StorageError> {
    let encoded = serde_json::to_vec(value).map_err(|_| StorageError::InvalidInput {
        field: "artifact_metadata",
    })?;
    if !value.is_object() || encoded.len() > MAX_ARTIFACT_METADATA_BYTES {
        Err(StorageError::InvalidInput {
            field: "artifact_metadata",
        })
    } else {
        Ok(())
    }
}

fn validate_limit(limit: u16, maximum: u16) -> Result<(), StorageError> {
    if limit == 0 || limit > maximum {
        Err(StorageError::InvalidInput { field: "limit" })
    } else {
        Ok(())
    }
}

fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn decode_artifact(row: &sqlx_postgres::PgRow) -> Result<AgentArtifactRecord, StorageError> {
    let id = row
        .try_get::<i64, _>(0)
        .ok()
        .and_then(|id| u64::try_from(id).ok())
        .filter(|id| *id > 0)
        .ok_or(StorageError::CorruptStoredValue {
            field: "artifact_id",
        })?;
    let kind = text(row, 2).and_then(|value| {
        AgentArtifactKind::parse(&value).ok_or(StorageError::CorruptStoredValue {
            field: "artifact_kind",
        })
    })?;
    let scope = text(row, 3).and_then(|value| {
        AgentArtifactScope::parse(&value).ok_or(StorageError::CorruptStoredValue {
            field: "artifact_scope",
        })
    })?;
    let state = text(row, 9).and_then(|value| {
        AgentArtifactState::parse(&value).ok_or(StorageError::CorruptStoredValue {
            field: "artifact_state",
        })
    })?;
    let metadata = text(row, 6).and_then(|value| {
        serde_json::from_str(&value).map_err(|_| StorageError::CorruptStoredValue {
            field: "artifact_metadata",
        })
    })?;
    Ok(AgentArtifactRecord {
        id,
        artifact_id: text(row, 1)?,
        kind,
        scope,
        scope_key: text(row, 4)?,
        body: text(row, 5)?,
        metadata,
        generation_id: optional_text(row, 7)?,
        source_digest: optional_text(row, 8)?,
        state,
        created_at: text(row, 10)?,
        updated_at: text(row, 11)?,
    })
}

fn decode_pending_summary(
    row: &sqlx_postgres::PgRow,
) -> Result<PendingSummarySymbol, StorageError> {
    Ok(PendingSummarySymbol {
        generation_id: text(row, 0)?,
        symbol_id: text(row, 1)?,
        path: text(row, 2)?,
        language: text(row, 3)?,
        symbol_kind: text(row, 4)?,
        qualified_name: text(row, 5)?,
        signature: text(row, 6)?,
        start_line: positive_u32(row, 7)?,
        end_line: positive_u32(row, 8)?,
        content_hash: text(row, 9)?,
        code: text(row, 10)?,
        code_truncated: row
            .try_get::<bool, _>(11)
            .map_err(|_| StorageError::CorruptStoredValue { field: "artifact" })?,
        priority: row
            .try_get::<bool, _>(12)
            .map_err(|_| StorageError::CorruptStoredValue { field: "artifact" })?,
    })
}

fn decode_pending_structural_summary(
    row: &sqlx_postgres::PgRow,
) -> Result<PendingStructuralSummary, StorageError> {
    let edges =
        serde_json::from_str(&text(row, 12)?).map_err(|_| StorageError::CorruptStoredValue {
            field: "structural_summary_edges",
        })?;
    Ok(PendingStructuralSummary {
        generation_id: text(row, 0)?,
        symbol_id: text(row, 1)?,
        path: text(row, 2)?,
        symbol_kind: text(row, 3)?,
        name: text(row, 4)?,
        qualified_name: text(row, 5)?,
        signature: text(row, 6)?,
        code: text(row, 7)?,
        start_line: positive_u32(row, 8)?,
        end_line: positive_u32(row, 9)?,
        content_hash: text(row, 10)?,
        declaration_only: row.try_get::<bool, _>(11).map_err(|_| {
            StorageError::CorruptStoredValue {
                field: "structural_summary",
            }
        })?,
        edges,
    })
}

fn decode_pending_neighbor_summary(
    row: &sqlx_postgres::PgRow,
) -> Result<PendingNeighborSummary, StorageError> {
    Ok(PendingNeighborSummary {
        generation_id: text(row, 0)?,
        symbol_id: text(row, 1)?,
        symbol_kind: text(row, 2)?,
        name: text(row, 3)?,
        content_hash: text(row, 4)?,
    })
}

fn decode_neighbor_summary_source(
    row: &sqlx_postgres::PgRow,
) -> Result<NeighborSummarySource, StorageError> {
    Ok(NeighborSummarySource {
        symbol_id: text(row, 0)?,
        symbol_kind: text(row, 1)?,
        name: text(row, 2)?,
        summary: text(row, 3)?,
        model: text(row, 4)?,
    })
}

fn decode_pending_role(row: &sqlx_postgres::PgRow) -> Result<PendingRoleSymbol, StorageError> {
    Ok(PendingRoleSymbol {
        symbol_id: text(row, 0)?,
        path: text(row, 1)?,
        language: text(row, 2)?,
        symbol_kind: text(row, 3)?,
        qualified_name: text(row, 4)?,
        signature: text(row, 5)?,
        description: text(row, 6)?,
        code: text(row, 7)?,
        exported: row
            .try_get::<bool, _>(8)
            .map_err(|_| StorageError::CorruptStoredValue { field: "artifact" })?,
    })
}

fn text(row: &sqlx_postgres::PgRow, index: usize) -> Result<String, StorageError> {
    row.try_get(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "artifact" })
}

fn optional_text(row: &sqlx_postgres::PgRow, index: usize) -> Result<Option<String>, StorageError> {
    row.try_get(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "artifact" })
}

fn positive_u32(row: &sqlx_postgres::PgRow, index: usize) -> Result<u32, StorageError> {
    row.try_get::<i32, _>(index)
        .ok()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or(StorageError::CorruptStoredValue { field: "artifact" })
}

fn nonnegative_u64(row: &sqlx_postgres::PgRow, index: usize) -> Result<u64, StorageError> {
    row.try_get::<i64, _>(index)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(StorageError::CorruptStoredValue { field: "artifact" })
}

fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_bounds_and_identifier_validation_fail_closed() {
        assert!(
            NewAgentArtifact::new(
                AgentArtifactKind::Note,
                AgentArtifactScope::Project,
                "project",
                "remember this"
            )
            .is_ok()
        );
        assert!(
            NewAgentArtifact::new(
                AgentArtifactKind::Note,
                AgentArtifactScope::Project,
                "",
                "remember this"
            )
            .is_err()
        );
        assert!(!canonical_uuid("../../not-an-artifact"));
        assert!(canonical_uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    }

    #[test]
    fn metadata_must_be_a_bounded_json_object() {
        let artifact = NewAgentArtifact::new(
            AgentArtifactKind::Role,
            AgentArtifactScope::Symbol,
            "symbol",
            "business_logic",
        )
        .unwrap_or_else(|error| panic!("valid artifact failed: {error}"));
        assert!(
            artifact
                .clone()
                .with_metadata(serde_json::json!({"via": "rule"}))
                .is_ok()
        );
        assert!(
            artifact
                .with_metadata(serde_json::json!(["not", "an", "object"]))
                .is_err()
        );
    }

    #[test]
    fn summary_candidate_policy_is_bounded_and_keeps_the_route_floor() {
        let default = SummaryCandidatePolicy::default();
        assert_eq!(default.minimum_body_lines, 4);
        assert_eq!(default.minimum_body_lines_by_kind.get("route"), Some(&1));
        assert!(SummaryCandidatePolicy::new(2, BTreeMap::from([("method".to_owned(), 1)])).is_ok());
        assert!(
            SummaryCandidatePolicy::new(2, BTreeMap::from([("bad\nkind".to_owned(), 1)])).is_err()
        );
        assert!(
            SummaryCandidatePolicy::new(MAX_SUMMARY_MINIMUM_BODY_LINES + 1, BTreeMap::new())
                .is_err()
        );
    }
}
