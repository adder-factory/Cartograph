use std::{collections::BTreeSet, time::Duration};

use cartograph_domain::ProjectId;
use serde::Serialize;
use serde_json::Value;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use thiserror::Error;

use crate::{CartographDatabase, database::set_local_statement_timeout};

const MAX_QUERY_BYTES: usize = 64 * 1_024;
const MAX_QUERY_ROWS: u16 = 1_000;
const MAX_QUERY_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ROW_JSON_BYTES: i32 = 4 * 1_024;
const MAX_RESULT_JSON_BYTES: usize = 1_024 * 1_024;

const LOGICAL_RELATIONS: &[&str] = &[
    "project",
    "files",
    "symbols",
    "edges",
    "reference_sites",
    "search_documents",
    "symbol_coverage",
    "file_history",
    "file_cochanges",
    "agent_artifacts",
];

const SAFE_TABLE_FUNCTIONS: &[&str] = &[
    "unnest",
    "jsonb_array_elements",
    "jsonb_array_elements_text",
    "jsonb_each",
    "jsonb_each_text",
    "generate_series",
];

const FORBIDDEN_WORDS: &[&str] = &[
    "insert", "update", "delete", "merge", "create", "alter", "drop", "truncate", "copy", "grant",
    "revoke", "call", "do", "vacuum", "refresh", "reindex", "cluster", "discard", "lock", "listen",
    "notify", "unlisten", "analyze", "program",
];

/// Validated project-scoped read-only SQL request.
#[derive(Clone, Debug)]
pub struct ReadOnlySqlRequest {
    query: String,
    limit: u16,
    timeout: Duration,
    explain: bool,
}

impl ReadOnlySqlRequest {
    /// Validate one SELECT/WITH or simple EXPLAIN SELECT/WITH statement.
    pub fn new(query: &str, limit: u16, timeout: Duration) -> Result<Self, ReadOnlySqlError> {
        if query.trim().is_empty()
            || query.len() > MAX_QUERY_BYTES
            || query.contains('\0')
            || limit == 0
            || limit > MAX_QUERY_ROWS
            || timeout.is_zero()
            || timeout > MAX_QUERY_TIMEOUT
        {
            return Err(ReadOnlySqlError::InvalidInput);
        }
        let query = strip_trailing_semicolon(query)?;
        let tokens = tokenize(&query)?;
        let first = tokens.first().and_then(Token::word);
        let explain = first == Some("explain");
        let statement_start = usize::from(explain);
        if !matches!(
            tokens.get(statement_start).and_then(Token::word),
            Some("select" | "with")
        ) {
            return Err(ReadOnlySqlError::Forbidden);
        }
        validate_tokens(&tokens[statement_start..])?;
        let query = if explain {
            remove_first_keyword(&query, "explain")?
        } else {
            query
        };
        Ok(Self {
            query,
            limit,
            timeout,
            explain,
        })
    }
}

/// One bounded row from the SQL escape hatch.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum ReadOnlySqlRow {
    Json(Value),
    Truncated {
        row_json_prefix: String,
        row_truncated: bool,
    },
}

/// Bounded query response with explicit row/output truncation.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlySqlResult {
    rows: Vec<ReadOnlySqlRow>,
    truncated: bool,
    row_limit: u16,
    output_byte_limit: usize,
    explain: bool,
}

/// Logical relation available to project-scoped ad-hoc SQL.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlySqlRelation {
    name: &'static str,
    columns: &'static [&'static str],
}

/// Credential-safe SQL boundary failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum ReadOnlySqlError {
    #[error("Cartograph read-only SQL input is invalid")]
    InvalidInput,
    #[error("Cartograph SQL accepts only one project-scoped read-only SELECT, WITH, or EXPLAIN")]
    Forbidden,
    #[error("Cartograph read-only SQL failed")]
    Database,
    #[error("Cartograph read-only SQL returned an invalid bounded row")]
    InvalidRow,
}

impl CartographDatabase {
    /// Execute one project-scoped SQL query under a read-only transaction and hard deadline.
    pub async fn execute_read_only_sql(
        &self,
        project_id: &ProjectId,
        request: &ReadOnlySqlRequest,
    ) -> Result<ReadOnlySqlResult, ReadOnlySqlError> {
        let schema = crate::database::quoted_schema(&self.schema);
        let logical = logical_ctes(&schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| ReadOnlySqlError::Database)?;
        query("SET TRANSACTION READ ONLY")
            .execute(&mut *transaction)
            .await
            .map_err(|_| ReadOnlySqlError::Database)?;
        set_local_statement_timeout(&mut transaction, request.timeout)
            .await
            .map_err(|_| ReadOnlySqlError::Database)?;
        query("SELECT set_config('search_path', 'pg_catalog', true)")
            .execute(&mut *transaction)
            .await
            .map_err(|_| ReadOnlySqlError::Database)?;
        let result = if request.explain {
            let statement = format!(
                "EXPLAIN (FORMAT TEXT) WITH {logical}, cartograph_user_query AS ({}) SELECT * FROM cartograph_user_query",
                request.query
            );
            execute_explain(&mut transaction, statement, project_id, request.limit).await
        } else {
            let statement = format!(
                r#"WITH {logical}, cartograph_user_query AS ({}),
                    cartograph_bounded_rows AS (
                        SELECT to_jsonb(cartograph_user_query)::text AS row_json
                        FROM cartograph_user_query
                        LIMIT $2
                    )
                    SELECT LEFT(row_json, $3), octet_length(row_json) > $3
                    FROM cartograph_bounded_rows"#,
                request.query
            );
            execute_rows(&mut transaction, statement, project_id, request.limit).await
        };
        match result {
            Ok(result) => {
                transaction
                    .commit()
                    .await
                    .map_err(|_| ReadOnlySqlError::Database)?;
                Ok(result)
            }
            Err(error) => {
                let _ = transaction.rollback().await;
                Err(error)
            }
        }
    }
}

/// Stable schema offered to SQL callers instead of physical cross-project tables.
#[must_use]
pub fn read_only_sql_schema() -> Vec<ReadOnlySqlRelation> {
    vec![
        relation(
            "project",
            &[
                "project_id",
                "generation_id",
                "source_revision",
                "generation_sequence",
            ],
        ),
        relation(
            "files",
            &[
                "file_id",
                "normalized_path",
                "language",
                "content_hash",
                "byte_size",
                "parse_status",
            ],
        ),
        relation(
            "symbols",
            &[
                "symbol_id",
                "file_id",
                "symbol_kind",
                "qualified_name",
                "simple_name",
                "signature",
                "start_line",
                "end_line",
                "visibility",
                "exported",
                "async_symbol",
            ],
        ),
        relation(
            "edges",
            &[
                "source_symbol_id",
                "target_symbol_id",
                "edge_kind",
                "confidence",
                "provenance",
                "site_count",
            ],
        ),
        relation(
            "reference_sites",
            &[
                "reference_id",
                "file_id",
                "owner_symbol_id",
                "target_symbol_id",
                "reference_name",
                "reference_kind",
                "start_byte",
                "end_byte",
                "confidence",
                "resolution_provenance",
                "site_count",
                "span_precision",
            ],
        ),
        relation(
            "search_documents",
            &[
                "document_id",
                "file_id",
                "symbol_id",
                "path",
                "language",
                "document_kind",
                "qualified_name",
                "code",
                "natural_text",
                "metadata",
            ],
        ),
        relation(
            "symbol_coverage",
            &[
                "source_id",
                "symbol_id",
                "lines_found",
                "lines_hit",
                "functions_found",
                "functions_hit",
                "coverage_fraction",
            ],
        ),
        relation(
            "file_history",
            &[
                "normalized_path",
                "head_commit",
                "commit_count",
                "author_count",
                "insertions",
                "deletions",
                "last_touched_at",
                "shallow_history",
            ],
        ),
        relation(
            "file_cochanges",
            &["path_a", "path_b", "commit_count", "confidence"],
        ),
        relation(
            "agent_artifacts",
            &[
                "artifact_id",
                "artifact_kind",
                "scope_kind",
                "scope_key",
                "body",
                "metadata",
                "generation_id",
                "source_digest",
                "state",
                "created_at",
                "updated_at",
            ],
        ),
    ]
}

async fn execute_rows(
    transaction: &mut sqlx_postgres::PgTransaction<'_>,
    statement: String,
    project_id: &ProjectId,
    limit: u16,
) -> Result<ReadOnlySqlResult, ReadOnlySqlError> {
    let fetch_limit = i64::from(limit) + 1;
    let rows = query(AssertSqlSafe(statement))
        .bind(project_id.as_str())
        .bind(fetch_limit)
        .bind(MAX_ROW_JSON_BYTES)
        .fetch_all(&mut **transaction)
        .await
        .map_err(|_| ReadOnlySqlError::Database)?;
    let mut output = Vec::new();
    let mut output_bytes = 0_usize;
    let mut truncated = rows.len() > usize::from(limit);
    for row in rows.into_iter().take(usize::from(limit)) {
        let prefix = row
            .try_get::<String, _>(0)
            .map_err(|_| ReadOnlySqlError::InvalidRow)?;
        let row_truncated = row
            .try_get::<bool, _>(1)
            .map_err(|_| ReadOnlySqlError::InvalidRow)?;
        let value = if row_truncated {
            ReadOnlySqlRow::Truncated {
                row_json_prefix: prefix,
                row_truncated: true,
            }
        } else {
            ReadOnlySqlRow::Json(
                serde_json::from_str(&prefix).map_err(|_| ReadOnlySqlError::InvalidRow)?,
            )
        };
        let bytes = serde_json::to_vec(&value)
            .map_err(|_| ReadOnlySqlError::InvalidRow)?
            .len();
        if output_bytes.saturating_add(bytes) > MAX_RESULT_JSON_BYTES {
            truncated = true;
            break;
        }
        output_bytes += bytes;
        output.push(value);
    }
    Ok(result(output, truncated, limit, false))
}

async fn execute_explain(
    transaction: &mut sqlx_postgres::PgTransaction<'_>,
    statement: String,
    project_id: &ProjectId,
    limit: u16,
) -> Result<ReadOnlySqlResult, ReadOnlySqlError> {
    let rows = query(AssertSqlSafe(statement))
        .bind(project_id.as_str())
        .fetch_all(&mut **transaction)
        .await
        .map_err(|_| ReadOnlySqlError::Database)?;
    let mut truncated = rows.len() > usize::from(limit);
    let mut output = Vec::new();
    let mut output_bytes = 0_usize;
    for row in rows.into_iter().take(usize::from(limit)) {
        let mut line = row
            .try_get::<String, _>(0)
            .map_err(|_| ReadOnlySqlError::InvalidRow)?;
        if line.len() > usize::try_from(MAX_ROW_JSON_BYTES).unwrap_or(4_096) {
            line.truncate(usize::try_from(MAX_ROW_JSON_BYTES).unwrap_or(4_096));
            truncated = true;
        }
        let value = ReadOnlySqlRow::Json(serde_json::json!({"plan": line}));
        let bytes = serde_json::to_vec(&value)
            .map_err(|_| ReadOnlySqlError::InvalidRow)?
            .len();
        if output_bytes.saturating_add(bytes) > MAX_RESULT_JSON_BYTES {
            truncated = true;
            break;
        }
        output_bytes += bytes;
        output.push(value);
    }
    Ok(result(output, truncated, limit, true))
}

const fn result(
    rows: Vec<ReadOnlySqlRow>,
    truncated: bool,
    row_limit: u16,
    explain: bool,
) -> ReadOnlySqlResult {
    ReadOnlySqlResult {
        rows,
        truncated,
        row_limit,
        output_byte_limit: MAX_RESULT_JSON_BYTES,
        explain,
    }
}

const fn relation(name: &'static str, columns: &'static [&'static str]) -> ReadOnlySqlRelation {
    ReadOnlySqlRelation { name, columns }
}

fn logical_ctes(schema: &str) -> String {
    format!(
        r#"cartograph_current AS (
                SELECT projects.project_id, projects.current_generation_id AS generation_id
                FROM {schema}."projects" AS projects
                WHERE projects.project_id = CAST($1 AS uuid)
            ),
            project AS (
                SELECT projects.project_id, generations.generation_id,
                       generations.source_revision, generations.generation_sequence
                FROM {schema}."projects" AS projects
                JOIN cartograph_current AS current USING (project_id)
                JOIN {schema}."index_generations" AS generations
                  ON generations.project_id = current.project_id
                 AND generations.generation_id = current.generation_id
            ),
            files AS (
                SELECT stored.file_id, stored.normalized_path, stored.language,
                       stored.content_hash, stored.byte_size, stored.parse_status
                FROM {schema}."files" AS stored
                JOIN cartograph_current AS current
                  ON current.project_id = stored.project_id
                 AND current.generation_id = stored.generation_id
            ),
            symbols AS (
                SELECT stored.symbol_id, stored.file_id, stored.symbol_kind,
                       stored.qualified_name, stored.simple_name, stored.signature,
                       stored.start_line, stored.end_line, stored.visibility,
                       stored.exported, stored.async_symbol
                FROM {schema}."symbols" AS stored
                JOIN cartograph_current AS current
                  ON current.project_id = stored.project_id
                 AND current.generation_id = stored.generation_id
            ),
            edges AS (
                SELECT stored.source_symbol_id, stored.target_symbol_id, stored.edge_kind,
                       stored.confidence, stored.provenance, stored.site_count
                FROM {schema}."edges" AS stored
                JOIN cartograph_current AS current
                  ON current.project_id = stored.project_id
                 AND current.generation_id = stored.generation_id
            ),
            reference_sites AS (
                SELECT stored.reference_id, stored.file_id, stored.owner_symbol_id,
                       stored.target_symbol_id, stored.reference_name, stored.reference_kind,
                       stored.start_byte, stored.end_byte, stored.confidence,
                       stored.resolution_provenance, stored.site_count, stored.span_precision
                FROM {schema}."references" AS stored
                JOIN cartograph_current AS current
                  ON current.project_id = stored.project_id
                 AND current.generation_id = stored.generation_id
            ),
            search_documents AS (
                SELECT stored.document_id, stored.file_id, stored.symbol_id, stored.path,
                       stored.language, stored.document_kind, stored.qualified_name,
                       stored.code, stored.natural_text, stored.metadata
                FROM {schema}."search_documents" AS stored
                JOIN cartograph_current AS current
                  ON current.project_id = stored.project_id
                 AND current.generation_id = stored.generation_id
            ),
            symbol_coverage AS (
                SELECT stored.source_id, stored.symbol_id, stored.lines_found,
                       stored.lines_hit, stored.functions_found, stored.functions_hit,
                       stored.coverage_fraction
                FROM {schema}."symbol_coverage" AS stored
                JOIN cartograph_current AS current
                  ON current.project_id = stored.project_id
                 AND current.generation_id = stored.generation_id
            ),
            file_history AS (
                SELECT stored.normalized_path, stored.head_commit, stored.commit_count,
                       stored.author_count, stored.insertions, stored.deletions,
                       stored.last_touched_at, stored.shallow_history
                FROM {schema}."file_history" AS stored
                JOIN cartograph_current AS current USING (project_id)
            ),
            file_cochanges AS (
                SELECT stored.path_a, stored.path_b, stored.commit_count, stored.confidence
                FROM {schema}."file_cochanges" AS stored
                JOIN cartograph_current AS current USING (project_id)
            ),
            agent_artifacts AS (
                SELECT stored.artifact_id, stored.artifact_kind, stored.scope_kind,
                       stored.scope_key, stored.body, stored.metadata, stored.generation_id,
                       stored.source_digest, stored.state, stored.created_at, stored.updated_at
                FROM {schema}."agent_artifacts" AS stored
                JOIN cartograph_current AS current USING (project_id)
            )"#,
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    Word(String),
    Symbol(char),
}

impl Token {
    fn word(&self) -> Option<&str> {
        match self {
            Self::Word(word) => Some(word),
            Self::Symbol(_) => None,
        }
    }
}

fn strip_trailing_semicolon(query: &str) -> Result<String, ReadOnlySqlError> {
    let trimmed = query.trim();
    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim_end();
    if trimmed.contains(';') {
        Err(ReadOnlySqlError::Forbidden)
    } else {
        Ok(trimmed.to_owned())
    }
}

fn remove_first_keyword(query: &str, keyword: &str) -> Result<String, ReadOnlySqlError> {
    let trimmed = query.trim_start();
    let prefix = trimmed
        .get(..keyword.len())
        .ok_or(ReadOnlySqlError::InvalidInput)?;
    if !prefix.eq_ignore_ascii_case(keyword) {
        return Err(ReadOnlySqlError::InvalidInput);
    }
    let rest = trimmed[keyword.len()..].trim_start();
    if rest.is_empty() {
        Err(ReadOnlySqlError::InvalidInput)
    } else {
        Ok(rest.to_owned())
    }
}

fn tokenize(query: &str) -> Result<Vec<Token>, ReadOnlySqlError> {
    let bytes = query.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            index += 1;
        } else if byte == b'-' && bytes.get(index + 1) == Some(&b'-') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
        } else if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index = skip_block_comment(bytes, index + 2)?;
        } else if byte == b'\'' {
            index = skip_string(bytes, index + 1)?;
        } else if byte == b'"' || byte == b'$' || byte == b';' || byte.is_ascii_control() {
            return Err(ReadOnlySqlError::Forbidden);
        } else if byte.is_ascii_alphabetic() || byte == b'_' {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
            {
                index += 1;
            }
            let word = std::str::from_utf8(&bytes[start..index])
                .map_err(|_| ReadOnlySqlError::InvalidInput)?
                .to_ascii_lowercase();
            tokens.push(Token::Word(word));
        } else if byte.is_ascii_digit() {
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric()
                    || matches!(bytes[index], b'.' | b'_' | b'+' | b'-'))
            {
                index += 1;
            }
        } else if byte.is_ascii() {
            tokens.push(Token::Symbol(char::from(byte)));
            index += 1;
        } else {
            index += utf8_character_width(byte).ok_or(ReadOnlySqlError::InvalidInput)?;
        }
    }
    Ok(tokens)
}

fn skip_string(bytes: &[u8], mut index: usize) -> Result<usize, ReadOnlySqlError> {
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index = index.saturating_add(2),
            b'\'' if bytes.get(index + 1) == Some(&b'\'') => index += 2,
            b'\'' => return Ok(index + 1),
            _ => index += 1,
        }
    }
    Err(ReadOnlySqlError::InvalidInput)
}

fn skip_block_comment(bytes: &[u8], mut index: usize) -> Result<usize, ReadOnlySqlError> {
    let mut depth = 1_u16;
    while index < bytes.len() {
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            depth = depth.checked_add(1).ok_or(ReadOnlySqlError::InvalidInput)?;
            index += 2;
        } else if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
            depth -= 1;
            index += 2;
            if depth == 0 {
                return Ok(index);
            }
        } else {
            index += 1;
        }
    }
    Err(ReadOnlySqlError::InvalidInput)
}

fn validate_tokens(tokens: &[Token]) -> Result<(), ReadOnlySqlError> {
    if tokens.iter().filter_map(Token::word).any(|word| {
        FORBIDDEN_WORDS.contains(&word)
            || word.starts_with("pg_")
            || word.starts_with("lo_")
            || matches!(
                word,
                "information_schema"
                    | "dblink"
                    | "set_config"
                    | "current_setting"
                    | "query_to_xml"
                    | "database_to_xml"
                    | "inet_server_addr"
                    | "inet_server_port"
            )
    }) {
        return Err(ReadOnlySqlError::Forbidden);
    }
    let mut allowed = LOGICAL_RELATIONS
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<BTreeSet<_>>();
    allowed.extend(collect_cte_names(tokens)?);
    let depths = token_depths(tokens)?;
    for (index, token) in tokens.iter().enumerate() {
        if matches!(token.word(), Some("from" | "join")) {
            validate_relation_target(tokens, index + 1, &allowed)?;
        }
        if token == &Token::Symbol(',') && comma_is_from_separator(tokens, &depths, index) {
            validate_relation_target(tokens, index + 1, &allowed)?;
        }
    }
    Ok(())
}

fn validate_relation_target(
    tokens: &[Token],
    mut index: usize,
    allowed: &BTreeSet<String>,
) -> Result<(), ReadOnlySqlError> {
    if tokens.get(index).and_then(Token::word) == Some("lateral") {
        index += 1;
    }
    match tokens.get(index) {
        Some(Token::Symbol('(')) => Ok(()),
        Some(Token::Word(word))
            if allowed.contains(word)
                && !matches!(tokens.get(index + 1), Some(Token::Symbol('.'))) =>
        {
            Ok(())
        }
        Some(Token::Word(word))
            if SAFE_TABLE_FUNCTIONS.contains(&word.as_str())
                && matches!(tokens.get(index + 1), Some(Token::Symbol('('))) =>
        {
            Ok(())
        }
        _ => Err(ReadOnlySqlError::Forbidden),
    }
}

fn collect_cte_names(tokens: &[Token]) -> Result<BTreeSet<String>, ReadOnlySqlError> {
    let mut names = BTreeSet::new();
    if tokens.first().and_then(Token::word) != Some("with") {
        return Ok(names);
    }
    let mut index = 1;
    if tokens.get(index).and_then(Token::word) == Some("recursive") {
        index += 1;
    }
    loop {
        let Some(Token::Word(name)) = tokens.get(index) else {
            return Err(ReadOnlySqlError::InvalidInput);
        };
        names.insert(name.clone());
        index += 1;
        if matches!(tokens.get(index), Some(Token::Symbol('('))) {
            index = skip_balanced(tokens, index)?;
        }
        if tokens.get(index).and_then(Token::word) != Some("as") {
            return Err(ReadOnlySqlError::InvalidInput);
        }
        index += 1;
        if matches!(
            tokens.get(index).and_then(Token::word),
            Some("materialized" | "not")
        ) {
            if tokens.get(index).and_then(Token::word) == Some("not") {
                index += 1;
                if tokens.get(index).and_then(Token::word) != Some("materialized") {
                    return Err(ReadOnlySqlError::InvalidInput);
                }
            }
            index += 1;
        }
        if !matches!(tokens.get(index), Some(Token::Symbol('('))) {
            return Err(ReadOnlySqlError::InvalidInput);
        }
        index = skip_balanced(tokens, index)?;
        if !matches!(tokens.get(index), Some(Token::Symbol(','))) {
            break;
        }
        index += 1;
    }
    Ok(names)
}

fn skip_balanced(tokens: &[Token], start: usize) -> Result<usize, ReadOnlySqlError> {
    let mut depth = 0_u32;
    for (index, token) in tokens.iter().enumerate().skip(start) {
        match token {
            Token::Symbol('(') => depth += 1,
            Token::Symbol(')') => {
                depth = depth.checked_sub(1).ok_or(ReadOnlySqlError::InvalidInput)?;
                if depth == 0 {
                    return Ok(index + 1);
                }
            }
            Token::Word(_) | Token::Symbol(_) => {}
        }
    }
    Err(ReadOnlySqlError::InvalidInput)
}

fn token_depths(tokens: &[Token]) -> Result<Vec<u32>, ReadOnlySqlError> {
    let mut depths = Vec::with_capacity(tokens.len());
    let mut depth = 0_u32;
    for token in tokens {
        depths.push(depth);
        match token {
            Token::Symbol('(') => depth += 1,
            Token::Symbol(')') => {
                depth = depth.checked_sub(1).ok_or(ReadOnlySqlError::InvalidInput)?;
            }
            Token::Word(_) | Token::Symbol(_) => {}
        }
    }
    if depth == 0 {
        Ok(depths)
    } else {
        Err(ReadOnlySqlError::InvalidInput)
    }
}

fn comma_is_from_separator(tokens: &[Token], depths: &[u32], comma: usize) -> bool {
    let depth = depths[comma];
    for index in (0..comma).rev() {
        if depths[index] != depth {
            continue;
        }
        match tokens[index].word() {
            Some("from") => return true,
            Some(
                "where" | "group" | "order" | "having" | "limit" | "offset" | "union" | "except"
                | "intersect" | "window",
            ) => return false,
            _ => {}
        }
    }
    false
}

const fn utf8_character_width(first: u8) -> Option<usize> {
    match first {
        0xC2..=0xDF => Some(2),
        0xE0..=0xEF => Some(3),
        0xF0..=0xF4 => Some(4),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(query: &str) -> Result<ReadOnlySqlRequest, ReadOnlySqlError> {
        ReadOnlySqlRequest::new(query, 100, Duration::from_secs(10))
    }

    #[test]
    fn read_only_gate_admits_project_relations_and_rejects_writes_or_physical_tables() {
        assert!(request("SELECT qualified_name FROM symbols LIMIT 10").is_ok());
        assert!(
            request("WITH roots AS (SELECT * FROM symbols) SELECT count(*) FROM roots").is_ok()
        );
        assert!(request("SELECT * FROM symbols s JOIN files f ON f.file_id = s.file_id").is_ok());
        assert!(request("SELECT * FROM symbols, files").is_ok());
        assert!(request("DELETE FROM symbols").is_err());
        assert!(
            request("WITH removed AS (DELETE FROM symbols RETURNING *) SELECT * FROM removed")
                .is_err()
        );
        assert!(request("SELECT * FROM pg_authid").is_err());
        assert!(request("SELECT * FROM secret_schema.secrets").is_err());
        assert!(request("SELECT pg_read_file('/tmp/secret')").is_err());
        assert!(request("SELECT 1; SELECT 2").is_err());
    }

    #[test]
    fn scanner_does_not_treat_literals_or_nested_comments_as_sql() {
        assert!(request("SELECT 'DELETE FROM pg_authid' AS text FROM project").is_ok());
        assert!(request("SELECT 1 /* outer /* DELETE */ still comment */ FROM project").is_ok());
        assert!(request("SELECT 'unterminated").is_err());
        assert!(request("SELECT $$dollar quoted$$").is_err());
    }

    #[test]
    fn explain_is_rewritten_but_analyze_is_refused() {
        let explain = request("EXPLAIN SELECT * FROM symbols")
            .unwrap_or_else(|error| panic!("explain failed validation: {error}"));
        assert!(explain.explain);
        assert!(request("EXPLAIN ANALYZE SELECT * FROM symbols").is_err());
    }
}
