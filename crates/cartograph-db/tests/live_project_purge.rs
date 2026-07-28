use std::{env, process, time::Duration};

use cartograph_config::DatabaseSettings;
use cartograph_db::{
    CartographDatabase, GenerationContents, GenerationFacts, GenerationValidationLimits,
    LeaseOwner, LeaseRequest, LeaseTarget, NewGeneration, NewProject, ProjectPurgeError,
    ProjectPurgeRequest, SearchDocumentInput, validate_generation_facts,
};
use cartograph_domain::{ContentDigest, DocumentId, DocumentKind, ProjectOperation};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

const TEST_DATABASE_URL_ENV: &str = "CARTOGRAPH_TEST_DATABASE_URL";
const TIMEOUT: Duration = Duration::from_secs(30);
const LEASE_DURATION: Duration = Duration::from_secs(60);
const PROJECT_FINGERPRINT: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DOCUMENT_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB/pgvector test database"]
async fn project_purge_blocks_live_work_and_drops_physical_search_relations() {
    let database_url = env::var(TEST_DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{TEST_DATABASE_URL_ENV} must be set"));
    let schema = format!("cartograph_purge_{}", process::id());
    let settings = DatabaseSettings::parse(&database_url, Some("4"), Some("10000"))
        .and_then(|settings| settings.with_schema(&schema))
        .unwrap_or_else(|error| panic!("purge settings failed: {error}"));
    let pool = cartograph_db::connect(&settings)
        .await
        .unwrap_or_else(|error| panic!("purge connection failed: {error}"));
    let database = CartographDatabase::new(pool.clone(), settings.schema().clone());
    database
        .migrate()
        .await
        .unwrap_or_else(|error| panic!("purge migration failed: {error}"));
    let project = database
        .register_project(NewProject::new(
            "purge/project",
            digest(PROJECT_FINGERPRINT),
        ))
        .await
        .unwrap_or_else(|error| panic!("purge project failed: {error}"));
    let staged = database
        .begin_generation(NewGeneration::new(project.clone(), "purge-revision", 1))
        .await
        .unwrap_or_else(|error| panic!("purge generation failed: {error}"));
    let lease = database
        .acquire_lease(LeaseRequest::new(
            LeaseTarget::new(
                project.clone(),
                ProjectOperation::Index,
                Some(staged.generation_id().clone()),
            ),
            LeaseOwner::new(process::id(), "purge-prepare"),
            LEASE_DURATION,
        ))
        .await
        .unwrap_or_else(|error| panic!("purge prepare lease failed: {error}"));
    let facts = GenerationFacts {
        documents: vec![SearchDocumentInput {
            document_id: DocumentId::parse(DOCUMENT_ID)
                .unwrap_or_else(|error| panic!("purge document ID failed: {error}")),
            file_id: None,
            symbol_id: None,
            path: "src/purge.rs".to_owned(),
            language: "rust".to_owned(),
            kind: DocumentKind::Symbol,
            qualified_name: "purge_fixture".to_owned(),
            code: "fn purge_fixture() {}".to_owned(),
            natural_text: String::new(),
            metadata: serde_json::json!({"fixture": true}),
        }],
        ..GenerationFacts::default()
    };
    let (canonical, _) = validate_generation_facts(
        facts,
        GenerationValidationLimits::new(64 * 1_024 * 1_024, 256 * 1_024 * 1_024)
            .unwrap_or_else(|error| panic!("purge limits failed: {error}")),
        || false,
    )
    .unwrap_or_else(|error| panic!("purge facts failed: {error}"));
    let ready = database
        .prepare_generation(GenerationContents::new(staged, canonical), &lease.fence())
        .await
        .unwrap_or_else(|error| panic!("purge preparation failed: {error}"));
    database
        .release_lease(&lease)
        .await
        .unwrap_or_else(|error| panic!("purge prepare lease release failed: {error}"));
    let publish_lease = database
        .acquire_lease(LeaseRequest::new(
            LeaseTarget::new(
                project.clone(),
                ProjectOperation::Index,
                Some(ready.generation_id().clone()),
            ),
            LeaseOwner::new(process::id(), "purge-publish"),
            LEASE_DURATION,
        ))
        .await
        .unwrap_or_else(|error| panic!("purge publish lease failed: {error}"));
    let current = database
        .publish_generation(ready, &publish_lease.fence())
        .await
        .unwrap_or_else(|error| panic!("purge publication failed: {error}"));
    let relation_name = format!(
        "\"{schema}\".\"search_g_{}\"",
        current.generation_id().as_str().replace('-', "")
    );
    assert!(relation_exists(&pool, &relation_name).await);

    let live_lease = database
        .acquire_lease(LeaseRequest::new(
            LeaseTarget::new(project.clone(), ProjectOperation::Migration, None),
            LeaseOwner::new(process::id(), "purge-blocker"),
            LEASE_DURATION,
        ))
        .await
        .unwrap_or_else(|error| panic!("purge blocker lease failed: {error}"));
    assert_eq!(
        database
            .purge_project(ProjectPurgeRequest {
                project_id: &project,
                maximum_generations: 10,
                maximum_cascade_rows: 1_000,
                statement_timeout: TIMEOUT,
            })
            .await,
        Err(ProjectPurgeError::LiveLeases { count: 1 })
    );
    database
        .release_lease(&live_lease)
        .await
        .unwrap_or_else(|error| panic!("purge blocker release failed: {error}"));

    let report = database
        .purge_project(ProjectPurgeRequest {
            project_id: &project,
            maximum_generations: 10,
            maximum_cascade_rows: 1_000,
            statement_timeout: TIMEOUT,
        })
        .await
        .unwrap_or_else(|error| panic!("project purge failed: {error}"));
    assert_eq!(report.generations_removed, 1);
    assert_eq!(report.search_relations_removed, 1);
    assert!(report.cascade_rows_removed >= 3);
    assert!(!relation_exists(&pool, &relation_name).await);
    assert!(
        database
            .project_snapshot_by_root("purge/project")
            .await
            .unwrap_or_else(|error| panic!("purge status failed: {error}"))
            .is_none()
    );

    drop(database);
    let drop_schema = format!(r#"DROP SCHEMA IF EXISTS "{schema}" CASCADE"#);
    query(AssertSqlSafe(drop_schema))
        .execute(&pool)
        .await
        .unwrap_or_else(|error| panic!("purge schema cleanup failed: {error}"));
    pool.close().await;
}

async fn relation_exists(pool: &sqlx_postgres::PgPool, relation: &str) -> bool {
    query("SELECT to_regclass($1) IS NOT NULL AS present")
        .bind(relation)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|error| panic!("purge relation lookup failed: {error}"))
        .try_get::<bool, _>("present")
        .unwrap_or_else(|error| panic!("purge relation decode failed: {error}"))
}

fn digest(raw: &str) -> ContentDigest {
    ContentDigest::parse(raw).unwrap_or_else(|error| panic!("purge digest failed: {error}"))
}
