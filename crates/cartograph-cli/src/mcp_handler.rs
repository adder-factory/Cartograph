use std::sync::Arc;

use cartograph_agent::{IndexOptions, ProjectRuntime};
use cartograph_domain::{NormalizedPath, ProjectId, SymbolId};
use cartograph_mcp::{
    BoxToolFuture, ToolAnnotations, ToolCall, ToolCallContext, ToolContractError, ToolDefinition,
    ToolError, ToolErrorCode, ToolHandler, ToolProfiles, ToolResult,
};
use cartograph_search::{
    ContextAnchor, ContextBudget, ContextRequest, DeterministicRetriever, IndexFreshness,
    TraversalBudget, TraversalRequest,
};
use serde::Serialize;
use serde_json::{Map, Value, json};

const STATUS_TOOL: &str = "cartograph_status";
const CONTEXT_TOOL: &str = "cartograph_context";
const FIND_TOOL: &str = "cartograph_find";
const GRAPH_TOOL: &str = "cartograph_graph";
const AFFECTED_TOOL: &str = "cartograph_affected";
const ADMIN_TOOL: &str = "cartograph_admin";

/// Product adapter joining the bounded MCP transport to public v2 services.
pub struct CartographMcpHandler {
    runtime: Arc<ProjectRuntime>,
    retrieval: DeterministicRetriever,
    definitions: Vec<ToolDefinition>,
}

impl CartographMcpHandler {
    pub fn new(runtime: Arc<ProjectRuntime>) -> Result<Self, ToolContractError> {
        let retrieval = DeterministicRetriever::new(runtime.database().clone());
        Ok(Self {
            runtime,
            retrieval,
            definitions: tool_definitions()?,
        })
    }

    async fn execute(
        &self,
        call: ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolResult, ToolError> {
        if context.should_stop() {
            return Err(safe_error(
                ToolErrorCode::Unavailable,
                "Cartograph request was cancelled before execution",
            ));
        }
        match call.name.as_str() {
            STATUS_TOOL => self.status(call.arguments).await,
            CONTEXT_TOOL => self.context(call.arguments).await,
            FIND_TOOL => self.find(call.arguments).await,
            GRAPH_TOOL => self.graph(call.arguments).await,
            AFFECTED_TOOL => self.affected(call.arguments).await,
            ADMIN_TOOL => self.admin(call.arguments).await,
            _ => Err(safe_error(
                ToolErrorCode::NotFound,
                "Cartograph tool is not available",
            )),
        }
    }

    async fn status(&self, arguments: Map<String, Value>) -> Result<ToolResult, ToolError> {
        reject_unknown(&arguments, &[])?;
        let status = self.runtime.status().await.map_err(internal_error)?;
        json_result(&status)
    }

    async fn context(&self, arguments: Map<String, Value>) -> Result<ToolResult, ToolError> {
        reject_unknown(
            &arguments,
            &["task", "exactName", "exactPath", "exactReference"],
        )?;
        let task = required_text(&arguments, "task")?;
        let (project_id, freshness) = self.current_project().await?;
        let mut request =
            ContextRequest::new(project_id, task, freshness, ContextBudget::default())
                .map_err(|_| invalid_arguments())?;
        if let Some(name) = optional_text(&arguments, "exactName")? {
            request = request
                .with_anchor(ContextAnchor::ExactName(name.to_owned()))
                .map_err(|_| invalid_arguments())?;
        }
        if let Some(path) = optional_text(&arguments, "exactPath")? {
            let path = NormalizedPath::parse(path).map_err(|_| invalid_arguments())?;
            request = request
                .with_anchor(ContextAnchor::ExactPath(path))
                .map_err(|_| invalid_arguments())?;
        }
        if let Some(reference) = optional_text(&arguments, "exactReference")? {
            request = request
                .with_anchor(ContextAnchor::ExactReference(reference.to_owned()))
                .map_err(|_| invalid_arguments())?;
        }
        let packet = self
            .retrieval
            .context_packet(&request)
            .await
            .map_err(internal_error)?;
        json_result(&packet)
    }

    async fn find(&self, arguments: Map<String, Value>) -> Result<ToolResult, ToolError> {
        reject_unknown(&arguments, &["query", "by", "limit"])?;
        let query = required_text(&arguments, "query")?;
        let by = optional_text(&arguments, "by")?.unwrap_or("name");
        let limit = optional_u16(&arguments, "limit", 20, 100)?;
        let (project_id, _) = self.current_project().await?;
        match by {
            "name" => json_result(
                &self
                    .retrieval
                    .exact_name(&project_id, query, limit)
                    .await
                    .map_err(internal_error)?,
            ),
            "path" => {
                let path = NormalizedPath::parse(query).map_err(|_| invalid_arguments())?;
                json_result(
                    &self
                        .retrieval
                        .exact_path(&project_id, &path, limit)
                        .await
                        .map_err(internal_error)?,
                )
            }
            "reference" => json_result(
                &self
                    .retrieval
                    .exact_reference(&project_id, query, limit)
                    .await
                    .map_err(internal_error)?,
            ),
            "bm25" => json_result(
                &self
                    .retrieval
                    .bm25(project_id, query, limit)
                    .await
                    .map_err(internal_error)?,
            ),
            _ => Err(invalid_arguments()),
        }
    }

    async fn graph(&self, arguments: Map<String, Value>) -> Result<ToolResult, ToolError> {
        reject_unknown(&arguments, &["symbolId", "direction", "depth", "maxNodes"])?;
        let symbol = parse_symbol(required_text(&arguments, "symbolId")?)?;
        let direction = optional_text(&arguments, "direction")?.unwrap_or("impact");
        let depth = optional_u8(&arguments, "depth", 2, 8)?;
        let max_nodes = optional_u16(&arguments, "maxNodes", 100, 500)?;
        let (project_id, _) = self.current_project().await?;
        let budget = TraversalBudget::new(depth, max_nodes).map_err(|_| invalid_arguments())?;
        let request =
            TraversalRequest::new(project_id, [symbol], budget).map_err(|_| invalid_arguments())?;
        match direction {
            "callers" => json_result(
                &self
                    .retrieval
                    .callers(&request)
                    .await
                    .map_err(internal_error)?,
            ),
            "callees" => json_result(
                &self
                    .retrieval
                    .callees(&request)
                    .await
                    .map_err(internal_error)?,
            ),
            "impact" => json_result(
                &self
                    .retrieval
                    .impact(&request)
                    .await
                    .map_err(internal_error)?,
            ),
            _ => Err(invalid_arguments()),
        }
    }

    async fn affected(&self, arguments: Map<String, Value>) -> Result<ToolResult, ToolError> {
        reject_unknown(&arguments, &["symbolId", "depth", "maxNodes", "limit"])?;
        let symbol = parse_symbol(required_text(&arguments, "symbolId")?)?;
        let depth = optional_u8(&arguments, "depth", 3, 8)?;
        let max_nodes = optional_u16(&arguments, "maxNodes", 200, 500)?;
        let limit = optional_u16(&arguments, "limit", 50, 100)?;
        let (project_id, _) = self.current_project().await?;
        let request = TraversalRequest::new(
            project_id,
            [symbol],
            TraversalBudget::new(depth, max_nodes).map_err(|_| invalid_arguments())?,
        )
        .map_err(|_| invalid_arguments())?;
        json_result(
            &self
                .retrieval
                .affected_tests(&request, limit)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn admin(&self, arguments: Map<String, Value>) -> Result<ToolResult, ToolError> {
        reject_unknown(&arguments, &["action", "force", "workers"])?;
        let action = required_text(&arguments, "action")?;
        if !matches!(action, "index" | "sync") {
            return Err(invalid_arguments());
        }
        let force = optional_bool(&arguments, "force")?.unwrap_or(false);
        let workers = optional_u16(&arguments, "workers", 16, 16)?;
        let options = IndexOptions::default()
            .with_force(force)
            .with_max_workers(workers)
            .map_err(|_| invalid_arguments())?;
        let report = self.runtime.index(options).await.map_err(internal_error)?;
        json_result(&report)
    }

    async fn current_project(&self) -> Result<(ProjectId, IndexFreshness), ToolError> {
        let status = self.runtime.status().await.map_err(internal_error)?;
        let Some(snapshot) = status.snapshot else {
            return Err(safe_error(
                ToolErrorCode::NotReady,
                "Cartograph has no project index; call cartograph_admin with action index",
            ));
        };
        Ok((
            snapshot.project_id,
            if status.fresh {
                IndexFreshness::Current
            } else {
                IndexFreshness::Stale
            },
        ))
    }
}

impl ToolHandler for CartographMcpHandler {
    fn tools(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
    }

    fn call<'a>(&'a self, call: ToolCall, context: ToolCallContext) -> BoxToolFuture<'a> {
        Box::pin(async move { self.execute(call, context).await })
    }
}

fn tool_definitions() -> Result<Vec<ToolDefinition>, ToolContractError> {
    let read_only = ToolAnnotations {
        read_only_hint: Some(true),
        destructive_hint: Some(false),
        idempotent_hint: Some(true),
        open_world_hint: Some(false),
    };
    let write = ToolAnnotations {
        read_only_hint: Some(false),
        destructive_hint: Some(false),
        idempotent_hint: Some(true),
        open_world_hint: Some(false),
    };
    Ok(vec![
        ToolDefinition::new(
            STATUS_TOOL,
            "Report the current PostgreSQL generation, relation counts, and live-source freshness.",
            object_schema(json!({}), &[]),
            ToolProfiles::ALL,
        )?
        .with_annotations(read_only),
        ToolDefinition::new(
            CONTEXT_TOOL,
            "Build a compact deterministic coding-task evidence packet with provenance, confidence, abstention, graph impact, and affected tests.",
            object_schema(
                json!({
                    "task": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "exactName": {"type": "string"},
                    "exactPath": {"type": "string"},
                    "exactReference": {"type": "string"}
                }),
                &["task"],
            ),
            ToolProfiles::ALL,
        )?
        .with_annotations(read_only),
        ToolDefinition::new(
            FIND_TOOL,
            "Find current-generation symbols, paths, references, or ParadeDB BM25 evidence.",
            object_schema(
                json!({
                    "query": {"type": "string", "minLength": 1},
                    "by": {"type": "string", "enum": ["name", "path", "reference", "bm25"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100}
                }),
                &["query"],
            ),
            ToolProfiles::ALL,
        )?
        .with_annotations(read_only),
        ToolDefinition::new(
            GRAPH_TOOL,
            "Traverse bounded callers, callees, or reverse impact from one exact symbol ID.",
            object_schema(
                json!({
                    "symbolId": {"type": "string"},
                    "direction": {"type": "string", "enum": ["callers", "callees", "impact"]},
                    "depth": {"type": "integer", "minimum": 1, "maximum": 8},
                    "maxNodes": {"type": "integer", "minimum": 1, "maximum": 500}
                }),
                &["symbolId"],
            ),
            ToolProfiles::ALL,
        )?
        .with_annotations(read_only),
        ToolDefinition::new(
            AFFECTED_TOOL,
            "Select affected tests through bounded reverse graph impact from one exact symbol ID.",
            object_schema(
                json!({
                    "symbolId": {"type": "string"},
                    "depth": {"type": "integer", "minimum": 1, "maximum": 8},
                    "maxNodes": {"type": "integer", "minimum": 1, "maximum": 500},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100}
                }),
                &["symbolId"],
            ),
            ToolProfiles::ALL,
        )?
        .with_annotations(read_only),
        ToolDefinition::new(
            ADMIN_TOOL,
            "Atomically index or synchronize the project through the bounded Rust pipeline.",
            object_schema(
                json!({
                    "action": {"type": "string", "enum": ["index", "sync"]},
                    "force": {"type": "boolean"},
                    "workers": {"type": "integer", "minimum": 1, "maximum": 16}
                }),
                &["action"],
            ),
            ToolProfiles::CORE,
        )?
        .with_annotations(write),
    ])
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn json_result(value: &impl Serialize) -> Result<ToolResult, ToolError> {
    let structured = serde_json::to_value(value).map_err(|_| ToolError::internal())?;
    let text = serde_json::to_string_pretty(&structured).map_err(|_| ToolError::internal())?;
    let structured = match structured {
        Value::Object(object) => object,
        value => Map::from_iter([("result".to_owned(), value)]),
    };
    Ok(ToolResult::text(text).with_structured_content(structured))
}

fn reject_unknown(arguments: &Map<String, Value>, allowed: &[&str]) -> Result<(), ToolError> {
    if arguments.keys().any(|key| !allowed.contains(&key.as_str())) {
        Err(invalid_arguments())
    } else {
        Ok(())
    }
}

fn required_text<'a>(arguments: &'a Map<String, Value>, key: &str) -> Result<&'a str, ToolError> {
    optional_text(arguments, key)?.ok_or_else(invalid_arguments)
}

fn optional_text<'a>(
    arguments: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, ToolError> {
    match arguments.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() && !value.contains('\0') => Ok(Some(value)),
        Some(_) => Err(invalid_arguments()),
    }
}

fn optional_bool(arguments: &Map<String, Value>, key: &str) -> Result<Option<bool>, ToolError> {
    match arguments.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid_arguments()),
    }
}

fn optional_u16(
    arguments: &Map<String, Value>,
    key: &str,
    default: u16,
    maximum: u16,
) -> Result<u16, ToolError> {
    let value = match arguments.get(key) {
        None => return Ok(default),
        Some(Value::Number(value)) => value.as_u64().ok_or_else(invalid_arguments)?,
        Some(_) => return Err(invalid_arguments()),
    };
    let value = u16::try_from(value).map_err(|_| invalid_arguments())?;
    if value == 0 || value > maximum {
        Err(invalid_arguments())
    } else {
        Ok(value)
    }
}

fn optional_u8(
    arguments: &Map<String, Value>,
    key: &str,
    default: u8,
    maximum: u8,
) -> Result<u8, ToolError> {
    let value = optional_u16(arguments, key, u16::from(default), u16::from(maximum))?;
    u8::try_from(value).map_err(|_| invalid_arguments())
}

fn parse_symbol(value: &str) -> Result<SymbolId, ToolError> {
    SymbolId::parse(value).map_err(|_| invalid_arguments())
}

fn invalid_arguments() -> ToolError {
    safe_error(
        ToolErrorCode::InvalidArguments,
        "Cartograph tool arguments are invalid",
    )
}

fn internal_error<T>(_error: T) -> ToolError {
    ToolError::internal()
}

fn safe_error(code: ToolErrorCode, message: &'static str) -> ToolError {
    match ToolError::safe(code, message) {
        Ok(error) => error,
        Err(_) => ToolError::internal(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_exact_sorted_by_transport_and_rejects_unadvertised_fields() {
        let definitions =
            tool_definitions().unwrap_or_else(|error| panic!("tool definitions failed: {error}"));
        let names = definitions
            .iter()
            .map(ToolDefinition::name)
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                STATUS_TOOL,
                CONTEXT_TOOL,
                FIND_TOOL,
                GRAPH_TOOL,
                AFFECTED_TOOL,
                ADMIN_TOOL
            ]
        );
        let invalid = Map::from_iter([("privateQuery".to_owned(), Value::Bool(true))]);
        assert!(reject_unknown(&invalid, &["query"]).is_err());
    }

    #[test]
    fn numeric_argument_parsing_is_bounded_and_does_not_coerce_strings() {
        let valid = Map::from_iter([("limit".to_owned(), json!(20))]);
        assert_eq!(optional_u16(&valid, "limit", 10, 100), Ok(20));
        let zero = Map::from_iter([("limit".to_owned(), json!(0))]);
        assert!(optional_u16(&zero, "limit", 10, 100).is_err());
        let string = Map::from_iter([("limit".to_owned(), json!("20"))]);
        assert!(optional_u16(&string, "limit", 10, 100).is_err());
    }
}
