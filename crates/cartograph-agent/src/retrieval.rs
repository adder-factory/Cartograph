use std::time::Duration;

use cartograph_db::{
    EmbeddingModelRegistration, EmbeddingModelRegistrationInput, EmbeddingNormalization,
    SemanticReadinessRequest, SemanticReadinessState, SemanticStorageError, StorageError,
    VectorSearchHit, VectorSearchInput, VectorSearchRequest,
};
use cartograph_domain::{GenerationId, NormalizedPath, ProjectId, SourceLanguage};
use cartograph_llm::{EmbeddingSettings, OpenAiEmbeddingClient};
use cartograph_search::{
    ChannelCandidate, ChannelResults, DeterministicRetriever, GenerationLexicalRequest,
    HybridSearchInput, HybridSearchPacket, LexicalQuery, RetrievalChannel, RetrievalChannels,
    RetrievalDocument, RetrievalDocumentInput, RetrievalError, SearchMode, SemanticReadiness,
    fuse_search,
};

use crate::{ProjectCancellation, ProjectError, ProjectRuntime};

const DEFAULT_CANDIDATE_LIMIT: u16 = 20;
const MAXIMUM_CANDIDATE_LIMIT: u16 = 100;
const SEMANTIC_ENDPOINT_TIMEOUT: Duration = Duration::from_secs(30);
const SEMANTIC_QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const MODEL_PROVIDER: &str = "openai-compatible";
const GENERATION_ATTEMPTS: usize = 2;

enum SemanticClientState {
    NotConfigured,
    Unavailable,
    Ready(Box<OpenAiEmbeddingClient>),
}

enum RetrievalStageError {
    RequestCancelled,
    GenerationChanged,
    Failed,
}

/// Validated deterministic/auto/hybrid policy for one natural-language retrieval.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetrievalOptions {
    mode: SearchMode,
    candidate_limit: u16,
}

/// One bounded natural-language retrieval request shared by CLI, MCP, and tests.
pub struct RetrievalRequest {
    project_id: ProjectId,
    query: String,
    options: RetrievalOptions,
}

impl RetrievalRequest {
    /// Bind project identity, redacted query text, and execution policy.
    #[must_use]
    pub fn new(project_id: ProjectId, query: impl Into<String>, options: RetrievalOptions) -> Self {
        Self {
            project_id,
            query: query.into(),
            options,
        }
    }
}

impl std::fmt::Debug for RetrievalRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RetrievalRequest")
            .field("project_id", &self.project_id)
            .field("query", &"<redacted>")
            .field("options", &self.options)
            .finish()
    }
}

/// Explicit embedding-client execution used by live tests and embedded hosts.
pub struct RetrievalClientRequest {
    request: RetrievalRequest,
    client: OpenAiEmbeddingClient,
    cancellation: ProjectCancellation,
}

impl RetrievalClientRequest {
    /// Attach a validated endpoint client and caller-owned cancellation.
    #[must_use]
    pub const fn new(
        request: RetrievalRequest,
        client: OpenAiEmbeddingClient,
        cancellation: ProjectCancellation,
    ) -> Self {
        Self {
            request,
            client,
            cancellation,
        }
    }
}

impl RetrievalOptions {
    /// Select a mode and a bounded Top-K candidate count.
    pub const fn new(mode: SearchMode, candidate_limit: u16) -> Result<Self, ProjectError> {
        if candidate_limit == 0 || candidate_limit > MAXIMUM_CANDIDATE_LIMIT {
            return Err(ProjectError::InvalidOptions);
        }
        Ok(Self {
            mode,
            candidate_limit,
        })
    }

    /// Requested deterministic, hybrid, or automatic execution policy.
    #[must_use]
    pub const fn mode(self) -> SearchMode {
        self.mode
    }

    /// Maximum independently ranked candidates admitted from each channel.
    #[must_use]
    pub const fn candidate_limit(self) -> u16 {
        self.candidate_limit
    }

    /// Replace only the channel policy while retaining the validated bound.
    #[must_use]
    pub const fn with_mode(mut self, mode: SearchMode) -> Self {
        self.mode = mode;
        self
    }
}

impl Default for RetrievalOptions {
    fn default() -> Self {
        Self {
            mode: SearchMode::Auto,
            candidate_limit: DEFAULT_CANDIDATE_LIMIT,
        }
    }
}

/// Concurrent channel result plus the exact semantic readiness used by policy selection.
pub struct PreparedRetrieval {
    semantic_readiness: SemanticReadiness,
    channels: RetrievalChannels,
}

impl PreparedRetrieval {
    /// Semantic readiness observed for this exact query attempt.
    #[must_use]
    pub const fn semantic_readiness(&self) -> SemanticReadiness {
        self.semantic_readiness
    }

    /// Consume the preparation into the channel join point used by context assembly.
    #[must_use]
    pub fn into_channels(self) -> RetrievalChannels {
        self.channels
    }

    fn into_packet(self, options: RetrievalOptions) -> Result<HybridSearchPacket, ProjectError> {
        fuse_search(
            HybridSearchInput::new(
                options.mode,
                self.semantic_readiness,
                options.candidate_limit,
            )
            .map_err(|_| ProjectError::RetrievalOperationFailed)?
            .with_channels(self.channels),
        )
        .map_err(|_| ProjectError::RetrievalOperationFailed)
    }
}

impl ProjectRuntime {
    /// Execute bounded lexical and eligible semantic retrieval concurrently.
    pub async fn prepare_retrieval(
        &self,
        request: RetrievalRequest,
    ) -> Result<PreparedRetrieval, ProjectError> {
        self.prepare_retrieval_with_cancellation(request, ProjectCancellation::new())
            .await
    }

    /// Prepare independently ranked channels with caller-owned cancellation.
    pub async fn prepare_retrieval_with_cancellation(
        &self,
        request: RetrievalRequest,
        cancellation: ProjectCancellation,
    ) -> Result<PreparedRetrieval, ProjectError> {
        let semantic_client = semantic_client_from_project(
            request.options.mode,
            self.project_root_for_host_operations(),
        );
        self.prepare_retrieval_inner(RetrievalExecutionRequest {
            request,
            semantic_client,
            cancellation,
        })
        .await
    }

    /// Prepare channels with an explicitly validated client for tests and embedded hosts.
    pub async fn prepare_retrieval_with_client(
        &self,
        input: RetrievalClientRequest,
    ) -> Result<PreparedRetrieval, ProjectError> {
        self.prepare_retrieval_inner(RetrievalExecutionRequest {
            request: input.request,
            semantic_client: SemanticClientState::Ready(Box::new(input.client)),
            cancellation: input.cancellation,
        })
        .await
    }

    async fn prepare_retrieval_inner(
        &self,
        input: RetrievalExecutionRequest,
    ) -> Result<PreparedRetrieval, ProjectError> {
        let RetrievalExecutionRequest {
            request:
                RetrievalRequest {
                    project_id,
                    query,
                    options,
                },
            semantic_client,
            cancellation,
        } = input;
        for attempt in 0..GENERATION_ATTEMPTS {
            match self
                .prepare_retrieval_attempt(RetrievalAttemptRequest {
                    project_id: &project_id,
                    query: &query,
                    options,
                    semantic_client: &semantic_client,
                    cancellation: &cancellation,
                })
                .await
            {
                Err(RetrievalStageError::GenerationChanged) if attempt == 0 => continue,
                Err(error) => return Err(project_retrieval_error(error)),
                Ok(prepared) => return Ok(prepared),
            }
        }
        Err(ProjectError::RetrievalOperationFailed)
    }

    async fn prepare_retrieval_attempt(
        &self,
        input: RetrievalAttemptRequest<'_>,
    ) -> Result<PreparedRetrieval, RetrievalStageError> {
        let RetrievalAttemptRequest {
            project_id,
            query,
            options,
            semantic_client,
            cancellation,
        } = input;
        let generation = self
            .database()
            .current_generation_record(project_id)
            .await
            .map_err(storage_stage_error)?;
        let Some(generation) = generation else {
            let lexical = ChannelResults::new(RetrievalChannel::Lexical, Vec::new())
                .map_err(|_| RetrievalStageError::Failed)?;
            let channels = RetrievalChannels::new()
                .with_channel(lexical)
                .map_err(|_| RetrievalStageError::Failed)?;
            let semantic_readiness = if options.mode == SearchMode::Deterministic {
                SemanticReadiness::NotConfigured
            } else {
                SemanticReadiness::NotIndexed
            };
            return Ok(PreparedRetrieval {
                semantic_readiness,
                channels,
            });
        };
        let expected_generation_id = generation.generation_id().clone();
        let lexical_query = LexicalQuery::new(query, options.candidate_limit)
            .map_err(|_| RetrievalStageError::Failed)?;
        let retriever = DeterministicRetriever::new(self.database().clone());
        if options.mode == SearchMode::Deterministic {
            let lexical = lexical_channel(LexicalChannelRequest {
                retriever,
                project_id: project_id.clone(),
                expected_generation_id: expected_generation_id.clone(),
                query: lexical_query,
                cancellation: cancellation.clone(),
            })
            .await?;
            ensure_generation_current(self, project_id, &expected_generation_id).await?;
            return Ok(PreparedRetrieval {
                semantic_readiness: SemanticReadiness::NotConfigured,
                channels: optional_channel(Some(lexical))
                    .map_err(|_| RetrievalStageError::Failed)?,
            });
        }

        let lexical = lexical_channel(LexicalChannelRequest {
            retriever,
            project_id: project_id.clone(),
            expected_generation_id: expected_generation_id.clone(),
            query: lexical_query,
            cancellation: cancellation.clone(),
        });
        let semantic = semantic_channel(SemanticChannelRequest {
            runtime: self,
            project_id: project_id.clone(),
            expected_generation_id: expected_generation_id.clone(),
            query: query.to_owned(),
            limit: options.candidate_limit,
            client: semantic_client,
            cancellation: cancellation.clone(),
        });
        let (lexical, semantic) = tokio::join!(lexical, semantic);
        let lexical = match lexical {
            Ok(channel) => Some(channel),
            Err(RetrievalStageError::RequestCancelled) => {
                return Err(RetrievalStageError::RequestCancelled);
            }
            Err(RetrievalStageError::GenerationChanged) => {
                return Err(RetrievalStageError::GenerationChanged);
            }
            Err(RetrievalStageError::Failed) => None,
        };
        let (semantic_readiness, semantic) = semantic?;
        if lexical.is_none() && semantic.is_none() {
            return Err(RetrievalStageError::Failed);
        }
        let channels = optional_channel(lexical).map_err(|_| RetrievalStageError::Failed)?;
        let channels = match semantic {
            Some(channel) => channels
                .with_channel(channel)
                .map_err(|_| RetrievalStageError::Failed)?,
            None => channels,
        };
        ensure_generation_current(self, project_id, &expected_generation_id).await?;
        Ok(PreparedRetrieval {
            semantic_readiness,
            channels,
        })
    }

    /// Return one compact fused packet suitable for CLI and MCP `find` consumers.
    pub async fn search(
        &self,
        request: RetrievalRequest,
    ) -> Result<HybridSearchPacket, ProjectError> {
        self.search_with_cancellation(request, ProjectCancellation::new())
            .await
    }

    /// Search with explicit cancellation across the endpoint and both PostgreSQL channels.
    pub async fn search_with_cancellation(
        &self,
        request: RetrievalRequest,
        cancellation: ProjectCancellation,
    ) -> Result<HybridSearchPacket, ProjectError> {
        let options = request.options;
        self.prepare_retrieval_with_cancellation(request, cancellation)
            .await?
            .into_packet(options)
    }

    /// Search through an explicit client without mutating process environment configuration.
    pub async fn search_with_client(
        &self,
        input: RetrievalClientRequest,
    ) -> Result<HybridSearchPacket, ProjectError> {
        let options = input.request.options;
        self.prepare_retrieval_with_client(input)
            .await?
            .into_packet(options)
    }
}

struct RetrievalExecutionRequest {
    request: RetrievalRequest,
    semantic_client: SemanticClientState,
    cancellation: ProjectCancellation,
}

struct RetrievalAttemptRequest<'a> {
    project_id: &'a ProjectId,
    query: &'a str,
    options: RetrievalOptions,
    semantic_client: &'a SemanticClientState,
    cancellation: &'a ProjectCancellation,
}

struct LexicalChannelRequest {
    retriever: DeterministicRetriever,
    project_id: ProjectId,
    expected_generation_id: GenerationId,
    query: LexicalQuery,
    cancellation: ProjectCancellation,
}

struct SemanticChannelRequest<'runtime> {
    runtime: &'runtime ProjectRuntime,
    project_id: ProjectId,
    expected_generation_id: GenerationId,
    query: String,
    limit: u16,
    client: &'runtime SemanticClientState,
    cancellation: ProjectCancellation,
}

fn semantic_client_from_project(
    mode: SearchMode,
    project_root: &std::path::Path,
) -> SemanticClientState {
    if mode == SearchMode::Deterministic {
        return SemanticClientState::NotConfigured;
    }
    match EmbeddingSettings::try_from_project(project_root) {
        Ok(Some(settings)) => OpenAiEmbeddingClient::new(settings)
            .map_or(SemanticClientState::Unavailable, |client| {
                SemanticClientState::Ready(Box::new(client))
            }),
        Ok(None) => SemanticClientState::NotConfigured,
        Err(_) => SemanticClientState::Unavailable,
    }
}

async fn lexical_channel(
    input: LexicalChannelRequest,
) -> Result<ChannelResults, RetrievalStageError> {
    let LexicalChannelRequest {
        retriever,
        project_id,
        expected_generation_id,
        query,
        cancellation,
    } = input;
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(RetrievalStageError::RequestCancelled),
        result = retriever.lexical_channel_for_generation(GenerationLexicalRequest::new(
            project_id,
            expected_generation_id,
            query,
        )) => {
            result.map_err(retrieval_stage_error)
        },
    }
}

async fn semantic_channel(
    input: SemanticChannelRequest<'_>,
) -> Result<(SemanticReadiness, Option<ChannelResults>), RetrievalStageError> {
    let SemanticChannelRequest {
        runtime,
        project_id,
        expected_generation_id,
        query,
        limit,
        client,
        cancellation,
    } = input;
    let client = match client {
        SemanticClientState::NotConfigured => {
            return Ok((SemanticReadiness::NotConfigured, None));
        }
        SemanticClientState::Unavailable => {
            return Ok((SemanticReadiness::Unavailable, None));
        }
        SemanticClientState::Ready(client) => client,
    };
    let inputs = [query];
    let batch = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(RetrievalStageError::RequestCancelled),
        result = tokio::time::timeout(SEMANTIC_ENDPOINT_TIMEOUT, client.embed(&inputs)) => match result {
            Ok(Ok(batch)) => batch,
            Err(_) => return Ok((SemanticReadiness::Unavailable, None)),
            Ok(Err(_)) => return Ok((SemanticReadiness::Unavailable, None)),
        },
    };
    let dimension = match u16::try_from(batch.dimension()) {
        Ok(dimension) => dimension,
        Err(_) => return Ok((SemanticReadiness::Unavailable, None)),
    };
    let registration = match model_registration(client.as_ref(), dimension) {
        Ok(registration) => registration,
        Err(_) => return Ok((SemanticReadiness::Unavailable, None)),
    };
    let selector = registration.selector();
    let readiness_request =
        SemanticReadinessRequest::new(project_id.clone(), selector.clone(), SEMANTIC_QUERY_TIMEOUT)
            .map_err(|_| RetrievalStageError::Failed)?;
    let readiness_report = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(RetrievalStageError::RequestCancelled),
        result = runtime.database().semantic_readiness(readiness_request) => match result {
            Ok(report) => report,
            Err(SemanticStorageError::CurrentGenerationChanged) => {
                return Err(RetrievalStageError::GenerationChanged);
            }
            Err(_) => return Ok((SemanticReadiness::Unavailable, None)),
        },
    };
    if readiness_report
        .generation_id()
        .is_some_and(|generation| generation != &expected_generation_id)
        || (readiness_report.generation_id().is_none()
            && readiness_report.state() == SemanticReadinessState::NoCurrentGeneration)
    {
        return Err(RetrievalStageError::GenerationChanged);
    }
    let readiness = semantic_readiness(readiness_report.state());
    if readiness != SemanticReadiness::Ready {
        return Ok((readiness, None));
    }
    let Some(vector) = batch.vectors().first() else {
        return Ok((SemanticReadiness::Unavailable, None));
    };
    let request = VectorSearchRequest::new(VectorSearchInput {
        project_id,
        expected_generation_id,
        model: selector,
        vector: vector.values().to_vec(),
        limit,
        statement_timeout: SEMANTIC_QUERY_TIMEOUT,
    })
    .map_err(|_| RetrievalStageError::Failed)?;
    let hits = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(RetrievalStageError::RequestCancelled),
        result = runtime.database().vector_top_k(request) => match result {
            Ok(hits) => hits,
            Err(SemanticStorageError::NotReady { state }) => {
                return Ok((semantic_readiness(state), None));
            }
            Err(SemanticStorageError::CurrentGenerationChanged) => {
                return Err(RetrievalStageError::GenerationChanged);
            }
            Err(_) => return Ok((SemanticReadiness::Unavailable, None)),
        },
    };
    let channel = semantic_results(&hits).map_err(|_| RetrievalStageError::Failed)?;
    Ok((SemanticReadiness::Ready, Some(channel)))
}

fn model_registration(
    client: &OpenAiEmbeddingClient,
    dimension: u16,
) -> Result<EmbeddingModelRegistration, SemanticStorageError> {
    let identity = client.identity();
    EmbeddingModelRegistration::new(EmbeddingModelRegistrationInput {
        model_id: identity.model_id().clone(),
        fingerprint: identity.fingerprint().clone(),
        provider: MODEL_PROVIDER.to_owned(),
        model_name: identity.model().to_owned(),
        dimension,
        normalization: EmbeddingNormalization::None,
    })
}

fn semantic_results(hits: &[VectorSearchHit]) -> Result<ChannelResults, ProjectError> {
    let candidates = hits
        .iter()
        .enumerate()
        .map(|(index, hit)| semantic_candidate(hit, index))
        .collect::<Result<Vec<_>, _>>()?;
    ChannelResults::new(RetrievalChannel::Semantic, candidates)
        .map_err(|_| ProjectError::RetrievalOperationFailed)
}

fn semantic_candidate(
    hit: &VectorSearchHit,
    index: usize,
) -> Result<ChannelCandidate, ProjectError> {
    let rank = u16::try_from(index.saturating_add(1))
        .map_err(|_| ProjectError::RetrievalOperationFailed)?;
    let path =
        NormalizedPath::parse(hit.path()).map_err(|_| ProjectError::RetrievalOperationFailed)?;
    let language = SourceLanguage::from_stable_str(hit.language())
        .ok_or(ProjectError::RetrievalOperationFailed)?;
    let mut document = RetrievalDocument::new(RetrievalDocumentInput {
        document_id: hit.document_id().clone(),
        generation_id: hit.generation_id().clone(),
        path,
        language,
        document_kind: hit.document_kind(),
    });
    if let Some(file_id) = hit.file_id() {
        document = document.with_file_id(file_id.clone());
    }
    if let Some(symbol_id) = hit.symbol_id() {
        document = document.with_symbol_id(symbol_id.clone());
    }
    let document = document
        .with_qualified_name(hit.qualified_name())
        .map_err(|_| ProjectError::RetrievalOperationFailed)?;
    let similarity = 1.0 - hit.distance();
    ChannelCandidate::new(document, rank, similarity)
        .map_err(|_| ProjectError::RetrievalOperationFailed)
}

fn optional_channel(channel: Option<ChannelResults>) -> Result<RetrievalChannels, ProjectError> {
    match channel {
        Some(channel) => RetrievalChannels::new()
            .with_channel(channel)
            .map_err(|_| ProjectError::RetrievalOperationFailed),
        None => Ok(RetrievalChannels::new()),
    }
}

async fn ensure_generation_current(
    runtime: &ProjectRuntime,
    project_id: &ProjectId,
    expected_generation_id: &GenerationId,
) -> Result<(), RetrievalStageError> {
    let current = runtime
        .database()
        .current_generation_record(project_id)
        .await
        .map_err(storage_stage_error)?;
    if current
        .as_ref()
        .is_some_and(|generation| generation.generation_id() == expected_generation_id)
    {
        Ok(())
    } else {
        Err(RetrievalStageError::GenerationChanged)
    }
}

fn storage_stage_error(error: StorageError) -> RetrievalStageError {
    match error {
        StorageError::CurrentGenerationChanged => RetrievalStageError::GenerationChanged,
        _ => RetrievalStageError::Failed,
    }
}

fn retrieval_stage_error(error: RetrievalError) -> RetrievalStageError {
    match error {
        RetrievalError::Storage(StorageError::CurrentGenerationChanged) => {
            RetrievalStageError::GenerationChanged
        }
        RetrievalError::Semantic(SemanticStorageError::CurrentGenerationChanged) => {
            RetrievalStageError::GenerationChanged
        }
        RetrievalError::InvalidInput { .. }
        | RetrievalError::Storage(_)
        | RetrievalError::Semantic(_) => RetrievalStageError::Failed,
    }
}

fn project_retrieval_error(error: RetrievalStageError) -> ProjectError {
    match error {
        RetrievalStageError::RequestCancelled => ProjectError::RequestCancelled,
        RetrievalStageError::GenerationChanged | RetrievalStageError::Failed => {
            ProjectError::RetrievalOperationFailed
        }
    }
}

const fn semantic_readiness(state: SemanticReadinessState) -> SemanticReadiness {
    match state {
        SemanticReadinessState::Ready => SemanticReadiness::Ready,
        SemanticReadinessState::ModelMissing
        | SemanticReadinessState::NoCurrentGeneration
        | SemanticReadinessState::NoDocuments
        | SemanticReadinessState::CoverageIncomplete
        | SemanticReadinessState::HnswUnavailable => SemanticReadiness::NotIndexed,
        SemanticReadinessState::ModelMismatch | SemanticReadinessState::ModelRetired => {
            SemanticReadiness::Stale
        }
        SemanticReadinessState::QueryProbeFailed => SemanticReadiness::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retrieval_options_default_to_auto_and_reject_unbounded_top_k() {
        assert_eq!(RetrievalOptions::default().mode(), SearchMode::Auto);
        assert_eq!(
            RetrievalOptions::default().candidate_limit(),
            DEFAULT_CANDIDATE_LIMIT
        );
        assert_eq!(
            RetrievalOptions::new(SearchMode::Hybrid, 0),
            Err(ProjectError::InvalidOptions)
        );
        assert_eq!(
            RetrievalOptions::new(
                SearchMode::Hybrid,
                MAXIMUM_CANDIDATE_LIMIT.saturating_add(1)
            ),
            Err(ProjectError::InvalidOptions)
        );
    }

    #[test]
    fn database_readiness_maps_to_explicit_agent_policy_states() {
        assert_eq!(
            semantic_readiness(SemanticReadinessState::Ready),
            SemanticReadiness::Ready
        );
        for state in [
            SemanticReadinessState::ModelMissing,
            SemanticReadinessState::NoCurrentGeneration,
            SemanticReadinessState::NoDocuments,
            SemanticReadinessState::CoverageIncomplete,
            SemanticReadinessState::HnswUnavailable,
        ] {
            assert_eq!(semantic_readiness(state), SemanticReadiness::NotIndexed);
        }
        for state in [
            SemanticReadinessState::ModelMismatch,
            SemanticReadinessState::ModelRetired,
        ] {
            assert_eq!(semantic_readiness(state), SemanticReadiness::Stale);
        }
        assert_eq!(
            semantic_readiness(SemanticReadinessState::QueryProbeFailed),
            SemanticReadiness::Unavailable
        );
    }
}
