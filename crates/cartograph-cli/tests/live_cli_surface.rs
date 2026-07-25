use std::{
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
    path::Path,
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use sqlx_core::{query::query, sql_str::AssertSqlSafe};

#[test]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
fn public_cli_exercises_native_agent_backend_and_optional_llm_routes() {
    let database_url = std::env::var("CARTOGRAPH_TEST_DATABASE_URL")
        .unwrap_or_else(|_| panic!("live CLI database is not configured"));
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let schema = format!("cg_cli_public_surface_{}_{}", std::process::id(), nanos);
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let project_path = project.path().to_string_lossy().into_owned();
    let missing_model = project
        .path()
        .join(".cartograph/missing-model.gguf")
        .to_string_lossy()
        .into_owned();

    let outcome = catch_unwind(AssertUnwindSafe(|| {
        write_project_fixture(project.path());
        git(project.path(), &["init", "--initial-branch=main"]);
        git(
            project.path(),
            &["config", "user.email", "cli-surface@example.invalid"],
        );
        git(
            project.path(),
            &["config", "user.name", "CLI Surface Fixture"],
        );
        git(project.path(), &["add", "."]);
        git(
            project.path(),
            &["commit", "-m", "CG-99 establish public CLI surface"],
        );

        success(
            project.path(),
            &database_url,
            &schema,
            &["index", &project_path, "--workers", "2", "--format", "json"],
        );
        success(
            project.path(),
            &database_url,
            &schema,
            &["status", &project_path, "--json", "--verbose"],
        );

        let root = json_success(
            project.path(),
            &database_url,
            &schema,
            &[
                "find-native",
                "root",
                "--by",
                "name",
                "--project-path",
                &project_path,
                "--format",
                "json",
            ],
        );
        let leaf = json_success(
            project.path(),
            &database_url,
            &schema,
            &[
                "find-native",
                "leaf",
                "--by",
                "name",
                "--project-path",
                &project_path,
                "--format",
                "json",
            ],
        );
        let root_id = symbol_id(&root, "root")
            .unwrap_or_else(|| panic!("native find did not return root: {root}"));
        let leaf_id = symbol_id(&leaf, "leaf")
            .unwrap_or_else(|| panic!("native find did not return leaf: {leaf}"));

        for (by, query_text) in [
            ("auto", "order service"),
            ("hybrid", "order service"),
            ("path", "src/lib.rs"),
            ("reference", "leaf"),
            ("bm25", "order service"),
        ] {
            success(
                project.path(),
                &database_url,
                &schema,
                &[
                    "find-native",
                    query_text,
                    "--by",
                    by,
                    "--project-path",
                    &project_path,
                    "--format",
                    "json",
                ],
            );
        }
        for anchor in [
            ["--exact-name", "root"],
            ["--exact-path", "src/lib.rs"],
            ["--exact-reference", "leaf"],
        ] {
            success(
                project.path(),
                &database_url,
                &schema,
                &[
                    "context-native",
                    "change root order behavior",
                    anchor[0],
                    anchor[1],
                    "--mode",
                    "deterministic",
                    "--project-path",
                    &project_path,
                    "--format",
                    "json",
                ],
            );
        }
        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "files-native",
                "--dir",
                "src",
                "--language",
                "rust",
                "--project-path",
                &project_path,
                "--format",
                "json",
            ],
        );
        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "entry-points-native",
                "--bucket",
                "public-exports",
                "--project-path",
                &project_path,
                "--format",
                "json",
            ],
        );
        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "at-range-native",
                "src/lib.rs",
                "1",
                "30",
                "--project-path",
                &project_path,
                "--format",
                "json",
            ],
        );

        for direction in ["callers", "callees", "both", "impact"] {
            success(
                project.path(),
                &database_url,
                &schema,
                &[
                    "graph-native",
                    &root_id,
                    "--direction",
                    direction,
                    "--project-path",
                    &project_path,
                    "--format",
                    "json",
                ],
            );
        }
        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "graph-native",
                &root_id,
                "--direction",
                "path",
                "--to",
                &leaf_id,
                "--project-path",
                &project_path,
                "--format",
                "json",
            ],
        );
        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "show",
                &root_id,
                "--project-path",
                &project_path,
                "--format",
                "json",
            ],
        );
        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "affected-native",
                &root_id,
                "--project-path",
                &project_path,
                "--format",
                "json",
            ],
        );
        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "review-native",
                "--ref",
                "HEAD",
                "--project-path",
                &project_path,
                "--format",
                "json",
            ],
        );
        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "export",
                &project_path,
                "--format",
                "json",
                "--limit",
                "100",
            ],
        );

        for arguments in [
            vec![
                "find",
                "root",
                "--by",
                "name",
                "--project-path",
                &project_path,
            ],
            vec![
                "context",
                "change root order behavior",
                "--mode",
                "deterministic",
                "--project-path",
                &project_path,
            ],
            vec![
                "files",
                "--format",
                "symbols",
                "--file",
                "src/lib.rs",
                "--project-path",
                &project_path,
            ],
            vec![
                "graph",
                "root",
                "--direction",
                "callees",
                "--project-path",
                &project_path,
            ],
            vec!["review", "risk", "--project-path", &project_path],
        ] {
            success(project.path(), &database_url, &schema, &arguments);
        }

        for arguments in [
            vec!["sync-if-dirty", &project_path, "--quiet"],
            vec!["install-hooks", &project_path, "--dry-run"],
            vec!["mcp-budget", "--profile", "coding", "--json"],
            vec!["completions", "bash"],
            vec!["__complete", "cartograph", "st"],
            vec!["guide"],
            vec!["doctor", &project_path, "--json"],
            vec![
                "db",
                "status",
                "--project-path",
                &project_path,
                "--port",
                "55432",
                "--format",
                "json",
            ],
        ] {
            success(project.path(), &database_url, &schema, &arguments);
        }

        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "llm",
                "setup",
                &project_path,
                "--preset",
                "custom",
                "--tier",
                "chat",
                "--endpoint",
                "http://127.0.0.1:65534",
                "--model",
                &missing_model,
                "--yes",
                "--json",
            ],
        );
        for arguments in [
            vec!["backend", "status", &project_path, "--json"],
            vec!["backend", "stop", &project_path, "--json"],
            vec!["backend", "logs", &project_path, "--lines", "20", "--json"],
        ] {
            success(project.path(), &database_url, &schema, &arguments);
        }
        for arguments in [
            vec!["backend", "start", &project_path, "--dry-run", "--json"],
            vec!["backend", "restart", &project_path, "--dry-run", "--json"],
        ] {
            failure(project.path(), &database_url, &schema, &arguments);
        }
        success(
            project.path(),
            &database_url,
            &schema,
            &[
                "llm",
                "install",
                &project_path,
                "--no-models",
                "--minimal",
                "--json",
            ],
        );
        failure(
            project.path(),
            &database_url,
            &schema,
            &[
                "llm",
                "smoke",
                &project_path,
                "--timeout-ms",
                "100",
                "--json",
            ],
        );
    }));

    cleanup_schema(&database_url, &schema);
    if let Err(payload) = outcome {
        resume_unwind(payload);
    }
}

fn write_project_fixture(root: &Path) {
    std::fs::create_dir_all(root.join(".cartograph"))
        .unwrap_or_else(|error| panic!("Cartograph fixture directory failed: {error}"));
    std::fs::create_dir_all(root.join("src"))
        .unwrap_or_else(|error| panic!("source fixture directory failed: {error}"));
    std::fs::create_dir_all(root.join("tests"))
        .unwrap_or_else(|error| panic!("test fixture directory failed: {error}"));
    std::fs::write(
        root.join("src/lib.rs"),
        r#"pub fn leaf(value: i32) -> i32 {
    value + 1
}

pub fn root(value: i32) -> i32 {
    leaf(value)
}

pub struct OrderService;
impl OrderService {
    pub fn execute(value: i32) -> i32 { root(value) }
}
"#,
    )
    .unwrap_or_else(|error| panic!("Rust fixture write failed: {error}"));
    std::fs::write(
        root.join("src/server.ts"),
        r#"import express from "express";
export const app = express();
export function handleOrder(id: string): string { return id.trim(); }
app.get("/orders/:id", (request, response) => response.send(handleOrder(request.params.id)));
"#,
    )
    .unwrap_or_else(|error| panic!("TypeScript fixture write failed: {error}"));
    std::fs::write(
        root.join("tests/server.test.ts"),
        "import { handleOrder } from '../src/server';\ntest('order', () => expect(handleOrder('42')).toBe('42'));\n",
    )
    .unwrap_or_else(|error| panic!("test fixture write failed: {error}"));
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"cli-surface","private":true,"scripts":{"test":"vitest run"},"dependencies":{"express":"5.0.0"},"devDependencies":{"vitest":"3.0.0"}}"#,
    )
    .unwrap_or_else(|error| panic!("manifest fixture write failed: {error}"));
}

fn success(root: &Path, database_url: &str, schema: &str, arguments: &[&str]) -> Output {
    let output = invoke(root, database_url, schema, arguments);
    assert!(
        output.status.success(),
        "cartograph {arguments:?} failed with status {:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn failure(root: &Path, database_url: &str, schema: &str, arguments: &[&str]) -> Output {
    let output = invoke(root, database_url, schema, arguments);
    assert!(
        !output.status.success(),
        "cartograph {arguments:?} unexpectedly succeeded"
    );
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains(database_url),
        "a failing CLI command exposed the database URL"
    );
    output
}

fn json_success(root: &Path, database_url: &str, schema: &str, arguments: &[&str]) -> Value {
    let output = success(root, database_url, schema, arguments);
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "cartograph {arguments:?} returned invalid JSON: {error}: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

fn invoke(root: &Path, database_url: &str, schema: &str, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cartograph"))
        .arg("--no-color")
        .args(arguments)
        .current_dir(root)
        .env("CARTOGRAPH_DATABASE_URL", database_url)
        .env("CARTOGRAPH_DATABASE_SCHEMA", schema)
        .env("CARTOGRAPH_DATABASE_MAX_CONNECTIONS", "8")
        .env("CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS", "10000")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap_or_else(|error| panic!("cartograph process failed to start: {error}"))
}

fn symbol_id(value: &Value, expected_name: &str) -> Option<String> {
    match value {
        Value::Object(object) => {
            let name = object
                .get("qualified_name")
                .or_else(|| object.get("qualifiedName"))
                .or_else(|| object.get("simple_name"))
                .or_else(|| object.get("simpleName"))
                .and_then(Value::as_str);
            if name == Some(expected_name)
                && let Some(id) = object
                    .get("symbol_id")
                    .or_else(|| object.get("symbolId"))
                    .and_then(Value::as_str)
            {
                return Some(id.to_owned());
            }
            object
                .values()
                .find_map(|child| symbol_id(child, expected_name))
        }
        Value::Array(values) => values
            .iter()
            .find_map(|child| symbol_id(child, expected_name)),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => None,
    }
}

fn git(root: &Path, arguments: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .unwrap_or_else(|error| panic!("git fixture command failed: {error}"));
    assert!(
        status.success(),
        "git fixture command failed: {arguments:?}"
    );
}

fn cleanup_schema(database_url: &str, schema: &str) {
    let settings =
        cartograph_config::DatabaseSettings::parse(database_url, Some("2"), Some("10000"))
            .and_then(|settings| settings.with_schema(schema))
            .unwrap_or_else(|error| panic!("cleanup settings failed: {error}"));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|error| panic!("cleanup runtime failed: {error}"));
    runtime.block_on(async {
        let pool = cartograph_db::connect(&settings)
            .await
            .unwrap_or_else(|error| panic!("cleanup connection failed: {error}"));
        query(AssertSqlSafe(format!(
            "DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"
        )))
        .execute(&pool)
        .await
        .unwrap_or_else(|error| panic!("cleanup failed: {error}"));
        pool.close().await;
    });
}
