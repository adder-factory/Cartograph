//! Lease-owned, bounded indexing supervision for Cartograph v2.

mod config;
mod prepare_scope;
mod progress;
mod supervisor;
mod task_scope;

pub use config::{InvalidSupervisorConfig, SupervisorConfig};
pub use prepare_scope::SupervisedPrepareError;
pub use progress::{
    CancellationReason, CancellationSignal, PipelineStage, ProgressError, ProgressReporter,
    SupervisorContext, SupervisorState, SupervisorStatus,
};
pub use supervisor::{IndexerSupervisor, PipelineFailure, SupervisorError, SupervisorRequest};
pub use task_scope::{ScopedTask, ScopedTaskError};
