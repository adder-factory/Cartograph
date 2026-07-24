use std::{collections::BTreeMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite, BufReader},
    sync::{Mutex, mpsc},
    task::JoinSet,
    time::{Instant, sleep_until},
};

use crate::{
    CancellationToken, ConfigError, ErrorCode, ServeError, StableErrorCode, ToolCall,
    ToolCallContext, ToolDefinition, ToolHandler, ToolProfile, ToolResult,
    error::valid_deadline,
    transport::{BoundedLine, read_bounded_line, write_responses},
};

/// Existing Cartograph v1 wire baseline retained for the first v2 MCP slice.
pub const DEFAULT_PROTOCOL_VERSION: &str = "2024-11-05";

const DEFAULT_MAX_INPUT_BYTES: usize = 1_048_576;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 4_194_304;
const DEFAULT_MAX_INFLIGHT_REQUESTS: usize = 32;
const DEFAULT_REQUEST_DEADLINE: Duration = Duration::from_secs(60);
const MIN_INPUT_BYTES: usize = 128;
const MAX_INPUT_BYTES: usize = 16 * 1_048_576;
const MIN_OUTPUT_BYTES: usize = 512;
const MAX_OUTPUT_BYTES: usize = 32 * 1_048_576;
const MAX_INFLIGHT_REQUESTS: usize = 1_024;
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_METHOD_BYTES: usize = 128;
const MAX_METADATA_BYTES: usize = 128;

/// JSON-RPC request identifier accepted by MCP.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Integer(i64),
}

/// Compact MCP implementation metadata injected into `initialize`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ServerMetadata {
    name: String,
    version: String,
}

impl ServerMetadata {
    /// Validate explicit implementation metadata.
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Result<Self, ConfigError> {
        let metadata = Self {
            name: name.into(),
            version: version.into(),
        };
        if valid_metadata_component(&metadata.name) && valid_metadata_component(&metadata.version) {
            Ok(metadata)
        } else {
            Err(ConfigError::InvalidServerMetadata)
        }
    }

    /// Cartograph metadata with the crate package version injected at compile time.
    #[must_use]
    pub fn cartograph() -> Self {
        Self {
            name: "cartograph".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }
}

impl Default for ServerMetadata {
    fn default() -> Self {
        Self::cartograph()
    }
}

/// Hard resource policy for one stdio connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServerLimits {
    max_input_bytes: usize,
    max_output_bytes: usize,
    max_inflight_requests: usize,
    request_deadline: Duration,
}

impl ServerLimits {
    /// Validate explicit input/output/concurrency/deadline bounds.
    pub const fn new(
        max_input_bytes: usize,
        max_output_bytes: usize,
        max_inflight_requests: usize,
        request_deadline: Duration,
    ) -> Result<Self, ConfigError> {
        if max_input_bytes < MIN_INPUT_BYTES || max_input_bytes > MAX_INPUT_BYTES {
            return Err(ConfigError::InvalidInputLimit);
        }
        if max_output_bytes < MIN_OUTPUT_BYTES || max_output_bytes > MAX_OUTPUT_BYTES {
            return Err(ConfigError::InvalidOutputLimit);
        }
        if max_inflight_requests == 0 || max_inflight_requests > MAX_INFLIGHT_REQUESTS {
            return Err(ConfigError::InvalidInflightLimit);
        }
        if !valid_deadline(request_deadline) {
            return Err(ConfigError::InvalidRequestDeadline);
        }
        Ok(Self {
            max_input_bytes,
            max_output_bytes,
            max_inflight_requests,
            request_deadline,
        })
    }

    /// Maximum JSON payload bytes accepted before a newline.
    #[must_use]
    pub const fn max_input_bytes(self) -> usize {
        self.max_input_bytes
    }

    /// Maximum serialized JSON response bytes, excluding its newline.
    #[must_use]
    pub const fn max_output_bytes(self) -> usize {
        self.max_output_bytes
    }

    /// Maximum concurrently executing tool calls.
    #[must_use]
    pub const fn max_inflight_requests(self) -> usize {
        self.max_inflight_requests
    }

    /// Hard wall-clock deadline for each tool call.
    #[must_use]
    pub const fn request_deadline(self) -> Duration {
        self.request_deadline
    }
}

impl Default for ServerLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            max_inflight_requests: DEFAULT_MAX_INFLIGHT_REQUESTS,
            request_deadline: DEFAULT_REQUEST_DEADLINE,
        }
    }
}

/// Immutable MCP connection configuration.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    metadata: ServerMetadata,
    protocol_version: String,
    profile: ToolProfile,
    limits: ServerLimits,
}

impl ServerConfig {
    /// Construct a server configuration around validated components.
    #[must_use]
    pub fn new(metadata: ServerMetadata, profile: ToolProfile, limits: ServerLimits) -> Self {
        Self {
            metadata,
            protocol_version: DEFAULT_PROTOCOL_VERSION.to_owned(),
            profile,
            limits,
        }
    }

    /// Override the advertised protocol version for a future negotiated slice.
    pub fn with_protocol_version(
        mut self,
        protocol_version: impl Into<String>,
    ) -> Result<Self, ConfigError> {
        let protocol_version = protocol_version.into();
        let valid = !protocol_version.is_empty()
            && protocol_version.len() <= 32
            && protocol_version
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'-');
        if !valid {
            return Err(ConfigError::InvalidProtocolVersion);
        }
        self.protocol_version = protocol_version;
        Ok(self)
    }

    /// Active advertised tool profile.
    #[must_use]
    pub const fn profile(&self) -> ToolProfile {
        self.profile
    }

    /// Active hard resource policy.
    #[must_use]
    pub const fn limits(&self) -> ServerLimits {
        self.limits
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self::new(
            ServerMetadata::default(),
            ToolProfile::default(),
            ServerLimits::default(),
        )
    }
}

/// Standalone bounded MCP protocol server.
#[derive(Clone)]
pub struct ProtocolServer {
    config: ServerConfig,
    handler: Arc<dyn ToolHandler>,
    tools: Arc<Vec<ToolDefinition>>,
    tool_names: Arc<BTreeMap<String, ()>>,
}

impl ProtocolServer {
    /// Validate a product adapter's immutable registry and bind it to MCP.
    pub fn new<H>(config: ServerConfig, handler: H) -> Result<Self, ConfigError>
    where
        H: ToolHandler,
    {
        Self::from_shared(config, Arc::new(handler))
    }

    /// Bind an already shared product adapter.
    pub fn from_shared(
        config: ServerConfig,
        handler: Arc<dyn ToolHandler>,
    ) -> Result<Self, ConfigError> {
        let definitions = handler.tools();
        let mut all_names = BTreeMap::new();
        let mut tools = Vec::new();
        let mut tool_names = BTreeMap::new();
        for definition in definitions {
            if all_names.insert(definition.name().to_owned(), ()).is_some() {
                return Err(ConfigError::DuplicateToolName);
            }
            if definition.included_in(config.profile) {
                tool_names.insert(definition.name().to_owned(), ());
                tools.push(definition);
            }
        }
        tools.sort_by(|left, right| left.name().cmp(right.name()));
        Ok(Self {
            config,
            handler,
            tools: Arc::new(tools),
            tool_names: Arc::new(tool_names),
        })
    }

    /// Serve one newline-delimited JSON-RPC connection with bounded backpressure.
    pub async fn serve<R, W>(&self, input: R, output: W) -> Result<(), ServeError>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let channel_capacity = self.config.limits.max_inflight_requests.max(1);
        let (output_sender, output_receiver) = mpsc::channel(channel_capacity);
        let maximum_output = self.config.limits.max_output_bytes;
        let writer = tokio::spawn(write_responses(output, output_receiver, maximum_output));
        let active = Arc::new(Mutex::new(BTreeMap::new()));
        let mut calls = JoinSet::new();
        let mut reader = BufReader::new(input);
        let mut phase = SessionPhase::New;
        let mut terminal_error = None;

        loop {
            reap_finished(&mut calls);
            let line =
                match read_bounded_line(&mut reader, self.config.limits.max_input_bytes).await {
                    Ok(line) => line,
                    Err(error) => {
                        terminal_error = Some(error);
                        break;
                    }
                };
            match line {
                BoundedLine::Eof => break,
                BoundedLine::TooLarge => {
                    let response = JsonRpcResponse::error(
                        None,
                        ErrorCode::INPUT_TOO_LARGE,
                        "Input message is too large",
                        StableErrorCode::InputTooLarge,
                    );
                    if send_response(&output_sender, response).await.is_err() {
                        terminal_error = Some(ServeError::OutputChannelClosed);
                        break;
                    }
                }
                BoundedLine::Line(bytes) => {
                    let Some(message) = parse_message(&bytes) else {
                        continue;
                    };
                    match message {
                        Ok(message) => {
                            if self
                                .dispatch(message, &mut phase, &active, &mut calls, &output_sender)
                                .await
                                .is_err()
                            {
                                terminal_error = Some(ServeError::OutputChannelClosed);
                                break;
                            }
                        }
                        Err(fault) => {
                            if send_response(&output_sender, fault.into_response())
                                .await
                                .is_err()
                            {
                                terminal_error = Some(ServeError::OutputChannelClosed);
                                break;
                            }
                        }
                    }
                }
            }
        }

        cancel_active(&active).await;
        while calls.join_next().await.is_some() {}
        drop(output_sender);

        let writer_result = match writer.await {
            Ok(result) => result,
            Err(_) => Err(ServeError::OutputTaskFailed),
        };
        match terminal_error {
            Some(error) => Err(error),
            None => writer_result,
        }
    }

    /// Serve stdin/stdout without writing any non-protocol bytes to stdout.
    pub async fn serve_stdio(&self) -> Result<(), ServeError> {
        self.serve(tokio::io::stdin(), tokio::io::stdout()).await
    }

    async fn dispatch(
        &self,
        message: InboundMessage,
        phase: &mut SessionPhase,
        active: &Arc<Mutex<BTreeMap<RequestId, CancellationToken>>>,
        calls: &mut JoinSet<()>,
        output: &mpsc::Sender<JsonRpcResponse>,
    ) -> Result<(), ServeError> {
        match message {
            InboundMessage::Notification { method, params } => {
                self.dispatch_notification(&method, params, phase, active)
                    .await;
                Ok(())
            }
            InboundMessage::Request { id, method, params } => match method.as_str() {
                "initialize" => self.initialize(id, params, phase, output).await,
                "ping" => {
                    if !valid_optional_object(&params) {
                        return send_response(
                            output,
                            invalid_params(Some(id), "Invalid ping parameters"),
                        )
                        .await;
                    }
                    send_response(output, JsonRpcResponse::success(id, json!({}))).await
                }
                "tools/list" => self.list_tools(id, params, *phase, output).await,
                "tools/call" => {
                    self.call_tool(id, params, *phase, active, calls, output)
                        .await
                }
                _ => {
                    send_response(
                        output,
                        JsonRpcResponse::error(
                            Some(id),
                            ErrorCode::METHOD_NOT_FOUND,
                            "Method not found",
                            StableErrorCode::MethodNotFound,
                        ),
                    )
                    .await
                }
            },
        }
    }

    async fn dispatch_notification(
        &self,
        method: &str,
        params: Option<Value>,
        phase: &mut SessionPhase,
        active: &Arc<Mutex<BTreeMap<RequestId, CancellationToken>>>,
    ) {
        match method {
            "notifications/initialized"
                if *phase == SessionPhase::InitializeResponded
                    && valid_optional_object(&params) =>
            {
                *phase = SessionPhase::Ready;
            }
            "notifications/cancelled" => {
                let Some(request_id) = cancellation_request_id(params) else {
                    return;
                };
                if let Some(token) = active.lock().await.get(&request_id).cloned() {
                    token.cancel();
                }
            }
            _ => {}
        }
    }

    async fn initialize(
        &self,
        id: RequestId,
        params: Option<Value>,
        phase: &mut SessionPhase,
        output: &mpsc::Sender<JsonRpcResponse>,
    ) -> Result<(), ServeError> {
        if *phase != SessionPhase::New {
            return send_response(
                output,
                JsonRpcResponse::error(
                    Some(id),
                    ErrorCode::INVALID_REQUEST,
                    "Server is already initialized",
                    StableErrorCode::AlreadyInitialized,
                ),
            )
            .await;
        }
        let Some(params) = params else {
            return send_response(
                output,
                invalid_params(Some(id), "Missing initialize parameters"),
            )
            .await;
        };
        let Ok(parsed) = serde_json::from_value::<InitializeParams>(params) else {
            return send_response(
                output,
                invalid_params(Some(id), "Invalid initialize parameters"),
            )
            .await;
        };
        if !valid_metadata_component(&parsed.client_info.name)
            || !valid_metadata_component(&parsed.client_info.version)
            || parsed.protocol_version.is_empty()
            || parsed.protocol_version.len() > 32
        {
            return send_response(
                output,
                invalid_params(Some(id), "Invalid initialize parameters"),
            )
            .await;
        }

        let negotiated = if parsed.protocol_version == self.config.protocol_version {
            parsed.protocol_version
        } else {
            self.config.protocol_version.clone()
        };
        let result = json!({
            "protocolVersion": negotiated,
            "capabilities": { "tools": {} },
            "serverInfo": self.config.metadata,
        });
        send_response(output, JsonRpcResponse::success(id, result)).await?;
        *phase = SessionPhase::InitializeResponded;
        Ok(())
    }

    async fn list_tools(
        &self,
        id: RequestId,
        params: Option<Value>,
        phase: SessionPhase,
        output: &mpsc::Sender<JsonRpcResponse>,
    ) -> Result<(), ServeError> {
        if phase != SessionPhase::Ready {
            return send_response(output, not_initialized(id)).await;
        }
        let cursor = match parse_cursor(params) {
            Ok(cursor) => cursor,
            Err(()) => {
                return send_response(
                    output,
                    invalid_params(Some(id), "Invalid tools/list parameters"),
                )
                .await;
            }
        };
        if cursor.is_some() {
            return send_response(
                output,
                JsonRpcResponse::error(
                    Some(id),
                    ErrorCode::INVALID_PARAMS,
                    "Pagination cursor is not supported",
                    StableErrorCode::UnsupportedCursor,
                ),
            )
            .await;
        }
        send_response(
            output,
            JsonRpcResponse::success(id, json!({ "tools": self.tools.as_ref() })),
        )
        .await
    }

    async fn call_tool(
        &self,
        id: RequestId,
        params: Option<Value>,
        phase: SessionPhase,
        active: &Arc<Mutex<BTreeMap<RequestId, CancellationToken>>>,
        calls: &mut JoinSet<()>,
        output: &mpsc::Sender<JsonRpcResponse>,
    ) -> Result<(), ServeError> {
        if phase != SessionPhase::Ready {
            return send_response(output, not_initialized(id)).await;
        }
        let Some(call) = parse_tool_call(params) else {
            return send_response(
                output,
                invalid_params(Some(id), "Invalid tools/call parameters"),
            )
            .await;
        };
        if !self.tool_names.contains_key(&call.name) {
            return send_response(
                output,
                JsonRpcResponse::error(
                    Some(id),
                    ErrorCode::INVALID_PARAMS,
                    "Unknown tool",
                    StableErrorCode::UnknownTool,
                ),
            )
            .await;
        }

        let cancellation = CancellationToken::new();
        let admission_error = {
            let mut requests = active.lock().await;
            if requests.contains_key(&id) {
                Some((
                    ErrorCode::DUPLICATE_REQUEST_ID,
                    "Request ID is already active",
                    StableErrorCode::DuplicateRequestId,
                ))
            } else if requests.len() >= self.config.limits.max_inflight_requests {
                Some((
                    ErrorCode::SERVER_BUSY,
                    "Server request capacity is exhausted",
                    StableErrorCode::ServerBusy,
                ))
            } else {
                requests.insert(id.clone(), cancellation.clone());
                None
            }
        };
        if let Some((code, message, stable_code)) = admission_error {
            return send_response(
                output,
                JsonRpcResponse::error(Some(id), code, message, stable_code),
            )
            .await;
        }

        let Some(deadline) = Instant::now().checked_add(self.config.limits.request_deadline) else {
            active.lock().await.remove(&id);
            return send_response(
                output,
                JsonRpcResponse::error(
                    Some(id),
                    ErrorCode::INTERNAL_ERROR,
                    "Internal error",
                    StableErrorCode::InternalError,
                ),
            )
            .await;
        };
        let handler = self.handler.clone();
        let output = output.clone();
        let active = active.clone();
        calls.spawn(async move {
            let response = execute_tool(handler, id.clone(), call, cancellation, deadline).await;
            let _send_result = output.send(response).await;
            active.lock().await.remove(&id);
        });
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionPhase {
    New,
    InitializeResponded,
    Ready,
}

enum InboundMessage {
    Request {
        id: RequestId,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    protocol_version: String,
    #[serde(rename = "capabilities")]
    _capabilities: Map<String, Value>,
    client_info: ClientInfo,
}

#[derive(Deserialize)]
struct ClientInfo {
    name: String,
    version: String,
}

struct ProtocolFault {
    id: Option<RequestId>,
    code: i64,
    message: &'static str,
    stable_code: StableErrorCode,
}

impl ProtocolFault {
    fn into_response(self) -> JsonRpcResponse {
        JsonRpcResponse::error(self.id, self.code, self.message, self.stable_code)
    }
}

#[derive(Serialize)]
pub(crate) struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Option<RequestId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize)]
struct JsonRpcError {
    code: i64,
    message: &'static str,
    data: ErrorData,
}

#[derive(Serialize)]
struct ErrorData {
    code: &'static str,
}

impl JsonRpcResponse {
    fn success(id: RequestId, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id: Some(id),
            result: Some(result),
            error: None,
        }
    }

    fn error(
        id: Option<RequestId>,
        code: i64,
        message: &'static str,
        stable_code: StableErrorCode,
    ) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message,
                data: ErrorData {
                    code: stable_code.as_str(),
                },
            }),
        }
    }

    pub(crate) fn output_too_large(self) -> Self {
        Self::error(
            self.id,
            ErrorCode::OUTPUT_TOO_LARGE,
            "Output message is too large",
            StableErrorCode::OutputTooLarge,
        )
    }
}

async fn execute_tool(
    handler: Arc<dyn ToolHandler>,
    id: RequestId,
    call: ToolCall,
    cancellation: CancellationToken,
    deadline: Instant,
) -> JsonRpcResponse {
    let context = ToolCallContext::new(cancellation.clone(), deadline);
    let mut worker = tokio::spawn(async move { handler.call(call, context).await });
    tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            worker.abort();
            let _join_result = worker.await;
            JsonRpcResponse::error(
                Some(id),
                ErrorCode::REQUEST_CANCELLED,
                "Request cancelled",
                StableErrorCode::RequestCancelled,
            )
        }
        () = sleep_until(deadline) => {
            cancellation.cancel();
            worker.abort();
            let _join_result = worker.await;
            JsonRpcResponse::error(
                Some(id),
                ErrorCode::REQUEST_TIMEOUT,
                "Request deadline exceeded",
                StableErrorCode::RequestTimeout,
            )
        }
        joined = &mut worker => {
            let result = match joined {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => ToolResult::from_error(error),
                Err(_) => ToolResult::from_error(crate::ToolError::internal()),
            };
            match serde_json::to_value(result) {
                Ok(value) => JsonRpcResponse::success(id, value),
                Err(_) => JsonRpcResponse::error(
                    Some(id),
                    ErrorCode::INTERNAL_ERROR,
                    "Internal error",
                    StableErrorCode::InternalError,
                ),
            }
        }
    }
}

fn parse_message(bytes: &[u8]) -> Option<Result<InboundMessage, ProtocolFault>> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    let value = match serde_json::from_slice::<Value>(bytes) {
        Ok(value) => value,
        Err(_) => {
            return Some(Err(ProtocolFault {
                id: None,
                code: ErrorCode::PARSE_ERROR,
                message: "Parse error",
                stable_code: StableErrorCode::ParseError,
            }));
        }
    };
    let Some(object) = value.as_object() else {
        return Some(Err(invalid_request(None)));
    };
    let id = object.get("id").and_then(parse_request_id);
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(Err(invalid_request(id)));
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Some(Err(invalid_request(id)));
    };
    if method.is_empty() || method.len() > MAX_METHOD_BYTES {
        return Some(Err(invalid_request(id)));
    }
    let params = object.get("params").cloned();
    if object.contains_key("id") {
        let Some(id) = id else {
            return Some(Err(invalid_request(None)));
        };
        Some(Ok(InboundMessage::Request {
            id,
            method: method.to_owned(),
            params,
        }))
    } else {
        Some(Ok(InboundMessage::Notification {
            method: method.to_owned(),
            params,
        }))
    }
}

fn parse_request_id(value: &Value) -> Option<RequestId> {
    match value {
        Value::String(id)
            if id.len() <= MAX_REQUEST_ID_BYTES && !id.chars().any(char::is_control) =>
        {
            Some(RequestId::String(id.clone()))
        }
        Value::Number(number) => number.as_i64().map(RequestId::Integer),
        _ => None,
    }
}

fn invalid_request(id: Option<RequestId>) -> ProtocolFault {
    ProtocolFault {
        id,
        code: ErrorCode::INVALID_REQUEST,
        message: "Invalid Request",
        stable_code: StableErrorCode::InvalidRequest,
    }
}

fn invalid_params(id: Option<RequestId>, message: &'static str) -> JsonRpcResponse {
    JsonRpcResponse::error(
        id,
        ErrorCode::INVALID_PARAMS,
        message,
        StableErrorCode::InvalidParams,
    )
}

fn not_initialized(id: RequestId) -> JsonRpcResponse {
    JsonRpcResponse::error(
        Some(id),
        ErrorCode::SERVER_NOT_INITIALIZED,
        "Server is not initialized",
        StableErrorCode::ServerNotInitialized,
    )
}

fn valid_optional_object(params: &Option<Value>) -> bool {
    matches!(params, None | Some(Value::Null) | Some(Value::Object(_)))
}

fn parse_cursor(params: Option<Value>) -> Result<Option<String>, ()> {
    let Some(params) = params else {
        return Ok(None);
    };
    if params.is_null() {
        return Ok(None);
    }
    let object = params.as_object().ok_or(())?;
    match object.get("cursor") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(cursor)) if !cursor.is_empty() && cursor.len() <= 1_024 => {
            Ok(Some(cursor.clone()))
        }
        Some(_) => Err(()),
    }
}

fn parse_tool_call(params: Option<Value>) -> Option<ToolCall> {
    let object = params?.as_object()?.clone();
    let name = object.get("name")?.as_str()?;
    if name.is_empty() || name.len() > 128 {
        return None;
    }
    let arguments = match object.get("arguments") {
        None => Map::new(),
        Some(Value::Object(arguments)) => arguments.clone(),
        Some(_) => return None,
    };
    Some(ToolCall {
        name: name.to_owned(),
        arguments,
    })
}

fn cancellation_request_id(params: Option<Value>) -> Option<RequestId> {
    let object = params?.as_object()?.clone();
    object.get("requestId").and_then(parse_request_id)
}

fn valid_metadata_component(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_METADATA_BYTES && !value.chars().any(char::is_control)
}

async fn send_response(
    output: &mpsc::Sender<JsonRpcResponse>,
    response: JsonRpcResponse,
) -> Result<(), ServeError> {
    output
        .send(response)
        .await
        .map_err(|_| ServeError::OutputChannelClosed)
}

fn reap_finished(calls: &mut JoinSet<()>) {
    while calls.try_join_next().is_some() {}
}

async fn cancel_active(active: &Arc<Mutex<BTreeMap<RequestId, CancellationToken>>>) {
    let tokens: Vec<_> = active.lock().await.values().cloned().collect();
    for token in tokens {
        token.cancel();
    }
}
