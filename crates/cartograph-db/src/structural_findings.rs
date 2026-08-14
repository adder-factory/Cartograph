//! Generation-fenced cache for the deterministic structural finding relation.
//!
//! Evaluating every detector over a whole published generation is far too slow
//! for a readiness probe, so the complete relation is computed once per exact
//! input fingerprint and then served from storage. The fingerprint covers every
//! input that can change while one generation stays current: the generation
//! itself, the superseded generation the growth detector compares against,
//! imported coverage, materialised similarity, the calendar day that bounds the
//! growth window, and the detector contract compiled into this binary.

use std::{sync::OnceLock, time::Duration};

use cartograph_domain::{ContentDigest, ProjectId};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

use crate::{
    CartographDatabase, StorageError,
    database::{quoted_schema, set_local_statement_timeout},
    insights::{FINDING_CTES_SQL_TEMPLATE, finding_ctes},
};

const REFRESH_LOCK_NAMESPACE: &str = "cartograph-v2-structural-findings";

/// Outcome of one bounded cache reconciliation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StructuralFindingRefresh {
    /// The stored relation already matched the exact input fingerprint.
    Current,
    /// The complete detector relation was recomputed and replaced.
    Recomputed,
    /// The project has no published generation to analyse.
    NoCurrentGeneration,
}

/// Exact detector-contract digest compiled into this binary.
///
/// A detector-SQL change must invalidate every stored relation; otherwise a warm
/// cache keeps serving findings that the shipped rules no longer produce.
fn detector_contract_digest() -> &'static str {
    static DIGEST: OnceLock<ContentDigest> = OnceLock::new();
    DIGEST
        .get_or_init(|| {
            let mut hasher = blake3::Hasher::new();
            hasher.update(FINDING_CTES_SQL_TEMPLATE.as_bytes());
            ContentDigest::from_bytes(*hasher.finalize().as_bytes())
        })
        .as_str()
}

fn database_error(operation: &'static str) -> StorageError {
    StorageError::DatabaseOperation { operation }
}

struct FingerprintedGeneration {
    generation_id: String,
    inputs_digest: String,
}

pub(crate) struct FencedStructuralFindingRefresh {
    pub(crate) outcome: StructuralFindingRefresh,
    pub(crate) generation_id: Option<String>,
}

impl CartographDatabase {
    /// Recompute the stored finding relation unless it already matches the exact
    /// current input fingerprint.
    ///
    /// # Errors
    ///
    /// Returns an error if the timeout is invalid, the fingerprint cannot be
    /// read, or the bounded recomputation transaction fails.
    pub async fn refresh_current_structural_findings(
        &self,
        project_id: &ProjectId,
        statement_timeout: Duration,
    ) -> Result<StructuralFindingRefresh, StorageError> {
        Ok(self
            .refresh_current_structural_findings_fenced(project_id, statement_timeout)
            .await?
            .outcome)
    }

    /// Reconcile the cache and retain the exact generation used to compute it.
    pub(crate) async fn refresh_current_structural_findings_fenced(
        &self,
        project_id: &ProjectId,
        statement_timeout: Duration,
    ) -> Result<FencedStructuralFindingRefresh, StorageError> {
        if statement_timeout.is_zero() {
            return Err(StorageError::InvalidInput {
                field: "statement_timeout",
            });
        }
        let Some(fingerprint) = self.structural_finding_fingerprint(project_id).await? else {
            return Ok(FencedStructuralFindingRefresh {
                outcome: StructuralFindingRefresh::NoCurrentGeneration,
                generation_id: None,
            });
        };
        let generation_id = fingerprint.generation_id.clone();
        if self
            .stored_structural_finding_digest(project_id, &fingerprint.generation_id)
            .await?
            .is_some_and(|stored| stored == fingerprint.inputs_digest)
        {
            return Ok(FencedStructuralFindingRefresh {
                outcome: StructuralFindingRefresh::Current,
                generation_id: Some(generation_id),
            });
        }
        let outcome = self
            .recompute_structural_findings(project_id, &fingerprint, statement_timeout)
            .await?;
        Ok(FencedStructuralFindingRefresh {
            outcome,
            generation_id: Some(generation_id),
        })
    }

    /// Replace the stored relation for one generation inside a single bounded,
    /// project-serialised transaction.
    async fn recompute_structural_findings(
        &self,
        project_id: &ProjectId,
        fingerprint: &FingerprintedGeneration,
        statement_timeout: Duration,
    ) -> Result<StructuralFindingRefresh, StorageError> {
        let schema = quoted_schema(&self.schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("structural-finding-refresh-begin"))?;
        set_local_statement_timeout(&mut transaction, statement_timeout)
            .await
            .map_err(|()| database_error("structural-finding-refresh-timeout"))?;
        query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!(
                "{REFRESH_LOCK_NAMESPACE}:{}:{}",
                self.schema.as_str(),
                fingerprint.generation_id
            ))
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("structural-finding-refresh-lock"))?;

        // Another agent may have completed the identical recomputation while this
        // transaction waited for the lock.
        let stored = query(AssertSqlSafe(format!(
            r#"SELECT runs.inputs_digest
                FROM {schema}."structural_finding_runs" AS runs
                WHERE runs.project_id = CAST($1 AS uuid)
                  AND runs.generation_id = CAST($2 AS uuid)"#
        )))
        .bind(project_id.as_str())
        .bind(&fingerprint.generation_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| database_error("structural-finding-refresh-recheck"))?
        .map(|row| row.try_get::<String, _>(0))
        .transpose()
        .map_err(|_| StorageError::CorruptStoredValue {
            field: "inputs_digest",
        })?;
        if stored.is_some_and(|digest| digest == fingerprint.inputs_digest) {
            transaction
                .commit()
                .await
                .map_err(|_| database_error("structural-finding-refresh-commit"))?;
            return Ok(StructuralFindingRefresh::Current);
        }

        query(AssertSqlSafe(format!(
            r#"DELETE FROM {schema}."structural_finding_runs"
                WHERE project_id = CAST($1 AS uuid)
                  AND generation_id = CAST($2 AS uuid)"#
        )))
        .bind(project_id.as_str())
        .bind(&fingerprint.generation_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| database_error("structural-finding-refresh-clear"))?;
        query(AssertSqlSafe(format!(
            r#"INSERT INTO {schema}."structural_finding_runs" (
                    project_id, generation_id, inputs_digest, analyzed_symbols
                )
                VALUES (CAST($1 AS uuid), CAST($2 AS uuid), $3, 0)"#
        )))
        .bind(project_id.as_str())
        .bind(&fingerprint.generation_id)
        .bind(&fingerprint.inputs_digest)
        .execute(&mut *transaction)
        .await
        .map_err(|_| database_error("structural-finding-refresh-open"))?;
        let store = format!(
            "{}{}",
            finding_ctes(&schema),
            include_str!("sql/structural_finding_store.sql").replace("{schema}", &schema),
        );
        query(AssertSqlSafe(store))
            .bind(project_id.as_str())
            .bind(&fingerprint.generation_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                if matches!(
                    error,
                    sqlx_core::error::Error::Database(ref database)
                        if database.code().as_deref() == Some("57014")
                ) {
                    StorageError::StatementTimeout {
                        operation: "structural-finding-refresh-store",
                    }
                } else {
                    database_error("structural-finding-refresh-store")
                }
            })?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error("structural-finding-refresh-commit"))?;
        Ok(StructuralFindingRefresh::Recomputed)
    }

    /// Exact current input fingerprint, or `None` without a published generation.
    async fn structural_finding_fingerprint(
        &self,
        project_id: &ProjectId,
    ) -> Result<Option<FingerprintedGeneration>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement =
            include_str!("sql/structural_finding_inputs_digest.sql").replace("{schema}", &schema);
        let row = query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(detector_contract_digest())
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("structural-finding-fingerprint"))?;
        row.map(|row| {
            Ok(FingerprintedGeneration {
                generation_id: row.try_get("generation_id").map_err(|_| {
                    StorageError::CorruptStoredValue {
                        field: "generation_id",
                    }
                })?,
                inputs_digest: row.try_get("inputs_digest").map_err(|_| {
                    StorageError::CorruptStoredValue {
                        field: "inputs_digest",
                    }
                })?,
            })
        })
        .transpose()
    }

    /// Stored fingerprint for one generation, if the relation was ever computed.
    async fn stored_structural_finding_digest(
        &self,
        project_id: &ProjectId,
        generation_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT runs.inputs_digest
                FROM {schema}."structural_finding_runs" AS runs
                WHERE runs.project_id = CAST($1 AS uuid)
                  AND runs.generation_id = CAST($2 AS uuid)"#
        );
        query(AssertSqlSafe(statement))
            .bind(project_id.as_str())
            .bind(generation_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("structural-finding-stored-digest"))?
            .map(|row| {
                row.try_get::<String, _>(0)
                    .map_err(|_| StorageError::CorruptStoredValue {
                        field: "inputs_digest",
                    })
            })
            .transpose()
    }
}
