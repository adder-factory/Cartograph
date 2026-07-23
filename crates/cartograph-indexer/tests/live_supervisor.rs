use std::{
    env,
    future::{Future, pending, poll_fn},
    process,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    task::Poll,
    time::Duration,
};

use cartograph_config::DatabaseSettings;
use cartograph_db::{
    CartographDatabase, GenerationContents, GenerationFacts, LeaseOwner, LeaseRequest, LeaseTarget,
    NewGeneration, NewProject, ReadyGeneration, SearchDocumentInput,
};
use cartograph_domain::{
    ContentDigest, DocumentId, DocumentKind, GenerationId, GenerationState, ProjectId,
    ProjectOperation,
};
use cartograph_indexer::{
    CancellationReason, IndexerSupervisor, PipelineFailure, PipelineStage, StageCapacity,
    StageDeadlinePolicy, StageEnvelope, StageExecution, StageFold, StageItemBudget,
    StageItemFailure, StageItemMeta, StageOutput, StageRunConfig, StageSequence, StageWorkItem,
    StageWorkload, SupervisorConfig, SupervisorError, SupervisorRequest, SupervisorState,
};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use tokio::sync::oneshot;

const TEST_DATABASE_URL_ENV: &str = "CARTOGRAPH_TEST_DATABASE_URL";
const PROJECT_FINGERPRINT: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COPY_PROBE_DOCUMENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVISION: &str = "1111111111111111111111111111111111111111";
const WORKER_COUNT: u16 = 4;
const SUCCESS_PROGRESS_STEPS: u64 = 3;
const SUCCESS_PROGRESS_BYTES: u64 = 32;
const EXPECTED_MINIMUM_HEARTBEATS: u64 = 2;
const SUCCESS_PROGRESS_DELAY: Duration = Duration::from_millis(125);
const STANDARD_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const STANDARD_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(100);
const STANDARD_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(500);
const STANDARD_PROGRESS_TIMEOUT: Duration = Duration::from_secs(2);
const STANDARD_CANCELLATION_GRACE: Duration = Duration::from_millis(300);
const STANDARD_COPY_TIMEOUT: Duration = Duration::from_millis(50);
const STALLED_PROGRESS_TIMEOUT: Duration = Duration::from_millis(200);
const TEST_LEASE_DURATION: Duration = Duration::from_secs(3);
const LEASE_WAIT_ATTEMPTS: usize = 100;
const LEASE_WAIT_INTERVAL: Duration = Duration::from_millis(20);
const NONCOOPERATIVE_WORK_DURATION: Duration = Duration::from_secs(2);
const SHORT_CANCELLATION_GRACE: Duration = Duration::from_millis(150);
const CANCELLING_OBSERVATION_DELAY: Duration = Duration::from_millis(40);
const DEADLINE_TEST_TIMEOUT: Duration = Duration::from_millis(900);
const DEADLINE_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(50);
const DEADLINE_PROGRESS_TIMEOUT: Duration = Duration::from_millis(300);
const DEADLINE_CANCELLATION_GRACE: Duration = Duration::from_millis(100);
const DEADLINE_COPY_TIMEOUT: Duration = Duration::from_millis(50);
const BOUNDARY_OPERATION_TIMEOUT: Duration = Duration::from_secs(8);
const BOUNDARY_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(200);
const BOUNDARY_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(750);
const BOUNDARY_PROGRESS_TIMEOUT: Duration = Duration::from_secs(3);
const BOUNDARY_CANCELLATION_GRACE: Duration = Duration::from_millis(500);
const BOUNDARY_COPY_TIMEOUT: Duration = Duration::from_millis(500);
const BOUNDARY_LEASE_DURATION: Duration = Duration::from_secs(6);
const UNCERTAIN_OPERATION_TIMEOUT: Duration = Duration::from_secs(4);
const UNCERTAIN_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(50);
const UNCERTAIN_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(100);
const UNCERTAIN_PROGRESS_TIMEOUT: Duration = Duration::from_secs(2);
const UNCERTAIN_CANCELLATION_GRACE: Duration = Duration::from_secs(1);
const UNCERTAIN_COPY_TIMEOUT: Duration = Duration::from_millis(100);
const UNCERTAIN_RESULT_BOUND: Duration = Duration::from_millis(700);
const RECONCILE_OPERATION_TIMEOUT: Duration = Duration::from_secs(3);
const RECONCILE_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(50);
const RECONCILE_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(100);
const RECONCILE_PROGRESS_TIMEOUT: Duration = Duration::from_secs(1);
const RECONCILE_CANCELLATION_GRACE: Duration = Duration::from_millis(300);
const RECONCILE_COPY_TIMEOUT: Duration = Duration::from_millis(200);
const FIRST_MUTATION_DELAY_SECONDS: &str = "0.25";
const ABORT_OPERATION_TIMEOUT: Duration = Duration::from_millis(1_200);
const ABORT_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(100);
const ABORT_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(100);
const ABORT_PROGRESS_TIMEOUT: Duration = Duration::from_millis(400);
const ABORT_CANCELLATION_GRACE: Duration = Duration::from_millis(100);
const ABORT_COPY_TIMEOUT: Duration = Duration::from_millis(100);
const ABORT_RESULT_BOUND: Duration = Duration::from_secs(2);
const COPY_CANCEL_OPERATION_TIMEOUT: Duration = Duration::from_secs(2);
const COPY_CANCEL_GRACE: Duration = Duration::from_millis(20);
const COPY_CANCEL_TIMEOUT: Duration = Duration::from_millis(200);
const LONG_COPY_OPERATION_TIMEOUT: Duration = Duration::from_secs(3);
const LONG_COPY_TIMEOUT: Duration = Duration::from_millis(500);
const LARGE_COPY_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(300);
const LARGE_COPY_PROGRESS_TIMEOUT: Duration = Duration::from_millis(500);
const LONG_COPY_TRIGGER_DELAY_SECONDS: &str = "0.20";
const LONG_COPY_CODE_BYTES: usize = 2 * 1_024 * 1_024;
const ORDERED_STAGE_ITEMS: u64 = 8;
const ORDERED_STAGE_WORKERS: usize = 4;
const ORDERED_STAGE_ITEM_BYTES: u64 = 16;

static SCHEMA_COUNTER: AtomicU32 = AtomicU32::new(0);

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn successful_supervision_renews_releases_and_requires_publication() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let target = target(&fixture.project, staged.generation_id());
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), standard_config());
    let current = supervisor
        .run(request(target.clone()), move |context| async move {
            assert!(
                context
                    .progress()
                    .begin_stage(PipelineStage::Discover)
                    .await
                    .is_ok()
            );
            for _ in 0..SUCCESS_PROGRESS_STEPS {
                tokio::time::sleep(SUCCESS_PROGRESS_DELAY).await;
                assert!(
                    context
                        .progress()
                        .advance(1, SUCCESS_PROGRESS_BYTES)
                        .await
                        .is_ok()
                );
            }
            assert!(
                context
                    .progress()
                    .begin_stage(PipelineStage::Copy)
                    .await
                    .is_ok()
            );
            context
                .prepare_generation(GenerationContents::new(staged, GenerationFacts::default()))
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
        })
        .await;
    let current = match current {
        Ok(current) => current,
        Err(error) => panic!("successful supervised generation failed: {error}"),
    };
    assert_eq!(current.project_id(), &fixture.project);
    assert_eq!(
        supervisor.status().await.state(),
        SupervisorState::Completed
    );
    assert!(!supervisor.cancel());
    assert!(supervisor.status().await.heartbeat_count() >= EXPECTED_MINIMUM_HEARTBEATS);
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn bounded_parallel_stage_reduces_before_supervised_publication() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), standard_config());
    let current = supervisor
        .run(request(target.clone()), move |context| async move {
            let deadline = tokio::time::Instant::now() + STANDARD_OPERATION_TIMEOUT;
            let inputs = (0..ORDERED_STAGE_ITEMS).map(|sequence| {
                StageEnvelope::new(
                    StageItemMeta::new(
                        StageSequence::new(sequence),
                        format!("src/ordered_{sequence}.rs"),
                        StageItemBudget::new(
                            ORDERED_STAGE_ITEM_BYTES,
                            ORDERED_STAGE_ITEM_BYTES,
                            deadline,
                        ),
                    ),
                    sequence,
                )
            });
            let execution = StageExecution::new(
                StageRunConfig::new(
                    PipelineStage::Parse,
                    StageCapacity::new(ORDERED_STAGE_WORKERS, ORDERED_STAGE_WORKERS),
                    StageDeadlinePolicy::new(deadline, STANDARD_CANCELLATION_GRACE),
                ),
                StageWorkload::new(inputs, |item: StageWorkItem<String, u64>| async move {
                    let (_, _, payload) = item.into_parts();
                    tokio::time::sleep(Duration::from_millis(
                        ORDERED_STAGE_ITEMS.saturating_sub(payload),
                    ))
                    .await;
                    Ok::<_, StageItemFailure>(payload)
                }),
                StageFold::new(
                    Vec::new(),
                    |ordered: &mut Vec<u64>, output: StageOutput<String, u64>| {
                        let (_, payload) = output.into_parts();
                        ordered.push(payload);
                        Ok(())
                    },
                ),
            );
            let ordered = context
                .stages()
                .execute(execution)
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Parse))?;
            assert_eq!(ordered, (0..ORDERED_STAGE_ITEMS).collect::<Vec<_>>());
            context
                .progress()
                .begin_stage(PipelineStage::Copy)
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))?;
            context
                .prepare_generation(GenerationContents::new(staged, GenerationFacts::default()))
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
        })
        .await;
    let current = match current {
        Ok(current) => current,
        Err(error) => panic!("bounded ordered stage failed before publication: {error}"),
    };
    assert_eq!(current.generation_id(), &generation_id);
    let status = supervisor.status().await;
    assert_eq!(status.state(), SupervisorState::Completed);
    assert_eq!(status.completed_items(), ORDERED_STAGE_ITEMS);
    assert_eq!(
        status.completed_bytes(),
        ORDERED_STAGE_ITEMS * ORDERED_STAGE_ITEM_BYTES
    );
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn large_payload_copy_uses_its_own_stage_deadline() {
    let fixture = open_fixture().await;
    install_copy_delay(&fixture).await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), large_payload_copy_config());
    let current = supervisor
        .run(request(target.clone()), move |context| async move {
            context
                .progress()
                .begin_stage(PipelineStage::Copy)
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))?;
            context
                .prepare_generation(GenerationContents::new(
                    staged,
                    GenerationFacts {
                        documents: vec![large_copy_probe_document()],
                        ..GenerationFacts::default()
                    },
                ))
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
        })
        .await;
    let current = match current {
        Ok(current) => current,
        Err(error) => panic!("large payload COPY used the heartbeat deadline: {error}"),
    };
    assert_eq!(current.generation_id(), &generation_id);
    assert_eq!(
        supervisor.status().await.state(),
        SupervisorState::Completed
    );
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn recovered_ready_generation_still_publishes_through_supervisor_gate() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let staging_lease = match fixture
        .database
        .acquire_lease(LeaseRequest::new(
            target.clone(),
            LeaseOwner::new(process::id(), "recovered-ready-staging"),
            TEST_LEASE_DURATION,
        ))
        .await
    {
        Ok(lease) => lease,
        Err(error) => panic!("recovered-ready staging lease failed: {error}"),
    };
    let ready = match fixture
        .database
        .prepare_generation(
            GenerationContents::new(staged, GenerationFacts::default()),
            &staging_lease.fence(),
        )
        .await
    {
        Ok(ready) => ready,
        Err(error) => panic!("recovered-ready staging failed: {error}"),
    };
    assert!(fixture.database.release_lease(&staging_lease).await.is_ok());
    drop(ready);
    let ready = match fixture
        .database
        .recover_generation(&fixture.project, &generation_id)
        .await
    {
        Ok(Some(cartograph_db::RecoverableGeneration::Ready(ready))) => ready,
        Ok(_) => panic!("ready generation was not recoverable for supervised publication"),
        Err(error) => panic!("ready generation recovery failed: {error}"),
    };
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), standard_config());
    let current = supervisor
        .run(request(target.clone()), move |_| async move { Ok(ready) })
        .await;
    let current = match current {
        Ok(current) => current,
        Err(error) => panic!("recovered ready generation did not publish: {error}"),
    };
    assert_eq!(current.generation_id(), &generation_id);
    assert_eq!(
        supervisor.status().await.state(),
        SupervisorState::Completed
    );
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn dropped_failed_child_blocks_publication_and_cleans_owned_generation() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), standard_config());
    let result = supervisor
        .run(request(target.clone()), move |context| async move {
            let failed_child = context
                .spawn(1, async {
                    Err::<(), PipelineFailure>(PipelineFailure::new(PipelineStage::Parse))
                })
                .map_err(|_| PipelineFailure::new(PipelineStage::Parse))?;
            drop(failed_child);
            tokio::task::yield_now().await;
            context
                .progress()
                .begin_stage(PipelineStage::Copy)
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))?;
            context
                .prepare_generation(GenerationContents::new(staged, GenerationFacts::default()))
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
        })
        .await;
    assert!(matches!(result, Err(SupervisorError::WorkerFailed)));
    assert_eq!(supervisor.status().await.state(), SupervisorState::Failed);
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn blocked_supervised_copy_rolls_back_backend_query_and_advisory_locks() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let lock_statement = format!(
        r#"LOCK TABLE "{}"."search_documents" IN ACCESS EXCLUSIVE MODE"#,
        fixture.schema
    );
    let mut table_lock = match fixture.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => panic!("COPY lock transaction failed: {error}"),
    };
    if let Err(error) = query(AssertSqlSafe(lock_statement))
        .execute(&mut *table_lock)
        .await
    {
        panic!("COPY table lock failed: {error}");
    }
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), abort_config());
    let result = tokio::time::timeout(
        ABORT_RESULT_BOUND,
        supervisor.run(request(target.clone()), move |context| async move {
            context
                .prepare_generation(GenerationContents::new(
                    staged,
                    GenerationFacts {
                        documents: vec![copy_probe_document()],
                        ..GenerationFacts::default()
                    },
                ))
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
        }),
    )
    .await;
    let result = match result {
        Ok(result) => result,
        Err(_) => panic!("blocked supervised COPY exceeded its absolute deadline"),
    };
    assert!(
        matches!(
            result,
            Err(SupervisorError::Pipeline {
                stage: PipelineStage::Copy
            })
        ),
        "unexpected blocked COPY result: {result:?}"
    );
    assert_no_active_schema_work(&fixture).await;
    assert_generation_advisories_available(&fixture, &target).await;
    assert!(table_lock.rollback().await.is_ok());
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn requested_cancellation_reaps_inflight_copy_before_external_unlock() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let lock_statement = format!(
        r#"LOCK TABLE "{}"."search_documents" IN ACCESS EXCLUSIVE MODE"#,
        fixture.schema
    );
    let mut table_lock = match fixture.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => panic!("cancelled COPY lock transaction failed: {error}"),
    };
    if let Err(error) = query(AssertSqlSafe(lock_statement))
        .execute(&mut *table_lock)
        .await
    {
        panic!("cancelled COPY table lock failed: {error}");
    }
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), copy_cancel_config());
    let runner = supervisor.clone();
    let request_target = target.clone();
    let handle = tokio::spawn(async move {
        runner
            .run(request(request_target), move |context| async move {
                context
                    .progress()
                    .begin_stage(PipelineStage::Copy)
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))?;
                context
                    .prepare_generation(GenerationContents::new(
                        staged,
                        GenerationFacts {
                            documents: vec![copy_probe_document()],
                            ..GenerationFacts::default()
                        },
                    ))
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
            })
            .await
    });
    wait_for_schema_lock(&fixture.pool, &fixture.schema, "search_documents").await;
    assert!(supervisor.cancel());
    let result = match tokio::time::timeout(ABORT_RESULT_BOUND, handle).await {
        Ok(result) => match result {
            Ok(result) => result,
            Err(error) => panic!("cancelled COPY supervisor task failed: {error}"),
        },
        Err(_) => panic!("cancelled COPY waited for the external table lock"),
    };
    assert!(matches!(
        result,
        Err(SupervisorError::Cancelled {
            reason: CancellationReason::Requested,
            grace_exceeded: true
        })
    ));
    assert_no_active_schema_work(&fixture).await;
    assert_generation_advisories_available(&fixture, &target).await;
    assert!(table_lock.rollback().await.is_ok());
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn aborting_public_run_reaps_inflight_copy_before_external_unlock() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let lock_statement = format!(
        r#"LOCK TABLE "{}"."search_documents" IN ACCESS EXCLUSIVE MODE"#,
        fixture.schema
    );
    let mut table_lock = match fixture.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => panic!("aborted caller COPY lock transaction failed: {error}"),
    };
    if let Err(error) = query(AssertSqlSafe(lock_statement))
        .execute(&mut *table_lock)
        .await
    {
        panic!("aborted caller COPY table lock failed: {error}");
    }
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), copy_cancel_config());
    let runner = supervisor.clone();
    let request_target = target.clone();
    let outer = tokio::spawn(async move {
        runner
            .run(request(request_target), move |context| async move {
                context
                    .progress()
                    .begin_stage(PipelineStage::Copy)
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))?;
                context
                    .prepare_generation(GenerationContents::new(
                        staged,
                        GenerationFacts {
                            documents: vec![copy_probe_document()],
                            ..GenerationFacts::default()
                        },
                    ))
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
            })
            .await
    });
    wait_for_schema_lock(&fixture.pool, &fixture.schema, "search_documents").await;
    outer.abort();
    assert!(matches!(outer.await, Err(error) if error.is_cancelled()));
    wait_for_supervisor_state(&supervisor, SupervisorState::Wedged).await;
    assert_no_active_schema_work(&fixture).await;
    assert_generation_advisories_available(&fixture, &target).await;
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));
    assert!(table_lock.rollback().await.is_ok());

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn dropping_polled_run_outside_runtime_reaps_inflight_copy() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let lock_statement = format!(
        r#"LOCK TABLE "{}"."search_documents" IN ACCESS EXCLUSIVE MODE"#,
        fixture.schema
    );
    let mut table_lock = match fixture.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => panic!("cross-thread drop lock transaction failed: {error}"),
    };
    if let Err(error) = query(AssertSqlSafe(lock_statement))
        .execute(&mut *table_lock)
        .await
    {
        panic!("cross-thread drop table lock failed: {error}");
    }
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), copy_cancel_config());
    let runner = supervisor.clone();
    let request_target = target.clone();
    let mut run = Box::pin(async move {
        runner
            .run(request(request_target), move |context| async move {
                context
                    .progress()
                    .begin_stage(PipelineStage::Copy)
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))?;
                context
                    .prepare_generation(GenerationContents::new(
                        staged,
                        GenerationFacts {
                            documents: vec![copy_probe_document()],
                            ..GenerationFacts::default()
                        },
                    ))
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
            })
            .await
    });
    poll_fn(|context| {
        assert!(matches!(run.as_mut().poll(context), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    wait_for_schema_lock(&fixture.pool, &fixture.schema, "search_documents").await;
    let dropper = std::thread::spawn(move || drop(run));
    assert!(dropper.join().is_ok());
    wait_for_supervisor_state(&supervisor, SupervisorState::Wedged).await;
    assert_no_active_schema_work(&fixture).await;
    assert_generation_advisories_available(&fixture, &target).await;
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));
    assert!(table_lock.rollback().await.is_ok());

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn requested_cancellation_fails_owned_generation_and_releases_lease() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), standard_config());
    let runner = supervisor.clone();
    let request_target = target.clone();
    let handle = tokio::spawn(async move {
        runner
            .run(request(request_target), move |context| async move {
                let _staged = staged;
                assert!(
                    context
                        .progress()
                        .begin_stage(PipelineStage::Read)
                        .await
                        .is_ok()
                );
                let mut cancellation = context.cancellation();
                cancellation.cancelled().await;
                Err::<ReadyGeneration, _>(PipelineFailure::new(PipelineStage::Read))
            })
            .await
    });
    wait_for_lease(&fixture.database, &target).await;
    assert!(supervisor.cancel());
    let result = join(handle).await;
    assert!(matches!(
        result,
        Err(SupervisorError::Cancelled {
            reason: CancellationReason::Requested,
            grace_exceeded: false
        })
    ));
    assert_eq!(
        supervisor.status().await.state(),
        SupervisorState::Cancelled
    );
    assert!(supervisor.status().await.heartbeat_count() > 0);
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn progress_stall_cancels_work_and_marks_generation_failed() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), stalled_config());
    let result = supervisor
        .run(request(target.clone()), move |context| async move {
            let _staged = staged;
            let mut cancellation = context.cancellation();
            cancellation.cancelled().await;
            Err::<ReadyGeneration, _>(PipelineFailure::new(PipelineStage::Discover))
        })
        .await;
    assert!(matches!(
        result,
        Err(SupervisorError::Cancelled {
            reason: CancellationReason::ProgressStalled,
            grace_exceeded: false
        })
    ));
    let status = supervisor.status().await;
    assert_eq!(status.state(), SupervisorState::Wedged);
    assert_eq!(
        status.cancellation_reason(),
        Some(CancellationReason::ProgressStalled)
    );
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn lost_lease_cancels_without_mutating_new_owners_generation() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), standard_config());
    let runner = supervisor.clone();
    let request_target = target.clone();
    let handle = tokio::spawn(async move {
        runner
            .run(request(request_target), move |context| async move {
                let _staged = staged;
                assert!(
                    context
                        .progress()
                        .begin_stage(PipelineStage::Parse)
                        .await
                        .is_ok()
                );
                let mut cancellation = context.cancellation();
                cancellation.cancelled().await;
                Err::<ReadyGeneration, _>(PipelineFailure::new(PipelineStage::Parse))
            })
            .await
    });
    wait_for_lease(&fixture.database, &target).await;
    expire_lease(&fixture, &target).await;
    let takeover = match fixture
        .database
        .acquire_lease(LeaseRequest::new(
            target.clone(),
            LeaseOwner::new(process::id(), "takeover-owner"),
            TEST_LEASE_DURATION,
        ))
        .await
    {
        Ok(lease) => lease,
        Err(error) => panic!("takeover lease acquisition failed: {error}"),
    };
    let result = join(handle).await;
    assert!(matches!(
        result,
        Err(SupervisorError::Cancelled {
            reason: CancellationReason::LeaseLost,
            grace_exceeded: false
        })
    ));
    assert_generation_state(&fixture, &generation_id, GenerationState::Staging).await;
    let status = match fixture.database.lease_status(&target).await {
        Ok(Some(status)) => status,
        Ok(None) => panic!("takeover lease disappeared"),
        Err(error) => panic!("takeover lease status failed: {error}"),
    };
    assert_eq!(status.owner_process_start(), "takeover-owner");
    assert!(fixture.database.release_lease(&takeover).await.is_ok());
    fail_recoverable_generation(&fixture, &generation_id).await;

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn operation_deadline_cancels_despite_continuous_progress() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), deadline_config());
    let result = supervisor
        .run(request(target.clone()), move |context| async move {
            let _staged = staged;
            assert!(
                context
                    .progress()
                    .begin_stage(PipelineStage::Resolve)
                    .await
                    .is_ok()
            );
            let mut cancellation = context.cancellation();
            loop {
                if cancellation.is_cancelled() {
                    cancellation.cancelled().await;
                    return Err(PipelineFailure::new(PipelineStage::Resolve));
                }
                assert!(context.progress().advance(1, 1).await.is_ok());
                tokio::task::yield_now().await;
            }
        })
        .await;
    assert!(matches!(
        result,
        Err(SupervisorError::Cancelled {
            reason: CancellationReason::OperationDeadline,
            grace_exceeded: false
        })
    ));
    assert_eq!(
        supervisor.status().await.state(),
        SupervisorState::Cancelled
    );
    assert!(supervisor.status().await.heartbeat_count() > 0);
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn noncooperative_work_is_dropped_after_visible_cancellation_grace() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let dropped = Arc::new(AtomicBool::new(false));
    let drop_observer = dropped.clone();
    let supervisor = IndexerSupervisor::new(
        fixture.database.clone(),
        standard_config().with_cancellation_grace(SHORT_CANCELLATION_GRACE),
    );
    let runner = supervisor.clone();
    let request_target = target.clone();
    let handle = tokio::spawn(async move {
        runner
            .run(request(request_target), move |context| async move {
                let _staged = staged;
                let _drop_flag = DropFlag(drop_observer);
                assert!(
                    context
                        .progress()
                        .begin_stage(PipelineStage::Read)
                        .await
                        .is_ok()
                );
                tokio::time::sleep(NONCOOPERATIVE_WORK_DURATION).await;
                Err(PipelineFailure::new(PipelineStage::Read))
            })
            .await
    });
    wait_for_lease(&fixture.database, &target).await;
    assert!(supervisor.cancel());
    tokio::time::sleep(CANCELLING_OBSERVATION_DELAY).await;
    assert_eq!(
        supervisor.status().await.state(),
        SupervisorState::Cancelling
    );
    let result = join(handle).await;
    assert!(matches!(
        result,
        Err(SupervisorError::Cancelled {
            reason: CancellationReason::Requested,
            grace_exceeded: true
        })
    ));
    let status = supervisor.status().await;
    assert_eq!(status.state(), SupervisorState::Wedged);
    assert!(status.grace_exceeded());
    assert!(dropped.load(Ordering::Acquire));
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn cancellation_during_blocked_acquisition_reaps_work_and_leaves_recoverable_staging() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let lock_statement = format!(
        r#"LOCK TABLE "{}"."project_operation_leases" IN ACCESS EXCLUSIVE MODE"#,
        fixture.schema
    );
    let mut lock = match fixture.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => panic!("acquisition lock transaction failed: {error}"),
    };
    if let Err(error) = query(AssertSqlSafe(lock_statement))
        .execute(&mut *lock)
        .await
    {
        panic!("acquisition lock failed: {error}");
    }
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), boundary_config());
    let runner = supervisor.clone();
    let work_called = Arc::new(AtomicBool::new(false));
    let work_observer = work_called.clone();
    let request_target = target.clone();
    let handle = tokio::spawn(async move {
        runner
            .run(
                request_with_duration(request_target, BOUNDARY_LEASE_DURATION),
                move |_| async move {
                    work_observer.store(true, Ordering::Release);
                    let _staged = staged;
                    Err::<ReadyGeneration, _>(PipelineFailure::new(PipelineStage::Discover))
                },
            )
            .await
    });
    wait_for_database_lock(&fixture.pool, &fixture.schema).await;
    assert!(supervisor.cancel());
    let result = match tokio::time::timeout(ABORT_RESULT_BOUND, handle).await {
        Ok(result) => match result {
            Ok(result) => result,
            Err(error) => panic!("blocked-acquisition supervisor task failed: {error}"),
        },
        Err(_) => panic!("bounded acquisition reconciliation waited for the external blocker"),
    };
    // Cancellation may linearize before the exact probe starts (cancelled) or
    // while the access-exclusive lock prevents proof (ambiguous). Both exits
    // must reap every database task before returning.
    assert!(
        matches!(
            result,
            Err(SupervisorError::Cancelled {
                reason: CancellationReason::Requested,
                grace_exceeded: false
            }) | Err(SupervisorError::AmbiguousOutcome {
                operation: "acquire"
            })
        ),
        "unexpected blocked acquisition result: {result:?}"
    );
    assert!(!work_called.load(Ordering::Acquire));
    assert_generation_state(&fixture, &generation_id, GenerationState::Staging).await;
    assert_no_active_schema_work(&fixture).await;
    assert_generation_advisories_available(&fixture, &target).await;
    assert!(lock.rollback().await.is_ok());
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));
    assert!(!supervisor.cancel());
    assert_no_active_schema_work(&fixture).await;
    fail_recoverable_generation(&fixture, &generation_id).await;
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn timed_out_acquisition_keeps_one_exact_attempt_and_recovers_its_token() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    install_one_shot_acquisition_delay(&fixture).await;
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), reconcile_config());
    let work_called = Arc::new(AtomicBool::new(false));
    let work_observer = work_called.clone();
    let result = supervisor
        .run(request(target.clone()), move |_| async move {
            work_observer.store(true, Ordering::Release);
            let _staged = staged;
            Err::<ReadyGeneration, _>(PipelineFailure::new(PipelineStage::Discover))
        })
        .await;
    assert!(matches!(
        result,
        Err(SupervisorError::Pipeline {
            stage: PipelineStage::Discover
        })
    ));
    assert!(work_called.load(Ordering::Acquire));
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn publication_gate_rejects_late_cancellation_and_commits_once() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let target = target(&fixture.project, staged.generation_id());
    let publication_key = format!(
        "cartograph-v2-publish:{}:{}",
        fixture.schema, fixture.project
    );
    let mut lock_connection = match fixture.pool.acquire().await {
        Ok(connection) => connection,
        Err(error) => panic!("publication lock connection failed: {error}"),
    };
    if let Err(error) = query("SELECT pg_advisory_lock(hashtextextended($1, 0))")
        .bind(&publication_key)
        .execute(&mut *lock_connection)
        .await
    {
        panic!("publication advisory lock failed: {error}");
    }
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), boundary_config());
    let runner = supervisor.clone();
    let request_target = target.clone();
    let run = runner.run(
        request_with_duration(request_target, BOUNDARY_LEASE_DURATION),
        move |context| async move {
            context
                .prepare_generation(GenerationContents::new(staged, GenerationFacts::default()))
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
        },
    );
    let release_publication = async {
        wait_for_supervisor_stage(&supervisor, PipelineStage::Publish).await;
        assert!(!supervisor.cancel());
        if let Err(error) = query("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
            .bind(&publication_key)
            .execute(&mut *lock_connection)
            .await
        {
            panic!("publication advisory unlock failed: {error}");
        }
    };
    let (current, ()) = tokio::join!(run, release_publication);
    let current = match current {
        Ok(current) => current,
        Err(error) => panic!("publication did not finish after gate close: {error}"),
    };
    assert_eq!(current.project_id(), &fixture.project);
    assert_eq!(
        supervisor.status().await.state(),
        SupervisorState::Completed
    );
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));
    assert!(!supervisor.cancel());
    drop(lock_connection);

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn timed_out_publication_reconciles_ready_state_retries_and_releases_atomically() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let target = target(&fixture.project, staged.generation_id());
    install_one_shot_publish_delay(&fixture).await;
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), reconcile_config());
    let current = supervisor
        .run(request(target.clone()), move |context| async move {
            context
                .prepare_generation(GenerationContents::new(staged, GenerationFacts::default()))
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
        })
        .await;
    let current = match current {
        Ok(current) => current,
        Err(error) => panic!("timed-out publication did not reconcile: {error}"),
    };
    assert_eq!(current.project_id(), &fixture.project);
    assert_eq!(
        supervisor.status().await.state(),
        SupervisorState::Completed
    );
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn timed_out_cleanup_reconciles_failure_and_exact_release_atomically() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    install_one_shot_cleanup_delay(&fixture).await;
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), reconcile_config());
    let runner = supervisor.clone();
    let request_target = target.clone();
    let handle = tokio::spawn(async move {
        runner
            .run(request(request_target), move |context| async move {
                let _staged = staged;
                let mut cancellation = context.cancellation();
                cancellation.cancelled().await;
                Err::<ReadyGeneration, _>(PipelineFailure::new(PipelineStage::Read))
            })
            .await
    });
    wait_for_lease(&fixture.database, &target).await;
    assert!(supervisor.cancel());
    let result = join(handle).await;
    assert!(matches!(
        result,
        Err(SupervisorError::Cancelled {
            reason: CancellationReason::Requested,
            grace_exceeded: false
        })
    ));
    assert_generation_state(&fixture, &generation_id, GenerationState::Failed).await;
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn blocked_publication_is_aborted_reaped_and_leaves_no_active_query() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let publication_key = format!(
        "cartograph-v2-publish:{}:{}",
        fixture.schema, fixture.project
    );
    let mut lock_connection = match fixture.pool.acquire().await {
        Ok(connection) => connection,
        Err(error) => panic!("publication abort lock connection failed: {error}"),
    };
    if let Err(error) = query("SELECT pg_advisory_lock(hashtextextended($1, 0))")
        .bind(&publication_key)
        .execute(&mut *lock_connection)
        .await
    {
        panic!("publication abort advisory lock failed: {error}");
    }
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), abort_config());
    let result = tokio::time::timeout(
        ABORT_RESULT_BOUND,
        supervisor.run(request(target.clone()), move |context| async move {
            context
                .prepare_generation(GenerationContents::new(staged, GenerationFacts::default()))
                .await
                .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
        }),
    )
    .await;
    let result = match result {
        Ok(result) => result,
        Err(_) => panic!("blocked publication exceeded its absolute supervisor deadline"),
    };
    assert!(
        matches!(
            result,
            Err(SupervisorError::AmbiguousOutcome {
                operation: "publish-generation"
            })
        ),
        "unexpected blocked publication result: {result:?}"
    );
    assert_no_active_schema_work(&fixture).await;
    assert_generation_advisories_available(&fixture, &target).await;
    if let Err(error) = query("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
        .bind(&publication_key)
        .execute(&mut *lock_connection)
        .await
    {
        panic!("publication abort advisory unlock failed: {error}");
    }
    drop(lock_connection);
    expire_lease(&fixture, &target).await;
    fail_recoverable_generation(&fixture, &generation_id).await;

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn blocked_cleanup_is_aborted_reaped_and_leaves_no_active_query() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let (release_work, work_release) = oneshot::channel();
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), abort_config());
    let run = supervisor.run(request(target.clone()), move |_| async move {
        if work_release.await.is_err() {
            return Err(PipelineFailure::new(PipelineStage::Read));
        }
        let _staged = staged;
        Err::<ReadyGeneration, _>(PipelineFailure::new(PipelineStage::Read))
    });
    let hold_generation_lock = async {
        wait_for_lease(&fixture.database, &target).await;
        let generation_lock_statement = format!(
            r#"SELECT state FROM "{}"."index_generations"
                WHERE project_id = CAST($1 AS uuid)
                  AND generation_id = CAST($2 AS uuid)
                FOR UPDATE"#,
            fixture.schema
        );
        let mut generation_lock = match fixture.pool.begin().await {
            Ok(transaction) => transaction,
            Err(error) => panic!("cleanup abort lock transaction failed: {error}"),
        };
        if let Err(error) = query(AssertSqlSafe(generation_lock_statement))
            .bind(fixture.project.as_str())
            .bind(generation_id.as_str())
            .fetch_one(&mut *generation_lock)
            .await
        {
            panic!("cleanup abort generation lock failed: {error}");
        }
        if release_work.send(()).is_err() {
            panic!("cleanup abort work release was not observed");
        }
        wait_for_supervisor_state(&supervisor, SupervisorState::Failed).await;
        assert_no_active_schema_work(&fixture).await;
        assert_generation_advisories_available(&fixture, &target).await;
        assert!(generation_lock.rollback().await.is_ok());
    };
    let joined = tokio::time::timeout(ABORT_RESULT_BOUND, async {
        tokio::join!(run, hold_generation_lock)
    })
    .await;
    let (result, ()) = match joined {
        Ok(joined) => joined,
        Err(_) => panic!("blocked cleanup exceeded its absolute supervisor deadline"),
    };
    assert!(
        matches!(
            result,
            Err(SupervisorError::AmbiguousOutcome {
                operation: "cleanup-generation"
            })
        ),
        "unexpected blocked cleanup result: {result:?}"
    );
    expire_lease(&fixture, &target).await;
    fail_recoverable_generation(&fixture, &generation_id).await;

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn heartbeat_uncertainty_drops_root_and_reaps_registered_children_without_grace() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let root_dropped = Arc::new(AtomicBool::new(false));
    let child_dropped = Arc::new(AtomicBool::new(false));
    let root_observer = root_dropped.clone();
    let child_observer = child_dropped.clone();
    let (child_started, child_started_receiver) = oneshot::channel();
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), uncertain_config());
    let runner = supervisor.clone();
    let request_target = target.clone();
    let handle = tokio::spawn(async move {
        runner
            .run(request(request_target), move |context| async move {
                let _staged = staged;
                let _root_drop = DropFlag(root_observer);
                let child = match context.spawn(1, async move {
                    let _child_drop = DropFlag(child_observer);
                    let _ = child_started.send(());
                    pending::<Result<(), PipelineFailure>>().await
                }) {
                    Ok(child) => child,
                    Err(error) => panic!("registered child did not spawn: {error}"),
                };
                assert!(child_started_receiver.await.is_ok());
                drop(child);
                pending::<Result<ReadyGeneration, PipelineFailure>>().await
            })
            .await
    });
    wait_for_lease(&fixture.database, &target).await;
    let mut lease_lock = match fixture.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => panic!("lease-lock transaction failed: {error}"),
    };
    let lease_lock_statement = format!(
        r#"SELECT lease_id FROM "{}"."project_operation_leases"
            WHERE project_id = CAST($1 AS uuid) AND operation = $2
            FOR UPDATE"#,
        fixture.schema
    );
    if let Err(error) = query(AssertSqlSafe(lease_lock_statement))
        .bind(target.project_id().as_str())
        .bind(target.operation().as_str())
        .fetch_one(&mut *lease_lock)
        .await
    {
        panic!("could not lock exact lease row: {error}");
    }
    let result = match tokio::time::timeout(UNCERTAIN_RESULT_BOUND, handle).await {
        Ok(result) => match result {
            Ok(result) => result,
            Err(error) => panic!("uncertain-heartbeat supervisor task failed: {error}"),
        },
        Err(_) => panic!("heartbeat uncertainty incorrectly waited for cancellation grace"),
    };
    assert!(matches!(
        result,
        Err(SupervisorError::Cancelled {
            reason: CancellationReason::LeaseHeartbeatFailed,
            grace_exceeded: false
        })
    ));
    assert!(root_dropped.load(Ordering::Acquire));
    assert!(child_dropped.load(Ordering::Acquire));
    assert_generation_state(&fixture, &generation_id, GenerationState::Staging).await;
    assert_no_active_schema_work(&fixture).await;
    assert_generation_advisories_available(&fixture, &target).await;
    assert!(lease_lock.rollback().await.is_ok());
    expire_lease(&fixture, &target).await;
    let takeover = match fixture
        .database
        .acquire_lease(LeaseRequest::new(
            target.clone(),
            LeaseOwner::new(process::id(), "uncertain-heartbeat-takeover"),
            TEST_LEASE_DURATION,
        ))
        .await
    {
        Ok(lease) => lease,
        Err(error) => panic!("uncertain-heartbeat takeover failed: {error}"),
    };
    assert!(fixture.database.release_lease(&takeover).await.is_ok());
    fail_recoverable_generation(&fixture, &generation_id).await;

    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn heartbeat_uncertainty_reaps_concurrent_copy_before_returning() {
    let fixture = open_fixture().await;
    let staged = begin_generation(&fixture).await;
    let generation_id = staged.generation_id().clone();
    let target = target(&fixture.project, &generation_id);
    let table_lock_statement = format!(
        r#"LOCK TABLE "{}"."search_documents" IN ACCESS EXCLUSIVE MODE"#,
        fixture.schema
    );
    let mut table_lock = match fixture.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => panic!("combined uncertainty table-lock transaction failed: {error}"),
    };
    if let Err(error) = query(AssertSqlSafe(table_lock_statement))
        .execute(&mut *table_lock)
        .await
    {
        panic!("combined uncertainty table lock failed: {error}");
    }
    let supervisor = IndexerSupervisor::new(fixture.database.clone(), long_copy_config());
    let runner = supervisor.clone();
    let request_target = target.clone();
    let handle = tokio::spawn(async move {
        runner
            .run(request(request_target), move |context| async move {
                context
                    .progress()
                    .begin_stage(PipelineStage::Copy)
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))?;
                context
                    .prepare_generation(GenerationContents::new(
                        staged,
                        GenerationFacts {
                            documents: vec![copy_probe_document()],
                            ..GenerationFacts::default()
                        },
                    ))
                    .await
                    .map_err(|_| PipelineFailure::new(PipelineStage::Copy))
            })
            .await
    });
    wait_for_lease(&fixture.database, &target).await;
    wait_for_schema_lock(&fixture.pool, &fixture.schema, "search_documents").await;
    let mut lease_lock = match fixture.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => panic!("combined uncertainty lease-lock transaction failed: {error}"),
    };
    let lease_lock_statement = format!(
        r#"SELECT lease_id FROM "{}"."project_operation_leases"
            WHERE project_id = CAST($1 AS uuid) AND operation = $2
            FOR UPDATE"#,
        fixture.schema
    );
    if let Err(error) = query(AssertSqlSafe(lease_lock_statement))
        .bind(target.project_id().as_str())
        .bind(target.operation().as_str())
        .fetch_one(&mut *lease_lock)
        .await
    {
        panic!("combined uncertainty lease row lock failed: {error}");
    }
    let result = match tokio::time::timeout(ABORT_RESULT_BOUND, handle).await {
        Ok(result) => match result {
            Ok(result) => result,
            Err(error) => panic!("combined uncertainty supervisor task failed: {error}"),
        },
        Err(_) => panic!("heartbeat uncertainty did not reap blocked COPY before its bound"),
    };
    assert!(matches!(
        result,
        Err(SupervisorError::Cancelled {
            reason: CancellationReason::LeaseHeartbeatFailed,
            grace_exceeded: false
        })
    ));
    assert_no_active_schema_work(&fixture).await;
    assert_generation_advisories_available(&fixture, &target).await;
    assert!(lease_lock.rollback().await.is_ok());
    assert!(table_lock.rollback().await.is_ok());
    assert_generation_state(&fixture, &generation_id, GenerationState::Staging).await;
    expire_lease(&fixture, &target).await;
    fail_recoverable_generation(&fixture, &generation_id).await;

    fixture.close().await;
}

fn standard_config() -> SupervisorConfig {
    SupervisorConfig::new(STANDARD_OPERATION_TIMEOUT)
        .with_heartbeat_interval(STANDARD_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(STANDARD_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(STANDARD_PROGRESS_TIMEOUT)
        .with_cancellation_grace(STANDARD_CANCELLATION_GRACE)
        .with_copy_timeout(STANDARD_COPY_TIMEOUT)
}

fn stalled_config() -> SupervisorConfig {
    standard_config()
        .with_progress_timeout(STALLED_PROGRESS_TIMEOUT)
        .with_cancellation_grace(STANDARD_CANCELLATION_GRACE)
}

fn deadline_config() -> SupervisorConfig {
    SupervisorConfig::new(DEADLINE_TEST_TIMEOUT)
        .with_heartbeat_interval(STANDARD_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(DEADLINE_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(DEADLINE_PROGRESS_TIMEOUT)
        .with_cancellation_grace(DEADLINE_CANCELLATION_GRACE)
        .with_copy_timeout(DEADLINE_COPY_TIMEOUT)
}

fn boundary_config() -> SupervisorConfig {
    SupervisorConfig::new(BOUNDARY_OPERATION_TIMEOUT)
        .with_heartbeat_interval(BOUNDARY_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(BOUNDARY_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(BOUNDARY_PROGRESS_TIMEOUT)
        .with_cancellation_grace(BOUNDARY_CANCELLATION_GRACE)
        .with_copy_timeout(BOUNDARY_COPY_TIMEOUT)
}

fn uncertain_config() -> SupervisorConfig {
    SupervisorConfig::new(UNCERTAIN_OPERATION_TIMEOUT)
        .with_heartbeat_interval(UNCERTAIN_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(UNCERTAIN_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(UNCERTAIN_PROGRESS_TIMEOUT)
        .with_cancellation_grace(UNCERTAIN_CANCELLATION_GRACE)
        .with_copy_timeout(UNCERTAIN_COPY_TIMEOUT)
}

fn reconcile_config() -> SupervisorConfig {
    SupervisorConfig::new(RECONCILE_OPERATION_TIMEOUT)
        .with_heartbeat_interval(RECONCILE_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(RECONCILE_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(RECONCILE_PROGRESS_TIMEOUT)
        .with_cancellation_grace(RECONCILE_CANCELLATION_GRACE)
        .with_copy_timeout(RECONCILE_COPY_TIMEOUT)
}

fn abort_config() -> SupervisorConfig {
    SupervisorConfig::new(ABORT_OPERATION_TIMEOUT)
        .with_heartbeat_interval(ABORT_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(ABORT_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(ABORT_PROGRESS_TIMEOUT)
        .with_cancellation_grace(ABORT_CANCELLATION_GRACE)
        .with_copy_timeout(ABORT_COPY_TIMEOUT)
}

fn copy_cancel_config() -> SupervisorConfig {
    SupervisorConfig::new(COPY_CANCEL_OPERATION_TIMEOUT)
        .with_heartbeat_interval(ABORT_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(ABORT_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(ABORT_PROGRESS_TIMEOUT)
        .with_cancellation_grace(COPY_CANCEL_GRACE)
        .with_copy_timeout(COPY_CANCEL_TIMEOUT)
}

fn long_copy_config() -> SupervisorConfig {
    SupervisorConfig::new(LONG_COPY_OPERATION_TIMEOUT)
        .with_heartbeat_interval(ABORT_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(ABORT_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(RECONCILE_PROGRESS_TIMEOUT)
        .with_cancellation_grace(ABORT_CANCELLATION_GRACE)
        .with_copy_timeout(LONG_COPY_TIMEOUT)
}

fn large_payload_copy_config() -> SupervisorConfig {
    SupervisorConfig::new(LONG_COPY_OPERATION_TIMEOUT)
        .with_heartbeat_interval(ABORT_HEARTBEAT_INTERVAL)
        .with_heartbeat_timeout(LARGE_COPY_HEARTBEAT_TIMEOUT)
        .with_progress_timeout(LARGE_COPY_PROGRESS_TIMEOUT)
        .with_cancellation_grace(ABORT_CANCELLATION_GRACE)
        .with_copy_timeout(LONG_COPY_TIMEOUT)
}

fn request(target: LeaseTarget) -> SupervisorRequest {
    request_with_duration(target, TEST_LEASE_DURATION)
}

fn request_with_duration(target: LeaseTarget, duration: Duration) -> SupervisorRequest {
    SupervisorRequest::new(
        target,
        LeaseOwner::new(process::id(), "supervisor-test-owner"),
        duration,
    )
}

struct DatabaseFixture {
    database: CartographDatabase,
    pool: sqlx_postgres::PgPool,
    schema: String,
    project: ProjectId,
}

struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

impl DatabaseFixture {
    async fn close(self) {
        drop(self.database);
        drop_schema(&self.pool, &self.schema).await;
        self.pool.close().await;
    }
}

async fn open_fixture() -> DatabaseFixture {
    let database_url = match env::var(TEST_DATABASE_URL_ENV) {
        Ok(database_url) => database_url,
        Err(_) => panic!("{TEST_DATABASE_URL_ENV} must be set for the ignored integration test"),
    };
    let schema = format!(
        "cartograph_supervisor_it_{}_{}",
        process::id(),
        SCHEMA_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let settings = DatabaseSettings::parse(&database_url, Some("8"), Some("10000"))
        .and_then(|settings| settings.with_schema(&schema));
    let settings = match settings {
        Ok(settings) => settings,
        Err(error) => panic!("supervisor test settings failed validation: {error}"),
    };
    let pool = match cartograph_db::connect(&settings).await {
        Ok(pool) => pool,
        Err(error) => panic!("supervisor test database connection failed: {error}"),
    };
    let database = CartographDatabase::new(pool.clone(), settings.schema().clone());
    if let Err(error) = database.migrate().await {
        panic!("supervisor test migration failed: {error}");
    }
    let project = match database
        .register_project(NewProject::new(
            format!("workspace/supervisor/{schema}"),
            digest(PROJECT_FINGERPRINT),
        ))
        .await
    {
        Ok(project) => project,
        Err(error) => panic!("supervisor test project registration failed: {error}"),
    };
    DatabaseFixture {
        database,
        pool,
        schema,
        project,
    }
}

async fn begin_generation(fixture: &DatabaseFixture) -> cartograph_db::StagedGeneration {
    match fixture
        .database
        .begin_generation(NewGeneration::new(
            fixture.project.clone(),
            REVISION,
            WORKER_COUNT,
        ))
        .await
    {
        Ok(staged) => staged,
        Err(error) => panic!("supervisor fixture generation failed to begin: {error}"),
    }
}

fn target(project: &ProjectId, generation: &GenerationId) -> LeaseTarget {
    LeaseTarget::new(
        project.clone(),
        ProjectOperation::Index,
        Some(generation.clone()),
    )
}

async fn wait_for_lease(database: &CartographDatabase, target: &LeaseTarget) {
    for _ in 0..LEASE_WAIT_ATTEMPTS {
        if matches!(database.lease_status(target).await, Ok(Some(_))) {
            return;
        }
        tokio::time::sleep(LEASE_WAIT_INTERVAL).await;
    }
    panic!("supervisor did not acquire its lease before the test deadline");
}

async fn wait_for_database_lock(pool: &sqlx_postgres::PgPool, schema: &str) {
    wait_for_schema_lock(pool, schema, "project_operation_leases").await;
}

async fn wait_for_schema_lock(pool: &sqlx_postgres::PgPool, schema: &str, relation: &str) {
    let pattern = format!("%{schema}%{relation}%");
    for _ in 0..LEASE_WAIT_ATTEMPTS {
        let row = query(
            r#"SELECT EXISTS (
                    SELECT 1 FROM pg_stat_activity
                    WHERE application_name = 'cartograph-v2'
                      AND state = 'active'
                      AND wait_event_type = 'Lock'
                      AND query ILIKE $1
                )"#,
        )
        .bind(&pattern)
        .fetch_one(pool)
        .await;
        if matches!(row, Ok(row) if row.try_get::<bool, _>(0).unwrap_or(false)) {
            return;
        }
        tokio::time::sleep(LEASE_WAIT_INTERVAL).await;
    }
    panic!("database operation did not reach the expected lock wait");
}

async fn wait_for_query_absent(pool: &sqlx_postgres::PgPool, schema: &str, query_fragment: &str) {
    let schema_pattern = format!("%{schema}%");
    for _ in 0..LEASE_WAIT_ATTEMPTS {
        let row = query(
            r#"SELECT NOT EXISTS (
                    SELECT 1 FROM pg_stat_activity
                    WHERE application_name = 'cartograph-v2'
                      AND state = 'active'
                      AND query ILIKE $1
                      AND query ILIKE $2
                )"#,
        )
        .bind(&schema_pattern)
        .bind(query_fragment)
        .fetch_one(pool)
        .await;
        if matches!(row, Ok(row) if row.try_get::<bool, _>(0).unwrap_or(false)) {
            return;
        }
        tokio::time::sleep(LEASE_WAIT_INTERVAL).await;
    }
    panic!("supervisor database query remained active after task reaping");
}

async fn assert_no_active_schema_work(fixture: &DatabaseFixture) {
    wait_for_query_absent(&fixture.pool, &fixture.schema, "%").await;
}

async fn assert_generation_advisories_available(fixture: &DatabaseFixture, target: &LeaseTarget) {
    let generation_id = match target.generation_id() {
        Some(generation_id) => generation_id,
        None => panic!("advisory-lock fixture requires a generation-bound target"),
    };
    let operation_key = format!(
        "cartograph-v2-operation:{}:{}:{}",
        fixture.schema,
        target.project_id(),
        target.operation().as_str()
    );
    let generation_key = format!(
        "cartograph-v2-generation:{}:{}:{}",
        fixture.schema,
        target.project_id(),
        generation_id
    );
    let mut connection = match fixture.pool.acquire().await {
        Ok(connection) => connection,
        Err(error) => panic!("advisory-lock probe connection failed: {error}"),
    };
    let acquired = query(
        r#"SELECT
                pg_try_advisory_lock(hashtextextended($1, 0)),
                pg_try_advisory_lock(hashtextextended($2, 0))"#,
    )
    .bind(&operation_key)
    .bind(&generation_key)
    .fetch_one(&mut *connection)
    .await;
    let acquired =
        acquired.and_then(|row| Ok((row.try_get::<bool, _>(0)?, row.try_get::<bool, _>(1)?)));
    let released = query(
        r#"SELECT
                pg_advisory_unlock(hashtextextended($1, 0)),
                pg_advisory_unlock(hashtextextended($2, 0))"#,
    )
    .bind(&operation_key)
    .bind(&generation_key)
    .execute(&mut *connection)
    .await;
    assert!(released.is_ok());
    assert!(matches!(acquired, Ok((true, true))));
}

async fn wait_for_supervisor_stage(supervisor: &IndexerSupervisor, expected: PipelineStage) {
    for _ in 0..LEASE_WAIT_ATTEMPTS {
        if supervisor.status().await.stage() == Some(expected) {
            return;
        }
        tokio::time::sleep(LEASE_WAIT_INTERVAL).await;
    }
    panic!("supervisor did not reach its expected pipeline stage");
}

async fn wait_for_supervisor_state(supervisor: &IndexerSupervisor, expected: SupervisorState) {
    for _ in 0..LEASE_WAIT_ATTEMPTS {
        if supervisor.status().await.state() == expected {
            return;
        }
        tokio::time::sleep(LEASE_WAIT_INTERVAL).await;
    }
    panic!("supervisor did not reach its expected terminal state");
}

async fn install_one_shot_publish_delay(fixture: &DatabaseFixture) {
    let sequence = format!(
        r#"CREATE SEQUENCE "{}"."publish_delay_sequence""#,
        fixture.schema
    );
    let function = format!(
        r#"CREATE FUNCTION "{}"."delay_first_publish"()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $delay$
            BEGIN
                IF nextval('"{}"."publish_delay_sequence"'::regclass) = 1 THEN
                    PERFORM pg_sleep({FIRST_MUTATION_DELAY_SECONDS});
                END IF;
                RETURN NEW;
            END
            $delay$"#,
        fixture.schema, fixture.schema
    );
    let trigger = format!(
        r#"CREATE TRIGGER delay_first_publish
            BEFORE UPDATE OF current_generation_id
            ON "{}"."projects"
            FOR EACH ROW EXECUTE FUNCTION "{}"."delay_first_publish"()"#,
        fixture.schema, fixture.schema
    );
    for statement in [sequence, function, trigger] {
        if let Err(error) = query(AssertSqlSafe(statement)).execute(&fixture.pool).await {
            panic!("could not install one-shot publication delay: {error}");
        }
    }
}

async fn install_one_shot_acquisition_delay(fixture: &DatabaseFixture) {
    let sequence = format!(
        r#"CREATE SEQUENCE "{}"."acquisition_delay_sequence""#,
        fixture.schema
    );
    let function = format!(
        r#"CREATE FUNCTION "{}"."delay_first_acquisition"()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $delay$
            BEGIN
                IF nextval('"{}"."acquisition_delay_sequence"'::regclass) = 1 THEN
                    PERFORM pg_sleep({FIRST_MUTATION_DELAY_SECONDS});
                END IF;
                RETURN NEW;
            END
            $delay$"#,
        fixture.schema, fixture.schema
    );
    let trigger = format!(
        r#"CREATE TRIGGER delay_first_acquisition
            BEFORE INSERT
            ON "{}"."project_operation_leases"
            FOR EACH ROW EXECUTE FUNCTION "{}"."delay_first_acquisition"()"#,
        fixture.schema, fixture.schema
    );
    for statement in [sequence, function, trigger] {
        if let Err(error) = query(AssertSqlSafe(statement)).execute(&fixture.pool).await {
            panic!("could not install one-shot acquisition delay: {error}");
        }
    }
}

async fn install_one_shot_cleanup_delay(fixture: &DatabaseFixture) {
    let sequence = format!(
        r#"CREATE SEQUENCE "{}"."cleanup_delay_sequence""#,
        fixture.schema
    );
    let function = format!(
        r#"CREATE FUNCTION "{}"."delay_first_cleanup"()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $delay$
            BEGIN
                IF NEW.state = 'failed'
                   AND nextval('"{}"."cleanup_delay_sequence"'::regclass) = 1 THEN
                    PERFORM pg_sleep({FIRST_MUTATION_DELAY_SECONDS});
                END IF;
                RETURN NEW;
            END
            $delay$"#,
        fixture.schema, fixture.schema
    );
    let trigger = format!(
        r#"CREATE TRIGGER delay_first_cleanup
            BEFORE UPDATE OF state
            ON "{}"."index_generations"
            FOR EACH ROW EXECUTE FUNCTION "{}"."delay_first_cleanup"()"#,
        fixture.schema, fixture.schema
    );
    for statement in [sequence, function, trigger] {
        if let Err(error) = query(AssertSqlSafe(statement)).execute(&fixture.pool).await {
            panic!("could not install one-shot cleanup delay: {error}");
        }
    }
}

async fn install_copy_delay(fixture: &DatabaseFixture) {
    let function = format!(
        r#"CREATE FUNCTION "{}"."delay_search_document_copy"()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $delay$
            BEGIN
                PERFORM pg_sleep({LONG_COPY_TRIGGER_DELAY_SECONDS});
                RETURN NULL;
            END
            $delay$"#,
        fixture.schema
    );
    let trigger = format!(
        r#"CREATE TRIGGER delay_search_document_copy
            AFTER INSERT ON "{}"."search_documents"
            FOR EACH STATEMENT
            EXECUTE FUNCTION "{}"."delay_search_document_copy"()"#,
        fixture.schema, fixture.schema
    );
    for statement in [function, trigger] {
        if let Err(error) = query(AssertSqlSafe(statement)).execute(&fixture.pool).await {
            panic!("could not install long-COPY delay: {error}");
        }
    }
}

async fn expire_lease(fixture: &DatabaseFixture, target: &LeaseTarget) {
    let statement = format!(
        r#"UPDATE "{}"."project_operation_leases"
            SET acquired_at = clock_timestamp() - interval '3 seconds',
                heartbeat_at = clock_timestamp() - interval '2 seconds',
                expires_at = clock_timestamp() - interval '1 second'
            WHERE project_id = CAST($1 AS uuid) AND operation = $2"#,
        fixture.schema,
    );
    if let Err(error) = query(AssertSqlSafe(statement))
        .bind(target.project_id().as_str())
        .bind(target.operation().as_str())
        .execute(&fixture.pool)
        .await
    {
        panic!("could not expire supervisor lease fixture: {error}");
    }
}

async fn assert_generation_state(
    fixture: &DatabaseFixture,
    generation: &GenerationId,
    expected: GenerationState,
) {
    assert!(matches!(
        fixture
            .database
            .generation_state(&fixture.project, generation)
            .await,
        Ok(Some(state)) if state == expected
    ));
}

async fn fail_recoverable_generation(fixture: &DatabaseFixture, generation: &GenerationId) {
    let recovered = match fixture
        .database
        .recover_generation(&fixture.project, generation)
        .await
    {
        Ok(Some(recovered)) => recovered,
        Ok(None) => panic!("staging generation was not recoverable after lease takeover"),
        Err(error) => panic!("generation recovery after lease takeover failed: {error}"),
    };
    let lease = match fixture
        .database
        .acquire_lease(LeaseRequest::new(
            target(&fixture.project, generation),
            LeaseOwner::new(process::id(), "supervisor-cleanup-owner"),
            TEST_LEASE_DURATION,
        ))
        .await
    {
        Ok(lease) => lease,
        Err(error) => panic!("cleanup lease acquisition failed: {error}"),
    };
    assert!(
        fixture
            .database
            .fail_generation(recovered, &lease.fence())
            .await
            .is_ok()
    );
    assert!(fixture.database.release_lease(&lease).await.is_ok());
}

async fn join<T>(handle: tokio::task::JoinHandle<T>) -> T {
    match handle.await {
        Ok(result) => result,
        Err(error) => panic!("supervisor task did not join cleanly: {error}"),
    }
}

async fn drop_schema(pool: &sqlx_postgres::PgPool, schema: &str) {
    let statement = format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE");
    if let Err(error) = query(AssertSqlSafe(statement)).execute(pool).await {
        panic!("failed to drop isolated supervisor schema: {error}");
    }
}

fn digest(raw: &str) -> ContentDigest {
    match ContentDigest::parse(raw) {
        Ok(digest) => digest,
        Err(error) => panic!("fixture digest is invalid: {error}"),
    }
}

fn copy_probe_document() -> SearchDocumentInput {
    let document_id = match DocumentId::parse(COPY_PROBE_DOCUMENT) {
        Ok(document_id) => document_id,
        Err(error) => panic!("COPY probe document ID is invalid: {error}"),
    };
    SearchDocumentInput {
        document_id,
        file_id: None,
        symbol_id: None,
        path: "src/supervised_copy.rs".to_owned(),
        language: "rust".to_owned(),
        kind: DocumentKind::Symbol,
        qualified_name: "supervised_copy_probe".to_owned(),
        code: "fn supervised_copy_probe() {}".to_owned(),
        natural_text: "supervised COPY cancellation probe".to_owned(),
        metadata: serde_json::json!({}),
    }
}

fn large_copy_probe_document() -> SearchDocumentInput {
    let mut document = copy_probe_document();
    document.code = "x".repeat(LONG_COPY_CODE_BYTES);
    document.natural_text = "large payload COPY deadline probe".to_owned();
    document
}
