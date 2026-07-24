use std::{
    env, process,
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

use cartograph_config::DatabaseSettings;
use cartograph_db::{
    CartographDatabase, LeaseError, LeaseOwner, LeaseRequest, LeaseTarget, MigrationError,
    NewProject, RecoverableGeneration,
};
use cartograph_domain::{
    ContentDigest, GenerationDigestVersion, GenerationId, ProjectId, ProjectOperation,
};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

const TEST_DATABASE_URL_ENV: &str = "CARTOGRAPH_TEST_DATABASE_URL";
const PROJECT_FINGERPRINT: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_ONE_START: &str = "boot-a:process-start-100";
const OWNER_TWO_START: &str = "boot-a:process-start-200";
const LEASE_DURATION: Duration = Duration::from_secs(30);
const LEASE_DURATION_MILLIS: i64 = 30_000;
const V1_PROJECT_ID: &str = "11111111-1111-4111-8111-111111111111";
const V1_GENERATION_ID: &str = "22222222-2222-4222-8222-222222222222";
const V1_FILE_ID: &str = "33333333-3333-4333-8333-333333333333";
const V1_SYMBOL_ID: &str = "44444444-4444-4444-8444-444444444444";
const V1_HISTORICAL_DIGEST: &str =
    "5555555555555555555555555555555555555555555555555555555555555555";
const INITIAL_MIGRATION_VERSION: i64 = 1;
const OPERATION_LEASES_MIGRATION_VERSION: i64 = 2;
const COMPLETE_EDGE_KINDS_MIGRATION_VERSION: i64 = 3;
const REFERENCE_EVIDENCE_MIGRATION_VERSION: i64 = 4;
const LATEST_MIGRATION_VERSION: i64 = 5;
const LATER_MIGRATION_COUNT: u64 = 4;
const EXPECTED_MIGRATIONS: [i64; 5] = [
    INITIAL_MIGRATION_VERSION,
    OPERATION_LEASES_MIGRATION_VERSION,
    COMPLETE_EDGE_KINDS_MIGRATION_VERSION,
    REFERENCE_EVIDENCE_MIGRATION_VERSION,
    LATEST_MIGRATION_VERSION,
];
const EXPECTED_V1_UPGRADE_MIGRATIONS: [i64; 4] = [
    OPERATION_LEASES_MIGRATION_VERSION,
    COMPLETE_EDGE_KINDS_MIGRATION_VERSION,
    REFERENCE_EVIDENCE_MIGRATION_VERSION,
    LATEST_MIGRATION_VERSION,
];

static SCHEMA_COUNTER: AtomicU32 = AtomicU32::new(0);

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn leases_are_exclusive_observable_recoverable_and_database_clock_driven() {
    let (database, pool, schema) = open_isolated_database().await;
    let report = match database.migrate().await {
        Ok(report) => report,
        Err(error) => panic!("lease schema migration failed: {error}"),
    };
    assert_eq!(report.applied_versions, EXPECTED_MIGRATIONS);
    assert_v1_to_latest_upgrade(&database, &pool, &schema).await;
    let project = register_project(&database).await;
    let fixture = LeaseFixture {
        database: &database,
        pool: &pool,
        schema: &schema,
        project: &project,
    };

    assert_stale_takeover(&fixture).await;
    assert_concurrent_exclusion(&database, &project).await;
    assert_ledger_gap_is_refused(&database, &pool, &schema).await;

    drop(database);
    drop_schema(&pool, &schema).await;
    pool.close().await;
}

struct LeaseFixture<'a> {
    database: &'a CartographDatabase,
    pool: &'a sqlx_postgres::PgPool,
    schema: &'a str,
    project: &'a ProjectId,
}

async fn assert_stale_takeover(fixture: &LeaseFixture<'_>) {
    let target = LeaseTarget::new(fixture.project.clone(), ProjectOperation::Index, None);
    let mut first = acquire(
        fixture.database,
        target.clone(),
        owner(101, OWNER_ONE_START),
    )
    .await;
    let blocked = fixture
        .database
        .acquire_lease(LeaseRequest::new(
            target.clone(),
            owner(202, OWNER_TWO_START),
            LEASE_DURATION,
        ))
        .await;
    assert!(matches!(blocked, Err(LeaseError::Busy)));
    let status = match fixture.database.lease_status(&target).await {
        Ok(Some(status)) => status,
        Ok(None) => panic!("active lease was not observable"),
        Err(error) => panic!("lease status failed: {error}"),
    };
    assert_eq!(status.owner_pid(), 101);
    assert_eq!(status.owner_process_start(), OWNER_ONE_START);
    if let Err(error) = fixture.database.heartbeat_lease(&mut first).await {
        panic!("active owner could not heartbeat: {error}");
    }
    assert_heartbeat_renewed(fixture, &target, status.expires_at()).await;

    expire_lease(fixture.pool, fixture.schema, &target).await;
    let expired = match fixture.database.lease_status(&target).await {
        Ok(Some(status)) => status,
        Ok(None) => panic!("expired lease disappeared before takeover"),
        Err(error) => panic!("expired lease status failed: {error}"),
    };
    assert!(expired.expired());
    assert!(matches!(
        fixture.database.heartbeat_lease(&mut first).await,
        Err(LeaseError::Lost)
    ));
    let second = acquire(
        fixture.database,
        target.clone(),
        owner(202, OWNER_TWO_START),
    )
    .await;
    assert_ne!(first.lease_id(), second.lease_id());
    assert!(matches!(
        fixture.database.heartbeat_lease(&mut first).await,
        Err(LeaseError::Lost)
    ));
    assert!(matches!(
        fixture.database.release_lease(&first).await,
        Err(LeaseError::Lost)
    ));
    if let Err(error) = fixture.database.release_lease(&second).await {
        panic!("takeover owner could not release: {error}");
    }
    assert!(matches!(
        fixture.database.lease_status(&target).await,
        Ok(None)
    ));
}

async fn assert_heartbeat_renewed(
    fixture: &LeaseFixture<'_>,
    target: &LeaseTarget,
    previous_expiry: &str,
) {
    let statement = format!(
        r#"SELECT (
                expires_at > CAST($3 AS timestamptz)
                AND expires_at = heartbeat_at + $4 * interval '1 millisecond'
            ) AS renewed
            FROM "{schema}"."project_operation_leases"
            WHERE project_id = CAST($1 AS uuid) AND operation = $2"#,
        schema = fixture.schema,
    );
    let row = query(AssertSqlSafe(statement))
        .bind(target.project_id().as_str())
        .bind(target.operation().as_str())
        .bind(previous_expiry)
        .bind(LEASE_DURATION_MILLIS)
        .fetch_one(fixture.pool)
        .await;
    let renewed = match row {
        Ok(row) => row.try_get::<bool, _>("renewed"),
        Err(error) => panic!("could not verify database-side lease renewal: {error}"),
    };
    assert!(matches!(renewed, Ok(true)));
}

async fn assert_v1_to_latest_upgrade(
    database: &CartographDatabase,
    pool: &sqlx_postgres::PgPool,
    schema: &str,
) {
    let drop_leases = format!(r#"DROP TABLE "{schema}"."project_operation_leases""#);
    if let Err(error) = query(AssertSqlSafe(drop_leases)).execute(pool).await {
        panic!("could not create the v1 upgrade fixture: {error}");
    }
    let drop_digest_version = format!(
        r#"ALTER TABLE "{schema}"."index_generations"
            DROP COLUMN content_digest_version"#
    );
    if let Err(error) = query(AssertSqlSafe(drop_digest_version))
        .execute(pool)
        .await
    {
        panic!("could not remove the digest-version column: {error}");
    }
    let drop_reference_evidence = format!(
        r#"ALTER TABLE "{schema}"."references"
            DROP COLUMN owner_symbol_id,
            DROP COLUMN reference_name,
            DROP COLUMN resolution_provenance"#
    );
    if let Err(error) = query(AssertSqlSafe(drop_reference_evidence))
        .execute(pool)
        .await
    {
        panic!("could not remove later reference evidence columns: {error}");
    }
    let delete_later = format!(r#"DELETE FROM "{schema}"."schema_migrations" WHERE version >= $1"#);
    let deleted = query(AssertSqlSafe(delete_later))
        .bind(OPERATION_LEASES_MIGRATION_VERSION)
        .execute(pool)
        .await;
    assert!(matches!(deleted, Ok(result) if result.rows_affected() == LATER_MIGRATION_COUNT));
    insert_v1_reference_fixture(pool, schema).await;

    assert!(matches!(
        database.migrate().await,
        Ok(report)
            if report.applied_versions == EXPECTED_V1_UPGRADE_MIGRATIONS
                && report.current_version == LATEST_MIGRATION_VERSION
    ));
    assert_upgraded_v1_reference_fixture(database, pool, schema).await;
    assert!(matches!(
        database.migrate().await,
        Ok(report)
            if report.applied_versions.is_empty()
                && report.current_version == LATEST_MIGRATION_VERSION
    ));
}

async fn insert_v1_reference_fixture(pool: &sqlx_postgres::PgPool, schema: &str) {
    let statements = [
        format!(
            r#"INSERT INTO "{schema}"."projects"
                (project_id, root_identity, repository_fingerprint, next_generation_sequence)
                VALUES (CAST('{V1_PROJECT_ID}' AS uuid), 'v1-reference-fixture',
                    '{PROJECT_FINGERPRINT}', 2)"#
        ),
        format!(
            r#"INSERT INTO "{schema}"."index_generations"
                (project_id, generation_id, generation_sequence, source_revision, state,
                 worker_count, content_digest, ready_at)
                VALUES (CAST('{V1_PROJECT_ID}' AS uuid), CAST('{V1_GENERATION_ID}' AS uuid), 1,
                    'v1-reference-revision', 'ready', 1, '{V1_HISTORICAL_DIGEST}',
                    clock_timestamp())"#
        ),
        format!(
            r#"INSERT INTO "{schema}"."files"
                (project_id, generation_id, file_id, normalized_path, language, content_hash,
                 byte_size, parse_status)
                VALUES (CAST('{V1_PROJECT_ID}' AS uuid), CAST('{V1_GENERATION_ID}' AS uuid),
                    CAST('{V1_FILE_ID}' AS uuid), 'src/v1.ts', 'typescript',
                    '{PROJECT_FINGERPRINT}', 10, 'parsed')"#
        ),
        format!(
            r#"INSERT INTO "{schema}"."symbols"
                (project_id, generation_id, symbol_id, file_id, symbol_kind, qualified_name,
                 signature, start_byte, end_byte, start_line, end_line, structural_digest)
                VALUES (CAST('{V1_PROJECT_ID}' AS uuid), CAST('{V1_GENERATION_ID}' AS uuid),
                    CAST('{V1_SYMBOL_ID}' AS uuid), CAST('{V1_FILE_ID}' AS uuid), 'function',
                    'legacy', 'function legacy()', 0, 10, 1, 1, '{PROJECT_FINGERPRINT}')"#
        ),
        format!(
            r#"INSERT INTO "{schema}"."references"
                (project_id, generation_id, file_id, target_symbol_id, reference_kind,
                 start_byte, end_byte, confidence)
                VALUES (CAST('{V1_PROJECT_ID}' AS uuid), CAST('{V1_GENERATION_ID}' AS uuid),
                    CAST('{V1_FILE_ID}' AS uuid), CAST('{V1_SYMBOL_ID}' AS uuid), 'calls',
                    0, 6, 1.0)"#
        ),
    ];
    for statement in statements {
        if let Err(error) = query(AssertSqlSafe(statement)).execute(pool).await {
            panic!("could not populate the v1 reference fixture: {error}");
        }
    }
}

async fn assert_upgraded_v1_reference_fixture(
    database: &CartographDatabase,
    pool: &sqlx_postgres::PgPool,
    schema: &str,
) {
    let statement = format!(
        r#"SELECT generations.content_digest, generations.content_digest_version,
                   reference_rows.reference_name, reference_rows.resolution_provenance
            FROM "{schema}"."index_generations" AS generations
            JOIN "{schema}"."references" AS reference_rows
              ON reference_rows.project_id = generations.project_id
             AND reference_rows.generation_id = generations.generation_id
            WHERE generations.generation_id = CAST($1 AS uuid)"#
    );
    let row = query(AssertSqlSafe(statement))
        .bind(V1_GENERATION_ID)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|error| panic!("could not inspect the upgraded v1 fixture: {error}"));
    assert_eq!(
        row.try_get::<String, _>("content_digest").ok().as_deref(),
        Some(V1_HISTORICAL_DIGEST)
    );
    assert!(matches!(
        row.try_get::<i16, _>("content_digest_version"),
        Ok(1)
    ));
    assert_eq!(
        row.try_get::<String, _>("reference_name").ok().as_deref(),
        Some("<legacy-unavailable>")
    );
    assert_eq!(
        row.try_get::<String, _>("resolution_provenance")
            .ok()
            .as_deref(),
        Some("legacy-unavailable")
    );

    let project = ProjectId::parse(V1_PROJECT_ID)
        .unwrap_or_else(|error| panic!("v1 project ID was invalid: {error}"));
    let generation = GenerationId::parse(V1_GENERATION_ID)
        .unwrap_or_else(|error| panic!("v1 generation ID was invalid: {error}"));
    let recovered = database
        .recover_generation(&project, &generation)
        .await
        .unwrap_or_else(|error| panic!("v1 ready generation recovery failed: {error}"));
    assert!(matches!(
        recovered,
        Some(RecoverableGeneration::Ready(ready))
            if ready.content_digest().as_str() == V1_HISTORICAL_DIGEST
                && ready.digest_version() == GenerationDigestVersion::V1
    ));
}

async fn assert_ledger_gap_is_refused(
    database: &CartographDatabase,
    pool: &sqlx_postgres::PgPool,
    schema: &str,
) {
    let delete_v1 = format!(r#"DELETE FROM "{schema}"."schema_migrations" WHERE version = $1"#);
    let deleted = query(AssertSqlSafe(delete_v1))
        .bind(INITIAL_MIGRATION_VERSION)
        .execute(pool)
        .await;
    assert!(matches!(deleted, Ok(result) if result.rows_affected() == 1));
    assert!(matches!(
        database.migrate().await,
        Err(MigrationError::LedgerGap {
            missing_version: INITIAL_MIGRATION_VERSION,
            recorded_version: LATEST_MIGRATION_VERSION,
        })
    ));
}

async fn assert_concurrent_exclusion(database: &CartographDatabase, project: &ProjectId) {
    let target = LeaseTarget::new(project.clone(), ProjectOperation::Sync, None);
    let first = LeaseRequest::new(target.clone(), owner(303, OWNER_ONE_START), LEASE_DURATION);
    let second = LeaseRequest::new(target.clone(), owner(404, OWNER_TWO_START), LEASE_DURATION);
    let (first, second) = tokio::join!(
        database.acquire_lease(first),
        database.acquire_lease(second)
    );
    let winner = match (first, second) {
        (Ok(lease), Err(LeaseError::Busy)) | (Err(LeaseError::Busy), Ok(lease)) => lease,
        results => panic!("concurrent lease result was not exactly-one winner: {results:?}"),
    };
    if let Err(error) = database.release_lease(&winner).await {
        panic!("concurrent winner could not release: {error}");
    }
}

async fn open_isolated_database() -> (CartographDatabase, sqlx_postgres::PgPool, String) {
    let database_url = match env::var(TEST_DATABASE_URL_ENV) {
        Ok(database_url) => database_url,
        Err(_) => panic!("{TEST_DATABASE_URL_ENV} must be set for the ignored integration test"),
    };
    let schema = format!(
        "cartograph_lease_it_{}_{}",
        process::id(),
        SCHEMA_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let settings = DatabaseSettings::parse(&database_url, Some("4"), Some("10000"))
        .and_then(|settings| settings.with_schema(&schema));
    let settings = match settings {
        Ok(settings) => settings,
        Err(error) => panic!("lease test database settings failed validation: {error}"),
    };
    let pool = match cartograph_db::connect(&settings).await {
        Ok(pool) => pool,
        Err(error) => panic!("lease test database connection failed: {error}"),
    };
    let database = CartographDatabase::new(pool.clone(), settings.schema().clone());
    (database, pool, schema)
}

async fn register_project(database: &CartographDatabase) -> ProjectId {
    let fingerprint = match ContentDigest::parse(PROJECT_FINGERPRINT) {
        Ok(fingerprint) => fingerprint,
        Err(error) => panic!("lease test fingerprint is invalid: {error}"),
    };
    match database
        .register_project(NewProject::new("workspace/leases", fingerprint))
        .await
    {
        Ok(project) => project,
        Err(error) => panic!("lease test project registration failed: {error}"),
    }
}

async fn acquire(
    database: &CartographDatabase,
    target: LeaseTarget,
    owner: LeaseOwner,
) -> cartograph_db::ProjectLease {
    match database
        .acquire_lease(LeaseRequest::new(target, owner, LEASE_DURATION))
        .await
    {
        Ok(lease) => lease,
        Err(error) => panic!("lease acquisition failed: {error}"),
    }
}

fn owner(pid: u32, process_start: &str) -> LeaseOwner {
    LeaseOwner::new(pid, process_start)
}

async fn expire_lease(pool: &sqlx_postgres::PgPool, schema: &str, target: &LeaseTarget) {
    let statement = format!(
        r#"UPDATE "{schema}"."project_operation_leases"
            SET acquired_at = clock_timestamp() - interval '3 seconds',
                heartbeat_at = clock_timestamp() - interval '2 seconds',
                expires_at = clock_timestamp() - interval '1 second'
            WHERE project_id = CAST($1 AS uuid) AND operation = $2"#
    );
    let result = query(AssertSqlSafe(statement))
        .bind(target.project_id().as_str())
        .bind(target.operation().as_str())
        .execute(pool)
        .await;
    assert!(matches!(result, Ok(result) if result.rows_affected() == 1));
}

async fn drop_schema(pool: &sqlx_postgres::PgPool, schema: &str) {
    let statement = format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE");
    if let Err(error) = query(AssertSqlSafe(statement)).execute(pool).await {
        panic!("failed to drop isolated lease-test schema: {error}");
    }
}
