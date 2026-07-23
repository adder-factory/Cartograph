//! Validated configuration for the Rust/PostgreSQL Cartograph runtime.
//!
//! The database URL is secret-bearing input. It stays wrapped in
//! [`secrecy::SecretString`] after validation and is never included in an error
//! or debug representation.

use std::{env, num::NonZeroU32, time::Duration};

use secrecy::SecretString;
use thiserror::Error;
use url::Url;

/// Environment variable containing the only supported v2 database URL.
pub const DATABASE_URL_ENV: &str = "CARTOGRAPH_DATABASE_URL";
/// Environment variable controlling the bounded PostgreSQL connection pool.
pub const DATABASE_MAX_CONNECTIONS_ENV: &str = "CARTOGRAPH_DATABASE_MAX_CONNECTIONS";
/// Environment variable controlling pool acquisition timeout in milliseconds.
pub const DATABASE_ACQUIRE_TIMEOUT_MS_ENV: &str = "CARTOGRAPH_DATABASE_ACQUIRE_TIMEOUT_MS";

const DEFAULT_MAX_CONNECTIONS: u32 = 8;
const MAX_CONNECTIONS_LIMIT: u32 = 64;
const DEFAULT_ACQUIRE_TIMEOUT_MS: u64 = 5_000;
const MAX_ACQUIRE_TIMEOUT_MS: u64 = 120_000;

struct BoundedIntegerInput<'a, T> {
    key: &'static str,
    raw: Option<&'a str>,
    default: T,
    maximum: T,
}

/// Validated Postgres-only database settings.
#[derive(Clone)]
pub struct DatabaseSettings {
    url: SecretString,
    max_connections: NonZeroU32,
    acquire_timeout: Duration,
}

impl std::fmt::Debug for DatabaseSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DatabaseSettings")
            .field("url", &"[REDACTED]")
            .field("max_connections", &self.max_connections)
            .field("acquire_timeout", &self.acquire_timeout)
            .finish()
    }
}

impl DatabaseSettings {
    /// Load settings from the process environment and validate every value.
    pub fn from_env() -> Result<Self, ConfigError> {
        let database_url =
            env::var(DATABASE_URL_ENV).map_err(|_| ConfigError::MissingDatabaseUrl)?;
        let max_connections = env::var(DATABASE_MAX_CONNECTIONS_ENV).ok();
        let acquire_timeout_ms = env::var(DATABASE_ACQUIRE_TIMEOUT_MS_ENV).ok();
        Self::parse(
            &database_url,
            max_connections.as_deref(),
            acquire_timeout_ms.as_deref(),
        )
    }

    /// Validate settings supplied by a non-environment boundary, such as a
    /// future project config loader.
    pub fn parse(
        database_url: &str,
        max_connections: Option<&str>,
        acquire_timeout_ms: Option<&str>,
    ) -> Result<Self, ConfigError> {
        validate_database_url(database_url)?;
        let max_connections = parse_bounded_nonzero_u32(BoundedIntegerInput {
            key: DATABASE_MAX_CONNECTIONS_ENV,
            raw: max_connections,
            default: DEFAULT_MAX_CONNECTIONS,
            maximum: MAX_CONNECTIONS_LIMIT,
        })?;
        let acquire_timeout_ms = parse_bounded_nonzero_u64(BoundedIntegerInput {
            key: DATABASE_ACQUIRE_TIMEOUT_MS_ENV,
            raw: acquire_timeout_ms,
            default: DEFAULT_ACQUIRE_TIMEOUT_MS,
            maximum: MAX_ACQUIRE_TIMEOUT_MS,
        })?;

        Ok(Self {
            url: SecretString::from(database_url.to_owned()),
            max_connections,
            acquire_timeout: Duration::from_millis(acquire_timeout_ms),
        })
    }

    /// The validated secret-bearing connection URL.
    #[must_use]
    pub const fn url(&self) -> &SecretString {
        &self.url
    }

    /// Maximum number of concurrent PostgreSQL connections.
    #[must_use]
    pub const fn max_connections(&self) -> NonZeroU32 {
        self.max_connections
    }

    /// Maximum time to wait for a pooled connection.
    #[must_use]
    pub const fn acquire_timeout(&self) -> Duration {
        self.acquire_timeout
    }
}

/// Configuration failures whose messages never echo secret-bearing input.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    /// No v2 database URL was supplied.
    #[error("{DATABASE_URL_ENV} is required; Cartograph v2 supports PostgreSQL only")]
    MissingDatabaseUrl,
    /// The URL could not be parsed.
    #[error("{DATABASE_URL_ENV} is not a valid URL")]
    InvalidDatabaseUrl,
    /// A non-PostgreSQL scheme was supplied.
    #[error("{DATABASE_URL_ENV} must use the postgres or postgresql scheme")]
    UnsupportedDatabaseScheme,
    /// A network host is required in the first v2 runtime slice.
    #[error("{DATABASE_URL_ENV} must include a database host")]
    MissingDatabaseHost,
    /// A bounded numeric setting was malformed or outside its range.
    #[error("{key} must be an integer in the inclusive range {minimum}..={maximum}")]
    InvalidBoundedInteger {
        /// Environment/config key whose value failed validation.
        key: &'static str,
        /// Smallest accepted value.
        minimum: u64,
        /// Largest accepted value.
        maximum: u64,
    },
}

fn validate_database_url(database_url: &str) -> Result<(), ConfigError> {
    let parsed = Url::parse(database_url).map_err(|_| ConfigError::InvalidDatabaseUrl)?;
    if !matches!(parsed.scheme(), "postgres" | "postgresql") {
        return Err(ConfigError::UnsupportedDatabaseScheme);
    }
    if parsed.host_str().is_none() {
        return Err(ConfigError::MissingDatabaseHost);
    }
    Ok(())
}

fn parse_bounded_nonzero_u32(
    input: BoundedIntegerInput<'_, u32>,
) -> Result<NonZeroU32, ConfigError> {
    let value = match input.raw {
        Some(raw) => raw.parse::<u32>().ok(),
        None => Some(input.default),
    }
    .filter(|value| *value <= input.maximum)
    .and_then(NonZeroU32::new)
    .ok_or(ConfigError::InvalidBoundedInteger {
        key: input.key,
        minimum: 1,
        maximum: u64::from(input.maximum),
    })?;
    Ok(value)
}

fn parse_bounded_nonzero_u64(input: BoundedIntegerInput<'_, u64>) -> Result<u64, ConfigError> {
    match input.raw {
        Some(raw) => raw.parse::<u64>().ok(),
        None => Some(input.default),
    }
    .filter(|value| (1..=input.maximum).contains(value))
    .ok_or(ConfigError::InvalidBoundedInteger {
        key: input.key,
        minimum: 1,
        maximum: input.maximum,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::ExposeSecret;

    const VALID_URL: &str = "postgresql://cartograph:secret@localhost:5433/cartograph";

    #[test]
    fn accepts_postgres_and_applies_bounded_defaults() {
        let settings = DatabaseSettings::parse(VALID_URL, None, None);
        let settings = match settings {
            Ok(settings) => settings,
            Err(error) => panic!("valid settings unexpectedly failed: {error}"),
        };

        assert_eq!(settings.url().expose_secret(), VALID_URL);
        assert_eq!(settings.max_connections().get(), DEFAULT_MAX_CONNECTIONS);
        assert_eq!(
            settings.acquire_timeout(),
            Duration::from_millis(DEFAULT_ACQUIRE_TIMEOUT_MS)
        );
    }

    #[test]
    fn rejects_sqlite_without_echoing_the_secret_input() {
        let input = "sqlite:///tmp/private-cartograph.db?password=should-not-leak";
        let error = DatabaseSettings::parse(input, None, None).err();
        let error = match error {
            Some(error) => error,
            None => panic!("SQLite URL was accepted"),
        };

        assert_eq!(error, ConfigError::UnsupportedDatabaseScheme);
        assert!(!error.to_string().contains("should-not-leak"));
        assert!(!format!("{error:?}").contains("should-not-leak"));
    }

    #[test]
    fn debug_output_redacts_database_credentials() {
        let settings = DatabaseSettings::parse(VALID_URL, Some("3"), Some("7000"));
        let settings = match settings {
            Ok(settings) => settings,
            Err(error) => panic!("valid settings unexpectedly failed: {error}"),
        };
        let rendered = format!("{settings:?}");

        assert!(rendered.contains("[REDACTED]"));
        assert!(!rendered.contains("secret"));
        assert!(!rendered.contains("localhost"));
    }

    #[test]
    fn rejects_zero_and_excessive_pool_limits() {
        for invalid in ["0", "65", "not-a-number"] {
            let error = DatabaseSettings::parse(VALID_URL, Some(invalid), None).err();
            assert!(matches!(
                error,
                Some(ConfigError::InvalidBoundedInteger {
                    key: DATABASE_MAX_CONNECTIONS_ENV,
                    minimum: 1,
                    maximum: 64,
                })
            ));
        }
    }

    #[test]
    fn rejects_url_without_network_host() {
        assert_eq!(
            DatabaseSettings::parse("postgresql:///cartograph", None, None).err(),
            Some(ConfigError::MissingDatabaseHost)
        );
    }
}
