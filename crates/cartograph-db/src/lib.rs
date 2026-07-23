//! PostgreSQL-only persistence and capability checks for Cartograph v2.

mod capabilities;
mod database;
mod generation;
mod ingest;
mod leases;
mod managed;
mod migrations;
mod search;

use std::str::FromStr;

pub use capabilities::{CapabilityCheck, CapabilityReport, CheckStatus, probe_capabilities};
use cartograph_config::DatabaseSettings;
pub use database::{CartographDatabase, StorageError};
pub use generation::{
    CurrentGeneration, FailGenerationError, FailedGeneration, GenerationContents, NewGeneration,
    NewProject, PrepareGenerationError, PublishGenerationError, ReadyGeneration,
    RecoverableGeneration, StagedGeneration,
};
pub use ingest::{
    EdgeInput, FileInput, GenerationFacts, ReferenceInput, SearchDocumentInput, SymbolInput,
};
pub use leases::{LeaseError, LeaseOwner, LeaseRequest, LeaseStatus, LeaseTarget, ProjectLease};
pub use managed::{
    DEFAULT_MANAGED_DATABASE_PORT, MANAGED_DATABASE_IMAGE, ManagedContainerState, ManagedDatabase,
    ManagedDatabaseError, ManagedDatabaseStatus, ManagedStartReport,
};
pub use migrations::{MigrationError, MigrationReport};
pub use search::{SearchHit, SearchQuery};
use secrecy::ExposeSecret;
use sqlx_core::pool::PoolOptions;
use sqlx_postgres::{PgConnectOptions, PgPool, Postgres};
use thiserror::Error;

/// Connect to the configured PostgreSQL database with a bounded pool.
pub async fn connect(settings: &DatabaseSettings) -> Result<PgPool, DatabaseError> {
    let options = PgConnectOptions::from_str(settings.url().expose_secret())
        .map_err(|_| DatabaseError::InvalidConnectionOptions)?
        .application_name("cartograph-v2");

    PoolOptions::<Postgres>::new()
        .max_connections(settings.max_connections().get())
        .acquire_timeout(settings.acquire_timeout())
        .connect_with(options)
        .await
        .map_err(|_| DatabaseError::ConnectionFailed)
}

/// Database failures whose public rendering cannot expose credentials.
#[derive(Debug, Error)]
pub enum DatabaseError {
    /// The validated URL could not be converted into driver options.
    #[error("PostgreSQL connection options are invalid")]
    InvalidConnectionOptions,
    /// Connection or authentication failed.
    #[error("could not connect to PostgreSQL; verify the server, credentials, and TLS settings")]
    ConnectionFailed,
    /// A capability probe query failed unexpectedly.
    #[error("PostgreSQL capability probe failed during {check}")]
    CapabilityProbe {
        /// Stable name of the failed probe.
        check: &'static str,
    },
}
