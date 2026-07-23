//! PostgreSQL-only persistence and capability checks for Cartograph v2.

mod capabilities;

use std::str::FromStr;

pub use capabilities::{CapabilityCheck, CapabilityReport, CheckStatus, probe_capabilities};
use cartograph_config::DatabaseSettings;
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
