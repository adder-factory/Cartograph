//! Bounded, secret-safe OpenAI-compatible embedding client for Cartograph v2.

mod chat;
mod client;
mod config;
mod model;
mod models;
mod project_config;
mod rerank;

pub use chat::{
    CHAT_API_KEY_ENV, CHAT_ENDPOINT_ENV, CHAT_MODEL_ENV, ChatCompletion, ChatError, ChatSettings,
    OpenAiChatClient,
};
pub use client::OpenAiEmbeddingClient;
pub use config::{
    EMBEDDING_API_KEY_ENV, EMBEDDING_ENDPOINT_ENV, EMBEDDING_MODEL_ENV, EmbeddingSettings,
};
pub use model::{EmbeddingBatch, EmbeddingError, EmbeddingModelIdentity, EmbeddingVector};
pub use models::{
    InstallModelsError, InstallModelsOptions, InstallModelsReport, InstalledModel,
    install_recommended_models,
};
pub use project_config::{
    LlmEndpointProbe, ProjectLlmConfigError, ProjectLlmCredentialSource, ProjectLlmProvider,
    ProjectLlmTier, ProjectLlmTierConfig, ProjectLlmTierInput, ProjectSourceSettings,
    ProjectSummaryEagerLimit, ProjectSummarySettings, load_exact_project_llm_tier,
    load_project_llm_tier, load_project_max_file_size, load_project_source_settings,
    load_project_summary_settings, probe_openai_compatible_endpoint, tune_project_llm_tier,
    write_project_llm_configuration, write_project_llm_tiers, write_project_max_file_size,
};
pub use rerank::{OpenAiRerankClient, RerankBatch, RerankError, RerankSettings};
