//! Test-only lifecycle helpers shared by Cartograph's live PostgreSQL suites.

use std::{thread, time::Duration};

use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::PgPoolOptions;
use thiserror::Error;

const CLEANUP_TIMEOUT: Duration = Duration::from_secs(20);
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
const MAXIMUM_SCHEMAS_PER_PREFIX: usize = 128;

/// A schema prefix could not be registered or cleaned safely.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum TestSchemaCleanupError {
    #[error("test schema prefix is invalid")]
    InvalidPrefix,
    #[error("test schema cleanup failed")]
    CleanupFailed,
}

/// Panic-safe guard for a unique test schema and any derived child schemas.
///
/// The guard performs its cleanup in a dedicated OS thread with an independent
/// Tokio runtime. This remains usable while an async test runtime is unwinding.
pub struct TestSchemaGuard {
    database_url: Option<String>,
    prefix: Option<String>,
}

impl std::fmt::Debug for TestSchemaGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TestSchemaGuard")
            .field("armed", &self.database_url.is_some())
            .finish_non_exhaustive()
    }
}

impl TestSchemaGuard {
    /// Arm cleanup for the exact schema and names beginning with `schema_`.
    pub fn new(
        database_url: impl Into<String>,
        schema: impl Into<String>,
    ) -> Result<Self, TestSchemaCleanupError> {
        let schema = schema.into();
        if !valid_schema_prefix(&schema) {
            return Err(TestSchemaCleanupError::InvalidPrefix);
        }
        Ok(Self {
            database_url: Some(database_url.into()),
            prefix: Some(schema),
        })
    }

    /// Clean now and disarm the drop fallback.
    pub async fn cleanup(mut self) -> Result<(), TestSchemaCleanupError> {
        let (database_url, prefix) = self.take().ok_or(TestSchemaCleanupError::CleanupFailed)?;
        cleanup_schemas(&database_url, &prefix).await
    }

    fn take(&mut self) -> Option<(String, String)> {
        self.database_url.take().zip(self.prefix.take())
    }
}

impl Drop for TestSchemaGuard {
    fn drop(&mut self) {
        let Some((database_url, prefix)) = self.take() else {
            return;
        };
        let cleanup = thread::Builder::new()
            .name("cartograph-test-schema-cleanup".to_owned())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                let Ok(runtime) = runtime else {
                    return Err(TestSchemaCleanupError::CleanupFailed);
                };
                runtime.block_on(cleanup_schemas(&database_url, &prefix))
            });
        if !matches!(
            cleanup.and_then(|thread| thread
                .join()
                .map_err(|_| std::io::Error::other("cleanup thread panicked"))),
            Ok(Ok(()))
        ) {
            eprintln!(
                "Cartograph test schema cleanup did not complete; the CI residual-schema gate will report it"
            );
        }
    }
}

async fn cleanup_schemas(database_url: &str, prefix: &str) -> Result<(), TestSchemaCleanupError> {
    let operation = async {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(ACQUIRE_TIMEOUT)
            .connect(database_url)
            .await
            .map_err(|_| TestSchemaCleanupError::CleanupFailed)?;
        query("SET statement_timeout = '15s'")
            .execute(&pool)
            .await
            .map_err(|_| TestSchemaCleanupError::CleanupFailed)?;
        query("SET lock_timeout = '3s'")
            .execute(&pool)
            .await
            .map_err(|_| TestSchemaCleanupError::CleanupFailed)?;
        let rows = query(
            "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = $1 OR starts_with(nspname, $1 || '_') ORDER BY nspname",
        )
        .bind(prefix)
        .fetch_all(&pool)
        .await
        .map_err(|_| TestSchemaCleanupError::CleanupFailed)?;
        if rows.len() > MAXIMUM_SCHEMAS_PER_PREFIX {
            return Err(TestSchemaCleanupError::CleanupFailed);
        }
        for row in rows {
            let schema = row
                .try_get::<String, _>("nspname")
                .map_err(|_| TestSchemaCleanupError::CleanupFailed)?;
            if !valid_schema_prefix(&schema)
                || (schema != prefix && !schema.starts_with(&format!("{prefix}_")))
            {
                return Err(TestSchemaCleanupError::CleanupFailed);
            }
            query(AssertSqlSafe(format!(
                "DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"
            )))
            .execute(&pool)
            .await
            .map_err(|_| TestSchemaCleanupError::CleanupFailed)?;
        }
        pool.close().await;
        Ok(())
    };
    tokio::time::timeout(CLEANUP_TIMEOUT, operation)
        .await
        .map_err(|_| TestSchemaCleanupError::CleanupFailed)?
}

fn valid_schema_prefix(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte == b'_' || byte.is_ascii_lowercase())
        && value
            .bytes()
            .all(|byte| byte == b'_' || byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_prefix_validation_is_fail_closed() {
        assert!(valid_schema_prefix("cg_fixture_123"));
        assert!(!valid_schema_prefix(""));
        assert!(!valid_schema_prefix("public; DROP SCHEMA public"));
        assert!(!valid_schema_prefix("Uppercase"));
        assert!(TestSchemaGuard::new("postgresql://unused", "invalid-name").is_err());
    }
}
