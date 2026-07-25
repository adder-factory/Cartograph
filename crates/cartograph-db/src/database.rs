use std::time::Duration;

use cartograph_config::DatabaseSchema;
use cartograph_domain::GenerationId;
use sqlx_core::{query::query, row::Row};
use sqlx_postgres::{PgConnection, PgPool, PgRow};
use thiserror::Error;

/// PostgreSQL-backed v2 data plane bound to one validated Cartograph schema.
#[derive(Clone)]
pub struct CartographDatabase {
    pub(crate) pool: PgPool,
    pub(crate) schema: DatabaseSchema,
}

impl CartographDatabase {
    /// Bind an established PostgreSQL pool to one validated schema.
    #[must_use]
    pub const fn new(pool: PgPool, schema: DatabaseSchema) -> Self {
        Self { pool, schema }
    }

    /// Configured schema identity.
    #[must_use]
    pub const fn schema(&self) -> &DatabaseSchema {
        &self.schema
    }

    /// Re-probe the live PostgreSQL 18, ParadeDB, pgvector, and tokenizer contract.
    pub async fn capability_report(&self) -> Result<crate::CapabilityReport, crate::DatabaseError> {
        crate::probe_capabilities(&self.pool).await
    }

    /// Close every pooled PostgreSQL connection owned by this service.
    pub async fn close(self) {
        self.pool.close().await;
    }
}

/// Expected persistence failures with credential-safe public messages.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum StorageError {
    /// A caller supplied an invalid bounded field.
    #[error("invalid {field} in Cartograph storage request")]
    InvalidInput {
        /// Stable field name; input contents are intentionally omitted.
        field: &'static str,
    },
    /// A database operation failed. Driver text is omitted because it may
    /// contain query data or deployment details.
    #[error("Cartograph PostgreSQL operation failed during {operation}")]
    DatabaseOperation {
        /// Stable operation identifier.
        operation: &'static str,
    },
    /// A type-state transition disagreed with durable database state.
    #[error("generation cannot transition from {actual} to {requested}")]
    InvalidGenerationTransition {
        /// State currently stored in PostgreSQL.
        actual: String,
        /// State required by this operation.
        requested: &'static str,
    },
    /// A database row contains an identity or enum value this binary cannot parse.
    #[error("Cartograph PostgreSQL data violates the {field} domain contract")]
    CorruptStoredValue {
        /// Stable field name; raw stored contents are intentionally omitted.
        field: &'static str,
    },
    /// A generation token no longer has a corresponding durable row.
    #[error("generation does not exist in the configured Cartograph schema")]
    GenerationNotFound,
    /// A newer generation is already visible and cannot be replaced by an
    /// older ready token.
    #[error(
        "generation sequence {candidate_sequence} is not newer than current sequence {current_sequence}"
    )]
    StaleGeneration {
        /// Sequence carried by the ready token.
        candidate_sequence: i64,
        /// Sequence already published for the project.
        current_sequence: i64,
    },
    /// A generation mutation did not hold the current unexpired exact lease token.
    #[error("Cartograph generation mutation lost its exact PostgreSQL lease fence")]
    LeaseFenceLost,
    /// A read stage's expected publication is no longer the project pointer.
    #[error("Cartograph current generation changed during bounded retrieval")]
    CurrentGenerationChanged,
    /// A generation has no verified immutable BM25 relation.
    #[error("Cartograph generation search relation is unavailable")]
    SearchRelationUnavailable,
    /// A project reached the hard bound for retained generation search relations.
    #[error("Cartograph project search relation limit is reached")]
    SearchRelationLimitReached,
}

pub(crate) fn quoted_schema(schema: &DatabaseSchema) -> String {
    // DatabaseSchema accepts ASCII identifier characters only and enforces the
    // PostgreSQL 63-byte limit. Quoting still prevents keyword/case ambiguity.
    format!("\"{}\"", schema.as_str())
}

pub(crate) async fn set_local_statement_timeout(
    connection: &mut PgConnection,
    timeout: Duration,
) -> Result<(), ()> {
    let millis = i64::try_from(timeout.as_millis()).map_err(|_| ())?;
    if millis == 0 {
        return Err(());
    }
    query("SELECT set_config('statement_timeout', $1, true)")
        .bind(format!("{millis}ms"))
        .execute(connection)
        .await
        .map(|_| ())
        .map_err(|_| ())
}

pub(crate) fn read_stored_string(
    row: &PgRow,
    index: usize,
    field: &'static str,
) -> Result<String, StorageError> {
    row.try_get::<String, _>(index)
        .map_err(|_| stored_value_error(field))
}

pub(crate) fn parse_stored_generation_id(
    row: &PgRow,
    index: usize,
) -> Result<GenerationId, StorageError> {
    let raw = read_stored_string(row, index, "generation_id")?;
    GenerationId::parse(&raw).map_err(|_| stored_value_error("generation_id"))
}

pub(crate) const fn stored_value_error(field: &'static str) -> StorageError {
    StorageError::CorruptStoredValue { field }
}
