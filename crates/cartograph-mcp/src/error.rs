use std::{error::Error, fmt, time::Duration};

/// Standard and server-defined JSON-RPC numeric error codes.
pub struct ErrorCode;

impl ErrorCode {
    /// Invalid JSON.
    pub const PARSE_ERROR: i64 = -32_700;
    /// Invalid JSON-RPC envelope.
    pub const INVALID_REQUEST: i64 = -32_600;
    /// Unknown JSON-RPC method.
    pub const METHOD_NOT_FOUND: i64 = -32_601;
    /// Invalid method parameters.
    pub const INVALID_PARAMS: i64 = -32_602;
    /// Unexpected server failure.
    pub const INTERNAL_ERROR: i64 = -32_603;
    /// Request arrived before MCP initialization completed.
    pub const SERVER_NOT_INITIALIZED: i64 = -32_002;
    /// Request exceeded the server deadline.
    pub const REQUEST_TIMEOUT: i64 = -32_001;
    /// Bounded input line was exceeded before parsing.
    pub const INPUT_TOO_LARGE: i64 = -32_010;
    /// Serialized response exceeded the configured output bound.
    pub const OUTPUT_TOO_LARGE: i64 = -32_011;
    /// Request ID is already active on this connection.
    pub const DUPLICATE_REQUEST_ID: i64 = -32_012;
    /// Bounded in-flight request capacity is exhausted.
    pub const SERVER_BUSY: i64 = -32_013;
    /// Request was cancelled by its peer.
    pub const REQUEST_CANCELLED: i64 = -32_800;
}

/// Stable machine-readable error values carried in JSON-RPC `error.data.code`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StableErrorCode {
    ParseError,
    InvalidRequest,
    MethodNotFound,
    InvalidParams,
    InternalError,
    ServerNotInitialized,
    RequestTimeout,
    InputTooLarge,
    OutputTooLarge,
    DuplicateRequestId,
    ServerBusy,
    RequestCancelled,
    UnknownTool,
    UnsupportedCursor,
    AlreadyInitialized,
}

impl StableErrorCode {
    /// Stable snake-case wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ParseError => "parse_error",
            Self::InvalidRequest => "invalid_request",
            Self::MethodNotFound => "method_not_found",
            Self::InvalidParams => "invalid_params",
            Self::InternalError => "internal_error",
            Self::ServerNotInitialized => "server_not_initialized",
            Self::RequestTimeout => "request_timeout",
            Self::InputTooLarge => "input_too_large",
            Self::OutputTooLarge => "output_too_large",
            Self::DuplicateRequestId => "duplicate_request_id",
            Self::ServerBusy => "server_busy",
            Self::RequestCancelled => "request_cancelled",
            Self::UnknownTool => "unknown_tool",
            Self::UnsupportedCursor => "unsupported_cursor",
            Self::AlreadyInitialized => "already_initialized",
        }
    }
}

/// Stable tool-level failure categories exposed to coding agents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolErrorCode {
    InvalidArguments,
    NotFound,
    Conflict,
    NotReady,
    Unavailable,
    Internal,
}

impl ToolErrorCode {
    /// Stable snake-case wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArguments => "invalid_arguments",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::NotReady => "not_ready",
            Self::Unavailable => "unavailable",
            Self::Internal => "tool_failed",
        }
    }
}

/// Tool execution failure with an explicitly safe or fully redacted message.
#[derive(Clone, PartialEq, Eq)]
pub struct ToolError {
    code: ToolErrorCode,
    safe_message: Option<String>,
}

impl ToolError {
    /// Construct an agent-visible failure. The caller must pass only text that
    /// is safe to cross the MCP boundary.
    pub fn safe(
        code: ToolErrorCode,
        safe_message: impl Into<String>,
    ) -> Result<Self, ToolContractError> {
        let safe_message = safe_message.into();
        if code == ToolErrorCode::Internal || safe_message.is_empty() || safe_message.len() > 1_024
        {
            return Err(ToolContractError::InvalidSafeError);
        }
        Ok(Self {
            code,
            safe_message: Some(safe_message),
        })
    }

    /// Construct a failure whose details must not cross the MCP boundary.
    #[must_use]
    pub const fn internal() -> Self {
        Self {
            code: ToolErrorCode::Internal,
            safe_message: None,
        }
    }

    pub(crate) const fn code(&self) -> ToolErrorCode {
        self.code
    }

    pub(crate) fn wire_message(&self) -> &str {
        self.safe_message
            .as_deref()
            .unwrap_or("Tool execution failed")
    }
}

impl fmt::Debug for ToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolError")
            .field("code", &self.code)
            .field("message", &self.safe_message.as_ref().map(|_| "<safe>"))
            .finish()
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Cartograph tool execution failed")
    }
}

impl Error for ToolError {}

/// Invalid public MCP/tool configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigError {
    InvalidServerMetadata,
    InvalidProtocolVersion,
    InvalidInputLimit,
    InvalidOutputLimit,
    InvalidInflightLimit,
    InvalidRequestDeadline,
    InvalidToolDefinition,
    DuplicateToolName,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidServerMetadata => "MCP server metadata is invalid",
            Self::InvalidProtocolVersion => "MCP protocol version is invalid",
            Self::InvalidInputLimit => "MCP input byte limit is invalid",
            Self::InvalidOutputLimit => "MCP output byte limit is invalid",
            Self::InvalidInflightLimit => "MCP in-flight request limit is invalid",
            Self::InvalidRequestDeadline => "MCP request deadline is invalid",
            Self::InvalidToolDefinition => "MCP tool definition is invalid",
            Self::DuplicateToolName => "MCP tool names must be unique",
        };
        formatter.write_str(message)
    }
}

impl Error for ConfigError {}

/// Invalid tool/profile contract supplied by an adapter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolContractError {
    InvalidName,
    InvalidDescription,
    InvalidInputSchema,
    EmptyProfiles,
    InvalidProfile,
    InvalidSafeError,
}

impl fmt::Display for ToolContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MCP tool contract is invalid")
    }
}

impl Error for ToolContractError {}

/// Redacted transport lifecycle failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServeError {
    InputReadFailed,
    OutputWriteFailed,
    OutputChannelClosed,
    OutputTaskFailed,
}

impl fmt::Display for ServeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InputReadFailed => "MCP input stream failed",
            Self::OutputWriteFailed => "MCP output stream failed",
            Self::OutputChannelClosed => "MCP output channel closed",
            Self::OutputTaskFailed => "MCP output task failed",
        };
        formatter.write_str(message)
    }
}

impl Error for ServeError {}

pub(crate) const fn valid_deadline(deadline: Duration) -> bool {
    !deadline.is_zero()
        && (deadline.as_secs() < 600 || (deadline.as_secs() == 600 && deadline.subsec_nanos() == 0))
}
