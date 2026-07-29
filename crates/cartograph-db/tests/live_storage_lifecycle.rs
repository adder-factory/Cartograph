use std::{env, process, time::Duration};

use cartograph_config::DatabaseSettings;
use cartograph_db::{
    CartographDatabase, GenerationContents, GenerationFacts, GenerationRetentionPolicy,
    GenerationRetentionRequest, GenerationValidationLimits, LeaseOwner, LeaseRequest, LeaseTarget,
    NativeParseCacheKey, NativeParseCacheKeyInput, NativeParseCacheRetentionPolicy,
    NativeParseCacheRetentionPolicyInput, NativeParseCacheRetentionRequest, NewGeneration,
    NewProject, PostRetentionMaintenance, StorageCompactionPolicy, StorageCompactionPolicyInput,
    validate_generation_facts,
};
use cartograph_domain::{
    ContentDigest, GenerationId, NormalizedPath, ProjectId, ProjectOperation, SourceLanguage,
};
use cartograph_test_support::TestSchemaGuard;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

const TEST_DATABASE_URL_ENV: &str = "CARTOGRAPH_TEST_DATABASE_URL";
const LEASE_DURATION: Duration = Duration::from_secs(60);
const STATEMENT_TIMEOUT: Duration = Duration::from_secs(60);

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn storage_lifecycle_is_bounded_observable_and_online() {
    let database_url = env::var(TEST_DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{TEST_DATABASE_URL_ENV} must be set"));
    let schema = format!("cg_storage_lifecycle_{}", process::id());
    let _schema_guard = TestSchemaGuard::new(&database_url, schema.clone())
        .unwrap_or_else(|error| panic!("storage schema guard failed: {error}"));
    let settings = DatabaseSettings::parse(&database_url, Some("8"), Some("60000"))
        .and_then(|settings| settings.with_schema(&schema))
        .unwrap_or_else(|error| panic!("storage settings failed: {error}"));
    let pool = cartograph_db::connect(&settings)
        .await
        .unwrap_or_else(|error| panic!("storage connection failed: {error}"));
    let database = CartographDatabase::new(pool.clone(), settings.schema().clone());
    let migration = database
        .migrate()
        .await
        .unwrap_or_else(|error| panic!("storage migration failed: {error}"));
    assert_eq!(migration.current_version, 23);
    assert_virtual_payload_accounting_and_autovacuum(&pool, &schema).await;

    let project = database
        .register_project(NewProject::new(
            "storage/lifecycle",
            digest(b"storage-project"),
        ))
        .await
        .unwrap_or_else(|error| panic!("storage project registration failed: {error}"));
    let first_ready = prepare_empty_generation(&database, &project, "storage-ready-one").await;
    let second_ready = prepare_empty_generation(&database, &project, "storage-ready-two").await;
    age_ready_generations(&pool, &schema, &project).await;

    let protected_contract = digest(b"current-extractor-contract");
    let prior_contract = digest(b"prior-extractor-contract");
    let obsolete_contract = digest(b"obsolete-extractor-contract");
    for (contract, path, payload) in [
        (
            &obsolete_contract,
            "src/obsolete.rs",
            b"obsolete".as_slice(),
        ),
        (&prior_contract, "src/prior.rs", b"prior".as_slice()),
        (&protected_contract, "src/current.rs", b"current".as_slice()),
    ] {
        database
            .store_native_parse_cache(&cache_key(&project, contract, path), payload)
            .await
            .unwrap_or_else(|error| panic!("parse cache fixture failed: {error}"));
    }

    let before = database
        .storage_usage(&project, 64, STATEMENT_TIMEOUT)
        .await
        .unwrap_or_else(|error| panic!("storage usage failed: {error}"));
    assert_eq!(before.parse_cache.rows, 3);
    assert_eq!(before.parse_cache.contracts, 3);
    assert_eq!(before.stale_ready_generations, 2);
    assert_eq!(before.deduplication.duplicate_content_groups, 1);
    assert_eq!(before.deduplication.redundant_generations, 1);
    assert!(!before.deduplication.mutation_supported);
    assert!(before.schema_bytes > 0);
    assert!(before.index_bytes > 0);

    let migration_lease = database
        .acquire_lease(LeaseRequest::new(
            LeaseTarget::new(project.clone(), ProjectOperation::Migration, None),
            LeaseOwner::new(process::id(), "storage-lifecycle-maintenance"),
            LEASE_DURATION,
        ))
        .await
        .unwrap_or_else(|error| panic!("storage migration lease failed: {error}"));
    let cache_report = database
        .cleanup_native_parse_cache(NativeParseCacheRetentionRequest {
            project_id: &project,
            protected_contract_digest: &protected_contract,
            policy: NativeParseCacheRetentionPolicy::new(NativeParseCacheRetentionPolicyInput {
                maximum_contracts: 2,
                maximum_rows: 2,
                maximum_payload_bytes: 1024,
                maximum_deletions: 16,
            })
            .unwrap_or_else(|error| panic!("cache policy failed: {error}")),
            fence: &migration_lease.fence(),
            statement_timeout: STATEMENT_TIMEOUT,
        })
        .await
        .unwrap_or_else(|error| panic!("cache cleanup failed: {error}"));
    assert_eq!(cache_report.rows_removed, 1);
    assert_eq!(cache_report.after.rows, 2);
    assert_eq!(cache_report.after.contracts, 2);
    assert!(!cache_report.over_contract_budget);
    assert!(
        database
            .load_native_parse_cache(&cache_key(&project, &protected_contract, "src/current.rs"))
            .await
            .unwrap_or_else(|error| panic!("protected cache lookup failed: {error}"))
            .is_some()
    );

    let retention = database
        .cleanup_generations(GenerationRetentionRequest::new(
            GenerationRetentionPolicy::new(0, 8)
                .and_then(|policy| policy.with_stale_ready_age(Duration::from_secs(1)))
                .unwrap_or_else(|error| panic!("retention policy failed: {error}")),
            &migration_lease.fence(),
            STATEMENT_TIMEOUT,
        ))
        .await
        .unwrap_or_else(|error| panic!("ready reconciliation failed: {error}"));
    assert_eq!(retention.ready_removed, 2);
    assert_eq!(retention.ready_remaining, 0);
    assert_eq!(retention.current_preserved, 0);
    assert_eq!(retention.maintenance, PostRetentionMaintenance::NotNeeded);
    database
        .release_lease(&migration_lease)
        .await
        .unwrap_or_else(|error| panic!("storage migration lease release failed: {error}"));
    assert_ne!(first_ready, second_ready);

    create_compaction_fixture(&pool, &schema).await;
    let compaction_policy = StorageCompactionPolicy::new(StorageCompactionPolicyInput {
        maximum_indexes: 4,
        maximum_candidate_bytes: 128 * 1024 * 1024,
        minimum_index_bytes: 1024 * 1024,
        statement_timeout: STATEMENT_TIMEOUT,
    })
    .unwrap_or_else(|error| panic!("compaction policy failed: {error}"));
    let plan = database
        .storage_compaction_plan(compaction_policy)
        .await
        .unwrap_or_else(|error| panic!("compaction plan failed: {error}"));
    assert!(
        plan.candidates
            .iter()
            .any(|candidate| candidate.index == "storage_compaction_fixture_idx")
    );
    assert!(plan.required_headroom_bytes > plan.candidate_bytes);
    let compacted = database
        .compact_storage_online(compaction_policy, u64::MAX)
        .await
        .unwrap_or_else(|error| panic!("online compaction failed: {error}"));
    assert!(
        compacted
            .reindexed
            .iter()
            .any(|candidate| candidate.index == "storage_compaction_fixture_idx")
    );
    assert!(compacted.stop_reason.is_none());

    drop(database);
    drop_schema(&pool, &schema).await;
    pool.close().await;
}

async fn prepare_empty_generation(
    database: &CartographDatabase,
    project: &ProjectId,
    revision: &str,
) -> GenerationId {
    let staged = database
        .begin_generation(NewGeneration::new(project.clone(), revision, 1))
        .await
        .unwrap_or_else(|error| panic!("storage generation start failed: {error}"));
    let lease = database
        .acquire_lease(LeaseRequest::new(
            LeaseTarget::new(
                project.clone(),
                ProjectOperation::Index,
                Some(staged.generation_id().clone()),
            ),
            LeaseOwner::new(process::id(), revision),
            LEASE_DURATION,
        ))
        .await
        .unwrap_or_else(|error| panic!("storage generation lease failed: {error}"));
    let limits = GenerationValidationLimits::new(1024 * 1024, 4 * 1024 * 1024)
        .unwrap_or_else(|error| panic!("storage validation limits failed: {error}"));
    let canonical = validate_generation_facts(GenerationFacts::default(), limits, || false)
        .map(|(facts, _)| facts)
        .unwrap_or_else(|error| panic!("storage generation facts failed: {error}"));
    let ready = database
        .prepare_generation(GenerationContents::new(staged, canonical), &lease.fence())
        .await
        .unwrap_or_else(|error| panic!("storage generation prepare failed: {error}"));
    database
        .release_lease(&lease)
        .await
        .unwrap_or_else(|error| panic!("storage generation lease release failed: {error}"));
    ready.generation_id().clone()
}

async fn age_ready_generations(pool: &sqlx_postgres::PgPool, schema: &str, project: &ProjectId) {
    query(AssertSqlSafe(format!(
        r#"UPDATE "{schema}"."index_generations"
            SET ready_at = clock_timestamp() - interval '2 days'
            WHERE project_id = $1::uuid AND state = 'ready'"#
    )))
    .bind(project.as_str())
    .execute(pool)
    .await
    .unwrap_or_else(|error| panic!("ready generation aging failed: {error}"));
}

async fn assert_virtual_payload_accounting_and_autovacuum(
    pool: &sqlx_postgres::PgPool,
    schema: &str,
) {
    let generated = query(
        r#"SELECT attributes.attgenerated::text AS generated
            FROM pg_catalog.pg_attribute AS attributes
            INNER JOIN pg_catalog.pg_class AS classes ON classes.oid = attributes.attrelid
            INNER JOIN pg_catalog.pg_namespace AS namespaces
                ON namespaces.oid = classes.relnamespace
            WHERE namespaces.nspname = $1
              AND classes.relname = 'native_parse_cache'
              AND attributes.attname = 'payload_bytes'"#,
    )
    .bind(schema)
    .fetch_one(pool)
    .await
    .unwrap_or_else(|error| panic!("generated column lookup failed: {error}"));
    assert_eq!(
        generated.try_get::<String, _>("generated").ok().as_deref(),
        Some("v")
    );
    let options = query(
        r#"SELECT reloptions
            FROM pg_catalog.pg_class AS classes
            INNER JOIN pg_catalog.pg_namespace AS namespaces
                ON namespaces.oid = classes.relnamespace
            WHERE namespaces.nspname = $1 AND classes.relname = 'native_parse_cache'"#,
    )
    .bind(schema)
    .fetch_one(pool)
    .await
    .unwrap_or_else(|error| panic!("autovacuum options lookup failed: {error}"))
    .try_get::<Option<Vec<String>>, _>("reloptions")
    .unwrap_or_else(|error| panic!("autovacuum options decode failed: {error}"))
    .unwrap_or_default();
    assert!(
        options
            .iter()
            .any(|option| option == "autovacuum_vacuum_scale_factor=0.01")
    );
    assert!(
        options
            .iter()
            .any(|option| option == "autovacuum_vacuum_threshold=100")
    );
}

async fn create_compaction_fixture(pool: &sqlx_postgres::PgPool, schema: &str) {
    for statement in [
        format!(
            r#"CREATE TABLE "{schema}"."storage_compaction_fixture" (
                id bigint NOT NULL, payload text NOT NULL
            )"#
        ),
        format!(
            r#"INSERT INTO "{schema}"."storage_compaction_fixture" (id, payload)
                SELECT value, repeat('x', 64) FROM generate_series(1, 200000) AS value"#
        ),
        format!(
            r#"CREATE INDEX storage_compaction_fixture_idx
                ON "{schema}"."storage_compaction_fixture" (id)"#
        ),
    ] {
        query(AssertSqlSafe(statement))
            .execute(pool)
            .await
            .unwrap_or_else(|error| panic!("compaction fixture failed: {error}"));
    }
}

fn cache_key(project: &ProjectId, contract: &ContentDigest, path: &str) -> NativeParseCacheKey {
    NativeParseCacheKey::new(NativeParseCacheKeyInput {
        project_id: project.clone(),
        extractor_contract_digest: contract.clone(),
        path: NormalizedPath::parse(path)
            .unwrap_or_else(|error| panic!("cache path failed: {error}")),
        language: SourceLanguage::Rust,
        content_hash: digest(path.as_bytes()),
        source_bytes: u64::try_from(path.len()).unwrap_or(u64::MAX),
    })
}

fn digest(bytes: &[u8]) -> ContentDigest {
    ContentDigest::from_bytes(*blake3::hash(bytes).as_bytes())
}

async fn drop_schema(pool: &sqlx_postgres::PgPool, schema: &str) {
    query(AssertSqlSafe(format!(
        "DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"
    )))
    .execute(pool)
    .await
    .unwrap_or_else(|error| panic!("storage schema cleanup failed: {error}"));
}
