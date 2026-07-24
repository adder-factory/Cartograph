use std::{env, process, time::SystemTime};

use cartograph_agent::{IndexOptions, ProjectRuntime};
use cartograph_config::DatabaseSettings;
use cartograph_db::SearchQuery;
use sqlx_core::{query::query, sql_str::AssertSqlSafe};

const TEST_DATABASE_URL_ENV: &str = "CARTOGRAPH_TEST_DATABASE_URL";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn fresh_checkout_indexes_searches_noops_and_atomically_refreshes() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live project settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let source = project.path().join("auth.ts");
    std::fs::write(
        &source,
        "export function verifyJwtSignature(token: string): boolean { return token.length > 0; }\n",
    )
    .unwrap_or_else(|error| panic!("fixture write failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("runtime connect failed: {error}"));
        let first = runtime
            .index(IndexOptions::default().with_max_workers(4).unwrap_or_else(|error| {
                panic!("worker options failed: {error}")
            }))
            .await
            .unwrap_or_else(|error| panic!("first index failed: {error}"));
        assert!(first.published);
        assert_eq!(first.native.as_ref().map(|native| native.files), Some(1));
        let status = runtime
            .status()
            .await
            .unwrap_or_else(|error| panic!("status failed: {error}"));
        assert!(status.fresh);
        assert_eq!(
            status
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.current.as_ref())
                .map(|current| current.generation_id.clone()),
            Some(first.generation_id.clone())
        );

        let hits = runtime
            .database()
            .search_current_code(SearchQuery::new(
                first.project_id.clone(),
                "verify jwt signature",
                5,
            ))
            .await
            .unwrap_or_else(|error| panic!("BM25 search failed: {error}"));
        assert_eq!(hits.first().map(|hit| hit.path()), Some("auth.ts"));

        let unchanged = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("unchanged index failed: {error}"));
        assert!(!unchanged.published);
        assert_eq!(unchanged.generation_id, first.generation_id);

        std::fs::write(
            &source,
            "export function rejectExpiredJwt(token: string): boolean { return token.length === 0; }\n",
        )
        .unwrap_or_else(|error| panic!("fixture update failed: {error}"));
        let stale = runtime
            .status()
            .await
            .unwrap_or_else(|error| panic!("stale status failed: {error}"));
        assert!(!stale.fresh);
        let refreshed = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("refresh index failed: {error}"));
        assert!(refreshed.published);
        assert_ne!(refreshed.generation_id, first.generation_id);
        assert_ne!(refreshed.content_digest, first.content_digest);
        let fresh = runtime
            .status()
            .await
            .unwrap_or_else(|error| panic!("fresh status failed: {error}"));
        assert!(fresh.fresh);
        runtime.close().await;
    }
    .await;

    drop_schema(&settings, &schema).await;
    result
}

fn unique_schema() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("cg_agent_live_{}_{}", process::id(), nanos)
}

async fn drop_schema(settings: &DatabaseSettings, schema: &str) {
    let pool = cartograph_db::connect(settings)
        .await
        .unwrap_or_else(|error| panic!("cleanup connection failed: {error}"));
    query(AssertSqlSafe(format!(
        "DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"
    )))
    .execute(&pool)
    .await
    .unwrap_or_else(|_| panic!("cleanup schema failed"));
    pool.close().await;
}
