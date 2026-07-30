use std::collections::BTreeSet;

use serde::Serialize;

use crate::{ProjectCancellation, ProjectRuntime, ReviewError, ReviewOptions, ReviewReport};

const MAX_VERIFICATION_COMMANDS: usize = 20;
const MAX_PACKAGE_JSON_BYTES: u64 = 2 * 1_048_576;

/// One repository-native command recommended but never executed by Cartograph.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCommand {
    kind: &'static str,
    command: String,
    reason: &'static str,
}

/// Post-edit evidence plus repository-native commands to run.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationPlan {
    review: ReviewReport,
    commands: Vec<VerificationCommand>,
    warnings: Vec<&'static str>,
    commands_executed: bool,
}

impl ProjectRuntime {
    /// Detect bounded repository-native verification commands without executing them.
    ///
    /// This is shared by full Git review plans and file-driven affected-test requests so
    /// transport adapters never reimplement package-manager or language-manifest policy.
    pub async fn repository_verification_commands(&self) -> Vec<VerificationCommand> {
        self.detect_verification_commands().await
    }

    /// Build a bounded review and command plan without executing repository code.
    /// # Errors
    ///
    /// Returns an error when `base_ref` or `max_changed_files` is invalid, the
    /// checkout/ref or bounded Git output is unavailable, project freshness
    /// cannot be established, or deterministic review evidence cannot be read.
    pub async fn verification_plan(
        &self,
        base_ref: &str,
        max_changed_files: u16,
        cancellation: ProjectCancellation,
    ) -> Result<VerificationPlan, ReviewError> {
        let options = ReviewOptions::new(base_ref)?.with_max_changed_files(max_changed_files)?;
        let review = self
            .review_with_cancellation(&options, cancellation)
            .await?;
        let commands = self.repository_verification_commands().await;
        let warnings = if commands.is_empty() {
            vec![
                "No recognized root verification manifest was found; inspect repository instructions",
            ]
        } else {
            Vec::new()
        };
        Ok(VerificationPlan {
            review,
            commands,
            warnings,
            commands_executed: false,
        })
    }

    async fn detect_verification_commands(&self) -> Vec<VerificationCommand> {
        let mut commands = Vec::new();
        if self.root.join("Cargo.toml").is_file() {
            commands.extend([
                command("format", "cargo fmt --all --check", "Rust formatting gate"),
                command(
                    "lint",
                    "cargo clippy --locked --workspace --all-targets --all-features -- -D warnings",
                    "Rust workspace lint gate",
                ),
                command(
                    "test",
                    "cargo test --locked --workspace",
                    "Rust workspace test gate",
                ),
            ]);
        }
        if self.root.join("go.mod").is_file() {
            commands.push(command("test", "go test ./...", "Go module test gate"));
        }
        if self.root.join("pyproject.toml").is_file() {
            commands.push(command(
                "test",
                "python -m pytest",
                "Python project test gate; verify the repository's configured runner",
            ));
        }
        commands.extend(self.package_commands().await);
        let mut seen = BTreeSet::new();
        commands.retain(|candidate| seen.insert(candidate.command.clone()));
        commands.truncate(MAX_VERIFICATION_COMMANDS);
        commands
    }

    async fn package_commands(&self) -> Vec<VerificationCommand> {
        let path = self.root.join("package.json");
        let Ok(metadata) = tokio::fs::metadata(&path).await else {
            return Vec::new();
        };
        if !metadata.is_file() || metadata.len() > MAX_PACKAGE_JSON_BYTES {
            return Vec::new();
        }
        let Ok(source) = tokio::fs::read_to_string(path).await else {
            return Vec::new();
        };
        let Ok(package) = serde_json::from_str::<serde_json::Value>(&source) else {
            return Vec::new();
        };
        let Some(scripts) = package
            .get("scripts")
            .and_then(serde_json::Value::as_object)
        else {
            return Vec::new();
        };
        let runner =
            if self.root.join("bun.lock").is_file() || self.root.join("bun.lockb").is_file() {
                "bun run"
            } else if self.root.join("pnpm-lock.yaml").is_file() {
                "pnpm run"
            } else if self.root.join("yarn.lock").is_file() {
                "yarn"
            } else {
                "npm run"
            };
        let preferred = [
            ("verify", "verify", "Repository aggregate verification gate"),
            ("typecheck", "type", "Static type gate"),
            ("lint", "lint", "Lint gate"),
            ("test", "test", "Test gate"),
            ("test:coverage", "coverage", "Coverage gate"),
            ("test:e2e", "e2e", "End-to-end gate"),
        ];
        preferred
            .into_iter()
            .filter(|(script, _, _)| scripts.contains_key(*script))
            .map(|(script, kind, reason)| command(kind, &format!("{runner} {script}"), reason))
            .collect()
    }
}

fn command(kind: &'static str, command: &str, reason: &'static str) -> VerificationCommand {
    VerificationCommand {
        kind,
        command: command.to_owned(),
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_records_are_explicitly_non_executing_data() {
        let value = serde_json::to_value(command("test", "cargo test", "fixture"))
            .unwrap_or_else(|error| panic!("command did not serialize: {error}"));
        assert_eq!(value["command"], "cargo test");
        assert_eq!(value["kind"], "test");
    }
}
