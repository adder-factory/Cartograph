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
const MAX_INSTRUCTIONS_BYTES: usize = 16 * 1_024;

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

/// Raw resource limits collected before boundary validation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServerLimitsInput {
    max_input_bytes: usize,
    max_output_bytes: usize,
    max_inflight_requests: usize,
    request_deadline: Duration,
}

impl ServerLimitsInput {
    /// Collect byte and concurrency limits with the standard request deadline.
    #[must_use]
    pub const fn new(
        max_input_bytes: usize,
        max_output_bytes: usize,
        max_inflight_requests: usize,
    ) -> Self {
        Self {
            max_input_bytes,
            max_output_bytes,
            max_inflight_requests,
            request_deadline: DEFAULT_REQUEST_DEADLINE,
        }
    }

    /// Override the wall-clock request deadline before validation.
    #[must_use]
    pub const fn with_request_deadline(mut self, request_deadline: Duration) -> Self {
        self.request_deadline = request_deadline;
        self
    }
}

impl ServerLimits {
    /// Validate explicit input/output/concurrency/deadline bounds.
    pub const fn new(input: ServerLimitsInput) -> Result<Self, ConfigError> {
        let ServerLimitsInput {
            max_input_bytes,
            max_output_bytes,
            max_inflight_requests,
            request_deadline,
        } = input;
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
    instructions: Option<String>,
    profile: ToolProfile,
    disabled_tools: BTreeMap<String, ()>,
    read_only_tools_only: bool,
    limits: ServerLimits,
}

impl ServerConfig {
    /// Construct a server configuration around validated components.
    #[must_use]
    pub fn new(metadata: ServerMetadata, profile: ToolProfile, limits: ServerLimits) -> Self {
        Self {
            metadata,
            protocol_version: DEFAULT_PROTOCOL_VERSION.to_owned(),
            instructions: None,
            profile,
            disabled_tools: BTreeMap::new(),
            read_only_tools_only: false,
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

    /// Advertise bounded, project-independent guidance in the initialize response.
    pub fn with_instructions(
        mut self,
        instructions: impl Into<String>,
    ) -> Result<Self, ConfigError> {
        let instructions = instructions.into();
        if instructions.trim().is_empty()
            || instructions.len() > MAX_INSTRUCTIONS_BYTES
            || instructions.contains('\0')
        {
            return Err(ConfigError::InvalidInstructions);
        }
        self.instructions = Some(instructions);
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

    /// Remove exact validated tool names from the advertised/callable surface.
    pub fn with_disabled_tools<I, S>(mut self, names: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        for name in names {
            let name = name.into();
            if name.is_empty()
                || name.len() > MAX_METHOD_BYTES
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            {
                return Err(ConfigError::InvalidServerMetadata);
            }
            self.disabled_tools.insert(name, ());
        }
        Ok(self)
    }

    /// Advertise only contracts explicitly marked read-only.
    #[must_use]
    pub const fn with_read_only_tools_only(mut self, enabled: bool) -> Self {
        self.read_only_tools_only = enabled;
        self
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
            if definition.included_in(config.profile)
                && !config.disabled_tools.contains_key(definition.name())
                && (!config.read_only_tools_only
                    || definition
                        .annotations()
                        .is_some_and(|annotations| annotations.read_only_hint == Some(true))
                    || definition.has_read_only_carve_out())
            {
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
        let mut writer = tokio::spawn(write_responses(output, output_receiver, maximum_output));
        let mut session = ConnectionState::new(output_sender);
        let mut reader = BufReader::new(input);
        let outcome = {
            let messages = self.read_messages(&mut reader, &mut session);
            tokio::pin!(messages);
            tokio::select! {
                terminal_error = &mut messages => ConnectionOutcome::Reader(terminal_error),
                writer_result = &mut writer => ConnectionOutcome::Writer(join_writer(writer_result)),
            }
        };
        session.shutdown().await;
        self.handler.shutdown().await;
        match outcome {
            ConnectionOutcome::Reader(terminal_error) => {
                let writer_result = join_writer(writer.await);
                terminal_error.map_or(writer_result, Err)
            }
            ConnectionOutcome::Writer(writer_result) => writer_result,
        }
    }

    async fn read_messages<R>(
        &self,
        reader: &mut BufReader<R>,
        session: &mut ConnectionState,
    ) -> Option<ServeError>
    where
        R: AsyncRead + Send + Unpin + 'static,
    {
        loop {
            reap_finished(&mut session.calls);
            let line = match read_bounded_line(reader, self.config.limits.max_input_bytes).await {
                Ok(line) => line,
                Err(error) => return Some(error),
            };
            match self.handle_line(line, session).await {
                Ok(ReadDirective::Continue) => {}
                Ok(ReadDirective::Stop) => return None,
                Err(error) => return Some(error),
            }
        }
    }

    async fn handle_line(
        &self,
        line: BoundedLine,
        session: &mut ConnectionState,
    ) -> Result<ReadDirective, ServeError> {
        match line {
            BoundedLine::Eof => Ok(ReadDirective::Stop),
            BoundedLine::TooLarge => {
                let response = JsonRpcResponse::error(
                    None,
                    ErrorSpec::new(
                        ErrorCode::INPUT_TOO_LARGE,
                        "Input message is too large",
                        StableErrorCode::InputTooLarge,
                    ),
                );
                send_response(&session.output, response).await?;
                Ok(ReadDirective::Continue)
            }
            BoundedLine::Line(bytes) => {
                let Some(message) = parse_message(&bytes) else {
                    return Ok(ReadDirective::Continue);
                };
                match message {
                    Ok(message) => self.dispatch(message, session).await?,
                    Err(fault) => {
                        send_response(&session.output, fault.into_response()).await?;
                    }
                }
                Ok(ReadDirective::Continue)
            }
        }
    }

    /// Serve stdin/stdout without writing any non-protocol bytes to stdout.
    pub async fn serve_stdio(&self) -> Result<(), ServeError> {
        self.serve(tokio::io::stdin(), tokio::io::stdout()).await
    }

    async fn dispatch(
        &self,
        message: InboundMessage,
        session: &mut ConnectionState,
    ) -> Result<(), ServeError> {
        match message {
            InboundMessage::Notification(notification) => {
                dispatch_notification(notification, session).await;
                Ok(())
            }
            InboundMessage::Request(request) => self.dispatch_request(request, session).await,
        }
    }

    async fn dispatch_request(
        &self,
        request: InboundRequest,
        session: &mut ConnectionState,
    ) -> Result<(), ServeError> {
        match request.method.as_str() {
            "initialize" => self.initialize(request, session).await,
            "ping" => ping(request, session).await,
            "tools/list" => self.list_tools(request, session).await,
            "tools/call" => self.call_tool(request, session).await,
            _ => {
                send_response(
                    &session.output,
                    JsonRpcResponse::error(
                        Some(request.id),
                        ErrorSpec::new(
                            ErrorCode::METHOD_NOT_FOUND,
                            "Method not found",
                            StableErrorCode::MethodNotFound,
                        ),
                    ),
                )
                .await
            }
        }
    }

    async fn initialize(
        &self,
        request: InboundRequest,
        session: &mut ConnectionState,
    ) -> Result<(), ServeError> {
        if session.phase != SessionPhase::New {
            return send_response(
                &session.output,
                JsonRpcResponse::error(
                    Some(request.id),
                    ErrorSpec::new(
                        ErrorCode::INVALID_REQUEST,
                        "Server is already initialized",
                        StableErrorCode::AlreadyInitialized,
                    ),
                ),
            )
            .await;
        }
        let Some(params) = request.params else {
            return send_response(
                &session.output,
                invalid_params(Some(request.id), "Missing initialize parameters"),
            )
            .await;
        };
        let Ok(parsed) = serde_json::from_value::<InitializeParams>(params) else {
            return send_response(
                &session.output,
                invalid_params(Some(request.id), "Invalid initialize parameters"),
            )
            .await;
        };
        if !valid_metadata_component(&parsed.client_info.name)
            || !valid_metadata_component(&parsed.client_info.version)
            || parsed.protocol_version.is_empty()
            || parsed.protocol_version.len() > 32
        {
            return send_response(
                &session.output,
                invalid_params(Some(request.id), "Invalid initialize parameters"),
            )
            .await;
        }

        let negotiated = if parsed.protocol_version == self.config.protocol_version {
            parsed.protocol_version
        } else {
            self.config.protocol_version.clone()
        };
        let mut result = json!({
            "protocolVersion": negotiated,
            "capabilities": { "tools": {} },
            "serverInfo": self.config.metadata,
        });
        if let Some(instructions) = &self.config.instructions
            && let Some(object) = result.as_object_mut()
        {
            object.insert(
                "instructions".to_owned(),
                Value::String(instructions.clone()),
            );
        }
        send_response(
            &session.output,
            JsonRpcResponse::success(request.id, result),
        )
        .await?;
        session.phase = SessionPhase::InitializeResponded;
        Ok(())
    }

    async fn list_tools(
        &self,
        request: InboundRequest,
        session: &ConnectionState,
    ) -> Result<(), ServeError> {
        if session.phase != SessionPhase::Ready {
            return send_response(&session.output, not_initialized(request.id)).await;
        }
        let cursor = match parse_cursor(request.params) {
            Ok(cursor) => cursor,
            Err(()) => {
                return send_response(
                    &session.output,
                    invalid_params(Some(request.id), "Invalid tools/list parameters"),
                )
                .await;
            }
        };
        if cursor.is_some() {
            return send_response(
                &session.output,
                JsonRpcResponse::error(
                    Some(request.id),
                    ErrorSpec::new(
                        ErrorCode::INVALID_PARAMS,
                        "Pagination cursor is not supported",
                        StableErrorCode::UnsupportedCursor,
                    ),
                ),
            )
            .await;
        }
        send_response(
            &session.output,
            JsonRpcResponse::success(request.id, json!({ "tools": self.tools.as_ref() })),
        )
        .await
    }

    async fn call_tool(
        &self,
        request: InboundRequest,
        session: &mut ConnectionState,
    ) -> Result<(), ServeError> {
        if session.phase != SessionPhase::Ready {
            return send_response(&session.output, not_initialized(request.id)).await;
        }
        let Some(call) = parse_tool_call(request.params) else {
            return send_response(
                &session.output,
                invalid_params(Some(request.id), "Invalid tools/call parameters"),
            )
            .await;
        };
        if !self.tool_names.contains_key(&call.name) {
            return send_response(
                &session.output,
                JsonRpcResponse::error(
                    Some(request.id),
                    ErrorSpec::new(
                        ErrorCode::INVALID_PARAMS,
                        "Unknown tool",
                        StableErrorCode::UnknownTool,
                    ),
                ),
            )
            .await;
        }

        let cancellation = match session
            .admit(&request.id, self.config.limits.max_inflight_requests)
            .await
        {
            Ok(cancellation) => cancellation,
            Err(response) => return send_response(&session.output, response).await,
        };

        let Some(deadline) = Instant::now().checked_add(self.config.limits.request_deadline) else {
            session.active.lock().await.remove(&request.id);
            return send_response(
                &session.output,
                JsonRpcResponse::error(
                    Some(request.id),
                    ErrorSpec::new(
                        ErrorCode::INTERNAL_ERROR,
                        "Internal error",
                        StableErrorCode::InternalError,
                    ),
                ),
            )
            .await;
        };
        session.spawn(ToolExecution {
            handler: self.handler.clone(),
            id: request.id,
            call,
            cancellation,
            deadline,
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

enum ReadDirective {
    Continue,
    Stop,
}

enum ConnectionOutcome {
    Reader(Option<ServeError>),
    Writer(Result<(), ServeError>),
}

fn join_writer(
    result: Result<Result<(), ServeError>, tokio::task::JoinError>,
) -> Result<(), ServeError> {
    result.unwrap_or(Err(ServeError::OutputTaskFailed))
}

struct ConnectionState {
    phase: SessionPhase,
    active: Arc<Mutex<BTreeMap<RequestId, CancellationToken>>>,
    calls: JoinSet<()>,
    output: mpsc::Sender<JsonRpcResponse>,
}

impl ConnectionState {
    fn new(output: mpsc::Sender<JsonRpcResponse>) -> Self {
        Self {
            phase: SessionPhase::New,
            active: Arc::new(Mutex::new(BTreeMap::new())),
            calls: JoinSet::new(),
            output,
        }
    }

    async fn admit(
        &self,
        id: &RequestId,
        maximum_inflight: usize,
    ) -> Result<CancellationToken, JsonRpcResponse> {
        let mut requests = self.active.lock().await;
        if requests.contains_key(id) {
            return Err(JsonRpcResponse::error(
                Some(id.clone()),
                ErrorSpec::new(
                    ErrorCode::DUPLICATE_REQUEST_ID,
                    "Request ID is already active",
                    StableErrorCode::DuplicateRequestId,
                ),
            ));
        }
        if requests.len() >= maximum_inflight {
            return Err(JsonRpcResponse::error(
                Some(id.clone()),
                ErrorSpec::new(
                    ErrorCode::SERVER_BUSY,
                    "Server request capacity is exhausted",
                    StableErrorCode::ServerBusy,
                ),
            ));
        }
        let cancellation = CancellationToken::new();
        requests.insert(id.clone(), cancellation.clone());
        Ok(cancellation)
    }

    fn spawn(&mut self, execution: ToolExecution) {
        let id = execution.id.clone();
        let output = self.output.clone();
        let active = self.active.clone();
        self.calls.spawn(async move {
            let response = execute_tool(execution).await;
            let _send_result = output.send(response).await;
            active.lock().await.remove(&id);
        });
    }

    async fn shutdown(mut self) {
        cancel_active(&self.active).await;
        while self.calls.join_next().await.is_some() {}
    }
}

enum InboundMessage {
    Request(InboundRequest),
    Notification(InboundNotification),
}

struct InboundRequest {
    id: RequestId,
    method: String,
    params: Option<Value>,
}

struct InboundNotification {
    method: String,
    params: Option<Value>,
}

struct ToolExecution {
    handler: Arc<dyn ToolHandler>,
    id: RequestId,
    call: ToolCall,
    cancellation: CancellationToken,
    deadline: Instant,
}

async fn dispatch_notification(notification: InboundNotification, session: &mut ConnectionState) {
    match notification.method.as_str() {
        "notifications/initialized"
            if session.phase == SessionPhase::InitializeResponded
                && valid_optional_object(&notification.params) =>
        {
            session.phase = SessionPhase::Ready;
        }
        "notifications/cancelled" => {
            let Some(request_id) = cancellation_request_id(notification.params) else {
                return;
            };
            if let Some(token) = session.active.lock().await.get(&request_id).cloned() {
                token.cancel();
            }
        }
        _ => {}
    }
}

async fn ping(request: InboundRequest, session: &ConnectionState) -> Result<(), ServeError> {
    if !valid_optional_object(&request.params) {
        return send_response(
            &session.output,
            invalid_params(Some(request.id), "Invalid ping parameters"),
        )
        .await;
    }
    send_response(
        &session.output,
        JsonRpcResponse::success(request.id, json!({})),
    )
    .await
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

#[derive(Clone, Copy)]
struct ErrorSpec {
    code: i64,
    message: &'static str,
    stable_code: StableErrorCode,
}

impl ErrorSpec {
    const fn new(code: i64, message: &'static str, stable_code: StableErrorCode) -> Self {
        Self {
            code,
            message,
            stable_code,
        }
    }
}

struct ProtocolFault {
    id: Option<RequestId>,
    error: ErrorSpec,
}

impl ProtocolFault {
    fn into_response(self) -> JsonRpcResponse {
        JsonRpcResponse::error(self.id, self.error)
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

    fn error(id: Option<RequestId>, error: ErrorSpec) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: error.code,
                message: error.message,
                data: ErrorData {
                    code: error.stable_code.as_str(),
                },
            }),
        }
    }

    pub(crate) fn output_too_large(self) -> Self {
        Self::error(
            self.id,
            ErrorSpec::new(
                ErrorCode::OUTPUT_TOO_LARGE,
                "Output message is too large",
                StableErrorCode::OutputTooLarge,
            ),
        )
    }
}

async fn execute_tool(execution: ToolExecution) -> JsonRpcResponse {
    let ToolExecution {
        handler,
        id,
        call,
        cancellation,
        deadline,
    } = execution;
    let context = ToolCallContext::new(cancellation.clone(), deadline);
    let mut worker = tokio::spawn(async move { handler.call(call, context).await });
    tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            worker.abort();
            let _join_result = worker.await;
            JsonRpcResponse::error(
                Some(id),
                ErrorSpec::new(
                    ErrorCode::REQUEST_CANCELLED,
                    "Request cancelled",
                    StableErrorCode::RequestCancelled,
                ),
            )
        }
        () = sleep_until(deadline) => {
            cancellation.cancel();
            worker.abort();
            let _join_result = worker.await;
            JsonRpcResponse::error(
                Some(id),
                ErrorSpec::new(
                    ErrorCode::REQUEST_TIMEOUT,
                    "Request deadline exceeded",
                    StableErrorCode::RequestTimeout,
                ),
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
                    ErrorSpec::new(
                        ErrorCode::INTERNAL_ERROR,
                        "Internal error",
                        StableErrorCode::InternalError,
                    ),
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
                error: ErrorSpec::new(
                    ErrorCode::PARSE_ERROR,
                    "Parse error",
                    StableErrorCode::ParseError,
                ),
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
        Some(Ok(InboundMessage::Request(InboundRequest {
            id,
            method: method.to_owned(),
            params,
        })))
    } else {
        Some(Ok(InboundMessage::Notification(InboundNotification {
            method: method.to_owned(),
            params,
        })))
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
        error: ErrorSpec::new(
            ErrorCode::INVALID_REQUEST,
            "Invalid Request",
            StableErrorCode::InvalidRequest,
        ),
    }
}

fn invalid_params(id: Option<RequestId>, message: &'static str) -> JsonRpcResponse {
    JsonRpcResponse::error(
        id,
        ErrorSpec::new(
            ErrorCode::INVALID_PARAMS,
            message,
            StableErrorCode::InvalidParams,
        ),
    )
}

fn not_initialized(id: RequestId) -> JsonRpcResponse {
    JsonRpcResponse::error(
        Some(id),
        ErrorSpec::new(
            ErrorCode::SERVER_NOT_INITIALIZED,
            "Server is not initialized",
            StableErrorCode::ServerNotInitialized,
        ),
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
