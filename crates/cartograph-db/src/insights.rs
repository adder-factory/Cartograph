use std::{collections::BTreeMap, time::Duration};

use cartograph_domain::{ContentDigest, GenerationId, NormalizedPath, ProjectId, SymbolId};
use serde::Serialize;
use serde_json::Value;
use sqlx_core::{column::ColumnIndex, row::Row};

use crate::{
    CartographDatabase, StorageError, StructuralFindingRefresh,
    database::{PgQuery, RowReadRequest, quoted_schema, read_rows},
};

const DEFAULT_INSIGHT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_INSIGHT_LIMIT: u16 = 500;
const MAX_IMPORT_INSIGHTS: i64 = 250_000;
const IMPORT_INSIGHT_OVERFLOW_PROBE: i64 = MAX_IMPORT_INSIGHTS + 1;
const MAX_RENAME_REFERENCES: i64 = 250_000;
const RENAME_REFERENCE_OVERFLOW_PROBE: i64 = MAX_RENAME_REFERENCES + 1;
const MAX_EXTERNAL_IMPORTS: i64 = 250_000;
const EXTERNAL_IMPORT_OVERFLOW_PROBE: i64 = MAX_EXTERNAL_IMPORTS + 1;
const MAX_TEST_IMPACT_INPUTS: usize = 128;
const MAX_TEST_IMPACT_DEPTH: u8 = 50;
const MAX_REPORTED_BARRELS: usize = 100;
const MAX_FILE_FINGERPRINTS: i64 = 250_000;
const FILE_FINGERPRINT_OVERFLOW_PROBE: i64 = MAX_FILE_FINGERPRINTS + 1;
const MAX_GROUPED_PATH_KEYS: usize = 52;
const MAX_GROUPED_PATHS_PER_KEY: usize = 500;
const MAX_GROUPED_PATHS: usize = 10_400;
const MAX_GROUP_KEY_BYTES: usize = 128;

/// One structurally unreferenced implementation candidate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadCodeCandidate {
    symbol_id: String,
    path: String,
    language: String,
    symbol_kind: String,
    qualified_name: String,
    start_line: u32,
    incoming_edges: u64,
    outgoing_edges: u64,
    safe_code: String,
    interface_dispatch_risk: bool,
    reason: &'static str,
}

impl DeadCodeCandidate {
    #[must_use]
    /// Returns the symbol ID.
    pub fn symbol_id(&self) -> &str {
        &self.symbol_id
    }

    #[must_use]
    /// Returns the path.
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    /// Returns the language.
    pub fn language(&self) -> &str {
        &self.language
    }

    #[must_use]
    /// Returns the symbol kind.
    pub fn symbol_kind(&self) -> &str {
        &self.symbol_kind
    }

    #[must_use]
    /// Returns the qualified name.
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    #[must_use]
    /// Returns the start line.
    pub const fn start_line(&self) -> u32 {
        self.start_line
    }

    #[must_use]
    /// Returns the outgoing edges.
    pub const fn outgoing_edges(&self) -> u64 {
        self.outgoing_edges
    }

    #[must_use]
    /// Returns the safe code.
    pub fn safe_code(&self) -> &str {
        &self.safe_code
    }

    #[must_use]
    /// Returns the interface dispatch risk.
    pub const fn interface_dispatch_risk(&self) -> bool {
        self.interface_dispatch_risk
    }
}

/// Database-side orphan filters applied before the candidate cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeadCodeQuery {
    limit: u16,
    include_tests: bool,
    exclude_fixtures: bool,
}

impl DeadCodeQuery {
    /// Creates a validated dead code query.
    ///
    /// # Errors
    ///
    /// Returns an error if `limit` is zero or exceeds the insight row maximum.
    pub fn new(limit: u16) -> Result<Self, StorageError> {
        validate_limit(limit)?;
        Ok(Self {
            limit,
            include_tests: false,
            exclude_fixtures: true,
        })
    }

    #[must_use]
    /// Sets the include tests and returns the updated value.
    pub const fn with_include_tests(mut self, include: bool) -> Self {
        self.include_tests = include;
        self
    }

    #[must_use]
    /// Sets the exclude fixtures and returns the updated value.
    pub const fn with_exclude_fixtures(mut self, exclude: bool) -> Self {
        self.exclude_fixtures = exclude;
        self
    }
}

/// One file ranked by current-generation structural pressure.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralHotspot {
    path: String,
    language: String,
    symbols: u64,
    incoming_edges: u64,
    outgoing_edges: u64,
    unresolved_references: u64,
    routes: u64,
    structural_risk: u64,
    commit_count: u64,
    author_count: u64,
    insertions: u64,
    deletions: u64,
    last_touched_at: Option<String>,
    last_touched_unix_seconds: Option<u64>,
    history_available: bool,
    composite_risk: u64,
    centrality: f64,
    structural_pressure: f64,
    churn_score: f64,
    risk_score: f64,
    maintenance_score: f64,
    brittle_score: f64,
    external_dependents: u64,
}

/// Maintenance lens applied before the database result cap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StructuralHotspotCategory {
    #[default]
    /// Composite structural and change risk.
    Risk,
    /// High maintenance activity or cost.
    Maintenance,
    /// Structural fragility with elevated dependent impact.
    Brittle,
}

/// Stable database-side ordering for risk hotspots.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StructuralHotspotSort {
    #[default]
    /// Order by composite risk score.
    Risk,
    /// Order by graph centrality.
    Centrality,
    /// Order by Git churn.
    Churn,
}

/// Validated hotspot filters that all execute before LIMIT.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StructuralHotspotQuery {
    category: StructuralHotspotCategory,
    sort: StructuralHotspotSort,
    minimum_commits: u64,
    minimum_centrality: f64,
    recency_days: Option<u32>,
    limit: u16,
}

impl StructuralHotspotQuery {
    /// Creates a validated structural hotspot query.
    ///
    /// # Errors
    ///
    /// Returns an error if `limit` is zero or exceeds the hotspot row maximum.
    pub fn new(limit: u16) -> Result<Self, StorageError> {
        validate_limit(limit)?;
        Ok(Self {
            category: StructuralHotspotCategory::Risk,
            sort: StructuralHotspotSort::Risk,
            minimum_commits: 0,
            minimum_centrality: 0.0,
            recency_days: None,
            limit,
        })
    }

    #[must_use]
    /// Sets the category and returns the updated value.
    pub const fn with_category(mut self, category: StructuralHotspotCategory) -> Self {
        self.category = category;
        self
    }

    #[must_use]
    /// Sets the sort and returns the updated value.
    pub const fn with_sort(mut self, sort: StructuralHotspotSort) -> Self {
        self.sort = sort;
        self
    }

    /// Sets the minimum commits and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if `commits` cannot be represented by PostgreSQL's
    /// signed `bigint` comparison.
    pub fn with_minimum_commits(mut self, commits: u64) -> Result<Self, StorageError> {
        if commits > i64::MAX as u64 {
            return Err(StorageError::InvalidInput {
                field: "hotspot_minimum_commits",
            });
        }
        self.minimum_commits = commits;
        Ok(self)
    }

    /// Sets the minimum centrality and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if `minimum` is non-finite or outside the inclusive
    /// normalized centrality range from zero to one.
    pub fn with_minimum_centrality(mut self, minimum: f64) -> Result<Self, StorageError> {
        if !minimum.is_finite() || !(0.0..=1.0).contains(&minimum) {
            return Err(StorageError::InvalidInput {
                field: "hotspot_minimum_centrality",
            });
        }
        self.minimum_centrality = minimum;
        Ok(self)
    }

    /// Sets the recency days and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if the optional recency window is zero days.
    pub fn with_recency_days(mut self, days: Option<u32>) -> Result<Self, StorageError> {
        if days == Some(0) {
            return Err(StorageError::InvalidInput {
                field: "hotspot_recency_days",
            });
        }
        self.recency_days = days;
        Ok(self)
    }
}

impl StructuralHotspot {
    #[must_use]
    /// Returns the path.
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    /// Returns the incoming edges.
    pub const fn incoming_edges(&self) -> u64 {
        self.incoming_edges
    }

    #[must_use]
    /// Returns the structural risk.
    pub const fn structural_risk(&self) -> u64 {
        self.structural_risk
    }

    #[must_use]
    /// Returns the commit count.
    pub const fn commit_count(&self) -> u64 {
        self.commit_count
    }

    #[must_use]
    /// Returns the last touched unix seconds.
    pub const fn last_touched_unix_seconds(&self) -> Option<u64> {
        self.last_touched_unix_seconds
    }

    #[must_use]
    /// Returns the composite risk.
    pub const fn composite_risk(&self) -> u64 {
        self.composite_risk
    }

    #[must_use]
    /// Returns the centrality.
    pub const fn centrality(&self) -> f64 {
        self.centrality
    }

    #[must_use]
    /// Returns the external dependents.
    pub const fn external_dependents(&self) -> u64 {
        self.external_dependents
    }

    #[must_use]
    /// Returns the risk score.
    pub const fn risk_score(&self) -> f64 {
        self.risk_score
    }
}

/// One caller-defined group of current project paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupedPathInput {
    key: String,
    paths: Vec<NormalizedPath>,
}

impl GroupedPathInput {
    /// Build one bounded, de-duplicated path group.
    /// # Errors
    ///
    /// Returns an error if the key is empty/oversized/NUL-containing or the
    /// de-duplicated path set is empty or exceeds its group cap.
    pub fn new(key: &str, paths: Vec<NormalizedPath>) -> Result<Self, StorageError> {
        if key.is_empty() || key.len() > MAX_GROUP_KEY_BYTES || key.contains('\0') {
            return Err(StorageError::InvalidInput {
                field: "grouped_path_key",
            });
        }
        let paths = paths.into_iter().collect::<std::collections::BTreeSet<_>>();
        if paths.is_empty() || paths.len() > MAX_GROUPED_PATHS_PER_KEY {
            return Err(StorageError::InvalidInput {
                field: "grouped_paths",
            });
        }
        Ok(Self {
            key: key.to_owned(),
            paths: paths.into_iter().collect(),
        })
    }
}

/// Validated grouped-path symbol lookup with one independent cap per group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupedSymbolQuery {
    groups: Vec<GroupedPathInput>,
    excluded_symbol_id: Option<SymbolId>,
    per_group_limit: u16,
}

impl GroupedSymbolQuery {
    /// Build a grouped current-symbol query executed in one PostgreSQL statement.
    /// # Errors
    ///
    /// Returns an error if groups are empty/too numerous, keys repeat, total
    /// path arithmetic/caps fail, or `per_group_limit` is invalid.
    pub fn new(groups: Vec<GroupedPathInput>, per_group_limit: u16) -> Result<Self, StorageError> {
        validate_limit(per_group_limit)?;
        let total_paths = groups
            .iter()
            .try_fold(0_usize, |total, group| total.checked_add(group.paths.len()))
            .ok_or(StorageError::InvalidInput {
                field: "grouped_paths",
            })?;
        let unique_keys = groups
            .iter()
            .map(|group| group.key.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        if groups.is_empty()
            || groups.len() > MAX_GROUPED_PATH_KEYS
            || unique_keys.len() != groups.len()
            || total_paths > MAX_GROUPED_PATHS
        {
            return Err(StorageError::InvalidInput {
                field: "grouped_paths",
            });
        }
        Ok(Self {
            groups,
            excluded_symbol_id: None,
            per_group_limit,
        })
    }

    /// Exclude the blamed/root symbol itself from every peer group.
    #[must_use]
    pub fn excluding_symbol(mut self, symbol_id: SymbolId) -> Self {
        self.excluded_symbol_id = Some(symbol_id);
        self
    }
}

/// One current-generation symbol attributed through a caller path group.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedSymbolPeer {
    symbol_id: String,
    path: String,
    language: String,
    symbol_kind: String,
    qualified_name: String,
    start_line: u32,
    end_line: u32,
}

/// Exact pre-limit count and bounded peers for one input group.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedSymbolPeers {
    key: String,
    total: u64,
    peers: Vec<GroupedSymbolPeer>,
    truncated: bool,
}

impl GroupedSymbolPeers {
    /// Caller-supplied stable group key.
    #[must_use]
    pub fn key(&self) -> &str {
        &self.key
    }
}

/// One current-generation import with exact resolution evidence.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInsight {
    path: String,
    language: String,
    owner_symbol_id: Option<String>,
    module_specifier: String,
    target_symbol_id: Option<String>,
    target_path: Option<String>,
    start_byte: u64,
    end_byte: u64,
    confidence: f32,
    provenance: String,
    site_count: u64,
    source_file_symbol_id: String,
}

impl ImportInsight {
    #[must_use]
    /// Returns the path.
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    /// Returns the language.
    pub fn language(&self) -> &str {
        &self.language
    }

    #[must_use]
    /// Returns the owner symbol ID.
    pub fn owner_symbol_id(&self) -> Option<&str> {
        self.owner_symbol_id.as_deref()
    }

    #[must_use]
    /// Returns the module specifier.
    pub fn module_specifier(&self) -> &str {
        &self.module_specifier
    }

    #[must_use]
    /// Returns the target path.
    pub fn target_path(&self) -> Option<&str> {
        self.target_path.as_deref()
    }

    #[must_use]
    /// Returns the target symbol ID.
    pub fn target_symbol_id(&self) -> Option<&str> {
        self.target_symbol_id.as_deref()
    }

    #[must_use]
    /// Returns the evidence symbol ID.
    pub fn evidence_symbol_id(&self) -> &str {
        self.owner_symbol_id
            .as_deref()
            .unwrap_or(&self.source_file_symbol_id)
    }

    #[must_use]
    /// Returns the start byte.
    pub const fn start_byte(&self) -> u64 {
        self.start_byte
    }

    #[must_use]
    /// Returns the end byte.
    pub const fn end_byte(&self) -> u64 {
        self.end_byte
    }

    #[must_use]
    /// Returns the confidence.
    pub const fn confidence(&self) -> f32 {
        self.confidence
    }

    #[must_use]
    /// Returns the provenance.
    pub fn provenance(&self) -> &str {
        &self.provenance
    }

    #[must_use]
    /// Returns the site count.
    pub const fn site_count(&self) -> u64 {
        self.site_count
    }
}

/// One JavaScript-family external import used by package-manifest auditing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImportRecord {
    path: String,
    language: String,
    module_specifier: String,
    site_count: u64,
}

impl ExternalImportRecord {
    #[must_use]
    /// Returns the path.
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    /// Returns the module specifier.
    pub fn module_specifier(&self) -> &str {
        &self.module_specifier
    }

    #[must_use]
    /// Returns the site count.
    pub const fn site_count(&self) -> u64 {
        self.site_count
    }
}

/// Resolution coverage for one current-generation language/reference family.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyCoverageRow {
    language: String,
    reference_kind: String,
    references: u64,
    resolved: u64,
    unresolved: u64,
    represented_sites: u64,
}

/// One exact reference site participating in a rename plan.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameReferenceSite {
    path: String,
    owner_symbol_id: Option<String>,
    start_byte: u64,
    end_byte: u64,
    reference_kind: String,
    confidence: f32,
    provenance: String,
}

impl RenameReferenceSite {
    #[must_use]
    /// Returns the path.
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    /// Returns the owner symbol ID.
    pub fn owner_symbol_id(&self) -> Option<&str> {
        self.owner_symbol_id.as_deref()
    }

    #[must_use]
    /// Returns the start byte.
    pub const fn start_byte(&self) -> u64 {
        self.start_byte
    }

    #[must_use]
    /// Returns the end byte.
    pub const fn end_byte(&self) -> u64 {
        self.end_byte
    }

    #[must_use]
    /// Returns the reference kind.
    pub fn reference_kind(&self) -> &str {
        &self.reference_kind
    }

    #[must_use]
    /// Returns the confidence.
    pub const fn confidence(&self) -> f32 {
        self.confidence
    }

    #[must_use]
    /// Returns the provenance.
    pub fn provenance(&self) -> &str {
        &self.provenance
    }
}

/// One graph-derived test-coverage row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralCoverageRow {
    symbol_id: String,
    path: String,
    qualified_name: String,
    symbol_kind: String,
    direct_test_files: u64,
    incoming_edges: u64,
}

/// One test file reached from changed files through the current dependency graph.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTestImpact {
    path: String,
    distance: u8,
    reason: &'static str,
}

impl FileTestImpact {
    /// Canonical project-relative test path.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Minimum cross-symbol graph distance from any input file.
    #[must_use]
    pub const fn distance(&self) -> u8 {
        self.distance
    }
}

/// PostgreSQL-native changed-file to affected-test traversal with bounded counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTestImpactResult {
    generation_id: GenerationId,
    matched_inputs: Vec<String>,
    dependent_file_count: u64,
    affected_test_file_count: u64,
    reached_barrel_count: u64,
    reached_barrels: Vec<String>,
    nodes_truncated: bool,
    barrels_truncated: bool,
    tests: Vec<FileTestImpact>,
    tests_truncated: bool,
}

/// Bounded reverse dependency traversal from exact current-generation files.
pub struct FileTestImpactQuery<'a> {
    /// Stable project ID for this record.
    pub project_id: &'a ProjectId,
    /// Project-relative paths for this record.
    pub paths: &'a [NormalizedPath],
    /// Maximum reverse-dependency traversal depth.
    pub max_depth: u8,
    /// Maximum number of distinct symbols admitted to the bounded traversal result.
    pub max_nodes: u16,
    /// Maximum number of entries returned by this bounded request.
    pub limit: u16,
    /// Optional test path regex, when available.
    pub test_path_regex: Option<&'a str>,
}

/// One current-generation path and exact indexed source digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFileFingerprint {
    path: NormalizedPath,
    content_hash: ContentDigest,
}

impl IndexedFileFingerprint {
    /// Canonical project-relative path.
    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    /// Digest of the exact source bytes indexed in the current generation.
    #[must_use]
    pub const fn content_hash(&self) -> &ContentDigest {
        &self.content_hash
    }
}

impl FileTestImpactResult {
    /// Immutable generation traversed by the query.
    #[must_use]
    pub const fn generation_id(&self) -> &GenerationId {
        &self.generation_id
    }

    /// Canonical input paths that existed in this generation.
    #[must_use]
    pub fn matched_inputs(&self) -> &[String] {
        &self.matched_inputs
    }

    /// Distinct non-input files reached within the admitted node budget.
    #[must_use]
    pub const fn dependent_file_count(&self) -> u64 {
        self.dependent_file_count
    }

    /// Affected test files found within the admitted node budget before output limiting.
    #[must_use]
    pub const fn affected_test_file_count(&self) -> u64 {
        self.affected_test_file_count
    }

    /// Whether more distinct symbols existed than the requested traversal node budget.
    #[must_use]
    pub const fn nodes_truncated(&self) -> bool {
        self.nodes_truncated
    }

    /// Complete number of public API barrels reached after the input layer.
    #[must_use]
    pub const fn reached_barrel_count(&self) -> u64 {
        self.reached_barrel_count
    }

    /// Bounded canonical paths for reached public API barrels.
    #[must_use]
    pub fn reached_barrels(&self) -> &[String] {
        &self.reached_barrels
    }

    /// Ordered affected test files retained under the response limit.
    #[must_use]
    pub fn tests(&self) -> &[FileTestImpact] {
        &self.tests
    }
}

/// One deterministic code-health signal derived from current graph facts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralFinding {
    symbol_id: String,
    path: String,
    qualified_name: String,
    finding: String,
    severity: String,
    start_line: u32,
    end_line: u32,
    metric_name: String,
    metric: f64,
    degree_centrality: f64,
    outgoing_edges: u64,
    unresolved_references: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<Value>,
}

/// Minimum severity accepted by a structural-finding query.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StructuralFindingSeverity {
    /// Include informational, warning, and error findings.
    Info,
    /// Include warning and error findings.
    #[default]
    Warning,
    /// Include only error findings.
    Error,
}

impl StructuralFindingSeverity {
    const fn rank(self) -> i16 {
        match self {
            Self::Info => 1,
            Self::Warning => 2,
            Self::Error => 3,
        }
    }
}

/// Fully bounded database-side filters for ranked structural findings.
#[derive(Clone, Debug, PartialEq)]
pub struct StructuralFindingQuery {
    limit: u16,
    finding: Option<String>,
    minimum_severity: StructuralFindingSeverity,
    minimum_metric: Option<f64>,
    maximum_metric: Option<f64>,
    minimum_centrality: Option<f64>,
    excluded_path_prefix: Option<String>,
    path_prefix: Option<String>,
    symbol_ids: Vec<SymbolId>,
    exclude_fixtures: bool,
}

/// Per-detector bounds for an audit that must not let one noisy rule starve others.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StructuralFindingGroupQuery {
    findings: Vec<String>,
    minimum_severity: StructuralFindingSeverity,
    per_finding_limit: u16,
    exclude_fixtures: bool,
}

impl StructuralFindingGroupQuery {
    /// Build a query for up to 64 detector names with an independent row cap.
    /// # Errors
    ///
    /// Returns an error if the detector list is empty/over 64, a name is
    /// invalid, or `per_finding_limit` is outside the insight bounds.
    pub fn new(findings: Vec<String>, per_finding_limit: u16) -> Result<Self, StorageError> {
        if findings.is_empty() || findings.len() > 64 {
            return Err(StorageError::InvalidInput {
                field: "finding_group",
            });
        }
        validate_limit(per_finding_limit)?;
        let mut unique = Vec::with_capacity(findings.len());
        for finding in findings {
            validate_finding_text(Some(&finding), "finding_group")?;
            if !unique.contains(&finding) {
                unique.push(finding);
            }
        }
        Ok(Self {
            findings: unique,
            minimum_severity: StructuralFindingSeverity::default(),
            per_finding_limit,
            exclude_fixtures: false,
        })
    }

    /// Select the minimum accepted severity.
    #[must_use]
    pub const fn with_minimum_severity(mut self, severity: StructuralFindingSeverity) -> Self {
        self.minimum_severity = severity;
        self
    }

    /// Drop conventional test, fixture, mock, example, script, and benchmark paths.
    #[must_use]
    pub const fn with_exclude_fixtures(mut self, exclude: bool) -> Self {
        self.exclude_fixtures = exclude;
        self
    }
}

/// Independently bounded detector groups plus complete pre-limit counts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralFindingGroup {
    findings: Vec<StructuralFinding>,
    counts: BTreeMap<String, u64>,
}

impl StructuralFindingGroup {
    /// Consume the group into its deterministically ordered findings.
    #[must_use]
    pub fn into_findings(self) -> Vec<StructuralFinding> {
        self.findings
    }

    /// Complete count for each requested detector before its independent cap.
    #[must_use]
    pub fn counts(&self) -> &BTreeMap<String, u64> {
        &self.counts
    }
}

impl StructuralFindingQuery {
    /// Build a warning-or-worse ranked query with an explicit result bound.
    /// # Errors
    ///
    /// Returns an error if `limit` is zero or exceeds the structural-finding cap.
    pub fn new(limit: u16) -> Result<Self, StorageError> {
        validate_limit(limit)?;
        Ok(Self {
            limit,
            finding: None,
            minimum_severity: StructuralFindingSeverity::default(),
            minimum_metric: None,
            maximum_metric: None,
            minimum_centrality: None,
            excluded_path_prefix: None,
            path_prefix: None,
            symbol_ids: Vec::new(),
            exclude_fixtures: false,
        })
    }

    /// Restrict results to one detector name.
    /// # Errors
    ///
    /// Returns an error if the optional detector name is empty, oversized, or
    /// contains a NUL byte.
    pub fn with_finding(mut self, finding: Option<&str>) -> Result<Self, StorageError> {
        validate_finding_text(finding, "finding")?;
        self.finding = finding.map(ToOwned::to_owned);
        Ok(self)
    }

    /// Select the minimum accepted severity.
    #[must_use]
    pub const fn with_minimum_severity(mut self, severity: StructuralFindingSeverity) -> Self {
        self.minimum_severity = severity;
        self
    }

    /// Restrict detector metrics to an inclusive range.
    /// # Errors
    ///
    /// Returns an error if either bound is non-finite or the minimum is greater
    /// than the maximum.
    pub fn with_metric_bounds(
        mut self,
        minimum: Option<f64>,
        maximum: Option<f64>,
    ) -> Result<Self, StorageError> {
        if minimum.is_some_and(|value| !value.is_finite())
            || maximum.is_some_and(|value| !value.is_finite())
            || minimum.zip(maximum).is_some_and(|(low, high)| low > high)
        {
            return Err(StorageError::InvalidInput {
                field: "finding_metric",
            });
        }
        self.minimum_metric = minimum;
        self.maximum_metric = maximum;
        Ok(self)
    }

    /// Restrict results by normalized incoming-edge-site degree.
    /// # Errors
    ///
    /// Returns an error if the optional minimum is non-finite or outside the
    /// inclusive normalized centrality range.
    pub fn with_minimum_centrality(mut self, minimum: Option<f64>) -> Result<Self, StorageError> {
        if minimum.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
            return Err(StorageError::InvalidInput {
                field: "finding_centrality",
            });
        }
        self.minimum_centrality = minimum;
        Ok(self)
    }

    /// Exclude one literal normalized-path prefix.
    /// # Errors
    ///
    /// Returns an error if the optional excluded prefix is empty, absolute,
    /// oversized, or contains a NUL byte.
    pub fn with_excluded_path_prefix(mut self, prefix: Option<&str>) -> Result<Self, StorageError> {
        validate_finding_path(prefix, "finding_excluded_path")?;
        self.excluded_path_prefix = prefix.map(ToOwned::to_owned);
        Ok(self)
    }

    /// Restrict results to one literal normalized-path prefix.
    /// # Errors
    ///
    /// Returns an error if the optional required prefix is empty, absolute,
    /// oversized, or contains a NUL byte.
    pub fn with_path_prefix(mut self, prefix: Option<&str>) -> Result<Self, StorageError> {
        validate_finding_path(prefix, "finding_path_prefix")?;
        self.path_prefix = prefix.map(ToOwned::to_owned);
        Ok(self)
    }

    /// Restrict findings to a non-empty, bounded set of exact symbol identities.
    /// # Errors
    ///
    /// Returns an error if the symbol set is empty or contains more than 20 identities.
    pub fn with_symbol_ids(mut self, symbol_ids: Vec<SymbolId>) -> Result<Self, StorageError> {
        if symbol_ids.is_empty() || symbol_ids.len() > 20 {
            return Err(StorageError::InvalidInput {
                field: "finding_symbol_ids",
            });
        }
        for symbol_id in symbol_ids {
            if !self.symbol_ids.contains(&symbol_id) {
                self.symbol_ids.push(symbol_id);
            }
        }
        Ok(self)
    }

    /// Drop conventional test, fixture, mock, example, and benchmark paths.
    #[must_use]
    pub const fn with_exclude_fixtures(mut self, exclude: bool) -> Self {
        self.exclude_fixtures = exclude;
        self
    }
}

/// Project-wide deterministic finding totals without a row-limit blind spot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StructuralFindingComputationState {
    /// No complete detector relation exists for the selected generation.
    #[default]
    NotComputed,
    /// Every detector completed for the exact current input fingerprint.
    Ready,
}

/// Project-wide deterministic finding totals without a row-limit blind spot.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralFindingStats {
    state: StructuralFindingComputationState,
    analyzed_symbols: u64,
    total_findings: u64,
    info_findings: u64,
    warning_findings: u64,
    error_findings: u64,
    very_long_symbols: u64,
    high_fan_out_symbols: u64,
    unresolved_reference_pressure: u64,
    code_health_score: f32,
    by_finding: BTreeMap<String, u64>,
}

impl StructuralFindingStats {
    /// Whether the complete detector relation was actually computed.
    #[must_use]
    pub const fn state(&self) -> StructuralFindingComputationState {
        self.state
    }
    /// Current-generation symbols evaluated by the complete detector relation.
    #[must_use]
    pub const fn analyzed_symbols(&self) -> u64 {
        self.analyzed_symbols
    }

    /// Exact number of findings across every detector before any response limit.
    #[must_use]
    pub const fn total_findings(&self) -> u64 {
        self.total_findings
    }

    /// Exact number of error-severity findings.
    #[must_use]
    pub const fn error_findings(&self) -> u64 {
        self.error_findings
    }
}

impl StructuralFinding {
    /// Stable symbol identity for composing findings with exact lookups.
    #[must_use]
    pub fn symbol_id(&self) -> &str {
        &self.symbol_id
    }

    /// Project-relative source path carrying the finding.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Stable qualified symbol name carrying the finding.
    #[must_use]
    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    /// Stable detector name.
    #[must_use]
    pub fn finding(&self) -> &str {
        &self.finding
    }

    /// Normalized incoming-edge-site degree used for impact filtering.
    #[must_use]
    pub const fn degree_centrality(&self) -> f64 {
        self.degree_centrality
    }
}

impl CartographDatabase {
    /// Rank bounded symbols with no incoming executable/reference evidence.
    /// # Errors
    ///
    /// Returns an error if `limit` is invalid or current graph-orphan evidence
    /// cannot be queried or decoded.
    pub async fn current_dead_code(
        &self,
        project_id: &ProjectId,
        limit: u16,
        include_tests: bool,
    ) -> Result<Vec<DeadCodeCandidate>, StorageError> {
        self.query_current_dead_code(
            project_id,
            &DeadCodeQuery::new(limit)?.with_include_tests(include_tests),
        )
        .await
    }

    /// Rank graph orphans after deterministic framework/path exemptions.
    /// # Errors
    ///
    /// Returns an error if the request limit is invalid or filtered orphan
    /// candidates contain malformed identity/count/confidence fields.
    pub async fn query_current_dead_code(
        &self,
        project_id: &ProjectId,
        request: &DeadCodeQuery,
    ) -> Result<Vec<DeadCodeCandidate>, StorageError> {
        validate_limit(request.limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = include_str!("sql/insights_dead_code.sql").replace("{schema}", &schema);
        let rows = self
            .bounded_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(request.include_tests)
                        .bind(request.exclude_fixtures)
                        .bind(i64::from(request.limit))
                },
                "current-dead-code",
            )
            .await?;
        rows.iter().map(decode_dead_code).collect()
    }

    /// Rank files by graph degree, unresolved evidence, and route pressure.
    /// # Errors
    ///
    /// Returns an error if `limit` is invalid or current graph/reference/route
    /// pressure rows cannot be queried or decoded.
    pub async fn current_structural_hotspots(
        &self,
        project_id: &ProjectId,
        limit: u16,
    ) -> Result<Vec<StructuralHotspot>, StorageError> {
        self.query_structural_hotspots(project_id, StructuralHotspotQuery::new(limit)?)
            .await
    }

    /// Rank a fully filtered current-generation hotspot lens before LIMIT.
    /// # Errors
    ///
    /// Returns an error if query bounds are invalid or the selected category,
    /// sort, churn, recency, and centrality result rows are malformed.
    pub async fn query_structural_hotspots(
        &self,
        project_id: &ProjectId,
        request: StructuralHotspotQuery,
    ) -> Result<Vec<StructuralHotspot>, StorageError> {
        validate_limit(request.limit)?;
        let schema = quoted_schema(&self.schema);
        let category_filter = match request.category {
            StructuralHotspotCategory::Risk | StructuralHotspotCategory::Maintenance => "true",
            StructuralHotspotCategory::Brittle => "external_dependents > 0",
        };
        let ordering = match (request.category, request.sort) {
            (StructuralHotspotCategory::Risk, StructuralHotspotSort::Centrality) => {
                "centrality DESC, risk_score DESC"
            }
            (StructuralHotspotCategory::Risk, StructuralHotspotSort::Churn) => {
                "churn_score DESC, risk_score DESC"
            }
            (StructuralHotspotCategory::Risk, StructuralHotspotSort::Risk) => {
                "risk_score DESC, centrality DESC"
            }
            (StructuralHotspotCategory::Maintenance, _) => {
                "maintenance_score DESC, churn_score DESC"
            }
            (StructuralHotspotCategory::Brittle, _) => "brittle_score DESC, centrality DESC",
        };
        let statement = include_str!("sql/insights_structural_hotspots.sql")
            .replace("{schema}", &schema)
            .replace("{category_filter}", category_filter)
            .replace("{ordering}", ordering);
        let minimum_commits =
            i64::try_from(request.minimum_commits).map_err(|_| StorageError::InvalidInput {
                field: "hotspot_minimum_commits",
            })?;
        let recency_days = request.recency_days.map(i64::from);
        let rows = self
            .bounded_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(minimum_commits)
                        .bind(request.minimum_centrality)
                        .bind(recency_days)
                        .bind(i64::from(request.limit))
                },
                "current-structural-hotspots",
            )
            .await?;
        rows.iter().map(decode_hotspot).collect()
    }

    /// Attribute multiple path groups to current symbols in one parallelizable PostgreSQL query.
    ///
    /// Counts and row-number caps are partitioned per group before results leave the database,
    /// so a large commit cannot starve smaller commits and `total` is never a page-size guess.
    /// # Errors
    ///
    /// Returns an error if grouped paths cannot be encoded/query-bound or a
    /// returned group key, total, symbol identity, or source span is malformed.
    pub async fn current_grouped_path_symbols(
        &self,
        project_id: &ProjectId,
        request: GroupedSymbolQuery,
    ) -> Result<Vec<GroupedSymbolPeers>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let order = request
            .groups
            .iter()
            .map(|group| group.key.clone())
            .collect::<Vec<_>>();
        let mut group_keys = Vec::new();
        let mut paths = Vec::new();
        for group in &request.groups {
            for path in &group.paths {
                group_keys.push(group.key.clone());
                paths.push(path.as_str().to_owned());
            }
        }
        let statement =
            include_str!("sql/insights_grouped_path_symbols.sql").replace("{schema}", &schema);
        let excluded_symbol_id = request
            .excluded_symbol_id
            .as_ref()
            .map(SymbolId::as_str)
            .map(ToOwned::to_owned);
        let rows = self
            .bounded_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(group_keys)
                        .bind(paths)
                        .bind(excluded_symbol_id)
                        .bind(i64::from(request.per_group_limit))
                },
                "current-grouped-path-symbols",
            )
            .await?;
        let mut grouped = order
            .iter()
            .map(|key| {
                (
                    key.clone(),
                    GroupedSymbolPeers {
                        key: key.clone(),
                        total: 0,
                        peers: Vec::new(),
                        truncated: false,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        for row in rows {
            let key = text(&row, 0)?;
            let group = grouped
                .get_mut(&key)
                .ok_or(StorageError::CorruptStoredValue {
                    field: "grouped_symbol_key",
                })?;
            group.total = nonnegative_u64(&row, 1)?;
            group.peers.push(GroupedSymbolPeer {
                symbol_id: text(&row, 2)?,
                path: text(&row, GROUPED_SYMBOL_PATH_COLUMN)?,
                language: text(&row, GROUPED_SYMBOL_LANGUAGE_COLUMN)?,
                symbol_kind: text(&row, GROUPED_SYMBOL_KIND_COLUMN)?,
                qualified_name: text(&row, GROUPED_SYMBOL_QUALIFIED_NAME_COLUMN)?,
                start_line: positive_u32(&row, GROUPED_SYMBOL_START_LINE_COLUMN)?,
                end_line: positive_u32(&row, GROUPED_SYMBOL_END_LINE_COLUMN)?,
            });
        }
        Ok(order
            .into_iter()
            .map(|key| {
                let mut group = grouped.remove(&key).unwrap_or(GroupedSymbolPeers {
                    key,
                    total: 0,
                    peers: Vec::new(),
                    truncated: false,
                });
                group.truncated =
                    group.total > u64::try_from(group.peers.len()).unwrap_or(u64::MAX);
                group
            })
            .collect())
    }

    /// List exact current-generation import references and their resolved targets.
    /// # Errors
    ///
    /// Returns an error if `limit` is invalid or a current import/reference
    /// target, span, confidence, provenance, or site count is malformed.
    pub async fn current_imports(
        &self,
        project_id: &ProjectId,
        limit: u16,
    ) -> Result<Vec<ImportInsight>, StorageError> {
        validate_limit(limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT files.normalized_path AS path,
                       files.language AS language,
                       refs.owner_symbol_id::text AS owner_symbol_id,
                       refs.reference_name AS module_specifier,
                       refs.target_symbol_id::text AS target_symbol_id,
                       target_files.normalized_path AS target_path,
                       refs.start_byte AS start_byte,
                       refs.end_byte AS end_byte,
                       refs.confidence AS confidence,
                       refs.resolution_provenance AS provenance,
                       refs.site_count AS site_count,
                       file_symbols.symbol_id::text AS source_file_symbol_id
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = refs.project_id
                 AND files.generation_id = refs.generation_id
                 AND files.file_id = refs.file_id
                JOIN {schema}."symbols" AS file_symbols
                  ON file_symbols.project_id = refs.project_id
                 AND file_symbols.generation_id = refs.generation_id
                 AND file_symbols.file_id = refs.file_id
                 AND file_symbols.symbol_kind = 'file'
                LEFT JOIN {schema}."symbols" AS target
                  ON target.project_id = refs.project_id
                 AND target.generation_id = refs.generation_id
                 AND target.symbol_id = refs.target_symbol_id
                LEFT JOIN {schema}."files" AS target_files
                  ON target_files.project_id = target.project_id
                 AND target_files.generation_id = target.generation_id
                 AND target_files.file_id = target.file_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.reference_kind = 'imports'
                ORDER BY files.normalized_path, refs.start_byte, refs.reference_id
                LIMIT $2"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()).bind(i64::from(limit)),
                "current-imports",
            )
            .await?;
        rows.iter().map(decode_import).collect()
    }

    /// Return the complete bounded import evidence set so higher-level filters
    /// are applied before response truncation rather than silently missing hits.
    /// # Errors
    ///
    /// Returns an error if complete import evidence exceeds its hard cap or a
    /// current import/reference row cannot be queried or decoded.
    pub async fn current_import_evidence(
        &self,
        project_id: &ProjectId,
    ) -> Result<Vec<ImportInsight>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT files.normalized_path AS path,
                       files.language AS language,
                       refs.owner_symbol_id::text AS owner_symbol_id,
                       refs.reference_name AS module_specifier,
                       refs.target_symbol_id::text AS target_symbol_id,
                       target_files.normalized_path AS target_path,
                       refs.start_byte AS start_byte,
                       refs.end_byte AS end_byte,
                       refs.confidence AS confidence,
                       refs.resolution_provenance AS provenance,
                       refs.site_count AS site_count,
                       file_symbols.symbol_id::text AS source_file_symbol_id
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = refs.project_id
                 AND files.generation_id = refs.generation_id
                 AND files.file_id = refs.file_id
                JOIN {schema}."symbols" AS file_symbols
                  ON file_symbols.project_id = refs.project_id
                 AND file_symbols.generation_id = refs.generation_id
                 AND file_symbols.file_id = refs.file_id
                 AND file_symbols.symbol_kind = 'file'
                LEFT JOIN {schema}."symbols" AS target
                  ON target.project_id = refs.project_id
                 AND target.generation_id = refs.generation_id
                 AND target.symbol_id = refs.target_symbol_id
                LEFT JOIN {schema}."files" AS target_files
                  ON target_files.project_id = target.project_id
                 AND target_files.generation_id = target.generation_id
                 AND target_files.file_id = target.file_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.reference_kind = 'imports'
                ORDER BY files.normalized_path, refs.start_byte, refs.reference_id
                LIMIT {IMPORT_INSIGHT_OVERFLOW_PROBE}"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()),
                "current-import-evidence",
            )
            .await?;
        if i64::try_from(rows.len()).unwrap_or(i64::MAX) > MAX_IMPORT_INSIGHTS {
            return Err(StorageError::InvalidInput {
                field: "import_insight_limit",
            });
        }
        rows.iter().map(decode_import).collect()
    }

    /// Return every bounded JavaScript-family import declaration for a manifest audit.
    /// # Errors
    ///
    /// Returns an error if JavaScript-family import evidence exceeds its hard
    /// cap or an aggregated path/language/specifier/site-count row is malformed.
    pub async fn current_external_imports(
        &self,
        project_id: &ProjectId,
    ) -> Result<Vec<ExternalImportRecord>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT files.normalized_path, files.language,
                       refs.reference_name, SUM(refs.site_count)::bigint
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = refs.project_id
                 AND files.generation_id = refs.generation_id
                 AND files.file_id = refs.file_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.reference_kind = 'imports'
                  AND files.language IN ('javascript', 'jsx', 'typescript', 'tsx')
                GROUP BY files.normalized_path, files.language, refs.reference_name
                ORDER BY files.normalized_path, refs.reference_name
                LIMIT {EXTERNAL_IMPORT_OVERFLOW_PROBE}"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()),
                "current-external-imports",
            )
            .await?;
        if i64::try_from(rows.len()).unwrap_or(i64::MAX) > MAX_EXTERNAL_IMPORTS {
            return Err(StorageError::InvalidInput {
                field: "external_import_limit",
            });
        }
        rows.iter().map(decode_external_import).collect()
    }

    /// Aggregate exact resolution coverage by language and reference kind.
    /// # Errors
    ///
    /// Returns an error if `limit` is invalid or per-language/reference-kind
    /// resolved, unresolved, and site-count aggregates cannot be decoded.
    pub async fn current_dependency_coverage(
        &self,
        project_id: &ProjectId,
        limit: u16,
    ) -> Result<Vec<DependencyCoverageRow>, StorageError> {
        validate_limit(limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT files.language,
                       refs.reference_kind,
                       COUNT(*)::bigint,
                       COUNT(*) FILTER (WHERE refs.target_symbol_id IS NOT NULL)::bigint,
                       COUNT(*) FILTER (WHERE refs.target_symbol_id IS NULL)::bigint,
                       COALESCE(SUM(refs.site_count), 0)::bigint
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = refs.project_id
                 AND files.generation_id = refs.generation_id
                 AND files.file_id = refs.file_id
                WHERE refs.project_id = CAST($1 AS uuid)
                GROUP BY files.language, refs.reference_kind
                ORDER BY
                    COUNT(*) FILTER (WHERE refs.target_symbol_id IS NULL) DESC,
                    files.language,
                    refs.reference_kind
                LIMIT $2"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()).bind(i64::from(limit)),
                "current-dependency-coverage",
            )
            .await?;
        rows.iter().map(decode_dependency_coverage).collect()
    }

    /// Return exact current-generation reference sites targeting one symbol.
    /// # Errors
    ///
    /// Returns an error if `limit` is invalid or an exact current rename site's
    /// path, span, owner, kind, confidence, or provenance is malformed.
    pub async fn current_rename_sites(
        &self,
        project_id: &ProjectId,
        symbol_id: &SymbolId,
        limit: u16,
    ) -> Result<Vec<RenameReferenceSite>, StorageError> {
        validate_limit(limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT files.normalized_path,
                       refs.owner_symbol_id::text,
                       refs.start_byte,
                       refs.end_byte,
                       refs.reference_kind,
                       refs.confidence,
                       refs.resolution_provenance
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = refs.project_id
                 AND files.generation_id = refs.generation_id
                 AND files.file_id = refs.file_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.target_symbol_id = CAST($2 AS uuid)
                ORDER BY files.normalized_path, refs.start_byte, refs.reference_id
                LIMIT $3"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(symbol_id.as_str())
                        .bind(i64::from(limit))
                },
                "current-rename-sites",
            )
            .await?;
        rows.iter().map(decode_rename_site).collect()
    }

    /// Return every bounded exact rename reference so textual de-duplication
    /// happens before the caller's display limit is applied.
    /// # Errors
    ///
    /// Returns an error if complete current rename evidence exceeds its hard
    /// cap or an exact reference site cannot be queried or decoded.
    pub async fn current_rename_reference_evidence(
        &self,
        project_id: &ProjectId,
        symbol_id: &SymbolId,
    ) -> Result<Vec<RenameReferenceSite>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT files.normalized_path,
                       refs.owner_symbol_id::text,
                       refs.start_byte,
                       refs.end_byte,
                       refs.reference_kind,
                       refs.confidence,
                       refs.resolution_provenance
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = refs.project_id
                 AND files.generation_id = refs.generation_id
                 AND files.file_id = refs.file_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.target_symbol_id = CAST($2 AS uuid)
                ORDER BY files.normalized_path, refs.start_byte, refs.reference_id
                LIMIT {RENAME_REFERENCE_OVERFLOW_PROBE}"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()).bind(symbol_id.as_str()),
                "current-rename-reference-evidence",
            )
            .await?;
        if i64::try_from(rows.len()).unwrap_or(i64::MAX) > MAX_RENAME_REFERENCES {
            return Err(StorageError::InvalidInput {
                field: "rename_reference_limit",
            });
        }
        rows.iter().map(decode_rename_site).collect()
    }

    /// Count all exact current-generation references targeting one symbol.
    /// # Errors
    ///
    /// Returns an error if the exact current reference count cannot be queried
    /// or is negative/malformed.
    pub async fn current_rename_site_count(
        &self,
        project_id: &ProjectId,
        symbol_id: &SymbolId,
    ) -> Result<u64, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT COUNT(*)::bigint
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.target_symbol_id = CAST($2 AS uuid)"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()).bind(symbol_id.as_str()),
                "current-rename-site-count",
            )
            .await?;
        rows.first()
            .map(|row| nonnegative_u64(row, 0))
            .transpose()?
            .ok_or(StorageError::CorruptStoredValue {
                field: "rename_site_count",
            })
    }

    /// Return the complete bounded current-generation source manifest used
    /// for exact on-disk drift classification.
    /// # Errors
    ///
    /// Returns an error if the current manifest exceeds its hard file cap or a
    /// normalized path/content hash row cannot be decoded.
    pub async fn current_file_fingerprints(
        &self,
        project_id: &ProjectId,
    ) -> Result<Vec<IndexedFileFingerprint>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT files.normalized_path, files.content_hash
                FROM {schema}."files" AS files
                JOIN current ON current.generation_id = files.generation_id
                WHERE files.project_id = CAST($1 AS uuid)
                ORDER BY files.normalized_path, files.file_id
                LIMIT {FILE_FINGERPRINT_OVERFLOW_PROBE}"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()),
                "current-file-fingerprints",
            )
            .await?;
        if i64::try_from(rows.len()).unwrap_or(i64::MAX) > MAX_FILE_FINGERPRINTS {
            return Err(StorageError::InvalidInput {
                field: "file_fingerprint_limit",
            });
        }
        rows.iter().map(decode_file_fingerprint).collect()
    }

    /// Traverse current-generation file dependents in PostgreSQL and return
    /// language-aware affected test files with bounded counts and explicit
    /// node-budget truncation. Every symbol
    /// in every matched input file is a root, so named imports and symbol-level
    /// calls are not lost behind a synthetic file node.
    /// # Errors
    ///
    /// Returns an error if path/depth/result/regex bounds are invalid or
    /// recursive impact counts and affected test rows cannot be decoded.
    pub async fn current_file_test_impact(
        &self,
        input: FileTestImpactQuery<'_>,
    ) -> Result<Option<FileTestImpactResult>, StorageError> {
        let FileTestImpactQuery {
            project_id,
            paths,
            max_depth,
            max_nodes,
            limit,
            test_path_regex,
        } = input;
        if paths.is_empty() || paths.len() > MAX_TEST_IMPACT_INPUTS {
            return Err(StorageError::InvalidInput {
                field: "test_impact_paths",
            });
        }
        if max_depth == 0 || max_depth > MAX_TEST_IMPACT_DEPTH {
            return Err(StorageError::InvalidInput {
                field: "test_impact_depth",
            });
        }
        validate_limit(max_nodes).map_err(|_| StorageError::InvalidInput {
            field: "test_impact_max_nodes",
        })?;
        validate_limit(limit)?;
        if test_path_regex.is_some_and(|pattern| pattern.is_empty() || pattern.len() > 4_096) {
            return Err(StorageError::InvalidInput {
                field: "test_impact_filter",
            });
        }
        let schema = quoted_schema(&self.schema);
        let statement = include_str!("sql/insights_file_test_impact.sql")
            .replace("{schema}", &schema)
            .replace("{MAX_REPORTED_BARRELS}", &MAX_REPORTED_BARRELS.to_string());
        let path_values = paths
            .iter()
            .map(|path| path.as_str().to_owned())
            .collect::<Vec<_>>();
        let rows = self
            .bounded_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(path_values)
                        .bind(i32::from(max_depth))
                        .bind(i64::from(limit))
                        .bind(test_path_regex)
                        .bind(i64::from(max_nodes))
                },
                "current-file-test-impact",
            )
            .await?;
        decode_file_test_impact(rows)
    }

    /// Rank symbols by direct incoming test-file evidence.
    /// # Errors
    ///
    /// Returns an error if `limit` is invalid or direct-test/incoming-edge
    /// coverage rows contain malformed identities or counts.
    pub async fn current_structural_coverage(
        &self,
        project_id: &ProjectId,
        limit: u16,
    ) -> Result<Vec<StructuralCoverageRow>, StorageError> {
        validate_limit(limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                )
                SELECT target.symbol_id::text,
                       target_files.normalized_path,
                       target.qualified_name,
                       target.symbol_kind,
                       COUNT(DISTINCT source_files.file_id) FILTER (
                           WHERE source_docs.document_kind = 'test'
                       )::bigint AS direct_tests,
                       COUNT(DISTINCT edges.source_symbol_id)::bigint AS incoming_edges
                FROM {schema}."symbols" AS target
                JOIN current ON current.generation_id = target.generation_id
                JOIN {schema}."files" AS target_files
                  ON target_files.project_id = target.project_id
                 AND target_files.generation_id = target.generation_id
                 AND target_files.file_id = target.file_id
                LEFT JOIN {schema}."edges" AS edges
                  ON edges.project_id = target.project_id
                 AND edges.generation_id = target.generation_id
                 AND edges.target_symbol_id = target.symbol_id
                 AND edges.edge_kind <> 'contains'
                LEFT JOIN {schema}."symbols" AS source
                  ON source.project_id = edges.project_id
                 AND source.generation_id = edges.generation_id
                 AND source.symbol_id = edges.source_symbol_id
                LEFT JOIN {schema}."files" AS source_files
                  ON source_files.project_id = source.project_id
                 AND source_files.generation_id = source.generation_id
                 AND source_files.file_id = source.file_id
                LEFT JOIN {schema}."search_documents" AS source_docs
                  ON source_docs.project_id = source_files.project_id
                 AND source_docs.generation_id = source_files.generation_id
                 AND source_docs.file_id = source_files.file_id
                 AND source_docs.document_kind = 'test'
                WHERE target.project_id = CAST($1 AS uuid)
                  AND target.symbol_kind NOT IN ('file', 'import', 'parameter')
                GROUP BY target.symbol_id, target_files.normalized_path,
                         target.qualified_name, target.symbol_kind, target.start_line
                ORDER BY direct_tests DESC, incoming_edges DESC,
                         target_files.normalized_path, target.start_line
                LIMIT $2"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()).bind(i64::from(limit)),
                "current-structural-coverage",
            )
            .await?;
        rows.iter().map(decode_coverage).collect()
    }

    /// Detect deterministic structural, coverage, clone, and agent-prone findings.
    /// # Errors
    ///
    /// Returns an error if `limit` is invalid or any current structural,
    /// coverage, clone, or agent-prone finding row is malformed.
    pub async fn current_structural_findings(
        &self,
        project_id: &ProjectId,
        limit: u16,
    ) -> Result<Vec<StructuralFinding>, StorageError> {
        let query = StructuralFindingQuery::new(limit)?
            .with_minimum_severity(StructuralFindingSeverity::Info);
        self.query_current_structural_findings(project_id, &query)
            .await
    }

    /// Query deterministic findings with every filter applied before the row limit.
    /// # Errors
    ///
    /// Returns an error if filter/result bounds are invalid or a ranked finding
    /// identity, severity, span, metric, centrality, or detail is malformed.
    pub async fn query_current_structural_findings(
        &self,
        project_id: &ProjectId,
        request: &StructuralFindingQuery,
    ) -> Result<Vec<StructuralFinding>, StorageError> {
        validate_limit(request.limit)?;
        self.refresh_current_structural_findings(project_id, DEFAULT_INSIGHT_TIMEOUT)
            .await?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r"SELECT symbol_id::text AS symbol_id, path, qualified_name, finding, severity,
                       start_line, end_line, metric_name, metric,
                       degree_centrality, outgoing_edges, unresolved_references,
                       detail::text AS detail
{filters}
                ORDER BY CASE severity WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
                         degree_centrality DESC, metric DESC, path, start_line, finding
                LIMIT $2",
            filters = stored_finding_filters(&schema),
        );
        let symbol_ids = (!request.symbol_ids.is_empty()).then(|| {
            request
                .symbol_ids
                .iter()
                .map(|symbol_id| symbol_id.as_str().to_owned())
                .collect::<Vec<_>>()
        });
        let rows = self
            .bounded_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(i64::from(request.limit))
                        .bind(request.finding.as_deref())
                        .bind(request.minimum_severity.rank())
                        .bind(request.minimum_metric)
                        .bind(request.maximum_metric)
                        .bind(request.minimum_centrality)
                        .bind(request.excluded_path_prefix.as_deref())
                        .bind(symbol_ids)
                        .bind(request.exclude_fixtures)
                        .bind(request.path_prefix.as_deref())
                },
                "query-current-structural-findings",
            )
            .await?;
        rows.iter().map(decode_finding).collect()
    }

    /// Count every current finding matching the same filters as a ranked query.
    /// # Errors
    ///
    /// Returns an error if filter bounds are invalid or the matching current
    /// finding count cannot be queried or represented as a nonnegative `u64`.
    pub async fn count_current_structural_findings(
        &self,
        project_id: &ProjectId,
        request: &StructuralFindingQuery,
    ) -> Result<u64, StorageError> {
        validate_limit(request.limit)?;
        self.refresh_current_structural_findings(project_id, DEFAULT_INSIGHT_TIMEOUT)
            .await?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r"SELECT COUNT(*)::bigint
{filters}
                  AND $2::bigint >= 0",
            filters = stored_finding_filters(&schema),
        );
        let symbol_ids = (!request.symbol_ids.is_empty()).then(|| {
            request
                .symbol_ids
                .iter()
                .map(|symbol_id| symbol_id.as_str().to_owned())
                .collect::<Vec<_>>()
        });
        let rows = self
            .bounded_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(0_i64)
                        .bind(request.finding.as_deref())
                        .bind(request.minimum_severity.rank())
                        .bind(request.minimum_metric)
                        .bind(request.maximum_metric)
                        .bind(request.minimum_centrality)
                        .bind(request.excluded_path_prefix.as_deref())
                        .bind(symbol_ids)
                        .bind(request.exclude_fixtures)
                        .bind(request.path_prefix.as_deref())
                },
                "count-current-structural-findings",
            )
            .await?;
        let row = rows
            .into_iter()
            .next()
            .ok_or_else(|| database_error("count-current-structural-findings"))?;
        nonnegative_u64(&row, 0)
    }

    /// Rank each requested detector independently and retain complete group counts.
    /// # Errors
    ///
    /// Returns an error if detector/per-group bounds are invalid or a ranked
    /// detector row, total, severity, metric, or detail is malformed.
    pub async fn query_current_structural_findings_per_detector(
        &self,
        project_id: &ProjectId,
        request: &StructuralFindingGroupQuery,
    ) -> Result<StructuralFindingGroup, StorageError> {
        validate_limit(request.per_finding_limit)?;
        // Every sibling finding query reads the stored relation; this one backs
        // the agent audit, which is the most detector-heavy consumer of all.
        self.refresh_current_structural_findings(project_id, DEFAULT_INSIGHT_TIMEOUT)
            .await?;
        let Some(generation) = current_generation_for_findings(self, project_id).await? else {
            return Ok(StructuralFindingGroup {
                findings: Vec::new(),
                counts: BTreeMap::new(),
            });
        };
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH ranked AS (
                    SELECT symbol_id, path, qualified_name, finding, severity,
                           start_line, end_line, metric_name, metric,
                           degree_centrality, outgoing_edges, unresolved_references, detail,
                           COUNT(*) OVER (PARTITION BY finding)::bigint AS detector_total,
                           ROW_NUMBER() OVER (
                               PARTITION BY finding
                               ORDER BY CASE severity
                                          WHEN 'error' THEN 3
                                          WHEN 'warning' THEN 2
                                          ELSE 1
                                        END DESC,
                                        degree_centrality DESC, metric DESC,
                                        path, start_line, symbol_id
                           ) AS detector_rank
                    FROM {schema}."structural_findings" AS findings
                    WHERE findings.project_id = CAST($1 AS uuid)
                      AND findings.generation_id = CAST($2 AS uuid)
                      AND finding = ANY($3::text[])
                      AND CASE severity
                            WHEN 'error' THEN 3
                            WHEN 'warning' THEN 2
                            ELSE 1
                          END >= $4
                      AND (NOT $5::boolean OR NOT (
                          path ~* '(^|/)(fixtures?|test-beds?|__tests__|__mocks__|tests?|specs?|integration|testing|testlib)(/|$)'
                          OR path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)[a-z0-9]+$'
                          OR path ~ '([A-Za-z](Test|Tests|TestCase|Spec))\.[a-z0-9]+$'
                          OR path ~* '(^|/)(bench(es|marks?)?|scripts?|examples?|samples?|demos?)(/|$)'
                      ))
                )
                SELECT symbol_id::text AS symbol_id, path, qualified_name, finding, severity,
                       start_line, end_line, metric_name, metric,
                       degree_centrality, outgoing_edges, unresolved_references,
                       detail::text AS detail, detector_total
                FROM ranked
                WHERE detector_rank <= $6
                ORDER BY finding, detector_rank, path, start_line, symbol_id"#,
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(generation.as_str())
                        .bind(request.findings.clone())
                        .bind(request.minimum_severity.rank())
                        .bind(request.exclude_fixtures)
                        .bind(i64::from(request.per_finding_limit))
                },
                "query-current-structural-findings-per-detector",
            )
            .await?;
        let mut counts = request
            .findings
            .iter()
            .map(|finding| (finding.clone(), 0_u64))
            .collect::<BTreeMap<_, _>>();
        let mut findings = Vec::with_capacity(rows.len());
        for row in rows {
            counts.insert(
                text(&row, "finding")?,
                nonnegative_u64(&row, "detector_total")?,
            );
            findings.push(decode_finding(&row)?);
        }
        Ok(StructuralFindingGroup { findings, counts })
    }

    /// Aggregate every current-generation finding without a row-limit blind spot.
    /// # Errors
    ///
    /// Returns an error if aggregate finding totals/by-kind counts cannot be
    /// queried or any stored count is negative, malformed, or overflowing.
    pub async fn current_structural_finding_stats(
        &self,
        project_id: &ProjectId,
    ) -> Result<StructuralFindingStats, StorageError> {
        let refresh = self
            .refresh_current_structural_findings_fenced(project_id, DEFAULT_INSIGHT_TIMEOUT)
            .await?;
        if refresh.outcome == StructuralFindingRefresh::NoCurrentGeneration {
            return Ok(StructuralFindingStats::default());
        }
        if let Some(stats) = self
            .cached_current_structural_finding_stats(project_id)
            .await?
        {
            return Ok(stats);
        }
        let current_generation = current_generation_for_findings(self, project_id).await?;
        Err(missing_structural_finding_stats_error(
            refresh.generation_id.as_deref(),
            current_generation.as_deref(),
        ))
    }

    /// Aggregate the stored finding relation without ever recomputing it.
    ///
    /// Returns `None` when the complete relation has not been computed for the
    /// exact current input fingerprint, so a readiness probe can report an
    /// explicit pending state instead of an unbounded recomputation.
    /// # Errors
    ///
    /// Returns an error if the aggregate cannot be queried or a stored count is
    /// malformed.
    pub async fn cached_current_structural_finding_stats(
        &self,
        project_id: &ProjectId,
    ) -> Result<Option<StructuralFindingStats>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement =
            include_str!("sql/structural_finding_stats.sql").replace("{schema}", &schema);
        let mut rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()),
                "cached-structural-finding-stats",
            )
            .await?;
        rows.pop().map(|row| decode_finding_stats(&row)).transpose()
    }

    /// Aggregate every current-generation finding by evaluating the complete
    /// detector relation within a caller-selected statement timeout.
    /// # Errors
    ///
    /// Returns an error if the timeout is zero or exceeds the insight bound,
    /// the aggregate cannot be queried, or a stored count is malformed.
    pub async fn current_structural_finding_stats_bounded(
        &self,
        project_id: &ProjectId,
        statement_timeout: Duration,
    ) -> Result<StructuralFindingStats, StorageError> {
        if statement_timeout.is_zero() || statement_timeout > DEFAULT_INSIGHT_TIMEOUT {
            return Err(StorageError::InvalidInput {
                field: "statement_timeout",
            });
        }
        let Some(generation) = current_generation_for_findings(self, project_id).await? else {
            return Ok(StructuralFindingStats::default());
        };
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r"{}, totals AS (
                    SELECT COUNT(*)::bigint AS total,
                           COUNT(*) FILTER (WHERE severity = 'info')::bigint AS info,
                           COUNT(*) FILTER (WHERE severity = 'warning')::bigint AS warning,
                           COUNT(*) FILTER (WHERE severity = 'error')::bigint AS error
                    FROM findings
                ), by_kind AS (
                    SELECT finding, COUNT(*)::bigint AS count
                    FROM findings GROUP BY finding
                )
                SELECT (SELECT COUNT(*)::bigint FROM base) AS analyzed_symbols,
                       totals.total AS total_findings,
                       totals.info AS info_findings,
                       totals.warning AS warning_findings,
                       totals.error AS error_findings,
                       COALESCE((SELECT count FROM by_kind WHERE finding = 'large_method'), 0)
                           AS very_long_symbols,
                       COALESCE((SELECT count FROM by_kind WHERE finding = 'high_fan_out'), 0)
                           AS high_fan_out_symbols,
                       COALESCE((SELECT count FROM by_kind WHERE finding = 'unresolved_reference_pressure'), 0)
                           AS unresolved_reference_pressure,
                       GREATEST(
                           0.0,
                           100.0 - (
                               totals.error * 4.0 + totals.warning * 2.0 + totals.info
                           ) * 100.0 / GREATEST((SELECT COUNT(*) FROM base), 1)
                       )::real AS code_health_score,
                       COALESCE((
                           SELECT jsonb_object_agg(finding, count ORDER BY finding)::text
                           FROM by_kind
                       ), '{{}}') AS by_finding
                FROM totals",
            finding_ctes(&schema),
        );
        let mut rows = self
            .bounded_serial_rows(
                SerialRowRequest {
                    statement,
                    operation: "current-structural-finding-stats",
                    statement_timeout,
                },
                |statement| {
                    statement
                        .bind(project_id.as_str())
                        .bind(generation.as_str())
                },
            )
            .await?;
        let row = rows
            .pop()
            .ok_or(StorageError::CorruptStoredValue { field: "insight" })?;
        decode_finding_stats(&row)
    }

    async fn bounded_rows<'query>(
        &self,
        statement: String,
        bind: impl FnOnce(PgQuery<'query>) -> PgQuery<'query>,
        operation: &'static str,
    ) -> Result<Vec<sqlx_postgres::PgRow>, StorageError> {
        let request = RowReadRequest::new(statement, operation, DEFAULT_INSIGHT_TIMEOUT);
        read_rows(self, request, bind).await
    }

    async fn bounded_serial_rows<'query>(
        &self,
        request: SerialRowRequest,
        bind: impl FnOnce(PgQuery<'query>) -> PgQuery<'query>,
    ) -> Result<Vec<sqlx_postgres::PgRow>, StorageError> {
        let SerialRowRequest {
            statement,
            operation,
            statement_timeout,
        } = request;
        // This full-generation aggregate can otherwise reserve one dynamic
        // shared-memory segment per PostgreSQL worker. Serial planning keeps
        // status bounded on large projects without weakening the query.
        let request =
            RowReadRequest::new(statement, operation, statement_timeout).with_serial_planning();
        read_rows(self, request, bind).await
    }
}

pub(crate) const FINDING_CTES_SQL_TEMPLATE: &str = include_str!("finding_ctes.sql");

pub(crate) fn finding_ctes(schema: &str) -> String {
    FINDING_CTES_SQL_TEMPLATE.replace("{schema}", schema)
}

/// One serially planned read with its audit label and deadline.
struct SerialRowRequest {
    statement: String,
    operation: &'static str,
    statement_timeout: Duration,
}

/// Exact published generation the cascade must fence on, if one exists.
///
/// Binding this as a parameter rather than spelling a subquery lets PostgreSQL
/// plan with the column's real statistics; an opaque fence collapses the row
/// estimate and the planner picks nested loops over the whole graph.
async fn current_generation_for_findings(
    database: &CartographDatabase,
    project_id: &ProjectId,
) -> Result<Option<String>, StorageError> {
    let schema = quoted_schema(&database.schema);
    let statement = format!(
        r#"SELECT projects.current_generation_id::text
            FROM {schema}."projects" AS projects
            WHERE projects.project_id = CAST($1 AS uuid)
              AND projects.current_generation_id IS NOT NULL"#
    );
    let mut rows = database
        .bounded_rows(
            statement,
            |statement| statement.bind(project_id.as_str()),
            "current-finding-generation",
        )
        .await?;
    rows.pop()
        .map(|row| {
            row.try_get::<String, _>(0)
                .map_err(|_| StorageError::CorruptStoredValue {
                    field: "generation_id",
                })
        })
        .transpose()
}

/// Generation-fenced source and shared filter predicates for the stored relation.
fn stored_finding_filters(schema: &str) -> String {
    include_str!("sql/structural_finding_filters.sql").replace("{schema}", schema)
}

fn validate_limit(limit: u16) -> Result<(), StorageError> {
    if limit == 0 || limit > MAX_INSIGHT_LIMIT {
        Err(StorageError::InvalidInput { field: "limit" })
    } else {
        Ok(())
    }
}

fn validate_finding_text(value: Option<&str>, field: &'static str) -> Result<(), StorageError> {
    if value.is_some_and(|value| value.is_empty() || value.len() > 128 || value.contains('\0')) {
        Err(StorageError::InvalidInput { field })
    } else {
        Ok(())
    }
}

fn validate_finding_path(value: Option<&str>, field: &'static str) -> Result<(), StorageError> {
    if value.is_some_and(|value| {
        value.is_empty() || value.len() > 4_096 || value.contains('\0') || value.starts_with('/')
    }) {
        Err(StorageError::InvalidInput { field })
    } else {
        Ok(())
    }
}

fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

fn text<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<String, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

fn optional_text<Index>(
    row: &sqlx_postgres::PgRow,
    index: Index,
) -> Result<Option<String>, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

fn nonnegative_u64<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<u64, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    let value = row
        .try_get::<i64, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    u64::try_from(value).map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

fn optional_nonnegative_u64<Index>(
    row: &sqlx_postgres::PgRow,
    index: Index,
) -> Result<Option<u64>, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get::<Option<i64>, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?
        .map(u64::try_from)
        .transpose()
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

fn fraction<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<f64, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    row.try_get::<f64, _>(index)
        .ok()
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        .ok_or(StorageError::CorruptStoredValue { field: "insight" })
}

fn positive_u32<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<u32, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    let value = row
        .try_get::<i32, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    u32::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(StorageError::CorruptStoredValue { field: "insight" })
}

fn nonnegative_u8<Index>(row: &sqlx_postgres::PgRow, index: Index) -> Result<u8, StorageError>
where
    Index: ColumnIndex<sqlx_postgres::PgRow>,
{
    let value = row
        .try_get::<i32, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    u8::try_from(value).map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

const GROUPED_SYMBOL_PATH_COLUMN: usize = 3;
const GROUPED_SYMBOL_LANGUAGE_COLUMN: usize = 4;
const GROUPED_SYMBOL_KIND_COLUMN: usize = 5;
const GROUPED_SYMBOL_QUALIFIED_NAME_COLUMN: usize = 6;
const GROUPED_SYMBOL_START_LINE_COLUMN: usize = 7;
const GROUPED_SYMBOL_END_LINE_COLUMN: usize = 8;
const DEAD_CODE_SYMBOL_KIND_COLUMN: usize = 3;
const DEAD_CODE_QUALIFIED_NAME_COLUMN: usize = 4;
const DEAD_CODE_START_LINE_COLUMN: usize = 5;
const DEAD_CODE_INCOMING_COLUMN: usize = 6;
const DEAD_CODE_OUTGOING_COLUMN: usize = 7;
const DEAD_CODE_SAFE_CODE_COLUMN: usize = 8;
const DEAD_CODE_INTERFACE_RISK_COLUMN: usize = 9;
const DEPENDENCY_COVERAGE_RESOLVED_COLUMN: usize = 3;
const DEPENDENCY_COVERAGE_UNRESOLVED_COLUMN: usize = 4;
const DEPENDENCY_COVERAGE_SITES_COLUMN: usize = 5;
const RENAME_END_BYTE_COLUMN: usize = 3;
const RENAME_REFERENCE_KIND_COLUMN: usize = 4;
const RENAME_CONFIDENCE_COLUMN: usize = 5;
const RENAME_PROVENANCE_COLUMN: usize = 6;
const FILE_IMPACT_AFFECTED_TEST_COUNT_COLUMN: usize = 3;
const FILE_IMPACT_REACHED_BARREL_COUNT_COLUMN: usize = 4;
const FILE_IMPACT_REACHED_BARRELS_COLUMN: usize = 5;
const FILE_IMPACT_NODES_TRUNCATED_COLUMN: usize = 6;
const FILE_IMPACT_TEST_PATH_COLUMN: usize = 7;
const FILE_IMPACT_TEST_DISTANCE_COLUMN: usize = 8;
const COVERAGE_SYMBOL_KIND_COLUMN: usize = 3;
const COVERAGE_DIRECT_TEST_FILES_COLUMN: usize = 4;
const COVERAGE_INCOMING_EDGES_COLUMN: usize = 5;

fn decode_dead_code(row: &sqlx_postgres::PgRow) -> Result<DeadCodeCandidate, StorageError> {
    Ok(DeadCodeCandidate {
        symbol_id: text(row, 0)?,
        path: text(row, 1)?,
        language: text(row, 2)?,
        symbol_kind: text(row, DEAD_CODE_SYMBOL_KIND_COLUMN)?,
        qualified_name: text(row, DEAD_CODE_QUALIFIED_NAME_COLUMN)?,
        start_line: positive_u32(row, DEAD_CODE_START_LINE_COLUMN)?,
        incoming_edges: nonnegative_u64(row, DEAD_CODE_INCOMING_COLUMN)?,
        outgoing_edges: nonnegative_u64(row, DEAD_CODE_OUTGOING_COLUMN)?,
        safe_code: text(row, DEAD_CODE_SAFE_CODE_COLUMN)?,
        interface_dispatch_risk: row
            .try_get(DEAD_CODE_INTERFACE_RISK_COLUMN)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        reason: "no_incoming_structural_evidence",
    })
}

struct HotspotStructureFields {
    path: String,
    language: String,
    symbols: u64,
    incoming_edges: u64,
    outgoing_edges: u64,
    unresolved_references: u64,
    routes: u64,
    structural_risk: u64,
}

struct HotspotHistoryFields {
    commit_count: u64,
    author_count: u64,
    insertions: u64,
    deletions: u64,
    last_touched_at: Option<String>,
    last_touched_unix_seconds: Option<u64>,
    history_available: bool,
    composite_risk: u64,
}

struct HotspotScoreFields {
    centrality: f64,
    structural_pressure: f64,
    churn_score: f64,
    risk_score: f64,
    maintenance_score: f64,
    brittle_score: f64,
    external_dependents: u64,
}

fn decode_hotspot(row: &sqlx_postgres::PgRow) -> Result<StructuralHotspot, StorageError> {
    let HotspotStructureFields {
        path,
        language,
        symbols,
        incoming_edges,
        outgoing_edges,
        unresolved_references,
        routes,
        structural_risk,
    } = decode_hotspot_structure(row)?;
    let HotspotHistoryFields {
        commit_count,
        author_count,
        insertions,
        deletions,
        last_touched_at,
        last_touched_unix_seconds,
        history_available,
        composite_risk,
    } = decode_hotspot_history(row)?;
    let HotspotScoreFields {
        centrality,
        structural_pressure,
        churn_score,
        risk_score,
        maintenance_score,
        brittle_score,
        external_dependents,
    } = decode_hotspot_scores(row)?;
    Ok(StructuralHotspot {
        path,
        language,
        symbols,
        incoming_edges,
        outgoing_edges,
        unresolved_references,
        routes,
        structural_risk,
        commit_count,
        author_count,
        insertions,
        deletions,
        last_touched_at,
        last_touched_unix_seconds,
        history_available,
        composite_risk,
        centrality,
        structural_pressure,
        churn_score,
        risk_score,
        maintenance_score,
        brittle_score,
        external_dependents,
    })
}

fn decode_hotspot_structure(
    row: &sqlx_postgres::PgRow,
) -> Result<HotspotStructureFields, StorageError> {
    Ok(HotspotStructureFields {
        path: text(row, "normalized_path")?,
        language: text(row, "language")?,
        symbols: nonnegative_u64(row, "symbols")?,
        incoming_edges: nonnegative_u64(row, "incoming_edges")?,
        outgoing_edges: nonnegative_u64(row, "outgoing_edges")?,
        unresolved_references: nonnegative_u64(row, "unresolved_references")?,
        routes: nonnegative_u64(row, "routes")?,
        structural_risk: nonnegative_u64(row, "structural_risk")?,
    })
}

fn decode_hotspot_history(
    row: &sqlx_postgres::PgRow,
) -> Result<HotspotHistoryFields, StorageError> {
    Ok(HotspotHistoryFields {
        commit_count: nonnegative_u64(row, "commit_count")?,
        author_count: nonnegative_u64(row, "author_count")?,
        insertions: nonnegative_u64(row, "insertions")?,
        deletions: nonnegative_u64(row, "deletions")?,
        last_touched_at: optional_text(row, "last_touched_at")?,
        last_touched_unix_seconds: optional_nonnegative_u64(row, "last_touched_unix_seconds")?,
        history_available: row
            .try_get("history_available")
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        composite_risk: nonnegative_u64(row, "composite_risk")?,
    })
}

fn decode_hotspot_scores(row: &sqlx_postgres::PgRow) -> Result<HotspotScoreFields, StorageError> {
    Ok(HotspotScoreFields {
        centrality: fraction(row, "centrality")?,
        structural_pressure: fraction(row, "structural_pressure")?,
        churn_score: fraction(row, "churn_score")?,
        risk_score: fraction(row, "risk_score")?,
        maintenance_score: fraction(row, "maintenance_score")?,
        brittle_score: fraction(row, "brittle_score")?,
        external_dependents: nonnegative_u64(row, "external_dependents")?,
    })
}

fn decode_import(row: &sqlx_postgres::PgRow) -> Result<ImportInsight, StorageError> {
    Ok(ImportInsight {
        path: text(row, "path")?,
        language: text(row, "language")?,
        owner_symbol_id: optional_text(row, "owner_symbol_id")?,
        module_specifier: text(row, "module_specifier")?,
        target_symbol_id: optional_text(row, "target_symbol_id")?,
        target_path: optional_text(row, "target_path")?,
        start_byte: nonnegative_u64(row, "start_byte")?,
        end_byte: nonnegative_u64(row, "end_byte")?,
        confidence: row
            .try_get("confidence")
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        provenance: text(row, "provenance")?,
        site_count: nonnegative_u64(row, "site_count")?,
        source_file_symbol_id: text(row, "source_file_symbol_id")?,
    })
}

fn decode_external_import(
    row: &sqlx_postgres::PgRow,
) -> Result<ExternalImportRecord, StorageError> {
    Ok(ExternalImportRecord {
        path: text(row, 0)?,
        language: text(row, 1)?,
        module_specifier: text(row, 2)?,
        site_count: nonnegative_u64(row, 3)?,
    })
}

fn decode_dependency_coverage(
    row: &sqlx_postgres::PgRow,
) -> Result<DependencyCoverageRow, StorageError> {
    Ok(DependencyCoverageRow {
        language: text(row, 0)?,
        reference_kind: text(row, 1)?,
        references: nonnegative_u64(row, 2)?,
        resolved: nonnegative_u64(row, DEPENDENCY_COVERAGE_RESOLVED_COLUMN)?,
        unresolved: nonnegative_u64(row, DEPENDENCY_COVERAGE_UNRESOLVED_COLUMN)?,
        represented_sites: nonnegative_u64(row, DEPENDENCY_COVERAGE_SITES_COLUMN)?,
    })
}

fn decode_rename_site(row: &sqlx_postgres::PgRow) -> Result<RenameReferenceSite, StorageError> {
    Ok(RenameReferenceSite {
        path: text(row, 0)?,
        owner_symbol_id: optional_text(row, 1)?,
        start_byte: nonnegative_u64(row, 2)?,
        end_byte: nonnegative_u64(row, RENAME_END_BYTE_COLUMN)?,
        reference_kind: text(row, RENAME_REFERENCE_KIND_COLUMN)?,
        confidence: row
            .try_get(RENAME_CONFIDENCE_COLUMN)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        provenance: text(row, RENAME_PROVENANCE_COLUMN)?,
    })
}

fn decode_file_fingerprint(
    row: &sqlx_postgres::PgRow,
) -> Result<IndexedFileFingerprint, StorageError> {
    let path = text(row, 0)?;
    Ok(IndexedFileFingerprint {
        path: NormalizedPath::parse(&path)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        content_hash: ContentDigest::parse(&text(row, 1)?)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
    })
}

fn decode_file_test_impact(
    rows: Vec<sqlx_postgres::PgRow>,
) -> Result<Option<FileTestImpactResult>, StorageError> {
    let Some(first) = rows.first() else {
        return Ok(None);
    };
    let generation_id = GenerationId::parse(&text(first, 0)?)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    let matched_inputs = first
        .try_get::<Vec<String>, _>(1)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    let dependent_file_count = nonnegative_u64(first, 2)?;
    let affected_test_file_count = nonnegative_u64(first, FILE_IMPACT_AFFECTED_TEST_COUNT_COLUMN)?;
    let reached_barrel_count = nonnegative_u64(first, FILE_IMPACT_REACHED_BARREL_COUNT_COLUMN)?;
    let reached_barrels = first
        .try_get::<Vec<String>, _>(FILE_IMPACT_REACHED_BARRELS_COLUMN)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    let nodes_truncated = first
        .try_get::<bool, _>(FILE_IMPACT_NODES_TRUNCATED_COLUMN)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    let mut tests = Vec::new();
    for row in rows {
        let path = optional_text(&row, FILE_IMPACT_TEST_PATH_COLUMN)?;
        let distance = row
            .try_get::<Option<i32>, _>(FILE_IMPACT_TEST_DISTANCE_COLUMN)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
        match (path, distance) {
            (None, None) => {}
            (Some(path), Some(_)) => tests.push(FileTestImpact {
                path,
                distance: nonnegative_u8(&row, FILE_IMPACT_TEST_DISTANCE_COLUMN)?,
                reason: "current_generation_dependency_graph",
            }),
            _ => return Err(StorageError::CorruptStoredValue { field: "insight" }),
        }
    }
    let returned_tests = u64::try_from(tests.len()).unwrap_or(u64::MAX);
    let returned_barrels = u64::try_from(reached_barrels.len()).unwrap_or(u64::MAX);
    Ok(Some(FileTestImpactResult {
        generation_id,
        matched_inputs,
        dependent_file_count,
        affected_test_file_count,
        reached_barrel_count,
        reached_barrels,
        nodes_truncated,
        barrels_truncated: nodes_truncated || reached_barrel_count > returned_barrels,
        tests,
        tests_truncated: nodes_truncated || affected_test_file_count > returned_tests,
    }))
}

fn decode_coverage(row: &sqlx_postgres::PgRow) -> Result<StructuralCoverageRow, StorageError> {
    Ok(StructuralCoverageRow {
        symbol_id: text(row, 0)?,
        path: text(row, 1)?,
        qualified_name: text(row, 2)?,
        symbol_kind: text(row, COVERAGE_SYMBOL_KIND_COLUMN)?,
        direct_test_files: nonnegative_u64(row, COVERAGE_DIRECT_TEST_FILES_COLUMN)?,
        incoming_edges: nonnegative_u64(row, COVERAGE_INCOMING_EDGES_COLUMN)?,
    })
}

fn decode_finding(row: &sqlx_postgres::PgRow) -> Result<StructuralFinding, StorageError> {
    Ok(StructuralFinding {
        symbol_id: text(row, "symbol_id")?,
        path: text(row, "path")?,
        qualified_name: text(row, "qualified_name")?,
        finding: text(row, "finding")?,
        severity: text(row, "severity")?,
        start_line: positive_u32(row, "start_line")?,
        end_line: positive_u32(row, "end_line")?,
        metric_name: text(row, "metric_name")?,
        metric: row.try_get("metric").map_err(|_| corrupt_insight())?,
        degree_centrality: row
            .try_get("degree_centrality")
            .map_err(|_| corrupt_insight())?,
        outgoing_edges: nonnegative_u64(row, "outgoing_edges")?,
        unresolved_references: nonnegative_u64(row, "unresolved_references")?,
        detail: optional_text(row, "detail")?
            .map(|detail| serde_json::from_str(&detail))
            .transpose()
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
    })
}

fn decode_finding_stats(
    row: &sqlx_postgres::PgRow,
) -> Result<StructuralFindingStats, StorageError> {
    let analyzed_symbols = nonnegative_u64(row, "analyzed_symbols")?;
    let total_findings = nonnegative_u64(row, "total_findings")?;
    let info_findings = nonnegative_u64(row, "info_findings")?;
    let warning_findings = nonnegative_u64(row, "warning_findings")?;
    let error_findings = nonnegative_u64(row, "error_findings")?;
    let by_finding = serde_json::from_str::<BTreeMap<String, u64>>(&text(row, "by_finding")?)
        .map_err(|_| corrupt_insight())?;
    let finding_sum = by_finding
        .values()
        .try_fold(0_u64, |sum, value| sum.checked_add(*value))
        .ok_or_else(corrupt_insight)?;
    if finding_sum != total_findings {
        return Err(corrupt_insight());
    }
    Ok(StructuralFindingStats {
        state: StructuralFindingComputationState::Ready,
        analyzed_symbols,
        total_findings,
        info_findings,
        warning_findings,
        error_findings,
        very_long_symbols: nonnegative_u64(row, "very_long_symbols")?,
        high_fan_out_symbols: nonnegative_u64(row, "high_fan_out_symbols")?,
        unresolved_reference_pressure: nonnegative_u64(row, "unresolved_reference_pressure")?,
        code_health_score: row
            .try_get("code_health_score")
            .map_err(|_| corrupt_insight())?,
        by_finding,
    })
}

const fn corrupt_insight() -> StorageError {
    StorageError::CorruptStoredValue { field: "insight" }
}

fn missing_structural_finding_stats_error(
    refreshed_generation: Option<&str>,
    current_generation: Option<&str>,
) -> StorageError {
    if refreshed_generation == current_generation && refreshed_generation.is_some() {
        StorageError::CorruptStoredValue {
            field: "structural_finding_run",
        }
    } else {
        StorageError::CurrentGenerationChanged
    }
}

#[cfg(test)]
mod tests {
    use super::missing_structural_finding_stats_error;
    use crate::StorageError;

    #[test]
    fn missing_structural_stats_distinguish_corruption_from_generation_drift() {
        assert_eq!(
            missing_structural_finding_stats_error(Some("generation-a"), Some("generation-a")),
            StorageError::CorruptStoredValue {
                field: "structural_finding_run"
            }
        );
        assert_eq!(
            missing_structural_finding_stats_error(Some("generation-a"), Some("generation-b")),
            StorageError::CurrentGenerationChanged
        );
        assert_eq!(
            missing_structural_finding_stats_error(Some("generation-a"), None),
            StorageError::CurrentGenerationChanged
        );
    }
}
