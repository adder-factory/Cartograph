use std::process::ExitCode;

use cartograph_config::DatabaseSettings;
use cartograph_db::{CapabilityReport, CheckStatus};
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
