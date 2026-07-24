use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use cartograph_db::{
    CartographDatabase, GenerationContents, LeaseFence, PrepareGenerationError,
    PrepareGenerationMutation, ReadyGeneration,
};
use thiserror::Error;
use tokio::{
    sync::oneshot,
    task::JoinHandle,
    time::{Instant, timeout_at},
};

/// A supervised prepare/COPY operation failed before returning a ready token.
#[derive(Debug, Error)]
pub enum SupervisedPrepareError {
    /// The one allowed prepare operation already started.
    #[error("Cartograph generation prepare already started for this supervised operation")]
    AlreadyStarted,
    /// The supervisor closed mutation admission before this call.
    #[error("Cartograph generation prepare scope is closed")]
    ScopeClosed,
    /// The retained database task ended without delivering its typed result.
    #[error("Cartograph generation prepare task ended without a result")]
    ResultUnavailable,
    /// PostgreSQL rejected validation, COPY, fencing, or the ready transition.
    #[error(transparent)]
    Database(#[from] PrepareGenerationError),
}

#[derive(Clone)]
pub(crate) struct PrepareScope {
    database: CartographDatabase,
    fence: LeaseFence,
    statement_timeout: Duration,
    registry: Arc<Mutex<PrepareRegistry>>,
}

struct PrepareRegistry {
    state: PrepareState,
    handle: Option<JoinHandle<()>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PrepareState {
    Open,
    Running,
    Closed,
}

pub(crate) struct PrepareReap {
    pub(crate) all_joined: bool,
}

impl PrepareScope {
    pub(crate) fn new(
        database: CartographDatabase,
        fence: LeaseFence,
        statement_timeout: Duration,
    ) -> Self {
        Self {
            database,
            fence,
            statement_timeout,
            registry: Arc::new(Mutex::new(PrepareRegistry {
                state: PrepareState::Open,
                handle: None,
            })),
        }
    }

    pub(crate) async fn prepare(
        &self,
        contents: GenerationContents,
    ) -> Result<ReadyGeneration, SupervisedPrepareError> {
        let receiver = self.start(contents)?;
        match receiver.await {
            Ok(Ok(ready)) => Ok(ready),
            Ok(Err(error)) => Err(SupervisedPrepareError::Database(error)),
            Err(_) => Err(SupervisedPrepareError::ResultUnavailable),
        }
    }

    fn start(
        &self,
        contents: GenerationContents,
    ) -> Result<
        oneshot::Receiver<Result<ReadyGeneration, PrepareGenerationError>>,
        SupervisedPrepareError,
    > {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| SupervisedPrepareError::ResultUnavailable)?;
        match registry.state {
            PrepareState::Open => {}
            PrepareState::Running => return Err(SupervisedPrepareError::AlreadyStarted),
            PrepareState::Closed => return Err(SupervisedPrepareError::ScopeClosed),
        }
        let database = self.database.clone();
        let fence = self.fence.clone();
        let statement_timeout = self.statement_timeout;
        let (sender, receiver) = oneshot::channel();
        registry.handle = Some(tokio::spawn(async move {
            let result = database
                .prepare_generation_bounded(
                    contents,
                    PrepareGenerationMutation::new(&fence, statement_timeout),
                )
                .await;
            let _ = sender.send(result);
        }));
        registry.state = PrepareState::Running;
        Ok(receiver)
    }

    pub(crate) async fn close_and_reap(
        &self,
        reap_deadline: Instant,
        hard_deadline: Instant,
    ) -> PrepareReap {
        let handle = match self.close_and_take() {
            Ok(handle) => handle,
            Err(()) => {
                return PrepareReap { all_joined: false };
            }
        };
        let Some(mut handle) = handle else {
            return PrepareReap { all_joined: true };
        };
        if let Ok(joined) = timeout_at(reap_deadline, &mut handle).await {
            return PrepareReap {
                all_joined: joined.is_ok(),
            };
        }
        if let Ok(joined) = timeout_at(hard_deadline, &mut handle).await {
            return PrepareReap {
                all_joined: joined.is_ok(),
            };
        }
        handle.abort();
        let _ = handle.await;
        PrepareReap { all_joined: false }
    }

    fn close_and_take(&self) -> Result<Option<JoinHandle<()>>, ()> {
        let mut registry = self.registry.lock().map_err(|_| ())?;
        let started = registry.state == PrepareState::Running;
        registry.state = PrepareState::Closed;
        if started {
            Ok(registry.handle.take())
        } else {
            Ok(None)
        }
    }
}
