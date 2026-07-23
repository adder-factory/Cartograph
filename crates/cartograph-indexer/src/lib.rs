//! Lease-owned, bounded indexing supervision for Cartograph v2.

mod config;
mod native_extraction;
mod prepare_scope;
mod progress;
mod stage;
mod supervisor;
mod task_scope;

pub use config::{InvalidSupervisorConfig, SupervisorConfig};
pub use native_extraction::{
    NativeExtractionConfigError, NativeExtractionObserver, NativeExtractionObserverError,
    NativeExtractionReport, NativeExtractionRequest, NativeExtractionResult,
    NativeExtractionStageConfig, NativeExtractionStageError, run_native_extraction_stage,
};
pub use prepare_scope::SupervisedPrepareError;
pub use progress::{
    CancellationReason, CancellationSignal, PipelineStage, ProgressError, ProgressReporter,
    SupervisorContext, SupervisorState, SupervisorStatus,
};
pub use stage::{
    StageCancellation, StageCapacity, StageDeadlinePolicy, StageEnvelope, StageExecution,
    StageFailureKind, StageFold, StageItemBudget, StageItemFailure, StageItemMeta, StageMetrics,
    StageMetricsError, StageMetricsSnapshot, StageOutput, StageRunConfig, StageRunError,
    StageRunner, StageSequence, StageWorkItem, StageWorkload,
};
pub use supervisor::{IndexerSupervisor, PipelineFailure, SupervisorError, SupervisorRequest};
pub use task_scope::{ScopedTask, ScopedTaskError};
