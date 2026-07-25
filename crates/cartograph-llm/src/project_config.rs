use std::{
    collections::BTreeMap,
    env,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use cartograph_domain::SourceLanguage;
use futures_util::StreamExt as _;
use reqwest::StatusCode;
use secrecy::{ExposeSecret as _, SecretString};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tempfile::NamedTempFile;
use thiserror::Error;
use url::Url;

const CONFIG_DIRECTORY: &str = ".cartograph";
const CONFIG_FILE: &str = "config.json";
const MAXIMUM_CONFIG_BYTES: u64 = 1024 * 1024;
const MAXIMUM_ENDPOINT_BYTES: usize = 4_096;
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
    Embedding,
    Summarize,
    Local,
    Ask,
    Classify,
    Reranker,
}

/// Validated provider retained from the v1.1.33 chat configuration contract.
/// Embedding and reranker tiers remain OpenAI-compatible HTTP only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectLlmProvider {
    OpenAiCompat,
    ClaudeBridge,
    AnthropicApi,
}

/// Effective project-wide eager summary budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSummaryEagerLimit {
    Bounded(u64),
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
    pub const fn enabled(&self) -> bool {
        self.enabled
    }

    #[must_use]
    pub const fn eager_limit(&self) -> ProjectSummaryEagerLimit {
        self.eager_limit
    }

    #[must_use]
    pub const fn minimum_body_lines(&self) -> u32 {
        self.minimum_body_lines
    }

    #[must_use]
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
#[derive(Clone, PartialEq, Eq)]
pub struct ProjectSourceSettings {
    maximum_file_bytes: Option<usize>,
    languages: Vec<SourceLanguage>,
    includes: Option<Vec<String>>,
    excludes: Vec<String>,
    extract_docstrings: bool,
    track_call_sites: bool,
    index_submodules: bool,
    index_embedded_repositories: bool,
    enable_centrality: bool,
    enable_betweenness: bool,
    enable_churn: bool,
    enable_co_change: bool,
    enable_biomarkers: bool,
    enable_issue_history: bool,
    enable_config_refs: bool,
    enable_sql_refs: bool,
    enable_build_context_refs: bool,
    enable_string_imports: bool,
    duplicate_code_partial_clones: bool,
    duplicate_code_allowlist: Vec<String>,
}

impl std::fmt::Debug for ProjectSourceSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProjectSourceSettings")
            .field("maximum_file_bytes", &self.maximum_file_bytes)
            .field("configured_languages", &self.languages.len())
            .field(
                "include_patterns",
                &self.includes.as_ref().map_or(0, Vec::len),
            )
            .field("exclude_patterns", &self.excludes.len())
            .field("extract_docstrings", &self.extract_docstrings)
            .field("track_call_sites", &self.track_call_sites)
            .field("index_submodules", &self.index_submodules)
            .field(
                "index_embedded_repositories",
                &self.index_embedded_repositories,
            )
            .field("enable_centrality", &self.enable_centrality)
            .field("enable_betweenness", &self.enable_betweenness)
            .field("enable_churn", &self.enable_churn)
            .field("enable_co_change", &self.enable_co_change)
            .field("enable_biomarkers", &self.enable_biomarkers)
            .field("enable_issue_history", &self.enable_issue_history)
            .field("enable_config_refs", &self.enable_config_refs)
            .field("enable_sql_refs", &self.enable_sql_refs)
            .field("enable_build_context_refs", &self.enable_build_context_refs)
            .field("enable_string_imports", &self.enable_string_imports)
            .field(
                "duplicate_code_partial_clones",
                &self.duplicate_code_partial_clones,
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
    pub const fn maximum_file_bytes(&self) -> Option<usize> {
        self.maximum_file_bytes
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
    pub fn excludes(&self) -> &[String] {
        &self.excludes
    }

    #[must_use]
    pub const fn extract_docstrings(&self) -> bool {
        self.extract_docstrings
    }

    #[must_use]
    pub const fn track_call_sites(&self) -> bool {
        self.track_call_sites
    }

    #[must_use]
    pub const fn index_submodules(&self) -> bool {
        self.index_submodules
    }

    #[must_use]
    pub const fn index_embedded_repositories(&self) -> bool {
        self.index_embedded_repositories
    }

    /// Whether v1-compatible PageRank centrality is derived for each generation.
    #[must_use]
    pub const fn enable_centrality(&self) -> bool {
        self.enable_centrality
    }

    /// Whether bounded sampled Brandes betweenness is derived for each generation.
    #[must_use]
    pub const fn enable_betweenness(&self) -> bool {
        self.enable_betweenness
    }

    #[must_use]
    pub const fn enable_churn(&self) -> bool {
        self.enable_churn
    }

    #[must_use]
    pub const fn enable_co_change(&self) -> bool {
        self.enable_co_change
    }

    #[must_use]
    pub const fn enable_biomarkers(&self) -> bool {
        self.enable_biomarkers
    }

    #[must_use]
    pub const fn enable_issue_history(&self) -> bool {
        self.enable_issue_history
    }

    #[must_use]
    pub const fn enable_config_refs(&self) -> bool {
        self.enable_config_refs
    }

    #[must_use]
    pub const fn enable_sql_refs(&self) -> bool {
        self.enable_sql_refs
    }

    #[must_use]
    pub const fn enable_build_context_refs(&self) -> bool {
        self.enable_build_context_refs
    }

    #[must_use]
    pub const fn enable_string_imports(&self) -> bool {
        self.enable_string_imports
    }

    /// Whether the wider 0.80 Type-3 clone band is enabled in addition to 0.95.
    #[must_use]
    pub const fn duplicate_code_partial_clones(&self) -> bool {
        self.duplicate_code_partial_clones
    }

    /// Project-relative path globs exempted from every duplicate-code tier.
    #[must_use]
    pub fn duplicate_code_allowlist(&self) -> &[String] {
        &self.duplicate_code_allowlist
    }
}

impl ProjectLlmTier {
    pub(crate) const fn config_key(self) -> &'static str {
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
    None,
    Environment,
    InlineLegacy,
}

/// Bounded `/v1/models` probe used by the agent-driven setup planner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmEndpointProbe {
    pub reachable: bool,
    pub openai_compatible: bool,
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
    pub const fn provider(&self) -> ProjectLlmProvider {
        self.provider
    }

    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }

    #[must_use]
    pub fn ask_model(&self) -> Option<&str> {
        self.ask_model.as_deref()
    }

    #[must_use]
    pub fn api_key(&self) -> Option<String> {
        self.api_key
            .as_ref()
            .map(|value| value.expose_secret().to_owned())
    }

    #[must_use]
    pub const fn credential_source(&self) -> ProjectLlmCredentialSource {
        self.credential_source
    }

    #[must_use]
    pub const fn timeout_ms(&self) -> Option<u64> {
        self.timeout_ms
    }

    #[must_use]
    pub const fn concurrency(&self) -> Option<u16> {
        self.concurrency
    }

    #[must_use]
    pub const fn summary_batch_size(&self) -> Option<u16> {
        self.summary_batch_size
    }

    #[must_use]
    pub fn claude_bin(&self) -> Option<&str> {
        self.claude_bin.as_deref()
    }

    #[must_use]
    pub fn llama_server_args(&self) -> &[String] {
        &self.llama_server_args
    }

    #[must_use]
    pub const fn externally_managed(&self) -> bool {
        self.externally_managed
    }
}

/// Validated config mutation. Credentials are preserved unless explicitly
/// cleared or replaced with an environment-variable reference.
#[derive(Clone, Debug)]
pub struct ProjectLlmTierInput {
    tier: ProjectLlmTier,
    provider: ProjectLlmProvider,
    endpoint: String,
    model: String,
    ask_model: Option<String>,
    api_key_env: Option<String>,
    replace_credentials: bool,
    timeout_ms: Option<u64>,
    concurrency: Option<u16>,
    summary_batch_size: Option<u16>,
    claude_bin: Option<String>,
}

impl ProjectLlmTierInput {
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
            api_key_env: None,
            replace_credentials: false,
            timeout_ms: None,
            concurrency: None,
            summary_batch_size: None,
            claude_bin: None,
        })
    }

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
            api_key_env: None,
            replace_credentials: true,
            timeout_ms: None,
            concurrency: None,
            summary_batch_size: None,
            claude_bin: None,
        })
    }

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
            api_key_env: Some("ANTHROPIC_API_KEY".to_owned()),
            replace_credentials: true,
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

    pub fn with_api_key_env(
        mut self,
        value: impl Into<String>,
    ) -> Result<Self, ProjectLlmConfigError> {
        if self.provider == ProjectLlmProvider::ClaudeBridge {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        let value = value.into();
        validate_env_name(&value)?;
        self.api_key_env = Some(value);
        self.replace_credentials = true;
        Ok(self)
    }

    #[must_use]
    pub fn without_credentials(mut self) -> Self {
        self.api_key_env = None;
        self.replace_credentials = true;
        self
    }

    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Result<Self, ProjectLlmConfigError> {
        if timeout_ms == 0 || timeout_ms > MAXIMUM_TIMEOUT_MS {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        self.timeout_ms = Some(timeout_ms);
        Ok(self)
    }

    pub fn with_concurrency(mut self, concurrency: u16) -> Result<Self, ProjectLlmConfigError> {
        if concurrency == 0 || concurrency > MAXIMUM_CONCURRENCY {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        self.concurrency = Some(concurrency);
        Ok(self)
    }

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
pub enum ProjectLlmConfigError {
    #[error("Cartograph project configuration path is unavailable")]
    ProjectUnavailable,
    #[error("Cartograph project configuration is too large")]
    ConfigTooLarge,
    #[error("Cartograph project configuration is invalid")]
    InvalidConfig,
    #[error("Cartograph project LLM tier is invalid")]
    InvalidTier,
    #[error("Cartograph project LLM credential environment variable is unavailable")]
    CredentialUnavailable,
    #[error("Cartograph project configuration cannot be written safely")]
    WriteFailed,
}

/// Load one tier, retaining v1's ask/classify-to-summarize fallback.
pub fn load_project_llm_tier(
    project_root: &Path,
    tier: ProjectLlmTier,
) -> Result<Option<ProjectLlmTierConfig>, ProjectLlmConfigError> {
    load_project_llm_tier_with_fallback(project_root, tier, true)
}

/// Load only the named tier without ask/local/classify fallback. Diagnostics
/// use this to distinguish a deliberate split tier from summarize fallback.
pub fn load_exact_project_llm_tier(
    project_root: &Path,
    tier: ProjectLlmTier,
) -> Result<Option<ProjectLlmTierConfig>, ProjectLlmConfigError> {
    load_project_llm_tier_with_fallback(project_root, tier, false)
}

/// Read the v1-compatible project-wide source-file ceiling without conflating
/// an absent setting with an invalid configuration file.
pub fn load_project_max_file_size(
    project_root: &Path,
) -> Result<Option<usize>, ProjectLlmConfigError> {
    load_project_source_settings(project_root).map(|settings| settings.maximum_file_bytes)
}

/// Read the summary candidate floor and eager budget from the shared v1 config.
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
    if value > MAXIMUM_SUMMARY_EAGER_LIMIT as f64 {
        return Err(ProjectLlmConfigError::InvalidConfig);
    }
    Ok(ProjectSummaryEagerLimit::Bounded(value.ceil() as u64))
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
    Ok(value.ceil() as u32)
}

/// Read bounded v1-compatible source discovery settings without exposing LLM credentials.
pub fn load_project_source_settings(
    project_root: &Path,
) -> Result<ProjectSourceSettings, ProjectLlmConfigError> {
    let Some(value) = read_config_value(project_root)? else {
        return Ok(ProjectSourceSettings {
            maximum_file_bytes: None,
            languages: Vec::new(),
            includes: None,
            excludes: Vec::new(),
            extract_docstrings: true,
            track_call_sites: true,
            index_submodules: true,
            index_embedded_repositories: true,
            enable_centrality: true,
            enable_betweenness: true,
            enable_churn: true,
            enable_co_change: true,
            enable_biomarkers: true,
            enable_issue_history: true,
            enable_config_refs: true,
            enable_sql_refs: true,
            enable_build_context_refs: true,
            enable_string_imports: true,
            duplicate_code_partial_clones: false,
            duplicate_code_allowlist: Vec::new(),
        });
    };
    let root = value
        .as_object()
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let maximum_file_bytes = root
        .get("maxFileSize")
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .filter(|value| (1..=MAXIMUM_PROJECT_SOURCE_BYTES).contains(value))
                .ok_or(ProjectLlmConfigError::InvalidConfig)
        })
        .transpose()?;
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
    Ok(ProjectSourceSettings {
        maximum_file_bytes,
        languages,
        includes,
        excludes,
        extract_docstrings,
        track_call_sites,
        index_submodules,
        index_embedded_repositories,
        enable_centrality,
        enable_betweenness,
        enable_churn,
        enable_co_change,
        enable_biomarkers,
        enable_issue_history,
        enable_config_refs,
        enable_sql_refs,
        enable_build_context_refs,
        enable_string_imports,
        duplicate_code_partial_clones,
        duplicate_code_allowlist,
    })
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
pub fn write_project_max_file_size(
    project_root: &Path,
    max_file_size: usize,
) -> Result<(), ProjectLlmConfigError> {
    if !(1..=MAXIMUM_PROJECT_SOURCE_BYTES).contains(&max_file_size) {
        return Err(ProjectLlmConfigError::InvalidConfig);
    }
    let mut root = read_config_value(project_root)?.unwrap_or_else(|| json!({"version": 2}));
    let root = root
        .as_object_mut()
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    root.insert("maxFileSize".to_owned(), Value::from(max_file_size));
    write_config_value(project_root, &Value::Object(root.clone()))
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
            parse_tier(value, configured_tier, tier, fallback)
        })
        .transpose()
}

/// Atomically update one or more tier blocks while preserving non-LLM config.
pub fn write_project_llm_tiers(
    project_root: &Path,
    inputs: &[ProjectLlmTierInput],
) -> Result<(), ProjectLlmConfigError> {
    write_project_llm_configuration(project_root, inputs, &[])
}

/// Atomically update configured tiers and explicitly disable incompatible ones.
pub fn write_project_llm_configuration(
    project_root: &Path,
    inputs: &[ProjectLlmTierInput],
    cleared: &[ProjectLlmTier],
) -> Result<(), ProjectLlmConfigError> {
    if inputs.is_empty() && cleared.is_empty() {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    let mut root = read_config_value(project_root)?.unwrap_or_else(|| json!({"version": 2}));
    let root = root
        .as_object_mut()
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let llm = object_field(root, "llm")?;
    llm.insert("enabled".to_owned(), Value::Bool(true));
    for input in inputs {
        let tier = object_field(llm, input.tier.config_key())?;
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
        if input.replace_credentials {
            tier.remove("apiKey");
            tier.remove("apiKeyEnv");
            if let Some(api_key_env) = &input.api_key_env {
                tier.insert("apiKeyEnv".to_owned(), Value::String(api_key_env.clone()));
            }
        }
    }
    for tier in cleared {
        llm.insert(tier.config_key().to_owned(), Value::Null);
    }
    write_config_value(project_root, &Value::Object(root.clone()))
}

/// Change only one configured tier's bounded client concurrency.
pub fn tune_project_llm_tier(
    project_root: &Path,
    tier: ProjectLlmTier,
    concurrency: u16,
) -> Result<(), ProjectLlmConfigError> {
    if concurrency == 0 || concurrency > MAXIMUM_CONCURRENCY {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    let mut root = read_config_value(project_root)?.ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let root_object = root
        .as_object_mut()
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let llm = root_object
        .get_mut("llm")
        .and_then(Value::as_object_mut)
        .ok_or(ProjectLlmConfigError::InvalidConfig)?;
    let tier = llm
        .get_mut(tier.config_key())
        .and_then(Value::as_object_mut)
        .ok_or(ProjectLlmConfigError::InvalidTier)?;
    tier.insert("concurrency".to_owned(), Value::from(concurrency));
    write_config_value(project_root, &root)
}

/// Probe a validated endpoint without credentials, redirects, or unbounded reads.
pub async fn probe_openai_compatible_endpoint(
    endpoint: &str,
    timeout: std::time::Duration,
) -> Result<LlmEndpointProbe, ProjectLlmConfigError> {
    validate_endpoint(endpoint)?;
    if timeout.is_zero() || timeout > std::time::Duration::from_secs(10) {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
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
    let response = match client.get(models_url).send().await {
        Ok(response) => response,
        Err(_) => return Ok(unreachable_probe()),
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

fn parse_tier(
    value: &Value,
    configured_tier: ProjectLlmTier,
    requested_tier: ProjectLlmTier,
    fallback: bool,
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
        configured_tier,
        ProjectLlmTier::Embedding | ProjectLlmTier::Reranker
    );
    if !chat_tier && provider != ProjectLlmProvider::OpenAiCompat {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    let endpoint = project_tier_endpoint(value, provider)?;
    let model = project_tier_model(value, provider, configured_tier, requested_tier, fallback)?;
    let ask_model = optional_model(value, "askModel")?;
    validate_model(&model)?;
    let explicit_api_key_env = match value.get("apiKeyEnv") {
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err(ProjectLlmConfigError::InvalidTier),
        None => None,
    };
    let inline = match value.get("apiKey") {
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err(ProjectLlmConfigError::InvalidTier),
        None => None,
    };
    let api_key_env = explicit_api_key_env
        .or_else(|| (provider == ProjectLlmProvider::AnthropicApi).then_some("ANTHROPIC_API_KEY"))
        .or_else(|| {
            (provider == ProjectLlmProvider::OpenAiCompat && value.get("endpoint").is_none())
                .then_some("OPENAI_API_KEY")
        });
    if explicit_api_key_env.is_some() && inline.is_some() {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    let (api_key, credential_source) = if provider == ProjectLlmProvider::ClaudeBridge {
        if inline.is_some() || explicit_api_key_env.is_some() {
            return Err(ProjectLlmConfigError::InvalidTier);
        }
        (None, ProjectLlmCredentialSource::None)
    } else if let Some(key) = inline {
        validate_api_key(key)?;
        (
            Some(SecretString::from(key.to_owned())),
            ProjectLlmCredentialSource::InlineLegacy,
        )
    } else if let Some(name) = api_key_env {
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
                if explicit_api_key_env.is_none()
                    && value.get("endpoint").is_some()
                    && provider == ProjectLlmProvider::OpenAiCompat =>
            {
                (None, ProjectLlmCredentialSource::None)
            }
            Err(_) => return Err(ProjectLlmConfigError::CredentialUnavailable),
        }
    } else {
        (None, ProjectLlmCredentialSource::None)
    };
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
    let claude_bin = parse_claude_bin(value, provider)?;
    let llama_server_args = parse_llama_server_args(value)?;
    let externally_managed = optional_bool(value, "externallyManaged")?.unwrap_or(false);
    Ok(ProjectLlmTierConfig {
        provider,
        endpoint,
        model,
        ask_model,
        api_key,
        credential_source,
        timeout_ms,
        concurrency,
        summary_batch_size,
        claude_bin,
        llama_server_args,
        externally_managed,
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
    configured_tier: ProjectLlmTier,
    requested_tier: ProjectLlmTier,
    fallback: bool,
) -> Result<String, ProjectLlmConfigError> {
    if fallback && requested_tier == ProjectLlmTier::Ask {
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
            let model = if configured_tier == ProjectLlmTier::Summarize {
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
    if raw.is_empty() || raw.len() > MAXIMUM_ENDPOINT_BYTES || raw.chars().any(char::is_control) {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    let endpoint = Url::parse(raw).map_err(|_| ProjectLlmConfigError::InvalidTier)?;
    if endpoint.username() != ""
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || endpoint.host_str().is_none()
    {
        return Err(ProjectLlmConfigError::InvalidTier);
    }
    match endpoint.scheme() {
        "https" => Ok(()),
        "http" if endpoint.host_str().is_some_and(loopback_host) => Ok(()),
        _ => Err(ProjectLlmConfigError::InvalidTier),
    }
}

fn loopback_host(host: &str) -> bool {
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
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

fn read_config_value(project_root: &Path) -> Result<Option<Value>, ProjectLlmConfigError> {
    let path = config_path(project_root)?;
    let metadata = match fs::symlink_metadata(&path) {
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
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| ProjectLlmConfigError::InvalidConfig)
}

fn write_config_value(project_root: &Path, value: &Value) -> Result<(), ProjectLlmConfigError> {
    let root = canonical_project_root(project_root)?;
    let directory = root.join(CONFIG_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(ProjectLlmConfigError::ProjectUnavailable),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&directory).map_err(|_| ProjectLlmConfigError::WriteFailed)?;
        }
        Err(_) => return Err(ProjectLlmConfigError::ProjectUnavailable),
    }
    let path = directory.join(CONFIG_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(ProjectLlmConfigError::ProjectUnavailable);
    }
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|_| ProjectLlmConfigError::InvalidConfig)?;
    bytes.push(b'\n');
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAXIMUM_CONFIG_BYTES {
        return Err(ProjectLlmConfigError::ConfigTooLarge);
    }
    let mut temporary =
        NamedTempFile::new_in(&directory).map_err(|_| ProjectLlmConfigError::WriteFailed)?;
    set_private_permissions(temporary.as_file())?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| ProjectLlmConfigError::WriteFailed)?;
    temporary
        .persist(&path)
        .map_err(|_| ProjectLlmConfigError::WriteFailed)?;
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ProjectLlmConfigError::WriteFailed)
}

#[cfg(unix)]
fn set_private_permissions(file: &File) -> Result<(), ProjectLlmConfigError> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| ProjectLlmConfigError::WriteFailed)
}

#[cfg(not(unix))]
const fn set_private_permissions(_file: &File) -> Result<(), ProjectLlmConfigError> {
    Ok(())
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
            "http://localhost:8081",
            "fixture-chat",
        )
        .and_then(|input| input.with_concurrency(3))
        .map(ProjectLlmTierInput::without_credentials)
        .unwrap_or_else(|error| panic!("tier input failed: {error}"));
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
    fn source_settings_are_bounded_v1_compatible_and_do_not_render_patterns() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"maxFileSize":4096,"languages":["typescript","rust","rust"],"exclude":["private/**"],"extractDocstrings":false,"trackCallSites":false,"indexSubmodules":false,"indexEmbeddedRepos":true,"enableCentrality":false,"enableBetweenness":false,"enableChurn":false,"enableCoChange":false,"enableBiomarkers":false,"enableIssueHistory":false,"enableConfigRefs":false,"enableSqlRefs":false,"enableBuildContextRefs":false,"enableStringImports":false,"duplicateCodePartialClones":true,"duplicateCodeAllowlist":["generated/**","vendor-copy/**"],"llm":{"apiKey":"do-not-render"}}"#,
        )
        .unwrap_or_else(|error| panic!("source config fixture failed: {error}"));
        let settings = load_project_source_settings(root.path())
            .unwrap_or_else(|error| panic!("source settings failed: {error}"));
        assert_eq!(settings.maximum_file_bytes(), Some(4096));
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
    }

    #[test]
    fn loader_accepts_legacy_inline_secret_without_debug_disclosure() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        fs::create_dir(root.path().join(CONFIG_DIRECTORY))
            .unwrap_or_else(|error| panic!("config directory failed: {error}"));
        fs::write(
            root.path().join(CONFIG_DIRECTORY).join(CONFIG_FILE),
            r#"{"llm":{"summarizeLlm":{"provider":"openai-compat","endpoint":"https://example.test","model":"fixture","apiKey":"do-not-print"}}}"#,
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
        for endpoint in [
            "http://example.test",
            "https://user:secret@example.test",
            "file:///tmp/model",
        ] {
            assert!(ProjectLlmTierInput::new(ProjectLlmTier::Ask, endpoint, "model").is_err());
        }
        assert!(
            ProjectLlmTierInput::new(ProjectLlmTier::Ask, "https://example.test", "model")
                .and_then(|input| input.with_api_key_env("bad-name"))
                .is_err()
        );
    }
}
