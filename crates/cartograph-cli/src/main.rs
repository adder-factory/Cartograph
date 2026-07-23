use std::{path::PathBuf, process::ExitCode, time::Duration};

use cartograph_config::DatabaseSettings;
use cartograph_db::{
    CapabilityReport, CheckStatus, DEFAULT_MANAGED_DATABASE_PORT, ManagedContainerState,
    ManagedDatabase, ManagedDatabaseStatus, ManagedStartReport,
};
use clap::{Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
    name = "cartograph-v2",
    version,
    about = "Rust/PostgreSQL Cartograph v2 preview"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Verify PostgreSQL 18, ParadeDB, pgvector, and code tokenization.
    Doctor {
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
        /// Output format for humans or automation.
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Stop only the container owned by this project.
    Stop {
        /// Existing project root whose managed resources should be stopped.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
    },
    /// Print a bounded tail from only the project-owned container.
    Logs {
        /// Existing project root whose managed logs should be read.
        #[arg(long, default_value = ".")]
        project_path: PathBuf,
        /// Maximum number of log lines.
        #[arg(long, default_value_t = 200, value_parser = clap::value_parser!(u16).range(1..=10000))]
        tail: u16,
    },
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum OutputFormat {
    #[default]
    Text,
    Json,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(exit_code) => exit_code,
        Err(message) => {
            eprintln!("cartograph-v2: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<ExitCode, String> {
    match cli.command {
        Command::Doctor { format } => run_doctor(format).await,
        Command::Db { command } => run_database_command(command).await,
    }
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
            format,
        } => {
            let database = ManagedDatabase::new(project_path, DEFAULT_MANAGED_DATABASE_PORT)
                .map_err(|error| error.to_string())?;
            let status = database.status().await.map_err(|error| error.to_string())?;
            print_managed_status(&status, format)?;
            Ok(ExitCode::SUCCESS)
        }
        DatabaseCommand::Stop { project_path } => {
            let database = ManagedDatabase::new(project_path, DEFAULT_MANAGED_DATABASE_PORT)
                .map_err(|error| error.to_string())?;
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
        DatabaseCommand::Logs { project_path, tail } => {
            let database = ManagedDatabase::new(project_path, DEFAULT_MANAGED_DATABASE_PORT)
                .map_err(|error| error.to_string())?;
            let logs = database
                .logs(tail)
                .await
                .map_err(|error| error.to_string())?;
            print!("{logs}");
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

async fn run_doctor(format: OutputFormat) -> Result<ExitCode, String> {
    let settings = DatabaseSettings::from_env().map_err(|error| error.to_string())?;
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
}
