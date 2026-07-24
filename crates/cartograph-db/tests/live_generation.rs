use std::{
    env, process,
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

use cartograph_config::DatabaseSettings;
use cartograph_db::{
    CanonicalGenerationFacts, CartographDatabase, CurrentGeneration, FailGenerationError,
    FailedGeneration, GenerationContents, GenerationFacts, GenerationValidationError,
    GenerationValidationLimits, LeaseOwner, LeaseRequest, LeaseTarget, MigrationError,
    NewGeneration, NewProject, PrepareGenerationError, ProjectLease, PublishGenerationError,
    ReadyGeneration, RecoverableGeneration, SearchDocumentInput, SearchQuery, StorageError,
    validate_generation_facts,
};
use cartograph_domain::{
    ContentDigest, DocumentId, DocumentKind, GenerationId, GenerationState, ProjectId,
    ProjectOperation,
};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

const TEST_DATABASE_URL_ENV: &str = "CARTOGRAPH_TEST_DATABASE_URL";
const REVISION_ONE: &str = "1111111111111111111111111111111111111111";
const REVISION_TWO: &str = "2222222222222222222222222222222222222222";
const REVISION_THREE: &str = "3333333333333333333333333333333333333333";
const REVISION_FOUR: &str = "4444444444444444444444444444444444444444";
const REVISION_FIVE: &str = "5555555555555555555555555555555555555555";
const DIGEST_ONE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const DOCUMENT_ONE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOCUMENT_TWO: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOCUMENT_THREE: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DOCUMENT_FOUR: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INITIAL_MIGRATION_VERSION: i64 = 1;
const OPERATION_LEASES_MIGRATION_VERSION: i64 = 2;
const COMPLETE_EDGE_KINDS_MIGRATION_VERSION: i64 = 3;
const REFERENCE_EVIDENCE_MIGRATION_VERSION: i64 = 4;
const DIGEST_VERSION_MIGRATION_VERSION: i64 = 5;
const LATEST_MIGRATION_VERSION: i64 = 6;
const EXPECTED_MIGRATIONS: [i64; 6] = [
    INITIAL_MIGRATION_VERSION,
    OPERATION_LEASES_MIGRATION_VERSION,
    COMPLETE_EDGE_KINDS_MIGRATION_VERSION,
    REFERENCE_EVIDENCE_MIGRATION_VERSION,
    DIGEST_VERSION_MIGRATION_VERSION,
    LATEST_MIGRATION_VERSION,
];
const INITIAL_WORKERS: u16 = 4;
const REPLACEMENT_WORKERS: u16 = 8;
const RECOVERY_WORKERS: u16 = 2;
const SEARCH_LIMIT: u16 = 10;
const TEST_LEASE_DURATION: Duration = Duration::from_secs(30);
const LOCK_ORDER_TIMEOUT: Duration = Duration::from_secs(5);
const LOCK_OBSERVATION_ATTEMPTS: usize = 100;
const TEST_VALIDATION_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const TEST_VALIDATION_WORKING_BYTES: u64 = 256 * 1024 * 1024;
const LOCK_OBSERVATION_INTERVAL: Duration = Duration::from_millis(20);

static SCHEMA_COUNTER: AtomicU32 = AtomicU32::new(0);

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn migrations_are_idempotent_and_only_published_generations_are_searchable() {
    let (database, pool, schema) = open_isolated_database().await;
    assert_migration_ledger(&database).await;
    let project = register_project(&database).await;
    let current_one = publish_initial_generation(&database, &project).await;
    let ready_older =
        prepare_rollback_retry(&database, &project, current_one.generation_id()).await;
    let current_two = publish_newer_generation(&database, &project, &ready_older).await;
    reject_stale_publication(&database, ready_older).await;
    assert_state(
        &database,
        StateExpectation::new(
            &project,
            current_one.generation_id(),
            GenerationState::Superseded,
        ),
    )
    .await;
    assert_state(
        &database,
        StateExpectation::new(
            &project,
            current_two.generation_id(),
            GenerationState::Current,
        ),
    )
    .await;
    assert_search(
        &database,
        SearchExpectation::empty(&project, "http response"),
    )
    .await;
    assert_search(
        &database,
        SearchExpectation::one(
            &project,
            "json payload",
            ExpectedHit {
                document_id: DOCUMENT_THREE,
                generation_id: current_two.generation_id(),
            },
        ),
    )
    .await;
    assert_restart_recovery(&database, &project).await;
    assert_validation_token_return(&database, &project).await;
    assert_ledger_tampering_is_refused(&database, &pool, &schema).await;

    drop(database);
    drop_schema(&pool, &schema).await;
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn stale_fences_cannot_prepare_or_publish_after_exact_token_takeover() {
    let (database, pool, schema) = open_isolated_database().await;
    assert_migration_ledger(&database).await;
    let project = register_project(&database).await;
    let staged = begin(
        &database,
        GenerationFixture {
            project: &project,
            revision: REVISION_ONE,
            workers: INITIAL_WORKERS,
        },
    )
    .await;
    let generation_id = staged.generation_id().clone();
    let target = LeaseTarget::new(
        project.clone(),
        ProjectOperation::Index,
        Some(generation_id.clone()),
    );
    let stale_prepare_lease = acquire_generation_lease(&database, &project, &generation_id).await;
    expire_generation_lease(&pool, &schema, &target).await;
    let prepare_lease = acquire_generation_lease(&database, &project, &generation_id).await;
    install_copy_rejection_sentinel(&pool, &schema).await;
    let stale_prepare = database
        .prepare_generation(
            GenerationContents::new(
                staged,
                canonical(GenerationFacts {
                    documents: vec![document(DocumentFixture {
                        id: DOCUMENT_ONE,
                        path: "src/stale_copy.rs",
                        qualified_name: "stale_copy_probe",
                        code: "fn stale_copy_probe() {}",
                    })],
                    ..GenerationFacts::default()
                }),
            ),
            &stale_prepare_lease.fence(),
        )
        .await;
    remove_copy_rejection_sentinel(&pool, &schema).await;
    let staged = match stale_prepare {
        Err(error) if *error.error() == StorageError::LeaseFenceLost => error.into_parts().0,
        Err(error) => panic!("stale prepare fence returned wrong error: {error}"),
        Ok(_) => panic!("stale prepare fence committed after takeover"),
    };
    let ready = match database
        .prepare_generation(
            GenerationContents::new(staged, canonical(GenerationFacts::default())),
            &prepare_lease.fence(),
        )
        .await
    {
        Ok(ready) => ready,
        Err(error) => panic!("current prepare fence failed: {error}"),
    };
    expire_generation_lease(&pool, &schema, &target).await;
    let publish_lease = acquire_generation_lease(&database, &project, &generation_id).await;
    let ready = match database
        .publish_generation(ready, &prepare_lease.fence())
        .await
    {
        Err(error) if *error.error() == StorageError::LeaseFenceLost => error.into_parts().0,
        Err(error) => panic!("stale publish fence returned wrong error: {error}"),
        Ok(_) => panic!("stale publish fence committed after takeover"),
    };
    let current = match database
        .publish_generation(ready, &publish_lease.fence())
        .await
    {
        Ok(current) => current,
        Err(error) => panic!("current publish fence failed: {error}"),
    };
    assert_eq!(current.generation_id(), &generation_id);
    assert!(matches!(database.lease_status(&target).await, Ok(None)));

    drop(database);
    drop_schema(&pool, &schema).await;
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn concurrent_prepare_and_cleanup_share_one_pre_copy_lock_order() {
    let (database, pool, schema) = open_isolated_database().await;
    assert_migration_ledger(&database).await;
    let project = register_project(&database).await;
    let staged = begin(
        &database,
        GenerationFixture {
            project: &project,
            revision: REVISION_ONE,
            workers: INITIAL_WORKERS,
        },
    )
    .await;
    let generation_id = staged.generation_id().clone();
    let target = LeaseTarget::new(
        project.clone(),
        ProjectOperation::Index,
        Some(generation_id.clone()),
    );
    let lease = acquire_generation_lease(&database, &project, &generation_id).await;
    let fence = lease.fence();
    let barrier_key = format!("cartograph-test-copy-barrier:{schema}");
    install_copy_barrier(&pool, &schema, &barrier_key).await;
    let mut barrier = match pool.acquire().await {
        Ok(connection) => connection,
        Err(error) => panic!("could not acquire COPY barrier connection: {error}"),
    };
    if let Err(error) = query("SELECT pg_advisory_lock(hashtextextended($1, 0))")
        .bind(&barrier_key)
        .execute(&mut *barrier)
        .await
    {
        panic!("could not establish COPY barrier: {error}");
    }

    let prepare_fence = fence.clone();
    let prepare_database = database.clone();
    let prepare = prepare_database.prepare_generation(
        GenerationContents::new(
            staged,
            canonical(GenerationFacts {
                documents: vec![document(DocumentFixture {
                    id: DOCUMENT_ONE,
                    path: "src/lock_order.rs",
                    qualified_name: "lock_order_probe",
                    code: "fn lock_order_probe() {}",
                })],
                ..GenerationFacts::default()
            }),
        ),
        &prepare_fence,
    );
    tokio::pin!(prepare);
    let cleanup_fence = fence.clone();
    let cleanup_database = database.clone();
    let concurrent_cleanup = async {
        wait_for_copy_barrier(&pool, &schema).await;
        let cleanup = cleanup_database.fail_generation_and_release(&cleanup_fence);
        tokio::pin!(cleanup);
        assert!(
            tokio::time::timeout(LOCK_OBSERVATION_INTERVAL, &mut cleanup)
                .await
                .is_err()
        );
        if let Err(error) = query("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
            .bind(&barrier_key)
            .execute(&mut *barrier)
            .await
        {
            panic!("could not release COPY barrier: {error}");
        }
        cleanup.await
    };
    let joined = tokio::time::timeout(LOCK_ORDER_TIMEOUT, async {
        tokio::join!(&mut prepare, concurrent_cleanup)
    })
    .await;
    let (prepare, cleanup) = match joined {
        Ok(joined) => joined,
        Err(_) => panic!("prepare and cleanup deadlocked across COPY foreign-key locks"),
    };
    assert!(prepare.is_ok());
    assert!(cleanup.is_ok());
    assert!(matches!(
        database.generation_state(&project, &generation_id).await,
        Ok(Some(GenerationState::Failed))
    ));
    assert!(matches!(database.lease_status(&target).await, Ok(None)));

    drop(barrier);
    drop(database);
    drop_schema(&pool, &schema).await;
    pool.close().await;
}

async fn install_copy_barrier(pool: &sqlx_postgres::PgPool, schema: &str, barrier_key: &str) {
    let function = format!(
        r#"CREATE FUNCTION "{schema}"."block_search_document_copy"()
            RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                PERFORM pg_advisory_xact_lock(hashtextextended('{barrier_key}', 0));
                RETURN NULL;
            END
            $body$"#
    );
    if let Err(error) = query(AssertSqlSafe(function)).execute(pool).await {
        panic!("could not install COPY barrier function: {error}");
    }
    let trigger = format!(
        r#"CREATE TRIGGER "block_search_document_copy"
            AFTER INSERT ON "{schema}"."search_documents"
            FOR EACH STATEMENT
            EXECUTE FUNCTION "{schema}"."block_search_document_copy"()"#
    );
    if let Err(error) = query(AssertSqlSafe(trigger)).execute(pool).await {
        panic!("could not install COPY barrier trigger: {error}");
    }
}

async fn install_copy_rejection_sentinel(pool: &sqlx_postgres::PgPool, schema: &str) {
    let function = format!(
        r#"CREATE FUNCTION "{schema}"."reject_stale_search_document_copy"()
            RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                RAISE EXCEPTION 'stale lease reached COPY';
            END
            $body$"#
    );
    if let Err(error) = query(AssertSqlSafe(function)).execute(pool).await {
        panic!("could not install stale-COPY sentinel function: {error}");
    }
    let trigger = format!(
        r#"CREATE TRIGGER "reject_stale_search_document_copy"
            BEFORE INSERT ON "{schema}"."search_documents"
            FOR EACH STATEMENT
            EXECUTE FUNCTION "{schema}"."reject_stale_search_document_copy"()"#
    );
    if let Err(error) = query(AssertSqlSafe(trigger)).execute(pool).await {
        panic!("could not install stale-COPY sentinel trigger: {error}");
    }
}

async fn remove_copy_rejection_sentinel(pool: &sqlx_postgres::PgPool, schema: &str) {
    let trigger = format!(
        r#"DROP TRIGGER "reject_stale_search_document_copy"
            ON "{schema}"."search_documents""#
    );
    if let Err(error) = query(AssertSqlSafe(trigger)).execute(pool).await {
        panic!("could not remove stale-COPY sentinel trigger: {error}");
    }
    let function = format!(r#"DROP FUNCTION "{schema}"."reject_stale_search_document_copy"()"#);
    if let Err(error) = query(AssertSqlSafe(function)).execute(pool).await {
        panic!("could not remove stale-COPY sentinel function: {error}");
    }
}

async fn wait_for_copy_barrier(pool: &sqlx_postgres::PgPool, schema: &str) {
    let query_pattern = format!("%{schema}%search_documents%");
    for _ in 0..LOCK_OBSERVATION_ATTEMPTS {
        let row = query(
            r#"SELECT EXISTS (
                    SELECT 1 FROM pg_stat_activity
                    WHERE application_name = 'cartograph-v2'
                      AND wait_event_type = 'Lock'
                      AND query LIKE $1
                ) AS waiting"#,
        )
        .bind(&query_pattern)
        .fetch_one(pool)
        .await;
        if matches!(
            row.and_then(|row| row.try_get::<bool, _>("waiting")),
            Ok(true)
        ) {
            return;
        }
        tokio::time::sleep(LOCK_OBSERVATION_INTERVAL).await;
    }
    panic!("prepare COPY did not reach the deterministic advisory barrier");
}

struct DocumentFixture<'a> {
    id: &'a str,
    path: &'a str,
    qualified_name: &'a str,
    code: &'a str,
}

struct StateExpectation<'a> {
    project: &'a ProjectId,
    generation: &'a GenerationId,
    state: GenerationState,
}

struct GenerationFixture<'a> {
    project: &'a ProjectId,
    revision: &'a str,
    workers: u16,
}

struct PrepareFixture {
    staged: cartograph_db::StagedGeneration,
    document: SearchDocumentInput,
}

struct ExpectedHit<'a> {
    document_id: &'a str,
    generation_id: &'a GenerationId,
}

impl<'a> StateExpectation<'a> {
    const fn new(
        project: &'a ProjectId,
        generation: &'a GenerationId,
        state: GenerationState,
    ) -> Self {
        Self {
            project,
            generation,
            state,
        }
    }
}

struct SearchExpectation<'a> {
    project: &'a ProjectId,
    query: &'a str,
    document_id: Option<&'a str>,
    generation_id: Option<&'a GenerationId>,
}

impl<'a> SearchExpectation<'a> {
    const fn empty(project: &'a ProjectId, query: &'a str) -> Self {
        Self {
            project,
            query,
            document_id: None,
            generation_id: None,
        }
    }

    const fn one(project: &'a ProjectId, query: &'a str, hit: ExpectedHit<'a>) -> Self {
        Self {
            project,
            query,
            document_id: Some(hit.document_id),
            generation_id: Some(hit.generation_id),
        }
    }
}

async fn assert_migration_ledger(database: &CartographDatabase) {
    let first = match database.migrate().await {
        Ok(report) => report,
        Err(error) => panic!("initial migration failed: {error}"),
    };
    assert_eq!(first.applied_versions, EXPECTED_MIGRATIONS);
    assert_eq!(first.current_version, LATEST_MIGRATION_VERSION);
    assert!(matches!(
        database.migrate().await,
        Ok(report)
            if report.applied_versions.is_empty()
                && report.current_version == LATEST_MIGRATION_VERSION
    ));
}

async fn register_project(database: &CartographDatabase) -> ProjectId {
    match database
        .register_project(NewProject::new("workspace/cartograph", digest(DIGEST_ONE)))
        .await
    {
        Ok(project) => project,
        Err(error) => panic!("project registration failed: {error}"),
    }
}

async fn publish_initial_generation(
    database: &CartographDatabase,
    project: &ProjectId,
) -> CurrentGeneration {
    let staged = begin(
        database,
        GenerationFixture {
            project,
            revision: REVISION_ONE,
            workers: INITIAL_WORKERS,
        },
    )
    .await;
    let ready = prepare(
        database,
        PrepareFixture {
            staged,
            document: document(DocumentFixture {
                id: DOCUMENT_ONE,
                path: "src/http_parser.rs",
                qualified_name: "parseHTTPResponse",
                code: "fn parse_http_response() -> Response { todo!() }",
            }),
        },
    )
    .await;
    assert_search(database, SearchExpectation::empty(project, "http response")).await;
    let current = match publish_fenced(database, ready).await {
        Ok(generation) => generation,
        Err(error) => panic!("first generation did not publish: {error}"),
    };
    assert_search(
        database,
        SearchExpectation::one(
            project,
            "http response",
            ExpectedHit {
                document_id: DOCUMENT_ONE,
                generation_id: current.generation_id(),
            },
        ),
    )
    .await;
    current
}

async fn prepare_rollback_retry(
    database: &CartographDatabase,
    project: &ProjectId,
    current_generation_id: &GenerationId,
) -> ReadyGeneration {
    let staged = begin(
        database,
        GenerationFixture {
            project,
            revision: REVISION_TWO,
            workers: REPLACEMENT_WORKERS,
        },
    )
    .await;
    let generation_id = staged.generation_id().clone();
    let duplicate = document(DocumentFixture {
        id: DOCUMENT_TWO,
        path: "src/new_parser.rs",
        qualified_name: "decodeJSONPayload",
        code: "fn decode_json_payload() {}",
    });
    let mut conflicting = duplicate.clone();
    conflicting.code = "fn decode_json_payload() { unreachable!() }".to_owned();
    let invalid = validate_for_test(GenerationFacts {
        documents: vec![duplicate.clone(), conflicting],
        ..GenerationFacts::default()
    });
    assert!(matches!(
        invalid,
        Err(GenerationValidationError::Storage(
            StorageError::InvalidInput {
                field: "duplicate_document_id"
            }
        ))
    ));
    assert_state(
        database,
        StateExpectation::new(project, &generation_id, GenerationState::Staging),
    )
    .await;
    assert_search(
        database,
        SearchExpectation::one(
            project,
            "http response",
            ExpectedHit {
                document_id: DOCUMENT_ONE,
                generation_id: current_generation_id,
            },
        ),
    )
    .await;
    prepare(
        database,
        PrepareFixture {
            staged,
            document: duplicate,
        },
    )
    .await
}

async fn publish_newer_generation(
    database: &CartographDatabase,
    project: &ProjectId,
    ready_older: &ReadyGeneration,
) -> CurrentGeneration {
    let staged = begin(
        database,
        GenerationFixture {
            project,
            revision: REVISION_THREE,
            workers: REPLACEMENT_WORKERS,
        },
    )
    .await;
    assert!(staged.sequence() > ready_older.sequence());
    let ready = prepare(
        database,
        PrepareFixture {
            staged,
            document: document(DocumentFixture {
                id: DOCUMENT_THREE,
                path: "src/json_decoder.rs",
                qualified_name: "decodeJSONPayload",
                code: "fn decode_json_payload() {}",
            }),
        },
    )
    .await;
    match publish_fenced(database, ready).await {
        Ok(generation) => generation,
        Err(error) => panic!("newer generation did not publish: {error}"),
    }
}

async fn reject_stale_publication(database: &CartographDatabase, ready: ReadyGeneration) {
    let ready = match publish_fenced(database, ready).await {
        Err(error) => {
            assert!(matches!(
                error.error(),
                StorageError::StaleGeneration { .. }
            ));
            error.into_parts().0
        }
        Ok(_) => panic!("older ready generation replaced a newer current generation"),
    };
    assert!(
        fail_fenced(database, RecoverableGeneration::Ready(ready))
            .await
            .is_ok()
    );
}

async fn assert_restart_recovery(database: &CartographDatabase, project: &ProjectId) {
    let staged = begin(
        database,
        GenerationFixture {
            project,
            revision: REVISION_FOUR,
            workers: RECOVERY_WORKERS,
        },
    )
    .await;
    let generation_id = staged.generation_id().clone();
    drop(staged);
    let recovered = match database.recover_generation(project, &generation_id).await {
        Ok(Some(RecoverableGeneration::Staged(generation))) => generation,
        Ok(_) => panic!("staging generation was not recoverable after token loss"),
        Err(error) => panic!("generation recovery failed: {error}"),
    };
    assert!(
        fail_fenced(database, RecoverableGeneration::Staged(recovered))
            .await
            .is_ok()
    );
    assert_state(
        database,
        StateExpectation::new(project, &generation_id, GenerationState::Failed),
    )
    .await;
}

async fn assert_validation_token_return(database: &CartographDatabase, project: &ProjectId) {
    let staged = begin(
        database,
        GenerationFixture {
            project,
            revision: REVISION_FIVE,
            workers: RECOVERY_WORKERS,
        },
    )
    .await;
    let mut invalid = document(DocumentFixture {
        id: DOCUMENT_FOUR,
        path: "src/empty.rs",
        qualified_name: "",
        code: "",
    });
    invalid.natural_text.clear();
    let invalid = validate_for_test(GenerationFacts {
        documents: vec![invalid],
        ..GenerationFacts::default()
    });
    assert!(matches!(
        invalid,
        Err(GenerationValidationError::Storage(
            StorageError::InvalidInput {
                field: "searchable_text"
            }
        ))
    ));
    assert!(
        fail_fenced(database, RecoverableGeneration::Staged(staged))
            .await
            .is_ok()
    );
}

async fn assert_state(database: &CartographDatabase, expected: StateExpectation<'_>) {
    let actual = database
        .generation_state(expected.project, expected.generation)
        .await;
    assert_eq!(actual.ok().flatten(), Some(expected.state));
}

async fn assert_search(database: &CartographDatabase, expected: SearchExpectation<'_>) {
    let hits = database
        .search_current_code(SearchQuery::new(
            expected.project.clone(),
            expected.query,
            SEARCH_LIMIT,
        ))
        .await;
    let hits = match hits {
        Ok(hits) => hits,
        Err(error) => panic!("BM25 search failed: {error}"),
    };
    match (expected.document_id, expected.generation_id) {
        (None, None) => assert!(hits.is_empty()),
        (Some(document_id), Some(generation_id)) => {
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].document_id().as_str(), document_id);
            assert_eq!(hits[0].generation_id(), generation_id);
            assert!(hits[0].score().is_finite() && hits[0].score().is_sign_positive());
        }
        _ => panic!("search expectation must contain both document and generation IDs"),
    }
}

async fn begin(
    database: &CartographDatabase,
    fixture: GenerationFixture<'_>,
) -> cartograph_db::StagedGeneration {
    match database
        .begin_generation(NewGeneration::new(
            fixture.project.clone(),
            fixture.revision,
            fixture.workers,
        ))
        .await
    {
        Ok(generation) => generation,
        Err(error) => panic!("generation did not begin: {error}"),
    }
}

async fn prepare(database: &CartographDatabase, fixture: PrepareFixture) -> ReadyGeneration {
    match prepare_fenced(
        database,
        fixture.staged,
        GenerationFacts {
            documents: vec![fixture.document],
            ..GenerationFacts::default()
        },
    )
    .await
    {
        Ok(generation) => generation,
        Err(error) => panic!("generation did not become ready: {error}"),
    }
}

async fn prepare_fenced(
    database: &CartographDatabase,
    staged: cartograph_db::StagedGeneration,
    facts: GenerationFacts,
) -> Result<ReadyGeneration, PrepareGenerationError> {
    let lease =
        acquire_generation_lease(database, staged.project_id(), staged.generation_id()).await;
    let fence = lease.fence();
    let result = database
        .prepare_generation(GenerationContents::new(staged, canonical(facts)), &fence)
        .await;
    assert!(database.release_lease(&lease).await.is_ok());
    result
}

fn canonical(facts: GenerationFacts) -> CanonicalGenerationFacts {
    validate_for_test(facts)
        .unwrap_or_else(|error| panic!("generation fixture was invalid: {error}"))
}

fn validate_for_test(
    facts: GenerationFacts,
) -> Result<CanonicalGenerationFacts, GenerationValidationError> {
    let limits = GenerationValidationLimits::new(
        TEST_VALIDATION_OUTPUT_BYTES,
        TEST_VALIDATION_WORKING_BYTES,
    )?;
    validate_generation_facts(facts, limits, || false).map(|(facts, _)| facts)
}

async fn publish_fenced(
    database: &CartographDatabase,
    ready: ReadyGeneration,
) -> Result<CurrentGeneration, PublishGenerationError> {
    let lease = acquire_generation_lease(database, ready.project_id(), ready.generation_id()).await;
    let fence = lease.fence();
    let result = database.publish_generation(ready, &fence).await;
    if result.is_err() {
        assert!(database.release_lease(&lease).await.is_ok());
    }
    result
}

async fn fail_fenced(
    database: &CartographDatabase,
    generation: RecoverableGeneration,
) -> Result<FailedGeneration, FailGenerationError> {
    let (project_id, generation_id) = match &generation {
        RecoverableGeneration::Staged(generation) => {
            (generation.project_id(), generation.generation_id())
        }
        RecoverableGeneration::Ready(generation) => {
            (generation.project_id(), generation.generation_id())
        }
    };
    let lease = acquire_generation_lease(database, project_id, generation_id).await;
    let result = database.fail_generation(generation, &lease.fence()).await;
    assert!(database.release_lease(&lease).await.is_ok());
    result
}

async fn acquire_generation_lease(
    database: &CartographDatabase,
    project_id: &ProjectId,
    generation_id: &GenerationId,
) -> ProjectLease {
    let target = LeaseTarget::new(
        project_id.clone(),
        ProjectOperation::Index,
        Some(generation_id.clone()),
    );
    match database
        .acquire_lease(LeaseRequest::new(
            target,
            LeaseOwner::new(process::id(), format!("generation-test-{generation_id}")),
            TEST_LEASE_DURATION,
        ))
        .await
    {
        Ok(lease) => lease,
        Err(error) => panic!("generation test lease acquisition failed: {error}"),
    }
}

async fn expire_generation_lease(pool: &sqlx_postgres::PgPool, schema: &str, target: &LeaseTarget) {
    let statement = format!(
        r#"UPDATE "{schema}"."project_operation_leases"
            SET acquired_at = clock_timestamp() - interval '3 seconds',
                heartbeat_at = clock_timestamp() - interval '2 seconds',
                expires_at = clock_timestamp() - interval '1 second'
            WHERE project_id = CAST($1 AS uuid) AND operation = $2"#
    );
    if let Err(error) = query(AssertSqlSafe(statement))
        .bind(target.project_id().as_str())
        .bind(target.operation().as_str())
        .execute(pool)
        .await
    {
        panic!("could not expire generation fence fixture: {error}");
    }
}

async fn assert_ledger_tampering_is_refused(
    database: &CartographDatabase,
    pool: &sqlx_postgres::PgPool,
    schema: &str,
) {
    tamper_migration_checksum(pool, schema).await;
    assert!(matches!(
        database.migrate().await,
        Err(MigrationError::LedgerConflict {
            version: INITIAL_MIGRATION_VERSION
        })
    ));
}

async fn open_isolated_database() -> (CartographDatabase, sqlx_postgres::PgPool, String) {
    let database_url = match env::var(TEST_DATABASE_URL_ENV) {
        Ok(database_url) => database_url,
        Err(_) => panic!("{TEST_DATABASE_URL_ENV} must be set for the ignored integration test"),
    };
    let schema = format!(
        "cartograph_it_{}_{}",
        process::id(),
        SCHEMA_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let settings = DatabaseSettings::parse(&database_url, Some("4"), Some("10000"))
        .and_then(|settings| settings.with_schema(&schema));
    let settings = match settings {
        Ok(settings) => settings,
        Err(error) => panic!("test database settings failed validation: {error}"),
    };
    let pool = match cartograph_db::connect(&settings).await {
        Ok(pool) => pool,
        Err(error) => panic!("test database connection failed: {error}"),
    };
    let database = CartographDatabase::new(pool.clone(), settings.schema().clone());
    (database, pool, schema)
}

fn document(fixture: DocumentFixture<'_>) -> SearchDocumentInput {
    SearchDocumentInput {
        document_id: parse_document_id(fixture.id),
        file_id: None,
        symbol_id: None,
        path: fixture.path.to_owned(),
        language: "rust".to_owned(),
        kind: DocumentKind::Symbol,
        qualified_name: fixture.qualified_name.to_owned(),
        code: fixture.code.to_owned(),
        natural_text: "Parser implementation evidence".to_owned(),
        metadata: serde_json::json!({"role": "parser"}),
    }
}

fn parse_document_id(raw: &str) -> DocumentId {
    match DocumentId::parse(raw) {
        Ok(id) => id,
        Err(error) => panic!("test document UUID is invalid: {error}"),
    }
}

fn digest(raw: &str) -> ContentDigest {
    match ContentDigest::parse(raw) {
        Ok(digest) => digest,
        Err(error) => panic!("test digest is invalid: {error}"),
    }
}

async fn drop_schema(pool: &sqlx_postgres::PgPool, schema: &str) {
    let statement = format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE");
    // The schema is generated exclusively from the decimal process id and an
    // atomic counter above; it contains no caller-controlled SQL fragment.
    if let Err(error) = query(AssertSqlSafe(statement)).execute(pool).await {
        panic!("failed to drop isolated test schema: {error}");
    }
}

async fn tamper_migration_checksum(pool: &sqlx_postgres::PgPool, schema: &str) {
    let statement =
        format!("UPDATE \"{schema}\".\"schema_migrations\" SET checksum = $1 WHERE version = 1");
    let result = query(AssertSqlSafe(statement))
        .bind("0".repeat(64))
        .execute(pool)
        .await;
    if let Err(error) = result {
        panic!("failed to prepare ledger-integrity test: {error}");
    }
}
