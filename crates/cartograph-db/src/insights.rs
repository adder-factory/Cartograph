use std::{collections::BTreeMap, time::Duration};

use cartograph_domain::{ContentDigest, GenerationId, NormalizedPath, ProjectId, SymbolId};
use serde::Serialize;
use serde_json::Value;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, StorageError,
    database::{quoted_schema, set_local_statement_timeout},
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
    pub const fn start_line(&self) -> u32 {
        self.start_line
    }

    #[must_use]
    pub const fn outgoing_edges(&self) -> u64 {
        self.outgoing_edges
    }

    #[must_use]
    pub fn safe_code(&self) -> &str {
        &self.safe_code
    }

    #[must_use]
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
    pub fn new(limit: u16) -> Result<Self, StorageError> {
        validate_limit(limit)?;
        Ok(Self {
            limit,
            include_tests: false,
            exclude_fixtures: true,
        })
    }

    #[must_use]
    pub const fn with_include_tests(mut self, include: bool) -> Self {
        self.include_tests = include;
        self
    }

    #[must_use]
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
    Risk,
    Maintenance,
    Brittle,
}

/// Stable database-side ordering for risk hotspots.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StructuralHotspotSort {
    #[default]
    Risk,
    Centrality,
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
    pub const fn with_category(mut self, category: StructuralHotspotCategory) -> Self {
        self.category = category;
        self
    }

    #[must_use]
    pub const fn with_sort(mut self, sort: StructuralHotspotSort) -> Self {
        self.sort = sort;
        self
    }

    pub fn with_minimum_commits(mut self, commits: u64) -> Result<Self, StorageError> {
        if commits > i64::MAX as u64 {
            return Err(StorageError::InvalidInput {
                field: "hotspot_minimum_commits",
            });
        }
        self.minimum_commits = commits;
        Ok(self)
    }

    pub fn with_minimum_centrality(mut self, minimum: f64) -> Result<Self, StorageError> {
        if !minimum.is_finite() || !(0.0..=1.0).contains(&minimum) {
            return Err(StorageError::InvalidInput {
                field: "hotspot_minimum_centrality",
            });
        }
        self.minimum_centrality = minimum;
        Ok(self)
    }

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
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub const fn incoming_edges(&self) -> u64 {
        self.incoming_edges
    }

    #[must_use]
    pub const fn structural_risk(&self) -> u64 {
        self.structural_risk
    }

    #[must_use]
    pub const fn commit_count(&self) -> u64 {
        self.commit_count
    }

    #[must_use]
    pub const fn last_touched_unix_seconds(&self) -> Option<u64> {
        self.last_touched_unix_seconds
    }

    #[must_use]
    pub const fn composite_risk(&self) -> u64 {
        self.composite_risk
    }

    #[must_use]
    pub const fn centrality(&self) -> f64 {
        self.centrality
    }

    #[must_use]
    pub const fn external_dependents(&self) -> u64 {
        self.external_dependents
    }

    #[must_use]
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
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }

    #[must_use]
    pub fn owner_symbol_id(&self) -> Option<&str> {
        self.owner_symbol_id.as_deref()
    }

    #[must_use]
    pub fn module_specifier(&self) -> &str {
        &self.module_specifier
    }

    #[must_use]
    pub fn target_path(&self) -> Option<&str> {
        self.target_path.as_deref()
    }

    #[must_use]
    pub fn target_symbol_id(&self) -> Option<&str> {
        self.target_symbol_id.as_deref()
    }

    #[must_use]
    pub fn evidence_symbol_id(&self) -> &str {
        self.owner_symbol_id
            .as_deref()
            .unwrap_or(&self.source_file_symbol_id)
    }

    #[must_use]
    pub const fn start_byte(&self) -> u64 {
        self.start_byte
    }

    #[must_use]
    pub const fn end_byte(&self) -> u64 {
        self.end_byte
    }

    #[must_use]
    pub const fn confidence(&self) -> f32 {
        self.confidence
    }

    #[must_use]
    pub fn provenance(&self) -> &str {
        &self.provenance
    }

    #[must_use]
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
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub fn module_specifier(&self) -> &str {
        &self.module_specifier
    }

    #[must_use]
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
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub fn owner_symbol_id(&self) -> Option<&str> {
        self.owner_symbol_id.as_deref()
    }

    #[must_use]
    pub const fn start_byte(&self) -> u64 {
        self.start_byte
    }

    #[must_use]
    pub const fn end_byte(&self) -> u64 {
        self.end_byte
    }

    #[must_use]
    pub fn reference_kind(&self) -> &str {
        &self.reference_kind
    }

    #[must_use]
    pub const fn confidence(&self) -> f32 {
        self.confidence
    }

    #[must_use]
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

/// PostgreSQL-native changed-file to affected-test traversal with complete counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTestImpactResult {
    generation_id: GenerationId,
    matched_inputs: Vec<String>,
    dependent_file_count: u64,
    affected_test_file_count: u64,
    reached_barrel_count: u64,
    reached_barrels: Vec<String>,
    barrels_truncated: bool,
    tests: Vec<FileTestImpact>,
    tests_truncated: bool,
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

    /// Distinct non-input files reached within the requested depth.
    #[must_use]
    pub const fn dependent_file_count(&self) -> u64 {
        self.dependent_file_count
    }

    /// Complete number of affected test files before output limiting.
    #[must_use]
    pub const fn affected_test_file_count(&self) -> u64 {
        self.affected_test_file_count
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
    pub fn with_excluded_path_prefix(mut self, prefix: Option<&str>) -> Result<Self, StorageError> {
        validate_finding_path(prefix, "finding_excluded_path")?;
        self.excluded_path_prefix = prefix.map(ToOwned::to_owned);
        Ok(self)
    }

    /// Restrict results to one literal normalized-path prefix.
    pub fn with_path_prefix(mut self, prefix: Option<&str>) -> Result<Self, StorageError> {
        validate_finding_path(prefix, "finding_path_prefix")?;
        self.path_prefix = prefix.map(ToOwned::to_owned);
        Ok(self)
    }

    /// Restrict findings to a non-empty, bounded set of exact symbol identities.
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
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralFindingStats {
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
    pub async fn query_current_dead_code(
        &self,
        project_id: &ProjectId,
        request: &DeadCodeQuery,
    ) -> Result<Vec<DeadCodeCandidate>, StorageError> {
        validate_limit(request.limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), degrees AS (
                    SELECT symbols.symbol_id,
                           COUNT(edges.source_symbol_id) FILTER (
                               WHERE edges.edge_kind NOT IN ('contains', 'def_use')
                           ) AS outgoing_edges
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    LEFT JOIN {schema}."edges" AS edges
                      ON edges.project_id = symbols.project_id
                     AND edges.generation_id = symbols.generation_id
                     AND edges.source_symbol_id = symbols.symbol_id
                    WHERE symbols.project_id = CAST($1 AS uuid)
                    GROUP BY symbols.symbol_id
                )
                SELECT symbols.symbol_id::text,
                       files.normalized_path,
                       files.language,
                       symbols.symbol_kind,
                       symbols.qualified_name,
                       symbols.start_line,
                       0::bigint AS incoming_edges,
                       COALESCE(degrees.outgoing_edges, 0)::bigint,
                       COALESCE(documents.code, '') AS safe_code,
                       EXISTS (
                           SELECT 1
                           FROM {schema}."edges" AS containment
                           JOIN {schema}."symbols" AS parent
                             ON parent.project_id = containment.project_id
                            AND parent.generation_id = containment.generation_id
                            AND parent.symbol_id = containment.source_symbol_id
                           JOIN {schema}."edges" AS contract
                             ON contract.project_id = parent.project_id
                            AND contract.generation_id = parent.generation_id
                            AND contract.source_symbol_id = parent.symbol_id
                            AND contract.edge_kind IN ('implements', 'extends')
                           WHERE containment.project_id = symbols.project_id
                             AND containment.generation_id = symbols.generation_id
                             AND containment.target_symbol_id = symbols.symbol_id
                             AND containment.edge_kind = 'contains'
                       ) AS interface_dispatch_risk
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                LEFT JOIN degrees ON degrees.symbol_id = symbols.symbol_id
                LEFT JOIN LATERAL (
                    SELECT search.code
                    FROM {schema}."search_documents" AS search
                    WHERE search.project_id = symbols.project_id
                      AND search.generation_id = symbols.generation_id
                      AND search.symbol_id = symbols.symbol_id
                      AND search.document_kind = 'symbol'
                    ORDER BY search.id
                    LIMIT 1
                ) AS documents ON true
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind IN (
                      'function', 'method', 'class', 'struct', 'component', 'resource'
                  )
                  AND NOT symbols.exported
                  AND NOT EXISTS (
                      SELECT 1 FROM {schema}."edges" AS incoming
                      WHERE incoming.project_id = symbols.project_id
                        AND incoming.generation_id = symbols.generation_id
                        AND incoming.target_symbol_id = symbols.symbol_id
                        AND incoming.source_symbol_id <> symbols.symbol_id
                        AND incoming.edge_kind IN (
                            'calls', 'references', 'instantiates', 'tests', 'exports',
                            'implements', 'extends', 'overrides', 'decorates'
                        )
                  )
                  AND ($2::boolean OR NOT (
                      files.normalized_path ~* '(^|/)(__tests__|tests?|specs?|scripts?|bench(es|marks?)?|examples?|samples?|demos?)(/|$)'
                      OR files.normalized_path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)'
                  ))
                  AND (NOT $3::boolean OR NOT (
                      files.normalized_path ~* '(^|/)(fixtures?|test-beds?|__mocks__|mocks?)(/|$)'
                  ))
                  AND NOT (
                      files.language = 'rust'
                      AND symbols.qualified_name ~ '(^|::|[.#/$])main$'
                      AND files.normalized_path ~ '(^|/)(build|main)\.rs$|(^|/)bin/[^/]+\.rs$'
                  )
                  AND NOT (
                      files.normalized_path LIKE 'src/installer/targets/%'
                      AND symbols.symbol_kind = 'method'
                      AND symbols.qualified_name ~ '(^|::|[.#/$])(supportsLocation|detect|install|uninstall|printConfig|describePaths)$'
                  )
                  AND NOT (
                      symbols.symbol_kind = 'method'
                      AND COALESCE(symbols.visibility, 'public') NOT IN ('private', 'protected')
                      AND EXISTS (
                          SELECT 1
                          FROM {schema}."edges" AS containment
                          JOIN {schema}."symbols" AS parent
                            ON parent.project_id = containment.project_id
                           AND parent.generation_id = containment.generation_id
                           AND parent.symbol_id = containment.source_symbol_id
                          WHERE containment.project_id = symbols.project_id
                            AND containment.generation_id = symbols.generation_id
                            AND containment.target_symbol_id = symbols.symbol_id
                            AND containment.edge_kind = 'contains'
                            AND parent.exported
                            AND parent.symbol_kind IN ('class', 'struct', 'trait', 'protocol', 'interface')
                      )
                  )
                ORDER BY COALESCE(degrees.outgoing_edges, 0) DESC,
                         files.normalized_path,
                         symbols.start_line,
                         symbols.symbol_id
                LIMIT $4"#,
        );
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
        rows.into_iter().map(decode_dead_code).collect()
    }

    /// Rank files by graph degree, unresolved evidence, and route pressure.
    pub async fn current_structural_hotspots(
        &self,
        project_id: &ProjectId,
        limit: u16,
    ) -> Result<Vec<StructuralHotspot>, StorageError> {
        self.query_structural_hotspots(project_id, StructuralHotspotQuery::new(limit)?)
            .await
    }

    /// Rank a fully filtered current-generation hotspot lens before LIMIT.
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
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), symbol_counts AS (
                    SELECT symbols.file_id,
                           COUNT(*) FILTER (WHERE symbols.symbol_kind <> 'file') AS symbols,
                           COUNT(*) FILTER (WHERE symbols.symbol_kind = 'route') AS routes,
                           COALESCE(MAX(symbols.pagerank), 0.0) AS centrality
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    WHERE symbols.project_id = CAST($1 AS uuid)
                    GROUP BY symbols.file_id
                ), outgoing AS (
                    SELECT source.file_id, SUM(edges.site_count) AS edges
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    JOIN {schema}."symbols" AS source
                      ON source.project_id = edges.project_id
                     AND source.generation_id = edges.generation_id
                     AND source.symbol_id = edges.source_symbol_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND edges.edge_kind <> 'contains'
                    GROUP BY source.file_id
                ), incoming AS (
                    SELECT target.file_id, SUM(edges.site_count) AS edges,
                           COUNT(DISTINCT source.file_id) FILTER (
                               WHERE source.file_id <> target.file_id
                           ) AS external_dependents
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    JOIN {schema}."symbols" AS target
                      ON target.project_id = edges.project_id
                     AND target.generation_id = edges.generation_id
                     AND target.symbol_id = edges.target_symbol_id
                    JOIN {schema}."symbols" AS source
                      ON source.project_id = edges.project_id
                     AND source.generation_id = edges.generation_id
                     AND source.symbol_id = edges.source_symbol_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND edges.edge_kind <> 'contains'
                    GROUP BY target.file_id
                ), unresolved AS (
                    SELECT refs.file_id, SUM(refs.site_count) AS refs
                    FROM {schema}."references" AS refs
                    JOIN current ON current.generation_id = refs.generation_id
                    WHERE refs.project_id = CAST($1 AS uuid)
                      AND refs.target_symbol_id IS NULL
                    GROUP BY refs.file_id
                ), base AS (
                SELECT files.normalized_path,
                       files.language,
                       COALESCE(symbol_counts.symbols, 0)::bigint AS symbols,
                       COALESCE(incoming.edges, 0)::bigint AS incoming_edges,
                       COALESCE(outgoing.edges, 0)::bigint AS outgoing_edges,
                       COALESCE(unresolved.refs, 0)::bigint AS unresolved_references,
                       COALESCE(symbol_counts.routes, 0)::bigint AS routes,
                       (COALESCE(incoming.edges, 0) * 3
                       + COALESCE(outgoing.edges, 0) * 2
                       + COALESCE(unresolved.refs, 0)
                        + COALESCE(symbol_counts.routes, 0) * 4)::bigint AS structural_risk,
                       COALESCE(history.commit_count, 0)::bigint AS commit_count,
                       COALESCE(history.author_count, 0)::bigint AS author_count,
                       COALESCE(history.insertions, 0)::bigint AS insertions,
                       COALESCE(history.deletions, 0)::bigint AS deletions,
                       history.last_touched_at::text AS last_touched_at,
                       EXTRACT(EPOCH FROM history.last_touched_at)::bigint
                           AS last_touched_unix_seconds,
                       (history.normalized_path IS NOT NULL) AS history_available,
                       (
                           (COALESCE(incoming.edges, 0) * 3
                            + COALESCE(outgoing.edges, 0) * 2
                            + COALESCE(unresolved.refs, 0)
                            + COALESCE(symbol_counts.routes, 0) * 4) * 100
                           + LEAST(COALESCE(history.commit_count, 0), 1000) * 10
                           + LEAST(
                               (COALESCE(history.insertions, 0)
                                + COALESCE(history.deletions, 0)) / 10,
                               1000
                             )
                       )::bigint AS composite_risk,
                       COALESCE(symbol_counts.centrality, 0.0)::double precision AS centrality,
                       COALESCE(incoming.external_dependents, 0)::bigint AS external_dependents
                FROM {schema}."files" AS files
                JOIN current ON current.generation_id = files.generation_id
                LEFT JOIN symbol_counts ON symbol_counts.file_id = files.file_id
                LEFT JOIN incoming ON incoming.file_id = files.file_id
                LEFT JOIN outgoing ON outgoing.file_id = files.file_id
                LEFT JOIN unresolved ON unresolved.file_id = files.file_id
                LEFT JOIN {schema}."file_history" AS history
                  ON history.project_id = files.project_id
                 AND history.normalized_path = files.normalized_path
                WHERE files.project_id = CAST($1 AS uuid)
                  AND COALESCE(history.commit_count, 0) >= $2
                  AND COALESCE(symbol_counts.centrality, 0.0) >= $3
                  AND ($4::bigint IS NULL OR history.last_touched_at >=
                       clock_timestamp() - ($4::bigint * interval '1 day'))
                ), normalized AS (
                    SELECT base.*,
                           CASE WHEN MAX(structural_risk) OVER () = 0 THEN 0.0
                                ELSE structural_risk::double precision
                                     / MAX(structural_risk) OVER ()::double precision
                           END AS structural_pressure,
                           CASE WHEN MAX(commit_count * 10 + insertions + deletions) OVER () = 0
                                THEN 0.0
                                ELSE (commit_count * 10 + insertions + deletions)::double precision
                                     / MAX(commit_count * 10 + insertions + deletions) OVER ()::double precision
                           END AS churn_score
                    FROM base
                ), scored AS (
                    SELECT normalized.*,
                           ((centrality * 0.7 + structural_pressure * 0.3) * churn_score)
                               AS risk_score,
                           (churn_score * (1.0 - centrality)) AS maintenance_score,
                           ((centrality * 0.7 + structural_pressure * 0.3)
                               / (1.0 + churn_score)) AS brittle_score
                    FROM normalized
                )
                SELECT normalized_path, language, symbols, incoming_edges,
                       outgoing_edges, unresolved_references, routes, structural_risk,
                       commit_count, author_count, insertions, deletions,
                       last_touched_at, last_touched_unix_seconds, history_available,
                       composite_risk, centrality, structural_pressure, churn_score,
                       risk_score, maintenance_score, brittle_score, external_dependents
                FROM scored
                WHERE {category_filter}
                ORDER BY {ordering}, normalized_path
                LIMIT $5"#,
        );
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
        rows.into_iter().map(decode_hotspot).collect()
    }

    /// Attribute multiple path groups to current symbols in one parallelizable PostgreSQL query.
    ///
    /// Counts and row-number caps are partitioned per group before results leave the database,
    /// so a large commit cannot starve smaller commits and `total` is never a page-size guess.
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
        let statement = format!(
            r#"WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), requested(group_key, normalized_path) AS (
                    SELECT * FROM unnest($2::text[], $3::text[])
                ), ranked AS (
                    SELECT requested.group_key,
                           COUNT(*) OVER (
                               PARTITION BY requested.group_key
                           )::bigint AS total,
                           ROW_NUMBER() OVER (
                               PARTITION BY requested.group_key
                               ORDER BY files.normalized_path,
                                        symbols.start_line,
                                        symbols.symbol_id
                           ) AS group_rank,
                           symbols.symbol_id::text,
                           files.normalized_path,
                           files.language,
                           symbols.symbol_kind,
                           symbols.qualified_name,
                           symbols.start_line,
                           symbols.end_line
                    FROM requested
                    JOIN current ON true
                    JOIN {schema}."files" AS files
                      ON files.project_id = CAST($1 AS uuid)
                     AND files.generation_id = current.generation_id
                     AND files.normalized_path = requested.normalized_path
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = files.project_id
                     AND symbols.generation_id = files.generation_id
                     AND symbols.file_id = files.file_id
                    WHERE symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
                      AND ($4::text IS NULL OR symbols.symbol_id <> CAST($4 AS uuid))
                )
                SELECT group_key, total, symbol_id, normalized_path, language,
                       symbol_kind, qualified_name, start_line, end_line
                FROM ranked
                WHERE group_rank <= $5
                ORDER BY group_key, group_rank"#,
        );
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
                path: text(&row, 3)?,
                language: text(&row, 4)?,
                symbol_kind: text(&row, 5)?,
                qualified_name: text(&row, 6)?,
                start_line: positive_u32(&row, 7)?,
                end_line: positive_u32(&row, 8)?,
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
                SELECT files.normalized_path,
                       files.language,
                       refs.owner_symbol_id::text,
                       refs.reference_name,
                       refs.target_symbol_id::text,
                       target_files.normalized_path,
                       refs.start_byte,
                       refs.end_byte,
                       refs.confidence,
                       refs.resolution_provenance,
                       refs.site_count,
                       file_symbols.symbol_id::text
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
        rows.into_iter().map(decode_import).collect()
    }

    /// Return the complete bounded import evidence set so higher-level filters
    /// are applied before response truncation rather than silently missing hits.
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
                SELECT files.normalized_path,
                       files.language,
                       refs.owner_symbol_id::text,
                       refs.reference_name,
                       refs.target_symbol_id::text,
                       target_files.normalized_path,
                       refs.start_byte,
                       refs.end_byte,
                       refs.confidence,
                       refs.resolution_provenance,
                       refs.site_count,
                       file_symbols.symbol_id::text
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
        rows.into_iter().map(decode_import).collect()
    }

    /// Return every bounded JavaScript-family import declaration for a manifest audit.
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
        rows.into_iter().map(decode_external_import).collect()
    }

    /// Aggregate exact resolution coverage by language and reference kind.
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
        rows.into_iter().map(decode_dependency_coverage).collect()
    }

    /// Return exact current-generation reference sites targeting one symbol.
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
        rows.into_iter().map(decode_rename_site).collect()
    }

    /// Return every bounded exact rename reference so textual de-duplication
    /// happens before the caller's display limit is applied.
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
        rows.into_iter().map(decode_rename_site).collect()
    }

    /// Count all exact current-generation references targeting one symbol.
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
        rows.into_iter().map(decode_file_fingerprint).collect()
    }

    /// Traverse current-generation file dependents in PostgreSQL and return
    /// language-aware affected test files with complete counts. Every symbol
    /// in every matched input file is a root, so named imports and symbol-level
    /// calls are not lost behind a synthetic file node.
    pub async fn current_file_test_impact(
        &self,
        project_id: &ProjectId,
        paths: &[NormalizedPath],
        max_depth: u8,
        limit: u16,
        test_path_regex: Option<&str>,
    ) -> Result<Option<FileTestImpactResult>, StorageError> {
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
        validate_limit(limit)?;
        if test_path_regex.is_some_and(|pattern| pattern.is_empty() || pattern.len() > 4_096) {
            return Err(StorageError::InvalidInput {
                field: "test_impact_filter",
            });
        }
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH RECURSIVE current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                      AND current_generation_id IS NOT NULL
                ), seed_files AS MATERIALIZED (
                    SELECT files.file_id, files.normalized_path
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND files.normalized_path = ANY(CAST($2 AS text[]))
                ), seed_symbols AS MATERIALIZED (
                    SELECT symbols.symbol_id
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    JOIN seed_files ON seed_files.file_id = symbols.file_id
                    WHERE symbols.project_id = CAST($1 AS uuid)
                ), walk(symbol_id, depth) AS (
                    SELECT seed_symbols.symbol_id, 0::integer
                    FROM seed_symbols
                    UNION
                    SELECT edges.source_symbol_id, walk.depth + 1
                    FROM walk
                    JOIN current ON true
                    JOIN {schema}."edges" AS edges
                      ON edges.project_id = CAST($1 AS uuid)
                     AND edges.generation_id = current.generation_id
                     AND edges.target_symbol_id = walk.symbol_id
                    WHERE walk.depth < $3
                      AND edges.edge_kind IN (
                          'calls', 'imports', 'references', 'implements', 'extends',
                          'tests', 'type_of', 'returns', 'instantiates', 'overrides',
                          'decorates', 'field_access', 'def_use', 'exports'
                      )
                ), reached_symbols AS MATERIALIZED (
                    SELECT walk.symbol_id, MIN(walk.depth)::integer AS distance
                    FROM walk
                    GROUP BY walk.symbol_id
                ), reached_files AS MATERIALIZED (
                    SELECT files.file_id,
                           files.normalized_path,
                           MIN(reached_symbols.distance)::integer AS distance,
                           CASE WHEN CAST($5 AS text) IS NULL THEN
                               EXISTS (
                                   SELECT 1
                                   FROM {schema}."search_documents" AS documents
                                   WHERE documents.project_id = files.project_id
                                     AND documents.generation_id = files.generation_id
                                     AND documents.file_id = files.file_id
                                     AND documents.document_kind = 'test'
                               )
                           ELSE files.normalized_path ~ CAST($5 AS text)
                           END AS is_test
                    FROM reached_symbols
                    JOIN current ON true
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = CAST($1 AS uuid)
                     AND symbols.generation_id = current.generation_id
                     AND symbols.symbol_id = reached_symbols.symbol_id
                    JOIN {schema}."files" AS files
                      ON files.project_id = symbols.project_id
                     AND files.generation_id = symbols.generation_id
                     AND files.file_id = symbols.file_id
                    GROUP BY files.project_id, files.generation_id,
                             files.file_id, files.normalized_path
                ), summary AS (
                    SELECT current.generation_id::text,
                           COALESCE((
                               SELECT array_agg(seed_files.normalized_path ORDER BY seed_files.normalized_path)
                               FROM seed_files
                           ), ARRAY[]::text[]) AS matched_inputs,
                           (SELECT COUNT(*)::bigint FROM reached_files WHERE distance > 0)
                               AS dependent_file_count,
                           (SELECT COUNT(*)::bigint FROM reached_files WHERE is_test)
                               AS affected_test_file_count,
                           (SELECT COUNT(*)::bigint
                              FROM reached_files
                             WHERE distance > 0
                               AND normalized_path ~ '(^|/)index\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$')
                               AS reached_barrel_count,
                           ARRAY(
                               SELECT normalized_path
                               FROM reached_files
                               WHERE distance > 0
                                 AND normalized_path ~ '(^|/)index\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$'
                               ORDER BY normalized_path
                               LIMIT {MAX_REPORTED_BARRELS}
                           ) AS reached_barrels
                    FROM current
                ), selected_tests AS (
                    SELECT normalized_path, distance
                    FROM reached_files
                    WHERE is_test
                    ORDER BY distance, normalized_path
                    LIMIT $4
                )
                SELECT summary.generation_id,
                       summary.matched_inputs,
                       summary.dependent_file_count,
                       summary.affected_test_file_count,
                       summary.reached_barrel_count,
                       summary.reached_barrels,
                       selected_tests.normalized_path,
                       selected_tests.distance
                FROM summary
                LEFT JOIN selected_tests ON true
                ORDER BY selected_tests.distance NULLS LAST,
                         selected_tests.normalized_path NULLS LAST"#,
        );
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
                },
                "current-file-test-impact",
            )
            .await?;
        decode_file_test_impact(rows)
    }

    /// Rank symbols by direct incoming test-file evidence.
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
        rows.into_iter().map(decode_coverage).collect()
    }

    /// Detect deterministic structural, coverage, clone, and agent-prone findings.
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
    pub async fn query_current_structural_findings(
        &self,
        project_id: &ProjectId,
        request: &StructuralFindingQuery,
    ) -> Result<Vec<StructuralFinding>, StorageError> {
        validate_limit(request.limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"{}
                SELECT symbol_id::text, path, qualified_name, finding, severity,
                       start_line, end_line, metric_name, metric,
                       degree_centrality, outgoing::bigint, unresolved::bigint, detail::text
                FROM findings
                WHERE ($3::text IS NULL OR finding = $3)
                  AND CASE severity
                        WHEN 'error' THEN 3
                        WHEN 'warning' THEN 2
                        ELSE 1
                      END >= $4
                  AND ($5::double precision IS NULL OR metric >= $5)
                  AND ($6::double precision IS NULL OR metric <= $6)
                  AND ($7::double precision IS NULL OR degree_centrality >= $7)
                  AND ($8::text IS NULL OR LEFT(path, LENGTH($8)) <> $8)
                  AND ($9::text[] IS NULL OR symbol_id::text = ANY($9))
                  AND (NOT $10::boolean OR NOT (
                      path ~* '(^|/)(fixtures?|test-beds?|__tests__|__mocks__|tests?|specs?|integration|testing|testlib)(/|$)'
                      OR path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)[a-z0-9]+$'
                      OR path ~ '([A-Za-z](Test|Tests|TestCase|Spec))\.[a-z0-9]+$'
                      OR path ~* '(^|/)(bench(es|marks?)?|scripts?|examples?|samples?|demos?)(/|$)'
                  ))
                  AND ($11::text IS NULL OR LEFT(path, LENGTH($11)) = $11)
                ORDER BY CASE severity WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
                         degree_centrality DESC, metric DESC, path, start_line, finding
                LIMIT $2"#,
            finding_ctes(&schema),
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
        rows.into_iter().map(decode_finding).collect()
    }

    /// Count every current finding matching the same filters as a ranked query.
    pub async fn count_current_structural_findings(
        &self,
        project_id: &ProjectId,
        request: &StructuralFindingQuery,
    ) -> Result<u64, StorageError> {
        validate_limit(request.limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"{}
                SELECT COUNT(*)::bigint
                FROM findings
                WHERE $2::bigint >= 0
                  AND ($3::text IS NULL OR finding = $3)
                  AND CASE severity
                        WHEN 'error' THEN 3
                        WHEN 'warning' THEN 2
                        ELSE 1
                      END >= $4
                  AND ($5::double precision IS NULL OR metric >= $5)
                  AND ($6::double precision IS NULL OR metric <= $6)
                  AND ($7::double precision IS NULL OR degree_centrality >= $7)
                  AND ($8::text IS NULL OR LEFT(path, LENGTH($8)) <> $8)
                  AND ($9::text[] IS NULL OR symbol_id::text = ANY($9))
                  AND (NOT $10::boolean OR NOT (
                      path ~* '(^|/)(fixtures?|test-beds?|__tests__|__mocks__|tests?|specs?|integration|testing|testlib)(/|$)'
                      OR path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)[a-z0-9]+$'
                      OR path ~ '([A-Za-z](Test|Tests|TestCase|Spec))\.[a-z0-9]+$'
                      OR path ~* '(^|/)(bench(es|marks?)?|scripts?|examples?|samples?|demos?)(/|$)'
                  ))
                  AND ($11::text IS NULL OR LEFT(path, LENGTH($11)) = $11)"#,
            finding_ctes(&schema),
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
    pub async fn query_current_structural_findings_per_detector(
        &self,
        project_id: &ProjectId,
        request: &StructuralFindingGroupQuery,
    ) -> Result<StructuralFindingGroup, StorageError> {
        validate_limit(request.per_finding_limit)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"{}, ranked AS (
                    SELECT symbol_id, path, qualified_name, finding, severity,
                           start_line, end_line, metric_name, metric,
                           degree_centrality, outgoing, unresolved, detail,
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
                    FROM findings
                    WHERE finding = ANY($2::text[])
                      AND CASE severity
                            WHEN 'error' THEN 3
                            WHEN 'warning' THEN 2
                            ELSE 1
                          END >= $3
                      AND (NOT $4::boolean OR NOT (
                          path ~* '(^|/)(fixtures?|test-beds?|__tests__|__mocks__|tests?|specs?|integration|testing|testlib)(/|$)'
                          OR path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)[a-z0-9]+$'
                          OR path ~ '([A-Za-z](Test|Tests|TestCase|Spec))\.[a-z0-9]+$'
                          OR path ~* '(^|/)(bench(es|marks?)?|scripts?|examples?|samples?|demos?)(/|$)'
                      ))
                )
                SELECT symbol_id::text, path, qualified_name, finding, severity,
                       start_line, end_line, metric_name, metric,
                       degree_centrality, outgoing::bigint, unresolved::bigint,
                       detail::text, detector_total
                FROM ranked
                WHERE detector_rank <= $5
                ORDER BY finding, detector_rank, path, start_line, symbol_id"#,
            finding_ctes(&schema),
        );
        let rows = self
            .bounded_rows(
                statement,
                |statement| {
                    statement
                        .bind(project_id.as_str())
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
            counts.insert(text(&row, 3)?, nonnegative_u64(&row, 13)?);
            findings.push(decode_finding(row)?);
        }
        Ok(StructuralFindingGroup { findings, counts })
    }

    /// Aggregate every current-generation finding without a row-limit blind spot.
    pub async fn current_structural_finding_stats(
        &self,
        project_id: &ProjectId,
    ) -> Result<StructuralFindingStats, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"{}, totals AS (
                    SELECT COUNT(*)::bigint AS total,
                           COUNT(*) FILTER (WHERE severity = 'info')::bigint AS info,
                           COUNT(*) FILTER (WHERE severity = 'warning')::bigint AS warning,
                           COUNT(*) FILTER (WHERE severity = 'error')::bigint AS error
                    FROM findings
                ), by_kind AS (
                    SELECT finding, COUNT(*)::bigint AS count
                    FROM findings GROUP BY finding
                )
                SELECT (SELECT COUNT(*)::bigint FROM base),
                       totals.total, totals.info, totals.warning, totals.error,
                       COALESCE((SELECT count FROM by_kind WHERE finding = 'large_method'), 0),
                       COALESCE((SELECT count FROM by_kind WHERE finding = 'high_fan_out'), 0),
                       COALESCE((SELECT count FROM by_kind WHERE finding = 'unresolved_reference_pressure'), 0),
                       GREATEST(
                           0.0,
                           100.0 - (
                               totals.error * 4.0 + totals.warning * 2.0 + totals.info
                           ) * 100.0 / GREATEST((SELECT COUNT(*) FROM base), 1)
                       )::real,
                       COALESCE((
                           SELECT jsonb_object_agg(finding, count ORDER BY finding)::text
                           FROM by_kind
                       ), '{{}}')
                FROM totals"#,
            finding_ctes(&schema),
        );
        let mut rows = self
            .bounded_rows(
                statement,
                |statement| statement.bind(project_id.as_str()),
                "current-structural-finding-stats",
            )
            .await?;
        let row = rows
            .pop()
            .ok_or(StorageError::CorruptStoredValue { field: "insight" })?;
        decode_finding_stats(&row)
    }

    async fn bounded_rows<'query, Bind>(
        &self,
        statement: String,
        bind: Bind,
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
        set_local_statement_timeout(&mut transaction, DEFAULT_INSIGHT_TIMEOUT)
            .await
            .map_err(|_| database_error(operation))?;
        let rows = bind(query(AssertSqlSafe(statement)))
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

fn finding_ctes(schema: &str) -> String {
    format!(
        r#"WITH current AS (
                SELECT current_generation_id AS generation_id
                FROM {schema}."projects"
                WHERE project_id = CAST($1 AS uuid)
            ), population AS (
                SELECT GREATEST(COUNT(*) - 1, 1)::double precision AS possible_peers
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
            ), previous AS (
                SELECT generations.generation_id, generations.published_at
                FROM {schema}."index_generations" AS generations
                WHERE generations.project_id = CAST($1 AS uuid)
                  AND generations.state = 'superseded'
                ORDER BY generations.generation_sequence DESC
                LIMIT 1
            ), outgoing AS (
                SELECT edges.source_symbol_id AS symbol_id,
                       SUM(edges.site_count)::bigint AS sites
                FROM {schema}."edges" AS edges
                JOIN current ON current.generation_id = edges.generation_id
                WHERE edges.project_id = CAST($1 AS uuid)
                  AND edges.edge_kind <> 'contains'
                GROUP BY edges.source_symbol_id
            ), unresolved AS (
                SELECT refs.owner_symbol_id AS symbol_id,
                       SUM(refs.site_count)::bigint AS sites
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.target_symbol_id IS NULL
                  AND refs.owner_symbol_id IS NOT NULL
                GROUP BY refs.owner_symbol_id
            ), incoming AS (
                SELECT edges.target_symbol_id AS symbol_id,
                       SUM(edges.site_count)::bigint AS sites,
                       COUNT(*) FILTER (
                           WHERE source.file_id <> target.file_id
                       )::bigint AS external_edges
                FROM {schema}."edges" AS edges
                JOIN current ON current.generation_id = edges.generation_id
                JOIN {schema}."symbols" AS source
                  ON source.project_id = edges.project_id
                 AND source.generation_id = edges.generation_id
                 AND source.symbol_id = edges.source_symbol_id
                JOIN {schema}."symbols" AS target
                  ON target.project_id = edges.project_id
                 AND target.generation_id = edges.generation_id
                 AND target.symbol_id = edges.target_symbol_id
                WHERE edges.project_id = CAST($1 AS uuid)
                  AND edges.edge_kind <> 'contains'
                GROUP BY edges.target_symbol_id
            ), members AS (
                SELECT parent.symbol_id,
                       COUNT(child.symbol_id)::bigint AS members,
                       COUNT(child.symbol_id) FILTER (
                           WHERE child.symbol_kind IN ('function', 'method')
                       )::bigint AS methods
                FROM {schema}."symbols" AS parent
                JOIN current ON current.generation_id = parent.generation_id
                LEFT JOIN {schema}."edges" AS containment
                  ON containment.project_id = parent.project_id
                 AND containment.generation_id = parent.generation_id
                 AND containment.source_symbol_id = parent.symbol_id
                 AND containment.edge_kind = 'contains'
                LEFT JOIN {schema}."symbols" AS child
                  ON child.project_id = containment.project_id
                 AND child.generation_id = containment.generation_id
                 AND child.symbol_id = containment.target_symbol_id
                WHERE parent.project_id = CAST($1 AS uuid)
                GROUP BY parent.symbol_id
            ), production_clone_symbols AS (
                SELECT symbols.*, files.normalized_path,
                       search.metadata AS search_metadata
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                JOIN {schema}."search_documents" AS search
                  ON search.project_id = symbols.project_id
                 AND search.generation_id = symbols.generation_id
                 AND search.symbol_id = symbols.symbol_id
                 AND search.document_kind = 'symbol'
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind IN ('function', 'method', 'component')
                  AND COALESCE(
                        (search.metadata ->> 'duplicate_detection_enabled')::boolean,
                        true
                      )
                  AND files.normalized_path !~* '(^|/)(fixtures?|test-beds?|__tests__|__mocks__|tests?|specs?|integration|testing|testlib)(/|$)'
                  AND files.normalized_path !~* '(\.test\.|\.spec\.|_test\.|_spec\.)[a-z0-9]+$'
                  AND files.normalized_path !~ '([A-Za-z](Test|Tests|TestCase|Spec))\.[a-z0-9]+$'
                  AND files.normalized_path !~* '(^|/)(test[-_][^/]*|test|mocks?|fixtures?)\.[a-z0-9]+$'
                  AND files.normalized_path !~* '(^|/)(bench(es|marks?)?|scripts?|examples?|samples?|demos?)(/|$)'
                  AND files.normalized_path !~* '\.(gen|generated)\.[a-z0-9]+$'
                  AND files.normalized_path !~* '^(publish|release|build|deploy|bundle|prepublish|postinstall)\.[mc]?[jt]s$'
            ), duplicates AS (
                SELECT structural_digest, COUNT(*)::bigint AS copies
                FROM production_clone_symbols
                WHERE end_line - start_line + 1 >= 6
                GROUP BY structural_digest
                HAVING COUNT(*) > 1
            ), clone_shapes AS (
                SELECT symbols.search_metadata ->> 'clone_shape_digest' AS clone_shape_digest,
                       COUNT(*)::bigint AS copies
                FROM production_clone_symbols AS symbols
                LEFT JOIN duplicates
                  ON duplicates.structural_digest = symbols.structural_digest
                WHERE duplicates.structural_digest IS NULL
                  AND symbols.end_line - symbols.start_line + 1 >= 12
                  AND COALESCE(
                        (symbols.search_metadata #>> ARRAY['health','literal_bytes'])::double precision,
                        0.0
                      ) / GREATEST(symbols.end_byte - symbols.start_byte, 1)::double precision <= 0.6
                  AND symbols.search_metadata ->> 'clone_shape_digest' IS NOT NULL
                GROUP BY symbols.search_metadata ->> 'clone_shape_digest'
                HAVING COUNT(*) > 1
                   AND COUNT(DISTINCT symbols.structural_digest) > 1
            ), syntactically_unclaimed_clone_symbols AS (
                SELECT symbols.*
                FROM production_clone_symbols AS symbols
                LEFT JOIN duplicates
                  ON duplicates.structural_digest = symbols.structural_digest
                LEFT JOIN clone_shapes
                  ON clone_shapes.clone_shape_digest =
                     symbols.search_metadata ->> 'clone_shape_digest'
                WHERE duplicates.structural_digest IS NULL
                  AND NOT (
                        clone_shapes.clone_shape_digest IS NOT NULL
                        AND symbols.end_line - symbols.start_line + 1 >= 12
                        AND COALESCE(
                              (symbols.search_metadata #>> ARRAY['health','literal_bytes'])::double precision,
                              0.0
                            ) / GREATEST(
                                  symbols.end_byte - symbols.start_byte,
                                  1
                                )::double precision <= 0.6
                      )
                  AND COALESCE(
                        (symbols.search_metadata #>> ARRAY['partial_clone','peer_count'])::bigint,
                        0
                      ) = 0
                  AND symbols.end_line - symbols.start_line + 1 >= 6
            ), semantic_clone_pairs AS (
                SELECT edges.source_symbol_id AS source_symbol_id,
                       edges.target_symbol_id AS target_symbol_id,
                       MAX(edges.score) AS score
                FROM {schema}."symbol_similarity_edges" AS edges
                JOIN current ON current.generation_id = edges.generation_id
                JOIN {schema}."symbol_similarity_builds" AS builds
                  ON builds.project_id = edges.project_id
                 AND builds.generation_id = edges.generation_id
                 AND builds.model_id = edges.model_id
                JOIN syntactically_unclaimed_clone_symbols AS source
                  ON source.project_id = edges.project_id
                 AND source.generation_id = edges.generation_id
                 AND source.symbol_id = edges.source_symbol_id
                JOIN syntactically_unclaimed_clone_symbols AS target
                  ON target.project_id = edges.project_id
                 AND target.generation_id = edges.generation_id
                 AND target.symbol_id = edges.target_symbol_id
                WHERE edges.project_id = CAST($1 AS uuid)
                  AND edges.score >= 0.95
                  AND edges.score <= 1.0
                  AND edges.source_symbol_id <> edges.target_symbol_id
                GROUP BY edges.source_symbol_id, edges.target_symbol_id
            ), undirected_semantic_clone_pairs AS (
                SELECT source_symbol_id AS symbol_id, target_symbol_id AS peer_symbol_id, score
                FROM semantic_clone_pairs
                UNION ALL
                SELECT target_symbol_id AS symbol_id, source_symbol_id AS peer_symbol_id, score
                FROM semantic_clone_pairs
            ), semantic_clone_peers AS (
                SELECT symbol_id, COUNT(DISTINCT peer_symbol_id)::bigint AS peers,
                       MAX(score) AS maximum_score
                FROM undirected_semantic_clone_pairs
                GROUP BY symbol_id
            ), source_classes AS (
                SELECT methods.symbol_id, containers.symbol_id AS class_id
                FROM {schema}."symbols" AS methods
                JOIN current ON current.generation_id = methods.generation_id
                JOIN {schema}."edges" AS containment
                  ON containment.project_id = methods.project_id
                 AND containment.generation_id = methods.generation_id
                 AND containment.target_symbol_id = methods.symbol_id
                 AND containment.edge_kind = 'contains'
                JOIN {schema}."symbols" AS containers
                  ON containers.project_id = containment.project_id
                 AND containers.generation_id = containment.generation_id
                 AND containers.symbol_id = containment.source_symbol_id
                WHERE methods.project_id = CAST($1 AS uuid)
                  AND methods.symbol_kind = 'method'
                  AND containers.symbol_kind IN ('class','struct','trait')
            ), field_classes AS (
                SELECT fields.symbol_id AS field_id, containers.symbol_id AS class_id
                FROM {schema}."symbols" AS fields
                JOIN current ON current.generation_id = fields.generation_id
                JOIN {schema}."edges" AS containment
                  ON containment.project_id = fields.project_id
                 AND containment.generation_id = fields.generation_id
                 AND containment.target_symbol_id = fields.symbol_id
                 AND containment.edge_kind = 'contains'
                JOIN {schema}."symbols" AS containers
                  ON containers.project_id = containment.project_id
                 AND containers.generation_id = containment.generation_id
                 AND containers.symbol_id = containment.source_symbol_id
                WHERE fields.project_id = CAST($1 AS uuid)
                  AND fields.symbol_kind IN ('field','property','method')
                  AND containers.symbol_kind IN ('class','struct','trait','interface')
            ), feature_envy_accesses AS (
                SELECT refs.owner_symbol_id AS symbol_id,
                       source_classes.class_id AS source_class_id,
                       field_classes.field_id,
                       field_classes.class_id AS field_class_id,
                       refs.site_count
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                JOIN source_classes ON source_classes.symbol_id = refs.owner_symbol_id
                JOIN field_classes ON field_classes.field_id = refs.target_symbol_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.reference_kind = 'field_access'
            ), feature_envy AS (
                SELECT symbol_id,
                       COUNT(DISTINCT field_id) FILTER (
                           WHERE field_class_id <> source_class_id
                       )::bigint AS atfd,
                       COUNT(DISTINCT field_class_id) FILTER (
                           WHERE field_class_id <> source_class_id
                       )::bigint AS fdp,
                       SUM(site_count) FILTER (
                           WHERE field_class_id = source_class_id
                       )::bigint AS own_accesses,
                       SUM(site_count) FILTER (
                           WHERE field_class_id <> source_class_id
                       )::bigint AS foreign_accesses
                FROM feature_envy_accesses
                GROUP BY symbol_id
            ), prior_symbols AS (
                SELECT symbols.symbol_id,
                       symbols.end_line - symbols.start_line + 1 AS lines,
                       previous.published_at
                FROM {schema}."symbols" AS symbols
                JOIN previous ON previous.generation_id = symbols.generation_id
                WHERE symbols.project_id = CAST($1 AS uuid)
            ), selected_coverage AS (
                SELECT DISTINCT ON (coverage.symbol_id)
                       coverage.symbol_id, coverage.coverage_fraction
                FROM {schema}."symbol_coverage" AS coverage
                JOIN current ON current.generation_id = coverage.generation_id
                WHERE coverage.project_id = CAST($1 AS uuid)
                  AND coverage.lines_found > 0
                ORDER BY coverage.symbol_id,
                         coverage.coverage_fraction DESC NULLS LAST,
                         coverage.source_id
            ), ranked_coverage AS (
                SELECT coverage.symbol_id, coverage.coverage_fraction,
                       percent_rank() OVER (
                           ORDER BY COALESCE(incoming.sites, 0)
                       ) AS centrality_percentile
                FROM selected_coverage AS coverage
                LEFT JOIN incoming ON incoming.symbol_id = coverage.symbol_id
            ), base AS (
                SELECT symbols.symbol_id, files.normalized_path AS path,
                       symbols.qualified_name, symbols.symbol_kind,
                       symbols.structural_digest,
                       documents.metadata ->> 'clone_shape_digest' AS clone_shape_digest,
                       documents.metadata #> ARRAY['partial_clone','listed_peer_symbol_ids'] AS partial_clone_listed_peer_ids,
                       symbols.start_line, symbols.end_line,
                       symbols.end_line - symbols.start_line + 1 AS lines,
                       symbols.exported, symbols.default_export,
                       (
                           (
                               files.normalized_path ~ '(^|/)routes/.*\.[jt]sx?$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])Route$'
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/routes/.*\.[jt]sx?$'
                               AND (
                                   symbols.default_export
                                   OR symbols.qualified_name ~ '(^|::|[.#/$])(loader|clientLoader|action|clientAction|headers|handle|links|meta|shouldRevalidate|middleware|clientMiddleware|unstable_middleware|unstable_clientMiddleware|ErrorBoundary|HydrateFallback)$'
                               )
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/root\.[jt]sx?$'
                               AND (
                                   symbols.default_export
                                   OR symbols.qualified_name ~ '(^|::|[.#/$])(loader|clientLoader|action|clientAction|headers|handle|links|meta|shouldRevalidate|middleware|clientMiddleware|unstable_middleware|unstable_clientMiddleware|ErrorBoundary|HydrateFallback|Layout)$'
                               )
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/entry\.server\.[jt]sx?$'
                               AND (
                                   symbols.default_export
                                   OR symbols.qualified_name ~ '(^|::|[.#/$])(handleRequest|handleDataRequest|handleError|streamTimeout)$'
                               )
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/(.*/)?(page|layout|template|route|error|global-error|loading|not-found|default|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(ts|tsx|js|jsx|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(dynamic|dynamicParams|revalidate|fetchCache|runtime|preferredRegion|maxDuration|experimental_ppr|generateStaticParams|generateImageMetadata|generateSitemaps)$'
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/(.*/)?route\.(ts|tsx|js|jsx|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$'
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/(.*/)?(page|layout|template|error|global-error|loading|not-found|default|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(ts|tsx|js|jsx|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(metadata|generateMetadata|viewport|generateViewport)$'
                           )
                           OR (
                               files.normalized_path ~ '^(src/)?middleware\.(ts|js|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(middleware|config)$'
                           )
                           OR (
                               files.normalized_path ~ '^(src/)?instrumentation\.(ts|js|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(register|onRequestError)$'
                           )
                       ) AS framework_convention_export,
                       LEAST(
                           1.0,
                           COALESCE(incoming.sites, 0)::double precision
                           / population.possible_peers
                       ) AS degree_centrality,
                       COALESCE(outgoing.sites, 0)::bigint AS outgoing,
                       COALESCE(unresolved.sites, 0)::bigint AS unresolved,
                       COALESCE(incoming.external_edges, 0)::bigint AS external_incoming,
                       COALESCE(members.members, 0)::bigint AS members,
                       COALESCE(members.methods, 0)::bigint AS methods,
                       COALESCE(duplicates.copies, 0)::bigint AS duplicate_copies,
                       COALESCE(clone_shape_match.copies, 0)::bigint AS clone_shape_copies,
                       COALESCE(
                           (documents.metadata #>> ARRAY['partial_clone','peer_count'])::bigint,
                           0
                       ) AS partial_clone_peers,
                       COALESCE(
                           (documents.metadata #>> ARRAY['partial_clone','maximum_overlap_ppm'])::double precision,
                           0.0
                       ) AS partial_clone_maximum_overlap_ppm,
                       COALESCE(
                           (documents.metadata #>> ARRAY['partial_clone','minimum_overlap_ppm'])::double precision,
                           0.0
                       ) AS partial_clone_minimum_overlap_ppm,
                       COALESCE(semantic_clone_peers.peers, 0)::bigint AS semantic_clone_peers,
                       COALESCE(semantic_clone_peers.maximum_score, 0.0)::double precision AS semantic_clone_maximum_score,
                       COALESCE(feature_envy.atfd, 0)::bigint AS feature_envy_atfd,
                       COALESCE(feature_envy.fdp, 0)::bigint AS feature_envy_fdp,
                       COALESCE(feature_envy.own_accesses, 0)::bigint AS own_accesses,
                       COALESCE(feature_envy.foreign_accesses, 0)::bigint AS foreign_accesses,
                       COALESCE(feature_envy.own_accesses, 0)::double precision /
                           GREATEST(
                               COALESCE(feature_envy.own_accesses, 0)
                               + COALESCE(feature_envy.foreign_accesses, 0),
                               1
                           )::double precision AS local_attribute_access,
                       prior_symbols.lines AS prior_lines,
                       prior_symbols.published_at AS prior_published_at,
                       ranked_coverage.coverage_fraction,
                       ranked_coverage.centrality_percentile,
                       COALESCE((documents.metadata #>> ARRAY['health','parameter_count'])::double precision, 0.0) AS parameter_count,
                       COALESCE((documents.metadata #>> ARRAY['health','cyclomatic'])::double precision, 0.0) AS cyclomatic,
                       COALESCE((documents.metadata #>> ARRAY['health','max_nesting'])::double precision, 0.0) AS max_nesting,
                       COALESCE((documents.metadata #>> ARRAY['health','max_conditional_operands'])::double precision, 0.0) AS max_conditional_operands,
                       COALESCE((documents.metadata #>> ARRAY['health','magic_numbers'])::double precision, 0.0) AS magic_numbers,
                       COALESCE((documents.metadata #>> ARRAY['health','hardcoded_urls'])::double precision, 0.0) AS hardcoded_urls,
                       COALESCE((documents.metadata #>> ARRAY['health','secrets_score'])::double precision, 0.0) AS secrets_score,
                       COALESCE((documents.metadata #>> ARRAY['health','stale_doc_numbers'])::double precision, 0.0) AS stale_doc_numbers,
                       COALESCE((documents.metadata #>> ARRAY['health','accidental_quadratic'])::double precision, 0.0) AS accidental_quadratic,
                       COALESCE((documents.metadata #>> ARRAY['health','empty_catches'])::double precision, 0.0) AS empty_catches,
                       COALESCE((documents.metadata #>> ARRAY['health','sync_io_in_async'])::double precision, 0.0) AS sync_io_in_async,
                       COALESCE((documents.metadata #>> ARRAY['health','sequential_await_loops'])::double precision, 0.0) AS sequential_await_loops,
                       COALESCE((documents.metadata #>> ARRAY['health','ts_any_casts'])::double precision, 0.0) AS ts_any_casts,
                       COALESCE((documents.metadata #>> ARRAY['health','ts_suppressions'])::double precision, 0.0) AS ts_suppressions,
                       COALESCE((documents.metadata #>> ARRAY['health','debug_logs'])::double precision, 0.0) AS debug_logs,
                       COALESCE((documents.metadata #>> ARRAY['health','incomplete_markers'])::double precision, 0.0) AS incomplete_markers,
                       COALESCE((documents.metadata #>> ARRAY['health','dynamic_eval'])::double precision, 0.0) AS dynamic_eval,
                       COALESCE((documents.metadata #>> ARRAY['health','insecure_hash'])::double precision, 0.0) AS insecure_hash,
                       COALESCE((documents.metadata #>> ARRAY['health','insecure_random'])::double precision, 0.0) AS insecure_random,
                       COALESCE((documents.metadata #>> ARRAY['health','http_without_timeout'])::double precision, 0.0) AS http_without_timeout,
                       COALESCE((documents.metadata #>> ARRAY['health','sql_string_concatenation'])::double precision, 0.0) AS sql_string_concatenation,
                       COALESCE((documents.metadata #>> ARRAY['health','unsafe_json_parse'])::double precision, 0.0) AS unsafe_json_parse,
                       COALESCE((documents.metadata #>> ARRAY['health','unvalidated_env'])::double precision, 0.0) AS unvalidated_env,
                       COALESCE((documents.metadata #>> ARRAY['health','empty_body'])::double precision, 0.0) AS empty_body
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                LEFT JOIN outgoing ON outgoing.symbol_id = symbols.symbol_id
                LEFT JOIN unresolved ON unresolved.symbol_id = symbols.symbol_id
                LEFT JOIN incoming ON incoming.symbol_id = symbols.symbol_id
                LEFT JOIN members ON members.symbol_id = symbols.symbol_id
                LEFT JOIN duplicates ON duplicates.structural_digest = symbols.structural_digest
                LEFT JOIN LATERAL (
                    SELECT clone_shapes.copies
                    FROM {schema}."search_documents" AS clone_document
                    JOIN clone_shapes
                      ON clone_shapes.clone_shape_digest =
                         clone_document.metadata ->> 'clone_shape_digest'
                    WHERE clone_document.project_id = symbols.project_id
                      AND clone_document.generation_id = symbols.generation_id
                      AND clone_document.symbol_id = symbols.symbol_id
                      AND clone_document.document_kind = 'symbol'
                    ORDER BY clone_document.id
                    LIMIT 1
                ) AS clone_shape_match ON true
                LEFT JOIN feature_envy ON feature_envy.symbol_id = symbols.symbol_id
                LEFT JOIN semantic_clone_peers ON semantic_clone_peers.symbol_id = symbols.symbol_id
                LEFT JOIN prior_symbols ON prior_symbols.symbol_id = symbols.symbol_id
                LEFT JOIN ranked_coverage ON ranked_coverage.symbol_id = symbols.symbol_id
                CROSS JOIN population
                LEFT JOIN LATERAL (
                    SELECT search.metadata
                    FROM {schema}."search_documents" AS search
                    WHERE search.project_id = symbols.project_id
                      AND search.generation_id = symbols.generation_id
                      AND search.symbol_id = symbols.symbol_id
                      AND search.document_kind = 'symbol'
                    ORDER BY search.id
                    LIMIT 1
                ) AS documents ON true
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
            ), findings AS (
                SELECT base.symbol_id, base.path, base.qualified_name,
                       candidate.finding, candidate.metric_name, candidate.metric,
                       CASE
                         WHEN candidate.metric >= candidate.error_threshold THEN 'error'
                         WHEN candidate.metric >= candidate.warning_threshold THEN 'warning'
                         ELSE 'info'
                       END AS severity,
                       base.start_line, base.end_line, base.degree_centrality,
                       base.outgoing, base.unresolved,
                       CASE WHEN candidate.finding = 'duplicate_code' THEN
                         jsonb_strip_nulls(jsonb_build_object(
                           'cloneType', CASE
                             WHEN base.duplicate_copies > 1 THEN 'exact'
                             WHEN base.clone_shape_copies > 1 THEN 'near'
                             WHEN base.partial_clone_peers > 0 THEN 'partial'
                             ELSE 'semantic'
                           END,
                           'classSize', CASE
                             WHEN base.duplicate_copies > 1 THEN base.duplicate_copies
                             WHEN base.clone_shape_copies > 1 THEN base.clone_shape_copies
                             WHEN base.partial_clone_peers > 0 THEN base.partial_clone_peers + 1
                             ELSE base.semantic_clone_peers + 1
                           END,
                           'loc', base.lines,
                           'maximumOverlap', CASE
                             WHEN base.partial_clone_peers > 0
                             THEN base.partial_clone_maximum_overlap_ppm / 1000000.0
                             ELSE NULL
                           END,
                           'minimumOverlap', CASE
                             WHEN base.partial_clone_peers > 0
                             THEN base.partial_clone_minimum_overlap_ppm / 1000000.0
                             ELSE NULL
                           END,
                           'maximumSemanticScore', CASE
                             WHEN base.semantic_clone_peers > 0
                             THEN base.semantic_clone_maximum_score
                             ELSE NULL
                           END,
                           'semanticThreshold', CASE
                             WHEN base.semantic_clone_peers > 0 THEN 0.95
                             ELSE NULL
                           END,
                           'members', CASE
                             WHEN base.duplicate_copies > 1 THEN (
                               SELECT COALESCE(jsonb_agg(member.payload ORDER BY member.path, member.start_line, member.symbol_id), '[]'::jsonb)
                               FROM (
                                 SELECT peer.normalized_path AS path,
                                        peer.start_line,
                                        peer.symbol_id,
                                        jsonb_build_object(
                                          'symbolId', peer.symbol_id::text,
                                          'qualifiedName', peer.qualified_name,
                                          'location', peer.normalized_path || ':' || peer.start_line::text
                                        ) AS payload
                                 FROM production_clone_symbols AS peer
                                 WHERE peer.symbol_id <> base.symbol_id
                                   AND peer.structural_digest = base.structural_digest
                                   AND peer.end_line - peer.start_line + 1 >= 6
                                 ORDER BY peer.normalized_path, peer.start_line, peer.symbol_id
                                 LIMIT 10
                               ) AS member
                             )
                             WHEN base.clone_shape_copies > 1 THEN (
                               SELECT COALESCE(jsonb_agg(member.payload ORDER BY member.path, member.start_line, member.symbol_id), '[]'::jsonb)
                               FROM (
                                 SELECT peer.normalized_path AS path,
                                        peer.start_line,
                                        peer.symbol_id,
                                        jsonb_build_object(
                                          'symbolId', peer.symbol_id::text,
                                          'qualifiedName', peer.qualified_name,
                                          'location', peer.normalized_path || ':' || peer.start_line::text
                                        ) AS payload
                                 FROM production_clone_symbols AS peer
                                 LEFT JOIN duplicates AS exact_peer
                                   ON exact_peer.structural_digest = peer.structural_digest
                                 WHERE peer.symbol_id <> base.symbol_id
                                   AND exact_peer.structural_digest IS NULL
                                   AND peer.search_metadata ->> 'clone_shape_digest' = base.clone_shape_digest
                                   AND peer.end_line - peer.start_line + 1 >= 12
                                   AND COALESCE(
                                         (peer.search_metadata #>> ARRAY['health','literal_bytes'])::double precision,
                                         0.0
                                       ) / GREATEST(peer.end_byte - peer.start_byte, 1)::double precision <= 0.6
                                 ORDER BY peer.normalized_path, peer.start_line, peer.symbol_id
                                 LIMIT 10
                               ) AS member
                             )
                             WHEN base.partial_clone_peers > 0 THEN (
                               SELECT COALESCE(jsonb_agg(member.payload ORDER BY member.path, member.start_line, member.symbol_id), '[]'::jsonb)
                               FROM (
                                 SELECT peer.normalized_path AS path,
                                        peer.start_line,
                                        peer.symbol_id,
                                        jsonb_build_object(
                                          'symbolId', peer.symbol_id::text,
                                          'qualifiedName', peer.qualified_name,
                                          'location', peer.normalized_path || ':' || peer.start_line::text
                                        ) AS payload
                                 FROM jsonb_array_elements_text(
                                        COALESCE(base.partial_clone_listed_peer_ids, '[]'::jsonb)
                                      ) AS listed(symbol_id)
                                 JOIN production_clone_symbols AS peer
                                   ON peer.symbol_id::text = listed.symbol_id
                                 ORDER BY peer.normalized_path, peer.start_line, peer.symbol_id
                                 LIMIT 10
                               ) AS member
                             )
                             ELSE (
                               SELECT COALESCE(jsonb_agg(member.payload ORDER BY member.path, member.start_line, member.symbol_id), '[]'::jsonb)
                               FROM (
                                 SELECT DISTINCT peer.normalized_path AS path,
                                        peer.start_line,
                                        peer.symbol_id,
                                        jsonb_build_object(
                                          'symbolId', peer.symbol_id::text,
                                          'qualifiedName', peer.qualified_name,
                                          'location', peer.normalized_path || ':' || peer.start_line::text
                                        ) AS payload
                                 FROM undirected_semantic_clone_pairs AS relation
                                 JOIN production_clone_symbols AS peer
                                   ON peer.symbol_id = relation.peer_symbol_id
                                 WHERE relation.symbol_id = base.symbol_id
                                 ORDER BY peer.normalized_path, peer.start_line, peer.symbol_id
                                 LIMIT 10
                               ) AS member
                             )
                           END
                         ))
                       ELSE NULL END AS detail
                FROM base
                CROSS JOIN LATERAL (
                    VALUES
                      ('large_method'::text, 'lines'::text, base.lines::double precision, 100.0, 100.0, 200.0, base.symbol_kind IN ('function','method','component')),
                      ('complex_method', 'cyclomatic', base.cyclomatic, 15.0, 15.0, 25.0, base.symbol_kind IN ('function','method','component')),
                      ('nested_complexity', 'max_nesting', base.max_nesting, 5.0, 5.0, 7.0, base.symbol_kind IN ('function','method','component')),
                      ('complex_conditional', 'conditional_operands', base.max_conditional_operands, 6.0, 6.0, 8.0, base.symbol_kind IN ('function','method','component')),
                      ('long_parameter_list', 'parameters', base.parameter_count, 4.0, 5.0, 7.0, base.symbol_kind IN ('function','method','component')),
                      ('brain_method', 'composite_risk', (base.lines / 100.0) * (base.cyclomatic / 10.0) * GREATEST(1.0, base.max_nesting / 3.0) * GREATEST(1.0, base.max_conditional_operands / 4.0), 5.0, 10.0, 20.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 50 AND base.cyclomatic >= 8),
                      ('magic_number', 'occurrences', base.magic_numbers, 3.0, 5.0, 8.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('hardcoded_url', 'occurrences', base.hardcoded_urls, 1.0, 2.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('recently_grew', 'growth_percent', base.lines::double precision * 100.0 / GREATEST(base.prior_lines, 1), 150.0, 200.0, 300.0, base.symbol_kind IN ('function','method','component') AND base.prior_lines >= 20 AND base.lines > base.prior_lines * 1.5 AND base.prior_published_at >= clock_timestamp() - interval '30 days'),
                      ('stale_doc', 'disjoint_documented_numbers', base.stale_doc_numbers, 1.0, 999.0, 999.0, base.symbol_kind = 'constant'),
                      ('secrets_handling', 'confidence_percent', base.secrets_score, 50.0, 50.0, 70.0, base.symbol_kind IN ('function','method','component')),
                      ('god_class', 'members', base.members::double precision, 15.0, 40.0, 60.0, base.symbol_kind IN ('class','struct','module') AND base.methods > 0),
                      ('feature_envy', 'foreign_field_accesses', base.feature_envy_atfd::double precision, 6.0, 12.0, 999.0, base.symbol_kind = 'method' AND base.feature_envy_fdp <= 2 AND base.local_attribute_access < (1.0 / 3.0)),
                      ('unused_export', 'external_incoming_edges', CASE WHEN base.exported AND base.external_incoming = 0 THEN 1.0 ELSE 0.0 END, 1.0, 1.0, 2.0, base.symbol_kind IN ('function','method','class','component','constant') AND base.path <> 'src/index.ts' AND base.path NOT LIKE '%.d.ts' AND NOT base.framework_convention_export),
                      ('low_coverage', 'uncovered_percent', (1.0 - COALESCE(base.coverage_fraction, 1.0)) * 100.0, 50.0, 50.0, 80.0, base.symbol_kind IN ('function','method','component') AND base.coverage_fraction <= 0.5 AND base.centrality_percentile >= 0.9),
                      ('duplicate_code', CASE WHEN base.duplicate_copies > 1 THEN 'exact_copies' WHEN base.clone_shape_copies > 1 THEN 'normalized_shape_copies' WHEN base.partial_clone_peers > 0 THEN 'partial_clone_peers' ELSE 'semantic_clone_peers' END, CASE WHEN base.duplicate_copies > 1 THEN base.duplicate_copies WHEN base.clone_shape_copies > 1 THEN base.clone_shape_copies WHEN base.partial_clone_peers > 0 THEN base.partial_clone_peers ELSE base.semantic_clone_peers END::double precision, CASE WHEN base.duplicate_copies > 1 OR base.clone_shape_copies > 1 THEN 2.0 ELSE 1.0 END, CASE WHEN base.duplicate_copies > 1 THEN 2.0 ELSE 999.0 END, 999.0, base.symbol_kind IN ('function','method','component') AND ((base.duplicate_copies > 1 AND base.lines >= 6) OR (base.clone_shape_copies > 1 AND base.lines >= 12) OR (base.partial_clone_peers > 0 AND base.lines >= 12) OR (base.semantic_clone_peers > 0 AND base.lines >= 6))),
                      ('high_fan_out', 'outgoing_sites', base.outgoing::double precision, 25.0, 50.0, 100.0, true),
                      ('unresolved_reference_pressure', 'unresolved_sites', base.unresolved::double precision, 15.0, 40.0, 100.0, true),
                      ('accidental_quadratic', 'occurrences', base.accidental_quadratic, 1.0, 1.0, 5.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('empty_catch', 'occurrences', base.empty_catches, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('sync_io_in_async', 'occurrences', base.sync_io_in_async, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('forof_await', 'occurrences', base.sequential_await_loops, 1.0, 2.0, 5.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('ts_any_cast', 'occurrences', base.ts_any_casts, 2.0, 3.0, 5.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('ts_ignore_suppression', 'occurrences', base.ts_suppressions, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('agent_debug_log', 'occurrences', base.debug_logs, 1.0, 1.0, 5.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('incomplete_marker', 'occurrences', base.incomplete_markers, 1.0, 5.0, 50.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('dynamic_eval', 'occurrences', base.dynamic_eval, 1.0, 1.0, 1.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('insecure_hash', 'occurrences', base.insecure_hash, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('random_for_security', 'occurrences', base.insecure_random, 1.0, 1.0, 1.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('http_no_timeout', 'occurrences', base.http_without_timeout, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('sql_string_concat', 'occurrences', base.sql_string_concatenation, 1.0, 1.0, 2.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('unsafe_json_parse', 'occurrences', base.unsafe_json_parse, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('env_no_validation', 'occurrences', base.unvalidated_env, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('empty_function_body', 'occurrences', base.empty_body, 1.0, 999.0, 999.0, base.symbol_kind IN ('function','method','component'))
                ) AS candidate(
                    finding, metric_name, metric, info_threshold,
                    warning_threshold, error_threshold, enabled
                )
                WHERE candidate.enabled AND candidate.metric >= candidate.info_threshold
            )"#,
    )
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

fn text(row: &sqlx_postgres::PgRow, index: usize) -> Result<String, StorageError> {
    row.try_get(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

fn optional_text(row: &sqlx_postgres::PgRow, index: usize) -> Result<Option<String>, StorageError> {
    row.try_get(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

fn nonnegative_u64(row: &sqlx_postgres::PgRow, index: usize) -> Result<u64, StorageError> {
    let value = row
        .try_get::<i64, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    u64::try_from(value).map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

fn optional_nonnegative_u64(
    row: &sqlx_postgres::PgRow,
    index: usize,
) -> Result<Option<u64>, StorageError> {
    row.try_get::<Option<i64>, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?
        .map(u64::try_from)
        .transpose()
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

fn fraction(row: &sqlx_postgres::PgRow, index: usize) -> Result<f64, StorageError> {
    row.try_get::<f64, _>(index)
        .ok()
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        .ok_or(StorageError::CorruptStoredValue { field: "insight" })
}

fn positive_u32(row: &sqlx_postgres::PgRow, index: usize) -> Result<u32, StorageError> {
    let value = row
        .try_get::<i32, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    u32::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(StorageError::CorruptStoredValue { field: "insight" })
}

fn nonnegative_u8(row: &sqlx_postgres::PgRow, index: usize) -> Result<u8, StorageError> {
    let value = row
        .try_get::<i32, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    u8::try_from(value).map_err(|_| StorageError::CorruptStoredValue { field: "insight" })
}

fn decode_dead_code(row: sqlx_postgres::PgRow) -> Result<DeadCodeCandidate, StorageError> {
    Ok(DeadCodeCandidate {
        symbol_id: text(&row, 0)?,
        path: text(&row, 1)?,
        language: text(&row, 2)?,
        symbol_kind: text(&row, 3)?,
        qualified_name: text(&row, 4)?,
        start_line: positive_u32(&row, 5)?,
        incoming_edges: nonnegative_u64(&row, 6)?,
        outgoing_edges: nonnegative_u64(&row, 7)?,
        safe_code: text(&row, 8)?,
        interface_dispatch_risk: row
            .try_get(9)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        reason: "no_incoming_structural_evidence",
    })
}

fn decode_hotspot(row: sqlx_postgres::PgRow) -> Result<StructuralHotspot, StorageError> {
    Ok(StructuralHotspot {
        path: text(&row, 0)?,
        language: text(&row, 1)?,
        symbols: nonnegative_u64(&row, 2)?,
        incoming_edges: nonnegative_u64(&row, 3)?,
        outgoing_edges: nonnegative_u64(&row, 4)?,
        unresolved_references: nonnegative_u64(&row, 5)?,
        routes: nonnegative_u64(&row, 6)?,
        structural_risk: nonnegative_u64(&row, 7)?,
        commit_count: nonnegative_u64(&row, 8)?,
        author_count: nonnegative_u64(&row, 9)?,
        insertions: nonnegative_u64(&row, 10)?,
        deletions: nonnegative_u64(&row, 11)?,
        last_touched_at: optional_text(&row, 12)?,
        last_touched_unix_seconds: optional_nonnegative_u64(&row, 13)?,
        history_available: row
            .try_get(14)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        composite_risk: nonnegative_u64(&row, 15)?,
        centrality: fraction(&row, 16)?,
        structural_pressure: fraction(&row, 17)?,
        churn_score: fraction(&row, 18)?,
        risk_score: fraction(&row, 19)?,
        maintenance_score: fraction(&row, 20)?,
        brittle_score: fraction(&row, 21)?,
        external_dependents: nonnegative_u64(&row, 22)?,
    })
}

fn decode_import(row: sqlx_postgres::PgRow) -> Result<ImportInsight, StorageError> {
    Ok(ImportInsight {
        path: text(&row, 0)?,
        language: text(&row, 1)?,
        owner_symbol_id: optional_text(&row, 2)?,
        module_specifier: text(&row, 3)?,
        target_symbol_id: optional_text(&row, 4)?,
        target_path: optional_text(&row, 5)?,
        start_byte: nonnegative_u64(&row, 6)?,
        end_byte: nonnegative_u64(&row, 7)?,
        confidence: row
            .try_get(8)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        provenance: text(&row, 9)?,
        site_count: nonnegative_u64(&row, 10)?,
        source_file_symbol_id: text(&row, 11)?,
    })
}

fn decode_external_import(row: sqlx_postgres::PgRow) -> Result<ExternalImportRecord, StorageError> {
    Ok(ExternalImportRecord {
        path: text(&row, 0)?,
        language: text(&row, 1)?,
        module_specifier: text(&row, 2)?,
        site_count: nonnegative_u64(&row, 3)?,
    })
}

fn decode_dependency_coverage(
    row: sqlx_postgres::PgRow,
) -> Result<DependencyCoverageRow, StorageError> {
    Ok(DependencyCoverageRow {
        language: text(&row, 0)?,
        reference_kind: text(&row, 1)?,
        references: nonnegative_u64(&row, 2)?,
        resolved: nonnegative_u64(&row, 3)?,
        unresolved: nonnegative_u64(&row, 4)?,
        represented_sites: nonnegative_u64(&row, 5)?,
    })
}

fn decode_rename_site(row: sqlx_postgres::PgRow) -> Result<RenameReferenceSite, StorageError> {
    Ok(RenameReferenceSite {
        path: text(&row, 0)?,
        owner_symbol_id: optional_text(&row, 1)?,
        start_byte: nonnegative_u64(&row, 2)?,
        end_byte: nonnegative_u64(&row, 3)?,
        reference_kind: text(&row, 4)?,
        confidence: row
            .try_get(5)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        provenance: text(&row, 6)?,
    })
}

fn decode_file_fingerprint(
    row: sqlx_postgres::PgRow,
) -> Result<IndexedFileFingerprint, StorageError> {
    let path = text(&row, 0)?;
    Ok(IndexedFileFingerprint {
        path: NormalizedPath::parse(&path)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
        content_hash: ContentDigest::parse(&text(&row, 1)?)
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
    let affected_test_file_count = nonnegative_u64(first, 3)?;
    let reached_barrel_count = nonnegative_u64(first, 4)?;
    let reached_barrels = first
        .try_get::<Vec<String>, _>(5)
        .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
    let mut tests = Vec::new();
    for row in rows {
        let path = optional_text(&row, 6)?;
        let distance = row
            .try_get::<Option<i32>, _>(7)
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?;
        match (path, distance) {
            (None, None) => {}
            (Some(path), Some(_)) => tests.push(FileTestImpact {
                path,
                distance: nonnegative_u8(&row, 7)?,
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
        barrels_truncated: reached_barrel_count > returned_barrels,
        tests,
        tests_truncated: affected_test_file_count > returned_tests,
    }))
}

fn decode_coverage(row: sqlx_postgres::PgRow) -> Result<StructuralCoverageRow, StorageError> {
    Ok(StructuralCoverageRow {
        symbol_id: text(&row, 0)?,
        path: text(&row, 1)?,
        qualified_name: text(&row, 2)?,
        symbol_kind: text(&row, 3)?,
        direct_test_files: nonnegative_u64(&row, 4)?,
        incoming_edges: nonnegative_u64(&row, 5)?,
    })
}

fn decode_finding(row: sqlx_postgres::PgRow) -> Result<StructuralFinding, StorageError> {
    Ok(StructuralFinding {
        symbol_id: text(&row, 0)?,
        path: text(&row, 1)?,
        qualified_name: text(&row, 2)?,
        finding: text(&row, 3)?,
        severity: text(&row, 4)?,
        start_line: positive_u32(&row, 5)?,
        end_line: positive_u32(&row, 6)?,
        metric_name: text(&row, 7)?,
        metric: row.try_get(8).map_err(|_| corrupt_insight())?,
        degree_centrality: row.try_get(9).map_err(|_| corrupt_insight())?,
        outgoing_edges: nonnegative_u64(&row, 10)?,
        unresolved_references: nonnegative_u64(&row, 11)?,
        detail: optional_text(&row, 12)?
            .map(|detail| serde_json::from_str(&detail))
            .transpose()
            .map_err(|_| StorageError::CorruptStoredValue { field: "insight" })?,
    })
}

fn decode_finding_stats(
    row: &sqlx_postgres::PgRow,
) -> Result<StructuralFindingStats, StorageError> {
    let analyzed_symbols = nonnegative_u64(row, 0)?;
    let total_findings = nonnegative_u64(row, 1)?;
    let info_findings = nonnegative_u64(row, 2)?;
    let warning_findings = nonnegative_u64(row, 3)?;
    let error_findings = nonnegative_u64(row, 4)?;
    let by_finding = serde_json::from_str::<BTreeMap<String, u64>>(&text(row, 9)?)
        .map_err(|_| corrupt_insight())?;
    let finding_sum = by_finding
        .values()
        .try_fold(0_u64, |sum, value| sum.checked_add(*value))
        .ok_or_else(corrupt_insight)?;
    if finding_sum != total_findings {
        return Err(corrupt_insight());
    }
    Ok(StructuralFindingStats {
        analyzed_symbols,
        total_findings,
        info_findings,
        warning_findings,
        error_findings,
        very_long_symbols: nonnegative_u64(row, 5)?,
        high_fan_out_symbols: nonnegative_u64(row, 6)?,
        unresolved_reference_pressure: nonnegative_u64(row, 7)?,
        code_health_score: row.try_get(8).map_err(|_| corrupt_insight())?,
        by_finding,
    })
}

const fn corrupt_insight() -> StorageError {
    StorageError::CorruptStoredValue { field: "insight" }
}
