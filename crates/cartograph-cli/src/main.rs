#![recursion_limit = "256"]

use std::{
    collections::BTreeMap,
    env, fs,
    io::{IsTerminal as _, Read as _, Write as _},
    path::{Path, PathBuf},
    process::{self, Command as ProcessCommand, ExitCode, Stdio},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use cartograph_agent::{
    EmbeddingOptions, IndexOptions, IndexReport, ProjectRuntime, RetrievalOptions,
    RetrievalRequest, ReviewOptions, ReviewReport, SourceContextOptions, SourceContextRequest,
    WorkingTreeOverlayRequest,
};
use cartograph_config::{DATABASE_URL_ENV, DatabaseSettings};
use cartograph_db::{
    CapabilityReport, CartographDatabase, CheckStatus, DEFAULT_MANAGED_DATABASE_PORT,
    GenerationRetentionPolicy, GenerationRetentionRequest, GenerationStorageSummary,
    GenerationValidationLimits, LeaseOwner, LeaseRequest, LeaseTarget, ManagedContainerState,
    ManagedDatabase, ManagedDatabaseStatus, ManagedDestructiveConfirmation,
    ManagedDestructiveOperation, ManagedStartReport, V1PostgresImportExecution,
    V1PostgresImportLimits, V1PostgresImportRequest, V1PostgresSource, V1PostgresSourceRevision,
};
use cartograph_domain::{
    EdgeKind, ModelId, NormalizedPath, ProjectId, ProjectOperation, SourceLanguage, SymbolId,
};
use cartograph_llm::{
    ProjectLlmCredentialSource, ProjectLlmTier, load_exact_project_llm_tier,
    probe_openai_compatible_endpoint,
};
use cartograph_mcp::{ProtocolServer, ServerConfig, ServerLimits, ServerMetadata, ToolProfile};
use cartograph_search::{
    ContextAnchor, ContextBudget, ContextRequest, ContextRequestOptions, DeterministicRetriever,
    EntryPointBucket, EntryPointsQuery, ExactPathQuery, ExactTextQuery, FileInventoryQuery,
    GraphPathRequest, GraphPathRequestInput, IndexFreshness, LexicalQuery, SearchMode,
    SimilarRequest, SourceRangeQuery, SourceRangeQueryInput, TaskIntent, TraversalBudget,
    TraversalRequest,
};
use clap::{Args, Parser, Subcommand, ValueEnum};
use futures_util::{StreamExt as _, stream};
use install::{
    InstallLocation as AgentInstallLocation, InstallReport, InstallRequest, InstallRequestInput,
    InstallTarget,
};
use mcp_handler::{AGENT_PLAYBOOK, CartographMcpHandler, HandlerDefaults};
use serde::Serialize;
use serde_json::{Map, Value};
use url::Url;

mod auto_sync;
mod backend;
mod completions;
mod generated_cli;
mod git_hooks;
mod graph_export;
mod host;
mod install;
mod llm_commands;
mod mcp_budget;
mod mcp_handler;
mod upgrade;

use graph_export::{DEFAULT_NODE_LIMIT, GraphExportFormat, GraphExportRequest};

const MANAGED_DATABASE_PORT_ENV: &str = "CARTOGRAPH_MANAGED_DATABASE_PORT";
const V1_IMPORT_CONFIRMATION: &str = "import-v1-postgres";
const RETENTION_CONFIRMATION: &str = "prune-old-generations";
const DEFAULT_IMPORT_MAXIMUM_ROWS: u64 = 10_000_000;
const MAXIMUM_IMPORT_ROWS: u64 = 100_000_000;
const DEFAULT_IMPORT_MAXIMUM_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAXIMUM_IMPORT_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(test)]
const EXCESSIVE_IMPORT_SOURCE_BYTES_TEXT: &str = "536870913";
const DEFAULT_IMPORT_OUTPUT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_IMPORT_WORKING_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAINTENANCE_LEASE_DURATION: Duration = Duration::from_secs(5 * 60);
const MAINTENANCE_STATEMENT_TIMEOUT: Duration = Duration::from_secs(4 * 60);
const MAXIMUM_TRANSIENT_FILE_BYTES: usize = 10 * 1024 * 1024;
const KIBIBYTE: usize = 1_024;
const MEBIBYTE: usize = KIBIBYTE * KIBIBYTE;
const GIBIBYTE_U64: u64 = 1_024 * 1_024 * 1_024;
const MEBIBYTE_U64: u64 = 1_024 * 1_024;
const RETAINED_BYTE_WARNING: u64 = 4 * GIBIBYTE_U64;
const MAXIMUM_SUPERSEDED_GENERATIONS_WITHOUT_ATTENTION: u64 = 34;
const MAXIMUM_FAILED_GENERATIONS_WITHOUT_ATTENTION: u64 = 32;
const MCP_SERVER_INSTRUCTIONS: &str = "Start with cartograph_status and do not treat stale or unknown-freshness graph evidence as current. Use cartograph_context for the concrete coding task, then narrow with entry_points, files, at_range, find, node, graph, or affected. Read live source before editing. After changes, use cartograph_review against the intended base and run the repository's real quality gates. Preserve generation, freshness, confidence, abstention, provenance, multiplicity, and truncation in your reasoning. Use cartograph_admin only for explicit bounded lifecycle work. Call cartograph_playbook when you need the full workflow and tool-routing guide.";

#[derive(Debug, Parser)]
#[command(
    name = "cartograph",
    version,
    about = "Rust/PostgreSQL/ParadeDB code intelligence for coding agents"
)]
struct Cli {
    /// Disable ANSI color output. Retained for v1 command-line compatibility.
    #[arg(long = "no-color", global = true)]
    _no_color: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Manage configured local llama-server processes without owning external providers.
    Backend {
        #[command(subcommand)]
        command: backend::BackendCommand,
    },
    /// Build and atomically publish a complete native source generation.
    #[command(alias = "quickstart")]
    Index {
        /// Existing project root to index.
        #[arg(default_value = ".")]
        project_path: PathBuf,
        /// Maximum native workers; the corpus-aware selector may use fewer.
        #[arg(long, value_parser = clap::value_parser!(u16).range(1..=16))]
        workers: Option<u16>,
        /// Publish a new generation even when the live source digest is unchanged.
        #[arg(long)]
        force: bool,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Report current generation counts and live-source freshness.
    Status {
        /// Existing project root whose state should be inspected.
        #[arg(default_value = ".")]
        project_path: PathBuf,
        /// Output the complete structured status as JSON.
        #[arg(short = 'j', long)]
        json: bool,
        /// Include default hotspot, biomarker, and summary-provenance rollups.
        #[arg(long)]
        verbose: bool,
        /// Inline the top-N hotspots; invalid or sub-one values suppress the rollup.
        #[arg(long)]
        top_hotspots: Option<String>,
        /// Inline the top-N warning-or-worse biomarker findings.
        #[arg(long)]
        top_biomarkers: Option<String>,
        /// Include summary coverage grouped by durable model provenance.
        #[arg(long)]
        summary_breakdown: bool,
        /// Additive v2 output selector; --json takes precedence.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Embed missing current-generation documents through the configured endpoint.
    Embed {
        /// Existing indexed project whose search documents should be embedded.
        #[arg(default_value = ".")]
        project_path: PathBuf,
        /// Maximum concurrent endpoint/database batches.
        #[arg(long, value_parser = clap::value_parser!(u16).range(1..=16))]
        workers: Option<u16>,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Probe the configured embedding model and report PostgreSQL semantic readiness.
    EmbeddingStatus {
        /// Existing indexed project whose semantic coverage should be checked.
        #[arg(default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Find exact, lexical, or hybrid evidence in the current generation.
    #[command(name = "find-native", hide = true)]
    Find {
        /// Name, project-relative path, reference text, or natural-language query.
        query: String,
        /// Retrieval channel to execute.
        #[arg(long, value_enum, default_value_t = FindBy::Auto)]
        by: FindBy,
        /// Maximum result rows.
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u16).range(1..=100))]
        limit: u16,
        /// Explicitly permit cached evidence when the live source revision is stale.
        #[arg(long)]
        allow_stale: bool,
        /// Existing project root whose current generation should be searched.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Build an intent-routed evidence packet with provenance, graph policy, and live overlay.
    #[command(name = "context-native", hide = true)]
    Context {
        /// Coding task or investigation question.
        task: String,
        /// Optional exact declaration-name seed.
        #[arg(long)]
        exact_name: Option<String>,
        /// Optional exact project-relative path seed.
        #[arg(long)]
        exact_path: Option<String>,
        /// Optional exact source-reference seed.
        #[arg(long)]
        exact_reference: Option<String>,
        /// Natural-language retrieval policy; auto falls back to deterministic BM25.
        #[arg(long, value_enum, default_value_t = RetrievalMode::Auto)]
        mode: RetrievalMode,
        /// Existing project root whose evidence should be assembled.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// List a bounded current-generation source-file inventory.
    #[command(name = "files-native", hide = true)]
    Files {
        /// Optional exact project-relative directory subtree.
        #[arg(long)]
        dir: Option<String>,
        /// Optional stable language identifier.
        #[arg(long)]
        language: Option<String>,
        /// Maximum file rows.
        #[arg(long, default_value_t = 200, value_parser = clap::value_parser!(u16).range(1..=500))]
        limit: u16,
        /// Explicitly permit cached evidence when the live source revision is stale.
        #[arg(long)]
        allow_stale: bool,
        /// Existing project root whose current generation should be listed.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Discover typed top-of-stack routes, commands, MCP tools, CLI declarations, and public APIs.
    #[command(name = "entry-points-native", hide = true)]
    EntryPoints {
        /// Optional category; omit to return every category in stable order.
        #[arg(long, value_enum)]
        bucket: Option<EntryPointBucketArg>,
        /// Maximum symbols returned per category.
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u16).range(1..=200))]
        limit: u16,
        /// Explicitly permit cached evidence when the live source revision is stale.
        #[arg(long)]
        allow_stale: bool,
        /// Existing project root whose public boundary should be inspected.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Resolve indexed symbols overlapping one exact inclusive source range.
    #[command(name = "at-range-native", hide = true)]
    AtRange {
        /// Exact project-relative source path.
        file: String,
        /// First one-based source line.
        #[arg(value_parser = clap::value_parser!(u32).range(1..=10_000_000))]
        start_line: u32,
        /// Last one-based source line.
        #[arg(value_parser = clap::value_parser!(u32).range(1..=10_000_000))]
        end_line: u32,
        /// Maximum overlapping symbols.
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u16).range(1..=200))]
        limit: u16,
        /// Explicitly permit cached evidence when the live source revision is stale.
        #[arg(long)]
        allow_stale: bool,
        /// Existing project root whose current generation should be queried.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Traverse or find a shortest dependency path from an exact symbol ID.
    #[command(name = "graph-native", hide = true)]
    Graph {
        /// Exact UUID returned by `cartograph find` or `cartograph context`.
        symbol_id: String,
        /// Traversal orientation.
        #[arg(long, value_enum, default_value_t = GraphAxis::Impact)]
        direction: GraphAxis,
        /// Exact target UUID required by `--direction path`.
        #[arg(long)]
        to: Option<String>,
        /// Restrict traversal or path search to one exact edge kind.
        #[arg(long, value_enum)]
        edge_kind: Option<GraphEdgeKind>,
        /// Semantic neighbor count for `--direction similar` (default 5, maximum 50).
        #[arg(long, value_parser = clap::value_parser!(u16).range(1..=50))]
        k: Option<u16>,
        /// Minimum cosine similarity for `--direction similar` (default 0.3).
        #[arg(long)]
        min_score: Option<f64>,
        /// Restrict semantic neighbors to the source symbol's language.
        #[arg(long)]
        same_language: bool,
        /// Exact active embedding-model UUID when multiple models are ready.
        #[arg(long)]
        model_id: Option<String>,
        /// Maximum graph depth.
        #[arg(long, default_value_t = 2, value_parser = clap::value_parser!(u8).range(1..=8))]
        depth: u8,
        /// Maximum non-root symbols.
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=500))]
        max_nodes: u16,
        /// Explicitly permit cached evidence when the live source revision is stale.
        #[arg(long)]
        allow_stale: bool,
        /// Existing project root whose graph should be traversed.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Read bounded source context for one exact current-generation symbol ID.
    Show {
        /// Exact UUID returned by `cartograph find`, `context`, or `graph`.
        symbol_id: String,
        /// Symmetric source lines included before and after the declaration.
        #[arg(long, default_value_t = 3, value_parser = clap::value_parser!(u16).range(0..=200))]
        context_lines: u16,
        /// Hard UTF-8 source payload ceiling.
        #[arg(long, default_value_t = 65_536, value_parser = clap::value_parser!(u32).range(1024..=262144))]
        max_bytes: u32,
        /// Explicitly permit stale metadata with source omitted.
        #[arg(long)]
        allow_stale: bool,
        /// Existing project root whose current symbol should be read.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Select bounded affected tests from reverse graph impact.
    #[command(name = "affected-native", hide = true)]
    Affected {
        /// Exact changed symbol UUID.
        symbol_id: String,
        /// Maximum graph depth.
        #[arg(long, default_value_t = 3, value_parser = clap::value_parser!(u8).range(1..=8))]
        depth: u8,
        /// Maximum graph nodes inspected.
        #[arg(long, default_value_t = 200, value_parser = clap::value_parser!(u16).range(1..=500))]
        max_nodes: u16,
        /// Maximum test results.
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=100))]
        limit: u16,
        /// Explicitly permit cached evidence when the live source revision is stale.
        #[arg(long)]
        allow_stale: bool,
        /// Existing project root whose graph should be traversed.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Compare the live checkout to a Git ref and assemble deterministic review evidence.
    #[command(name = "review-native", hide = true)]
    Review {
        /// Git revision to compare with the live index and working tree.
        #[arg(long = "ref", default_value = "HEAD")]
        base_ref: String,
        /// Maximum changed files retained after stable path ordering.
        #[arg(long, default_value_t = 200, value_parser = clap::value_parser!(u16).range(1..=512))]
        max_changed_files: u16,
        /// Existing project root whose Git checkout and graph should be reviewed.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Export a capped graph snapshot as JSON, DOT, Mermaid, or Cytoscape JSON.
    Export {
        /// Existing indexed project to export.
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Explicit project path (overrides the positional path).
        #[arg(short = 'p', long)]
        project_path: Option<PathBuf>,
        /// Graph artifact format.
        #[arg(short = 'f', long, value_enum, default_value_t = GraphExportFormat::Json)]
        format: GraphExportFormat,
        /// Write the artifact to a file instead of stdout.
        #[arg(short = 'o', long)]
        out: Option<PathBuf>,
        /// Maximum exported nodes; edges are retained only between exported nodes.
        #[arg(long, default_value_t = DEFAULT_NODE_LIMIT, value_parser = clap::value_parser!(u16).range(1..=50_000))]
        limit: u16,
        /// Comma-separated symbol kinds to include.
        #[arg(long)]
        kind: Option<String>,
        /// Comma-separated edge kinds to include.
        #[arg(long)]
        edge_kind: Option<String>,
        /// Comma-separated languages to include.
        #[arg(long)]
        language: Option<String>,
        /// Only include symbols whose project-relative file starts with this prefix.
        #[arg(long)]
        file: Option<String>,
    },
    /// Find embedding-cosine peers of an exact symbol name or UUID.
    Similar {
        /// Exact symbol name or UUID.
        symbol: String,
        /// Maximum semantic neighbors.
        #[arg(short = 'k', long = "top-k", visible_alias = "k", default_value_t = 5, value_parser = clap::value_parser!(u16).range(1..=50))]
        k: u16,
        /// Minimum cosine similarity.
        #[arg(long, default_value_t = 0.3)]
        min_score: f64,
        /// Restrict results to the source symbol's language.
        #[arg(long)]
        same_language: bool,
        /// Exact active embedding-model UUID when more than one model is ready.
        #[arg(long)]
        model_id: Option<String>,
        /// Explicitly permit cached evidence when the live source is stale.
        #[arg(long)]
        allow_stale: bool,
        /// Existing indexed project.
        #[arg(short = 'p', long, default_value = ".")]
        project_path: PathBuf,
    },
    /// Re-index only when source state is dirty or the current generation is stale.
    SyncIfDirty {
        /// Existing indexed project.
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Suppress hook-friendly output.
        #[arg(short = 'q', long)]
        quiet: bool,
        /// Transient maximum source-file size (bytes, kb, or mb; maximum 10mb).
        #[arg(long)]
        max_file_size: Option<String>,
    },
    /// Install managed Git hooks that keep the Cartograph index fresh.
    InstallHooks {
        /// Existing Git working tree.
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Comma-separated hooks: post-merge, post-checkout, post-rewrite.
        #[arg(long)]
        hooks: Option<String>,
        /// Cartograph executable name or path embedded in the managed block.
        #[arg(long)]
        command: Option<String>,
        /// Remove only Cartograph's managed hook blocks.
        #[arg(long)]
        remove: bool,
        /// Print planned changes without writing hook files.
        #[arg(long)]
        dry_run: bool,
    },
    /// Measure MCP startup payload size and its largest schema contributors.
    McpBudget {
        /// Advertised tool profile.
        #[arg(long, value_enum, default_value_t = McpProfile::Core)]
        profile: McpProfile,
        /// Measure with only explicitly read-only tool contracts.
        #[arg(long = "no-write-tools")]
        no_write_tools: bool,
        /// Exact tool names to omit; repeat the option or pass several names.
        #[arg(long, num_args = 1.., action = clap::ArgAction::Append)]
        disable_tool: Vec<String>,
        /// Number of largest tool schemas to list.
        #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u16).range(0..=100))]
        top: u16,
        /// Print structured JSON.
        #[arg(long)]
        json: bool,
    },
    /// Print shell completion setup.
    #[command(alias = "completion")]
    Completions {
        /// Target shell.
        #[arg(value_enum)]
        shell: completions::CompletionShell,
    },
    /// Internal dynamic shell-completion helper.
    #[command(name = "__complete", hide = true, trailing_var_arg = true)]
    CompleteInternal {
        #[arg(allow_hyphen_values = true)]
        words: Vec<String>,
    },
    /// Print the complete coding-agent workflow and tool-routing guide.
    Guide,
    /// Configure, install, and exercise optional OpenAI-compatible LLM tiers.
    Llm {
        #[command(subcommand)]
        command: llm_commands::LlmCommand,
    },
    /// Deprecated alias of `cartograph llm install`.
    #[command(name = "setup", hide = true)]
    Setup(llm_commands::InstallArguments),
    /// Check for a newer native release and optionally install it in place.
    #[command(alias = "update")]
    Upgrade {
        /// Download, verify, smoke-test, and atomically install the latest release.
        #[arg(long)]
        apply: bool,
        /// Output structured JSON.
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Configure Cartograph for one or more coding-agent hosts.
    Install {
        /// Comma-separated target ids, or auto, all, or none.
        #[arg(short = 't', long)]
        target: Option<String>,
        /// Install globally for all projects or privately in this project.
        #[arg(short = 'l', long, value_enum, default_value_t = InstallLocation::Global)]
        location: InstallLocation,
        /// Existing project root to expose through the MCP server.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Loopback port for this project's managed PostgreSQL database.
        #[arg(long, value_parser = clap::value_parser!(u16).range(1..=65535))]
        managed_database_port: Option<u16>,
        /// Use non-interactive defaults: global, auto-detected targets, permissions enabled.
        #[arg(short = 'y', long)]
        yes: bool,
        /// Skip Claude/Qoder MCP auto-allow entries.
        #[arg(long)]
        no_permissions: bool,
        /// Skip managed Git hooks for project-local installation.
        #[arg(long)]
        no_hooks: bool,
        /// Command or absolute executable path written into host configuration.
        #[arg(long)]
        command: Option<String>,
        /// Print one target's MCP configuration without writing files.
        #[arg(long)]
        print_config: Option<String>,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Remove Cartograph-owned MCP entries and guidance from agent hosts.
    Uninstall {
        /// Optional comma-separated target ids; defaults to every known target.
        #[arg(short = 't', long)]
        target: Option<String>,
        /// Remove global or project-local entries.
        #[arg(short = 'l', long, value_enum, default_value_t = InstallLocation::Global)]
        location: InstallLocation,
        /// Existing project root containing the registration.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Serve Cartograph's bounded Model Context Protocol connection over stdio.
    Serve {
        /// Confirm stdio MCP transport (the only v2 transport in this release).
        #[arg(long)]
        mcp: bool,
        /// Existing project root exposed to this MCP process.
        #[arg(short = 'p', long, default_value = ".")]
        project_path: PathBuf,
        /// Loopback port for this project's managed PostgreSQL database.
        #[arg(long, value_parser = clap::value_parser!(u16).range(1..=65535))]
        managed_database_port: Option<u16>,
        /// Advertised MCP tool profile.
        #[arg(long, value_enum, default_value_t = McpProfile::Core)]
        profile: McpProfile,
        /// Compatibility flag; PostgreSQL advisory locks replace the v1 writer daemon.
        #[arg(long, conflicts_with = "no_daemon")]
        daemon: bool,
        /// Run this MCP connection directly (the native v2 default).
        #[arg(long = "no-daemon", conflicts_with = "daemon")]
        no_daemon: bool,
        /// Internal v1 compatibility flag; native v2 still serves this connection directly.
        #[arg(long, hide = true)]
        daemon_child: bool,
        /// Advertise only explicitly read-only tool contracts.
        #[arg(long = "no-write-tools")]
        no_write_tools: bool,
        /// Default allowStale to true when a supporting tool omits it.
        #[arg(long)]
        allow_stale_default: bool,
        /// Default lowTokens to true when a supporting tool omits it.
        #[arg(long)]
        low_tokens_default: bool,
        /// Exact tool names to omit from the advertised and callable surface.
        #[arg(long, num_args = 1.., action = clap::ArgAction::Append)]
        disable_tool: Vec<String>,
        /// Skip the default one-time source catch-up before serving.
        #[arg(long)]
        no_startup_sync: bool,
    },
    /// Verify PostgreSQL 18, ParadeDB, pgvector, and code tokenization.
    Doctor {
        /// Existing project root used to discover managed credentials when no URL is exported.
        #[arg(default_value = ".")]
        project_path: PathBuf,
        /// Repair safe local gaps: create private state, start the managed database, and install/configure missing minimal LLM tiers.
        #[arg(long)]
        fix: bool,
        /// Skip project state, index, and LLM checks for fresh-install verification.
        #[arg(long, visible_alias = "skip-project-checks")]
        no_project_checks: bool,
        /// Print structured JSON (alias of --format json).
        #[arg(short = 'j', long)]
        json: bool,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Manage Cartograph's project-owned PostgreSQL + ParadeDB container.
    Db {
        #[command(subcommand)]
        command: DatabaseCommand,
    },
}

#[derive(Debug, Subcommand)]
enum DatabaseCommand {
    /// Idempotently start, initialize, and verify the managed database.
    Start(DatabaseStartArguments),
    /// Report the owned container state without creating anything.
    Status(DatabaseStatusArguments),
    /// Stop only the container owned by this project.
    Stop(DatabaseStopArguments),
    /// Print a bounded tail from only the project-owned container.
    Logs(DatabaseLogsArguments),
    /// Write a private, verified custom-format PostgreSQL archive.
    Backup(DatabaseBackupArguments),
    /// Replace managed contents from a verified archive with automatic rollback.
    Restore(DatabaseRestoreArguments),
    /// Permanently remove only the resources owned by this project.
    Remove(DatabaseDestructiveArguments),
    /// Replace an owned older container with the supported image and rollback on failure.
    Upgrade(DatabaseDestructiveArguments),
    /// Inspect or transactionally rebuild the derived ParadeDB BM25 index.
    DerivedIndex(DatabaseDerivedIndexArguments),
    /// Validate or resume a PostgreSQL-only v1.1.33 schema import.
    ImportV1(V1ImportArguments),
    /// Delete a bounded batch of stale staging, failed, and old superseded generations.
    Prune(PruneArguments),
}

#[derive(Debug, Args)]
struct DatabaseStartArguments {
    /// Existing project root whose managed resources should be used.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Loopback host port for PostgreSQL.
    #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
    port: u16,
    /// Maximum seconds to wait for managed database readiness.
    #[arg(long, default_value_t = 90, value_parser = clap::value_parser!(u64).range(1..=600))]
    wait_seconds: u64,
    /// Output format for humans or automation.
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Debug, Args)]
struct DatabaseStatusArguments {
    /// Existing project root whose managed resources should be inspected.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Loopback host port used by the managed database.
    #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
    port: u16,
    /// Output format for humans or automation.
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Debug, Args)]
struct DatabaseStopArguments {
    /// Existing project root whose managed resources should be stopped.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Loopback host port used by the managed database.
    #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
    port: u16,
}

#[derive(Debug, Args)]
struct DatabaseLogsArguments {
    /// Existing project root whose managed logs should be read.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Loopback host port used by the managed database.
    #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
    port: u16,
    /// Maximum number of log lines.
    #[arg(long, default_value_t = 200, value_parser = clap::value_parser!(u16).range(1..=10000))]
    tail: u16,
}

#[derive(Debug, Args)]
struct DatabaseBackupArguments {
    /// New archive path; an existing path is refused.
    destination: PathBuf,
    /// Existing project root whose owned database should be backed up.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Loopback host port used by the managed database.
    #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
    port: u16,
    /// Output format for humans or automation.
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Debug, Args)]
struct DatabaseRestoreArguments {
    /// Existing custom-format archive to restore.
    source: PathBuf,
    /// Exact acknowledgement: restore-managed-database.
    #[arg(long)]
    confirm: String,
    /// Existing project root whose owned database should be restored.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Loopback host port used by the managed database.
    #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
    port: u16,
    /// Output format for humans or automation.
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Debug, Args)]
struct DatabaseDestructiveArguments {
    /// Exact acknowledgement for the requested destructive operation.
    #[arg(long)]
    confirm: String,
    /// Existing project root whose owned database should be changed.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Loopback host port used by the managed database.
    #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
    port: u16,
    /// Output format for humans or automation.
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Debug, Args)]
struct DatabaseDerivedIndexArguments {
    /// Rebuild instead of only checking health.
    #[arg(long)]
    rebuild: bool,
    /// Exact acknowledgement required with --rebuild.
    #[arg(long, requires = "rebuild")]
    confirm: Option<String>,
    /// Existing project root whose derived index should be inspected.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Loopback host port used by the managed database.
    #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
    port: u16,
    /// Output format for humans or automation.
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum OutputFormat {
    #[default]
    Text,
    Json,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
enum McpProfile {
    Full,
    #[default]
    Core,
    Coding,
    ReadOnly,
    Review,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum FindBy {
    #[default]
    Auto,
    Name,
    Path,
    Reference,
    Bm25,
    Hybrid,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum RetrievalMode {
    #[default]
    Auto,
    Deterministic,
    Hybrid,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum EntryPointBucketArg {
    Routes,
    Cli,
    CliCommands,
    McpTools,
    CliFiles,
    PublicExports,
}

impl From<EntryPointBucketArg> for EntryPointBucket {
    fn from(value: EntryPointBucketArg) -> Self {
        match value {
            EntryPointBucketArg::Routes => Self::Routes,
            EntryPointBucketArg::Cli | EntryPointBucketArg::CliCommands => Self::CliCommands,
            EntryPointBucketArg::McpTools => Self::McpTools,
            EntryPointBucketArg::CliFiles => Self::CliFiles,
            EntryPointBucketArg::PublicExports => Self::PublicExports,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
enum GraphAxis {
    Callers,
    Callees,
    Both,
    Path,
    Similar,
    #[default]
    Impact,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum GraphEdgeKind {
    Calls,
    Imports,
    References,
    Implements,
    Extends,
    Tests,
    TypeOf,
    Returns,
    Instantiates,
    Overrides,
    Decorates,
    FieldAccess,
    DefUse,
    Exports,
    Contains,
}

impl From<GraphEdgeKind> for EdgeKind {
    fn from(value: GraphEdgeKind) -> Self {
        match value {
            GraphEdgeKind::Calls => Self::Calls,
            GraphEdgeKind::Imports => Self::Imports,
            GraphEdgeKind::References => Self::References,
            GraphEdgeKind::Implements => Self::Implements,
            GraphEdgeKind::Extends => Self::Extends,
            GraphEdgeKind::Tests => Self::Tests,
            GraphEdgeKind::TypeOf => Self::TypeOf,
            GraphEdgeKind::Returns => Self::Returns,
            remaining => graph_edge_kind_tail(remaining),
        }
    }
}

const fn graph_edge_kind_tail(value: GraphEdgeKind) -> EdgeKind {
    match value {
        GraphEdgeKind::Instantiates => EdgeKind::Instantiates,
        GraphEdgeKind::Overrides => EdgeKind::Overrides,
        GraphEdgeKind::Decorates => EdgeKind::Decorates,
        GraphEdgeKind::FieldAccess => EdgeKind::FieldAccess,
        GraphEdgeKind::DefUse => EdgeKind::DefUse,
        GraphEdgeKind::Exports => EdgeKind::Exports,
        GraphEdgeKind::Contains => EdgeKind::Contains,
        GraphEdgeKind::Calls
        | GraphEdgeKind::Imports
        | GraphEdgeKind::References
        | GraphEdgeKind::Implements
        | GraphEdgeKind::Extends
        | GraphEdgeKind::Tests
        | GraphEdgeKind::TypeOf
        | GraphEdgeKind::Returns => unreachable!(),
    }
}

struct FindArguments {
    project_path: PathBuf,
    query: String,
    by: FindBy,
    limit: u16,
    allow_stale: bool,
    format: OutputFormat,
}

struct FilesArguments {
    project_path: PathBuf,
    directory: Option<String>,
    language: Option<String>,
    limit: u16,
    allow_stale: bool,
    format: OutputFormat,
}

struct EntryPointsArguments {
    project_path: PathBuf,
    bucket: Option<EntryPointBucket>,
    limit: u16,
    allow_stale: bool,
    format: OutputFormat,
}

struct AtRangeArguments {
    project_path: PathBuf,
    file: String,
    start_line: u32,
    end_line: u32,
    limit: u16,
    allow_stale: bool,
    format: OutputFormat,
}

struct ContextArguments {
    project_path: PathBuf,
    task: String,
    exact_name: Option<String>,
    exact_path: Option<String>,
    exact_reference: Option<String>,
    mode: RetrievalMode,
    format: OutputFormat,
}

impl From<RetrievalMode> for SearchMode {
    fn from(value: RetrievalMode) -> Self {
        match value {
            RetrievalMode::Auto => Self::Auto,
            RetrievalMode::Deterministic => Self::Deterministic,
            RetrievalMode::Hybrid => Self::Hybrid,
        }
    }
}

struct GraphArguments {
    project_path: PathBuf,
    symbol_id: String,
    direction: GraphAxis,
    target_symbol_id: Option<String>,
    edge_kind: Option<EdgeKind>,
    similar_limit: Option<u16>,
    minimum_score: Option<f64>,
    same_language: bool,
    model_id: Option<String>,
    depth: u8,
    max_nodes: u16,
    allow_stale: bool,
    format: OutputFormat,
}

struct AffectedArguments {
    project_path: PathBuf,
    symbol_id: String,
    depth: u8,
    max_nodes: u16,
    limit: u16,
    allow_stale: bool,
    format: OutputFormat,
}

struct ShowArguments {
    project_path: PathBuf,
    symbol_id: String,
    context_lines: u16,
    max_bytes: u32,
    allow_stale: bool,
    format: OutputFormat,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliFreshEvidence<'evidence, Evidence> {
    freshness: IndexFreshness,
    evidence: &'evidence Evidence,
}

struct ReviewArguments {
    project_path: PathBuf,
    base_ref: String,
    max_changed_files: u16,
    format: OutputFormat,
}

struct IndexArguments {
    project_path: PathBuf,
    workers: Option<u16>,
    force: bool,
    format: OutputFormat,
    managed_database_port: Option<u16>,
}

struct AgentInstallArguments {
    target: Option<String>,
    location: InstallLocation,
    project_path: PathBuf,
    managed_database_port: Option<u16>,
    yes: bool,
    permissions: bool,
    hooks: bool,
    command: Option<String>,
    print_config: Option<String>,
    format: OutputFormat,
    remove: bool,
}

struct McpServeArguments {
    mcp: bool,
    project_path: PathBuf,
    managed_database_port: Option<u16>,
    profile: McpProfile,
    daemon: bool,
    no_daemon: bool,
    daemon_child: bool,
    no_write_tools: bool,
    allow_stale_default: bool,
    low_tokens_default: bool,
    disable_tool: Vec<String>,
    no_startup_sync: bool,
}

#[derive(Debug, Args)]
struct V1ImportArguments {
    /// Existing checkout whose bytes must match the v1 source rows.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Existing v1.1.33 PostgreSQL schema in the same database.
    #[arg(long)]
    source_schema: String,
    /// Hard aggregate row ceiling for source admission.
    #[arg(
        long,
        default_value_t = DEFAULT_IMPORT_MAXIMUM_ROWS,
        value_parser = clap::value_parser!(u64).range(1..=MAXIMUM_IMPORT_ROWS)
    )]
    maximum_rows: u64,
    /// Hard aggregate source and legacy-metadata byte ceiling.
    #[arg(
        long,
        default_value_t = DEFAULT_IMPORT_MAXIMUM_SOURCE_BYTES,
        value_parser = clap::value_parser!(u64).range(1..=MAXIMUM_IMPORT_SOURCE_BYTES)
    )]
    maximum_source_bytes: u64,
    /// Validate source, checkout hashes, bounds, and canonical facts without importing.
    #[arg(long)]
    dry_run: bool,
    /// Exact acknowledgement required for mutation: import-v1-postgres.
    #[arg(long, required_unless_present = "dry_run")]
    confirm: Option<String>,
    /// Output format for humans or automation.
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Debug, Args)]
struct PruneArguments {
    /// Existing project whose current generation is always preserved.
    #[arg(long, default_value = ".")]
    project_path: PathBuf,
    /// Number of newest superseded generations that must be retained.
    #[arg(long, default_value_t = 2)]
    keep_superseded: u32,
    /// Maximum generations deleted in one transaction.
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=10000))]
    maximum_deletions: u32,
    /// Exact acknowledgement: prune-old-generations.
    #[arg(long)]
    confirm: String,
    /// Output format for humans or automation.
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

struct TraversalArguments<'a> {
    project_id: ProjectId,
    symbol_id: &'a str,
    depth: u8,
    max_nodes: u16,
    edge_kind: Option<EdgeKind>,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum InstallLocation {
    #[default]
    Global,
    Local,
}

impl From<InstallLocation> for AgentInstallLocation {
    fn from(value: InstallLocation) -> Self {
        match value {
            InstallLocation::Global => Self::Global,
            InstallLocation::Local => Self::Local,
        }
    }
}

impl From<McpProfile> for ToolProfile {
    fn from(value: McpProfile) -> Self {
        match value {
            McpProfile::Full => Self::Full,
            McpProfile::Core => Self::Core,
            McpProfile::Coding => Self::Coding,
            McpProfile::ReadOnly => Self::ReadOnly,
            McpProfile::Review => Self::Review,
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let parsed = match generated_cli::parse() {
        Ok(parsed) => parsed,
        Err(generated_cli::ParseFailure::Clap(error)) => {
            let exit_code = if error.use_stderr() {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            };
            if error.print().is_err() {
                return ExitCode::FAILURE;
            }
            return exit_code;
        }
        Err(generated_cli::ParseFailure::Contract(message)) => {
            eprintln!("cartograph: {message}");
            return ExitCode::FAILURE;
        }
    };
    let result = match parsed {
        generated_cli::ParsedCli::Static(cli) => run(cli).await,
        generated_cli::ParsedCli::Tool(invocation) => generated_cli::run(invocation).await,
    };
    match result {
        Ok(exit_code) => exit_code,
        Err(message) => {
            eprintln!("cartograph: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<ExitCode, String> {
    match cli.command {
        command @ (Command::Index { .. }
        | Command::Status { .. }
        | Command::Embed { .. }
        | Command::EmbeddingStatus { .. }) => run_index_command(command).await,
        command @ (Command::Find { .. }
        | Command::Context { .. }
        | Command::Files { .. }
        | Command::EntryPoints { .. }
        | Command::AtRange { .. }) => run_search_command(command).await,
        command @ (Command::Graph { .. }
        | Command::Show { .. }
        | Command::Affected { .. }
        | Command::Review { .. }) => run_graph_command(command).await,
        command => run_operator_command(command).await,
    }
}

async fn run_index_command(command: Command) -> Result<ExitCode, String> {
    match command {
        Command::Index {
            project_path,
            workers,
            force,
            format,
        } => {
            run_index(IndexArguments {
                project_path,
                workers,
                force,
                format,
                managed_database_port: None,
            })
            .await
        }
        Command::Status {
            project_path,
            json,
            verbose,
            top_hotspots,
            top_biomarkers,
            summary_breakdown,
            format,
        } => {
            run_status(StatusRunInput {
                project_path,
                json: json || matches!(format, OutputFormat::Json),
                verbose,
                top_hotspots,
                top_biomarkers,
                summary_breakdown,
            })
            .await
        }
        Command::Embed {
            project_path,
            workers,
            format,
        } => run_embed(project_path, workers, format).await,
        Command::EmbeddingStatus {
            project_path,
            format,
        } => run_embedding_status(project_path, format).await,
        _ => Err("internal index command routing failed".to_owned()),
    }
}

async fn run_search_command(command: Command) -> Result<ExitCode, String> {
    match command {
        Command::Find {
            query,
            by,
            limit,
            allow_stale,
            project_path,
            format,
        } => {
            run_find(FindArguments {
                project_path,
                query,
                by,
                limit,
                allow_stale,
                format,
            })
            .await
        }
        Command::Context {
            task,
            exact_name,
            exact_path,
            exact_reference,
            mode,
            project_path,
            format,
        } => {
            run_context(ContextArguments {
                project_path,
                task,
                exact_name,
                exact_path,
                exact_reference,
                mode,
                format,
            })
            .await
        }
        Command::Files {
            dir,
            language,
            limit,
            allow_stale,
            project_path,
            format,
        } => {
            run_files(FilesArguments {
                project_path,
                directory: dir,
                language,
                limit,
                allow_stale,
                format,
            })
            .await
        }
        Command::EntryPoints {
            bucket,
            limit,
            allow_stale,
            project_path,
            format,
        } => {
            run_entry_points(EntryPointsArguments {
                project_path,
                bucket: bucket.map(Into::into),
                limit,
                allow_stale,
                format,
            })
            .await
        }
        Command::AtRange {
            file,
            start_line,
            end_line,
            limit,
            allow_stale,
            project_path,
            format,
        } => {
            run_at_range(AtRangeArguments {
                project_path,
                file,
                start_line,
                end_line,
                limit,
                allow_stale,
                format,
            })
            .await
        }
        _ => Err("internal search command routing failed".to_owned()),
    }
}

async fn run_graph_command(command: Command) -> Result<ExitCode, String> {
    match command {
        Command::Graph {
            symbol_id,
            direction,
            to,
            edge_kind,
            k,
            min_score,
            same_language,
            model_id,
            depth,
            max_nodes,
            allow_stale,
            project_path,
            format,
        } => {
            run_graph(GraphArguments {
                project_path,
                symbol_id,
                direction,
                target_symbol_id: to,
                edge_kind: edge_kind.map(Into::into),
                similar_limit: k,
                minimum_score: min_score,
                same_language,
                model_id,
                depth,
                max_nodes,
                allow_stale,
                format,
            })
            .await
        }
        Command::Show {
            symbol_id,
            context_lines,
            max_bytes,
            allow_stale,
            project_path,
            format,
        } => {
            run_show(ShowArguments {
                project_path,
                symbol_id,
                context_lines,
                max_bytes,
                allow_stale,
                format,
            })
            .await
        }
        Command::Affected {
            symbol_id,
            depth,
            max_nodes,
            limit,
            allow_stale,
            project_path,
            format,
        } => {
            run_affected(AffectedArguments {
                project_path,
                symbol_id,
                depth,
                max_nodes,
                limit,
                allow_stale,
                format,
            })
            .await
        }
        Command::Review {
            base_ref,
            max_changed_files,
            project_path,
            format,
        } => {
            run_review(ReviewArguments {
                project_path,
                base_ref,
                max_changed_files,
                format,
            })
            .await
        }
        _ => Err("internal graph command routing failed".to_owned()),
    }
}

async fn run_operator_command(command: Command) -> Result<ExitCode, String> {
    match command {
        Command::Backend { command } => backend::run(command).await,
        Command::Setup(arguments) => {
            llm_commands::run(llm_commands::LlmCommand::Install(arguments)).await
        }
        Command::Install {
            target,
            location,
            project_path,
            managed_database_port,
            yes,
            no_permissions,
            no_hooks,
            command,
            print_config,
            format,
        } => {
            run_agent_install(AgentInstallArguments {
                target,
                location,
                project_path,
                managed_database_port,
                yes,
                permissions: !no_permissions,
                hooks: !no_hooks,
                command,
                print_config,
                format,
                remove: false,
            })
            .await
        }
        Command::Uninstall {
            target,
            location,
            project_path,
            format,
        } => {
            run_agent_install(AgentInstallArguments {
                target,
                location,
                project_path,
                managed_database_port: None,
                yes: true,
                permissions: false,
                hooks: false,
                command: None,
                print_config: None,
                format,
                remove: true,
            })
            .await
        }
        command => run_runtime_operator_command(command).await,
    }
}

async fn run_runtime_operator_command(command: Command) -> Result<ExitCode, String> {
    match command {
        Command::Serve {
            mcp,
            project_path,
            managed_database_port,
            profile,
            daemon,
            no_daemon,
            daemon_child,
            no_write_tools,
            allow_stale_default,
            low_tokens_default,
            disable_tool,
            no_startup_sync,
        } => {
            run_mcp_server(McpServeArguments {
                mcp,
                project_path,
                managed_database_port,
                profile,
                daemon,
                no_daemon,
                daemon_child,
                no_write_tools,
                allow_stale_default,
                low_tokens_default,
                disable_tool,
                no_startup_sync,
            })
            .await
        }
        Command::Doctor {
            project_path,
            fix,
            no_project_checks,
            json,
            format,
        } => {
            run_doctor(DoctorRunInput {
                project_path,
                fix,
                skip_project_checks: no_project_checks,
                format: if json { OutputFormat::Json } else { format },
            })
            .await
        }
        Command::Db { command } => run_database_command(command).await,
        command => run_auxiliary_operator_command(command).await,
    }
}

async fn run_auxiliary_operator_command(command: Command) -> Result<ExitCode, String> {
    match command {
        Command::Export {
            path,
            project_path,
            format,
            out,
            limit,
            kind,
            edge_kind,
            language,
            file,
        } => {
            let project_path = project_path.unwrap_or(path);
            run_graph_export_command(
                project_path,
                GraphExportCommandInput {
                    format,
                    output: out,
                    limit,
                    kinds: kind,
                    edge_kinds: edge_kind,
                    languages: language,
                    file_prefix: file,
                },
            )
            .await
        }
        Command::Similar {
            symbol,
            k,
            min_score,
            same_language,
            model_id,
            allow_stale,
            project_path,
        } => {
            run_similar_command(SimilarCommandInput {
                symbol,
                k,
                min_score,
                same_language,
                model_id,
                allow_stale,
                project_path,
            })
            .await
        }
        Command::SyncIfDirty {
            path,
            quiet,
            max_file_size,
        } => run_sync_if_dirty(path, quiet, max_file_size.as_deref()).await,
        Command::InstallHooks {
            path,
            hooks,
            command,
            remove,
            dry_run,
        } => run_install_hooks_command(git_hooks::InstallHooksRequest {
            project_path: path,
            hooks,
            command,
            remove,
            dry_run,
        }),
        Command::McpBudget {
            profile,
            no_write_tools,
            disable_tool,
            top,
            json,
        } => run_mcp_budget_command(McpBudgetCommandInput {
            profile,
            no_write_tools,
            disable_tool,
            top,
            json,
        }),
        Command::Completions { shell } => {
            print!("{}", completions::render_script(shell));
            Ok(ExitCode::SUCCESS)
        }
        Command::CompleteInternal { words } => {
            let command = generated_cli::command()?;
            for candidate in completions::complete(&command, &words) {
                println!("{candidate}");
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Guide => {
            print!("{AGENT_PLAYBOOK}");
            Ok(ExitCode::SUCCESS)
        }
        Command::Llm { command } => llm_commands::run(command).await,
        Command::Upgrade { apply, json } => run_upgrade_command(apply, json).await,
        _ => Err("internal operator command routing failed".to_owned()),
    }
}

struct GraphExportCommandInput {
    format: GraphExportFormat,
    output: Option<PathBuf>,
    limit: u16,
    kinds: Option<String>,
    edge_kinds: Option<String>,
    languages: Option<String>,
    file_prefix: Option<String>,
}

struct SimilarCommandInput {
    symbol: String,
    k: u16,
    min_score: f64,
    same_language: bool,
    model_id: Option<String>,
    allow_stale: bool,
    project_path: PathBuf,
}

struct McpBudgetCommandInput {
    profile: McpProfile,
    no_write_tools: bool,
    disable_tool: Vec<String>,
    top: u16,
    json: bool,
}

async fn run_graph_export_command(
    project_path: PathBuf,
    input: GraphExportCommandInput,
) -> Result<ExitCode, String> {
    let runtime = open_runtime(&project_path).await?;
    let (project_id, freshness) = current_project(&runtime).await?;
    require_freshness(freshness, false)?;
    let output = graph_export::run_graph_export(
        runtime.database(),
        GraphExportRequest {
            project_id,
            format: input.format,
            output: input.output,
            limit: input.limit,
            kinds: input.kinds,
            edge_kinds: input.edge_kinds,
            languages: input.languages,
            file_prefix: input.file_prefix,
        },
    )
    .await?;
    print!("{output}");
    Ok(ExitCode::SUCCESS)
}

async fn run_similar_command(input: SimilarCommandInput) -> Result<ExitCode, String> {
    if !input.min_score.is_finite() || !(0.0..=1.0).contains(&input.min_score) {
        return Err("--min-score must be between 0 and 1".to_owned());
    }
    let mut arguments = Map::from_iter([
        ("start".to_owned(), Value::String(input.symbol)),
        ("direction".to_owned(), Value::String("similar".to_owned())),
        ("k".to_owned(), Value::from(input.k)),
        ("minScore".to_owned(), Value::from(input.min_score)),
        ("sameLanguage".to_owned(), Value::Bool(input.same_language)),
        ("allowStale".to_owned(), Value::Bool(input.allow_stale)),
    ]);
    if let Some(model_id) = input.model_id {
        arguments.insert("modelId".to_owned(), Value::String(model_id));
    }
    generated_cli::run_direct("cartograph_graph", input.project_path, arguments).await
}

fn run_install_hooks_command(request: git_hooks::InstallHooksRequest) -> Result<ExitCode, String> {
    let output = git_hooks::run_install_hooks(request)?;
    print!("{output}");
    Ok(ExitCode::SUCCESS)
}

fn run_mcp_budget_command(input: McpBudgetCommandInput) -> Result<ExitCode, String> {
    let definitions =
        mcp_handler::tool_definitions().map_err(|_| "MCP tool contracts are invalid".to_owned())?;
    let registered = definitions
        .iter()
        .map(|definition| definition.name())
        .collect::<std::collections::BTreeSet<_>>();
    if let Some(unknown) = input
        .disable_tool
        .iter()
        .find(|name| !registered.contains(name.as_str()))
    {
        return Err(format!("--disable-tool names an unknown tool: {unknown}"));
    }
    let report = mcp_budget::measure(mcp_budget::McpBudgetInput {
        definitions,
        profile: input.profile.into(),
        read_only_only: input.no_write_tools,
        disabled: &input.disable_tool,
        top: usize::from(input.top),
        instructions: MCP_SERVER_INSTRUCTIONS,
        playbook: AGENT_PLAYBOOK,
    })?;
    if input.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .map_err(|_| "could not serialize MCP budget".to_owned())?
        );
    } else {
        print!("{}", mcp_budget::render(&report));
    }
    Ok(ExitCode::SUCCESS)
}

async fn run_upgrade_command(apply: bool, json: bool) -> Result<ExitCode, String> {
    let report = upgrade::run_upgrade(apply).await;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .map_err(|_| "could not serialize upgrade report".to_owned())?
        );
    } else {
        print!("{}", upgrade::render(&report));
    }
    Ok(if upgrade::succeeded(&report) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

async fn run_find(arguments: FindArguments) -> Result<ExitCode, String> {
    let FindArguments {
        project_path,
        query,
        by,
        limit,
        allow_stale,
        format,
    } = arguments;
    let runtime = open_runtime(&project_path).await?;
    let (project_id, freshness) = current_project(&runtime).await?;
    require_freshness(freshness, allow_stale)?;
    let retrieval = DeterministicRetriever::new(runtime.database().clone());
    match by {
        FindBy::Auto | FindBy::Hybrid => {
            let mode = if matches!(by, FindBy::Hybrid) {
                SearchMode::Hybrid
            } else {
                SearchMode::Auto
            };
            let options = RetrievalOptions::new(mode, limit).map_err(|error| error.to_string())?;
            let result = runtime
                .search(RetrievalRequest::new(project_id, query, options))
                .await
                .map_err(|error| error.to_string())?;
            print_fresh_evidence(freshness, &result, format)?;
        }
        FindBy::Name => {
            let query = ExactTextQuery::new(&query, limit).map_err(|error| error.to_string())?;
            let result = retrieval
                .exact_name(&project_id, query)
                .await
                .map_err(|error| error.to_string())?;
            print_fresh_evidence(freshness, &result, format)?;
        }
        FindBy::Path => {
            let path = NormalizedPath::parse(&query)
                .map_err(|_| "source path must be project-relative".to_owned())?;
            let query = ExactPathQuery::new(&path, limit).map_err(|error| error.to_string())?;
            let result = retrieval
                .exact_path(&project_id, query)
                .await
                .map_err(|error| error.to_string())?;
            print_fresh_evidence(freshness, &result, format)?;
        }
        FindBy::Reference => {
            let query = ExactTextQuery::new(&query, limit).map_err(|error| error.to_string())?;
            let result = retrieval
                .exact_reference(&project_id, query)
                .await
                .map_err(|error| error.to_string())?;
            print_fresh_evidence(freshness, &result, format)?;
        }
        FindBy::Bm25 => {
            let query = LexicalQuery::new(query, limit).map_err(|error| error.to_string())?;
            let result = retrieval
                .bm25(project_id, query)
                .await
                .map_err(|error| error.to_string())?;
            print_fresh_evidence(freshness, &result, format)?;
        }
    }
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_files(arguments: FilesArguments) -> Result<ExitCode, String> {
    let runtime = open_runtime(&arguments.project_path).await?;
    let (project_id, freshness) = current_project(&runtime).await?;
    require_freshness(freshness, arguments.allow_stale)?;
    let mut query = FileInventoryQuery::new(arguments.limit).map_err(|error| error.to_string())?;
    if let Some(directory) = arguments.directory {
        query = query.within_directory(
            NormalizedPath::parse(&directory)
                .map_err(|_| "source directory must be project-relative".to_owned())?,
        );
    }
    if let Some(language) = arguments.language {
        query = query.with_language(
            SourceLanguage::from_stable_str(&language)
                .ok_or_else(|| "language must be a registered stable identifier".to_owned())?,
        );
    }
    let result = DeterministicRetriever::new(runtime.database().clone())
        .files(&project_id, &query)
        .await
        .map_err(|error| error.to_string())?;
    print_fresh_evidence(freshness, &result, arguments.format)?;
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_entry_points(arguments: EntryPointsArguments) -> Result<ExitCode, String> {
    let runtime = open_runtime(&arguments.project_path).await?;
    let (project_id, freshness) = current_project(&runtime).await?;
    require_freshness(freshness, arguments.allow_stale)?;
    let mut query = EntryPointsQuery::new(arguments.limit).map_err(|error| error.to_string())?;
    if let Some(bucket) = arguments.bucket {
        query = query.with_bucket(bucket);
    }
    let result = DeterministicRetriever::new(runtime.database().clone())
        .entry_points(&project_id, query)
        .await
        .map_err(|error| error.to_string())?;
    print_fresh_evidence(freshness, &result, arguments.format)?;
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_at_range(arguments: AtRangeArguments) -> Result<ExitCode, String> {
    let runtime = open_runtime(&arguments.project_path).await?;
    let (project_id, freshness) = current_project(&runtime).await?;
    require_freshness(freshness, arguments.allow_stale)?;
    let path = NormalizedPath::parse(&arguments.file)
        .map_err(|_| "source file must be project-relative".to_owned())?;
    let query = SourceRangeQuery::new(SourceRangeQueryInput {
        path,
        start_line: arguments.start_line,
        end_line: arguments.end_line,
        limit: arguments.limit,
    })
    .map_err(|error| error.to_string())?;
    let result = DeterministicRetriever::new(runtime.database().clone())
        .symbols_at_range(&project_id, &query)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "source file was not found in the current generation".to_owned())?;
    print_fresh_evidence(freshness, &result, arguments.format)?;
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_context(arguments: ContextArguments) -> Result<ExitCode, String> {
    let ContextArguments {
        project_path,
        task,
        exact_name,
        exact_path,
        exact_reference,
        mode,
        format,
    } = arguments;
    let runtime = open_runtime(&project_path).await?;
    let (project_id, freshness) = current_project(&runtime).await?;
    let mode = SearchMode::from(mode);
    let overlay_task = task.clone();
    let intent = TaskIntent::classify(&task);
    let budget = ContextBudget::for_intent(intent);
    let retrieval_options =
        RetrievalOptions::new(mode, budget.candidate_limit()).map_err(|error| error.to_string())?;
    let prepared = runtime
        .prepare_retrieval(RetrievalRequest::new(
            project_id.clone(),
            task.clone(),
            retrieval_options,
        ))
        .await
        .map_err(|error| error.to_string())?;
    let mut request = ContextRequest::new(
        project_id,
        task,
        ContextRequestOptions::new(freshness, budget)
            .with_search(mode, prepared.semantic_readiness()),
    )
    .map_err(|error| error.to_string())?
    .with_intent(intent);
    if let Some(name) = exact_name {
        request = request
            .with_anchor(ContextAnchor::ExactName(name))
            .map_err(|error| error.to_string())?;
    }
    if let Some(path) = exact_path {
        request = request
            .with_anchor(ContextAnchor::ExactPath(
                NormalizedPath::parse(&path)
                    .map_err(|_| "source path must be project-relative".to_owned())?,
            ))
            .map_err(|error| error.to_string())?;
    }
    if let Some(reference) = exact_reference {
        request = request
            .with_anchor(ContextAnchor::ExactReference(reference))
            .map_err(|error| error.to_string())?;
    }
    let result = DeterministicRetriever::new(runtime.database().clone())
        .context_packet_with_channels(&request, prepared.into_channels())
        .await
        .map_err(|error| error.to_string())?;
    let result = if freshness == IndexFreshness::Current {
        result
    } else {
        let overlay = runtime
            .working_tree_overlay(WorkingTreeOverlayRequest::new(
                overlay_task,
                cartograph_agent::ProjectCancellation::new(),
            ))
            .await
            .map_err(|error| error.to_string())?;
        result.with_working_tree_overlay(overlay)
    };
    print_serialized(&result, format)?;
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_graph(arguments: GraphArguments) -> Result<ExitCode, String> {
    validate_graph_arguments(&arguments)?;
    let GraphArguments {
        project_path,
        symbol_id,
        direction,
        target_symbol_id,
        edge_kind,
        similar_limit,
        minimum_score,
        same_language,
        model_id,
        depth,
        max_nodes,
        allow_stale,
        format,
    } = arguments;
    let runtime = open_runtime(&project_path).await?;
    let (project_id, freshness) = current_project(&runtime).await?;
    require_freshness(freshness, allow_stale)?;
    let retrieval = DeterministicRetriever::new(runtime.database().clone());
    let execution = GraphExecution {
        retrieval: &retrieval,
        freshness,
        format,
    };
    if direction == GraphAxis::Similar {
        run_similar_graph(
            execution,
            SimilarGraphInput {
                project_id,
                symbol_id,
                limit: similar_limit.unwrap_or(5),
                minimum_score: minimum_score.unwrap_or(0.3),
                same_language,
                model_id,
            },
        )
        .await?;
    } else {
        run_structural_graph(
            execution,
            StructuralGraphInput {
                project_id,
                symbol_id,
                direction,
                target_symbol_id,
                edge_kind,
                depth,
                max_nodes,
            },
        )
        .await?;
    }
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

fn validate_graph_arguments(arguments: &GraphArguments) -> Result<(), String> {
    if arguments.direction != GraphAxis::Path && arguments.target_symbol_id.is_some() {
        return Err("--to is only valid with --direction path".to_owned());
    }
    if arguments.direction == GraphAxis::Path && arguments.target_symbol_id.is_none() {
        return Err("--to is required with --direction path".to_owned());
    }
    let has_similar_options = arguments.similar_limit.is_some()
        || arguments.minimum_score.is_some()
        || arguments.same_language
        || arguments.model_id.is_some();
    if arguments.direction != GraphAxis::Similar && has_similar_options {
        return Err("--k, --min-score, --same-language, and --model-id are only valid with --direction similar".to_owned());
    }
    if arguments.direction == GraphAxis::Similar && arguments.edge_kind.is_some() {
        return Err("--edge-kind is not valid with --direction similar".to_owned());
    }
    Ok(())
}

struct GraphExecution<'retriever> {
    retrieval: &'retriever DeterministicRetriever,
    freshness: IndexFreshness,
    format: OutputFormat,
}

struct SimilarGraphInput {
    project_id: ProjectId,
    symbol_id: String,
    limit: u16,
    minimum_score: f64,
    same_language: bool,
    model_id: Option<String>,
}

async fn run_similar_graph(
    execution: GraphExecution<'_>,
    input: SimilarGraphInput,
) -> Result<(), String> {
    let symbol = SymbolId::parse(&input.symbol_id)
        .map_err(|_| "symbol ID must be a non-nil UUID".to_owned())?;
    let mut request = SimilarRequest::new(input.project_id, symbol, input.limit)
        .and_then(|request| request.with_minimum_score(input.minimum_score))
        .map_err(|error| error.to_string())?
        .with_same_language(input.same_language);
    if let Some(model_id) = input.model_id {
        request = request.with_model_id(
            ModelId::parse(&model_id).map_err(|_| "model ID must be a non-nil UUID".to_owned())?,
        );
    }
    let result = execution
        .retrieval
        .similar(&request)
        .await
        .map_err(|error| error.to_string())?;
    print_fresh_evidence(execution.freshness, &result, execution.format)
}

struct StructuralGraphInput {
    project_id: ProjectId,
    symbol_id: String,
    direction: GraphAxis,
    target_symbol_id: Option<String>,
    edge_kind: Option<EdgeKind>,
    depth: u8,
    max_nodes: u16,
}

async fn run_structural_graph(
    execution: GraphExecution<'_>,
    input: StructuralGraphInput,
) -> Result<(), String> {
    let request = traversal_request(TraversalArguments {
        project_id: input.project_id.clone(),
        symbol_id: &input.symbol_id,
        depth: input.depth,
        max_nodes: input.max_nodes,
        edge_kind: input.edge_kind,
    })?;
    match input.direction {
        GraphAxis::Callers => print_fresh_evidence(
            execution.freshness,
            &execution
                .retrieval
                .callers(&request)
                .await
                .map_err(|error| error.to_string())?,
            execution.format,
        ),
        GraphAxis::Callees => print_fresh_evidence(
            execution.freshness,
            &execution
                .retrieval
                .callees(&request)
                .await
                .map_err(|error| error.to_string())?,
            execution.format,
        ),
        GraphAxis::Both => print_fresh_evidence(
            execution.freshness,
            &execution
                .retrieval
                .both(&request)
                .await
                .map_err(|error| error.to_string())?,
            execution.format,
        ),
        GraphAxis::Path => run_graph_path(execution, input, &request).await,
        GraphAxis::Impact => print_fresh_evidence(
            execution.freshness,
            &execution
                .retrieval
                .impact(&request)
                .await
                .map_err(|error| error.to_string())?,
            execution.format,
        ),
        GraphAxis::Similar => unreachable!("similar is handled before structural traversal"),
    }
}

async fn run_graph_path(
    execution: GraphExecution<'_>,
    input: StructuralGraphInput,
    request: &TraversalRequest,
) -> Result<(), String> {
    let target_symbol_id = input
        .target_symbol_id
        .as_deref()
        .ok_or_else(|| "--to is required with --direction path".to_owned())?;
    let target = SymbolId::parse(target_symbol_id)
        .map_err(|_| "target symbol ID must be a non-nil UUID".to_owned())?;
    let mut path = GraphPathRequest::new(GraphPathRequestInput {
        project_id: input.project_id,
        start: request.roots()[0].clone(),
        target,
        budget: TraversalBudget::new(input.depth, input.max_nodes)
            .map_err(|error| error.to_string())?,
    });
    if let Some(edge_kind) = input.edge_kind {
        path = path.with_edge_kind(edge_kind);
    }
    let result = execution
        .retrieval
        .path(&path)
        .await
        .map_err(|error| error.to_string())?;
    print_fresh_evidence(execution.freshness, &result, execution.format)
}

async fn run_affected(arguments: AffectedArguments) -> Result<ExitCode, String> {
    let AffectedArguments {
        project_path,
        symbol_id,
        depth,
        max_nodes,
        limit,
        allow_stale,
        format,
    } = arguments;
    let runtime = open_runtime(&project_path).await?;
    let (project_id, freshness) = current_project(&runtime).await?;
    require_freshness(freshness, allow_stale)?;
    let request = traversal_request(TraversalArguments {
        project_id,
        symbol_id: &symbol_id,
        depth,
        max_nodes,
        edge_kind: None,
    })?;
    let result = DeterministicRetriever::new(runtime.database().clone())
        .affected_tests(&request, limit)
        .await
        .map_err(|error| error.to_string())?;
    print_fresh_evidence(freshness, &result, format)?;
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_show(arguments: ShowArguments) -> Result<ExitCode, String> {
    let symbol_id = SymbolId::parse(&arguments.symbol_id)
        .map_err(|_| "symbol ID must be a non-nil UUID".to_owned())?;
    let maximum_bytes = usize::try_from(arguments.max_bytes)
        .map_err(|_| "source-context byte limit is invalid".to_owned())?;
    let options = SourceContextOptions::new(arguments.context_lines, maximum_bytes)
        .map_err(|error| error.to_string())?;
    let runtime = open_runtime(&arguments.project_path).await?;
    let result = runtime
        .source_context(SourceContextRequest::new(symbol_id, options))
        .await;
    runtime.close().await;
    let result = result.map_err(|error| error.to_string())?;
    if !result.fresh() && !arguments.allow_stale {
        return Err(stale_index_message());
    }
    print_serialized(&result, arguments.format)?;
    Ok(ExitCode::SUCCESS)
}

async fn run_review(arguments: ReviewArguments) -> Result<ExitCode, String> {
    let ReviewArguments {
        project_path,
        base_ref,
        max_changed_files,
        format,
    } = arguments;
    let options = ReviewOptions::new(base_ref)
        .and_then(|options| options.with_max_changed_files(max_changed_files))
        .map_err(|error| error.to_string())?;
    let runtime = open_runtime(&project_path).await?;
    let report = runtime
        .review(&options)
        .await
        .map_err(|error| error.to_string())?;
    print_review_report(&report, format)?;
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn open_runtime(project_path: &PathBuf) -> Result<ProjectRuntime, String> {
    let settings = resolve_database_settings(project_path)?;
    ProjectRuntime::connect(project_path, &settings)
        .await
        .map_err(|error| error.to_string())
}

fn resolve_database_settings(project_path: &PathBuf) -> Result<DatabaseSettings, String> {
    resolve_database_settings_with_port(project_path, None)
}

fn resolve_database_settings_with_port(
    project_path: &PathBuf,
    managed_database_port: Option<u16>,
) -> Result<DatabaseSettings, String> {
    if env::var_os(DATABASE_URL_ENV).is_some() {
        return DatabaseSettings::from_env().map_err(|error| error.to_string());
    }
    let port = resolve_managed_database_port(managed_database_port)?;
    ManagedDatabase::new(project_path, port)
        .and_then(|database| database.connection_settings())
        .map_err(|error| format!("{error}; run `cartograph db start --project-path <path>` first"))
}

fn resolve_managed_database_port(explicit: Option<u16>) -> Result<u16, String> {
    if let Some(port) = explicit {
        return (port > 0).then_some(port).ok_or_else(|| {
            "managed database port must be an integer between 1 and 65535".to_owned()
        });
    }
    let port = match env::var(MANAGED_DATABASE_PORT_ENV) {
        Ok(raw) => raw
            .parse::<u16>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                format!("{MANAGED_DATABASE_PORT_ENV} must be an integer between 1 and 65535")
            }),
        Err(env::VarError::NotPresent) => Ok(DEFAULT_MANAGED_DATABASE_PORT),
        Err(env::VarError::NotUnicode(_)) => Err(format!(
            "{MANAGED_DATABASE_PORT_ENV} must be an integer between 1 and 65535"
        )),
    }?;
    Ok(port)
}

async fn current_project(runtime: &ProjectRuntime) -> Result<(ProjectId, IndexFreshness), String> {
    let status = runtime.status().await.map_err(|error| error.to_string())?;
    let snapshot = status
        .snapshot
        .ok_or_else(|| "project has no index; run `cartograph index`".to_owned())?;
    Ok((
        snapshot.project_id,
        if status.fresh {
            IndexFreshness::Current
        } else {
            IndexFreshness::Stale
        },
    ))
}

fn require_freshness(freshness: IndexFreshness, allow_stale: bool) -> Result<(), String> {
    if freshness == IndexFreshness::Current || allow_stale {
        Ok(())
    } else {
        Err(stale_index_message())
    }
}

fn stale_index_message() -> String {
    "Cartograph index is stale; synchronize it or explicitly pass --allow-stale".to_owned()
}

fn traversal_request(arguments: TraversalArguments<'_>) -> Result<TraversalRequest, String> {
    let TraversalArguments {
        project_id,
        symbol_id,
        depth,
        max_nodes,
        edge_kind,
    } = arguments;
    let symbol_id =
        SymbolId::parse(symbol_id).map_err(|_| "symbol ID must be a non-nil UUID".to_owned())?;
    let budget = TraversalBudget::new(depth, max_nodes).map_err(|error| error.to_string())?;
    let request = TraversalRequest::new(project_id, [symbol_id], budget)
        .map_err(|error| error.to_string())?;
    Ok(match edge_kind {
        Some(edge_kind) => request.with_edge_kind(edge_kind),
        None => request,
    })
}

fn print_serialized(value: &impl Serialize, format: OutputFormat) -> Result<(), String> {
    let rendered = match format {
        OutputFormat::Text | OutputFormat::Json => serde_json::to_string_pretty(value)
            .map_err(|_| "could not serialize Cartograph result".to_owned())?,
    };
    println!("{rendered}");
    Ok(())
}

fn print_fresh_evidence(
    freshness: IndexFreshness,
    evidence: &impl Serialize,
    format: OutputFormat,
) -> Result<(), String> {
    print_serialized(
        &CliFreshEvidence {
            freshness,
            evidence,
        },
        format,
    )
}

fn print_review_report(report: &ReviewReport, format: OutputFormat) -> Result<(), String> {
    if matches!(format, OutputFormat::Json) {
        return print_serialized(report, format);
    }
    let comparison = report.comparison();
    let packet = report.packet();
    println!(
        "Review against {} ({}): {} worktree, {} changed file(s){}",
        comparison.base_ref(),
        comparison
            .base_commit()
            .chars()
            .take(12)
            .collect::<String>(),
        if comparison.worktree_dirty() {
            "dirty"
        } else {
            "clean"
        },
        comparison.files().len(),
        if comparison.truncated() {
            " (truncated)"
        } else {
            ""
        }
    );
    println!(
        "Index evidence: {:?} freshness, {:?} confidence, abstention {:?}",
        packet.freshness(),
        packet.confidence(),
        packet.abstention()
    );
    for file in comparison.files() {
        println!("- {} {}", file.kind().as_str(), file.path());
    }
    println!(
        "Context: {} indexed changed file(s), {} evidence item(s), {} affected test(s)",
        packet.indexed_changed_files().len(),
        packet.evidence().len(),
        packet.affected_tests().len()
    );
    if packet.truncation().any() {
        println!(
            "Truncation: changed_files={} symbol_roots={} graph={} affected_tests={} evidence={}",
            packet.truncation().changed_files(),
            packet.truncation().symbol_roots(),
            packet.truncation().graph(),
            packet.truncation().affected_tests(),
            packet.truncation().evidence()
        );
    }
    Ok(())
}

struct AgentInstallContext {
    project_path: PathBuf,
    executable: PathBuf,
    location: AgentInstallLocation,
    managed_database_port: Option<u16>,
    command: Option<String>,
    permissions: bool,
    format: OutputFormat,
}

impl AgentInstallContext {
    fn request(&self, target: InstallTarget) -> Result<InstallRequest, String> {
        let request = InstallRequest::new(InstallRequestInput {
            project_root: &self.project_path,
            executable: &self.executable,
            target,
            location: self.location,
            command_override: self.command.as_deref(),
            permissions: self.permissions,
        })
        .map_err(|error| error.to_string())?;
        Ok(match self.managed_database_port {
            Some(port) => request.with_managed_database_port(port),
            None => request,
        })
    }

    fn print_config(&self, target: &str) -> Result<(), String> {
        let target = InstallTarget::parse(target).ok_or_else(|| unknown_target(target))?;
        print!(
            "{}",
            install::print_config(&self.request(target)?).map_err(|error| error.to_string())?
        );
        Ok(())
    }

    fn apply_targets(
        &self,
        targets: Vec<InstallTarget>,
        remove: bool,
    ) -> Result<Vec<install::InstallReport>, String> {
        let mut reports = Vec::with_capacity(targets.len());
        for target in targets {
            if !target.supports(self.location) {
                if matches!(self.format, OutputFormat::Text) {
                    eprintln!(
                        "{}: skipped because it has no project-local MCP configuration",
                        target.label()
                    );
                }
                continue;
            }
            let request = self.request(target)?;
            let report = if remove {
                install::uninstall(&request)
            } else {
                install::install(&request)
            }
            .map_err(|error| format!("{}: {error}", target.label()))?;
            reports.push(report);
        }
        Ok(reports)
    }

    async fn initialize_local_project(&self) -> Result<(), String> {
        if env::var_os(DATABASE_URL_ENV).is_none() {
            run_database_start(DatabaseStartArguments {
                project_path: self.project_path.clone(),
                port: self
                    .managed_database_port
                    .unwrap_or(DEFAULT_MANAGED_DATABASE_PORT),
                wait_seconds: 90,
                format: self.format,
            })
            .await?;
        }
        run_index(IndexArguments {
            project_path: self.project_path.clone(),
            workers: None,
            force: false,
            format: self.format,
            managed_database_port: self.managed_database_port,
        })
        .await
        .map(|_| ())
    }

    fn install_hooks(&self) {
        let hook_command = self
            .command
            .clone()
            .or_else(|| self.executable.to_str().map(str::to_owned));
        match git_hooks::run_install_hooks(git_hooks::InstallHooksRequest {
            project_path: self.project_path.clone(),
            hooks: None,
            command: hook_command,
            remove: false,
            dry_run: false,
        }) {
            Ok(output) if matches!(self.format, OutputFormat::Text) => print!("{output}"),
            Ok(_) => {}
            Err(error) if matches!(self.format, OutputFormat::Text) => {
                eprintln!("Git hooks were not installed: {error}");
            }
            Err(_) => {}
        }
    }
}

async fn run_agent_install(arguments: AgentInstallArguments) -> Result<ExitCode, String> {
    let AgentInstallArguments {
        target,
        location,
        project_path,
        managed_database_port,
        yes,
        permissions,
        hooks,
        command,
        print_config,
        format,
        remove,
    } = arguments;
    let executable = env::current_exe()
        .map_err(|_| "could not resolve the current Cartograph executable".to_owned())?;
    let location = AgentInstallLocation::from(location);
    let managed_database_port = if !remove
        && location == AgentInstallLocation::Local
        && env::var_os(DATABASE_URL_ENV).is_none()
    {
        Some(resolve_managed_database_port(managed_database_port)?)
    } else {
        None
    };
    let context = AgentInstallContext {
        project_path,
        executable,
        location,
        managed_database_port,
        command,
        permissions,
        format,
    };
    if let Some(target) = print_config {
        if remove {
            return Err("--print-config is only available for install".to_owned());
        }
        context.print_config(&target)?;
        return Ok(ExitCode::SUCCESS);
    }

    let selector = target
        .as_deref()
        .unwrap_or(if remove { "all" } else { "auto" });
    let targets = resolve_install_targets(selector, &context)?;
    if !remove && !yes {
        confirm_agent_install(context.location, &targets)?;
    }

    let reports = context.apply_targets(targets, remove)?;
    print_install_reports(&reports, context.format, remove)?;

    if !remove && context.location == AgentInstallLocation::Local {
        context.initialize_local_project().await?;
    }

    if !remove && context.location == AgentInstallLocation::Local && hooks {
        context.install_hooks();
    }
    Ok(ExitCode::SUCCESS)
}

fn resolve_install_targets(
    selector: &str,
    context: &AgentInstallContext,
) -> Result<Vec<InstallTarget>, String> {
    match selector.trim().to_ascii_lowercase().as_str() {
        "none" => return Ok(Vec::new()),
        "all" => return Ok(InstallTarget::ALL.to_vec()),
        "auto" => {
            let mut detected = Vec::new();
            for target in InstallTarget::ALL {
                if !target.supports(context.location) {
                    continue;
                }
                let request = InstallRequest::new(InstallRequestInput {
                    project_root: &context.project_path,
                    executable: &context.executable,
                    target,
                    location: context.location,
                    command_override: context.command.as_deref(),
                    permissions: context.permissions,
                })
                .map_err(|error| error.to_string())?;
                if request.detected() {
                    detected.push(target);
                }
            }
            if detected.is_empty() {
                detected.push(InstallTarget::Claude);
            }
            return Ok(detected);
        }
        _ => {}
    }
    let mut targets = Vec::new();
    for value in selector
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let target = InstallTarget::parse(value).ok_or_else(|| unknown_target(value))?;
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    if targets.is_empty() {
        return Err("--target must name at least one agent, or auto, all, or none".to_owned());
    }
    Ok(targets)
}

fn unknown_target(value: &str) -> String {
    let known = InstallTarget::ALL
        .iter()
        .map(|target| target.label())
        .collect::<Vec<_>>()
        .join(", ");
    format!("unknown target {value:?}; known targets: {known}, plus auto, all, none")
}

fn confirm_agent_install(
    location: AgentInstallLocation,
    targets: &[InstallTarget],
) -> Result<(), String> {
    if !std::io::stdin().is_terminal() {
        return Err("install needs --yes when stdin is not interactive".to_owned());
    }
    let target_list = targets
        .iter()
        .map(|target| target.label())
        .collect::<Vec<_>>()
        .join(", ");
    print!(
        "Install Cartograph for {target_list} at {} scope? [Y/n] ",
        match location {
            AgentInstallLocation::Global => "global",
            AgentInstallLocation::Local => "project-local",
        }
    );
    std::io::stdout()
        .flush()
        .map_err(|_| "could not write the install prompt".to_owned())?;
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .map_err(|_| "could not read the install confirmation".to_owned())?;
    if answer.trim().is_empty() || answer.trim().eq_ignore_ascii_case("y") {
        Ok(())
    } else {
        Err("installation cancelled".to_owned())
    }
}

fn print_install_reports(
    reports: &[InstallReport],
    format: OutputFormat,
    removed: bool,
) -> Result<(), String> {
    if matches!(format, OutputFormat::Json) {
        return print_serialized(&reports, format);
    }
    if reports.is_empty() {
        println!("No agent targets selected.");
        return Ok(());
    }
    for report in reports {
        println!(
            "{} ({}): {}",
            report.target().label(),
            match report.location() {
                AgentInstallLocation::Global => "global",
                AgentInstallLocation::Local => "local",
            },
            if report.changed() {
                if removed { "removed" } else { "installed" }
            } else if removed {
                "already absent"
            } else {
                "already current"
            }
        );
        for file in report.files() {
            println!("- {} {}", file.action().label(), file.path().display());
        }
        println!("  executable: {}", report.executable());
        println!("  project: {}", report.project_root().display());
    }
    if reports.iter().any(InstallReport::changed) {
        println!("Restart changed agent hosts to load the Cartograph MCP server.");
    }
    Ok(())
}

async fn run_mcp_server(arguments: McpServeArguments) -> Result<ExitCode, String> {
    let McpServeArguments {
        mcp,
        project_path,
        managed_database_port,
        profile,
        daemon: _daemon,
        no_daemon: _no_daemon,
        daemon_child: _daemon_child,
        no_write_tools,
        allow_stale_default,
        low_tokens_default,
        disable_tool,
        no_startup_sync,
    } = arguments;
    if !mcp {
        return Err("serve requires --mcp; Cartograph v2 uses stdio MCP transport".to_owned());
    }
    let read_only_mode = no_write_tools || profile == McpProfile::ReadOnly;
    let managed_database_port = if env::var_os(DATABASE_URL_ENV).is_some() {
        managed_database_port.unwrap_or(DEFAULT_MANAGED_DATABASE_PORT)
    } else {
        resolve_managed_database_port(managed_database_port)?
    };
    let settings = resolve_database_settings_with_port(&project_path, Some(managed_database_port))?;
    let runtime = ProjectRuntime::connect(&project_path, &settings)
        .await
        .map_err(|error| error.to_string())?;
    if !no_startup_sync {
        runtime
            .index(IndexOptions::default())
            .await
            .map_err(|error| format!("MCP startup sync failed: {error}"))?;
    }
    let runtime = Arc::new(runtime);
    let handler = CartographMcpHandler::new(runtime)
        .map_err(|error| error.to_string())?
        .configured(
            HandlerDefaults {
                allow_stale: allow_stale_default,
                low_tokens: low_tokens_default,
                trace_calls: !read_only_mode,
                read_only: read_only_mode,
            },
            managed_database_port,
        );
    mcp_handler::enable_handler_auto_sync(&handler)
        .await
        .map_err(|error| error.to_string())?;
    let definitions =
        mcp_handler::tool_definitions().map_err(|_| "MCP tool contracts are invalid".to_owned())?;
    let registered = definitions
        .iter()
        .map(|definition| definition.name())
        .collect::<std::collections::BTreeSet<_>>();
    if let Some(unknown) = disable_tool
        .iter()
        .find(|name| !registered.contains(name.as_str()))
    {
        return Err(format!("--disable-tool names an unknown tool: {unknown}"));
    }
    let config = ServerConfig::new(
        ServerMetadata::cartograph(),
        profile.into(),
        ServerLimits::default(),
    )
    .with_instructions(MCP_SERVER_INSTRUCTIONS)
    .and_then(|config| config.with_disabled_tools(disable_tool))
    .map(|config| config.with_read_only_tools_only(read_only_mode))
    .map_err(|error| error.to_string())?;
    let server = ProtocolServer::new(config, handler).map_err(|error| error.to_string())?;
    server
        .serve_stdio()
        .await
        .map_err(|error| error.to_string())?;
    Ok(ExitCode::SUCCESS)
}

async fn run_index(arguments: IndexArguments) -> Result<ExitCode, String> {
    let IndexArguments {
        project_path,
        workers,
        force,
        format,
        managed_database_port,
    } = arguments;
    let settings = resolve_database_settings_with_port(&project_path, managed_database_port)?;
    let runtime = ProjectRuntime::connect(&project_path, &settings)
        .await
        .map_err(|error| error.to_string())?;
    let mut options = IndexOptions::default().with_force(force);
    if let Some(workers) = workers {
        options = options
            .with_max_workers(workers)
            .map_err(|error| error.to_string())?;
    }
    let result = runtime.index(options).await;
    let report = result.map_err(|error| error.to_string())?;
    print_index_report(&report, format)?;
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_sync_if_dirty(
    project_path: PathBuf,
    quiet: bool,
    max_file_size: Option<&str>,
) -> Result<ExitCode, String> {
    let maximum_source_bytes = max_file_size.map(parse_max_file_size).transpose()?;
    let runtime = open_runtime(&project_path).await?;
    let status = runtime.status().await.map_err(|error| error.to_string())?;
    let dirty = git_worktree_dirty(&project_path);
    if !dirty && status.fresh {
        if !quiet {
            println!("No source changes and index is current; skipping sync");
        }
        runtime.close().await;
        return Ok(ExitCode::SUCCESS);
    }
    let mut options = IndexOptions::default();
    if let Some(maximum_source_bytes) = maximum_source_bytes {
        options = options
            .with_max_source_bytes(maximum_source_bytes)
            .map_err(|error| error.to_string())?;
    }
    let report = runtime
        .index(options)
        .await
        .map_err(|error| error.to_string())?;
    if !quiet {
        if report.published {
            println!("Synced changed source into a new generation");
        } else {
            println!("Source manifest is unchanged; existing generation retained");
        }
    }
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

fn parse_max_file_size(raw: &str) -> Result<usize, String> {
    let value = raw.trim().to_ascii_lowercase();
    let split = value
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(value.len());
    let (quantity, unit) = value.split_at(split);
    let unit = unit.trim();
    let multiplier = match unit {
        "" | "b" | "byte" | "bytes" => 1_usize,
        "k" | "kb" | "kib" => KIBIBYTE,
        "m" | "mb" | "mib" => MEBIBYTE,
        _ => return Err(max_file_size_error(raw)),
    };
    let bytes = quantity
        .parse::<usize>()
        .ok()
        .and_then(|quantity| quantity.checked_mul(multiplier))
        .filter(|bytes| (1..=MAXIMUM_TRANSIENT_FILE_BYTES).contains(bytes))
        .ok_or_else(|| max_file_size_error(raw))?;
    Ok(bytes)
}

fn max_file_size_error(raw: &str) -> String {
    format!("--max-file-size must be between 1 byte and 10mb (got {raw:?})")
}

fn git_worktree_dirty(project_path: &PathBuf) -> bool {
    let mut child = match ProcessCommand::new("git")
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
        .current_dir(project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return true;
    };
    let mut byte = [0_u8; 1];
    let read = stdout.read(&mut byte);
    drop(stdout);
    match read {
        Ok(0) => child.wait().map_or(true, |status| !status.success()),
        Ok(_) => {
            let _ = child.kill();
            let _ = child.wait();
            true
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            true
        }
    }
}

struct StatusRunInput {
    project_path: PathBuf,
    json: bool,
    verbose: bool,
    top_hotspots: Option<String>,
    top_biomarkers: Option<String>,
    summary_breakdown: bool,
}

async fn run_status(input: StatusRunInput) -> Result<ExitCode, String> {
    let mut arguments = Map::new();
    if input.verbose {
        arguments.insert("verbose".to_owned(), Value::Bool(true));
    }
    if input.summary_breakdown {
        arguments.insert("summaryBreakdown".to_owned(), Value::Bool(true));
    }
    if let Some(value) = normalize_status_rollup(input.top_hotspots.as_deref()) {
        arguments.insert("topHotspots".to_owned(), Value::from(value));
    }
    if let Some(value) = normalize_status_rollup(input.top_biomarkers.as_deref()) {
        arguments.insert("topBiomarkers".to_owned(), Value::from(value));
    }
    let result =
        generated_cli::run_direct_result("cartograph_status", input.project_path, arguments)
            .await?;
    if result.is_error() {
        return Ok(ExitCode::FAILURE);
    }
    let text = result
        .primary_text()
        .ok_or_else(|| "status returned no structured payload".to_owned())?;
    if input.json {
        println!("{text}");
    } else {
        let value: Value = serde_json::from_str(text)
            .map_err(|_| "status returned malformed structured payload".to_owned())?;
        render_status_text(&value);
    }
    Ok(ExitCode::SUCCESS)
}

fn normalize_status_rollup(raw: Option<&str>) -> Option<f64> {
    raw.map(|value| {
        value
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 1.0)
            .unwrap_or(0.0)
    })
}

fn render_status_text(value: &Value) {
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let storage = value
        .get("storage")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    println!("Cartograph {version} — {storage}");
    let current = value
        .pointer("/project/snapshot/current")
        .filter(|current| current.is_object());
    if let Some(current) = current {
        let generation = current
            .get("generation_id")
            .or_else(|| current.get("generationId"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let counts = current.get("counts").unwrap_or(&Value::Null);
        println!(
            "Generation {generation}: {} files, {} symbols, {} edges; source {}",
            counts.get("files").and_then(Value::as_u64).unwrap_or(0),
            counts.get("symbols").and_then(Value::as_u64).unwrap_or(0),
            counts.get("edges").and_then(Value::as_u64).unwrap_or(0),
            if value
                .pointer("/project/fresh")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "fresh"
            } else {
                "stale"
            }
        );
    } else {
        println!("Project has no published generation; run `cartograph index`.");
    }
    if let Some(generations) = value
        .pointer("/project/snapshot/generation_storage")
        .and_then(Value::as_object)
    {
        let staging = status_count(generations, "staging");
        let ready = status_count(generations, "ready");
        let current = status_count(generations, "current");
        let superseded = status_count(generations, "superseded");
        let failed = status_count(generations, "failed");
        let retained_bytes = status_count(generations, "estimated_retained_bytes");
        let generation_storage = GenerationStorageSummary {
            staging,
            ready,
            current,
            superseded,
            failed,
            estimated_retained_bytes: retained_bytes,
            ..GenerationStorageSummary::default()
        };
        println!(
            "Retained generations: {staging} staging, {ready} ready, {current} current, \
             {superseded} superseded, {failed} failed; estimated {}",
            render_byte_count(retained_bytes)
        );
        if generation_storage_needs_attention(generation_storage) {
            println!(
                "WARNING: generation retention needs attention; run `cartograph index` to trigger \
                 automatic bounded cleanup, then inspect `cartograph db prune --help` if the backlog remains."
            );
        }
    }
    if let Some(state) = value
        .pointer("/featureReadiness/state")
        .and_then(Value::as_str)
    {
        println!("Feature readiness: {state}");
    }
    let hotspots = value
        .pointer("/rollups/hotspots")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let biomarkers = value
        .pointer("/rollups/biomarkers")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if hotspots > 0 || biomarkers > 0 {
        println!("Inline rollups: {hotspots} hotspots, {biomarkers} biomarkers");
    }
    println!("Graph queries: retained; browser visualizer: intentionally removed");
}

fn status_count(values: &Map<String, Value>, field: &str) -> u64 {
    values.get(field).and_then(Value::as_u64).unwrap_or(0)
}

const fn generation_storage_needs_attention(storage: GenerationStorageSummary) -> bool {
    storage.staging > 1
        || storage.ready > 1
        || storage.superseded > MAXIMUM_SUPERSEDED_GENERATIONS_WITHOUT_ATTENTION
        || storage.failed > MAXIMUM_FAILED_GENERATIONS_WITHOUT_ATTENTION
        || storage.estimated_retained_bytes > RETAINED_BYTE_WARNING
}

fn render_byte_count(bytes: u64) -> String {
    if bytes >= GIBIBYTE_U64 {
        format!("{} GiB ({} bytes)", bytes / GIBIBYTE_U64, bytes)
    } else {
        format!("{} MiB ({} bytes)", bytes / MEBIBYTE_U64, bytes)
    }
}

async fn run_embed(
    project_path: PathBuf,
    workers: Option<u16>,
    format: OutputFormat,
) -> Result<ExitCode, String> {
    let runtime = open_runtime(&project_path).await?;
    let mut options = EmbeddingOptions::default();
    if let Some(workers) = workers {
        options = options
            .with_max_workers(workers)
            .map_err(|error| error.to_string())?;
    }
    let result = runtime.embed_current(options).await;
    runtime.close().await;
    print_serialized(&result.map_err(|error| error.to_string())?, format)?;
    Ok(ExitCode::SUCCESS)
}

async fn run_embedding_status(
    project_path: PathBuf,
    format: OutputFormat,
) -> Result<ExitCode, String> {
    let runtime = open_runtime(&project_path).await?;
    let result = runtime.embedding_status().await;
    runtime.close().await;
    print_serialized(&result.map_err(|error| error.to_string())?, format)?;
    Ok(ExitCode::SUCCESS)
}

fn print_index_report(report: &IndexReport, format: OutputFormat) -> Result<(), String> {
    match format {
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(report)
                .map_err(|_| "could not serialize the index report".to_owned())?
        ),
        OutputFormat::Text => {
            println!(
                "Index generation: {} ({})",
                report.generation_id,
                if report.published {
                    "published"
                } else {
                    "already current"
                }
            );
            println!("Workers: {}", report.workers);
            println!("Source revision: {}", report.source_revision);
            println!("Logical digest: {}", report.content_digest);
            if let Some(native) = report.native {
                println!(
                    "Native facts: {} files, {} symbols, {} resolved and {} unresolved references",
                    native.files,
                    native.symbols,
                    native.resolved_references,
                    native.unresolved_references
                );
            }
        }
    }
    Ok(())
}

async fn run_database_command(command: DatabaseCommand) -> Result<ExitCode, String> {
    match command {
        DatabaseCommand::Start(arguments) => run_database_start(arguments).await,
        DatabaseCommand::Status(arguments) => run_database_status(arguments).await,
        DatabaseCommand::Stop(arguments) => run_database_stop(arguments).await,
        DatabaseCommand::Logs(arguments) => run_database_logs(arguments).await,
        DatabaseCommand::Backup(arguments) => run_database_backup(arguments).await,
        DatabaseCommand::Restore(arguments) => run_database_restore(arguments).await,
        DatabaseCommand::Remove(arguments) => run_database_remove(arguments).await,
        DatabaseCommand::Upgrade(arguments) => run_database_upgrade(arguments).await,
        DatabaseCommand::DerivedIndex(arguments) => run_derived_index(arguments).await,
        DatabaseCommand::ImportV1(arguments) => run_v1_postgres_import(arguments).await,
        DatabaseCommand::Prune(arguments) => run_generation_prune(arguments).await,
    }
}

async fn run_database_start(arguments: DatabaseStartArguments) -> Result<ExitCode, String> {
    let database = ManagedDatabase::new(arguments.project_path, arguments.port)
        .map_err(|error| error.to_string())?
        .with_startup_timeout(Duration::from_secs(arguments.wait_seconds));
    let report = database
        .lifecycle()
        .start()
        .await
        .map_err(|error| error.to_string())?;
    print_managed_start(&report, arguments.format)?;
    Ok(ExitCode::SUCCESS)
}

async fn run_database_status(arguments: DatabaseStatusArguments) -> Result<ExitCode, String> {
    let database = ManagedDatabase::new(arguments.project_path, arguments.port)
        .map_err(|error| error.to_string())?;
    let status = database
        .lifecycle()
        .status()
        .await
        .map_err(|error| error.to_string())?;
    print_managed_status(&status, arguments.format)?;
    Ok(ExitCode::SUCCESS)
}

async fn run_database_stop(arguments: DatabaseStopArguments) -> Result<ExitCode, String> {
    let database = ManagedDatabase::new(arguments.project_path, arguments.port)
        .map_err(|error| error.to_string())?;
    let stopped = database
        .lifecycle()
        .stop()
        .await
        .map_err(|error| error.to_string())?;
    println!(
        "{}",
        if stopped {
            "Managed Cartograph database stopped."
        } else {
            "Managed Cartograph database was already stopped or absent."
        }
    );
    Ok(ExitCode::SUCCESS)
}

async fn run_database_logs(arguments: DatabaseLogsArguments) -> Result<ExitCode, String> {
    let database = ManagedDatabase::new(arguments.project_path, arguments.port)
        .map_err(|error| error.to_string())?;
    let logs = database
        .lifecycle()
        .logs(arguments.tail)
        .await
        .map_err(|error| error.to_string())?;
    print!("{logs}");
    Ok(ExitCode::SUCCESS)
}

async fn run_database_backup(arguments: DatabaseBackupArguments) -> Result<ExitCode, String> {
    let database = ManagedDatabase::new(arguments.project_path, arguments.port)
        .map_err(|error| error.to_string())?;
    let report = database
        .archives()
        .backup(arguments.destination)
        .await
        .map_err(|error| error.to_string())?;
    print_serialized(&report, arguments.format)?;
    Ok(ExitCode::SUCCESS)
}

async fn run_database_restore(arguments: DatabaseRestoreArguments) -> Result<ExitCode, String> {
    let database = ManagedDatabase::new(arguments.project_path, arguments.port)
        .map_err(|error| error.to_string())?;
    let confirmation = database
        .confirm_destructive_operation(ManagedDestructiveOperation::Restore, &arguments.confirm)
        .map_err(|error| error.to_string())?;
    let report = database
        .archives()
        .restore(arguments.source, confirmation)
        .await
        .map_err(|error| error.to_string())?;
    print_serialized(&report, arguments.format)?;
    Ok(ExitCode::SUCCESS)
}

async fn run_database_remove(arguments: DatabaseDestructiveArguments) -> Result<ExitCode, String> {
    let (database, confirmation, format) =
        prepare_database_destruction(arguments, ManagedDestructiveOperation::Remove)?;
    let report = database
        .maintenance()
        .remove(confirmation)
        .await
        .map_err(|error| error.to_string())?;
    print_serialized(&report, format)?;
    Ok(ExitCode::SUCCESS)
}

async fn run_database_upgrade(arguments: DatabaseDestructiveArguments) -> Result<ExitCode, String> {
    let (database, confirmation, format) =
        prepare_database_destruction(arguments, ManagedDestructiveOperation::Upgrade)?;
    let report = database
        .maintenance()
        .upgrade(confirmation)
        .await
        .map_err(|error| error.to_string())?;
    print_serialized(&report, format)?;
    Ok(ExitCode::SUCCESS)
}

fn prepare_database_destruction(
    arguments: DatabaseDestructiveArguments,
    operation: ManagedDestructiveOperation,
) -> Result<
    (
        ManagedDatabase,
        ManagedDestructiveConfirmation,
        OutputFormat,
    ),
    String,
> {
    let database = ManagedDatabase::new(arguments.project_path, arguments.port)
        .map_err(|error| error.to_string())?;
    let confirmation = database
        .confirm_destructive_operation(operation, &arguments.confirm)
        .map_err(|error| error.to_string())?;
    Ok((database, confirmation, arguments.format))
}

async fn run_derived_index(arguments: DatabaseDerivedIndexArguments) -> Result<ExitCode, String> {
    let database = ManagedDatabase::new(arguments.project_path, arguments.port)
        .map_err(|error| error.to_string())?;
    if arguments.rebuild {
        rebuild_derived_index(&database, arguments.confirm, arguments.format).await?;
    } else {
        let report = database
            .maintenance()
            .derived_index_health()
            .await
            .map_err(|error| error.to_string())?;
        print_serialized(&report, arguments.format)?;
    }
    Ok(ExitCode::SUCCESS)
}

async fn rebuild_derived_index(
    database: &ManagedDatabase,
    confirmation: Option<String>,
    format: OutputFormat,
) -> Result<(), String> {
    let acknowledgement = confirmation
        .ok_or_else(|| "--confirm rebuild-managed-derived-indexes is required".to_owned())?;
    let confirmation = database
        .confirm_destructive_operation(
            ManagedDestructiveOperation::RebuildDerivedIndexes,
            &acknowledgement,
        )
        .map_err(|error| error.to_string())?;
    let report = database
        .maintenance()
        .rebuild_derived_indexes(confirmation)
        .await
        .map_err(|error| error.to_string())?;
    print_serialized(&report, format)
}

async fn run_v1_postgres_import(arguments: V1ImportArguments) -> Result<ExitCode, String> {
    let V1ImportArguments {
        project_path,
        source_schema,
        maximum_rows,
        maximum_source_bytes,
        dry_run,
        confirm,
        format,
    } = arguments;
    if !dry_run && confirm.as_deref() != Some(V1_IMPORT_CONFIRMATION) {
        return Err(format!(
            "v1 import requires --confirm {V1_IMPORT_CONFIRMATION}"
        ));
    }
    let source_schema = cartograph_config::DatabaseSchema::parse(&source_schema)
        .map_err(|error| error.to_string())?;
    let identity = ProjectRuntime::inspect_source_identity(&project_path)
        .map_err(|error| error.to_string())?;
    let validation =
        GenerationValidationLimits::new(DEFAULT_IMPORT_OUTPUT_BYTES, DEFAULT_IMPORT_WORKING_BYTES)
            .map_err(|error| error.to_string())?;
    let limits = V1PostgresImportLimits::new(maximum_rows, maximum_source_bytes, validation)
        .map_err(|error| error.to_string())?;
    let execution = V1PostgresImportExecution::new(
        maintenance_owner(),
        MAINTENANCE_LEASE_DURATION,
        MAINTENANCE_STATEMENT_TIMEOUT,
    );
    let source_revision =
        V1PostgresSourceRevision::new(identity.repository_fingerprint, identity.source_revision);
    let source = V1PostgresSource::new(source_schema, &project_path, source_revision);
    let request = V1PostgresImportRequest::new(source, execution, limits);
    let settings = resolve_database_settings(&project_path)?;
    let pool = cartograph_db::connect(&settings)
        .await
        .map_err(|error| error.to_string())?;
    let database = CartographDatabase::new(pool, settings.schema().clone());
    let result = if dry_run {
        database
            .dry_run_v1_postgres_import(&request)
            .await
            .map_err(|error| error.to_string())
            .and_then(|report| print_serialized(&report, format))
    } else {
        database
            .import_v1_postgres(request)
            .await
            .map_err(|error| error.to_string())
            .and_then(|report| print_serialized(&report, format))
    };
    database.close().await;
    result?;
    Ok(ExitCode::SUCCESS)
}

async fn run_generation_prune(arguments: PruneArguments) -> Result<ExitCode, String> {
    let PruneArguments {
        project_path,
        keep_superseded,
        maximum_deletions,
        confirm,
        format,
    } = arguments;
    if confirm != RETENTION_CONFIRMATION {
        return Err(format!(
            "generation pruning requires --confirm {RETENTION_CONFIRMATION}"
        ));
    }
    let policy = GenerationRetentionPolicy::new(keep_superseded, maximum_deletions)
        .map_err(|error| error.to_string())?;
    let runtime = open_runtime(&project_path).await?;
    let status = runtime.status().await.map_err(|error| error.to_string())?;
    let project_id = status
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.project_id.clone())
        .ok_or_else(|| "project has no index; nothing can be pruned".to_owned())?;
    let lease = runtime
        .database()
        .acquire_lease(LeaseRequest::new(
            LeaseTarget::new(project_id, ProjectOperation::Migration, None),
            maintenance_owner(),
            MAINTENANCE_LEASE_DURATION,
        ))
        .await
        .map_err(|error| error.to_string())?;
    let fence = lease.fence();
    let cleanup = runtime
        .database()
        .cleanup_generations(GenerationRetentionRequest::new(
            policy,
            &fence,
            MAINTENANCE_STATEMENT_TIMEOUT,
        ))
        .await
        .map_err(|error| error.to_string());
    let release = runtime
        .database()
        .release_lease(&lease)
        .await
        .map_err(|error| error.to_string());
    let result = cleanup.and_then(|report| release.map(|()| report));
    runtime.close().await;
    print_serialized(&result?, format)?;
    Ok(ExitCode::SUCCESS)
}

fn maintenance_owner() -> LeaseOwner {
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    LeaseOwner::new(process::id(), format!("cartograph-cli:{started}"))
}

fn print_managed_start(report: &ManagedStartReport, format: OutputFormat) -> Result<(), String> {
    match format {
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(report)
                .map_err(|_| "could not serialize the managed start report".to_owned())?
        ),
        OutputFormat::Text => {
            println!(
                "Managed credentials: {}",
                if report.credentials_created {
                    "created privately"
                } else {
                    "reused"
                }
            );
            println!(
                "Managed container: {}",
                if report.container_created {
                    "created"
                } else {
                    "reused"
                }
            );
            println!(
                "Cartograph schema: {} at version {} (applied now: {})",
                report.schema,
                report.migrations.current_version,
                if report.migrations.applied_versions.is_empty() {
                    "none".to_owned()
                } else {
                    report
                        .migrations
                        .applied_versions
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            );
            print!("{}", render_text_report(&report.capabilities));
        }
    }
    Ok(())
}

fn render_text_report(report: &CapabilityReport) -> String {
    let mut output = format!(
        "# Cartograph v2 database capabilities\n\n{}\n",
        report.postgres_version
    );
    for check in &report.checks {
        let marker = match check.status {
            CheckStatus::Pass => "✓",
            CheckStatus::Fail => "✗",
        };
        output.push_str(&format!("\n{marker} {} — {}\n", check.id, check.message));
        if let Some(remediation) = check.remediation {
            output.push_str(&format!("  Fix: {remediation}\n"));
        }
    }
    output
}

fn print_managed_status(
    status: &ManagedDatabaseStatus,
    format: OutputFormat,
) -> Result<(), String> {
    match format {
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(status)
                .map_err(|_| "could not serialize the managed database status".to_owned())?
        ),
        OutputFormat::Text => println!(
            "Managed database: {} ({}, loopback port {}, image {})",
            managed_state_label(status.state),
            status.container_name,
            status.port,
            if status.image_matches {
                "supported"
            } else {
                "absent or different"
            }
        ),
    }
    Ok(())
}

const fn managed_state_label(state: ManagedContainerState) -> &'static str {
    match state {
        ManagedContainerState::Missing => "missing",
        ManagedContainerState::Created => "created",
        ManagedContainerState::Starting => "starting",
        ManagedContainerState::Healthy => "healthy",
        ManagedContainerState::Unhealthy => "unhealthy",
        ManagedContainerState::Paused => "paused",
        ManagedContainerState::Restarting => "restarting",
        ManagedContainerState::Stopped => "stopped",
        ManagedContainerState::Unknown => "unknown",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DoctorStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCheck {
    id: String,
    status: DoctorStatus,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    remediation: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorReport {
    ready: bool,
    fixes_applied: Vec<String>,
    checks: Vec<DoctorCheck>,
    #[serde(skip_serializing_if = "Option::is_none")]
    database: Option<CapabilityReport>,
}

struct DoctorRunInput {
    project_path: PathBuf,
    fix: bool,
    skip_project_checks: bool,
    format: OutputFormat,
}

pub(crate) struct DoctorReportInput<'settings> {
    pub(crate) project_path: PathBuf,
    pub(crate) fix: bool,
    pub(crate) skip_project_checks: bool,
    pub(crate) explicit_database_settings: Option<&'settings DatabaseSettings>,
}

pub(crate) struct ProjectStateCheckInput<'input> {
    pub(crate) project_path: &'input Path,
    pub(crate) fix: bool,
    pub(crate) fixes: &'input mut Vec<String>,
    pub(crate) checks: &'input mut Vec<DoctorCheck>,
}

async fn run_doctor(input: DoctorRunInput) -> Result<ExitCode, String> {
    let report =
        build_doctor_report(input.project_path, input.fix, input.skip_project_checks).await?;
    match input.format {
        OutputFormat::Text => print!("{}", render_doctor_report(&report)),
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .map_err(|_| "could not serialize the doctor report".to_owned())?
        ),
    }
    Ok(if report.ready {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

async fn build_doctor_report(
    project_path: PathBuf,
    fix: bool,
    skip_project_checks: bool,
) -> Result<DoctorReport, String> {
    build_doctor_report_with_settings(DoctorReportInput {
        project_path,
        fix,
        skip_project_checks,
        explicit_database_settings: None,
    })
    .await
}

async fn apply_managed_database_doctor_fix(
    project_path: &Path,
    fixes_applied: &mut Vec<String>,
    checks: &mut Vec<DoctorCheck>,
) {
    match ManagedDatabase::new(project_path, DEFAULT_MANAGED_DATABASE_PORT) {
        Ok(database) => match database.lifecycle().start().await {
            Ok(report) => fixes_applied.push(format!(
                "managed PostgreSQL is ready; {} migration(s) applied",
                report.migrations.applied_versions.len()
            )),
            Err(error) => checks.push(doctor_fail(
                "database-fix",
                error.to_string(),
                "Start Docker, then run `cartograph db start --project-path <path>`.".to_owned(),
            )),
        },
        Err(error) => checks.push(doctor_fail(
            "database-fix",
            error.to_string(),
            "Run `cartograph db start --project-path <path>`.".to_owned(),
        )),
    }
}

async fn apply_llm_doctor_fix(
    project_path: &Path,
    fixes_applied: &mut Vec<String>,
    checks: &mut Vec<DoctorCheck>,
) {
    match llm_commands::doctor_fix_missing_tiers(project_path).await {
        Ok(fixes) => fixes_applied.extend(fixes),
        Err(error) => checks.push(doctor_fail(
            "llm-fix",
            error,
            "Run `cartograph llm setup` or `cartograph llm install --minimal`.".to_owned(),
        )),
    }
}

async fn build_doctor_report_with_settings(
    input: DoctorReportInput<'_>,
) -> Result<DoctorReport, String> {
    let project_path = input
        .project_path
        .canonicalize()
        .map_err(|_| "doctor project path must be an existing directory".to_owned())?;
    if !project_path.is_dir() {
        return Err("doctor project path must be an existing directory".to_owned());
    }
    let mut fixes_applied = Vec::new();
    let mut checks = Vec::new();

    check_native_executable(&mut checks);
    if !input.skip_project_checks {
        check_or_fix_project_state(ProjectStateCheckInput {
            project_path: &project_path,
            fix: input.fix,
            fixes: &mut fixes_applied,
            checks: &mut checks,
        })?;
    }

    let external_database =
        input.explicit_database_settings.is_some() || env::var_os(DATABASE_URL_ENV).is_some();
    if input.fix && !external_database {
        apply_managed_database_doctor_fix(&project_path, &mut fixes_applied, &mut checks).await;
    }

    if input.fix && !input.skip_project_checks {
        apply_llm_doctor_fix(&project_path, &mut fixes_applied, &mut checks).await;
    }

    if !external_database {
        check_managed_database(&project_path, &mut checks).await;
    } else {
        checks.push(doctor_pass(
            "database-source",
            if input.explicit_database_settings.is_some() {
                "Using validated external PostgreSQL settings supplied to this process."
            } else {
                "Using validated external PostgreSQL settings from the process environment."
            },
        ));
    }

    let (database, settings) =
        check_database_capabilities(&project_path, input.explicit_database_settings, &mut checks)
            .await;
    if !input.skip_project_checks
        && let Some(settings) = settings.as_ref()
    {
        check_project_index(&project_path, settings, &mut checks).await;
    }
    if !input.skip_project_checks {
        check_llm_configuration(&project_path, &mut checks).await;
    }

    let ready = !checks
        .iter()
        .any(|check| check.status == DoctorStatus::Fail);
    Ok(DoctorReport {
        ready,
        fixes_applied,
        checks,
        database,
    })
}

fn check_native_executable(checks: &mut Vec<DoctorCheck>) {
    let healthy = env::current_exe()
        .ok()
        .is_some_and(|path| native_executable_path_is_safe(&path));
    checks.push(if healthy {
        doctor_pass(
            "native-runtime",
            concat!(
                "Native Rust executable is available (",
                env!("CARGO_PKG_VERSION"),
                ")."
            ),
        )
    } else {
        doctor_fail(
            "native-runtime",
            "The running Cartograph executable could not be resolved safely.".to_owned(),
            "Reinstall the native Cartograph release binary.".to_owned(),
        )
    });
}

fn native_executable_path_is_safe(path: &Path) -> bool {
    path.canonicalize()
        .ok()
        .and_then(|canonical| fs::symlink_metadata(canonical).ok())
        .is_some_and(|metadata| metadata.file_type().is_file())
}

fn check_or_fix_project_state(input: ProjectStateCheckInput<'_>) -> Result<(), String> {
    let state = input.project_path.join(".cartograph");
    match fs::symlink_metadata(&state) {
        Ok(metadata) if metadata.file_type().is_dir() => input.checks.push(doctor_pass(
            "project-state",
            "The project has a real .cartograph state directory.",
        )),
        Ok(_) => input.checks.push(doctor_fail(
            "project-state",
            "The .cartograph state entry is not a real directory.".to_owned(),
            "Replace it with a private directory after preserving any intentional contents."
                .to_owned(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && input.fix => {
            fs::create_dir(&state).map_err(|_| {
                "doctor could not create the .cartograph state directory".to_owned()
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).map_err(|_| {
                    "doctor could not make the .cartograph state directory private".to_owned()
                })?;
            }
            input
                .fixes
                .push("created the private .cartograph state directory".to_owned());
            input.checks.push(doctor_pass(
                "project-state",
                "The project has a real .cartograph state directory.",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            input.checks.push(doctor_warn(
                "project-state",
                "The project is not initialized yet.",
                "Run `cartograph doctor --fix` or `cartograph db start`.".to_owned(),
            ))
        }
        Err(_) => input.checks.push(doctor_fail(
            "project-state",
            "The .cartograph state entry could not be inspected.".to_owned(),
            "Check project-directory permissions.".to_owned(),
        )),
    }
    Ok(())
}

async fn check_managed_database(project_path: &Path, checks: &mut Vec<DoctorCheck>) {
    let database = match ManagedDatabase::new(project_path, DEFAULT_MANAGED_DATABASE_PORT) {
        Ok(database) => database,
        Err(error) => {
            checks.push(doctor_fail(
                "managed-database",
                error.to_string(),
                "Run `cartograph db start --project-path <path>`.".to_owned(),
            ));
            return;
        }
    };
    match database.lifecycle().status().await {
        Ok(status) if status.state == ManagedContainerState::Healthy && status.image_matches => {
            checks.push(doctor_pass(
                "managed-database",
                "The project-owned PostgreSQL container is healthy and uses the pinned image.",
            ));
        }
        Ok(status) => checks.push(doctor_fail(
            "managed-database",
            format!(
                "Managed database state is {} and pinned-image match is {}.",
                managed_state_label(status.state),
                status.image_matches
            ),
            "Run `cartograph db start`; use `cartograph db upgrade` for an owned older image."
                .to_owned(),
        )),
        Err(error) => checks.push(doctor_fail(
            "managed-database",
            error.to_string(),
            "Start Docker and run `cartograph db start --project-path <path>`.".to_owned(),
        )),
    }
}

async fn check_database_capabilities(
    project_path: &PathBuf,
    explicit_database_settings: Option<&DatabaseSettings>,
    checks: &mut Vec<DoctorCheck>,
) -> (Option<CapabilityReport>, Option<DatabaseSettings>) {
    let settings = match explicit_database_settings
        .cloned()
        .map_or_else(|| resolve_database_settings(project_path), Ok)
    {
        Ok(settings) => settings,
        Err(error) => {
            checks.push(doctor_fail(
                "database-settings",
                error,
                "Set CARTOGRAPH_DATABASE_URL or run `cartograph db start`.".to_owned(),
            ));
            return (None, None);
        }
    };
    let pool = match cartograph_db::connect(&settings).await {
        Ok(pool) => pool,
        Err(error) => {
            checks.push(doctor_fail(
                "database-connection",
                error.to_string(),
                "Verify PostgreSQL connectivity or restart the managed database.".to_owned(),
            ));
            return (None, Some(settings));
        }
    };
    let report = match cartograph_db::probe_capabilities(&pool).await {
        Ok(report) => report,
        Err(error) => {
            pool.close().await;
            checks.push(doctor_fail(
                "database-capabilities",
                error.to_string(),
                "Use PostgreSQL 18 with pg_search and pgvector enabled.".to_owned(),
            ));
            return (None, Some(settings));
        }
    };
    pool.close().await;
    for capability in &report.checks {
        checks.push(DoctorCheck {
            id: format!("database-{}", capability.id),
            status: match capability.status {
                CheckStatus::Pass => DoctorStatus::Pass,
                CheckStatus::Fail => DoctorStatus::Fail,
            },
            message: capability.message.clone(),
            remediation: capability.remediation.map(str::to_owned),
        });
    }
    (Some(report), Some(settings))
}

async fn check_project_index(
    project_path: &Path,
    settings: &DatabaseSettings,
    checks: &mut Vec<DoctorCheck>,
) {
    let runtime = match ProjectRuntime::connect_read_only(project_path, settings).await {
        Ok(runtime) => runtime,
        Err(error) => {
            checks.push(doctor_fail(
                "schema-migrations",
                error.to_string(),
                "Run `cartograph db start` or verify the configured schema permissions.".to_owned(),
            ));
            return;
        }
    };
    let status = runtime.status().await;
    if let Ok(status) = &status
        && let Some(snapshot) = &status.snapshot
    {
        check_generation_storage(snapshot.generation_storage, checks);
    }
    match status {
        Ok(status)
            if status
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.current.as_ref())
                .is_none() =>
        {
            checks.push(doctor_warn(
                "project-index",
                "No published graph generation exists yet.",
                "Run `cartograph index`.".to_owned(),
            ));
        }
        Ok(status) if status.fresh => checks.push(doctor_pass(
            "project-index",
            "The published graph generation matches the live source manifest.",
        )),
        Ok(_) => checks.push(doctor_warn(
            "project-index",
            "The published graph generation is stale relative to live source.",
            "Run `cartograph index` or `cartograph sync-if-dirty`.".to_owned(),
        )),
        Err(error) => checks.push(doctor_warn(
            "project-index",
            "Project index status could not be determined.",
            format!("Run `cartograph index`; status detail: {error}"),
        )),
    }
    runtime.close().await;
}

fn check_generation_storage(storage: GenerationStorageSummary, checks: &mut Vec<DoctorCheck>) {
    let message = format!(
        "Retained generations: {} staging, {} ready, {} current, {} superseded, {} failed; \
         estimated {}.",
        storage.staging,
        storage.ready,
        storage.current,
        storage.superseded,
        storage.failed,
        render_byte_count(storage.estimated_retained_bytes)
    );
    if generation_storage_needs_attention(storage) {
        checks.push(doctor_warn(
            "generation-retention",
            message,
            "Run `cartograph index` to trigger automatic bounded cleanup; if the backlog remains, inspect `cartograph db prune --help` and database free space.".to_owned(),
        ));
    } else {
        checks.push(doctor_pass("generation-retention", message));
    }
}

async fn check_llm_configuration(project_path: &Path, checks: &mut Vec<DoctorCheck>) {
    let tiers = [
        (ProjectLlmTier::Embedding, "embedding", true),
        (ProjectLlmTier::Summarize, "summarize", true),
        (ProjectLlmTier::Local, "local", false),
        (ProjectLlmTier::Ask, "ask", false),
        (ProjectLlmTier::Classify, "classify", false),
        (ProjectLlmTier::Reranker, "reranker", false),
    ];
    let mut loopback = BTreeMap::<String, Vec<&'static str>>::new();
    for (tier, label, required) in tiers {
        let config = match load_exact_project_llm_tier(project_path, tier) {
            Ok(Some(config)) => config,
            Ok(None) if required => {
                checks.push(doctor_warn(
                    format!("llm-{label}"),
                    format!("The {label} LLM tier is not configured; deterministic graph/BM25 retrieval remains available."),
                    "Run `cartograph llm setup` or `cartograph llm install --minimal`.".to_owned(),
                ));
                continue;
            }
            Ok(None) => continue,
            Err(error) => {
                checks.push(doctor_fail(
                    format!("llm-{label}"),
                    error.to_string(),
                    "Repair .cartograph/config.json with `cartograph llm setup`.".to_owned(),
                ));
                continue;
            }
        };
        if config.credential_source() == ProjectLlmCredentialSource::InlineLegacy {
            checks.push(doctor_warn(
                format!("llm-{label}-credential"),
                "A legacy inline LLM credential is configured.",
                "Move the credential to an environment variable and use apiKeyEnv.".to_owned(),
            ));
        }
        check_local_model(label, config.model(), checks);
        let is_loopback = Url::parse(config.endpoint())
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .is_some_and(|host| {
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|address| address.is_loopback())
            });
        if is_loopback {
            loopback
                .entry(config.endpoint().to_owned())
                .or_default()
                .push(label);
        } else {
            checks.push(doctor_pass(
                format!("llm-{label}-config"),
                format!("The {label} remote tier is valid; use `cartograph llm smoke` for an authenticated request."),
            ));
        }
    }

    let probes = stream::iter(loopback)
        .map(|(endpoint, labels)| async move {
            let result = probe_openai_compatible_endpoint(&endpoint, Duration::from_secs(2)).await;
            (labels, result)
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    for (labels, result) in probes {
        for label in labels {
            match &result {
                Ok(probe) if probe.openai_compatible => checks.push(doctor_pass(
                    format!("llm-{label}-endpoint"),
                    format!("The {label} loopback endpoint is OpenAI-compatible."),
                )),
                Ok(probe) if probe.reachable => checks.push(doctor_warn(
                    format!("llm-{label}-endpoint"),
                    format!("The {label} loopback endpoint is reachable but did not expose a compatible model catalog."),
                    "Start the configured OpenAI-compatible backend and run `cartograph llm smoke`.".to_owned(),
                )),
                Ok(_) | Err(_) => checks.push(doctor_warn(
                    format!("llm-{label}-endpoint"),
                    format!("The {label} loopback endpoint is not responding."),
                    "Run `cartograph backend start` or start the externally managed provider.".to_owned(),
                )),
            }
        }
    }
}

fn check_local_model(label: &str, model: &str, checks: &mut Vec<DoctorCheck>) {
    let path = Path::new(model);
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("gguf") {
        return;
    }
    let valid = fs::symlink_metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.file_type().is_file() && metadata.len() > 0);
    checks.push(if valid {
        doctor_pass(
            format!("llm-{label}-model"),
            format!("The {label} GGUF model is a non-empty regular file."),
        )
    } else {
        doctor_warn(
            format!("llm-{label}-model"),
            format!("The configured {label} GGUF model is missing or unsafe."),
            "Run `cartograph llm install --minimal` or repair the model path.".to_owned(),
        )
    });
}

fn doctor_pass(id: impl Into<String>, message: impl Into<String>) -> DoctorCheck {
    DoctorCheck {
        id: id.into(),
        status: DoctorStatus::Pass,
        message: message.into(),
        remediation: None,
    }
}

fn doctor_warn(
    id: impl Into<String>,
    message: impl Into<String>,
    remediation: String,
) -> DoctorCheck {
    DoctorCheck {
        id: id.into(),
        status: DoctorStatus::Warn,
        message: message.into(),
        remediation: Some(remediation),
    }
}

fn doctor_fail(
    id: impl Into<String>,
    message: impl Into<String>,
    remediation: String,
) -> DoctorCheck {
    let mut check = doctor_warn(id, message, remediation);
    check.status = DoctorStatus::Fail;
    check
}

fn render_doctor_report(report: &DoctorReport) -> String {
    let mut output = "# Cartograph v2 doctor\n".to_owned();
    if !report.fixes_applied.is_empty() {
        output.push_str("\nRepairs applied:\n");
        for fix in &report.fixes_applied {
            output.push_str(&format!("- {fix}\n"));
        }
    }
    for check in &report.checks {
        let marker = match check.status {
            DoctorStatus::Pass => "✓",
            DoctorStatus::Warn => "⚠",
            DoctorStatus::Fail => "✗",
        };
        output.push_str(&format!("\n{marker} {} — {}\n", check.id, check.message));
        if let Some(remediation) = &check.remediation {
            output.push_str(&format!("  Fix: {remediation}\n"));
        }
    }
    output.push_str(if report.ready {
        "\nAll hard requirements passed. Cartograph v2 is ready; warnings identify optional or project-index gaps.\n"
    } else {
        "\nOne or more hard requirements failed. Cartograph v2 is not ready.\n"
    });
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn v1_1_33_cli_tree_remains_available_except_browser_viewer() {
        fn walk(command: &clap::Command, parent: &[String], rows: &mut BTreeMap<String, Value>) {
            let mut path = parent.to_vec();
            path.push(command.get_name().to_owned());
            let path_key = path.join(" ");
            let mut aliases = command
                .get_all_aliases()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            aliases.sort();
            let mut options = command
                .get_arguments()
                .flat_map(|argument| {
                    argument
                        .get_long()
                        .into_iter()
                        .chain(argument.get_all_aliases().unwrap_or_default())
                        .map(str::to_owned)
                })
                .collect::<Vec<_>>();
            options.sort();
            let mut positionals = command
                .get_positionals()
                .map(|argument| {
                    let id = match argument.get_id().as_str() {
                        "__compat_ask_path" => "path",
                        "__compat_files_target" => "target",
                        "project_path" => "path",
                        value => value,
                    };
                    (argument.get_index().unwrap_or(usize::MAX), id.to_owned())
                })
                .collect::<Vec<_>>();
            positionals.sort_by_key(|(index, _)| *index);
            rows.insert(
                path_key.clone(),
                serde_json::json!({
                    "path": path_key,
                    "aliases": aliases,
                    "options": options,
                    "positionals": positionals
                        .into_iter()
                        .map(|(_, positional)| positional)
                        .collect::<Vec<_>>(),
                }),
            );
            for child in command.get_subcommands() {
                walk(child, &path, rows);
            }
        }

        let mut command = generated_cli::command()
            .unwrap_or_else(|error| panic!("generated CLI command failed: {error}"));
        command.build();
        let mut current = BTreeMap::new();
        walk(&command, &[], &mut current);
        let tool_contracts = mcp_handler::tool_definitions()
            .unwrap_or_else(|error| panic!("MCP definitions failed: {error}"))
            .into_iter()
            .map(|definition| (definition.name().to_owned(), definition))
            .collect::<BTreeMap<_, _>>();
        let legacy = serde_json::from_str::<Vec<Value>>(include_str!("v1_1_33_cli_contract.json"))
            .unwrap_or_else(|error| panic!("v1.1.33 CLI fixture failed to parse: {error}"));

        for command in legacy {
            let path = command["path"]
                .as_str()
                .unwrap_or_else(|| panic!("legacy CLI path was invalid"));
            if path == "cartograph viewer" || path.starts_with("cartograph viewer ") {
                continue;
            }
            let segments = path.split_whitespace().collect::<Vec<_>>();
            let collapsed = if current.contains_key(path) {
                None
            } else if segments.len() == 3 {
                let family = segments[1];
                let value = segments[2];
                let property = match family {
                    "admin" | "summaries" | "session" => "action",
                    "review" => "mode",
                    _ => panic!("v2 dropped the v1.1.33 command `{path}`"),
                };
                let tool_name = format!("cartograph_{}", family.replace('-', "_"));
                let definition = tool_contracts
                    .get(&tool_name)
                    .unwrap_or_else(|| panic!("{tool_name} contract was missing"));
                let accepted = definition.input_schema()["properties"][property]["enum"]
                    .as_array()
                    .unwrap_or_else(|| panic!("{tool_name}.{property} enum was missing"));
                assert!(
                    accepted.iter().any(|candidate| candidate == value),
                    "v2 dropped the v1.1.33 action `{path}`"
                );
                Some(format!("cartograph {family}"))
            } else {
                panic!("v2 dropped the v1.1.33 command `{path}");
            };
            let actual_path = collapsed.as_deref().unwrap_or(path);
            let actual = current
                .get(actual_path)
                .unwrap_or_else(|| panic!("v2 dropped the v1.1.33 command `{actual_path}`"));
            for field in ["aliases", "options", "positionals"] {
                let legacy_values = command[field]
                    .as_array()
                    .unwrap_or_else(|| panic!("legacy `{path}` {field} were invalid"))
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                let actual_values = actual[field]
                    .as_array()
                    .unwrap_or_else(|| panic!("current `{path}` {field} were invalid"))
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                if collapsed.is_some() && field == "aliases" {
                    assert!(
                        legacy_values
                            .iter()
                            .all(|alias| *alias == segments[2].replace('_', "-")),
                        "collapsed action aliases drifted for `{path}`: {legacy_values:?}"
                    );
                    continue;
                }
                if collapsed.is_some() && field == "positionals" {
                    assert!(
                        legacy_values.len() <= actual_values.len().saturating_sub(1),
                        "v2 dropped v1.1.33 positional capacity on `{path}`; legacy={legacy_values:?}, current={actual_values:?}"
                    );
                    continue;
                }
                let mut cursor = 0_usize;
                for legacy_value in legacy_values {
                    let Some(relative) = actual_values[cursor..]
                        .iter()
                        .position(|actual| *actual == legacy_value)
                    else {
                        panic!(
                            "v2 dropped or reordered v1.1.33 {field} `{legacy_value}` on `{path}`; current={actual_values:?}"
                        );
                    };
                    cursor = cursor.saturating_add(relative).saturating_add(1);
                }
            }
        }
    }

    #[test]
    fn text_report_includes_actionable_failure_and_terminal_state() {
        let report = DoctorReport {
            ready: false,
            fixes_applied: Vec::new(),
            checks: vec![DoctorCheck {
                id: "database-postgres-18".to_owned(),
                status: DoctorStatus::Fail,
                message: "PostgreSQL server reports version number 170009".to_owned(),
                remediation: Some("Upgrade PostgreSQL.".to_owned()),
            }],
            database: None,
        };

        let rendered = render_doctor_report(&report);

        assert!(rendered.contains("✗ database-postgres-18"));
        assert!(rendered.contains("Fix: Upgrade PostgreSQL."));
        assert!(rendered.contains("is not ready"));
    }

    #[test]
    fn generation_retention_warning_matches_automatic_cleanup_bounds() {
        const FOUR_GIBIBYTES: u64 = 4 * 1_024 * 1_024 * 1_024;

        let healthy = GenerationStorageSummary {
            staging: 1,
            ready: 1,
            superseded: 34,
            failed: 32,
            estimated_retained_bytes: FOUR_GIBIBYTES,
            ..GenerationStorageSummary::default()
        };
        assert!(!generation_storage_needs_attention(healthy));
        let mut warnings = [healthy; 5];
        warnings[0].staging += 1;
        warnings[1].ready += 1;
        warnings[2].superseded += 1;
        warnings[3].failed += 1;
        warnings[4].estimated_retained_bytes += 1;
        for warning in warnings {
            assert!(generation_storage_needs_attention(warning));
        }
    }

    #[test]
    fn doctor_generation_retention_check_is_actionable_and_byte_exact() {
        let mut healthy_checks = Vec::new();
        check_generation_storage(
            GenerationStorageSummary {
                current: 1,
                estimated_retained_bytes: 1_024 * 1_024,
                ..GenerationStorageSummary::default()
            },
            &mut healthy_checks,
        );
        assert_eq!(healthy_checks.len(), 1);
        assert_eq!(healthy_checks[0].id, "generation-retention");
        assert_eq!(healthy_checks[0].status, DoctorStatus::Pass);
        assert!(healthy_checks[0].message.contains("1 MiB (1048576 bytes)"));
        assert!(healthy_checks[0].remediation.is_none());

        let mut warning_checks = Vec::new();
        check_generation_storage(
            GenerationStorageSummary {
                staging: 2,
                current: 1,
                estimated_retained_bytes: 5 * 1_024 * 1_024 * 1_024,
                ..GenerationStorageSummary::default()
            },
            &mut warning_checks,
        );
        assert_eq!(warning_checks.len(), 1);
        assert_eq!(warning_checks[0].id, "generation-retention");
        assert_eq!(warning_checks[0].status, DoctorStatus::Warn);
        assert!(warning_checks[0].message.contains("2 staging"));
        assert!(warning_checks[0].message.contains("5 GiB"));
        assert!(
            warning_checks[0]
                .remediation
                .as_deref()
                .is_some_and(|message| message.contains("cartograph db prune --help"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_runtime_accepts_installer_symlink_to_regular_executable() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("temporary directory failed: {error}"));
        let versioned_binary = directory.path().join("versions/v2.0.4/bin/cartograph");
        fs::create_dir_all(
            versioned_binary
                .parent()
                .unwrap_or_else(|| panic!("versioned binary must have a parent")),
        )
        .unwrap_or_else(|error| panic!("versioned directory failed: {error}"));
        fs::write(&versioned_binary, b"native-binary")
            .unwrap_or_else(|error| panic!("versioned binary failed: {error}"));
        let installer_link = directory.path().join("cartograph");
        symlink(&versioned_binary, &installer_link)
            .unwrap_or_else(|error| panic!("installer symlink failed: {error}"));

        assert!(native_executable_path_is_safe(&installer_link));
    }

    #[test]
    fn compatibility_file_size_parser_is_strict_and_bounded() {
        assert_eq!(parse_max_file_size("1"), Ok(1));
        assert_eq!(parse_max_file_size("64kb"), Ok(64 * 1024));
        assert_eq!(parse_max_file_size("10 MiB"), Ok(10 * 1024 * 1024));
        assert!(parse_max_file_size("0").is_err());
        assert!(parse_max_file_size("10.5mb").is_err());
        assert!(parse_max_file_size("11mb").is_err());
    }

    #[test]
    fn cli_parses_index_status_and_serve_commands() {
        let index = Cli::try_parse_from([
            "cartograph",
            "index",
            "workspace",
            "--workers",
            "4",
            "--force",
            "--format",
            "json",
        ])
        .unwrap_or_else(|error| panic!("index CLI did not parse: {error}"));
        match index.command {
            Command::Index {
                project_path,
                workers,
                force,
                format,
            } => {
                assert_eq!(project_path, PathBuf::from("workspace"));
                assert_eq!(workers, Some(4));
                assert!(force);
                assert!(matches!(format, OutputFormat::Json));
            }
            _ => panic!("index parsed as the wrong command"),
        }

        let status = Cli::try_parse_from(["cartograph", "status", "workspace"])
            .unwrap_or_else(|error| panic!("status CLI did not parse: {error}"));
        assert!(matches!(status.command, Command::Status { .. }));

        let guide = Cli::try_parse_from(["cartograph", "guide"])
            .unwrap_or_else(|error| panic!("guide CLI did not parse: {error}"));
        assert!(matches!(guide.command, Command::Guide));

        let serve = Cli::try_parse_from([
            "cartograph",
            "serve",
            "--mcp",
            "--project-path",
            "workspace",
            "--managed-database-port",
            "55435",
            "--profile",
            "read-only",
        ])
        .unwrap_or_else(|error| panic!("serve CLI did not parse: {error}"));
        assert!(matches!(
            serve.command,
            Command::Serve {
                mcp: true,
                managed_database_port: Some(55_435),
                profile: McpProfile::ReadOnly,
                ..
            }
        ));
    }

    #[test]
    fn managed_database_port_resolution_accepts_explicit_values_and_rejects_zero() {
        assert_eq!(resolve_managed_database_port(Some(55_435)), Ok(55_435));
        assert!(resolve_managed_database_port(Some(0)).is_err());
    }

    #[test]
    fn explicit_managed_database_port_keeps_missing_credentials_actionable() {
        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("could not create managed port fixture: {error}"));
        let result =
            resolve_database_settings_with_port(&directory.path().to_path_buf(), Some(55_435));
        let error = match result {
            Ok(_) => panic!("missing managed credentials unexpectedly resolved"),
            Err(error) => error,
        };

        assert!(error.contains("cartograph db start --project-path <path>"));
    }

    #[tokio::test]
    async fn serve_dispatch_preserves_managed_port_before_transport_validation() {
        let result = run_operator_command(Command::Serve {
            mcp: false,
            project_path: PathBuf::from("workspace"),
            managed_database_port: Some(55_435),
            profile: McpProfile::Core,
            daemon: false,
            no_daemon: false,
            daemon_child: false,
            no_write_tools: false,
            allow_stale_default: false,
            low_tokens_default: false,
            disable_tool: Vec::new(),
            no_startup_sync: true,
        })
        .await;

        assert_eq!(
            result,
            Err("serve requires --mcp; Cartograph v2 uses stdio MCP transport".to_owned())
        );
    }

    #[tokio::test]
    async fn local_print_config_accepts_an_explicit_managed_port() {
        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("could not create install fixture: {error}"));
        let result = run_agent_install(AgentInstallArguments {
            target: None,
            location: InstallLocation::Local,
            project_path: directory.path().to_path_buf(),
            managed_database_port: Some(55_435),
            yes: true,
            permissions: false,
            hooks: false,
            command: None,
            print_config: Some("codex".to_owned()),
            format: OutputFormat::Json,
            remove: false,
        })
        .await;

        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
    }

    #[test]
    fn cli_parses_review_search_and_show_commands() {
        let review = generated_cli::parse_from([
            "cartograph",
            "review",
            "context",
            "--ref",
            "main",
            "--project-path",
            "workspace",
        ])
        .unwrap_or_else(|error| panic!("review CLI did not parse: {error}"));
        let generated_cli::ParsedCli::Tool(review) = review else {
            panic!("review did not route through the generated public command");
        };
        assert_eq!(review.tool_name(), "cartograph_review");
        assert_eq!(review.arguments()["mode"], "context");
        assert_eq!(review.arguments()["baseRef"], "main");

        let find = generated_cli::parse_from(["cartograph", "find", "trace auth failure"])
            .unwrap_or_else(|error| panic!("find CLI did not parse: {error}"));
        assert!(matches!(find, generated_cli::ParsedCli::Tool(_)));

        let context = generated_cli::parse_from([
            "cartograph",
            "context",
            "trace auth failure",
            "--mode",
            "deterministic",
        ])
        .unwrap_or_else(|error| panic!("context CLI did not parse: {error}"));
        assert!(matches!(context, generated_cli::ParsedCli::Tool(_)));

        let show = Cli::try_parse_from([
            "cartograph",
            "show",
            "11111111-1111-4111-8111-111111111111",
            "--project-path",
            "workspace",
        ])
        .unwrap_or_else(|error| panic!("show CLI did not parse: {error}"));
        assert!(matches!(show.command, Command::Show { .. }));

        let graph_path = generated_cli::parse_from([
            "cartograph",
            "graph",
            "11111111-1111-4111-8111-111111111111",
            "--direction",
            "path",
            "--to",
            "22222222-2222-4222-8222-222222222222",
            "--edge-kind",
            "field-access",
        ])
        .unwrap_or_else(|error| panic!("graph path CLI did not parse: {error}"));
        assert!(matches!(graph_path, generated_cli::ParsedCli::Tool(_)));
        let graph_similar = generated_cli::parse_from([
            "cartograph",
            "graph",
            "11111111-1111-4111-8111-111111111111",
            "--direction",
            "similar",
            "--k",
            "7",
            "--min-score",
            "0.75",
            "--same-language",
            "--model-id",
            "22222222-2222-4222-8222-222222222222",
        ])
        .unwrap_or_else(|error| panic!("graph similar CLI did not parse: {error}"));
        assert!(matches!(graph_similar, generated_cli::ParsedCli::Tool(_)));

        let files = generated_cli::parse_from([
            "cartograph",
            "files",
            "--dir",
            "src",
            "--language",
            "rust",
            "--allow-stale",
        ])
        .unwrap_or_else(|error| panic!("files CLI did not parse: {error}"));
        assert!(matches!(files, generated_cli::ParsedCli::Tool(_)));

        let entry_points = generated_cli::parse_from([
            "cartograph",
            "entry-points",
            "--bucket",
            "public-exports",
            "--limit",
            "40",
            "--allow-stale",
        ])
        .unwrap_or_else(|error| panic!("entry-points CLI did not parse: {error}"));
        assert!(matches!(entry_points, generated_cli::ParsedCli::Tool(_)));

        let at_range = generated_cli::parse_from([
            "cartograph",
            "at-range",
            "src/main.rs",
            "10",
            "20",
            "--limit",
            "50",
        ])
        .unwrap_or_else(|error| panic!("at-range CLI did not parse: {error}"));
        let generated_cli::ParsedCli::Tool(at_range) = at_range else {
            panic!("at-range did not route through the generated public command");
        };
        assert_eq!(at_range.arguments()["file"], "src/main.rs");
        assert_eq!(at_range.arguments()["startLine"], 10);
        assert_eq!(at_range.arguments()["endLine"], 20);
    }

    #[test]
    fn cli_parses_install_and_database_commands() {
        let install = Cli::try_parse_from([
            "cartograph",
            "install",
            "--yes",
            "--target",
            "codex",
            "--location",
            "local",
            "--project-path",
            "workspace",
            "--managed-database-port",
            "55435",
        ])
        .unwrap_or_else(|error| panic!("install CLI did not parse: {error}"));
        assert!(matches!(
            install.command,
            Command::Install {
                target: Some(ref target),
                managed_database_port: Some(55_435),
                yes: true,
                ..
            } if target == "codex"
        ));

        let llm_install = Cli::try_parse_from([
            "cartograph",
            "llm",
            "install",
            "workspace",
            "--no-models",
            "--database-provider",
            "postgres",
            "--database-url",
            "postgresql://cartograph@127.0.0.1:55432/cartograph",
            "--database-schema",
            "review_project",
            "--database-pgvector",
            "require",
            "--database-max-connections",
            "12",
            "--database-query-timeout-ms",
            "45000",
            "--database-connection-timeout-seconds",
            "7",
            "--database-ssl",
        ])
        .unwrap_or_else(|error| panic!("LLM install compatibility CLI did not parse: {error}"));
        assert!(matches!(
            llm_install.command,
            Command::Llm {
                command: llm_commands::LlmCommand::Install(_)
            }
        ));

        let database = Cli::try_parse_from(["cartograph", "db", "start"])
            .unwrap_or_else(|error| panic!("database start CLI did not parse: {error}"));
        assert!(matches!(
            database.command,
            Command::Db {
                command: DatabaseCommand::Start(DatabaseStartArguments {
                    port: DEFAULT_MANAGED_DATABASE_PORT,
                    ..
                })
            }
        ));

        let import = Cli::try_parse_from([
            "cartograph",
            "db",
            "import-v1",
            "--source-schema",
            "cartograph_v1",
            "--dry-run",
        ])
        .unwrap_or_else(|error| panic!("database import CLI did not parse: {error}"));
        assert!(matches!(
            import.command,
            Command::Db {
                command: DatabaseCommand::ImportV1(V1ImportArguments {
                    dry_run: true,
                    maximum_rows: DEFAULT_IMPORT_MAXIMUM_ROWS,
                    maximum_source_bytes: DEFAULT_IMPORT_MAXIMUM_SOURCE_BYTES,
                    ..
                })
            }
        ));
        assert!(
            Cli::try_parse_from([
                "cartograph",
                "db",
                "import-v1",
                "--source-schema",
                "cartograph_v1",
                "--dry-run",
                "--maximum-source-bytes",
                EXCESSIVE_IMPORT_SOURCE_BYTES_TEXT,
            ])
            .is_err()
        );
    }
}
