use std::env;

use cartograph_config::DatabaseSettings;
use cartograph_db::CheckStatus;

const TEST_DATABASE_URL_ENV: &str = "CARTOGRAPH_TEST_DATABASE_URL";

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + ParadeDB test database"]
async fn live_database_satisfies_every_v2_capability() {
    let database_url = match env::var(TEST_DATABASE_URL_ENV) {
        Ok(database_url) => database_url,
        Err(_) => panic!("{TEST_DATABASE_URL_ENV} must be set for the ignored integration test"),
    };
    let settings = match DatabaseSettings::parse(&database_url, Some("2"), Some("10000")) {
        Ok(settings) => settings,
        Err(error) => panic!("test database settings failed validation: {error}"),
    };
    let pool = match cartograph_db::connect(&settings).await {
        Ok(pool) => pool,
        Err(error) => panic!("test database connection failed: {error}"),
    };
    let report = match cartograph_db::probe_capabilities(&pool).await {
        Ok(report) => report,
        Err(error) => panic!("live capability probe failed: {error}"),
    };
    pool.close().await;

    let failed: Vec<_> = report
        .checks
        .iter()
        .filter(|check| check.status == CheckStatus::Fail)
        .map(|check| format!("{}: {}", check.id, check.message))
        .collect();

    assert!(
        report.ready,
        "live database did not satisfy v2 requirements: {}",
        failed.join("; ")
    );
    assert!((180_004..190_000).contains(&report.postgres_version_num));
    assert_eq!(report.pg_search_version.as_deref(), Some("0.25.0"));
    assert_eq!(report.pgvector_version.as_deref(), Some("0.8.4"));
    assert_eq!(report.checks.len(), 6);
}
