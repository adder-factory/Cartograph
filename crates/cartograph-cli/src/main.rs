use std::{env, path::PathBuf, process::ExitCode, sync::Arc, time::Duration};

use cartograph_agent::{IndexOptions, IndexReport, ProjectRuntime, ProjectStatus};
use cartograph_config::{DATABASE_URL_ENV, DatabaseSettings};
use cartograph_db::{
    CapabilityReport, CheckStatus, DEFAULT_MANAGED_DATABASE_PORT, ManagedContainerState,
    ManagedDatabase, ManagedDatabaseStatus, ManagedDestructiveOperation, ManagedStartReport,
};
use cartograph_domain::{NormalizedPath, ProjectId, SymbolId};
use cartograph_mcp::{ProtocolServer, ServerConfig, ServerLimits, ServerMetadata, ToolProfile};
use cartograph_search::{
    ContextAnchor, ContextBudget, ContextRequest, DeterministicRetriever, IndexFreshness,
    TraversalBudget, TraversalRequest,
};
use clap::{Parser, Subcommand, ValueEnum};
use mcp_handler::CartographMcpHandler;
use serde::Serialize;

mod mcp_handler;

const MANAGED_DATABASE_PORT_ENV: &str = "CARTOGRAPH_MANAGED_DATABASE_PORT";

#[derive(Debug, Parser)]
#[command(
    name = "cartograph",
    version,
    about = "Rust/PostgreSQL/ParadeDB code intelligence for coding agents"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Build and atomically publish a complete native source generation.
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
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Find exact or ParadeDB-ranked evidence in the current generation.
    Find {
        /// Name, project-relative path, reference text, or BM25 query.
        query: String,
        /// Retrieval channel to execute.
        #[arg(long, value_enum, default_value_t = FindBy::Name)]
        by: FindBy,
        /// Maximum result rows.
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u16).range(1..=100))]
        limit: u16,
        /// Existing project root whose current generation should be searched.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Build a compact deterministic coding-task evidence packet.
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
        /// Existing project root whose evidence should be assembled.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Traverse callers, callees, or reverse impact from an exact symbol ID.
    Graph {
        /// Exact UUID returned by `cartograph find` or `cartograph context`.
        symbol_id: String,
        /// Traversal orientation.
        #[arg(long, value_enum, default_value_t = GraphAxis::Impact)]
        direction: GraphAxis,
        /// Maximum graph depth.
        #[arg(long, default_value_t = 2, value_parser = clap::value_parser!(u8).range(1..=8))]
        depth: u8,
        /// Maximum non-root symbols.
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=500))]
        max_nodes: u16,
        /// Existing project root whose graph should be traversed.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Select bounded affected tests from reverse graph impact.
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
        /// Existing project root whose graph should be traversed.
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
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Advertised MCP tool profile.
        #[arg(long, value_enum, default_value_t = McpProfile::Core)]
        profile: McpProfile,
    },
    /// Verify PostgreSQL 18, ParadeDB, pgvector, and code tokenization.
    Doctor {
        /// Existing project root used to discover managed credentials when no URL is exported.
        #[arg(default_value = ".")]
        project_path: PathBuf,
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
    Start {
        /// Existing project root whose managed resources should be used.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Loopback host port for PostgreSQL.
        #[arg(long, default_value_t = 55432, value_parser = clap::value_parser!(u16).range(1..=65535))]
        port: u16,
        /// Maximum seconds to wait for managed database readiness.
        #[arg(long, default_value_t = 90, value_parser = clap::value_parser!(u64).range(1..=600))]
        wait_seconds: u64,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Report the owned container state without creating anything.
    Status {
        /// Existing project root whose managed resources should be inspected.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Loopback host port used by the managed database.
        #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
        port: u16,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Stop only the container owned by this project.
    Stop {
        /// Existing project root whose managed resources should be stopped.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Loopback host port used by the managed database.
        #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
        port: u16,
    },
    /// Print a bounded tail from only the project-owned container.
    Logs {
        /// Existing project root whose managed logs should be read.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Loopback host port used by the managed database.
        #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
        port: u16,
        /// Maximum number of log lines.
        #[arg(long, default_value_t = 200, value_parser = clap::value_parser!(u16).range(1..=10000))]
        tail: u16,
    },
    /// Write a private, verified custom-format PostgreSQL archive.
    Backup {
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
    },
    /// Replace managed contents from a verified archive with automatic rollback.
    Restore {
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
    },
    /// Permanently remove only the resources owned by this project.
    Remove {
        /// Exact acknowledgement: remove-managed-database.
        #[arg(long)]
        confirm: String,
        /// Existing project root whose owned resources should be removed.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Loopback host port used by the managed database.
        #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
        port: u16,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Replace an owned older container with the supported image and rollback on failure.
    Upgrade {
        /// Exact acknowledgement: upgrade-managed-database.
        #[arg(long)]
        confirm: String,
        /// Existing project root whose owned database should be upgraded.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Loopback host port used by the managed database.
        #[arg(long, default_value_t = DEFAULT_MANAGED_DATABASE_PORT, value_parser = clap::value_parser!(u16).range(1..=65535))]
        port: u16,
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Inspect or transactionally rebuild the derived ParadeDB BM25 index.
    DerivedIndex {
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
    },
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum OutputFormat {
    #[default]
    Text,
    Json,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum McpProfile {
    #[default]
    Core,
    ReadOnly,
    Review,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum FindBy {
    #[default]
    Name,
    Path,
    Reference,
    Bm25,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum GraphAxis {
    Callers,
    Callees,
    #[default]
    Impact,
}

impl From<McpProfile> for ToolProfile {
    fn from(value: McpProfile) -> Self {
        match value {
            McpProfile::Core => Self::Core,
            McpProfile::ReadOnly => Self::ReadOnly,
            McpProfile::Review => Self::Review,
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(exit_code) => exit_code,
        Err(message) => {
            eprintln!("cartograph: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<ExitCode, String> {
    match cli.command {
        Command::Index {
            project_path,
            workers,
            force,
            format,
        } => run_index(project_path, workers, force, format).await,
        Command::Status {
            project_path,
            format,
        } => run_status(project_path, format).await,
        Command::Find {
            query,
            by,
            limit,
            project_path,
            format,
        } => run_find(project_path, query, by, limit, format).await,
        Command::Context {
            task,
            exact_name,
            exact_path,
            exact_reference,
            project_path,
            format,
        } => {
            run_context(
                project_path,
                task,
                exact_name,
                exact_path,
                exact_reference,
                format,
            )
            .await
        }
        Command::Graph {
            symbol_id,
            direction,
            depth,
            max_nodes,
            project_path,
            format,
        } => run_graph(project_path, symbol_id, direction, depth, max_nodes, format).await,
        Command::Affected {
            symbol_id,
            depth,
            max_nodes,
            limit,
            project_path,
            format,
        } => run_affected(project_path, symbol_id, depth, max_nodes, limit, format).await,
        Command::Serve {
            mcp,
            project_path,
            profile,
        } => run_mcp_server(mcp, project_path, profile).await,
        Command::Doctor {
            project_path,
            format,
        } => run_doctor(project_path, format).await,
        Command::Db { command } => run_database_command(command).await,
    }
}

async fn run_find(
    project_path: PathBuf,
    query: String,
    by: FindBy,
    limit: u16,
    format: OutputFormat,
) -> Result<ExitCode, String> {
    let runtime = open_runtime(&project_path).await?;
    let (project_id, _) = current_project(&runtime).await?;
    let retrieval = DeterministicRetriever::new(runtime.database().clone());
    match by {
        FindBy::Name => {
            let result = retrieval
                .exact_name(&project_id, &query, limit)
                .await
                .map_err(|error| error.to_string())?;
            print_serialized(&result, format)?;
        }
        FindBy::Path => {
            let path = NormalizedPath::parse(&query)
                .map_err(|_| "source path must be project-relative".to_owned())?;
            let result = retrieval
                .exact_path(&project_id, &path, limit)
                .await
                .map_err(|error| error.to_string())?;
            print_serialized(&result, format)?;
        }
        FindBy::Reference => {
            let result = retrieval
                .exact_reference(&project_id, &query, limit)
                .await
                .map_err(|error| error.to_string())?;
            print_serialized(&result, format)?;
        }
        FindBy::Bm25 => {
            let result = retrieval
                .bm25(project_id, query, limit)
                .await
                .map_err(|error| error.to_string())?;
            print_serialized(&result, format)?;
        }
    }
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_context(
    project_path: PathBuf,
    task: String,
    exact_name: Option<String>,
    exact_path: Option<String>,
    exact_reference: Option<String>,
    format: OutputFormat,
) -> Result<ExitCode, String> {
    let runtime = open_runtime(&project_path).await?;
    let (project_id, freshness) = current_project(&runtime).await?;
    let mut request = ContextRequest::new(project_id, task, freshness, ContextBudget::default())
        .map_err(|error| error.to_string())?;
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
        .context_packet(&request)
        .await
        .map_err(|error| error.to_string())?;
    print_serialized(&result, format)?;
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_graph(
    project_path: PathBuf,
    symbol_id: String,
    direction: GraphAxis,
    depth: u8,
    max_nodes: u16,
    format: OutputFormat,
) -> Result<ExitCode, String> {
    let runtime = open_runtime(&project_path).await?;
    let (project_id, _) = current_project(&runtime).await?;
    let request = traversal_request(project_id, &symbol_id, depth, max_nodes)?;
    let retrieval = DeterministicRetriever::new(runtime.database().clone());
    match direction {
        GraphAxis::Callers => print_serialized(
            &retrieval
                .callers(&request)
                .await
                .map_err(|error| error.to_string())?,
            format,
        )?,
        GraphAxis::Callees => print_serialized(
            &retrieval
                .callees(&request)
                .await
                .map_err(|error| error.to_string())?,
            format,
        )?,
        GraphAxis::Impact => print_serialized(
            &retrieval
                .impact(&request)
                .await
                .map_err(|error| error.to_string())?,
            format,
        )?,
    }
    runtime.close().await;
    Ok(ExitCode::SUCCESS)
}

async fn run_affected(
    project_path: PathBuf,
    symbol_id: String,
    depth: u8,
    max_nodes: u16,
    limit: u16,
    format: OutputFormat,
) -> Result<ExitCode, String> {
    let runtime = open_runtime(&project_path).await?;
    let (project_id, _) = current_project(&runtime).await?;
    let request = traversal_request(project_id, &symbol_id, depth, max_nodes)?;
    let result = DeterministicRetriever::new(runtime.database().clone())
        .affected_tests(&request, limit)
        .await
        .map_err(|error| error.to_string())?;
    print_serialized(&result, format)?;
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
    if env::var_os(DATABASE_URL_ENV).is_some() {
        return DatabaseSettings::from_env().map_err(|error| error.to_string());
    }
    let port = match env::var(MANAGED_DATABASE_PORT_ENV) {
        Ok(raw) => raw
            .parse::<u16>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                format!("{MANAGED_DATABASE_PORT_ENV} must be an integer between 1 and 65535")
            })?,
        Err(env::VarError::NotPresent) => DEFAULT_MANAGED_DATABASE_PORT,
        Err(env::VarError::NotUnicode(_)) => {
            return Err(format!(
                "{MANAGED_DATABASE_PORT_ENV} must be an integer between 1 and 65535"
            ));
        }
    };
    ManagedDatabase::new(project_path, port)
        .and_then(|database| database.connection_settings())
        .map_err(|error| format!("{error}; run `cartograph db start --project-path <path>` first"))
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

fn traversal_request(
    project_id: ProjectId,
    symbol_id: &str,
    depth: u8,
    max_nodes: u16,
) -> Result<TraversalRequest, String> {
    let symbol_id =
        SymbolId::parse(symbol_id).map_err(|_| "symbol ID must be a non-nil UUID".to_owned())?;
    let budget = TraversalBudget::new(depth, max_nodes).map_err(|error| error.to_string())?;
    TraversalRequest::new(project_id, [symbol_id], budget).map_err(|error| error.to_string())
}

fn print_serialized(value: &impl Serialize, format: OutputFormat) -> Result<(), String> {
    let rendered = match format {
        OutputFormat::Text | OutputFormat::Json => serde_json::to_string_pretty(value)
            .map_err(|_| "could not serialize Cartograph result".to_owned())?,
    };
    println!("{rendered}");
    Ok(())
}

async fn run_mcp_server(
    mcp: bool,
    project_path: PathBuf,
    profile: McpProfile,
) -> Result<ExitCode, String> {
    if !mcp {
        return Err("serve requires --mcp; Cartograph v2 uses stdio MCP transport".to_owned());
    }
    let settings = resolve_database_settings(&project_path)?;
    let runtime = Arc::new(
        ProjectRuntime::connect(&project_path, &settings)
            .await
            .map_err(|error| error.to_string())?,
    );
    let handler = CartographMcpHandler::new(runtime).map_err(|error| error.to_string())?;
    let config = ServerConfig::new(
        ServerMetadata::cartograph(),
        profile.into(),
        ServerLimits::default(),
    );
    let server = ProtocolServer::new(config, handler).map_err(|error| error.to_string())?;
    server
        .serve_stdio()
        .await
        .map_err(|error| error.to_string())?;
    Ok(ExitCode::SUCCESS)
}

async fn run_index(
    project_path: PathBuf,
    workers: Option<u16>,
    force: bool,
    format: OutputFormat,
) -> Result<ExitCode, String> {
    let settings = resolve_database_settings(&project_path)?;
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

async fn run_status(project_path: PathBuf, format: OutputFormat) -> Result<ExitCode, String> {
    let settings = resolve_database_settings(&project_path)?;
    let runtime = ProjectRuntime::connect(&project_path, &settings)
        .await
        .map_err(|error| error.to_string())?;
    let result = runtime.status().await;
    let status = result.map_err(|error| error.to_string())?;
    print_project_status(&status, format)?;
    runtime.close().await;
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

fn print_project_status(status: &ProjectStatus, format: OutputFormat) -> Result<(), String> {
    match format {
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(status)
                .map_err(|_| "could not serialize the project status".to_owned())?
        ),
        OutputFormat::Text => match status
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.current.as_ref())
        {
            Some(current) => println!(
                "Project generation {}: {} files, {} symbols, {} edges; source {}",
                current.generation_id,
                current.counts.files,
                current.counts.symbols,
                current.counts.edges,
                if status.fresh { "fresh" } else { "stale" }
            ),
            None => println!("Project has no published generation; run `cartograph index`."),
        },
    }
    Ok(())
}

async fn run_database_command(command: DatabaseCommand) -> Result<ExitCode, String> {
    match command {
        DatabaseCommand::Start {
            project_path,
            port,
            wait_seconds,
            format,
        } => {
            let database = ManagedDatabase::new(project_path, port)
                .map_err(|error| error.to_string())?
                .with_startup_timeout(Duration::from_secs(wait_seconds));
            let report = database.start().await.map_err(|error| error.to_string())?;
            print_managed_start(&report, format)?;
            Ok(ExitCode::SUCCESS)
        }
        DatabaseCommand::Status {
            project_path,
            port,
            format,
        } => {
            let database =
                ManagedDatabase::new(project_path, port).map_err(|error| error.to_string())?;
            let status = database.status().await.map_err(|error| error.to_string())?;
            print_managed_status(&status, format)?;
            Ok(ExitCode::SUCCESS)
        }
        DatabaseCommand::Stop { project_path, port } => {
            let database =
                ManagedDatabase::new(project_path, port).map_err(|error| error.to_string())?;
            let stopped = database.stop().await.map_err(|error| error.to_string())?;
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
        DatabaseCommand::Logs {
            project_path,
            port,
            tail,
        } => {
            let database =
                ManagedDatabase::new(project_path, port).map_err(|error| error.to_string())?;
            let logs = database
                .logs(tail)
                .await
                .map_err(|error| error.to_string())?;
            print!("{logs}");
            Ok(ExitCode::SUCCESS)
        }
        DatabaseCommand::Backup {
            destination,
            project_path,
            port,
            format,
        } => {
            let database =
                ManagedDatabase::new(project_path, port).map_err(|error| error.to_string())?;
            let report = database
                .backup(destination)
                .await
                .map_err(|error| error.to_string())?;
            print_serialized(&report, format)?;
            Ok(ExitCode::SUCCESS)
        }
        DatabaseCommand::Restore {
            source,
            confirm,
            project_path,
            port,
            format,
        } => {
            let database =
                ManagedDatabase::new(project_path, port).map_err(|error| error.to_string())?;
            let confirmation = database
                .confirm_destructive_operation(ManagedDestructiveOperation::Restore, &confirm)
                .map_err(|error| error.to_string())?;
            let report = database
                .restore(source, confirmation)
                .await
                .map_err(|error| error.to_string())?;
            print_serialized(&report, format)?;
            Ok(ExitCode::SUCCESS)
        }
        DatabaseCommand::Remove {
            confirm,
            project_path,
            port,
            format,
        } => {
            let database =
                ManagedDatabase::new(project_path, port).map_err(|error| error.to_string())?;
            let confirmation = database
                .confirm_destructive_operation(ManagedDestructiveOperation::Remove, &confirm)
                .map_err(|error| error.to_string())?;
            let report = database
                .remove(confirmation)
                .await
                .map_err(|error| error.to_string())?;
            print_serialized(&report, format)?;
            Ok(ExitCode::SUCCESS)
        }
        DatabaseCommand::Upgrade {
            confirm,
            project_path,
            port,
            format,
        } => {
            let database =
                ManagedDatabase::new(project_path, port).map_err(|error| error.to_string())?;
            let confirmation = database
                .confirm_destructive_operation(ManagedDestructiveOperation::Upgrade, &confirm)
                .map_err(|error| error.to_string())?;
            let report = database
                .upgrade(confirmation)
                .await
                .map_err(|error| error.to_string())?;
            print_serialized(&report, format)?;
            Ok(ExitCode::SUCCESS)
        }
        DatabaseCommand::DerivedIndex {
            rebuild,
            confirm,
            project_path,
            port,
            format,
        } => {
            let database =
                ManagedDatabase::new(project_path, port).map_err(|error| error.to_string())?;
            if rebuild {
                let acknowledgement = confirm.ok_or_else(|| {
                    "--confirm rebuild-managed-derived-indexes is required".to_owned()
                })?;
                let confirmation = database
                    .confirm_destructive_operation(
                        ManagedDestructiveOperation::RebuildDerivedIndexes,
                        &acknowledgement,
                    )
                    .map_err(|error| error.to_string())?;
                let report = database
                    .rebuild_derived_indexes(confirmation)
                    .await
                    .map_err(|error| error.to_string())?;
                print_serialized(&report, format)?;
            } else {
                let report = database
                    .derived_index_health()
                    .await
                    .map_err(|error| error.to_string())?;
                print_serialized(&report, format)?;
            }
            Ok(ExitCode::SUCCESS)
        }
    }
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

async fn run_doctor(project_path: PathBuf, format: OutputFormat) -> Result<ExitCode, String> {
    let settings = resolve_database_settings(&project_path)?;
    let pool = cartograph_db::connect(&settings)
        .await
        .map_err(|error| error.to_string())?;
    let report = cartograph_db::probe_capabilities(&pool)
        .await
        .map_err(|error| error.to_string())?;
    pool.close().await;

    match format {
        OutputFormat::Text => print!("{}", render_text_report(&report)),
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .map_err(|_| "could not serialize the capability report".to_owned())?
        ),
    }

    Ok(if report.ready {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

fn render_text_report(report: &CapabilityReport) -> String {
    let mut output = format!(
        "# Cartograph v2 database doctor\n\n{}\n",
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
    output.push_str(if report.ready {
        "\nAll hard requirements passed. Cartograph v2 storage is ready.\n"
    } else {
        "\nOne or more hard requirements failed. Cartograph v2 will not start.\n"
    });
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use cartograph_db::{CapabilityCheck, CapabilityReport};
    use clap::Parser;

    #[test]
    fn text_report_includes_actionable_failure_and_terminal_state() {
        let report = CapabilityReport {
            ready: false,
            postgres_version_num: 170_009,
            postgres_version: "PostgreSQL 17.9".to_owned(),
            pg_search_version: None,
            pgvector_version: None,
            checks: vec![CapabilityCheck {
                id: "postgres-18",
                status: CheckStatus::Fail,
                message: "PostgreSQL server reports version number 170009".to_owned(),
                remediation: Some("Upgrade PostgreSQL."),
            }],
        };

        let rendered = render_text_report(&report);

        assert!(rendered.contains("✗ postgres-18"));
        assert!(rendered.contains("Fix: Upgrade PostgreSQL."));
        assert!(rendered.contains("will not start"));
    }

    #[test]
    fn stable_cli_parses_native_index_and_status_commands() {
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

        let serve = Cli::try_parse_from([
            "cartograph",
            "serve",
            "--mcp",
            "--project-path",
            "workspace",
            "--profile",
            "read-only",
        ])
        .unwrap_or_else(|error| panic!("serve CLI did not parse: {error}"));
        assert!(matches!(
            serve.command,
            Command::Serve {
                mcp: true,
                profile: McpProfile::ReadOnly,
                ..
            }
        ));
    }
}
