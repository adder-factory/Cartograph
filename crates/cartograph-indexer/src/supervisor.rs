use std::{
    future::Future,
    ops::Deref,
    sync::{Arc, Mutex},
    time::Duration,
};

use cartograph_db::{
    CartographDatabase, CurrentGeneration, LeaseAcquisitionAttempt, LeaseAcquisitionProbe,
    LeaseError, LeaseFence, LeaseOwner, LeaseRequest, LeaseTarget, ObservedGeneration,
    ObservedLease, OperationReconciliation, ProjectLease, ReadyGeneration, StorageError,
    TerminalGenerationMutation,
};
use cartograph_domain::{ContentDigest, GenerationId, ProjectId};
use thiserror::Error;
use tokio::{
    sync::watch,
    time::{Instant, MissedTickBehavior, interval_at, sleep_until, timeout_at},
};

use crate::{
    CancellationReason, InvalidSupervisorConfig, PipelineStage, ProgressError, SupervisorConfig,
    SupervisorContext, SupervisorStatus,
    prepare_scope::{PrepareReap, PrepareScope},
    progress::{SharedProgress, SupervisorContextParts},
    task_scope::{ReapReport, TaskScope},
};

/// Lease acquisition boundary for one supervised project operation.
#[derive(Clone, Debug)]
pub struct SupervisorRequest {
    target: LeaseTarget,
    owner: LeaseOwner,
    lease_duration: Duration,
}

impl SupervisorRequest {
    /// Bind a project/generation operation to an observable process owner.
    #[must_use]
    pub const fn new(target: LeaseTarget, owner: LeaseOwner, lease_duration: Duration) -> Self {
        Self {
            target,
            owner,
            lease_duration,
        }
    }
}

/// Credential-safe failure returned by a supervised pipeline future.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[error("Cartograph indexing failed during the {stage:?} stage")]
pub struct PipelineFailure {
    stage: PipelineStage,
}

impl PipelineFailure {
    /// Identify the stable stage without accepting arbitrary error text.
    #[must_use]
    pub const fn new(stage: PipelineStage) -> Self {
        Self { stage }
    }

    /// Stable failed stage recorded by the supervisor and structured workers.
    #[must_use]
    pub const fn stage(self) -> PipelineStage {
        self.stage
    }
}

/// One-shot supervisor bound to a PostgreSQL data plane and deadline policy.
#[derive(Clone)]
pub struct IndexerSupervisor {
    database: CartographDatabase,
    config: SupervisorConfig,
    progress: SharedProgress,
    cancellation: watch::Sender<bool>,
    lifecycle: Arc<Mutex<LifecycleGate>>,
}

struct RunCoordinator<'a> {
    supervisor: &'a IndexerSupervisor,
}

impl Deref for RunCoordinator<'_> {
    type Target = IndexerSupervisor;

    fn deref(&self) -> &Self::Target {
        self.supervisor
    }
}

struct DurableCoordinator<'a> {
    supervisor: &'a IndexerSupervisor,
}

impl Deref for DurableCoordinator<'_> {
    type Target = IndexerSupervisor;

    fn deref(&self) -> &Self::Target {
        self.supervisor
    }
}

impl IndexerSupervisor {
    /// Create a queued one-shot supervisor. Configuration is validated before acquisition.
    #[must_use]
    pub fn new(database: CartographDatabase, config: SupervisorConfig) -> Self {
        let (cancellation, _) = watch::channel(false);
        Self {
            database,
            config,
            progress: SharedProgress::new(),
            cancellation,
            lifecycle: Arc::new(Mutex::new(LifecycleGate::new())),
        }
    }

    /// Return a point-in-time observable status packet.
    pub async fn status(&self) -> SupervisorStatus {
        self.progress.status().await
    }

    /// Request cancellation exactly until durable publication finalization starts.
    ///
    /// A `true` result is linearized against the publication gate and guarantees
    /// that this run will not subsequently start publication.
    pub fn cancel(&self) -> bool {
        let accepted = self
            .lifecycle
            .lock()
            .map(|mut lifecycle| lifecycle.request_external_cancellation())
            .unwrap_or(false);
        if accepted {
            self.cancellation.send_replace(true);
        }
        accepted
    }

    /// Acquire the lease, monitor work, enforce deadlines, and clean up exactly once.
    pub async fn run<Work, WorkFuture>(
        &self,
        request: SupervisorRequest,
        work: Work,
    ) -> Result<CurrentGeneration, SupervisorError>
    where
        Work: FnOnce(SupervisorContext) -> WorkFuture + Send + 'static,
        WorkFuture: Future<Output = Result<ReadyGeneration, PipelineFailure>> + Send + 'static,
    {
        let runtime = tokio::runtime::Handle::current();
        let runner = self.clone();
        let run = runtime.spawn(async move {
            RunCoordinator {
                supervisor: &runner,
            }
            .run_inner(request, work)
            .await
        });
        SupervisorRunGuard::new(self.clone(), runtime, run)
            .join()
            .await
    }
}

impl RunCoordinator<'_> {
    async fn run_inner<Work, WorkFuture>(
        &self,
        request: SupervisorRequest,
        work: Work,
    ) -> Result<CurrentGeneration, SupervisorError>
    where
        Work: FnOnce(SupervisorContext) -> WorkFuture,
        WorkFuture: Future<Output = Result<ReadyGeneration, PipelineFailure>>,
    {
        self.config.validate_for(request.lease_duration)?;
        if request.target.generation_id().is_none() {
            return Err(SupervisorError::MissingGeneration);
        }
        if !self.progress.reserve().await {
            return Err(SupervisorError::AlreadyStarted);
        }
        self.start_lifecycle()?;
        let budget = OperationBudget::new(self.config);
        let receiver = self.cancellation.subscribe();
        let _lifecycle = LifecycleFinishGuard::new(self);
        self.run_started(StartedRun {
            request,
            work,
            receiver,
            budget,
        })
        .await
    }

    async fn run_started<Work, WorkFuture>(
        &self,
        started: StartedRun<Work>,
    ) -> Result<CurrentGeneration, SupervisorError>
    where
        Work: FnOnce(SupervisorContext) -> WorkFuture,
        WorkFuture: Future<Output = Result<ReadyGeneration, PipelineFailure>>,
    {
        let StartedRun {
            request,
            work,
            mut receiver,
            budget,
        } = started;
        if *receiver.borrow_and_update() {
            self.select_cancellation(CancellationReason::Requested)?;
            self.progress
                .mark_cancelled(CancellationReason::Requested, false)
                .await;
            return Err(cancelled(CancellationReason::Requested, false));
        }
        let (attempt, probe) =
            match CartographDatabase::prepare_lease_acquisition(LeaseRequest::new(
                request.target.clone(),
                request.owner,
                request.lease_duration,
            )) {
                Ok(capabilities) => capabilities,
                Err(source) => {
                    self.begin_finishing()?;
                    self.progress.mark_failed().await;
                    return Err(SupervisorError::Lease {
                        operation: "prepare-acquire",
                        source,
                    });
                }
            };
        let lease = match self
            .durable()
            .acquire_exact(
                attempt,
                AcquisitionContext {
                    probe,
                    budget,
                    receiver: &mut receiver,
                },
            )
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                return self.finish_acquisition_failure(error, &mut receiver).await;
            }
        };
        self.progress.mark_active().await;
        let fence = lease.fence();
        let operation = OwnedOperation {
            target: request.target,
            lease: Some(lease),
            fence: fence.clone(),
            budget,
        };
        self.run_owned(OwnedRun {
            operation,
            work,
            receiver,
        })
        .await
    }

    async fn finish_acquisition_failure(
        &self,
        error: SupervisorError,
        receiver: &mut watch::Receiver<bool>,
    ) -> Result<CurrentGeneration, SupervisorError> {
        if *receiver.borrow_and_update()
            && !matches!(
                &error,
                SupervisorError::AmbiguousOutcome { .. }
                    | SupervisorError::OperationBudgetExhausted
            )
        {
            self.select_cancellation(CancellationReason::Requested)?;
            self.progress
                .mark_cancelled(CancellationReason::Requested, false)
                .await;
            return Err(cancelled(CancellationReason::Requested, false));
        }
        self.begin_finishing()?;
        self.progress.mark_failed().await;
        Err(error)
    }

    async fn run_owned<Work, WorkFuture>(
        &self,
        owned: OwnedRun<Work>,
    ) -> Result<CurrentGeneration, SupervisorError>
    where
        Work: FnOnce(SupervisorContext) -> WorkFuture,
        WorkFuture: Future<Output = Result<ReadyGeneration, PipelineFailure>>,
    {
        let OwnedRun {
            mut operation,
            work,
            mut receiver,
        } = owned;
        if *receiver.borrow_and_update() {
            return self
                .cancel_before_work(&mut operation, CancellationReason::Requested)
                .await;
        }
        if Instant::now() >= operation.budget.work_deadline {
            return self
                .cancel_before_work(&mut operation, CancellationReason::OperationDeadline)
                .await;
        }

        let tasks = TaskScope::new(self.config.workers.tasks, self.config.workers.bytes);
        let prepares = PrepareScope::new(
            self.database.clone(),
            operation.fence.clone(),
            self.config.deadlines.copy_timeout(),
        );
        let context = SupervisorContext::new(SupervisorContextParts {
            shared: self.progress.clone(),
            receiver: receiver.clone(),
            tasks: tasks.clone(),
            prepares: prepares.clone(),
        });
        let lease = match operation.lease.take() {
            Some(lease) => lease,
            None => {
                self.progress.mark_failed().await;
                return Err(SupervisorError::LifecycleUnavailable);
            }
        };
        let outcome = WorkMonitor {
            database: self.database.clone(),
            config: self.config,
            budget: operation.budget,
            progress: self.progress.clone(),
            cancellation: &self.cancellation,
            receiver,
            lifecycle: &self.lifecycle,
            lease: Some(lease),
        }
        .run(work(context))
        .await;
        let (outcome, lease) = outcome;
        operation.lease = lease;
        let reap_deadline = operation.budget.request_deadline(
            match &outcome {
                MonitorOutcome::Cancelled(CancelledWork {
                    reason: CancellationReason::LeaseLost
                        | CancellationReason::LeaseHeartbeatFailed,
                    ..
                }) => self.config.deadlines.heartbeat_request,
                _ => self.config.deadlines.cancellation_grace,
            },
            operation.budget.final_deadline
                - self.config.deadlines.database_finish_reserve(),
        );
        let reap = tasks.close_abort_and_reap(reap_deadline).await;
        let prepare = prepares
            .close_and_reap(
                operation.budget.prepare_reap_deadline(self.config),
                operation.budget.final_deadline,
            )
            .await;
        self.finish(
            &mut operation,
            MonitoredWork {
                outcome,
                reap,
                prepare,
            },
        )
        .await
    }

    async fn cancel_before_work(
        &self,
        operation: &mut OwnedOperation,
        reason: CancellationReason,
    ) -> Result<CurrentGeneration, SupervisorError> {
        let selected = self.select_cancellation(reason)?;
        self.progress.mark_cancelling(selected).await;
        self.cancellation.send_replace(true);
        self.finish_cancelled(
            operation,
            CancelledWork {
                reason: selected,
                grace_exceeded: false,
            },
        )
        .await
    }

    async fn finish(
        &self,
        operation: &mut OwnedOperation,
        monitored: MonitoredWork,
    ) -> Result<CurrentGeneration, SupervisorError> {
        let MonitoredWork {
            outcome,
            reap,
            prepare,
        } = monitored;
        if !prepare.all_joined {
            self.progress.mark_failed().await;
            return Err(SupervisorError::UnreapedDurableOperation {
                operation: "prepare-generation",
            });
        }
        if !reap.all_joined {
            self.progress.mark_failed().await;
            return Err(SupervisorError::UnreapedWorkers);
        }
        if reap.worker_failed {
            return self
                .fail_owned(operation, SupervisorError::WorkerFailed)
                .await;
        }
        if reap.unobserved_results {
            return self
                .fail_owned(operation, SupervisorError::UnobservedWorkers)
                .await;
        }
        match outcome {
            MonitorOutcome::Ready(ready) if reap.active_tasks == 0 => {
                self.finish_ready(operation, ready).await
            }
            MonitorOutcome::Ready(_) => {
                self.fail_owned(operation, SupervisorError::UnjoinedWorkers)
                    .await
            }
            MonitorOutcome::Failed(failure) => {
                self.fail_owned(
                    operation,
                    SupervisorError::Pipeline {
                        stage: failure.stage,
                    },
                )
                .await
            }
            MonitorOutcome::Cancelled(cancellation) => {
                self.finish_cancelled(operation, cancellation).await
            }
            MonitorOutcome::SupervisorFailed(error) => self.fail_owned(operation, error).await,
        }
    }

    async fn finish_ready(
        &self,
        operation: &mut OwnedOperation,
        ready: ReadyGeneration,
    ) -> Result<CurrentGeneration, SupervisorError> {
        if ready.project_id() != operation.target.project_id()
            || Some(ready.generation_id()) != operation.target.generation_id()
        {
            return self
                .fail_owned(operation, SupervisorError::GenerationMismatch)
                .await;
        }
        if let Err(error) = self
            .durable()
            .heartbeat_owned(operation, "publish-heartbeat")
            .await
        {
            return self.finish_authority_error(operation, error).await;
        }
        if let Err(source) = self.progress.begin_stage(PipelineStage::Publish).await {
            return self
                .fail_owned(operation, SupervisorError::Progress { source })
                .await;
        }
        match self.durable().publish_reconciled(ready, operation).await {
            Ok(current) => {
                self.progress.mark_completed().await;
                Ok(current)
            }
            Err(error) => self.finish_authority_error(operation, error).await,
        }
    }

    async fn finish_authority_error(
        &self,
        operation: &mut OwnedOperation,
        error: SupervisorError,
    ) -> Result<CurrentGeneration, SupervisorError> {
        if error.forbids_cleanup() {
            self.progress.mark_failed().await;
            Err(error)
        } else {
            self.fail_owned(operation, error).await
        }
    }

    async fn finish_cancelled(
        &self,
        operation: &mut OwnedOperation,
        cancellation: CancelledWork,
    ) -> Result<CurrentGeneration, SupervisorError> {
        if !cancellation.reason.is_authority_uncertain()
            && let Err(error) = self.durable().cleanup_owned_failure(operation).await
        {
            self.progress.mark_failed().await;
            return Err(error);
        }
        self.progress
            .mark_cancelled(cancellation.reason, cancellation.grace_exceeded)
            .await;
        Err(cancelled(cancellation.reason, cancellation.grace_exceeded))
    }

    async fn fail_owned<T>(
        &self,
        operation: &mut OwnedOperation,
        error: SupervisorError,
    ) -> Result<T, SupervisorError> {
        if error.forbids_cleanup() {
            self.progress.mark_failed().await;
            return Err(error);
        }
        let cleanup = self.durable().cleanup_owned_failure(operation).await;
        self.progress.mark_failed().await;
        match cleanup {
            Ok(()) => Err(error),
            Err(cleanup) => Err(cleanup),
        }
    }

    const fn durable(&self) -> DurableCoordinator<'_> {
        DurableCoordinator {
            supervisor: self.supervisor,
        }
    }
}

impl DurableCoordinator<'_> {
    async fn publish_reconciled(
        &self,
        ready: ReadyGeneration,
        operation: &OwnedOperation,
    ) -> Result<CurrentGeneration, SupervisorError> {
        let expected = ExpectedGeneration::from_ready(&ready);
        let mut retries = 0_u8;
        let mut publication = self.spawn_publication(ready, operation.fence.clone());
        loop {
            let deadline = match operation
                .budget
                .database_deadline(self.config, operation.budget.durable_ceiling(self.config))
            {
                Ok(deadline) => deadline,
                Err(_) => {
                    self.finish_and_reap_durable(
                        publication,
                        DurableReap::new(operation.budget, "publish-generation"),
                    )
                    .await?;
                    return Err(ambiguous("publish-generation"));
                }
            };
            let pending = match classify_publication_poll(
                timeout_at(deadline, &mut publication).await,
                retries == 0,
            )? {
                PublicationPoll::Complete(current) => return Ok(current),
                PublicationPoll::Reconcile(pending) => pending,
            };
            let evidence = PublicationEvidence {
                reconciliation: match self.reconcile(operation, "publish-generation").await {
                    Ok(reconciliation) => reconciliation,
                    Err(error) => {
                        self.reap_if_active(
                            PendingDurable::new(publication, pending.task_active),
                            DurableReap::new(operation.budget, "publish-generation"),
                        )
                        .await?;
                        return Err(error);
                    }
                },
                retry: pending.retry,
                retry_allowed: pending.retry_allowed,
            };
            match decide_publication(&expected, evidence) {
                PublicationDecision::Complete(current) => {
                    self.reap_if_active(
                        PendingDurable::new(publication, pending.task_active),
                        DurableReap::new(operation.budget, "publish-generation"),
                    )
                    .await?;
                    return Ok(current);
                }
                PublicationDecision::Wait => continue,
                PublicationDecision::Retry(recovered) => {
                    self.reap_if_active(
                        PendingDurable::new(publication, pending.task_active),
                        DurableReap::new(operation.budget, "publish-generation"),
                    )
                    .await?;
                    retries = retries.saturating_add(1);
                    publication = self.spawn_publication(recovered, operation.fence.clone());
                }
                PublicationDecision::Fail(error) => {
                    self.reap_if_active(
                        PendingDurable::new(publication, pending.task_active),
                        DurableReap::new(operation.budget, "publish-generation"),
                    )
                    .await?;
                    return Err(error);
                }
            }
        }
    }

    fn spawn_publication(
        &self,
        ready: ReadyGeneration,
        fence: LeaseFence,
    ) -> tokio::task::JoinHandle<Result<CurrentGeneration, cartograph_db::PublishGenerationError>>
    {
        let database = self.database.clone();
        let statement_timeout = self.config.deadlines.statement_timeout();
        tokio::spawn(async move {
            database
                .publish_generation_bounded(
                    ready,
                    TerminalGenerationMutation::new(&fence, statement_timeout),
                )
                .await
        })
    }

    async fn cleanup_owned_failure(
        &self,
        operation: &mut OwnedOperation,
    ) -> Result<(), SupervisorError> {
        self.heartbeat_owned(operation, "cleanup-heartbeat").await?;
        let budget = operation.budget;
        let mut retries = 0_u8;
        let mut cleanup = self.spawn_cleanup(operation.fence.clone());
        loop {
            let deadline =
                match budget.database_deadline(self.config, budget.durable_ceiling(self.config)) {
                    Ok(deadline) => deadline,
                    Err(_) => {
                        self.finish_and_reap_durable(
                            cleanup,
                            DurableReap::new(operation.budget, "cleanup-generation"),
                        )
                        .await?;
                        return Err(ambiguous("cleanup-generation"));
                    }
                };
            let pending = match classify_cleanup_poll(
                timeout_at(deadline, &mut cleanup).await,
                retries == 0,
            )? {
                CleanupPoll::Complete => return Ok(()),
                CleanupPoll::Reconcile(pending) => pending,
            };
            let evidence = CleanupEvidence {
                reconciliation: match self.reconcile(operation, "cleanup-generation").await {
                    Ok(reconciliation) => reconciliation,
                    Err(error) => {
                        self.reap_if_active(
                            PendingDurable::new(cleanup, pending.task_active),
                            DurableReap::new(operation.budget, "cleanup-generation"),
                        )
                        .await?;
                        return Err(error);
                    }
                },
                retry_allowed: pending.retry_allowed,
                task_active: pending.task_active,
            };
            match decide_cleanup(evidence) {
                CleanupDecision::Complete => {
                    self.reap_if_active(
                        PendingDurable::new(cleanup, pending.task_active),
                        DurableReap::new(operation.budget, "cleanup-generation"),
                    )
                    .await?;
                    return Ok(());
                }
                CleanupDecision::Wait => continue,
                CleanupDecision::Retry => {
                    self.reap_if_active(
                        PendingDurable::new(cleanup, pending.task_active),
                        DurableReap::new(operation.budget, "cleanup-generation"),
                    )
                    .await?;
                    retries = retries.saturating_add(1);
                    cleanup = self.spawn_cleanup(operation.fence.clone());
                }
                CleanupDecision::Fail(error) => {
                    self.reap_if_active(
                        PendingDurable::new(cleanup, pending.task_active),
                        DurableReap::new(operation.budget, "cleanup-generation"),
                    )
                    .await?;
                    return Err(error);
                }
            }
        }
    }

    fn spawn_cleanup(
        &self,
        fence: LeaseFence,
    ) -> tokio::task::JoinHandle<Result<(), StorageError>> {
        let database = self.database.clone();
        let statement_timeout = self.config.deadlines.statement_timeout();
        tokio::spawn(async move {
            database
                .fail_generation_and_release_bounded(TerminalGenerationMutation::new(
                    &fence,
                    statement_timeout,
                ))
                .await
        })
    }

    async fn finish_and_reap_durable<T>(
        &self,
        mut handle: tokio::task::JoinHandle<T>,
        context: DurableReap,
    ) -> Result<(), SupervisorError> {
        let deadline = context.budget.request_deadline(
            self.config.deadlines.heartbeat_request,
            context.budget.final_deadline,
        );
        if Instant::now() >= deadline {
            handle.abort();
            let _ = handle.await;
            return Err(SupervisorError::UnreapedDurableOperation {
                operation: context.operation,
            });
        }
        match timeout_at(deadline, &mut handle).await {
            Ok(_) => Ok(()),
            Err(_) => {
                handle.abort();
                let _ = handle.await;
                Err(SupervisorError::UnreapedDurableOperation {
                    operation: context.operation,
                })
            }
        }
    }

    async fn reap_if_active<T>(
        &self,
        pending: PendingDurable<T>,
        context: DurableReap,
    ) -> Result<(), SupervisorError> {
        if pending.active {
            self.finish_and_reap_durable(pending.handle, context).await
        } else {
            Ok(())
        }
    }

    async fn heartbeat_owned(
        &self,
        owned: &mut OwnedOperation,
        operation: &'static str,
    ) -> Result<(), SupervisorError> {
        let budget = owned.budget;
        let Some(lease) = owned.lease.take() else {
            let reconciliation = self.reconcile(owned, operation).await?;
            return if reconciliation.lease() == ObservedLease::Owned {
                Err(SupervisorError::AmbiguousOutcome { operation })
            } else {
                Err(SupervisorError::OwnershipLost { operation })
            };
        };
        let attempt = run_bounded_heartbeat(HeartbeatRequest {
            database: self.database.clone(),
            config: self.config,
            budget,
            ceiling: budget.durable_ceiling(self.config),
            operation,
            lease,
        })
        .await?;
        let late = attempt.late;
        let result = attempt.result;
        owned.lease = Some(attempt.lease);
        match (late, result) {
            (false, Ok(())) => {
                self.progress.mark_heartbeat().await;
                Ok(())
            }
            (_, Err(LeaseError::Lost)) => Err(SupervisorError::OwnershipLost { operation }),
            (true, _) | (_, Err(LeaseError::DatabaseOperation { .. })) => {
                let reconciliation = self.reconcile(owned, operation).await?;
                if reconciliation.lease() == ObservedLease::Owned {
                    Ok(())
                } else {
                    Err(SupervisorError::OwnershipLost { operation })
                }
            }
            (_, Err(source)) => Err(SupervisorError::Lease { operation, source }),
        }
    }

    async fn reconcile(
        &self,
        owned: &OwnedOperation,
        operation: &'static str,
    ) -> Result<OperationReconciliation, SupervisorError> {
        let budget = owned.budget;
        let deadline =
            budget.database_deadline(self.config, budget.durable_ceiling(self.config))?;
        let database = self.database.clone();
        let fence = owned.fence.clone();
        let statement_timeout = self.config.deadlines.statement_timeout();
        let mut reconciliation = tokio::spawn(async move {
            database
                .reconcile_operation_bounded(&fence, statement_timeout)
                .await
        });
        match timeout_at(deadline, &mut reconciliation).await {
            Ok(Ok(Ok(reconciliation))) => Ok(reconciliation),
            Ok(_) => Err(SupervisorError::AmbiguousOutcome { operation }),
            Err(_) => {
                self.finish_and_reap_durable(reconciliation, DurableReap::new(budget, operation))
                    .await?;
                Err(SupervisorError::AmbiguousOutcome { operation })
            }
        }
    }

    async fn acquire_exact(
        &self,
        attempt: LeaseAcquisitionAttempt,
        context: AcquisitionContext<'_>,
    ) -> Result<ProjectLease, SupervisorError> {
        let mut acquisition = self.spawn_acquisition(attempt);
        loop {
            let deadline = match context
                .budget
                .database_deadline(self.config, context.budget.work_deadline)
            {
                Ok(deadline) => deadline,
                Err(_) => {
                    self.finish_and_reap_durable(
                        acquisition,
                        DurableReap::new(context.budget, "acquire"),
                    )
                    .await?;
                    return self
                        .resolve_acquisition(&context, ambiguous("acquire"))
                        .await;
                }
            };
            let polled = tokio::select! {
                biased;
                changed = context.receiver.changed() => {
                    if changed.is_err() || *context.receiver.borrow_and_update() {
                        self.finish_and_reap_durable(
                            acquisition,
                            DurableReap::new(context.budget, "acquire"),
                        )
                        .await?;
                        return match self.reconcile_acquisition(&context).await? {
                            Some(lease) => Ok(lease),
                            None => Err(cancelled(CancellationReason::Requested, false)),
                        };
                    }
                    continue;
                },
                result = timeout_at(deadline, &mut acquisition) => result,
            };
            match polled {
                Ok(Ok(Ok(lease))) => return Ok(lease),
                Ok(Ok(Err(source))) if !matches!(source, LeaseError::DatabaseOperation { .. }) => {
                    return Err(SupervisorError::Lease {
                        operation: "acquire",
                        source,
                    });
                }
                Ok(Ok(Err(source))) => {
                    return self
                        .resolve_acquisition(
                            &context,
                            SupervisorError::Lease {
                                operation: "acquire",
                                source,
                            },
                        )
                        .await;
                }
                Ok(Err(_)) => {
                    return self
                        .resolve_acquisition(&context, ambiguous("acquire"))
                        .await;
                }
                Err(_) => match self.reconcile_acquisition(&context).await {
                    Ok(Some(lease)) => {
                        self.finish_and_reap_durable(
                            acquisition,
                            DurableReap::new(context.budget, "acquire"),
                        )
                        .await?;
                        return Ok(lease);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        self.finish_and_reap_durable(
                            acquisition,
                            DurableReap::new(context.budget, "acquire"),
                        )
                        .await?;
                        return Err(error);
                    }
                },
            }
        }
    }

    async fn resolve_acquisition(
        &self,
        context: &AcquisitionContext<'_>,
        fallback: SupervisorError,
    ) -> Result<ProjectLease, SupervisorError> {
        match self.reconcile_acquisition(context).await? {
            Some(lease) => Ok(lease),
            None => Err(fallback),
        }
    }

    fn spawn_acquisition(
        &self,
        attempt: LeaseAcquisitionAttempt,
    ) -> tokio::task::JoinHandle<Result<ProjectLease, LeaseError>> {
        let database = self.database.clone();
        let statement_timeout = self.config.deadlines.statement_timeout();
        tokio::spawn(async move {
            database
                .acquire_reconcilable_lease_bounded(attempt, statement_timeout)
                .await
        })
    }

    async fn reconcile_acquisition(
        &self,
        context: &AcquisitionContext<'_>,
    ) -> Result<Option<ProjectLease>, SupervisorError> {
        let deadline = context
            .budget
            .database_deadline(self.config, context.budget.final_deadline)?;
        let database = self.database.clone();
        let probe = context.probe.clone();
        let statement_timeout = self.config.deadlines.statement_timeout();
        let mut reconciliation = tokio::spawn(async move {
            database
                .reconcile_acquisition_bounded(&probe, statement_timeout)
                .await
        });
        match timeout_at(deadline, &mut reconciliation).await {
            Ok(Ok(Ok(lease))) => Ok(lease),
            Ok(_) => Err(ambiguous("acquire")),
            Err(_) => {
                self.finish_and_reap_durable(
                    reconciliation,
                    DurableReap::new(context.budget, "reconcile-acquire"),
                )
                .await?;
                Err(ambiguous("acquire"))
            }
        }
    }
}

impl IndexerSupervisor {
    fn start_lifecycle(&self) -> Result<(), SupervisorError> {
        self.lifecycle
            .lock()
            .map_err(|_| SupervisorError::LifecycleUnavailable)?
            .start()
    }

    fn select_cancellation(
        &self,
        reason: CancellationReason,
    ) -> Result<CancellationReason, SupervisorError> {
        self.lifecycle
            .lock()
            .map_err(|_| SupervisorError::LifecycleUnavailable)
            .map(|mut lifecycle| lifecycle.select_cancellation(reason))
    }

    fn begin_finishing(&self) -> Result<Option<CancellationReason>, SupervisorError> {
        self.lifecycle
            .lock()
            .map_err(|_| SupervisorError::LifecycleUnavailable)
            .map(|mut lifecycle| lifecycle.begin_finishing())
    }

    fn finish_lifecycle(&self) {
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            lifecycle.finish();
        }
    }
}

struct SupervisorRunGuard {
    supervisor: IndexerSupervisor,
    runtime: tokio::runtime::Handle,
    handle: Option<tokio::task::JoinHandle<Result<CurrentGeneration, SupervisorError>>>,
    reap_timeout: Duration,
}

impl SupervisorRunGuard {
    fn new(
        supervisor: IndexerSupervisor,
        runtime: tokio::runtime::Handle,
        handle: tokio::task::JoinHandle<Result<CurrentGeneration, SupervisorError>>,
    ) -> Self {
        let reap_timeout = supervisor
            .config
            .deadlines
            .operation
            .saturating_add(supervisor.config.deadlines.heartbeat_request);
        Self {
            supervisor,
            runtime,
            handle: Some(handle),
            reap_timeout,
        }
    }

    async fn join(mut self) -> Result<CurrentGeneration, SupervisorError> {
        let result = match self.handle.as_mut() {
            Some(handle) => handle.await,
            None => return Err(SupervisorError::LifecycleUnavailable),
        };
        self.handle.take();
        match result {
            Ok(result) => result,
            Err(_) => Err(SupervisorError::LifecycleUnavailable),
        }
    }
}

impl Drop for SupervisorRunGuard {
    fn drop(&mut self) {
        let Some(mut handle) = self.handle.take() else {
            return;
        };
        self.supervisor.cancel();
        let reap_timeout = self.reap_timeout;
        // The caller can no longer await cleanup, so retain one bounded reaper
        // on the spawning runtime even if this guard is dropped from another thread.
        drop(self.runtime.spawn(async move {
            let deadline = Instant::now() + reap_timeout;
            if timeout_at(deadline, &mut handle).await.is_err() {
                handle.abort();
                let _ = handle.await;
            }
        }));
    }
}

struct LifecycleFinishGuard<'a> {
    supervisor: &'a IndexerSupervisor,
}

impl<'a> LifecycleFinishGuard<'a> {
    const fn new(supervisor: &'a IndexerSupervisor) -> Self {
        Self { supervisor }
    }
}

impl Drop for LifecycleFinishGuard<'_> {
    fn drop(&mut self) {
        self.supervisor.finish_lifecycle();
    }
}

struct OwnedOperation {
    target: LeaseTarget,
    lease: Option<ProjectLease>,
    fence: LeaseFence,
    budget: OperationBudget,
}

#[derive(Clone, Copy)]
struct DurableReap {
    budget: OperationBudget,
    operation: &'static str,
}

impl DurableReap {
    const fn new(budget: OperationBudget, operation: &'static str) -> Self {
        Self { budget, operation }
    }
}

struct PendingDurable<T> {
    handle: tokio::task::JoinHandle<T>,
    active: bool,
}

impl<T> PendingDurable<T> {
    const fn new(handle: tokio::task::JoinHandle<T>, active: bool) -> Self {
        Self { handle, active }
    }
}

struct AcquisitionContext<'a> {
    probe: LeaseAcquisitionProbe,
    budget: OperationBudget,
    receiver: &'a mut watch::Receiver<bool>,
}

struct StartedRun<Work> {
    request: SupervisorRequest,
    work: Work,
    receiver: watch::Receiver<bool>,
    budget: OperationBudget,
}

struct OwnedRun<Work> {
    operation: OwnedOperation,
    work: Work,
    receiver: watch::Receiver<bool>,
}

struct MonitoredWork {
    outcome: MonitorOutcome,
    reap: ReapReport,
    prepare: PrepareReap,
}

enum MonitorOutcome {
    Ready(ReadyGeneration),
    Failed(PipelineFailure),
    Cancelled(CancelledWork),
    SupervisorFailed(SupervisorError),
}

#[derive(Clone, Copy)]
struct CancelledWork {
    reason: CancellationReason,
    grace_exceeded: bool,
}

struct WorkMonitor<'a> {
    database: CartographDatabase,
    config: SupervisorConfig,
    budget: OperationBudget,
    progress: SharedProgress,
    cancellation: &'a watch::Sender<bool>,
    receiver: watch::Receiver<bool>,
    lifecycle: &'a Arc<Mutex<LifecycleGate>>,
    lease: Option<ProjectLease>,
}

impl WorkMonitor<'_> {
    async fn run<WorkFuture>(mut self, work: WorkFuture) -> (MonitorOutcome, Option<ProjectLease>)
    where
        WorkFuture: Future<Output = Result<ReadyGeneration, PipelineFailure>>,
    {
        tokio::pin!(work);
        if *self.receiver.borrow_and_update() {
            let outcome = self
                .cancel_work(CancellationReason::Requested, &mut work)
                .await;
            return (outcome, self.lease.take());
        }
        let outcome = self.monitor_events(&mut work).await;
        (outcome, self.lease.take())
    }

    async fn monitor_events<WorkFuture>(
        &mut self,
        work: &mut std::pin::Pin<&mut WorkFuture>,
    ) -> MonitorOutcome
    where
        WorkFuture: Future<Output = Result<ReadyGeneration, PipelineFailure>>,
    {
        let operation_deadline = sleep_until(self.budget.work_deadline);
        let progress_deadline =
            sleep_until(self.progress.last_progress().await + self.config.deadlines.progress);
        let mut heartbeat = interval_at(
            Instant::now() + self.config.deadlines.heartbeat_interval,
            self.config.deadlines.heartbeat_interval,
        );
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        tokio::pin!(operation_deadline);
        tokio::pin!(progress_deadline);

        loop {
            tokio::select! {
                biased;
                changed = self.receiver.changed() => {
                    if changed.is_err() || *self.receiver.borrow_and_update() {
                        break self.cancel_work(CancellationReason::Requested, work).await;
                    }
                },
                () = &mut operation_deadline => {
                    break self.cancel_work(CancellationReason::OperationDeadline, work).await;
                },
                () = &mut progress_deadline => {
                    let next = self.progress.last_progress().await + self.config.deadlines.progress;
                    if next <= Instant::now() {
                        break self.cancel_work(CancellationReason::ProgressStalled, work).await;
                    }
                    progress_deadline.as_mut().reset(next);
                },
                result = &mut *work => break self.complete_work(result),
                _ = heartbeat.tick() => {
                    match self.renew_lease().await {
                        Ok(None) => {}
                        Ok(Some(reason)) => break self.cancel_work(reason, work).await,
                        Err(error) => break MonitorOutcome::SupervisorFailed(error),
                    }
                },
                () = self.progress.notified() => {
                    let next = self.progress.last_progress().await + self.config.deadlines.progress;
                    progress_deadline.as_mut().reset(next);
                },
            }
        }
    }

    async fn renew_lease(&mut self) -> Result<Option<CancellationReason>, SupervisorError> {
        let lease = self
            .lease
            .take()
            .ok_or(SupervisorError::LifecycleUnavailable)?;
        let attempt = run_bounded_heartbeat(HeartbeatRequest {
            database: self.database.clone(),
            config: self.config,
            budget: self.budget,
            ceiling: self.budget.work_deadline,
            operation: "heartbeat",
            lease,
        })
        .await?;
        self.lease = Some(attempt.lease);
        match (attempt.late, attempt.result) {
            (false, Ok(())) => {
                self.progress.mark_heartbeat().await;
                Ok(None)
            }
            (_, Err(LeaseError::Lost)) => Ok(Some(CancellationReason::LeaseLost)),
            _ => Ok(Some(CancellationReason::LeaseHeartbeatFailed)),
        }
    }

    fn complete_work(&self, result: Result<ReadyGeneration, PipelineFailure>) -> MonitorOutcome {
        let transition = self.lifecycle.lock();
        let Ok(mut lifecycle) = transition else {
            return MonitorOutcome::Failed(PipelineFailure::new(PipelineStage::Reduce));
        };
        match result {
            Ok(ready) => match lifecycle.begin_publication() {
                Ok(()) => MonitorOutcome::Ready(ready),
                Err(reason) => MonitorOutcome::Cancelled(CancelledWork {
                    reason,
                    grace_exceeded: false,
                }),
            },
            Err(failure) => match lifecycle.begin_finishing() {
                Some(reason) => MonitorOutcome::Cancelled(CancelledWork {
                    reason,
                    grace_exceeded: false,
                }),
                None => MonitorOutcome::Failed(failure),
            },
        }
    }

    async fn cancel_work<WorkFuture>(
        &mut self,
        reason: CancellationReason,
        work: &mut std::pin::Pin<&mut WorkFuture>,
    ) -> MonitorOutcome
    where
        WorkFuture: Future<Output = Result<ReadyGeneration, PipelineFailure>>,
    {
        let selected = self
            .lifecycle
            .lock()
            .map(|mut lifecycle| lifecycle.select_cancellation(reason))
            .unwrap_or(reason);
        self.progress.mark_cancelling(selected).await;
        self.cancellation.send_replace(true);
        if selected.is_authority_uncertain() {
            return MonitorOutcome::Cancelled(CancelledWork {
                reason: selected,
                grace_exceeded: false,
            });
        }
        let cleanup_reserve = self.config.deadlines.database_finish_reserve();
        let grace_ceiling = self.budget.final_deadline - cleanup_reserve;
        let grace_deadline = self
            .budget
            .request_deadline(self.config.deadlines.cancellation_grace, grace_ceiling);
        let completed = timeout_at(grace_deadline, work).await.is_ok();
        MonitorOutcome::Cancelled(CancelledWork {
            reason: selected,
            grace_exceeded: !completed,
        })
    }
}

struct HeartbeatAttempt {
    lease: ProjectLease,
    result: Result<(), LeaseError>,
    late: bool,
}

struct HeartbeatRequest {
    database: CartographDatabase,
    config: SupervisorConfig,
    budget: OperationBudget,
    ceiling: Instant,
    operation: &'static str,
    lease: ProjectLease,
}

async fn run_bounded_heartbeat(
    request: HeartbeatRequest,
) -> Result<HeartbeatAttempt, SupervisorError> {
    let HeartbeatRequest {
        database,
        config,
        budget,
        ceiling,
        operation,
        mut lease,
    } = request;
    let request_deadline = budget.database_deadline(config, ceiling)?;
    let mut task = tokio::spawn(async move {
        let result = database
            .heartbeat_lease_bounded(&mut lease, config.deadlines.statement_timeout())
            .await;
        (lease, result)
    });
    match timeout_at(request_deadline, &mut task).await {
        Ok(Ok((lease, result))) => Ok(HeartbeatAttempt {
            lease,
            result,
            late: false,
        }),
        Ok(Err(_)) => Err(ambiguous(operation)),
        Err(_) => {
            let reap_deadline =
                budget.request_deadline(config.deadlines.heartbeat_request, budget.final_deadline);
            match timeout_at(reap_deadline, &mut task).await {
                Ok(Ok((lease, result))) => Ok(HeartbeatAttempt {
                    lease,
                    result,
                    late: true,
                }),
                Ok(Err(_)) => Err(ambiguous(operation)),
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    Err(SupervisorError::UnreapedDurableOperation { operation })
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
struct OperationBudget {
    work_deadline: Instant,
    final_deadline: Instant,
}

impl OperationBudget {
    fn new(config: SupervisorConfig) -> Self {
        let final_deadline = Instant::now() + config.deadlines.operation;
        Self {
            work_deadline: final_deadline - config.deadlines.finish_reserve(),
            final_deadline,
        }
    }

    fn request_deadline(self, maximum: Duration, ceiling: Instant) -> Instant {
        (Instant::now() + maximum).min(ceiling)
    }

    fn database_deadline(
        self,
        config: SupervisorConfig,
        ceiling: Instant,
    ) -> Result<Instant, SupervisorError> {
        if Instant::now() >= ceiling {
            Err(SupervisorError::OperationBudgetExhausted)
        } else {
            Ok(self.request_deadline(config.deadlines.heartbeat_request, ceiling))
        }
    }

    fn durable_ceiling(self, config: SupervisorConfig) -> Instant {
        self.final_deadline - config.deadlines.heartbeat_request
    }

    fn prepare_reap_deadline(self, config: SupervisorConfig) -> Instant {
        self.final_deadline - config.deadlines.database_finish_reserve()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LifecyclePhase {
    Queued,
    Running,
    Publishing,
    Finishing,
    Terminal,
}

struct LifecycleGate {
    phase: LifecyclePhase,
    cancellation: Option<CancellationReason>,
}

impl LifecycleGate {
    const fn new() -> Self {
        Self {
            phase: LifecyclePhase::Queued,
            cancellation: None,
        }
    }

    fn start(&mut self) -> Result<(), SupervisorError> {
        if self.phase != LifecyclePhase::Queued {
            Err(SupervisorError::AlreadyStarted)
        } else {
            self.phase = LifecyclePhase::Running;
            Ok(())
        }
    }

    fn request_external_cancellation(&mut self) -> bool {
        if !matches!(self.phase, LifecyclePhase::Queued | LifecyclePhase::Running)
            || self.cancellation.is_some()
        {
            false
        } else {
            self.cancellation = Some(CancellationReason::Requested);
            true
        }
    }

    fn select_cancellation(&mut self, reason: CancellationReason) -> CancellationReason {
        let selected = self.cancellation.unwrap_or(reason);
        self.cancellation = Some(selected);
        self.phase = LifecyclePhase::Finishing;
        selected
    }

    fn begin_publication(&mut self) -> Result<(), CancellationReason> {
        if let Some(reason) = self.cancellation {
            self.phase = LifecyclePhase::Finishing;
            Err(reason)
        } else {
            self.phase = LifecyclePhase::Publishing;
            Ok(())
        }
    }

    fn begin_finishing(&mut self) -> Option<CancellationReason> {
        self.phase = LifecyclePhase::Finishing;
        self.cancellation
    }

    fn finish(&mut self) {
        self.phase = LifecyclePhase::Terminal;
    }
}

struct ExpectedGeneration {
    project_id: ProjectId,
    generation_id: GenerationId,
    sequence: i64,
    digest: ContentDigest,
}

struct PublicationEvidence {
    reconciliation: OperationReconciliation,
    retry: Option<ReadyGeneration>,
    retry_allowed: bool,
}

struct PendingPublication {
    retry: Option<ReadyGeneration>,
    retry_allowed: bool,
    task_active: bool,
}

enum PublicationPoll {
    Complete(CurrentGeneration),
    Reconcile(PendingPublication),
}

enum PublicationDecision {
    Complete(CurrentGeneration),
    Wait,
    Retry(ReadyGeneration),
    Fail(SupervisorError),
}

struct CleanupEvidence {
    reconciliation: OperationReconciliation,
    retry_allowed: bool,
    task_active: bool,
}

enum CleanupDecision {
    Complete,
    Wait,
    Retry,
    Fail(SupervisorError),
}

struct PendingCleanup {
    retry_allowed: bool,
    task_active: bool,
}

enum CleanupPoll {
    Complete,
    Reconcile(PendingCleanup),
}

type PublicationWait = Result<
    Result<
        Result<CurrentGeneration, cartograph_db::PublishGenerationError>,
        tokio::task::JoinError,
    >,
    tokio::time::error::Elapsed,
>;

type CleanupWait =
    Result<Result<Result<(), StorageError>, tokio::task::JoinError>, tokio::time::error::Elapsed>;

impl ExpectedGeneration {
    fn from_ready(ready: &ReadyGeneration) -> Self {
        Self {
            project_id: ready.project_id().clone(),
            generation_id: ready.generation_id().clone(),
            sequence: ready.sequence(),
            digest: ready.content_digest().clone(),
        }
    }

    fn matches_ready(&self, ready: &ReadyGeneration) -> bool {
        ready.project_id() == &self.project_id
            && ready.generation_id() == &self.generation_id
            && ready.sequence() == self.sequence
            && ready.content_digest() == &self.digest
    }

    fn matches_current(&self, current: &CurrentGeneration) -> bool {
        current.project_id() == &self.project_id
            && current.generation_id() == &self.generation_id
            && current.sequence() == self.sequence
            && current.content_digest() == &self.digest
    }
}

fn decide_publication(
    expected: &ExpectedGeneration,
    evidence: PublicationEvidence,
) -> PublicationDecision {
    let lease = evidence.reconciliation.lease();
    match evidence.reconciliation.into_generation() {
        ObservedGeneration::Current(current)
            if expected.matches_current(&current) && lease != ObservedLease::Owned =>
        {
            PublicationDecision::Complete(current)
        }
        ObservedGeneration::Ready(observed) if expected.matches_ready(&observed) => {
            if lease != ObservedLease::Owned {
                PublicationDecision::Fail(ownership_lost("publish-generation"))
            } else if let Some(retry) = evidence.retry {
                if evidence.retry_allowed && expected.matches_ready(&retry) {
                    PublicationDecision::Retry(retry)
                } else {
                    PublicationDecision::Fail(ambiguous("publish-generation"))
                }
            } else {
                PublicationDecision::Wait
            }
        }
        _ => PublicationDecision::Fail(ambiguous("publish-generation")),
    }
}

fn classify_publication_poll(
    result: PublicationWait,
    retry_allowed: bool,
) -> Result<PublicationPoll, SupervisorError> {
    match result {
        Ok(Ok(Ok(current))) => Ok(PublicationPoll::Complete(current)),
        Ok(Ok(Err(error))) if *error.error() == StorageError::LeaseFenceLost => {
            Err(ownership_lost("publish-generation"))
        }
        Ok(Ok(Err(error))) if !matches!(error.error(), StorageError::DatabaseOperation { .. }) => {
            let (_, source) = error.into_parts();
            Err(SupervisorError::Storage {
                operation: "publish-generation",
                source,
            })
        }
        Ok(Ok(Err(error))) => Ok(PublicationPoll::Reconcile(PendingPublication {
            retry: Some(error.into_parts().0),
            retry_allowed,
            task_active: false,
        })),
        Ok(Err(_)) => Err(ambiguous("publish-generation")),
        Err(_) => Ok(PublicationPoll::Reconcile(PendingPublication {
            retry: None,
            retry_allowed: false,
            task_active: true,
        })),
    }
}

fn decide_cleanup(evidence: CleanupEvidence) -> CleanupDecision {
    let lease = evidence.reconciliation.lease();
    match evidence.reconciliation.into_generation() {
        ObservedGeneration::Failed if lease != ObservedLease::Owned => CleanupDecision::Complete,
        ObservedGeneration::Staged(_)
        | ObservedGeneration::Ready(_)
        | ObservedGeneration::Failed
            if lease == ObservedLease::Owned =>
        {
            if evidence.retry_allowed {
                CleanupDecision::Retry
            } else if evidence.task_active {
                CleanupDecision::Wait
            } else {
                CleanupDecision::Fail(ambiguous("cleanup-generation"))
            }
        }
        ObservedGeneration::Staged(_) | ObservedGeneration::Ready(_)
            if lease != ObservedLease::Owned =>
        {
            CleanupDecision::Fail(ownership_lost("cleanup-generation"))
        }
        _ => CleanupDecision::Fail(ambiguous("cleanup-generation")),
    }
}

fn classify_cleanup_poll(
    result: CleanupWait,
    retry_allowed: bool,
) -> Result<CleanupPoll, SupervisorError> {
    match result {
        Ok(Ok(Ok(()))) => Ok(CleanupPoll::Complete),
        Ok(Ok(Err(StorageError::LeaseFenceLost))) => Err(ownership_lost("cleanup-generation")),
        Ok(Ok(Err(error))) if !matches!(error, StorageError::DatabaseOperation { .. }) => {
            Err(SupervisorError::Storage {
                operation: "cleanup-generation",
                source: error,
            })
        }
        Ok(Ok(Err(_))) => Ok(CleanupPoll::Reconcile(PendingCleanup {
            retry_allowed,
            task_active: false,
        })),
        Ok(Err(_)) => Err(ambiguous("cleanup-generation")),
        Err(_) => Ok(CleanupPoll::Reconcile(PendingCleanup {
            retry_allowed: false,
            task_active: true,
        })),
    }
}

impl CancellationReason {
    const fn is_authority_uncertain(self) -> bool {
        matches!(self, Self::LeaseLost | Self::LeaseHeartbeatFailed)
    }
}

/// Credential-safe supervisor failure.
#[derive(Debug, Error)]
pub enum SupervisorError {
    /// Deadline configuration is invalid before any external mutation.
    #[error(transparent)]
    InvalidConfig(#[from] InvalidSupervisorConfig),
    /// The one-shot supervisor was reused.
    #[error("Cartograph indexer supervisor has already started")]
    AlreadyStarted,
    /// Lease acquisition, renewal, or exact release failed.
    #[error("Cartograph indexer lease operation failed during {operation}")]
    Lease {
        /// Stable operation identifier.
        operation: &'static str,
        /// Credential-safe database lease error.
        #[source]
        source: LeaseError,
    },
    /// Durable generation cleanup or verification failed safely.
    #[error("Cartograph indexer storage operation failed during {operation}")]
    Storage {
        /// Stable operation identifier.
        operation: &'static str,
        /// Credential-safe storage error.
        #[source]
        source: StorageError,
    },
    /// A pipeline mutation lost its exact database lease token.
    #[error("Cartograph indexer lost exact lease ownership during {operation}")]
    OwnershipLost {
        /// Stable operation identifier.
        operation: &'static str,
    },
    /// PostgreSQL could not prove whether a timed-out mutation committed.
    #[error("Cartograph indexer could not reconcile durable outcome during {operation}")]
    AmbiguousOutcome {
        /// Stable operation identifier.
        operation: &'static str,
    },
    /// Pipeline work returned a stage-scoped failure.
    #[error("Cartograph indexing failed during the {stage:?} stage")]
    Pipeline {
        /// Stable pipeline stage.
        stage: PipelineStage,
    },
    /// A full index operation did not identify a generation to publish.
    #[error("Cartograph indexer supervision requires a generation-bound lease target")]
    MissingGeneration,
    /// Work returned a ready token for a different project or generation.
    #[error("Cartograph indexer work returned a mismatched ready generation")]
    GenerationMismatch,
    /// Controlled stage progress failed its monotonic contract.
    #[error("Cartograph indexer progress contract failed")]
    Progress {
        /// Stable progress-domain failure.
        #[source]
        source: ProgressError,
    },
    /// Supervision cancelled work and completed every safe owned cleanup step.
    #[error("Cartograph indexing was cancelled because {reason:?}")]
    Cancelled {
        /// Stable cancellation cause.
        reason: CancellationReason,
        /// Whether the work future or a registered worker exceeded its grace period.
        grace_exceeded: bool,
    },
    /// A work future returned while a registered child was still running.
    #[error("Cartograph indexing returned before all registered workers completed")]
    UnjoinedWorkers,
    /// A registered worker panicked before the task scope was joined.
    #[error("Cartograph indexing registered worker failed")]
    WorkerFailed,
    /// A registered worker result was dropped instead of being joined.
    #[error("Cartograph indexing registered worker result was not observed")]
    UnobservedWorkers,
    /// An aborted registered worker could not be joined by the absolute deadline.
    #[error("Cartograph indexing could not reap all registered workers by its deadline")]
    UnreapedWorkers,
    /// An acquisition, heartbeat, publication, or cleanup task could not be reaped.
    #[error("Cartograph indexer could not reap durable operation {operation} by its deadline")]
    UnreapedDurableOperation {
        /// Stable database operation identifier.
        operation: &'static str,
    },
    /// The absolute operation budget was exhausted before a required database request.
    #[error("Cartograph indexer exhausted its whole-operation deadline")]
    OperationBudgetExhausted,
    /// The in-process lifecycle gate became unavailable.
    #[error("Cartograph indexer lifecycle gate is unavailable")]
    LifecycleUnavailable,
}

impl SupervisorError {
    const fn forbids_cleanup(&self) -> bool {
        matches!(
            self,
            Self::OwnershipLost { .. }
                | Self::AmbiguousOutcome { .. }
                | Self::OperationBudgetExhausted
                | Self::UnreapedWorkers
                | Self::UnreapedDurableOperation { .. }
        )
    }
}

const fn cancelled(reason: CancellationReason, grace_exceeded: bool) -> SupervisorError {
    SupervisorError::Cancelled {
        reason,
        grace_exceeded,
    }
}

const fn ambiguous(operation: &'static str) -> SupervisorError {
    SupervisorError::AmbiguousOutcome { operation }
}

const fn ownership_lost(operation: &'static str) -> SupervisorError {
    SupervisorError::OwnershipLost { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_and_publication_are_one_atomic_lifecycle_decision() {
        let mut cancelled = LifecycleGate::new();
        assert!(cancelled.request_external_cancellation());
        assert!(cancelled.start().is_ok());
        assert_eq!(
            cancelled.begin_publication(),
            Err(CancellationReason::Requested)
        );
        cancelled.finish();
        assert!(!cancelled.request_external_cancellation());

        let mut publishing = LifecycleGate::new();
        assert!(publishing.start().is_ok());
        assert!(publishing.begin_publication().is_ok());
        assert!(!publishing.request_external_cancellation());
        publishing.finish();
        assert!(!publishing.request_external_cancellation());
    }
}
