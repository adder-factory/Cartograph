use std::{
    env,
    io::{self, IsTerminal as _, Write as _},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, Instant},
};

use cartograph_config::{DATABASE_URL_ENV, DatabaseSettings};
use cartograph_db::{CartographDatabase, DEFAULT_MANAGED_DATABASE_PORT, ManagedDatabase};
use cartograph_llm::{
    ChatSettings, EmbeddingSettings, InstallModelsOptions, OpenAiChatClient, OpenAiEmbeddingClient,
    OpenAiRerankClient, ProjectLlmTier, ProjectLlmTierInput, RerankSettings,
    install_recommended_models, load_exact_project_llm_tier, probe_openai_compatible_endpoint,
    write_project_llm_configuration,
};
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAXIMUM_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_MODEL_CONCURRENCY: u16 = 2;

#[derive(Debug, Subcommand)]
pub(super) enum LlmCommand {
    /// Select detected/local/cloud providers and atomically update config.json.
    Setup(SetupArguments),
    /// Send small real requests to every required or explicitly configured tier.
    Smoke(SmokeArguments),
    /// Download checksum-pinned recommended GGUFs and write the local stack config.
    Install(InstallArguments),
}

#[derive(Debug, Args)]
pub(super) struct SetupArguments {
    /// Existing project root.
    #[arg(default_value = ".")]
    path: PathBuf,
    /// Apply a preset non-interactively; omit for the interactive detector.
    #[arg(long, value_enum)]
    preset: Option<SetupPreset>,
    /// Custom preset tier.
    #[arg(long, value_enum)]
    tier: Option<LlmTierArgument>,
    /// Custom OpenAI-compatible base or complete API endpoint.
    #[arg(long)]
    endpoint: Option<String>,
    /// Custom provider model identifier.
    #[arg(long)]
    model: Option<String>,
    /// Environment-variable name containing the provider credential.
    #[arg(long)]
    api_key_env: Option<String>,
    /// Omit the 7B ask tier and reranker from local presets.
    #[arg(long)]
    minimal: bool,
    /// Apply the detected recommendation without prompting.
    #[arg(long)]
    yes: bool,
    /// Print structured JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
pub(super) struct SmokeArguments {
    /// Existing project root.
    #[arg(default_value = ".")]
    path: PathBuf,
    /// Per-tier request deadline in milliseconds.
    #[arg(long, default_value_t = DEFAULT_TIMEOUT_MS, value_parser = clap::value_parser!(u64).range(1..=MAXIMUM_TIMEOUT_MS))]
    timeout_ms: u64,
    /// Print structured JSON instead of Markdown.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
pub(super) struct InstallArguments {
    /// Existing project root.
    #[arg(default_value = ".")]
    path: PathBuf,
    /// Install only embedding and 3B chat models.
    #[arg(long)]
    minimal: bool,
    /// Skip model downloads; useful when another provider manages its models.
    #[arg(long)]
    no_models: bool,
    /// Model directory (defaults to ~/.cartograph/models).
    #[arg(long)]
    dir: Option<PathBuf>,
    /// Parallel checksum-bounded model downloads.
    #[arg(long, default_value_t = 2, value_parser = clap::value_parser!(u16).range(1..=4))]
    concurrency: u16,
    /// Storage provider compatibility selector. Cartograph v2 accepts PostgreSQL only.
    #[arg(long)]
    database_provider: Option<String>,
    /// Secret-bearing PostgreSQL URL used only by this process and never persisted.
    #[arg(long)]
    database_url: Option<String>,
    /// Validated PostgreSQL schema for this project.
    #[arg(long)]
    database_schema: Option<String>,
    /// pgvector compatibility selector. V2 requires auto or require.
    #[arg(long)]
    database_pgvector: Option<String>,
    /// Bounded PostgreSQL connection-pool size.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=64))]
    database_max_connections: Option<u32>,
    /// PostgreSQL statement timeout in milliseconds.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=600_000))]
    database_query_timeout_ms: Option<u64>,
    /// PostgreSQL connection acquisition timeout in seconds.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=120))]
    database_connection_timeout_seconds: Option<u64>,
    /// Require TLS at the PostgreSQL driver boundary.
    #[arg(long)]
    database_ssl: bool,
    /// Print structured JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
enum SetupPreset {
    #[value(name = "install-llama-cpp", alias = "local-llama-cpp")]
    LocalLlamaCpp,
    #[value(name = "install-ollama", alias = "ollama")]
    Ollama,
    InstallMlx,
    CloudOpenAi,
    CloudOpenAiCompat,
    HybridClaudeBridge,
    HybridAnthropicApi,
    Custom,
    Skip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum LlmTierArgument {
    Embed,
    Chat,
    Local,
    Ask,
    Classify,
    Reranker,
}

impl From<LlmTierArgument> for ProjectLlmTier {
    fn from(value: LlmTierArgument) -> Self {
        match value {
            LlmTierArgument::Embed => Self::Embedding,
            LlmTierArgument::Chat => Self::Summarize,
            LlmTierArgument::Local => Self::Local,
            LlmTierArgument::Ask => Self::Ask,
            LlmTierArgument::Classify => Self::Classify,
            LlmTierArgument::Reranker => Self::Reranker,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupReport {
    applied: bool,
    preset: SetupPreset,
    detected: Vec<DetectedEndpoint>,
    configured_tiers: Vec<ProjectLlmTier>,
    cleared_tiers: Vec<ProjectLlmTier>,
    next_steps: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectedEndpoint {
    endpoint: String,
    reachable: bool,
    openai_compatible: bool,
    models: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SmokeStatus {
    Ok,
    Skip,
    Fail,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeRow {
    tier: &'static str,
    status: SmokeStatus,
    model: Option<String>,
    endpoint: Option<String>,
    duration_ms: u64,
    detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum OverallSmokeStatus {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeReport {
    overall_status: OverallSmokeStatus,
    rows: Vec<SmokeRow>,
    duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallReport {
    models: Option<cartograph_llm::InstallModelsReport>,
    config_written: bool,
    minimal: bool,
    database: &'static str,
    database_migrations_applied: usize,
    doctor: crate::DoctorReport,
    next_steps: Vec<String>,
}

pub(super) async fn run(command: LlmCommand) -> Result<ExitCode, String> {
    match command {
        LlmCommand::Setup(arguments) => run_setup(arguments).await,
        LlmCommand::Smoke(arguments) => run_smoke(arguments).await,
        LlmCommand::Install(arguments) => run_install(arguments).await,
    }
}

/// Apply only missing required LLM tiers for `doctor --fix`.
///
/// Existing tier choices and credentials are never replaced. A detected Ollama
/// endpoint is reused; otherwise the checksum-pinned minimal llama.cpp model
/// set is installed and configured. Starting provider processes remains an
/// explicit operator action.
pub(super) async fn doctor_fix_missing_tiers(project: &Path) -> Result<Vec<String>, String> {
    let required = [ProjectLlmTier::Embedding, ProjectLlmTier::Summarize];
    let mut missing = Vec::new();
    for tier in required {
        match load_exact_project_llm_tier(project, tier) {
            Ok(Some(_)) => {}
            Ok(None) => missing.push(tier),
            Err(error) => return Err(error.to_string()),
        }
    }
    if missing.is_empty() {
        return Ok(Vec::new());
    }

    let detected = detect_endpoints().await;
    let preset = recommend_preset(&detected);
    let (recommended, source) = match preset {
        SetupPreset::Ollama => (ollama_inputs(true)?.0, "detected Ollama".to_owned()),
        SetupPreset::LocalLlamaCpp => {
            let directory = default_models_directory()?;
            install_recommended_models(
                InstallModelsOptions::new(directory.clone(), true, DEFAULT_MODEL_CONCURRENCY)
                    .map_err(|error| error.to_string())?,
            )
            .await
            .map_err(|error| error.to_string())?;
            (
                local_inputs_in(&directory, true)?.0,
                "checksum-pinned minimal llama.cpp models".to_owned(),
            )
        }
        SetupPreset::InstallMlx
        | SetupPreset::CloudOpenAi
        | SetupPreset::CloudOpenAiCompat
        | SetupPreset::HybridClaudeBridge
        | SetupPreset::HybridAnthropicApi
        | SetupPreset::Custom
        | SetupPreset::Skip => {
            return Err("doctor could not select an automatic LLM repair preset".to_owned());
        }
    };
    let inputs = recommended
        .into_iter()
        .filter(|input| missing.contains(&input.tier()))
        .collect::<Vec<_>>();
    write_project_llm_configuration(project, &inputs, &[]).map_err(|error| error.to_string())?;
    Ok(vec![format!(
        "configured {} missing required LLM tier(s) from {source}",
        inputs.len()
    )])
}

async fn run_setup(arguments: SetupArguments) -> Result<ExitCode, String> {
    let detected = detect_endpoints().await;
    let recommended = recommend_preset(&detected);
    let preset = match arguments.preset {
        Some(preset) => preset,
        None if arguments.yes => recommended,
        None if io::stdin().is_terminal() && io::stdout().is_terminal() => {
            prompt_preset(recommended)?
        }
        None => {
            render_detection(&detected, recommended);
            return Err(
                "non-interactive setup requires --preset (or --yes to apply the detected recommendation)"
                    .to_owned(),
            );
        }
    };
    let (inputs, cleared) = setup_inputs(&arguments, preset)?;
    let applied = preset != SetupPreset::Skip;
    if applied {
        write_project_llm_configuration(&arguments.path, &inputs, &cleared)
            .map_err(|error| error.to_string())?;
    }
    let report = SetupReport {
        applied,
        preset,
        detected,
        configured_tiers: inputs.iter().map(ProjectLlmTierInput::tier).collect(),
        cleared_tiers: cleared,
        next_steps: if applied {
            vec![
                "Start or restart the configured provider processes.".to_owned(),
                format!("Run `cartograph llm smoke {}`.", arguments.path.display()),
                format!("Run `cartograph doctor {}`.", arguments.path.display()),
            ]
        } else {
            vec![
                "Deterministic BM25 and graph retrieval remain available without an LLM."
                    .to_owned(),
            ]
        },
    };
    if arguments.json {
        print_json(&report)?;
    } else {
        println!(
            "LLM setup {} ({preset:?}); configured {} tier(s), cleared {}.",
            if applied { "applied" } else { "skipped" },
            report.configured_tiers.len(),
            report.cleared_tiers.len()
        );
        for step in &report.next_steps {
            println!("- {step}");
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn setup_inputs(
    arguments: &SetupArguments,
    preset: SetupPreset,
) -> Result<(Vec<ProjectLlmTierInput>, Vec<ProjectLlmTier>), String> {
    match preset {
        SetupPreset::LocalLlamaCpp => {
            reject_custom_fields(arguments)?;
            local_inputs(arguments.minimal)
        }
        SetupPreset::Ollama => {
            reject_custom_fields(arguments)?;
            ollama_inputs(arguments.minimal)
        }
        SetupPreset::HybridClaudeBridge => hybrid_claude_inputs(arguments),
        SetupPreset::HybridAnthropicApi => hybrid_anthropic_inputs(arguments),
        SetupPreset::CloudOpenAi => cloud_openai_inputs(arguments),
        SetupPreset::InstallMlx | SetupPreset::CloudOpenAiCompat | SetupPreset::Custom => {
            custom_inputs(arguments)
        }
        SetupPreset::Skip => {
            reject_custom_fields(arguments)?;
            Ok((Vec::new(), Vec::new()))
        }
    }
}

fn reject_custom_fields(arguments: &SetupArguments) -> Result<(), String> {
    if arguments.tier.is_some()
        || arguments.endpoint.is_some()
        || arguments.model.is_some()
        || arguments.api_key_env.is_some()
    {
        Err("--tier, --endpoint, --model, and --api-key-env require --preset custom".to_owned())
    } else {
        Ok(())
    }
}

fn local_inputs(minimal: bool) -> Result<(Vec<ProjectLlmTierInput>, Vec<ProjectLlmTier>), String> {
    let directory = default_models_directory()?;
    local_inputs_in(&directory, minimal)
}

fn ollama_inputs(minimal: bool) -> Result<(Vec<ProjectLlmTierInput>, Vec<ProjectLlmTier>), String> {
    let endpoint = "http://127.0.0.1:11434";
    let mut inputs = vec![
        tier_input(ProjectLlmTier::Embedding, endpoint, "nomic-embed-text", 4)?,
        tier_input(
            ProjectLlmTier::Summarize,
            endpoint,
            "qwen2.5-coder:3b",
            DEFAULT_MODEL_CONCURRENCY,
        )?,
        tier_input(
            ProjectLlmTier::Local,
            endpoint,
            "qwen2.5-coder:3b",
            DEFAULT_MODEL_CONCURRENCY,
        )?,
        tier_input(
            ProjectLlmTier::Classify,
            endpoint,
            "qwen2.5-coder:3b",
            DEFAULT_MODEL_CONCURRENCY,
        )?,
    ];
    if !minimal {
        inputs.push(tier_input(
            ProjectLlmTier::Ask,
            endpoint,
            "qwen2.5-coder:7b",
            1,
        )?);
    }
    Ok((
        inputs,
        vec![ProjectLlmTier::Reranker]
            .into_iter()
            .chain(minimal.then_some(ProjectLlmTier::Ask))
            .collect(),
    ))
}

fn custom_inputs(
    arguments: &SetupArguments,
) -> Result<(Vec<ProjectLlmTierInput>, Vec<ProjectLlmTier>), String> {
    if arguments.minimal {
        return Err("--minimal applies only to local-llama-cpp and ollama presets".to_owned());
    }
    let tier = arguments
        .tier
        .ok_or_else(|| "--preset custom requires --tier".to_owned())?;
    let endpoint = arguments
        .endpoint
        .as_deref()
        .ok_or_else(|| "--preset custom requires --endpoint".to_owned())?;
    let model = arguments
        .model
        .as_deref()
        .ok_or_else(|| "--preset custom requires --model".to_owned())?;
    let mut input = ProjectLlmTierInput::new(tier.into(), endpoint, model)
        .map_err(|error| error.to_string())?;
    if let Some(name) = &arguments.api_key_env {
        input = input
            .with_api_key_env(name)
            .map_err(|error| error.to_string())?;
    }
    Ok((vec![input], Vec::new()))
}

fn cloud_openai_inputs(
    arguments: &SetupArguments,
) -> Result<(Vec<ProjectLlmTierInput>, Vec<ProjectLlmTier>), String> {
    if arguments.minimal {
        return Err("--minimal applies only to local model presets".to_owned());
    }
    let tier = arguments
        .tier
        .ok_or_else(|| "--preset cloud-open-ai requires --tier".to_owned())?;
    let model = arguments
        .model
        .as_deref()
        .ok_or_else(|| "--preset cloud-open-ai requires --model".to_owned())?;
    let mut input = ProjectLlmTierInput::new(
        tier.into(),
        arguments
            .endpoint
            .as_deref()
            .unwrap_or("https://api.openai.com"),
        model,
    )
    .map_err(|error| error.to_string())?;
    input = input
        .with_api_key_env(arguments.api_key_env.as_deref().unwrap_or("OPENAI_API_KEY"))
        .map_err(|error| error.to_string())?;
    Ok((vec![input], Vec::new()))
}

fn hybrid_claude_inputs(
    arguments: &SetupArguments,
) -> Result<(Vec<ProjectLlmTierInput>, Vec<ProjectLlmTier>), String> {
    if arguments.minimal
        || arguments.tier.is_some()
        || arguments.endpoint.is_some()
        || arguments.model.is_some()
        || arguments.api_key_env.is_some()
    {
        return Err(
            "hybrid-claude-bridge uses its bounded default tiers and accepts no custom tier fields"
                .to_owned(),
        );
    }
    let mut inputs = vec![hybrid_embedding_input()?];
    inputs.push(
        ProjectLlmTierInput::claude_bridge(ProjectLlmTier::Summarize, "claude-haiku-4-5")
            .and_then(|input| input.with_ask_model("claude-sonnet-4-6"))
            .and_then(|input| input.with_summary_batch_size(3))
            .map_err(|error| error.to_string())?,
    );
    for (tier, model) in [
        (ProjectLlmTier::Local, "claude-sonnet-4-6"),
        (ProjectLlmTier::Ask, "claude-sonnet-4-6"),
        (ProjectLlmTier::Classify, "claude-haiku-4-5"),
    ] {
        inputs.push(
            ProjectLlmTierInput::claude_bridge(tier, model).map_err(|error| error.to_string())?,
        );
    }
    Ok((inputs, vec![ProjectLlmTier::Reranker]))
}

fn hybrid_anthropic_inputs(
    arguments: &SetupArguments,
) -> Result<(Vec<ProjectLlmTierInput>, Vec<ProjectLlmTier>), String> {
    if arguments.minimal
        || arguments.tier.is_some()
        || arguments.endpoint.is_some()
        || arguments.model.is_some()
    {
        return Err(
            "hybrid-anthropic-api uses its bounded default chat tiers; only --api-key-env may override credential lookup"
                .to_owned(),
        );
    }
    let make = |tier, model| -> Result<ProjectLlmTierInput, String> {
        let mut input =
            ProjectLlmTierInput::anthropic_api(tier, model).map_err(|error| error.to_string())?;
        if let Some(name) = &arguments.api_key_env {
            input = input
                .with_api_key_env(name)
                .map_err(|error| error.to_string())?;
        }
        Ok(input)
    };
    let mut inputs = vec![hybrid_embedding_input()?];
    inputs.push(
        make(ProjectLlmTier::Summarize, "claude-haiku-4-5")?
            .with_ask_model("claude-sonnet-4-6")
            .and_then(|input| input.with_summary_batch_size(3))
            .map_err(|error| error.to_string())?,
    );
    inputs.push(make(ProjectLlmTier::Local, "claude-sonnet-4-6")?);
    inputs.push(make(ProjectLlmTier::Ask, "claude-sonnet-4-6")?);
    inputs.push(make(ProjectLlmTier::Classify, "claude-haiku-4-5")?);
    Ok((inputs, vec![ProjectLlmTier::Reranker]))
}

fn hybrid_embedding_input() -> Result<ProjectLlmTierInput, String> {
    let model = default_models_directory()?
        .join("jina-embeddings-v2-base-code.Q4_K_M.gguf")
        .to_string_lossy()
        .into_owned();
    tier_input(ProjectLlmTier::Embedding, "http://127.0.0.1:8080", model, 4)
}

fn tier_input(
    tier: ProjectLlmTier,
    endpoint: &str,
    model: impl Into<String>,
    concurrency: u16,
) -> Result<ProjectLlmTierInput, String> {
    ProjectLlmTierInput::new(tier, endpoint, model)
        .and_then(|input| input.with_concurrency(concurrency))
        .map(ProjectLlmTierInput::without_credentials)
        .map_err(|error| error.to_string())
}

async fn detect_endpoints() -> Vec<DetectedEndpoint> {
    let (llama_embed, llama_chat, ollama, mlx, studio) = tokio::join!(
        detect_one("http://127.0.0.1:8080"),
        detect_one("http://127.0.0.1:8081"),
        detect_one("http://127.0.0.1:11434"),
        detect_one("http://127.0.0.1:8000"),
        detect_one("http://127.0.0.1:1234"),
    );
    vec![llama_embed, llama_chat, ollama, mlx, studio]
}

async fn detect_one(endpoint: &str) -> DetectedEndpoint {
    let probe = probe_openai_compatible_endpoint(endpoint, Duration::from_secs(2)).await;
    match probe {
        Ok(probe) => DetectedEndpoint {
            endpoint: endpoint.to_owned(),
            reachable: probe.reachable,
            openai_compatible: probe.openai_compatible,
            models: probe.models,
        },
        Err(_) => DetectedEndpoint {
            endpoint: endpoint.to_owned(),
            reachable: false,
            openai_compatible: false,
            models: Vec::new(),
        },
    }
}

fn recommend_preset(detected: &[DetectedEndpoint]) -> SetupPreset {
    if detected
        .iter()
        .any(|entry| entry.endpoint.ends_with(":11434") && entry.openai_compatible)
    {
        SetupPreset::Ollama
    } else {
        SetupPreset::LocalLlamaCpp
    }
}

fn prompt_preset(recommended: SetupPreset) -> Result<SetupPreset, String> {
    println!("Detected LLM providers. Choose a setup preset:");
    println!("  1) local-llama-cpp");
    println!("  2) ollama");
    println!("  3) hybrid-claude-bridge");
    println!("  4) hybrid-anthropic-api");
    println!("  5) cloud-open-ai (use non-interactive tier/model flags)");
    println!("  6) custom OpenAI-compatible (use non-interactive flags)");
    println!("  7) skip");
    print!("Choice [{:?}]: ", recommended);
    io::stdout()
        .flush()
        .map_err(|_| "could not prompt for LLM setup".to_owned())?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|_| "could not read LLM setup choice".to_owned())?;
    match answer.trim() {
        "" => Ok(recommended),
        "1" | "local-llama-cpp" => Ok(SetupPreset::LocalLlamaCpp),
        "2" | "ollama" => Ok(SetupPreset::Ollama),
        "3" | "hybrid-claude-bridge" => Ok(SetupPreset::HybridClaudeBridge),
        "4" | "hybrid-anthropic-api" => Ok(SetupPreset::HybridAnthropicApi),
        "5" | "cloud-open-ai" => Err(
            "cloud OpenAI setup requires --preset cloud-open-ai --tier <tier> --model <id>"
                .to_owned(),
        ),
        "6" | "custom" => Err(
            "custom setup requires --preset custom --tier <tier> --endpoint <url> --model <id>"
                .to_owned(),
        ),
        "7" | "skip" => Ok(SetupPreset::Skip),
        _ => Err("LLM setup choice was not recognized".to_owned()),
    }
}

fn render_detection(detected: &[DetectedEndpoint], recommended: SetupPreset) {
    println!("LLM setup recommendation: {recommended:?}");
    for endpoint in detected.iter().filter(|entry| entry.reachable) {
        println!(
            "- {}: {} ({} model(s))",
            endpoint.endpoint,
            if endpoint.openai_compatible {
                "OpenAI-compatible"
            } else {
                "reachable but incompatible"
            },
            endpoint.models.len()
        );
    }
}

async fn run_smoke(arguments: SmokeArguments) -> Result<ExitCode, String> {
    let started = Instant::now();
    let timeout = Duration::from_millis(arguments.timeout_ms);
    let (embedding, summarize, ask, local, classify, rerank) = tokio::join!(
        smoke_embedding(&arguments.path, timeout),
        smoke_chat(
            &arguments.path,
            ProjectLlmTier::Summarize,
            "summarize",
            true,
            timeout
        ),
        smoke_chat(&arguments.path, ProjectLlmTier::Ask, "ask", false, timeout),
        smoke_chat(
            &arguments.path,
            ProjectLlmTier::Local,
            "local",
            false,
            timeout
        ),
        smoke_chat(
            &arguments.path,
            ProjectLlmTier::Classify,
            "classify",
            false,
            timeout
        ),
        smoke_rerank(&arguments.path, timeout),
    );
    let rows = vec![embedding, summarize, ask, local, classify, rerank];
    let overall_status = if rows.iter().any(|row| row.status == SmokeStatus::Fail) {
        OverallSmokeStatus::Fail
    } else if rows.iter().any(|row| row.status == SmokeStatus::Skip) {
        OverallSmokeStatus::Warn
    } else {
        OverallSmokeStatus::Ok
    };
    let report = SmokeReport {
        overall_status,
        rows,
        duration_ms: elapsed_ms(started),
    };
    if arguments.json {
        print_json(&report)?;
    } else {
        render_smoke(&report);
    }
    Ok(if overall_status == OverallSmokeStatus::Fail {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

async fn smoke_embedding(project: &Path, timeout: Duration) -> SmokeRow {
    let started = Instant::now();
    let configured = match load_exact_project_llm_tier(project, ProjectLlmTier::Embedding) {
        Ok(Some(config)) => config,
        Ok(None) => return missing_row("embedding", true, started),
        Err(error) => return failed_row("embedding", None, None, started, error.to_string()),
    };
    let model = Some(configured.model().to_owned());
    let endpoint = Some(configured.endpoint().to_owned());
    let result = async {
        let settings = EmbeddingSettings::new(
            configured.endpoint(),
            configured.model(),
            configured.api_key(),
        )
        .map_err(|error| error.to_string())?;
        let client = OpenAiEmbeddingClient::new(settings).map_err(|error| error.to_string())?;
        let batch = client
            .embed(&["Cartograph LLM smoke embedding probe".to_owned()])
            .await
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(batch.dimension())
    };
    match tokio::time::timeout(timeout, result).await {
        Ok(Ok(dimension)) => ok_row(
            "embedding",
            model,
            endpoint,
            started,
            format!("one finite vector returned ({dimension} dimensions)"),
        ),
        Ok(Err(error)) => failed_row("embedding", model, endpoint, started, error),
        Err(_) => failed_row(
            "embedding",
            model,
            endpoint,
            started,
            "request timed out".to_owned(),
        ),
    }
}

async fn smoke_chat(
    project: &Path,
    tier: ProjectLlmTier,
    label: &'static str,
    required: bool,
    timeout: Duration,
) -> SmokeRow {
    let started = Instant::now();
    let configured = match load_exact_project_llm_tier(project, tier) {
        Ok(Some(config)) => config,
        Ok(None) => return missing_row(label, required, started),
        Err(error) => return failed_row(label, None, None, started, error.to_string()),
    };
    let model = Some(configured.model().to_owned());
    let endpoint = Some(configured.endpoint().to_owned());
    let result = async {
        let settings =
            ChatSettings::from_project_config(&configured).map_err(|error| error.to_string())?;
        OpenAiChatClient::new(settings)
            .map_err(|error| error.to_string())?
            .complete_message(
                "Reply with a short acknowledgement.",
                "Cartograph LLM smoke test",
                Some(24),
            )
            .await
            .map_err(|error| error.to_string())
    };
    match tokio::time::timeout(timeout, result).await {
        Ok(Ok(completion)) => ok_row(
            label,
            model,
            endpoint,
            started,
            format!(
                "chat completion returned {} UTF-8 bytes",
                completion.content().len()
            ),
        ),
        Ok(Err(error)) => failed_row(label, model, endpoint, started, error),
        Err(_) => failed_row(
            label,
            model,
            endpoint,
            started,
            "request timed out".to_owned(),
        ),
    }
}

async fn smoke_rerank(project: &Path, timeout: Duration) -> SmokeRow {
    let started = Instant::now();
    let configured = match load_exact_project_llm_tier(project, ProjectLlmTier::Reranker) {
        Ok(Some(config)) => config,
        Ok(None) => return missing_row("rerank", false, started),
        Err(error) => return failed_row("rerank", None, None, started, error.to_string()),
    };
    let model = Some(configured.model().to_owned());
    let endpoint = Some(configured.endpoint().to_owned());
    let result = async {
        let settings = RerankSettings::try_from_project(project)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "rerankerLlm is not configured".to_owned())?;
        OpenAiRerankClient::new(settings)
            .map_err(|error| error.to_string())?
            .rerank(
                "code graph search",
                &[
                    "code graph symbol search".to_owned(),
                    "banana bread recipe".to_owned(),
                ],
            )
            .await
            .map_err(|error| error.to_string())
    };
    match tokio::time::timeout(timeout, result).await {
        Ok(Ok(batch)) => ok_row(
            "rerank",
            model,
            endpoint,
            started,
            format!("{} finite normalized scores returned", batch.scores().len()),
        ),
        Ok(Err(error)) => failed_row("rerank", model, endpoint, started, error),
        Err(_) => failed_row(
            "rerank",
            model,
            endpoint,
            started,
            "request timed out".to_owned(),
        ),
    }
}

fn ok_row(
    tier: &'static str,
    model: Option<String>,
    endpoint: Option<String>,
    started: Instant,
    detail: String,
) -> SmokeRow {
    SmokeRow {
        tier,
        status: SmokeStatus::Ok,
        model,
        endpoint,
        duration_ms: elapsed_ms(started),
        detail,
    }
}

fn failed_row(
    tier: &'static str,
    model: Option<String>,
    endpoint: Option<String>,
    started: Instant,
    detail: String,
) -> SmokeRow {
    SmokeRow {
        tier,
        status: SmokeStatus::Fail,
        model,
        endpoint,
        duration_ms: elapsed_ms(started),
        detail,
    }
}

fn missing_row(tier: &'static str, required: bool, started: Instant) -> SmokeRow {
    SmokeRow {
        tier,
        status: if required {
            SmokeStatus::Fail
        } else {
            SmokeStatus::Skip
        },
        model: None,
        endpoint: None,
        duration_ms: elapsed_ms(started),
        detail: if required {
            format!("{tier} LLM tier is not configured")
        } else {
            format!("{tier} tier is not configured; summarize/cosine fallback remains active")
        },
    }
}

fn render_smoke(report: &SmokeReport) {
    println!("## cartograph llm smoke\n");
    for row in &report.rows {
        let marker = match row.status {
            SmokeStatus::Ok => "✓",
            SmokeStatus::Skip => "○",
            SmokeStatus::Fail => "✗",
        };
        let location = match (&row.endpoint, &row.model) {
            (Some(endpoint), Some(model)) => format!(" — {endpoint} / {model}"),
            _ => String::new(),
        };
        println!(
            "{marker} **{}**{location} ({}ms)\n  {}",
            row.tier, row.duration_ms, row.detail
        );
    }
    println!(
        "\nOverall: {:?} ({}ms)",
        report.overall_status, report.duration_ms
    );
}

async fn run_install(arguments: InstallArguments) -> Result<ExitCode, String> {
    let project = arguments
        .path
        .canonicalize()
        .map_err(|_| "LLM install project path must be an existing directory".to_owned())?;
    if !project.is_dir() {
        return Err("LLM install project path must be an existing directory".to_owned());
    }
    let mut state_fixes = Vec::new();
    let mut state_checks = Vec::new();
    crate::check_or_fix_project_state(&project, true, &mut state_fixes, &mut state_checks)?;
    if state_checks
        .iter()
        .any(|check| check.status == crate::DoctorStatus::Fail)
    {
        return Err("LLM install could not initialize private project state".to_owned());
    }
    let explicit_database = resolve_install_database_settings(&arguments)?;
    let (database, database_migrations_applied, doctor_settings) =
        if let Some(settings) = explicit_database {
            let pool = cartograph_db::connect(&settings)
                .await
                .map_err(|error| error.to_string())?;
            let database = CartographDatabase::new(pool, settings.schema().clone());
            let migrations = database
                .migrate()
                .await
                .map_err(|error| error.to_string())?;
            database.close().await;
            (
                "external",
                migrations.applied_versions.len(),
                Some(settings),
            )
        } else {
            let report = ManagedDatabase::new(&project, DEFAULT_MANAGED_DATABASE_PORT)
                .map_err(|error| error.to_string())?
                .lifecycle()
                .start()
                .await
                .map_err(|error| error.to_string())?;
            ("managed", report.migrations.applied_versions.len(), None)
        };
    let directory = arguments.dir.unwrap_or(default_models_directory()?);
    let models = if arguments.no_models {
        None
    } else {
        Some(
            install_recommended_models(
                InstallModelsOptions::new(
                    directory.clone(),
                    arguments.minimal,
                    arguments.concurrency,
                )
                .map_err(|error| error.to_string())?,
            )
            .await
            .map_err(|error| error.to_string())?,
        )
    };
    let config_written = !arguments.no_models;
    if config_written {
        let (inputs, cleared) = local_inputs_in(&directory, arguments.minimal)?;
        write_project_llm_configuration(&project, &inputs, &cleared)
            .map_err(|error| error.to_string())?;
    }
    let doctor = crate::build_doctor_report_with_settings(
        project.clone(),
        false,
        false,
        doctor_settings.as_ref(),
    )
    .await?;
    let report = InstallReport {
        models,
        config_written,
        minimal: arguments.minimal,
        database,
        database_migrations_applied,
        doctor,
        next_steps: if config_written {
            vec![
                format!("Run `cartograph backend start {}`.", project.display()),
                format!("Run `cartograph llm smoke {}`.", project.display()),
            ]
        } else {
            vec![format!(
                "Run `cartograph llm setup {}` to select the externally managed provider.",
                project.display()
            )]
        },
    };
    if arguments.json {
        print_json(&report)?;
    } else {
        println!(
            "LLM install complete: downloads={}, configWritten={}, database={}",
            report.models.is_some(),
            report.config_written,
            report.database,
        );
        for step in &report.next_steps {
            println!("- {step}");
        }
        println!();
        print!("{}", crate::render_doctor_report(&report.doctor));
    }
    Ok(if report.doctor.ready {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

fn resolve_install_database_settings(
    arguments: &InstallArguments,
) -> Result<Option<DatabaseSettings>, String> {
    match arguments.database_provider.as_deref() {
        None | Some("postgres" | "postgresql") => {}
        Some("sqlite") => {
            return Err(
                "SQLite was intentionally removed in Cartograph v2; use PostgreSQL 18 with ParadeDB and pgvector"
                    .to_owned(),
            );
        }
        Some(_) => return Err("database provider must be postgres or postgresql".to_owned()),
    }
    match arguments.database_pgvector.as_deref() {
        None | Some("auto" | "require") => {}
        Some("off") => {
            return Err("pgvector cannot be disabled in Cartograph v2".to_owned());
        }
        Some(_) => return Err("database pgvector mode must be auto or require".to_owned()),
    }

    let connection_override = arguments.database_url.is_some()
        || arguments.database_schema.is_some()
        || arguments.database_max_connections.is_some()
        || arguments.database_query_timeout_ms.is_some()
        || arguments.database_connection_timeout_seconds.is_some()
        || arguments.database_ssl;
    let mut settings = if let Some(url) = arguments.database_url.as_deref() {
        DatabaseSettings::parse(url, None, None).map_err(|error| error.to_string())?
    } else if env::var_os(DATABASE_URL_ENV).is_some() {
        DatabaseSettings::from_env().map_err(|error| error.to_string())?
    } else if connection_override {
        return Err(
            "--database-url or CARTOGRAPH_DATABASE_URL is required with external PostgreSQL connection overrides"
                .to_owned(),
        );
    } else {
        return Ok(None);
    };
    if let Some(max_connections) = arguments.database_max_connections {
        settings = settings
            .with_max_connections(max_connections)
            .map_err(|error| error.to_string())?;
    }
    if let Some(seconds) = arguments.database_connection_timeout_seconds {
        settings = settings
            .with_acquire_timeout_ms(seconds.saturating_mul(1_000))
            .map_err(|error| error.to_string())?;
    }
    if let Some(query_timeout_ms) = arguments.database_query_timeout_ms {
        let raw = query_timeout_ms.to_string();
        settings = settings
            .with_query_timeout_ms(Some(&raw))
            .map_err(|error| error.to_string())?;
    }
    if let Some(schema) = arguments.database_schema.as_deref() {
        settings = settings
            .with_schema(schema)
            .map_err(|error| error.to_string())?;
    }
    if arguments.database_ssl {
        settings = settings.with_require_ssl(true);
    }
    Ok(Some(settings))
}

fn local_inputs_in(
    directory: &Path,
    minimal: bool,
) -> Result<(Vec<ProjectLlmTierInput>, Vec<ProjectLlmTier>), String> {
    let model = |filename: &str| directory.join(filename).to_string_lossy().into_owned();
    let mut inputs = vec![
        tier_input(
            ProjectLlmTier::Embedding,
            "http://127.0.0.1:8080",
            model("jina-embeddings-v2-base-code.Q4_K_M.gguf"),
            4,
        )?,
        tier_input(
            ProjectLlmTier::Summarize,
            "http://127.0.0.1:8081",
            model("qwen2.5-coder-3b-instruct-q4_k_m.gguf"),
            2,
        )?,
        tier_input(
            ProjectLlmTier::Local,
            "http://127.0.0.1:8081",
            model("qwen2.5-coder-3b-instruct-q4_k_m.gguf"),
            2,
        )?,
        tier_input(
            ProjectLlmTier::Classify,
            "http://127.0.0.1:8081",
            model("qwen2.5-coder-3b-instruct-q4_k_m.gguf"),
            2,
        )?,
    ];
    let cleared = if minimal {
        vec![ProjectLlmTier::Ask, ProjectLlmTier::Reranker]
    } else {
        inputs.push(tier_input(
            ProjectLlmTier::Ask,
            "http://127.0.0.1:8082",
            model("qwen2.5-coder-7b-instruct-q4_k_m.gguf"),
            1,
        )?);
        inputs.push(tier_input(
            ProjectLlmTier::Reranker,
            "http://127.0.0.1:8083",
            model("bge-reranker-v2-m3-Q4_K_M.gguf"),
            2,
        )?);
        Vec::new()
    };
    Ok((inputs, cleared))
}

fn default_models_directory() -> Result<PathBuf, String> {
    let root = match env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        Some(home) => PathBuf::from(home),
        None => env::current_dir()
            .map_err(|_| "could not resolve the Cartograph models directory".to_owned())?,
    };
    Ok(root.join(".cartograph").join("models"))
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn print_json(value: &impl Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .map_err(|_| "could not serialize LLM report".to_owned())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_arguments(path: &Path) -> SetupArguments {
        SetupArguments {
            path: path.to_path_buf(),
            preset: None,
            tier: None,
            endpoint: None,
            model: None,
            api_key_env: None,
            minimal: false,
            yes: false,
            json: false,
        }
    }

    fn install_arguments() -> InstallArguments {
        InstallArguments {
            path: PathBuf::from("."),
            minimal: false,
            no_models: true,
            dir: None,
            concurrency: 2,
            database_provider: None,
            database_url: None,
            database_schema: None,
            database_pgvector: None,
            database_max_connections: None,
            database_query_timeout_ms: None,
            database_connection_timeout_seconds: None,
            database_ssl: false,
            json: false,
        }
    }

    #[test]
    fn presets_preserve_split_chat_and_minimal_fallback_contracts() {
        let (full, cleared) =
            ollama_inputs(false).unwrap_or_else(|error| panic!("ollama preset failed: {error}"));
        assert!(
            full.iter()
                .any(|input| input.tier() == ProjectLlmTier::Local)
        );
        assert!(full.iter().any(|input| input.tier() == ProjectLlmTier::Ask));
        assert_eq!(cleared, vec![ProjectLlmTier::Reranker]);

        let (minimal, cleared) = ollama_inputs(true)
            .unwrap_or_else(|error| panic!("minimal ollama preset failed: {error}"));
        assert!(
            !minimal
                .iter()
                .any(|input| input.tier() == ProjectLlmTier::Ask)
        );
        assert!(cleared.contains(&ProjectLlmTier::Ask));
        assert!(cleared.contains(&ProjectLlmTier::Reranker));
    }

    #[test]
    fn hybrid_presets_write_native_provider_tiers_without_sqlite_or_inline_secrets() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        std::fs::create_dir(root.path().join(".cartograph"))
            .unwrap_or_else(|error| panic!("state directory failed: {error}"));
        let arguments = SetupArguments {
            path: root.path().to_path_buf(),
            preset: None,
            tier: None,
            endpoint: None,
            model: None,
            api_key_env: None,
            minimal: false,
            yes: false,
            json: false,
        };
        let (bridge, bridge_cleared) = hybrid_claude_inputs(&arguments)
            .unwrap_or_else(|error| panic!("bridge preset failed: {error}"));
        assert_eq!(bridge.len(), 5);
        assert_eq!(bridge_cleared, vec![ProjectLlmTier::Reranker]);
        write_project_llm_configuration(root.path(), &bridge, &bridge_cleared)
            .unwrap_or_else(|error| panic!("bridge config failed: {error}"));
        let bridge_config = std::fs::read_to_string(root.path().join(".cartograph/config.json"))
            .unwrap_or_else(|error| panic!("bridge config read failed: {error}"));
        assert!(bridge_config.contains("\"provider\": \"claude-bridge\""));
        assert!(!bridge_config.contains("apiKey"));
        assert!(!bridge_config.contains("sqlite"));

        let (anthropic, anthropic_cleared) = hybrid_anthropic_inputs(&arguments)
            .unwrap_or_else(|error| panic!("anthropic preset failed: {error}"));
        assert_eq!(anthropic.len(), 5);
        write_project_llm_configuration(root.path(), &anthropic, &anthropic_cleared)
            .unwrap_or_else(|error| panic!("anthropic config failed: {error}"));
        let anthropic_config = std::fs::read_to_string(root.path().join(".cartograph/config.json"))
            .unwrap_or_else(|error| panic!("anthropic config read failed: {error}"));
        assert!(anthropic_config.contains("\"provider\": \"anthropic-api\""));
        assert!(anthropic_config.contains("\"apiKeyEnv\": \"ANTHROPIC_API_KEY\""));
        assert!(!anthropic_config.contains("apiKey\""));
    }

    #[test]
    fn explicit_postgres_install_options_are_validated_without_persisting_the_url() {
        let mut arguments = install_arguments();
        arguments.database_provider = Some("postgresql".to_owned());
        arguments.database_url =
            Some("postgresql://cartograph@127.0.0.1:55432/cartograph".to_owned());
        arguments.database_schema = Some("Review_Project".to_owned());
        arguments.database_pgvector = Some("require".to_owned());
        arguments.database_max_connections = Some(12);
        arguments.database_query_timeout_ms = Some(45_000);
        arguments.database_connection_timeout_seconds = Some(7);
        arguments.database_ssl = true;

        let settings = resolve_install_database_settings(&arguments)
            .unwrap_or_else(|error| panic!("explicit database settings failed: {error}"))
            .unwrap_or_else(|| panic!("explicit database settings disappeared"));
        assert_eq!(settings.schema().as_str(), "review_project");
        assert_eq!(settings.max_connections().get(), 12);
        assert_eq!(settings.acquire_timeout(), Duration::from_secs(7));
        assert_eq!(settings.query_timeout(), Duration::from_secs(45));
        assert!(settings.require_ssl());

        arguments.database_provider = Some("sqlite".to_owned());
        let error = resolve_install_database_settings(&arguments)
            .err()
            .unwrap_or_else(|| panic!("SQLite install mode was accepted"));
        assert!(error.contains("intentionally removed"));
        assert!(!error.contains("private"));

        arguments.database_provider = Some("postgres".to_owned());
        arguments.database_pgvector = Some("off".to_owned());
        assert!(resolve_install_database_settings(&arguments).is_err());
    }

    #[test]
    fn every_setup_preset_has_explicit_inputs_clears_and_custom_field_policy() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let mut arguments = setup_arguments(root.path());

        let (local, local_cleared) = local_inputs_in(root.path(), false)
            .unwrap_or_else(|error| panic!("local preset failed: {error}"));
        assert_eq!(local.len(), 6);
        assert!(local_cleared.is_empty());
        let (minimal, minimal_cleared) = local_inputs_in(root.path(), true)
            .unwrap_or_else(|error| panic!("minimal local preset failed: {error}"));
        assert_eq!(minimal.len(), 4);
        assert_eq!(
            minimal_cleared,
            vec![ProjectLlmTier::Ask, ProjectLlmTier::Reranker]
        );

        arguments.tier = Some(LlmTierArgument::Chat);
        arguments.endpoint = Some("https://api.openai.com/v1".to_owned());
        arguments.model = Some("gpt-fixture".to_owned());
        arguments.api_key_env = Some("OPENAI_FIXTURE_KEY".to_owned());
        let (custom, cleared) = setup_inputs(&arguments, SetupPreset::Custom)
            .unwrap_or_else(|error| panic!("custom preset failed: {error}"));
        assert_eq!(custom.len(), 1);
        assert!(cleared.is_empty());
        assert_eq!(custom[0].tier(), ProjectLlmTier::Summarize);
        assert!(setup_inputs(&arguments, SetupPreset::LocalLlamaCpp).is_err());
        assert!(setup_inputs(&arguments, SetupPreset::Ollama).is_err());
        assert!(setup_inputs(&arguments, SetupPreset::Skip).is_err());

        arguments.tier = None;
        assert!(setup_inputs(&arguments, SetupPreset::Custom).is_err());
        arguments.tier = Some(LlmTierArgument::Embed);
        arguments.endpoint = None;
        assert!(setup_inputs(&arguments, SetupPreset::Custom).is_err());
        arguments.endpoint = Some("https://api.openai.com".to_owned());
        arguments.model = None;
        assert!(setup_inputs(&arguments, SetupPreset::Custom).is_err());
        arguments.model = Some("text-embedding-3-small".to_owned());
        arguments.api_key_env = None;
        let (cloud, _) = setup_inputs(&arguments, SetupPreset::CloudOpenAi)
            .unwrap_or_else(|error| panic!("cloud preset failed: {error}"));
        assert_eq!(cloud[0].tier(), ProjectLlmTier::Embedding);

        arguments.minimal = true;
        assert!(setup_inputs(&arguments, SetupPreset::CloudOpenAi).is_err());
        assert!(setup_inputs(&arguments, SetupPreset::Custom).is_err());
        arguments.minimal = false;
        arguments.tier = None;
        arguments.endpoint = None;
        arguments.model = None;
        let (skipped, skipped_clears) = setup_inputs(&arguments, SetupPreset::Skip)
            .unwrap_or_else(|error| panic!("skip preset failed: {error}"));
        assert!(skipped.is_empty());
        assert!(skipped_clears.is_empty());

        for (argument, tier) in [
            (LlmTierArgument::Local, ProjectLlmTier::Local),
            (LlmTierArgument::Ask, ProjectLlmTier::Ask),
            (LlmTierArgument::Classify, ProjectLlmTier::Classify),
            (LlmTierArgument::Reranker, ProjectLlmTier::Reranker),
        ] {
            assert_eq!(ProjectLlmTier::from(argument), tier);
        }
    }

    #[test]
    fn detection_recommendation_and_smoke_rows_keep_required_failures_explicit() {
        let detected = vec![DetectedEndpoint {
            endpoint: "http://127.0.0.1:11434".to_owned(),
            reachable: true,
            openai_compatible: true,
            models: vec!["fixture".to_owned()],
        }];
        assert_eq!(recommend_preset(&detected), SetupPreset::Ollama);
        assert_eq!(recommend_preset(&[]), SetupPreset::LocalLlamaCpp);
        render_detection(&detected, SetupPreset::Ollama);

        let required = missing_row("embedding", true, Instant::now());
        assert_eq!(required.status, SmokeStatus::Fail);
        assert!(required.detail.contains("not configured"));
        let optional = missing_row("ask", false, Instant::now());
        assert_eq!(optional.status, SmokeStatus::Skip);
        assert!(optional.detail.contains("fallback"));
        let ok = ok_row(
            "summarize",
            Some("fixture".to_owned()),
            Some("http://127.0.0.1:8081".to_owned()),
            Instant::now(),
            "bounded response".to_owned(),
        );
        let failed = failed_row(
            "rerank",
            None,
            None,
            Instant::now(),
            "bounded failure".to_owned(),
        );
        let report = SmokeReport {
            overall_status: OverallSmokeStatus::Fail,
            rows: vec![required, optional, ok, failed],
            duration_ms: 1,
        };
        render_smoke(&report);
        assert!(elapsed_ms(Instant::now()) <= 1_000);
    }

    #[tokio::test]
    async fn skipped_setup_and_unconfigured_smoke_are_noninteractive_and_deterministic() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
        let mut setup = setup_arguments(root.path());
        setup.preset = Some(SetupPreset::Skip);
        setup.json = true;
        assert_eq!(run(LlmCommand::Setup(setup)).await, Ok(ExitCode::SUCCESS));
        assert!(!root.path().join(".cartograph/config.json").exists());

        assert_eq!(
            run(LlmCommand::Smoke(SmokeArguments {
                path: root.path().to_path_buf(),
                timeout_ms: 50,
                json: false,
            }))
            .await,
            Ok(ExitCode::FAILURE)
        );
        let unreachable = detect_one("http://127.0.0.1:1").await;
        assert!(!unreachable.reachable);
        assert!(!unreachable.openai_compatible);
        assert!(unreachable.models.is_empty());
    }
}
