use std::{
    collections::BTreeMap,
    env,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use cartograph_domain::SourceLanguage;
use futures_util::StreamExt as _;
use num_traits::ToPrimitive as _;
use reqwest::StatusCode;
use secrecy::{ExposeSecret as _, SecretString};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tempfile::NamedTempFile;
use thiserror::Error;
use url::Url;

const CONFIG_DIRECTORY: &str = ".cartograph";
const CONFIG_FILE: &str = "config.json";
const CONFIG_LOCK_FILE: &str = "config.lock";
const CONFIG_LOCK_WAIT: Duration = Duration::from_millis(250);
const CONFIG_LOCK_RETRY: Duration = Duration::from_millis(5);
const MAXIMUM_CONFIG_BYTES: u64 = 1024 * 1024;
const MAXIMUM_MODEL_BYTES: usize = 256;
const MAXIMUM_API_KEY_BYTES: usize = 8_192;
const MAXIMUM_TIMEOUT_MS: u64 = 600_000;
const MAXIMUM_CONCURRENCY: u16 = 16;
const MAXIMUM_SUMMARY_BATCH_SIZE: u16 = 16;
const MAXIMUM_CLAUDE_BINARY_BYTES: usize = 4_096;
const MAXIMUM_LLAMA_SERVER_ARGUMENTS: usize = 128;
const MAXIMUM_LLAMA_SERVER_ARGUMENT_BYTES: usize = 4_096;
const MAXIMUM_LLAMA_SERVER_ARGUMENT_TOTAL_BYTES: usize = 32 * 1_024;
const MAXIMUM_PROBE_BYTES: usize = 1024 * 1024;
const MAXIMUM_PROBE_MODELS: usize = 128;
const MAXIMUM_PROJECT_SOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAXIMUM_PROJECT_GENERATION_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAXIMUM_PROJECT_EXCLUDES: usize = 4_096;
const MAXIMUM_PROJECT_EXCLUDE_BYTES: usize = 4_096;
const OPENAI_CLOUD_ENDPOINT: &str = "https://api.openai.com";
const ANTHROPIC_CLOUD_ENDPOINT: &str = "https://api.anthropic.com";
const CLAUDE_BRIDGE_ENDPOINT: &str = "claude-bridge://local";
const DEFAULT_CLAUDE_SUMMARIZE_MODEL: &str = "claude-haiku-4-5";
const DEFAULT_CLAUDE_ASK_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_SUMMARY_EAGER_LIMIT: u64 = 600;
const MAXIMUM_SUMMARY_EAGER_LIMIT: u64 = 10_000_000;
const DEFAULT_SUMMARY_MINIMUM_BODY_LINES: u32 = 4;
const MAXIMUM_SUMMARY_MINIMUM_BODY_LINES: u32 = 1_000_000;
const MAXIMUM_SUMMARY_KIND_OVERRIDES: usize = 128;
const MAXIMUM_SUMMARY_KIND_BYTES: usize = 64;

/// LLM slots preserved from the v1.1.33 project-config contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectLlmTier {
    /// Represents the embedding project LLM tier.
    Embedding,
    /// Represents the summarize project LLM tier.
    Summarize,
    /// Represents the local project LLM tier.
    Local,
    /// Represents the ask project LLM tier.
    Ask,
    /// Represents the classify project LLM tier.
    Classify,
    /// Represents the reranker project LLM tier.
    Reranker,
}

/// Validated provider retained from the v1.1.33 chat configuration contract.
/// Embedding and reranker tiers remain OpenAI-compatible HTTP only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectLlmProvider {
    /// Represents the open ai compat project LLM provider.
    OpenAiCompat,
    /// Represents the claude bridge project LLM provider.
    ClaudeBridge,
    /// Represents the anthropic API project LLM provider.
    AnthropicApi,
}

/// Effective project-wide eager summary budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSummaryEagerLimit {
    /// Represents the bounded project summary eager limit.
    Bounded(u64),
    /// Represents the uncapped project summary eager limit.
    Uncapped,
}

/// V1-compatible summary candidate and eager-run settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectSummarySettings {
    enabled: bool,
    eager_limit: ProjectSummaryEagerLimit,
    minimum_body_lines: u32,
    minimum_body_lines_by_kind: BTreeMap<String, u32>,
}

impl ProjectSummarySettings {
    #[must_use]
    /// Returns whether summary generation is enabled.
    pub const fn enabled(&self) -> bool {
        self.enabled
    }

    #[must_use]
    /// Returns the eager limit.
    pub const fn eager_limit(&self) -> ProjectSummaryEagerLimit {
        self.eager_limit
    }

    #[must_use]
    /// Returns the minimum body lines.
    pub const fn minimum_body_lines(&self) -> u32 {
        self.minimum_body_lines
    }

    #[must_use]
    /// Returns the minimum body lines by kind.
    pub const fn minimum_body_lines_by_kind(&self) -> &BTreeMap<String, u32> {
        &self.minimum_body_lines_by_kind
    }
}

impl ProjectLlmProvider {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "openai-compat" => Some(Self::OpenAiCompat),
            "claude-bridge" => Some(Self::ClaudeBridge),
            "anthropic-api" => Some(Self::AnthropicApi),
            _ => None,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiCompat => "openai-compat",
            Self::ClaudeBridge => "claude-bridge",
            Self::AnthropicApi => "anthropic-api",
        }
    }
}

/// Non-secret source discovery settings read from the shared project config boundary.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ProjectSourceSettings {
    maximum_file_bytes: Option<usize>,
    maximum_generation_bytes: Option<u64>,
    languages: Vec<SourceLanguage>,
    includes: Option<Vec<String>>,
    excludes: Vec<String>,
    features: SourceFeatureFlags,
    duplicate_code_allowlist: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
enum SourceFeature {
    ExtractDocstrings = 1 << 0,
    TrackCallSites = 1 << 1,
    IndexSubmodules = 1 << 2,
    IndexEmbeddedRepositories = 1 << 3,
    Centrality = 1 << 4,
    Betweenness = 1 << 5,
    Churn = 1 << 6,
    CoChange = 1 << 7,
    Biomarkers = 1 << 8,
    IssueHistory = 1 << 9,
    ConfigReferences = 1 << 10,
    SqlReferences = 1 << 11,
    BuildContextReferences = 1 << 12,
    StringImports = 1 << 13,
    DuplicateCodePartialClones = 1 << 14,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SourceFeatureFlags(u16);

impl SourceFeatureFlags {
    const DEFAULT_BITS: u16 = (1 << 14) - 1;

    const fn enabled(self, feature: SourceFeature) -> bool {
        self.0 & feature as u16 != 0
    }

    const fn set(&mut self, feature: SourceFeature, enabled: bool) {
        let mask = feature as u16;
        if enabled {
            self.0 |= mask;
        } else {
            self.0 &= !mask;
        }
    }
}

impl Default for SourceFeatureFlags {
    fn default() -> Self {
        Self(Self::DEFAULT_BITS)
    }
}

impl std::fmt::Debug for ProjectSourceSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProjectSourceSettings")
            .field("maximum_file_bytes", &self.maximum_file_bytes)
            .field("maximum_generation_bytes", &self.maximum_generation_bytes)
            .field("configured_languages", &self.languages.len())
            .field(
                "include_patterns",
                &self.includes.as_ref().map_or(0, Vec::len),
            )
            .field("exclude_patterns", &self.excludes.len())
            .field("features", &self.features)
            .field("extract_docstrings", &self.extract_docstrings())
            .field("track_call_sites", &self.track_call_sites())
            .field("index_submodules", &self.index_submodules())
            .field(
                "index_embedded_repositories",
                &self.index_embedded_repositories(),
            )
            .field("enable_centrality", &self.enable_centrality())
            .field("enable_betweenness", &self.enable_betweenness())
            .field("enable_churn", &self.enable_churn())
            .field("enable_co_change", &self.enable_co_change())
            .field("enable_biomarkers", &self.enable_biomarkers())
            .field("enable_issue_history", &self.enable_issue_history())
            .field("enable_config_refs", &self.enable_config_refs())
            .field("enable_sql_refs", &self.enable_sql_refs())
            .field(
                "enable_build_context_refs",
                &self.enable_build_context_refs(),
            )
            .field("enable_string_imports", &self.enable_string_imports())
            .field(
                "duplicate_code_partial_clones",
                &self.duplicate_code_partial_clones(),
            )
            .field(
                "duplicate_code_allowlist_patterns",
                &self.duplicate_code_allowlist.len(),
            )
            .finish()
    }
}

impl ProjectSourceSettings {
    #[must_use]
    /// Returns the maximum file bytes.
    pub const fn maximum_file_bytes(&self) -> Option<usize> {
        self.maximum_file_bytes
    }

    /// Returns the explicit retained canonical-generation byte ceiling.
    #[must_use]
    pub const fn maximum_generation_bytes(&self) -> Option<u64> {
        self.maximum_generation_bytes
    }

    /// Empty means every native language; otherwise this is the canonical
    /// v1-compatible `languages` allow-list.
    #[must_use]
    pub fn languages(&self) -> &[SourceLanguage] {
        &self.languages
    }

    /// `None` selects every native path; `Some` preserves the exact project
    /// include-glob allow-list, including an intentionally empty list.
    #[must_use]
    pub fn includes(&self) -> Option<&[String]> {
        self.includes.as_deref()
    }

    #[must_use]
    /// Returns the excludes.
    pub fn excludes(&self) -> &[String] {
        &self.excludes
    }

    #[must_use]
    /// Returns whether extracted docstrings are retained.
    pub const fn extract_docstrings(&self) -> bool {
        self.features.enabled(SourceFeature::ExtractDocstrings)
    }

    #[must_use]
    /// Returns whether call-site facts are indexed.
    pub const fn track_call_sites(&self) -> bool {
        self.features.enabled(SourceFeature::TrackCallSites)
    }

    #[must_use]
    /// Returns whether nested Git submodules are indexed.
    pub const fn index_submodules(&self) -> bool {
        self.features.enabled(SourceFeature::IndexSubmodules)
    }

    #[must_use]
    /// Returns whether embedded repositories are indexed.
    pub const fn index_embedded_repositories(&self) -> bool {
        self.features
            .enabled(SourceFeature::IndexEmbeddedRepositories)
    }

    /// Whether v1-compatible `PageRank` centrality is derived for each generation.
    #[must_use]
    pub const fn enable_centrality(&self) -> bool {
        self.features.enabled(SourceFeature::Centrality)
    }

    /// Whether bounded sampled Brandes betweenness is derived for each generation.
    #[must_use]
    pub const fn enable_betweenness(&self) -> bool {
        self.features.enabled(SourceFeature::Betweenness)
    }

    #[must_use]
    /// Whether Git churn facts are derived.
    pub const fn enable_churn(&self) -> bool {
        self.features.enabled(SourceFeature::Churn)
    }

    #[must_use]
    /// Whether Git co-change relationships are derived.
    pub const fn enable_co_change(&self) -> bool {
        self.features.enabled(SourceFeature::CoChange)
    }

    #[must_use]
    /// Whether static code-health biomarkers are derived.
    pub const fn enable_biomarkers(&self) -> bool {
        self.features.enabled(SourceFeature::Biomarkers)
    }

    #[must_use]
    /// Whether issue-tagged Git history is derived.
    pub const fn enable_issue_history(&self) -> bool {
        self.features.enabled(SourceFeature::IssueHistory)
    }

    #[must_use]
    /// Whether configuration-key references are extracted.
    pub const fn enable_config_refs(&self) -> bool {
        self.features.enabled(SourceFeature::ConfigReferences)
    }

    #[must_use]
    /// Whether SQL relation references are extracted.
    pub const fn enable_sql_refs(&self) -> bool {
        self.features.enabled(SourceFeature::SqlReferences)
    }

    #[must_use]
    /// Whether build-context file references are extracted.
    pub const fn enable_build_context_refs(&self) -> bool {
        self.features.enabled(SourceFeature::BuildContextReferences)
    }

    #[must_use]
    /// Whether import-shaped string literals contribute module edges.
    pub const fn enable_string_imports(&self) -> bool {
        self.features.enabled(SourceFeature::StringImports)
    }

    /// Whether the wider 0.80 Type-3 clone band is enabled in addition to 0.95.
    #[must_use]
    pub const fn duplicate_code_partial_clones(&self) -> bool {
        self.features
            .enabled(SourceFeature::DuplicateCodePartialClones)
    }

    /// Project-relative path globs exempted from every duplicate-code tier.
    #[must_use]
    pub fn duplicate_code_allowlist(&self) -> &[String] {
        &self.duplicate_code_allowlist
    }
}

impl ProjectLlmTier {
    const fn config_key(self) -> &'static str {
        match self {
            Self::Embedding => "embeddingLlm",
            Self::Summarize => "summarizeLlm",
            Self::Local => "localLlm",
            Self::Ask => "askLlm",
            Self::Classify => "classifyLlm",
            Self::Reranker => "rerankerLlm",
        }
    }

    const fn fallback(self) -> Option<Self> {
        match self {
            Self::Local | Self::Ask | Self::Classify => Some(Self::Summarize),
            Self::Embedding | Self::Summarize | Self::Reranker => None,
        }
    }
}

/// Where a configured Bearer credential is resolved without exposing it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectLlmCredentialSource {
    /// Represents the none project LLM credential source.
    None,
    /// Represents the environment project LLM credential source.
    Environment,
    /// Represents the inline legacy project LLM credential source.
    InlineLegacy,
}

/// Secret-free outcome for one configured tier credential mutation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectLlmCredentialWriteAction {
    /// No credential existed and no credential mutation was needed.
    Unchanged,
    /// An existing credential was retained because the provider origin did not change.
    Preserved,
    /// The caller explicitly removed every credential reference.
    ClearedExplicitly,
    /// Cartograph removed credentials because the provider endpoint origin changed.
    ClearedOriginChange,
    /// The caller replaced any previous credential with an environment reference.
    EnvironmentReferenceSet,
}

/// One tier's secret-free credential mutation result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLlmCredentialWriteEntry {
    /// Tier whose configuration was updated.
    pub tier: ProjectLlmTier,
    /// Credential action applied without exposing credential material.
    pub action: ProjectLlmCredentialWriteAction,
}

/// Atomic project LLM configuration write report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLlmWriteReport {
    /// One entry for every configured tier mutation.
    pub credential_actions: Vec<ProjectLlmCredentialWriteEntry>,
}

/// Secret-safe outcome for one legacy inline credential migration candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectCredentialMigrationStatus {
    /// Represents the ready credential migration status state.
    Ready,
    /// Represents the migrated credential migration status state.
    Migrated,
    /// Represents the environment missing credential migration status state.
    EnvironmentMissing,
    /// Represents the environment mismatch credential migration status state.
    EnvironmentMismatch,
    /// Represents the unsupported provider credential migration status state.
    UnsupportedProvider,
}

/// One credential migration decision. The credential value is never retained
/// in or exposed by this report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCredentialMigrationEntry {
    /// Tier for this record.
    pub tier: ProjectLlmTier,
    /// Optional environment, when available.
    pub environment: Option<String>,
    /// Status for this record.
    pub status: ProjectCredentialMigrationStatus,
}

/// Atomic project credential migration report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCredentialMigrationReport {
    /// Whether migration changes are reported without being written.
    pub dry_run: bool,
    /// Bounded candidates included in this result.
    pub candidates: Vec<ProjectCredentialMigrationEntry>,
    /// Number of migrated.
    pub migrated: usize,
    /// Number of remaining inline.
    pub remaining_inline: usize,
}

/// Bounded `/v1/models` probe used by the agent-driven setup planner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmEndpointProbe {
    /// Whether the configured endpoint accepted a bounded probe.
    pub reachable: bool,
    /// Whether the endpoint satisfied the OpenAI-compatible response contract.
    pub openai_compatible: bool,
    /// Bounded models included in this result.
    pub models: Vec<String>,
}

/// One validated OpenAI-compatible project tier.
#[derive(Clone)]
pub struct ProjectLlmTierConfig {
    provider: ProjectLlmProvider,
    endpoint: String,
    model: String,
    ask_model: Option<String>,
    api_key: Option<SecretString>,
    credential_source: ProjectLlmCredentialSource,
    timeout_ms: Option<u64>,
    concurrency: Option<u16>,
    summary_batch_size: Option<u16>,
    claude_bin: Option<String>,
    llama_server_args: Vec<String>,
    externally_managed: bool,
}

impl std::fmt::Debug for ProjectLlmTierConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProjectLlmTierConfig")
            .field("provider", &self.provider)
            .field("endpoint", &"<redacted>")
            .field("model", &self.model)
            .field("ask_model", &self.ask_model)
            .field("api_key_configured", &self.api_key.is_some())
            .field("credential_source", &self.credential_source)
            .field("timeout_ms", &self.timeout_ms)
            .field("concurrency", &self.concurrency)
            .field("summary_batch_size", &self.summary_batch_size)
            .field("claude_binary_configured", &self.claude_bin.is_some())
            .field("llama_server_argument_count", &self.llama_server_args.len())
            .field("externally_managed", &self.externally_managed)
            .finish()
    }
}

impl ProjectLlmTierConfig {
    #[must_use]
    /// Returns the provider.
    pub const fn provider(&self) -> ProjectLlmProvider {
        self.provider
    }

    #[must_use]
    /// Returns the endpoint.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    #[must_use]
    /// Returns the model.
    pub fn model(&self) -> &str {
        &self.model
    }

    #[must_use]
    /// Returns the ask model.
    pub fn ask_model(&self) -> Option<&str> {
        self.ask_model.as_deref()
    }

    #[must_use]
    /// Returns the API key.
    pub fn api_key(&self) -> Option<String> {
        self.api_key
            .as_ref()
            .map(|value| value.expose_secret().to_owned())
    }

    #[must_use]
    /// Returns the credential source.
    pub const fn credential_source(&self) -> ProjectLlmCredentialSource {
        self.credential_source
    }

    #[must_use]
    /// Returns the timeout milliseconds.
    pub const fn timeout_ms(&self) -> Option<u64> {
        self.timeout_ms
    }

    #[must_use]
    /// Returns the concurrency.
    pub const fn concurrency(&self) -> Option<u16> {
        self.concurrency
    }

    #[must_use]
    /// Returns the summary batch size.
    pub const fn summary_batch_size(&self) -> Option<u16> {
        self.summary_batch_size
    }

    #[must_use]
    /// Returns the claude bin.
    pub fn claude_bin(&self) -> Option<&str> {
        self.claude_bin.as_deref()
    }

    #[must_use]
    /// Returns the llama server args.
    pub fn llama_server_args(&self) -> &[String] {
        &self.llama_server_args
    }

    #[must_use]
    /// Returns whether the configured backend is managed externally.
    pub const fn externally_managed(&self) -> bool {
        self.externally_managed
    }
}

#[derive(Clone, Debug)]
enum ProjectLlmCredentialIntent {
    Preserve,
    Clear,
    Environment(String),
}

/// Validated config mutation. Credentials are preserved only while the
/// provider endpoint origin is unchanged, unless explicitly cleared or
/// replaced with an environment-variable reference.
#[derive(Clone, Debug)]
pub struct ProjectLlmTierInput {
    tier: ProjectLlmTier,
    provider: ProjectLlmProvider,
    endpoint: String,
    model: String,
    ask_model: Option<String>,
    credential_intent: ProjectLlmCredentialIntent,
    timeout_ms: Option<u64>,
    concurrency: Option<u16>,
    summary_batch_size: Option<u16>,
    claude_bin: Option<String>,
}

impl ProjectLlmTierInput {
    /// Creates a validated project LLM tier input.
    ///
    /// # Errors
    ///
    /// Returns an error if `endpoint` is unsafe/invalid or `model` is empty,
    /// oversized, or contains control characters.
    pub fn new(
        tier: ProjectLlmTier,
        endpoint: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, ProjectLlmConfigError> {
        let endpoint = endpoint.into();
        let model = model.into();
        validate_endpoint(&endpoint)?;
        validate_model(&model)?;
        Ok(Self {
            tier,
            provider: ProjectLlmProvider::OpenAiCompat,
            endpoint,
            model,
            ask_model: None,
            credential_intent: ProjectLlmCredentialIntent::Preserve,
            timeout_ms: None,
            concurrency: None,
            summary_batch_size: None,
            claude_bin: None,
        })
    }

    /// Returns the claude bridge.
    ///
    /// # Errors
    ///
    /// Returns an error if `tier` is not chat-capable or `model` violates its
    /// non-empty, byte-length, or control-character contract.
    pub fn claude_bridge(
        tier: ProjectLlmTier,
        model: impl Into<String>,
    ) -> Result<Self, ProjectLlmConfigError> {
        validate_chat_tier(tier)?;
        let model = model.into();
        validate_model(&model)?;
        Ok(Self {
            tier,
            provider: ProjectLlmProvider::ClaudeBridge,
            endpoint: CLAUDE_BRIDGE_ENDPOINT.to_owned(),
            model,
            ask_model: None,
            credential_intent: ProjectLlmCredentialIntent::Clear,
            timeout_ms: None,
            concurrency: None,
            summary_batch_size: None,
            claude_bin: None,
        })
    }

    /// Returns the anthropic API.
    ///
    /// # Errors
    ///
    /// Returns an error if `tier` is not chat-capable or `model` violates its
    /// non-empty, byte-length, or control-character contract.
    pub fn anthropic_api(
        tier: ProjectLlmTier,
        model: impl Into<String>,
    ) -> Result<Self, ProjectLlmConfigError> {
        validate_chat_tier(tier)?;
        let model = model.into();
        validate_model(&model)?;
        Ok(Self {
            tier,
            provider: ProjectLlmProvider::AnthropicApi,
            endpoint: ANTHROPIC_CLOUD_ENDPOINT.to_owned(),
            model,
            ask_model: None,
            credential_intent: ProjectLlmCredentialIntent::Environment(
                "ANTHROPIC_API_KEY".to_owned(),
            ),
            timeout_ms: None,
            concurrency: None,
            summary_batch_size: None,
            claude_bin: None,
        })
    }

    /// Tier selected by this validated configuration mutation.
    ///
    /// Setup and doctor workflows use this to apply only genuinely missing
    /// tiers without overwriting an operator's existing backend choices.
    #[must_use]
    pub const fn tier(&self) -> ProjectLlmTier {
        self.tier
    }

    /// Sets the API key environment and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error for the credential-free Claude bridge or if the value
    /// is not a valid bounded environment-variable name.
    pub fn with_api_key_env(
        mut self,
        value: impl Into<String>,
    ) -> Result<Self, ProjectLlmConfigError> {
        if self.provider == ProjectLlmProvider::ClaudeBridge {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        let value = value.into();
        validate_env_name(&value)?;
        self.credential_intent = ProjectLlmCredentialIntent::Environment(value);
        Ok(self)
    }

    #[must_use]
    /// Returns a copy with all resolved credential material removed.
    pub fn without_credentials(mut self) -> Self {
        self.credential_intent = ProjectLlmCredentialIntent::Clear;
        self
    }

    /// Sets the timeout milliseconds and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if `timeout_ms` is zero or exceeds the project-tier maximum.
    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Result<Self, ProjectLlmConfigError> {
        if timeout_ms == 0 || timeout_ms > MAXIMUM_TIMEOUT_MS {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        self.timeout_ms = Some(timeout_ms);
        Ok(self)
    }

    /// Sets the concurrency and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if `concurrency` is zero or exceeds the project-tier maximum.
    pub fn with_concurrency(mut self, concurrency: u16) -> Result<Self, ProjectLlmConfigError> {
        if concurrency == 0 || concurrency > MAXIMUM_CONCURRENCY {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        self.concurrency = Some(concurrency);
        Ok(self)
    }

    /// Sets the ask model and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if the tier is not chat-capable or `ask_model` violates
    /// its non-empty, byte-length, or control-character contract.
    pub fn with_ask_model(
        mut self,
        ask_model: impl Into<String>,
    ) -> Result<Self, ProjectLlmConfigError> {
        validate_chat_tier(self.tier)?;
        let ask_model = ask_model.into();
        validate_model(&ask_model)?;
        self.ask_model = Some(ask_model);
        Ok(self)
    }

    /// Sets the summary batch size and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error if the tier is not chat-capable or the batch size is
    /// zero or above the summary batching maximum.
    pub fn with_summary_batch_size(
        mut self,
        summary_batch_size: u16,
    ) -> Result<Self, ProjectLlmConfigError> {
        validate_chat_tier(self.tier)?;
        if summary_batch_size == 0 || summary_batch_size > MAXIMUM_SUMMARY_BATCH_SIZE {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        self.summary_batch_size = Some(summary_batch_size);
        Ok(self)
    }

    /// Sets the claude bin and returns the updated value.
    ///
    /// # Errors
    ///
    /// Returns an error unless the provider is Claude bridge, or if the binary
    /// name/path is empty, oversized, or contains control characters.
    pub fn with_claude_bin(
        mut self,
        claude_bin: impl Into<String>,
    ) -> Result<Self, ProjectLlmConfigError> {
        if self.provider != ProjectLlmProvider::ClaudeBridge {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        let claude_bin = claude_bin.into();
        if claude_bin.is_empty()
            || claude_bin.len() > MAXIMUM_CLAUDE_BINARY_BYTES
            || claude_bin.chars().any(char::is_control)
        {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        self.claude_bin = Some(claude_bin);
        Ok(self)
    }
}

fn validate_chat_tier(tier: ProjectLlmTier) -> Result<(), ProjectLlmConfigError> {
    if matches!(tier, ProjectLlmTier::Embedding | ProjectLlmTier::Reranker) {
        Err(ProjectLlmConfigError::InvalidTier)
    } else {
        Ok(())
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
/// Errors produced while processing project LLM config.
pub enum ProjectLlmConfigError {
    #[error("Cartograph project configuration path is unavailable")]
    /// The requested project could not be opened safely.
    ProjectUnavailable,
    #[error("Cartograph project configuration is too large")]
    /// The host configuration exceeds the safe rewrite byte ceiling.
    ConfigTooLarge,
    #[error("Cartograph project configuration is invalid")]
    /// Configuration is malformed or violates a required bound.
    InvalidConfig,
    #[error("Cartograph project LLM tier is invalid")]
    /// The requested model tier is not valid for this provider.
    InvalidTier,
    #[error("Cartograph project LLM credential environment variable is unavailable")]
    /// The configured credential reference could not be resolved privately.
    CredentialUnavailable,
    #[error("Cartograph project configuration cannot be written safely")]
    /// The bounded output could not be written atomically.
    WriteFailed,
    #[error("Cartograph project configuration changed concurrently")]
    /// The host configuration changed during the atomic rewrite.
    ConcurrentModification,
}

/// Load one tier, retaining v1's ask/classify-to-summarize fallback.
/// # Errors
///
/// Returns an error if the project/config path is unsafe/unreadable/oversized,
/// JSON or the selected/fallback tier is malformed, or credential lookup fails.
pub fn load_project_llm_tier(
    project_root: &Path,
    tier: ProjectLlmTier,
) -> Result<Option<ProjectLlmTierConfig>, ProjectLlmConfigError> {
    load_project_llm_tier_with_fallback(project_root, tier, true)
}

/// Load only the named tier without ask/local/classify fallback. Diagnostics
/// use this to distinguish a deliberate split tier from summarize fallback.
/// # Errors
///
/// Returns an error if the project/config path is unsafe/unreadable/oversized,
/// JSON or the exact tier is malformed, or credential lookup fails.
pub fn load_exact_project_llm_tier(
    project_root: &Path,
    tier: ProjectLlmTier,
) -> Result<Option<ProjectLlmTierConfig>, ProjectLlmConfigError> {
    load_project_llm_tier_with_fallback(project_root, tier, false)
}

/// Read the v1-compatible project-wide source-file ceiling without conflating
/// an absent setting with an invalid configuration file.
/// # Errors
///
/// Returns an error if project source configuration is unsafe, unreadable,
/// oversized, malformed, or contains an out-of-range file-size value.
pub fn load_project_max_file_size(
    project_root: &Path,
) -> Result<Option<usize>, ProjectLlmConfigError> {
    load_project_source_settings(project_root).map(|settings| settings.maximum_file_bytes)
}

/// Read the summary candidate floor and eager budget from the shared v1 config.
/// # Errors
///
/// Returns an error if config access/JSON shape is invalid or summary enable,
/// eager-limit, line-floor, kind-override, or depth settings violate bounds.
pub fn load_project_summary_settings(
    project_root: &Path,
) -> Result<ProjectSummarySettings, ProjectLlmConfigError> {
    let Some(value) = read_config_value(project_root)? else {
        return Ok(default_summary_settings(false));
    };
    let root = value
        .as_object()
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let Some(llm) = root.get("llm") else {
        return Ok(default_summary_settings(false));
    };
    let llm = llm
        .as_object()
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let provider_enabled = optional_config_bool(llm, "enabled")?.unwrap_or(true);
    let enabled = provider_enabled && optional_config_bool(llm, "summarize")?.unwrap_or(true);
    let eager_limit = llm
        .get("summarizeEagerLimit")
        .map(parse_summary_eager_limit)
        .transpose()?
        .unwrap_or(ProjectSummaryEagerLimit::Bounded(
            DEFAULT_SUMMARY_EAGER_LIMIT,
        ));
    let minimum_body_lines = llm
        .get("minBodyLines")
        .map(parse_summary_line_floor)
        .transpose()?
        .unwrap_or(DEFAULT_SUMMARY_MINIMUM_BODY_LINES);
    let mut minimum_body_lines_by_kind = BTreeMap::from([("route".to_owned(), 1)]);
    if let Some(overrides) = llm.get("minBodyLinesByKind") {
        let overrides = overrides
            .as_object()
            .filter(|values| values.len() <= MAXIMUM_SUMMARY_KIND_OVERRIDES)
            .ok_or(ProjectLlmConfigError::InvalidConfig)?;
        for (kind, value) in overrides {
            if kind.is_empty()
                || kind.len() > MAXIMUM_SUMMARY_KIND_BYTES
                || kind.chars().any(char::is_control)
            {
                return Err(ProjectLlmConfigError::InvalidConfig);
            }
            minimum_body_lines_by_kind.insert(kind.clone(), parse_summary_line_floor(value)?);
        }
    }
    Ok(ProjectSummarySettings {
        enabled,
        eager_limit,
        minimum_body_lines,
        minimum_body_lines_by_kind,
    })
}

fn default_summary_settings(enabled: bool) -> ProjectSummarySettings {
    ProjectSummarySettings {
        enabled,
        eager_limit: ProjectSummaryEagerLimit::Bounded(DEFAULT_SUMMARY_EAGER_LIMIT),
        minimum_body_lines: DEFAULT_SUMMARY_MINIMUM_BODY_LINES,
        minimum_body_lines_by_kind: BTreeMap::from([("route".to_owned(), 1)]),
    }
}

fn parse_summary_eager_limit(
    value: &Value,
) -> Result<ProjectSummaryEagerLimit, ProjectLlmConfigError> {
    let value = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    if value < 0.0 {
        return Ok(ProjectSummaryEagerLimit::Uncapped);
    }
    let maximum = MAXIMUM_SUMMARY_EAGER_LIMIT
        .to_f64()
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    if value > maximum {
        return Err(ProjectLlmConfigError::InvalidConfig);
    }
    let bounded = value
        .ceil()
        .to_u64()
        .filter(|bounded| *bounded <= MAXIMUM_SUMMARY_EAGER_LIMIT)
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    Ok(ProjectSummaryEagerLimit::Bounded(bounded))
}

fn parse_summary_line_floor(value: &Value) -> Result<u32, ProjectLlmConfigError> {
    let value = value
        .as_f64()
        .filter(|value| {
            value.is_finite()
                && *value >= 0.0
                && *value <= f64::from(MAXIMUM_SUMMARY_MINIMUM_BODY_LINES)
        })
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    value
        .ceil()
        .to_u32()
        .filter(|bounded| *bounded <= MAXIMUM_SUMMARY_MINIMUM_BODY_LINES)
        .ok_or(ProjectLlmConfigError::InvalidConfig)
}

/// Read bounded v1-compatible source discovery settings without exposing LLM credentials.
/// # Errors
///
/// Returns an error if config access/JSON shape is invalid or file-size,
/// language, include/exclude, nested-repository, or allow-list settings are malformed.
pub fn load_project_source_settings(
    project_root: &Path,
) -> Result<ProjectSourceSettings, ProjectLlmConfigError> {
    let Some(value) = read_config_value(project_root)? else {
        return Ok(ProjectSourceSettings::default());
    };
    let root = value
        .as_object()
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    parse_project_source_settings(root)
}

fn parse_project_source_settings(
    root: &Map<String, Value>,
) -> Result<ProjectSourceSettings, ProjectLlmConfigError> {
    let maximum_file_bytes = optional_bounded_config_u64(
        root,
        "maxFileSize",
        u64::try_from(MAXIMUM_PROJECT_SOURCE_BYTES)
            .map_err(|_| ProjectLlmConfigError::InvalidConfig)?,
    )?
    .map(usize::try_from)
    .transpose()
    .map_err(|_| ProjectLlmConfigError::InvalidConfig)?;
    let maximum_generation_bytes =
        optional_bounded_config_u64(root, "maxGenerationBytes", MAXIMUM_PROJECT_GENERATION_BYTES)?;
    let languages = root
        .get("languages")
        .map(parse_project_languages)
        .transpose()?
        .unwrap_or_default();
    let mut includes = root.get("include").map(parse_project_globs).transpose()?;
    if root
        .get("version")
        .and_then(Value::as_u64)
        .is_some_and(|version| version < 2)
        && let Some(includes) = includes.as_mut()
    {
        for additive in ["**/*.pyi", "**/*.toml"] {
            if !includes.iter().any(|pattern| pattern == additive) {
                includes.push(additive.to_owned());
            }
        }
    }
    let excludes = root
        .get("exclude")
        .map(parse_project_excludes)
        .transpose()?
        .unwrap_or_default();
    let extract_docstrings = optional_config_bool(root, "extractDocstrings")?.unwrap_or(true);
    let track_call_sites = optional_config_bool(root, "trackCallSites")?.unwrap_or(true);
    let index_submodules = optional_config_bool(root, "indexSubmodules")?.unwrap_or(true);
    let index_embedded_repositories =
        optional_config_bool(root, "indexEmbeddedRepos")?.unwrap_or(true) && index_submodules;
    let enable_centrality = optional_config_bool(root, "enableCentrality")?.unwrap_or(true);
    // v2 enables its bounded native implementation by default. The legacy
    // `false` override remains authoritative for projects that prefer the
    // indexing-cost tradeoff from v1.
    let enable_betweenness = optional_config_bool(root, "enableBetweenness")?.unwrap_or(true);
    let enable_churn = optional_config_bool(root, "enableChurn")?.unwrap_or(true);
    let enable_co_change = optional_config_bool(root, "enableCoChange")?.unwrap_or(true);
    let enable_biomarkers = optional_config_bool(root, "enableBiomarkers")?.unwrap_or(true);
    let enable_issue_history = optional_config_bool(root, "enableIssueHistory")?.unwrap_or(true);
    let enable_config_refs = optional_config_bool(root, "enableConfigRefs")?.unwrap_or(true);
    let enable_sql_refs = optional_config_bool(root, "enableSqlRefs")?.unwrap_or(true);
    let enable_build_context_refs =
        optional_config_bool(root, "enableBuildContextRefs")?.unwrap_or(true);
    let enable_string_imports = optional_config_bool(root, "enableStringImports")?.unwrap_or(true);
    let duplicate_code_partial_clones =
        optional_config_bool(root, "duplicateCodePartialClones")?.unwrap_or(false);
    let duplicate_code_allowlist = root
        .get("duplicateCodeAllowlist")
        .map(parse_project_globs)
        .transpose()?
        .unwrap_or_default();
    let mut features = SourceFeatureFlags::default();
    for (feature, enabled) in [
        (SourceFeature::ExtractDocstrings, extract_docstrings),
        (SourceFeature::TrackCallSites, track_call_sites),
        (SourceFeature::IndexSubmodules, index_submodules),
        (
            SourceFeature::IndexEmbeddedRepositories,
            index_embedded_repositories,
        ),
        (SourceFeature::Centrality, enable_centrality),
        (SourceFeature::Betweenness, enable_betweenness),
        (SourceFeature::Churn, enable_churn),
        (SourceFeature::CoChange, enable_co_change),
        (SourceFeature::Biomarkers, enable_biomarkers),
        (SourceFeature::IssueHistory, enable_issue_history),
        (SourceFeature::ConfigReferences, enable_config_refs),
        (SourceFeature::SqlReferences, enable_sql_refs),
        (
            SourceFeature::BuildContextReferences,
            enable_build_context_refs,
        ),
        (SourceFeature::StringImports, enable_string_imports),
        (
            SourceFeature::DuplicateCodePartialClones,
            duplicate_code_partial_clones,
        ),
    ] {
        features.set(feature, enabled);
    }
    Ok(ProjectSourceSettings {
        maximum_file_bytes,
        maximum_generation_bytes,
        languages,
        includes,
        excludes,
        features,
        duplicate_code_allowlist,
    })
}

fn optional_bounded_config_u64(
    root: &Map<String, Value>,
    key: &str,
    maximum: u64,
) -> Result<Option<u64>, ProjectLlmConfigError> {
    root.get(key)
        .map(|value| {
            value
                .as_u64()
                .filter(|value| (1..=maximum).contains(value))
                .ok_or(ProjectLlmConfigError::InvalidConfig)
        })
        .transpose()
}

fn parse_project_languages(value: &Value) -> Result<Vec<SourceLanguage>, ProjectLlmConfigError> {
    let values = value
        .as_array()
        .filter(|values| values.len() <= SourceLanguage::ALL.len())
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let mut languages = Vec::new();
    languages
        .try_reserve_exact(values.len())
        .map_err(|_| ProjectLlmConfigError::InvalidConfig)?;
    for value in values {
        let language = value
            .as_str()
            .and_then(SourceLanguage::from_stable_str)
            .ok_or(ProjectLlmConfigError::InvalidConfig)?;
        if !languages.contains(&language) {
            languages.push(language);
        }
    }
    languages.sort_unstable();
    Ok(languages)
}

fn parse_project_excludes(value: &Value) -> Result<Vec<String>, ProjectLlmConfigError> {
    parse_project_globs(value)
}

fn parse_project_globs(value: &Value) -> Result<Vec<String>, ProjectLlmConfigError> {
    let values = value
        .as_array()
        .filter(|values| values.len() <= MAXIMUM_PROJECT_EXCLUDES)
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let mut excludes = Vec::new();
    excludes
        .try_reserve_exact(values.len())
        .map_err(|_| ProjectLlmConfigError::InvalidConfig)?;
    for value in values {
        let pattern = value
            .as_str()
            .filter(|pattern| {
                !pattern.is_empty()
                    && pattern.len() <= MAXIMUM_PROJECT_EXCLUDE_BYTES
                    && !pattern.contains('\0')
            })
            .ok_or(ProjectLlmConfigError::InvalidConfig)?;
        excludes.push(pattern.to_owned());
    }
    Ok(excludes)
}

fn optional_config_bool(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<bool>, ProjectLlmConfigError> {
    object
        .get(key)
        .map(|value| value.as_bool().ok_or(ProjectLlmConfigError::InvalidConfig))
        .transpose()
}

/// Atomically preserve the rest of `.cartograph/config.json` while updating
/// the v1-compatible project-wide source-file ceiling.
/// # Errors
///
/// Returns an error if `max_file_size` is out of range, existing config is
/// unsafe/malformed/oversized, or the private atomic rewrite cannot complete.
pub fn write_project_max_file_size(
    project_root: &Path,
    max_file_size: usize,
) -> Result<(), ProjectLlmConfigError> {
    if !(1..=MAXIMUM_PROJECT_SOURCE_BYTES).contains(&max_file_size) {
        return Err(ProjectLlmConfigError::InvalidConfig);
    }
    update_config_value(project_root, |current| {
        let mut value = current.unwrap_or_else(|| json!({"version": 2}));
        let root = value
            .as_object_mut()
            .ok_or(ProjectLlmConfigError::InvalidConfig)?;
        root.insert("maxFileSize".to_owned(), Value::from(max_file_size));
        Ok((value, ()))
    })
}

fn load_project_llm_tier_with_fallback(
    project_root: &Path,
    tier: ProjectLlmTier,
    allow_fallback: bool,
) -> Result<Option<ProjectLlmTierConfig>, ProjectLlmConfigError> {
    let Some(value) = read_config_value(project_root)? else {
        return Ok(None);
    };
    let llm = value
        .as_object()
        .and_then(|root| root.get("llm"))
        .and_then(Value::as_object);
    let Some(llm) = llm else {
        return Ok(None);
    };
    if llm.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Ok(None);
    }
    let exact = llm.get(tier.config_key()).filter(|value| !value.is_null());
    let selected = exact.map(|value| (value, tier, false)).or_else(|| {
        if !allow_fallback {
            return None;
        }
        tier.fallback().and_then(|fallback| {
            llm.get(fallback.config_key())
                .filter(|value| !value.is_null())
                .map(|value| (value, fallback, true))
        })
    });
    selected
        .map(|(value, configured_tier, fallback)| {
            parse_tier(
                value,
                TierResolution {
                    configured: configured_tier,
                    requested: tier,
                    fallback,
                },
            )
        })
        .transpose()
}

/// Atomically update one or more tier blocks while preserving non-LLM config.
/// # Errors
///
/// Returns an error if tier mutations are invalid/empty, existing config is
/// unsafe/malformed/oversized, or the locked private atomic rewrite fails.
pub fn write_project_llm_tiers(
    project_root: &Path,
    inputs: &[ProjectLlmTierInput],
) -> Result<(), ProjectLlmConfigError> {
    write_project_llm_configuration(project_root, inputs, &[])
}

/// Replace legacy inline credentials with named environment references only
/// when the current process proves that the selected environment variable
/// contains the exact same secret. The update is one atomic config write and
/// reports no secret material.
/// # Errors
///
/// Returns an error if overrides/config are invalid, an environment value is
/// absent or differs from the inline secret, or guarded atomic rewrite detects a race.
pub fn migrate_project_inline_credentials(
    project_root: &Path,
    environment_overrides: &[(ProjectLlmTier, String)],
    apply: bool,
) -> Result<ProjectCredentialMigrationReport, ProjectLlmConfigError> {
    migrate_project_inline_credentials_with(CredentialMigrationRequest {
        project_root,
        environment_overrides,
        apply,
        resolve: |name: &str| env::var(name).ok(),
    })
}

struct CredentialMigrationRequest<'a, Resolve> {
    project_root: &'a Path,
    environment_overrides: &'a [(ProjectLlmTier, String)],
    apply: bool,
    resolve: Resolve,
}

struct CredentialMigrationState<Resolve> {
    overrides: BTreeMap<ProjectLlmTier, String>,
    apply: bool,
    resolve: Resolve,
    candidates: Vec<ProjectCredentialMigrationEntry>,
    migrated: usize,
}

impl<Resolve> CredentialMigrationState<Resolve>
where
    Resolve: FnMut(&str) -> Option<String>,
{
    fn new(
        environment_overrides: &[(ProjectLlmTier, String)],
        apply: bool,
        resolve: Resolve,
    ) -> Result<Self, ProjectLlmConfigError> {
        let mut overrides = BTreeMap::new();
        for (tier, name) in environment_overrides {
            validate_env_name(name)?;
            if overrides.insert(*tier, name.clone()).is_some() {
                return Err(ProjectLlmConfigError::InvalidTier);
            }
        }
        Ok(Self {
            overrides,
            apply,
            resolve,
            candidates: Vec::new(),
            migrated: 0,
        })
    }

    fn migrate_tier(
        &mut self,
        llm: &mut Map<String, Value>,
        tier: ProjectLlmTier,
    ) -> Result<(), ProjectLlmConfigError> {
        let Some(value) = llm.get_mut(tier.config_key()) else {
            return Ok(());
        };
        if value.is_null() {
            return Ok(());
        }
        let object = value
            .as_object_mut()
            .ok_or(ProjectLlmConfigError::InvalidTier)?;
        let Some(inline) = optional_string_value(object, "apiKey")? else {
            return Ok(());
        };
        validate_api_key(inline)?;
        if object.contains_key("apiKeyEnv") {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        let provider = object
            .get("provider")
            .and_then(Value::as_str)
            .and_then(ProjectLlmProvider::parse)
            .ok_or(ProjectLlmConfigError::InvalidTier)?;
        let environment = self
            .overrides
            .get(&tier)
            .cloned()
            .or_else(|| match provider {
                ProjectLlmProvider::OpenAiCompat => Some("OPENAI_API_KEY".to_owned()),
                ProjectLlmProvider::AnthropicApi => Some("ANTHROPIC_API_KEY".to_owned()),
                ProjectLlmProvider::ClaudeBridge => None,
            });
        let status = match environment.as_deref() {
            None => ProjectCredentialMigrationStatus::UnsupportedProvider,
            Some(name) => match (self.resolve)(name) {
                None => ProjectCredentialMigrationStatus::EnvironmentMissing,
                Some(value) if value != inline => {
                    ProjectCredentialMigrationStatus::EnvironmentMismatch
                }
                Some(_) if self.apply => {
                    object.remove("apiKey");
                    object.insert("apiKeyEnv".to_owned(), Value::String(name.to_owned()));
                    self.migrated = self.migrated.saturating_add(1);
                    ProjectCredentialMigrationStatus::Migrated
                }
                Some(_) => ProjectCredentialMigrationStatus::Ready,
            },
        };
        self.candidates.push(ProjectCredentialMigrationEntry {
            tier,
            environment,
            status,
        });
        Ok(())
    }

    fn report(self) -> ProjectCredentialMigrationReport {
        let remaining_inline = self.candidates.len().saturating_sub(self.migrated);
        ProjectCredentialMigrationReport {
            dry_run: !self.apply,
            candidates: self.candidates,
            migrated: self.migrated,
            remaining_inline,
        }
    }
}

fn migrate_project_inline_credentials_with<Resolve>(
    request: CredentialMigrationRequest<'_, Resolve>,
) -> Result<ProjectCredentialMigrationReport, ProjectLlmConfigError>
where
    Resolve: FnMut(&str) -> Option<String>,
{
    migrate_project_inline_credentials_with_observer(request, || {})
}

fn migrate_project_inline_credentials_with_observer<Resolve, Observe>(
    request: CredentialMigrationRequest<'_, Resolve>,
    observe_before_write: Observe,
) -> Result<ProjectCredentialMigrationReport, ProjectLlmConfigError>
where
    Resolve: FnMut(&str) -> Option<String>,
    Observe: FnOnce(),
{
    let mut state = CredentialMigrationState::new(
        request.environment_overrides,
        request.apply,
        request.resolve,
    )?;
    let Some(snapshot) = read_config_snapshot(request.project_root)? else {
        return Ok(state.report());
    };
    let mut config = snapshot.value;
    let root = config
        .as_object_mut()
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let Some(llm) = root.get_mut("llm").and_then(Value::as_object_mut) else {
        return Ok(state.report());
    };
    for tier in credential_migration_tiers() {
        state.migrate_tier(llm, tier)?;
    }
    if state.apply && state.migrated > 0 {
        observe_before_write();
        write_config_value_if_unchanged(request.project_root, &config, &snapshot.bytes)?;
    }
    Ok(state.report())
}

const fn credential_migration_tiers() -> [ProjectLlmTier; 6] {
    [
        ProjectLlmTier::Embedding,
        ProjectLlmTier::Summarize,
        ProjectLlmTier::Local,
        ProjectLlmTier::Ask,
        ProjectLlmTier::Classify,
        ProjectLlmTier::Reranker,
    ]
}

/// Atomically update configured tiers and explicitly disable incompatible ones.
/// # Errors
///
/// Returns an error if no mutation is requested, tier sets/config objects are
/// invalid, or the private locked size-bounded atomic rewrite fails.
pub fn write_project_llm_configuration(
    project_root: &Path,
    inputs: &[ProjectLlmTierInput],
    cleared: &[ProjectLlmTier],
) -> Result<(), ProjectLlmConfigError> {
    write_project_llm_configuration_with_report(project_root, inputs, cleared).map(|_| ())
}

/// Atomically update configured tiers and return secret-free credential actions.
/// # Errors
///
/// Returns an error if no mutation is requested, tier sets/config objects are
/// invalid, or the private locked size-bounded atomic rewrite fails.
pub fn write_project_llm_configuration_with_report(
    project_root: &Path,
    inputs: &[ProjectLlmTierInput],
    cleared: &[ProjectLlmTier],
) -> Result<ProjectLlmWriteReport, ProjectLlmConfigError> {
    if inputs.is_empty() && cleared.is_empty() {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    update_config_value(project_root, |current| {
        let mut value = current.unwrap_or_else(|| json!({"version": 2}));
        let root = value
            .as_object_mut()
            .ok_or(ProjectLlmConfigError::InvalidConfig)?;
        let llm = object_field(root, "llm")?;
        llm.insert("enabled".to_owned(), Value::Bool(true));
        let mut credential_actions = Vec::with_capacity(inputs.len());
        for input in inputs {
            credential_actions.push(update_project_llm_tier(llm, input)?);
        }
        for tier in cleared {
            llm.insert(tier.config_key().to_owned(), Value::Null);
        }
        Ok((value, ProjectLlmWriteReport { credential_actions }))
    })
}

fn update_project_llm_tier(
    llm: &mut Map<String, Value>,
    input: &ProjectLlmTierInput,
) -> Result<ProjectLlmCredentialWriteEntry, ProjectLlmConfigError> {
    let tier = object_field(llm, input.tier.config_key())?;
    let action = apply_credential_intent(tier, input);
    tier.insert(
        "provider".to_owned(),
        Value::String(input.provider.as_str().to_owned()),
    );
    if input.provider == ProjectLlmProvider::ClaudeBridge {
        tier.remove("endpoint");
    } else {
        tier.insert("endpoint".to_owned(), Value::String(input.endpoint.clone()));
    }
    tier.insert("model".to_owned(), Value::String(input.model.clone()));
    if let Some(ask_model) = &input.ask_model {
        tier.insert("askModel".to_owned(), Value::String(ask_model.clone()));
    }
    if let Some(timeout_ms) = input.timeout_ms {
        tier.insert("timeoutMs".to_owned(), Value::from(timeout_ms));
    }
    if let Some(concurrency) = input.concurrency {
        tier.insert("concurrency".to_owned(), Value::from(concurrency));
    }
    if let Some(summary_batch_size) = input.summary_batch_size {
        tier.insert(
            "summaryBatchSize".to_owned(),
            Value::from(summary_batch_size),
        );
    }
    if let Some(claude_bin) = &input.claude_bin {
        tier.insert("claudeBin".to_owned(), Value::String(claude_bin.clone()));
    } else if input.provider != ProjectLlmProvider::ClaudeBridge {
        tier.remove("claudeBin");
    }
    Ok(ProjectLlmCredentialWriteEntry {
        tier: input.tier,
        action,
    })
}

fn apply_credential_intent(
    tier: &mut Map<String, Value>,
    input: &ProjectLlmTierInput,
) -> ProjectLlmCredentialWriteAction {
    let had_credentials = tier.contains_key("apiKey") || tier.contains_key("apiKeyEnv");
    match &input.credential_intent {
        ProjectLlmCredentialIntent::Clear => {
            tier.remove("apiKey");
            tier.remove("apiKeyEnv");
            ProjectLlmCredentialWriteAction::ClearedExplicitly
        }
        ProjectLlmCredentialIntent::Environment(environment) => {
            tier.remove("apiKey");
            tier.insert("apiKeyEnv".to_owned(), Value::String(environment.clone()));
            ProjectLlmCredentialWriteAction::EnvironmentReferenceSet
        }
        ProjectLlmCredentialIntent::Preserve
            if had_credentials && credential_origin_changed(tier, input) =>
        {
            tier.remove("apiKey");
            tier.remove("apiKeyEnv");
            ProjectLlmCredentialWriteAction::ClearedOriginChange
        }
        ProjectLlmCredentialIntent::Preserve if had_credentials => {
            ProjectLlmCredentialWriteAction::Preserved
        }
        ProjectLlmCredentialIntent::Preserve => ProjectLlmCredentialWriteAction::Unchanged,
    }
}

fn credential_origin_changed(configured: &Map<String, Value>, input: &ProjectLlmTierInput) -> bool {
    configured_credential_origin(configured)
        .zip(credential_origin(input.provider, &input.endpoint))
        .is_none_or(|(configured, requested)| configured != requested)
}

fn configured_credential_origin(
    configured: &Map<String, Value>,
) -> Option<(ProjectLlmProvider, String)> {
    let provider = configured
        .get("provider")
        .and_then(Value::as_str)
        .and_then(ProjectLlmProvider::parse)?;
    let endpoint = match provider {
        ProjectLlmProvider::OpenAiCompat => configured
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or(OPENAI_CLOUD_ENDPOINT),
        ProjectLlmProvider::AnthropicApi => configured
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or(ANTHROPIC_CLOUD_ENDPOINT),
        ProjectLlmProvider::ClaudeBridge => CLAUDE_BRIDGE_ENDPOINT,
    };
    credential_origin(provider, endpoint)
}

fn credential_origin(
    provider: ProjectLlmProvider,
    endpoint: &str,
) -> Option<(ProjectLlmProvider, String)> {
    if provider == ProjectLlmProvider::ClaudeBridge {
        return Some((provider, CLAUDE_BRIDGE_ENDPOINT.to_owned()));
    }
    let endpoint = Url::parse(endpoint).ok()?;
    let host = endpoint
        .host_str()?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let port = endpoint.port_or_known_default()?;
    Some((
        provider,
        format!("{}://{host}:{port}", endpoint.scheme().to_ascii_lowercase()),
    ))
}

/// Change only one configured tier's bounded client concurrency.
/// # Errors
///
/// Returns an error if `concurrency` is out of range, the exact configured tier
/// is missing/malformed, or the private atomic rewrite fails.
pub fn tune_project_llm_tier(
    project_root: &Path,
    tier: ProjectLlmTier,
    concurrency: u16,
) -> Result<(), ProjectLlmConfigError> {
    if concurrency == 0 || concurrency > MAXIMUM_CONCURRENCY {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    update_config_value(project_root, |current| {
        let mut value = current.ok_or(ProjectLlmConfigError::InvalidConfig)?;
        let root = value
            .as_object_mut()
            .ok_or(ProjectLlmConfigError::InvalidConfig)?;
        let llm = root
            .get_mut("llm")
            .and_then(Value::as_object_mut)
            .ok_or(ProjectLlmConfigError::InvalidConfig)?;
        let tier = llm
            .get_mut(tier.config_key())
            .and_then(Value::as_object_mut)
            .ok_or(ProjectLlmConfigError::InvalidTier)?;
        tier.insert("concurrency".to_owned(), Value::from(concurrency));
        Ok((value, ()))
    })
}

/// Probe a validated endpoint without credentials, redirects, or unbounded reads.
/// # Errors
///
/// Returns an error if endpoint/timeout validation fails, no TLS provider can
/// be installed, or the redirect-free bounded HTTP client cannot be built.
pub async fn probe_openai_compatible_endpoint(
    endpoint: &str,
    timeout: std::time::Duration,
) -> Result<LlmEndpointProbe, ProjectLlmConfigError> {
    validate_endpoint(endpoint)?;
    if timeout.is_zero() || timeout > std::time::Duration::from_secs(10) {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    crate::ensure_tls_crypto_provider().map_err(|_| ProjectLlmConfigError::InvalidTier)?;
    let mut models_url = Url::parse(endpoint).map_err(|_| ProjectLlmConfigError::InvalidTier)?;
    let path = models_url.path().trim_end_matches('/');
    let base = ["/v1/chat/completions", "/v1/embeddings", "/v1/rerank"]
        .iter()
        .find_map(|suffix| path.strip_suffix(suffix))
        .unwrap_or(path);
    models_url.set_path(&format!("{base}/v1/models"));
    let client = reqwest::Client::builder()
        .connect_timeout(timeout)
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ProjectLlmConfigError::InvalidTier)?;
    let Ok(response) = client.get(models_url).send().await else {
        return Ok(unreachable_probe());
    };
    if response.status() != StatusCode::OK {
        return Ok(reachable_incompatible_probe());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAXIMUM_PROBE_BYTES as u64)
    {
        return Ok(reachable_incompatible_probe());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return Ok(reachable_incompatible_probe());
        };
        if bytes.len().saturating_add(chunk.len()) > MAXIMUM_PROBE_BYTES {
            return Ok(reachable_incompatible_probe());
        }
        bytes.extend_from_slice(&chunk);
    }
    let Some(data) = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| value.get("data").and_then(Value::as_array).cloned())
    else {
        return Ok(reachable_incompatible_probe());
    };
    let mut models = data
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .filter(|model| {
            !model.is_empty()
                && model.len() <= MAXIMUM_MODEL_BYTES
                && !model.chars().any(char::is_control)
        })
        .take(MAXIMUM_PROBE_MODELS)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    Ok(LlmEndpointProbe {
        reachable: true,
        openai_compatible: true,
        models,
    })
}

const fn unreachable_probe() -> LlmEndpointProbe {
    LlmEndpointProbe {
        reachable: false,
        openai_compatible: false,
        models: Vec::new(),
    }
}

const fn reachable_incompatible_probe() -> LlmEndpointProbe {
    LlmEndpointProbe {
        reachable: true,
        openai_compatible: false,
        models: Vec::new(),
    }
}

#[derive(Clone, Copy)]
struct TierResolution {
    configured: ProjectLlmTier,
    requested: ProjectLlmTier,
    fallback: bool,
}

fn parse_tier(
    value: &Value,
    resolution: TierResolution,
) -> Result<ProjectLlmTierConfig, ProjectLlmConfigError> {
    let value = value
        .as_object()
        .ok_or(ProjectLlmConfigError::InvalidTier)?;
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .and_then(ProjectLlmProvider::parse)
        .ok_or(ProjectLlmConfigError::InvalidTier)?;
    let chat_tier = !matches!(
        resolution.configured,
        ProjectLlmTier::Embedding | ProjectLlmTier::Reranker
    );
    if !chat_tier && provider != ProjectLlmProvider::OpenAiCompat {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    let endpoint = project_tier_endpoint(value, provider)?;
    let model = project_tier_model(value, provider, resolution)?;
    let ask_model = optional_model(value, "askModel")?;
    validate_model(&model)?;
    let credentials = parse_tier_credentials(value, provider)?;
    let limits = parse_tier_runtime_limits(value)?;
    let claude_bin = parse_claude_bin(value, provider)?;
    let llama_server_args = parse_llama_server_args(value)?;
    let externally_managed = optional_bool(value, "externallyManaged")?.unwrap_or(false);
    Ok(ProjectLlmTierConfig {
        provider,
        endpoint,
        model,
        ask_model,
        api_key: credentials.api_key,
        credential_source: credentials.source,
        timeout_ms: limits.timeout_ms,
        concurrency: limits.concurrency,
        summary_batch_size: limits.summary_batch_size,
        claude_bin,
        llama_server_args,
        externally_managed,
    })
}

struct TierCredentials {
    api_key: Option<SecretString>,
    source: ProjectLlmCredentialSource,
}

#[derive(Clone, Copy)]
struct CredentialResolution<'input> {
    value: &'input Map<String, Value>,
    explicit_api_key_env: Option<&'input str>,
    inline: Option<&'input str>,
    api_key_env: Option<&'input str>,
    missing_default_env_permitted: bool,
}

fn parse_tier_credentials(
    value: &Map<String, Value>,
    provider: ProjectLlmProvider,
) -> Result<TierCredentials, ProjectLlmConfigError> {
    let explicit_api_key_env = optional_string_value(value, "apiKeyEnv")?;
    let inline = optional_string_value(value, "apiKey")?;
    let api_key_env = explicit_api_key_env
        .or_else(|| (provider == ProjectLlmProvider::AnthropicApi).then_some("ANTHROPIC_API_KEY"))
        .or_else(|| {
            (provider == ProjectLlmProvider::OpenAiCompat && value.get("endpoint").is_none())
                .then_some("OPENAI_API_KEY")
        });
    if explicit_api_key_env.is_some() && inline.is_some() {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    if provider == ProjectLlmProvider::ClaudeBridge {
        if inline.is_some() || explicit_api_key_env.is_some() {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        return Ok(TierCredentials {
            api_key: None,
            source: ProjectLlmCredentialSource::None,
        });
    }
    resolve_tier_credentials(CredentialResolution {
        value,
        explicit_api_key_env,
        inline,
        api_key_env,
        missing_default_env_permitted: provider == ProjectLlmProvider::OpenAiCompat,
    })
}

fn optional_string_value<'input>(
    value: &'input Map<String, Value>,
    key: &str,
) -> Result<Option<&'input str>, ProjectLlmConfigError> {
    match value.get(key) {
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(ProjectLlmConfigError::InvalidTier),
        None => Ok(None),
    }
}

fn resolve_tier_credentials(
    resolution: CredentialResolution<'_>,
) -> Result<TierCredentials, ProjectLlmConfigError> {
    let (api_key, source) = if let Some(key) = resolution.inline {
        validate_api_key(key)?;
        (
            Some(SecretString::from(key.to_owned())),
            ProjectLlmCredentialSource::InlineLegacy,
        )
    } else if let Some(name) = resolution.api_key_env {
        validate_env_name(name)?;
        match env::var(name) {
            Ok(key) => {
                validate_api_key(&key)?;
                (
                    Some(SecretString::from(key)),
                    ProjectLlmCredentialSource::Environment,
                )
            }
            Err(env::VarError::NotPresent)
                if resolution.explicit_api_key_env.is_none()
                    && resolution.value.get("endpoint").is_some()
                    && resolution.missing_default_env_permitted =>
            {
                (None, ProjectLlmCredentialSource::None)
            }
            Err(_) => return Err(ProjectLlmConfigError::CredentialUnavailable),
        }
    } else {
        (None, ProjectLlmCredentialSource::None)
    };
    Ok(TierCredentials { api_key, source })
}

struct TierRuntimeLimits {
    timeout_ms: Option<u64>,
    concurrency: Option<u16>,
    summary_batch_size: Option<u16>,
}

fn parse_tier_runtime_limits(
    value: &Map<String, Value>,
) -> Result<TierRuntimeLimits, ProjectLlmConfigError> {
    let timeout_ms = optional_bounded_u64(value, "timeoutMs", MAXIMUM_TIMEOUT_MS)?;
    let concurrency = optional_bounded_u64(value, "concurrency", u64::from(MAXIMUM_CONCURRENCY))?
        .map(|value| u16::try_from(value).map_err(|_| ProjectLlmConfigError::InvalidTier))
        .transpose()?;
    let summary_batch_size = optional_bounded_u64(
        value,
        "summaryBatchSize",
        u64::from(MAXIMUM_SUMMARY_BATCH_SIZE),
    )?
    .map(|value| u16::try_from(value).map_err(|_| ProjectLlmConfigError::InvalidTier))
    .transpose()?;
    Ok(TierRuntimeLimits {
        timeout_ms,
        concurrency,
        summary_batch_size,
    })
}

fn project_tier_endpoint(
    object: &Map<String, Value>,
    provider: ProjectLlmProvider,
) -> Result<String, ProjectLlmConfigError> {
    let configured = match object.get("endpoint") {
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err(ProjectLlmConfigError::InvalidTier),
        None => None,
    };
    let endpoint = match provider {
        ProjectLlmProvider::OpenAiCompat => configured.unwrap_or(OPENAI_CLOUD_ENDPOINT),
        ProjectLlmProvider::AnthropicApi => configured.unwrap_or(ANTHROPIC_CLOUD_ENDPOINT),
        ProjectLlmProvider::ClaudeBridge => {
            if configured.is_some() {
                return Err(ProjectLlmConfigError::InvalidTier);
            }
            return Ok(CLAUDE_BRIDGE_ENDPOINT.to_owned());
        }
    };
    validate_endpoint(endpoint)?;
    Ok(endpoint.to_owned())
}

fn project_tier_model(
    object: &Map<String, Value>,
    provider: ProjectLlmProvider,
    resolution: TierResolution,
) -> Result<String, ProjectLlmConfigError> {
    if resolution.fallback && resolution.requested == ProjectLlmTier::Ask {
        if let Some(model) = optional_model(object, "askModel")? {
            return Ok(model);
        }
        if matches!(
            provider,
            ProjectLlmProvider::ClaudeBridge | ProjectLlmProvider::AnthropicApi
        ) {
            return Ok(DEFAULT_CLAUDE_ASK_MODEL.to_owned());
        }
    }
    if let Some(model) = optional_model(object, "model")? {
        return Ok(model);
    }
    match provider {
        ProjectLlmProvider::OpenAiCompat => Err(ProjectLlmConfigError::InvalidTier),
        ProjectLlmProvider::ClaudeBridge | ProjectLlmProvider::AnthropicApi => {
            let model = if resolution.configured == ProjectLlmTier::Summarize {
                DEFAULT_CLAUDE_SUMMARIZE_MODEL
            } else {
                DEFAULT_CLAUDE_ASK_MODEL
            };
            Ok(model.to_owned())
        }
    }
}

fn optional_model(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, ProjectLlmConfigError> {
    object
        .get(key)
        .map(|value| {
            let model = value.as_str().ok_or(ProjectLlmConfigError::InvalidTier)?;
            validate_model(model)?;
            Ok(model.to_owned())
        })
        .transpose()
}

fn parse_claude_bin(
    object: &Map<String, Value>,
    provider: ProjectLlmProvider,
) -> Result<Option<String>, ProjectLlmConfigError> {
    let configured = object
        .get("claudeBin")
        .map(|value| {
            value
                .as_str()
                .filter(|value| {
                    !value.is_empty()
                        && value.len() <= MAXIMUM_CLAUDE_BINARY_BYTES
                        && !value.chars().any(char::is_control)
                })
                .map(str::to_owned)
                .ok_or(ProjectLlmConfigError::InvalidTier)
        })
        .transpose()?;
    if provider == ProjectLlmProvider::ClaudeBridge {
        Ok(configured)
    } else {
        Ok(None)
    }
}

fn parse_llama_server_args(
    object: &Map<String, Value>,
) -> Result<Vec<String>, ProjectLlmConfigError> {
    let Some(value) = object.get("llamaServerArgs") else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .filter(|values| values.len() <= MAXIMUM_LLAMA_SERVER_ARGUMENTS)
        .ok_or(ProjectLlmConfigError::InvalidTier)?;
    let mut total = 0_usize;
    let mut arguments = Vec::with_capacity(values.len());
    for value in values {
        let argument = value
            .as_str()
            .filter(|argument| {
                !argument.is_empty()
                    && argument.len() <= MAXIMUM_LLAMA_SERVER_ARGUMENT_BYTES
                    && !argument.chars().any(char::is_control)
            })
            .ok_or(ProjectLlmConfigError::InvalidTier)?;
        total = total
            .checked_add(argument.len())
            .filter(|total| *total <= MAXIMUM_LLAMA_SERVER_ARGUMENT_TOTAL_BYTES)
            .ok_or(ProjectLlmConfigError::InvalidTier)?;
        arguments.push(argument.to_owned());
    }
    Ok(arguments)
}

fn optional_bool(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<bool>, ProjectLlmConfigError> {
    object
        .get(key)
        .map(|value| value.as_bool().ok_or(ProjectLlmConfigError::InvalidTier))
        .transpose()
}

fn optional_bounded_u64(
    object: &Map<String, Value>,
    key: &str,
    maximum: u64,
) -> Result<Option<u64>, ProjectLlmConfigError> {
    object
        .get(key)
        .map(|value| {
            value
                .as_u64()
                .filter(|value| (1..=maximum).contains(value))
                .ok_or(ProjectLlmConfigError::InvalidTier)
        })
        .transpose()
}

fn validate_endpoint(raw: &str) -> Result<(), ProjectLlmConfigError> {
    crate::endpoint::validate_endpoint(raw).map_err(|()| ProjectLlmConfigError::InvalidTier)
}

fn validate_model(value: &str) -> Result<(), ProjectLlmConfigError> {
    if value.trim().is_empty()
        || value.len() > MAXIMUM_MODEL_BYTES
        || value.chars().any(char::is_control)
    {
        Err(ProjectLlmConfigError::InvalidTier)
    } else {
        Ok(())
    }
}

fn validate_api_key(value: &str) -> Result<(), ProjectLlmConfigError> {
    if value.is_empty()
        || value.len() > MAXIMUM_API_KEY_BYTES
        || value.chars().any(char::is_control)
    {
        Err(ProjectLlmConfigError::InvalidTier)
    } else {
        Ok(())
    }
}

fn validate_env_name(value: &str) -> Result<(), ProjectLlmConfigError> {
    let mut bytes = value.bytes();
    let first = bytes
        .next()
        .is_some_and(|byte| byte == b'_' || byte.is_ascii_uppercase());
    if value.len() > 128
        || !first
        || !bytes.all(|byte| byte == b'_' || byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        Err(ProjectLlmConfigError::InvalidTier)
    } else {
        Ok(())
    }
}

fn object_field<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, ProjectLlmConfigError> {
    if !parent.contains_key(key) || parent.get(key).is_some_and(Value::is_null) {
        parent.insert(key.to_owned(), Value::Object(Map::new()));
    }
    parent
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .ok_or(ProjectLlmConfigError::InvalidConfig)
}

struct ConfigSnapshot {
    value: Value,
    bytes: Vec<u8>,
}

struct ConfigWriteLock {
    file: File,
}

impl Drop for ConfigWriteLock {
    fn drop(&mut self) {
        let _ = File::unlock(&self.file);
    }
}

struct ConfigWriteTarget {
    directory: PathBuf,
    path: PathBuf,
    _lock: ConfigWriteLock,
}

fn read_config_value(project_root: &Path) -> Result<Option<Value>, ProjectLlmConfigError> {
    read_config_snapshot(project_root).map(|snapshot| snapshot.map(|snapshot| snapshot.value))
}

fn read_config_snapshot(
    project_root: &Path,
) -> Result<Option<ConfigSnapshot>, ProjectLlmConfigError> {
    let path = config_path(project_root)?;
    let Some(bytes) = read_config_bytes(&path)? else {
        return Ok(None);
    };
    let value = serde_json::from_slice(&bytes).map_err(|_| ProjectLlmConfigError::InvalidConfig)?;
    Ok(Some(ConfigSnapshot { value, bytes }))
}

fn read_config_bytes(path: &Path) -> Result<Option<Vec<u8>>, ProjectLlmConfigError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ProjectLlmConfigError::ProjectUnavailable),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(ProjectLlmConfigError::ProjectUnavailable);
    }
    if metadata.len() > MAXIMUM_CONFIG_BYTES {
        return Err(ProjectLlmConfigError::ConfigTooLarge);
    }
    let file = File::open(path).map_err(|_| ProjectLlmConfigError::ProjectUnavailable)?;
    let mut bytes = Vec::new();
    file.take(MAXIMUM_CONFIG_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| ProjectLlmConfigError::InvalidConfig)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAXIMUM_CONFIG_BYTES {
        return Err(ProjectLlmConfigError::ConfigTooLarge);
    }
    Ok(Some(bytes))
}

fn update_config_value<ResultValue>(
    project_root: &Path,
    update: impl FnOnce(Option<Value>) -> Result<(Value, ResultValue), ProjectLlmConfigError>,
) -> Result<ResultValue, ProjectLlmConfigError> {
    update_config_value_after_missing_observed(project_root, update, || {})
}

fn update_config_value_after_missing_observed<ResultValue>(
    project_root: &Path,
    update: impl FnOnce(Option<Value>) -> Result<(Value, ResultValue), ProjectLlmConfigError>,
    observe_missing: impl FnOnce(),
) -> Result<ResultValue, ProjectLlmConfigError> {
    let target = acquire_config_write_target_after_missing_observed(project_root, observe_missing)?;
    let expected = read_config_bytes(&target.path)?;
    let current = expected
        .as_deref()
        .map(|bytes| {
            serde_json::from_slice(bytes).map_err(|_| ProjectLlmConfigError::InvalidConfig)
        })
        .transpose()?;
    let (value, result) = update(current)?;
    if read_config_bytes(&target.path)? != expected {
        return Err(ProjectLlmConfigError::ConcurrentModification);
    }
    write_config_value_at(&target.directory, &target.path, &value)?;
    Ok(result)
}

fn write_config_value_if_unchanged(
    project_root: &Path,
    value: &Value,
    expected: &[u8],
) -> Result<(), ProjectLlmConfigError> {
    write_config_value_guarded(project_root, value, Some(expected))
}

fn write_config_value_guarded(
    project_root: &Path,
    value: &Value,
    expected: Option<&[u8]>,
) -> Result<(), ProjectLlmConfigError> {
    let target = acquire_config_write_target(project_root)?;
    if let Some(expected) = expected {
        let current = read_config_bytes(&target.path)?
            .ok_or(ProjectLlmConfigError::ConcurrentModification)?;
        if current != expected {
            return Err(ProjectLlmConfigError::ConcurrentModification);
        }
    }
    write_config_value_at(&target.directory, &target.path, value)
}

fn acquire_config_write_target(
    project_root: &Path,
) -> Result<ConfigWriteTarget, ProjectLlmConfigError> {
    acquire_config_write_target_after_missing_observed(project_root, || {})
}

fn acquire_config_write_target_after_missing_observed(
    project_root: &Path,
    observe_missing: impl FnOnce(),
) -> Result<ConfigWriteTarget, ProjectLlmConfigError> {
    let root = canonical_project_root(project_root)?;
    let directory = root.join(CONFIG_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            observe_missing();
            match fs::create_dir(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(ProjectLlmConfigError::WriteFailed),
            }
        }
        Err(_) => return Err(ProjectLlmConfigError::ProjectUnavailable),
    }
    if !fs::symlink_metadata(&directory)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        return Err(ProjectLlmConfigError::ProjectUnavailable);
    }
    let lock = acquire_config_write_lock(&directory)?;
    let path = directory.join(CONFIG_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(ProjectLlmConfigError::ProjectUnavailable);
    }
    Ok(ConfigWriteTarget {
        directory,
        path,
        _lock: lock,
    })
}

fn write_config_value_at(
    directory: &Path,
    path: &Path,
    value: &Value,
) -> Result<(), ProjectLlmConfigError> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|_| ProjectLlmConfigError::InvalidConfig)?;
    bytes.push(b'\n');
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAXIMUM_CONFIG_BYTES {
        return Err(ProjectLlmConfigError::ConfigTooLarge);
    }
    let mut temporary =
        NamedTempFile::new_in(directory).map_err(|_| ProjectLlmConfigError::WriteFailed)?;
    #[cfg(unix)]
    set_private_permissions(temporary.as_file())?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| ProjectLlmConfigError::WriteFailed)?;
    temporary
        .persist(path)
        .map_err(|_| ProjectLlmConfigError::WriteFailed)?;
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ProjectLlmConfigError::WriteFailed)
}

fn acquire_config_write_lock(directory: &Path) -> Result<ConfigWriteLock, ProjectLlmConfigError> {
    let path = directory.join(CONFIG_LOCK_FILE);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) | Err(_) => return Err(ProjectLlmConfigError::ProjectUnavailable),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| ProjectLlmConfigError::WriteFailed)?;
    if !file
        .metadata()
        .is_ok_and(|metadata| metadata.file_type().is_file())
    {
        return Err(ProjectLlmConfigError::ProjectUnavailable);
    }
    #[cfg(unix)]
    set_private_permissions(&file)?;
    let started = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(ConfigWriteLock { file }),
            Err(std::fs::TryLockError::WouldBlock) if started.elapsed() < CONFIG_LOCK_WAIT => {
                let remaining = CONFIG_LOCK_WAIT.saturating_sub(started.elapsed());
                thread::sleep(CONFIG_LOCK_RETRY.min(remaining));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(ProjectLlmConfigError::ConcurrentModification);
            }
            Err(_) => return Err(ProjectLlmConfigError::WriteFailed),
        }
    }
}

#[cfg(unix)]
fn set_private_permissions(file: &File) -> Result<(), ProjectLlmConfigError> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| ProjectLlmConfigError::WriteFailed)
}

fn config_path(project_root: &Path) -> Result<PathBuf, ProjectLlmConfigError> {
    Ok(canonical_project_root(project_root)?
        .join(CONFIG_DIRECTORY)
        .join(CONFIG_FILE))
}

fn canonical_project_root(project_root: &Path) -> Result<PathBuf, ProjectLlmConfigError> {
    let root =
        fs::canonicalize(project_root).map_err(|_| ProjectLlmConfigError::ProjectUnavailable)?;
    if root.is_dir() {
        Ok(root)
    } else {
        Err(ProjectLlmConfigError::ProjectUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Arc, Barrier, mpsc},
        thread,
        time::Duration,
    };

    const LOCAL_SUMMARY_ENDPOINT: &str = "http://localhost:8081";
    const LEGACY_INLINE_CONFIG: &str = r#"{"llm":{"summarizeLlm":{"provider":"openai-compat","endpoint":"https://example.test","model":"fixture","apiKey":"do-not-print"}}}"#;
    const REJECTED_ENDPOINTS: [&str; 3] = [
        "http://example.test",
        "https://user:secret@example.test",
        "file:///tmp/model",
    ];
    const VALID_REMOTE_ENDPOINT: &str = "https://example.test";

    #[test]
    fn project_config_round_trips_without_replacing_unrelated_fields() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"version":1,"languages":["rust"],"llm":{"enabled":true}}"#,
        )
        .unwrap_or_else(|error| panic!("config fixture failed: {error}"));
        let input = ProjectLlmTierInput::new(
            ProjectLlmTier::Summarize,
            LOCAL_SUMMARY_ENDPOINT,
            "fixture-chat",
        )
        .and_then(|input| input.with_concurrency(3))
        .map_or_else(
            |error| panic!("tier input failed: {error}"),
            ProjectLlmTierInput::without_credentials,
        );
        assert_eq!(input.tier(), ProjectLlmTier::Summarize);
        write_project_llm_tiers(root.path(), &[input])
            .unwrap_or_else(|error| panic!("tier write failed: {error}"));
        let loaded = load_project_llm_tier(root.path(), ProjectLlmTier::Summarize)
            .unwrap_or_else(|error| panic!("tier load failed: {error}"))
            .unwrap_or_else(|| panic!("tier missing"));
        assert_eq!(loaded.model(), "fixture-chat");
        assert_eq!(loaded.concurrency(), Some(3));
        assert_eq!(loaded.credential_source(), ProjectLlmCredentialSource::None);
        let value = read_config_value(root.path())
            .unwrap_or_else(|error| panic!("config reread failed: {error}"))
            .unwrap_or_else(|| panic!("config missing"));
        assert_eq!(value["languages"], json!(["rust"]));
        assert!(value["llm"]["summarizeLlm"].get("apiKey").is_none());
    }

    #[test]
    fn endpoint_origin_changes_clear_credentials_while_same_origin_updates_preserve_them() {
        let changed = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("origin-change tempdir failed: {error}"));
        fs::create_dir(changed.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("origin-change state failed: {error}"));
        fs::write(
            changed.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"version":2,"llm":{"enabled":true,"embeddingLlm":{"provider":"openai-compat","endpoint":"https://example.test/v1","model":"remote","apiKey":"fixture-secret"}}}"#,
        )
        .unwrap_or_else(|error| panic!("origin-change fixture failed: {error}"));
        let input = ProjectLlmTierInput::new(
            ProjectLlmTier::Embedding,
            "http://127.0.0.1:9999/v1",
            "local",
        )
        .unwrap_or_else(|error| panic!("origin-change input failed: {error}"));
        let report = write_project_llm_configuration_with_report(changed.path(), &[input], &[])
            .unwrap_or_else(|error| panic!("origin-change write failed: {error}"));
        assert_eq!(
            report.credential_actions,
            vec![ProjectLlmCredentialWriteEntry {
                tier: ProjectLlmTier::Embedding,
                action: ProjectLlmCredentialWriteAction::ClearedOriginChange,
            }]
        );
        let changed_value = read_config_value(changed.path())
            .unwrap_or_else(|error| panic!("origin-change read failed: {error}"))
            .unwrap_or_else(|| panic!("origin-change config missing"));
        assert!(changed_value["llm"]["embeddingLlm"].get("apiKey").is_none());
        assert!(
            changed_value["llm"]["embeddingLlm"]
                .get("apiKeyEnv")
                .is_none()
        );
        assert!(
            !serde_json::to_string(&report)
                .unwrap_or_else(|error| panic!("origin-change report failed: {error}"))
                .contains("fixture-secret")
        );

        let same = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("same-origin tempdir failed: {error}"));
        fs::create_dir(same.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("same-origin state failed: {error}"));
        fs::write(
            same.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"version":2,"llm":{"enabled":true,"embeddingLlm":{"provider":"openai-compat","endpoint":"https://example.test/v1","model":"old","apiKey":"fixture-secret"}}}"#,
        )
        .unwrap_or_else(|error| panic!("same-origin fixture failed: {error}"));
        let input =
            ProjectLlmTierInput::new(ProjectLlmTier::Embedding, "https://example.test/v2", "new")
                .unwrap_or_else(|error| panic!("same-origin input failed: {error}"));
        let report = write_project_llm_configuration_with_report(same.path(), &[input], &[])
            .unwrap_or_else(|error| panic!("same-origin write failed: {error}"));
        assert_eq!(
            report.credential_actions[0].action,
            ProjectLlmCredentialWriteAction::Preserved
        );
        let same_value = read_config_value(same.path())
            .unwrap_or_else(|error| panic!("same-origin read failed: {error}"))
            .unwrap_or_else(|| panic!("same-origin config missing"));
        assert_eq!(
            same_value["llm"]["embeddingLlm"]["apiKey"],
            Value::String("fixture-secret".to_owned())
        );
    }

    #[test]
    fn max_file_size_round_trips_without_replacing_llm_or_language_fields() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"version":2,"languages":["rust"],"llm":{"enabled":false}}"#,
        )
        .unwrap_or_else(|error| panic!("config fixture failed: {error}"));

        write_project_max_file_size(root.path(), 5 * 1024 * 1024)
            .unwrap_or_else(|error| panic!("max file size write failed: {error}"));
        assert_eq!(
            load_project_max_file_size(root.path()),
            Ok(Some(5 * 1024 * 1024))
        );
        let value = read_config_value(root.path())
            .unwrap_or_else(|error| panic!("config reread failed: {error}"))
            .unwrap_or_else(|| panic!("config missing"));
        assert_eq!(value["languages"], json!(["rust"]));
        assert_eq!(value["llm"]["enabled"], false);
        assert!(write_project_max_file_size(root.path(), 0).is_err());
        assert!(
            write_project_max_file_size(root.path(), MAXIMUM_PROJECT_SOURCE_BYTES + 1).is_err()
        );
    }

    #[test]
    fn config_updates_wait_for_short_contention_and_read_after_lock() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let directory = root.path().join(CONFIG_DIRECTORY);
        fs::create_dir(&directory)
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        let path = directory.join(CONFIG_FILE);
        fs::write(&path, r#"{"version":2,"languages":["rust"]}"#)
            .unwrap_or_else(|error| panic!("config fixture failed: {error}"));
        let held = acquire_config_write_lock(&directory)
            .unwrap_or_else(|error| panic!("fixture lock failed: {error}"));
        let project = root.path().to_path_buf();
        let (started_tx, started_rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            started_tx
                .send(())
                .unwrap_or_else(|error| panic!("writer start signal failed: {error}"));
            write_project_max_file_size(&project, 8 * 1024 * 1024)
        });
        started_rx
            .recv()
            .unwrap_or_else(|error| panic!("writer start wait failed: {error}"));
        thread::sleep(Duration::from_millis(25));
        assert!(
            !writer.is_finished(),
            "a short-lived writer must wait for the config lock"
        );

        fs::write(
            &path,
            r#"{"version":2,"languages":["rust"],"concurrentEdit":true}"#,
        )
        .unwrap_or_else(|error| panic!("concurrent fixture write failed: {error}"));
        drop(held);
        writer
            .join()
            .unwrap_or_else(|_| panic!("config writer panicked"))
            .unwrap_or_else(|error| panic!("config writer failed: {error}"));

        let value = read_config_value(root.path())
            .unwrap_or_else(|error| panic!("config reread failed: {error}"))
            .unwrap_or_else(|| panic!("config missing"));
        assert_eq!(value["languages"], json!(["rust"]));
        assert_eq!(value["concurrentEdit"], true);
        assert_eq!(value["maxFileSize"], 8 * 1024 * 1024);
    }

    #[test]
    fn concurrent_first_config_updates_share_directory_creation_and_preserve_both_fields() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let project = Arc::new(root.path().to_path_buf());
        let missing_barrier = Arc::new(Barrier::new(2));

        let maximum_project = project.clone();
        let maximum_barrier = missing_barrier.clone();
        let maximum = thread::spawn(move || {
            update_config_value_after_missing_observed(
                &maximum_project,
                |current| {
                    let mut value = current.unwrap_or_else(|| json!({"version": 2}));
                    value
                        .as_object_mut()
                        .ok_or(ProjectLlmConfigError::InvalidConfig)?
                        .insert("maxFileSize".to_owned(), Value::from(8 * 1024 * 1024));
                    Ok((value, ()))
                },
                || {
                    maximum_barrier.wait();
                },
            )
        });
        let language_project = project.clone();
        let language_barrier = missing_barrier.clone();
        let language = thread::spawn(move || {
            update_config_value_after_missing_observed(
                &language_project,
                |current| {
                    let mut value = current.unwrap_or_else(|| json!({"version": 2}));
                    value
                        .as_object_mut()
                        .ok_or(ProjectLlmConfigError::InvalidConfig)?
                        .insert("languages".to_owned(), json!(["rust"]));
                    Ok((value, ()))
                },
                || {
                    language_barrier.wait();
                },
            )
        });

        maximum
            .join()
            .unwrap_or_else(|_| panic!("maximum writer panicked"))
            .unwrap_or_else(|error| panic!("maximum writer failed: {error}"));
        language
            .join()
            .unwrap_or_else(|_| panic!("language writer panicked"))
            .unwrap_or_else(|error| panic!("language writer failed: {error}"));

        let value = read_config_value(&project)
            .unwrap_or_else(|error| panic!("config reread failed: {error}"))
            .unwrap_or_else(|| panic!("config missing"));
        assert_eq!(value["maxFileSize"], 8 * 1024 * 1024);
        assert_eq!(value["languages"], json!(["rust"]));
    }

    #[test]
    fn config_updates_fail_after_bounded_lock_contention() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let directory = root.path().join(CONFIG_DIRECTORY);
        fs::create_dir(&directory)
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        let _held = acquire_config_write_lock(&directory)
            .unwrap_or_else(|error| panic!("fixture lock failed: {error}"));

        let started = std::time::Instant::now();
        let result = write_project_max_file_size(root.path(), 8 * 1024 * 1024);
        let elapsed = started.elapsed();

        assert_eq!(result, Err(ProjectLlmConfigError::ConcurrentModification));
        assert!(
            elapsed >= Duration::from_millis(100),
            "config contention failed immediately after {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "config contention was not bounded: {elapsed:?}"
        );
    }

    #[test]
    fn config_updates_reject_an_uncooperative_edit_during_mutation() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let directory = root.path().join(CONFIG_DIRECTORY);
        fs::create_dir(&directory)
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        let path = directory.join(CONFIG_FILE);
        fs::write(&path, r#"{"version":2,"languages":["rust"]}"#)
            .unwrap_or_else(|error| panic!("config fixture failed: {error}"));
        let observed_path = path.clone();

        let result = update_config_value(root.path(), |current| {
            fs::write(
                &observed_path,
                r#"{"version":2,"languages":["rust"],"externalEdit":true}"#,
            )
            .unwrap_or_else(|error| panic!("external edit failed: {error}"));
            let mut value = current.ok_or(ProjectLlmConfigError::InvalidConfig)?;
            value
                .as_object_mut()
                .ok_or(ProjectLlmConfigError::InvalidConfig)?
                .insert("maxFileSize".to_owned(), Value::from(8 * 1024 * 1024));
            Ok((value, ()))
        });

        assert_eq!(result, Err(ProjectLlmConfigError::ConcurrentModification));
        let value = read_config_value(root.path())
            .unwrap_or_else(|error| panic!("config reread failed: {error}"))
            .unwrap_or_else(|| panic!("config missing"));
        assert_eq!(value["externalEdit"], true);
        assert!(value.get("maxFileSize").is_none());
    }

    #[test]
    fn source_settings_are_bounded_v1_compatible_and_do_not_render_patterns() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"maxFileSize":4096,"maxGenerationBytes":8589934592,"languages":["typescript","rust","rust"],"exclude":["private/**"],"extractDocstrings":false,"trackCallSites":false,"indexSubmodules":false,"indexEmbeddedRepos":true,"enableCentrality":false,"enableBetweenness":false,"enableChurn":false,"enableCoChange":false,"enableBiomarkers":false,"enableIssueHistory":false,"enableConfigRefs":false,"enableSqlRefs":false,"enableBuildContextRefs":false,"enableStringImports":false,"duplicateCodePartialClones":true,"duplicateCodeAllowlist":["generated/**","vendor-copy/**"],"llm":{"apiKey":"do-not-render"}}"#,
        )
        .unwrap_or_else(|error| panic!("source config fixture failed: {error}"));
        let settings = load_project_source_settings(root.path())
            .unwrap_or_else(|error| panic!("source settings failed: {error}"));
        assert_eq!(settings.maximum_file_bytes(), Some(4096));
        assert_eq!(settings.maximum_generation_bytes(), Some(8_589_934_592));
        assert_eq!(
            settings.languages(),
            [SourceLanguage::Rust, SourceLanguage::TypeScript]
        );
        assert_eq!(settings.excludes(), ["private/**"]);
        assert!(!settings.extract_docstrings());
        assert!(!settings.track_call_sites());
        assert!(!settings.index_submodules());
        assert!(!settings.index_embedded_repositories());
        assert!(!settings.enable_centrality());
        assert!(!settings.enable_betweenness());
        assert!(!settings.enable_churn());
        assert!(!settings.enable_co_change());
        assert!(!settings.enable_biomarkers());
        assert!(!settings.enable_issue_history());
        assert!(!settings.enable_config_refs());
        assert!(!settings.enable_sql_refs());
        assert!(!settings.enable_build_context_refs());
        assert!(!settings.enable_string_imports());
        assert!(settings.duplicate_code_partial_clones());
        assert_eq!(
            settings.duplicate_code_allowlist(),
            ["generated/**", "vendor-copy/**"]
        );
        let rendered = format!("{settings:?}");
        assert!(!rendered.contains("private"));
        assert!(!rendered.contains("generated"));
        assert!(!rendered.contains("do-not-render"));

        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"exclude":"not-an-array"}"#,
        )
        .unwrap_or_else(|error| panic!("invalid source config fixture failed: {error}"));
        assert_eq!(
            load_project_source_settings(root.path()),
            Err(ProjectLlmConfigError::InvalidConfig)
        );

        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"maxGenerationBytes":8589934593}"#,
        )
        .unwrap_or_else(|error| panic!("invalid generation config fixture failed: {error}"));
        assert_eq!(
            load_project_source_settings(root.path()),
            Err(ProjectLlmConfigError::InvalidConfig)
        );
    }

    #[test]
    fn loader_accepts_legacy_inline_secret_without_debug_disclosure() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            LEGACY_INLINE_CONFIG,
        )
        .unwrap_or_else(|error| panic!("legacy fixture failed: {error}"));
        let loaded = load_project_llm_tier(root.path(), ProjectLlmTier::Summarize)
            .unwrap_or_else(|error| panic!("legacy tier failed: {error}"))
            .unwrap_or_else(|| panic!("legacy tier missing"));
        assert_eq!(
            loaded.credential_source(),
            ProjectLlmCredentialSource::InlineLegacy
        );
        assert!(!format!("{loaded:?}").contains("do-not-print"));
    }

    #[test]
    fn inline_credential_migration_requires_an_exact_environment_match() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        let path = root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE);
        fs::write(&path, LEGACY_INLINE_CONFIG)
            .unwrap_or_else(|error| panic!("legacy fixture failed: {error}"));

        let blocked = migrate_project_inline_credentials_with(CredentialMigrationRequest {
            project_root: root.path(),
            environment_overrides: &[],
            apply: true,
            resolve: |_: &str| Some("different-secret".to_owned()),
        })
        .unwrap_or_else(|error| panic!("blocked migration failed: {error}"));
        assert_eq!(blocked.migrated, 0);
        assert_eq!(blocked.remaining_inline, 1);
        assert_eq!(
            blocked.candidates[0].status,
            ProjectCredentialMigrationStatus::EnvironmentMismatch
        );
        assert!(
            fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("blocked config read failed: {error}"))
                .contains("do-not-print")
        );

        let dry_run = migrate_project_inline_credentials_with(CredentialMigrationRequest {
            project_root: root.path(),
            environment_overrides: &[(ProjectLlmTier::Summarize, "CARTOGRAPH_TEST_KEY".to_owned())],
            apply: false,
            resolve: |_: &str| Some("do-not-print".to_owned()),
        })
        .unwrap_or_else(|error| panic!("dry migration failed: {error}"));
        assert_eq!(
            dry_run.candidates[0].status,
            ProjectCredentialMigrationStatus::Ready
        );
        assert!(
            !serde_json::to_string(&dry_run)
                .unwrap_or_else(|error| panic!("report serialization failed: {error}"))
                .contains("do-not-print")
        );

        let applied = migrate_project_inline_credentials_with(CredentialMigrationRequest {
            project_root: root.path(),
            environment_overrides: &[(ProjectLlmTier::Summarize, "CARTOGRAPH_TEST_KEY".to_owned())],
            apply: true,
            resolve: |_: &str| Some("do-not-print".to_owned()),
        })
        .unwrap_or_else(|error| panic!("credential migration failed: {error}"));
        assert_eq!(applied.migrated, 1);
        assert_eq!(applied.remaining_inline, 0);
        let updated = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("updated config read failed: {error}"));
        assert!(!updated.contains("do-not-print"));
        assert!(updated.contains("\"apiKeyEnv\": \"CARTOGRAPH_TEST_KEY\""));
    }

    #[test]
    fn inline_credential_migration_rejects_a_concurrent_config_change() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        let path = root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE);
        fs::write(&path, LEGACY_INLINE_CONFIG)
            .unwrap_or_else(|error| panic!("legacy fixture failed: {error}"));
        let mut concurrent = serde_json::from_str::<Value>(LEGACY_INLINE_CONFIG)
            .unwrap_or_else(|error| panic!("concurrent fixture parse failed: {error}"));
        concurrent
            .as_object_mut()
            .unwrap_or_else(|| panic!("concurrent fixture root is not an object"))
            .insert("concurrentEdit".to_owned(), Value::Bool(true));
        let mut concurrent_bytes = serde_json::to_vec_pretty(&concurrent)
            .unwrap_or_else(|error| panic!("concurrent fixture encode failed: {error}"));
        concurrent_bytes.push(b'\n');
        let observed_path = path.clone();
        let observed_bytes = concurrent_bytes.clone();

        let result = migrate_project_inline_credentials_with_observer(
            CredentialMigrationRequest {
                project_root: root.path(),
                environment_overrides: &[(
                    ProjectLlmTier::Summarize,
                    "CARTOGRAPH_TEST_KEY".to_owned(),
                )],
                apply: true,
                resolve: |_: &str| Some("do-not-print".to_owned()),
            },
            move || {
                fs::write(observed_path, observed_bytes)
                    .unwrap_or_else(|error| panic!("concurrent config write failed: {error}"));
            },
        );

        assert_eq!(result, Err(ProjectLlmConfigError::ConcurrentModification));
        assert_eq!(
            fs::read(path).unwrap_or_else(|error| panic!("concurrent config read failed: {error}")),
            concurrent_bytes
        );
    }

    #[test]
    fn v1_chat_providers_defaults_and_ask_fallback_are_preserved() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"llm":{"summarizeLlm":{"provider":"claude-bridge","askModel":"claude-custom-ask","claudeBin":"/usr/bin/env","summaryBatchSize":9},"localLlm":{"provider":"anthropic-api","apiKey":"test-anthropic-key"}}}"#,
        )
        .unwrap_or_else(|error| panic!("provider fixture failed: {error}"));

        let summarize = load_exact_project_llm_tier(root.path(), ProjectLlmTier::Summarize)
            .unwrap_or_else(|error| panic!("summarize provider failed: {error}"))
            .unwrap_or_else(|| panic!("summarize provider missing"));
        assert_eq!(summarize.provider(), ProjectLlmProvider::ClaudeBridge);
        assert_eq!(summarize.endpoint(), CLAUDE_BRIDGE_ENDPOINT);
        assert_eq!(summarize.model(), DEFAULT_CLAUDE_SUMMARIZE_MODEL);
        assert_eq!(summarize.ask_model(), Some("claude-custom-ask"));
        assert_eq!(summarize.claude_bin(), Some("/usr/bin/env"));
        assert_eq!(summarize.summary_batch_size(), Some(9));

        let ask = load_project_llm_tier(root.path(), ProjectLlmTier::Ask)
            .unwrap_or_else(|error| panic!("ask fallback failed: {error}"))
            .unwrap_or_else(|| panic!("ask fallback missing"));
        assert_eq!(ask.provider(), ProjectLlmProvider::ClaudeBridge);
        assert_eq!(ask.model(), "claude-custom-ask");

        let local = load_exact_project_llm_tier(root.path(), ProjectLlmTier::Local)
            .unwrap_or_else(|error| panic!("anthropic provider failed: {error}"))
            .unwrap_or_else(|| panic!("anthropic provider missing"));
        assert_eq!(local.provider(), ProjectLlmProvider::AnthropicApi);
        assert_eq!(local.endpoint(), ANTHROPIC_CLOUD_ENDPOINT);
        assert_eq!(local.model(), DEFAULT_CLAUDE_ASK_MODEL);
        assert_eq!(
            local.credential_source(),
            ProjectLlmCredentialSource::InlineLegacy
        );

        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"llm":{"embeddingLlm":{"provider":"anthropic-api","model":"invalid"}}}"#,
        )
        .unwrap_or_else(|error| panic!("invalid provider fixture failed: {error}"));
        assert!(matches!(
            load_project_llm_tier(root.path(), ProjectLlmTier::Embedding),
            Err(ProjectLlmConfigError::InvalidTier)
        ));
    }

    #[test]
    fn summary_policy_preserves_fractional_negative_and_per_kind_v1_semantics() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"llm":{"enabled":true,"summarize":false,"summarizeEagerLimit":10.2,"minBodyLines":2.1,"minBodyLinesByKind":{"method":1.2}}}"#,
        )
        .unwrap_or_else(|error| panic!("summary policy fixture failed: {error}"));
        let settings = load_project_summary_settings(root.path())
            .unwrap_or_else(|error| panic!("summary settings failed: {error}"));
        assert!(!settings.enabled());
        assert_eq!(
            settings.eager_limit(),
            ProjectSummaryEagerLimit::Bounded(11)
        );
        assert_eq!(settings.minimum_body_lines(), 3);
        assert_eq!(settings.minimum_body_lines_by_kind().get("route"), Some(&1));
        assert_eq!(
            settings.minimum_body_lines_by_kind().get("method"),
            Some(&2)
        );

        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"llm":{"summarizeEagerLimit":-0.5}}"#,
        )
        .unwrap_or_else(|error| panic!("uncapped summary fixture failed: {error}"));
        assert_eq!(
            load_project_summary_settings(root.path())
                .unwrap_or_else(|error| panic!("uncapped summary settings failed: {error}"))
                .eager_limit(),
            ProjectSummaryEagerLimit::Uncapped
        );

        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"llm":{"minBodyLinesByKind":{"method":-1}}}"#,
        )
        .unwrap_or_else(|error| panic!("invalid summary fixture failed: {error}"));
        assert!(matches!(
            load_project_summary_settings(root.path()),
            Err(ProjectLlmConfigError::InvalidConfig)
        ));
    }

    #[test]
    fn endpoint_and_environment_name_policy_rejects_unsafe_values() {
        for endpoint in REJECTED_ENDPOINTS {
            assert!(ProjectLlmTierInput::new(ProjectLlmTier::Ask, endpoint, "model").is_err());
        }
        assert!(
            ProjectLlmTierInput::new(ProjectLlmTier::Ask, VALID_REMOTE_ENDPOINT, "model")
                .and_then(|input| input.with_api_key_env("bad-name"))
                .is_err()
        );
    }
}
