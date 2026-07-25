use std::time::Duration;

use cartograph_domain::ProjectId;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, StorageError,
    database::{quoted_schema, set_local_statement_timeout},
};

const SESSION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SESSION_LABEL_BYTES: usize = 256;
const MAX_SESSION_OBJECTIVE_BYTES: usize = 65_536;
const MAX_SESSION_LIST: u16 = 100;
const MAX_SESSION_CALLS: u16 = 1_000;
const MAX_RETAINED_TOOL_CALLS: i64 = 10_000;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_TOOL_ARGUMENT_BYTES: usize = 65_536;
const MAX_RESULT_SUMMARY_BYTES: usize = 2_048;
const MAX_MACRO_NAME_BYTES: usize = 256;
const MAX_MACRO_STEPS: usize = 32;
const MAX_MACRO_BYTES: usize = 256 * 1_024;
const MAX_MACRO_LIST: u16 = 100;

/// Durable session origin.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpSessionKind {
    Automatic,
    Named,
}

impl McpSessionKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Named => "named",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "automatic" => Some(Self::Automatic),
            "named" => Some(Self::Named),
            _ => None,
        }
    }
}

/// Validated new durable trace session.
pub struct NewMcpSession {
    kind: McpSessionKind,
    label: Option<String>,
    objective: String,
}

impl NewMcpSession {
    pub fn automatic() -> Self {
        Self {
            kind: McpSessionKind::Automatic,
            label: None,
            objective: String::new(),
        }
    }

    pub fn named(label: &str, objective: &str) -> Result<Self, StorageError> {
        Self::named_optional(Some(label), objective)
    }

    pub fn named_optional(label: Option<&str>, objective: &str) -> Result<Self, StorageError> {
        if let Some(label) = label {
            validate_label(label)?;
        }
        validate_objective(objective)?;
        Ok(Self {
            kind: McpSessionKind::Named,
            label: label.map(str::to_owned),
            objective: objective.to_owned(),
        })
    }
}

/// One durable MCP/agent investigation session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSessionRecord {
    session_id: String,
    label: Option<String>,
    objective: String,
    kind: McpSessionKind,
    state: String,
    tool_count: u64,
    started_at: String,
    last_activity_at: String,
}

impl McpSessionRecord {
    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    #[must_use]
    pub const fn tool_count(&self) -> u64 {
        self.tool_count
    }
}

/// Validated tool-call trace payload. Arguments must already be privacy-redacted.
pub struct McpToolCallInput {
    tool_name: String,
    arguments: Value,
    result_summary: String,
    success: bool,
    duration_ms: u64,
}

impl McpToolCallInput {
    pub fn new(
        tool_name: &str,
        arguments: Value,
        result_summary: &str,
        success: bool,
        duration_ms: u64,
    ) -> Result<Self, StorageError> {
        validate_tool_name(tool_name)?;
        validate_arguments(&arguments)?;
        validate_result_summary(result_summary)?;
        Ok(Self {
            tool_name: tool_name.to_owned(),
            arguments,
            result_summary: result_summary.to_owned(),
            success,
            duration_ms,
        })
    }
}

/// One ordered call from a durable session trace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallRecord {
    session_id: String,
    step: u64,
    called_at: String,
    tool_name: String,
    arguments: Value,
    result_summary: String,
    success: bool,
    duration_ms: u64,
}

impl McpToolCallRecord {
    #[must_use]
    pub const fn step(&self) -> u64 {
        self.step
    }

    #[must_use]
    pub fn tool_name(&self) -> &str {
        &self.tool_name
    }

    #[must_use]
    pub const fn arguments(&self) -> &Value {
        &self.arguments
    }

    #[must_use]
    pub fn result_summary(&self) -> &str {
        &self.result_summary
    }

    #[must_use]
    pub const fn success(&self) -> bool {
        self.success
    }

    #[must_use]
    pub const fn duration_ms(&self) -> u64 {
        self.duration_ms
    }
}

/// Aggregate latency/use row for one MCP tool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolUsage {
    tool_name: String,
    call_count: u64,
    p50_duration_ms: u64,
    p95_duration_ms: u64,
    max_duration_ms: u64,
}

/// Project-local trace totals and per-tool latency percentiles.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTraceUsage {
    session_count: u64,
    tool_call_count: u64,
    error_count: u64,
    tools: Vec<McpToolUsage>,
}

/// One validated saved macro step.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpMacroStep {
    tool: String,
    #[serde(default)]
    args: Map<String, Value>,
}

impl McpMacroStep {
    pub fn new(tool: &str, args: Map<String, Value>) -> Result<Self, StorageError> {
        validate_tool_name(tool)?;
        validate_arguments(&Value::Object(args.clone()))?;
        Ok(Self {
            tool: tool.to_owned(),
            args,
        })
    }

    #[must_use]
    pub fn tool(&self) -> &str {
        &self.tool
    }

    #[must_use]
    pub const fn args(&self) -> &Map<String, Value> {
        &self.args
    }
}

/// Validated macro upsert.
pub struct NewMcpMacro {
    name: String,
    steps: Vec<McpMacroStep>,
}

impl NewMcpMacro {
    pub fn new(name: &str, steps: Vec<McpMacroStep>) -> Result<Self, StorageError> {
        validate_macro_name(name)?;
        validate_macro_steps(&steps)?;
        Ok(Self {
            name: name.to_owned(),
            steps,
        })
    }
}

/// One durable macro recipe and execution metadata.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpMacroRecord {
    name: String,
    steps: Vec<McpMacroStep>,
    created_at: String,
    updated_at: String,
    last_run_at: Option<String>,
    run_count: u64,
}

impl McpMacroRecord {
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn steps(&self) -> &[McpMacroStep] {
        &self.steps
    }
}

impl CartographDatabase {
    /// Create an automatic process trace or named resumable session.
    pub async fn create_mcp_session(
        &self,
        project_id: &ProjectId,
        input: &NewMcpSession,
    ) -> Result<McpSessionRecord, StorageError> {
        if let Some(label) = &input.label {
            validate_label(label)?;
        }
        validate_objective(&input.objective)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"INSERT INTO {schema}."mcp_sessions" (
                    project_id, label, objective, session_kind
                ) VALUES (CAST($1 AS uuid), $2, $3, $4)
                RETURNING session_id::text, label, objective, session_kind, state,
                          tool_count, started_at::text, last_activity_at::text"#,
        );
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(input.label.as_deref())
            .bind(&input.objective)
            .bind(input.kind.as_str())
            .fetch_one(&self.pool)
            .await
            .map_err(|_| database_error("create-mcp-session"))?;
        decode_session(&row)
    }

    /// List newest active/closed sessions for one project.
    pub async fn list_mcp_sessions(
        &self,
        project_id: &ProjectId,
        limit: u16,
    ) -> Result<Vec<McpSessionRecord>, StorageError> {
        validate_limit(limit, MAX_SESSION_LIST)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT session_id::text, label, objective, session_kind, state,
                      tool_count, started_at::text, last_activity_at::text
                FROM {schema}."mcp_sessions"
                WHERE project_id = CAST($1 AS uuid)
                ORDER BY last_activity_at DESC, id DESC
                LIMIT $2"#,
        );
        let rows = self
            .session_read(
                statement,
                |statement| statement.bind(i64::from(limit)),
                project_id,
                "list-mcp-sessions",
            )
            .await?;
        rows.iter().map(decode_session).collect()
    }

    /// Resolve a project-owned session by exact UUID, newest label, or latest non-empty trace.
    pub async fn find_mcp_session(
        &self,
        project_id: &ProjectId,
        session_id: Option<&str>,
        label: Option<&str>,
        require_calls: bool,
    ) -> Result<Option<McpSessionRecord>, StorageError> {
        if session_id.is_none() && label.is_none() && !require_calls {
            return Err(StorageError::InvalidInput {
                field: "session_lookup",
            });
        }
        if let Some(session_id) = session_id {
            validate_uuid(session_id, "session_id")?;
        }
        if let Some(label) = label {
            validate_label(label)?;
        }
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT session_id::text, label, objective, session_kind, state,
                      tool_count, started_at::text, last_activity_at::text
                FROM {schema}."mcp_sessions"
                WHERE project_id = CAST($1 AS uuid)
                  AND ($2::text IS NULL OR session_id = CAST($2 AS uuid))
                  AND ($2::text IS NOT NULL OR $3::text IS NULL OR label = $3)
                  AND (NOT $4::boolean OR tool_count > 0)
                ORDER BY last_activity_at DESC, id DESC
                LIMIT 1"#,
        );
        let rows = self
            .session_read(
                statement,
                |statement| statement.bind(session_id).bind(label).bind(require_calls),
                project_id,
                "find-mcp-session",
            )
            .await?;
        rows.first().map(decode_session).transpose()
    }

    /// Delete a session and all calls under its foreign-key cascade.
    pub async fn delete_mcp_session(
        &self,
        project_id: &ProjectId,
        session_id: &str,
    ) -> Result<bool, StorageError> {
        validate_uuid(session_id, "session_id")?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"DELETE FROM {schema}."mcp_sessions"
                WHERE project_id = CAST($1 AS uuid)
                  AND session_id = CAST($2 AS uuid)"#,
        );
        let result = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(|_| database_error("delete-mcp-session"))?;
        Ok(result.rows_affected() == 1)
    }

    /// Atomically allocate a step, append a trace row, and prune oldest project calls.
    pub async fn record_mcp_tool_call(
        &self,
        project_id: &ProjectId,
        session_id: &str,
        input: &McpToolCallInput,
    ) -> Result<McpToolCallRecord, StorageError> {
        validate_uuid(session_id, "session_id")?;
        validate_tool_call(input)?;
        let schema = quoted_schema(&self.schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("begin-record-mcp-call"))?;
        set_local_statement_timeout(&mut transaction, SESSION_TIMEOUT)
            .await
            .map_err(|_| database_error("timeout-record-mcp-call"))?;
        let update = format!(
            r#"UPDATE {schema}."mcp_sessions"
                SET tool_count = tool_count + 1,
                    last_activity_at = clock_timestamp()
                WHERE project_id = CAST($1 AS uuid)
                  AND session_id = CAST($2 AS uuid)
                RETURNING tool_count"#,
        );
        let step = query(AssertSqlSafe(update))
            .bind(project_id.as_str())
            .bind(session_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| database_error("allocate-mcp-call-step"))?
            .ok_or(StorageError::InvalidInput {
                field: "session_id",
            })?
            .try_get::<i64, _>(0)
            .map_err(|_| StorageError::CorruptStoredValue {
                field: "session_step",
            })?;
        let arguments =
            serde_json::to_string(&input.arguments).map_err(|_| StorageError::InvalidInput {
                field: "tool_arguments",
            })?;
        let insert = format!(
            r#"INSERT INTO {schema}."mcp_tool_calls" (
                    project_id, session_id, step, tool_name, arguments,
                    result_summary, result_kind, duration_ms
                ) VALUES (
                    CAST($1 AS uuid), CAST($2 AS uuid), $3, $4,
                    CAST($5 AS jsonb), $6, $7, $8
                )
                RETURNING session_id::text, step, called_at::text, tool_name,
                          arguments::text, result_summary, result_kind, duration_ms"#,
        );
        let row = query(AssertSqlSafe(insert))
            .bind(project_id.as_str())
            .bind(session_id)
            .bind(step)
            .bind(&input.tool_name)
            .bind(arguments)
            .bind(&input.result_summary)
            .bind(if input.success { "success" } else { "error" })
            .bind(
                i64::try_from(input.duration_ms).map_err(|_| StorageError::InvalidInput {
                    field: "duration_ms",
                })?,
            )
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| database_error("insert-mcp-call"))?;
        let prune = format!(
            r#"DELETE FROM {schema}."mcp_tool_calls"
                WHERE id IN (
                    SELECT id
                    FROM {schema}."mcp_tool_calls"
                    WHERE project_id = CAST($1 AS uuid)
                    ORDER BY called_at DESC, id DESC
                    OFFSET {MAX_RETAINED_TOOL_CALLS}
                )"#,
        );
        query(AssertSqlSafe(prune))
            .bind(project_id.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("prune-mcp-calls"))?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error("commit-record-mcp-call"))?;
        decode_call(&row)
    }

    /// Return one session's ordered bounded trace.
    pub async fn mcp_calls_for_session(
        &self,
        project_id: &ProjectId,
        session_id: &str,
        limit: u16,
    ) -> Result<Vec<McpToolCallRecord>, StorageError> {
        validate_uuid(session_id, "session_id")?;
        validate_limit(limit, MAX_SESSION_CALLS)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT session_id::text, step, called_at::text, tool_name,
                      arguments::text, result_summary, result_kind, duration_ms
                FROM (
                    SELECT session_id, step, called_at, tool_name, arguments,
                           result_summary, result_kind, duration_ms
                    FROM {schema}."mcp_tool_calls"
                    WHERE project_id = CAST($1 AS uuid)
                      AND session_id = CAST($2 AS uuid)
                    ORDER BY step DESC
                    LIMIT $3
                ) AS recent
                ORDER BY step"#,
        );
        let rows = self
            .session_read(
                statement,
                |statement| statement.bind(session_id).bind(i64::from(limit)),
                project_id,
                "mcp-calls-for-session",
            )
            .await?;
        rows.iter().map(decode_call).collect()
    }

    /// Aggregate trace counts and exact PostgreSQL discrete latency percentiles.
    pub async fn mcp_trace_usage(
        &self,
        project_id: &ProjectId,
    ) -> Result<McpTraceUsage, StorageError> {
        let schema = quoted_schema(&self.schema);
        let totals = format!(
            r#"SELECT
                    (SELECT COUNT(*) FROM {schema}."mcp_sessions"
                     WHERE project_id = CAST($1 AS uuid))::bigint,
                    COUNT(*)::bigint,
                    COUNT(*) FILTER (WHERE result_kind = 'error')::bigint
                FROM {schema}."mcp_tool_calls"
                WHERE project_id = CAST($1 AS uuid)"#,
        );
        let rows = self
            .session_read(
                totals,
                |statement| statement,
                project_id,
                "mcp-trace-usage-totals",
            )
            .await?;
        let row = rows.first().ok_or(StorageError::CorruptStoredValue {
            field: "trace_usage",
        })?;
        let session_count = nonnegative_u64(row, 0)?;
        let tool_call_count = nonnegative_u64(row, 1)?;
        let error_count = nonnegative_u64(row, 2)?;
        let by_tool = format!(
            r#"SELECT tool_name,
                      COUNT(*)::bigint,
                      percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms)::bigint,
                      percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::bigint,
                      MAX(duration_ms)::bigint
                FROM {schema}."mcp_tool_calls"
                WHERE project_id = CAST($1 AS uuid)
                GROUP BY tool_name
                ORDER BY COUNT(*) DESC, tool_name"#,
        );
        let tools = self
            .session_read(
                by_tool,
                |statement| statement,
                project_id,
                "mcp-trace-usage-tools",
            )
            .await?
            .iter()
            .map(|row| {
                Ok(McpToolUsage {
                    tool_name: text(row, 0)?,
                    call_count: nonnegative_u64(row, 1)?,
                    p50_duration_ms: nonnegative_u64(row, 2)?,
                    p95_duration_ms: nonnegative_u64(row, 3)?,
                    max_duration_ms: nonnegative_u64(row, 4)?,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        Ok(McpTraceUsage {
            session_count,
            tool_call_count,
            error_count,
            tools,
        })
    }

    /// Upsert one validated project-local macro recipe.
    pub async fn save_mcp_macro(
        &self,
        project_id: &ProjectId,
        input: &NewMcpMacro,
    ) -> Result<McpMacroRecord, StorageError> {
        validate_macro_name(&input.name)?;
        validate_macro_steps(&input.steps)?;
        let schema = quoted_schema(&self.schema);
        let steps =
            serde_json::to_string(&input.steps).map_err(|_| StorageError::InvalidInput {
                field: "macro_steps",
            })?;
        let statement = format!(
            r#"INSERT INTO {schema}."mcp_macros" (project_id, name, steps)
                VALUES (CAST($1 AS uuid), $2, CAST($3 AS jsonb))
                ON CONFLICT (project_id, name) DO UPDATE
                SET steps = EXCLUDED.steps,
                    updated_at = clock_timestamp()
                RETURNING name, steps::text, created_at::text, updated_at::text,
                          last_run_at::text, run_count"#,
        );
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(&input.name)
            .bind(steps)
            .fetch_one(&self.pool)
            .await
            .map_err(|_| database_error("save-mcp-macro"))?;
        decode_macro(&row)
    }

    /// Resolve one exact macro name.
    pub async fn get_mcp_macro(
        &self,
        project_id: &ProjectId,
        name: &str,
    ) -> Result<Option<McpMacroRecord>, StorageError> {
        validate_macro_name(name)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT name, steps::text, created_at::text, updated_at::text,
                      last_run_at::text, run_count
                FROM {schema}."mcp_macros"
                WHERE project_id = CAST($1 AS uuid) AND name = $2"#,
        );
        let rows = self
            .session_read(
                statement,
                |statement| statement.bind(name),
                project_id,
                "get-mcp-macro",
            )
            .await?;
        rows.first().map(decode_macro).transpose()
    }

    /// List saved macros newest-first.
    pub async fn list_mcp_macros(
        &self,
        project_id: &ProjectId,
        limit: u16,
    ) -> Result<Vec<McpMacroRecord>, StorageError> {
        validate_limit(limit, MAX_MACRO_LIST)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT name, steps::text, created_at::text, updated_at::text,
                      last_run_at::text, run_count
                FROM {schema}."mcp_macros"
                WHERE project_id = CAST($1 AS uuid)
                ORDER BY updated_at DESC, name
                LIMIT $2"#,
        );
        let rows = self
            .session_read(
                statement,
                |statement| statement.bind(i64::from(limit)),
                project_id,
                "list-mcp-macros",
            )
            .await?;
        rows.iter().map(decode_macro).collect()
    }

    /// Increment successful macro-run usage metadata.
    pub async fn mark_mcp_macro_run(
        &self,
        project_id: &ProjectId,
        name: &str,
    ) -> Result<(), StorageError> {
        validate_macro_name(name)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"UPDATE {schema}."mcp_macros"
                SET last_run_at = clock_timestamp(), run_count = run_count + 1
                WHERE project_id = CAST($1 AS uuid) AND name = $2"#,
        );
        query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(name)
            .execute(&self.pool)
            .await
            .map_err(|_| database_error("mark-mcp-macro-run"))?;
        Ok(())
    }

    /// Delete one exact macro name.
    pub async fn delete_mcp_macro(
        &self,
        project_id: &ProjectId,
        name: &str,
    ) -> Result<bool, StorageError> {
        validate_macro_name(name)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"DELETE FROM {schema}."mcp_macros"
                WHERE project_id = CAST($1 AS uuid) AND name = $2"#,
        );
        let result = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(name)
            .execute(&self.pool)
            .await
            .map_err(|_| database_error("delete-mcp-macro"))?;
        Ok(result.rows_affected() == 1)
    }

    async fn session_read<'query, Bind>(
        &self,
        statement: String,
        bind: Bind,
        project_id: &ProjectId,
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
        set_local_statement_timeout(&mut transaction, SESSION_TIMEOUT)
            .await
            .map_err(|_| database_error(operation))?;
        let rows = bind(query(AssertSqlSafe(statement)).bind(project_id.as_str()))
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

fn validate_label(value: &str) -> Result<(), StorageError> {
    validate_text(value, MAX_SESSION_LABEL_BYTES, "session_label", false)
}

fn validate_objective(value: &str) -> Result<(), StorageError> {
    validate_text(
        value,
        MAX_SESSION_OBJECTIVE_BYTES,
        "session_objective",
        true,
    )
}

fn validate_tool_name(value: &str) -> Result<(), StorageError> {
    validate_text(value, MAX_TOOL_NAME_BYTES, "tool_name", false)?;
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        Ok(())
    } else {
        Err(StorageError::InvalidInput { field: "tool_name" })
    }
}

fn validate_arguments(value: &Value) -> Result<(), StorageError> {
    let encoded = serde_json::to_vec(value).map_err(|_| StorageError::InvalidInput {
        field: "tool_arguments",
    })?;
    if !value.is_object() || encoded.len() > MAX_TOOL_ARGUMENT_BYTES {
        Err(StorageError::InvalidInput {
            field: "tool_arguments",
        })
    } else {
        Ok(())
    }
}

fn validate_result_summary(value: &str) -> Result<(), StorageError> {
    validate_text(value, MAX_RESULT_SUMMARY_BYTES, "result_summary", true)
}

fn validate_tool_call(input: &McpToolCallInput) -> Result<(), StorageError> {
    validate_tool_name(&input.tool_name)?;
    validate_arguments(&input.arguments)?;
    validate_result_summary(&input.result_summary)
}

fn validate_macro_name(value: &str) -> Result<(), StorageError> {
    validate_text(value, MAX_MACRO_NAME_BYTES, "macro_name", false)
}

fn validate_macro_steps(steps: &[McpMacroStep]) -> Result<(), StorageError> {
    if steps.is_empty() || steps.len() > MAX_MACRO_STEPS {
        return Err(StorageError::InvalidInput {
            field: "macro_steps",
        });
    }
    for step in steps {
        validate_tool_name(&step.tool)?;
        validate_arguments(&Value::Object(step.args.clone()))?;
    }
    let encoded = serde_json::to_vec(steps).map_err(|_| StorageError::InvalidInput {
        field: "macro_steps",
    })?;
    if encoded.len() > MAX_MACRO_BYTES {
        Err(StorageError::InvalidInput {
            field: "macro_steps",
        })
    } else {
        Ok(())
    }
}

fn validate_text(
    value: &str,
    maximum: usize,
    field: &'static str,
    allow_empty: bool,
) -> Result<(), StorageError> {
    if (!allow_empty && value.is_empty()) || value.len() > maximum || value.contains('\0') {
        Err(StorageError::InvalidInput { field })
    } else {
        Ok(())
    }
}

fn validate_limit(limit: u16, maximum: u16) -> Result<(), StorageError> {
    if limit == 0 || limit > maximum {
        Err(StorageError::InvalidInput { field: "limit" })
    } else {
        Ok(())
    }
}

fn validate_uuid(value: &str, field: &'static str) -> Result<(), StorageError> {
    let valid = value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    valid
        .then_some(())
        .ok_or(StorageError::InvalidInput { field })
}

fn decode_session(row: &sqlx_postgres::PgRow) -> Result<McpSessionRecord, StorageError> {
    Ok(McpSessionRecord {
        session_id: text(row, 0)?,
        label: optional_text(row, 1)?,
        objective: text(row, 2)?,
        kind: McpSessionKind::parse(&text(row, 3)?).ok_or(StorageError::CorruptStoredValue {
            field: "session_kind",
        })?,
        state: text(row, 4)?,
        tool_count: nonnegative_u64(row, 5)?,
        started_at: text(row, 6)?,
        last_activity_at: text(row, 7)?,
    })
}

fn decode_call(row: &sqlx_postgres::PgRow) -> Result<McpToolCallRecord, StorageError> {
    let arguments = serde_json::from_str::<Value>(&text(row, 4)?).map_err(|_| {
        StorageError::CorruptStoredValue {
            field: "tool_arguments",
        }
    })?;
    Ok(McpToolCallRecord {
        session_id: text(row, 0)?,
        step: nonnegative_u64(row, 1)?,
        called_at: text(row, 2)?,
        tool_name: text(row, 3)?,
        arguments,
        result_summary: text(row, 5)?,
        success: match text(row, 6)?.as_str() {
            "success" => true,
            "error" => false,
            _ => {
                return Err(StorageError::CorruptStoredValue {
                    field: "result_kind",
                });
            }
        },
        duration_ms: nonnegative_u64(row, 7)?,
    })
}

fn decode_macro(row: &sqlx_postgres::PgRow) -> Result<McpMacroRecord, StorageError> {
    let steps = serde_json::from_str::<Vec<McpMacroStep>>(&text(row, 1)?).map_err(|_| {
        StorageError::CorruptStoredValue {
            field: "macro_steps",
        }
    })?;
    validate_macro_steps(&steps).map_err(|_| StorageError::CorruptStoredValue {
        field: "macro_steps",
    })?;
    Ok(McpMacroRecord {
        name: text(row, 0)?,
        steps,
        created_at: text(row, 2)?,
        updated_at: text(row, 3)?,
        last_run_at: optional_text(row, 4)?,
        run_count: nonnegative_u64(row, 5)?,
    })
}

fn text(row: &sqlx_postgres::PgRow, index: usize) -> Result<String, StorageError> {
    row.try_get(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "session" })
}

fn optional_text(row: &sqlx_postgres::PgRow, index: usize) -> Result<Option<String>, StorageError> {
    row.try_get(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "session" })
}

fn nonnegative_u64(row: &sqlx_postgres::PgRow, index: usize) -> Result<u64, StorageError> {
    let value = row
        .try_get::<i64, _>(index)
        .map_err(|_| StorageError::CorruptStoredValue { field: "session" })?;
    u64::try_from(value).map_err(|_| StorageError::CorruptStoredValue { field: "session" })
}

const fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macro_contract_rejects_empty_and_oversized_recipes() {
        assert!(NewMcpMacro::new("empty", Vec::new()).is_err());
        let step = McpMacroStep::new("cartograph_status", Map::new())
            .unwrap_or_else(|error| panic!("macro step failed: {error}"));
        assert!(NewMcpMacro::new("valid", vec![step.clone()]).is_ok());
        assert!(NewMcpMacro::new("too-many", vec![step; MAX_MACRO_STEPS + 1]).is_err());
    }

    #[test]
    fn trace_arguments_must_be_bounded_objects() {
        assert!(McpToolCallInput::new("cartograph_status", Value::Null, "ok", true, 1).is_err());
        assert!(
            McpToolCallInput::new(
                "cartograph_status",
                Value::Object(Map::new()),
                "ok",
                true,
                1,
            )
            .is_ok()
        );
    }
}
