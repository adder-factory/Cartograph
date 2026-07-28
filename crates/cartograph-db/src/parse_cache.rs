use std::time::Duration;

use cartograph_domain::{ContentDigest, NormalizedPath, ProjectId, SourceLanguage};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use thiserror::Error;

use crate::{
    CartographDatabase,
    database::{quoted_schema, set_local_statement_timeout},
};

const CACHE_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const PATH_DIGEST_DOMAIN: &[u8] = b"cartograph-v2-native-parse-cache-path-v1";
/// Maximum serialized facts retained for one immutable source file.
pub const MAX_NATIVE_PARSE_CACHE_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;

/// Exact path-sensitive identity for one native extraction result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeParseCacheKey {
    project_id: ProjectId,
    extractor_contract_digest: ContentDigest,
    path: NormalizedPath,
    language: SourceLanguage,
    content_hash: ContentDigest,
    source_bytes: u64,
}

/// Source and extractor identity used to construct one native parse-cache key.
pub struct NativeParseCacheKeyInput {
    pub project_id: ProjectId,
    pub extractor_contract_digest: ContentDigest,
    pub path: NormalizedPath,
    pub language: SourceLanguage,
    pub content_hash: ContentDigest,
    pub source_bytes: u64,
}

impl NativeParseCacheKey {
    #[must_use]
    pub fn new(input: NativeParseCacheKeyInput) -> Self {
        let NativeParseCacheKeyInput {
            project_id,
            extractor_contract_digest,
            path,
            language,
            content_hash,
            source_bytes,
        } = input;
        Self {
            project_id,
            extractor_contract_digest,
            path,
            language,
            content_hash,
            source_bytes,
        }
    }

    #[must_use]
    pub const fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    #[must_use]
    pub const fn extractor_contract_digest(&self) -> &ContentDigest {
        &self.extractor_contract_digest
    }

    #[must_use]
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    #[must_use]
    pub const fn language(&self) -> SourceLanguage {
        self.language
    }

    #[must_use]
    pub const fn content_hash(&self) -> &ContentDigest {
        &self.content_hash
    }

    #[must_use]
    pub const fn source_bytes(&self) -> u64 {
        self.source_bytes
    }
}

/// Bounded serialized extraction facts loaded from PostgreSQL.
#[derive(Debug, PartialEq, Eq)]
pub struct NativeParseCacheRecord {
    payload: Vec<u8>,
    payload_digest: ContentDigest,
    source_bytes: u64,
}

impl NativeParseCacheRecord {
    #[must_use]
    pub const fn payload(&self) -> &[u8] {
        self.payload.as_slice()
    }

    #[must_use]
    pub const fn payload_digest(&self) -> &ContentDigest {
        &self.payload_digest
    }

    #[must_use]
    pub const fn source_bytes(&self) -> u64 {
        self.source_bytes
    }
}

/// Outcome of an immutable cache write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeParseCacheWrite {
    Inserted,
    AlreadyPresent,
}

/// Credential- and source-safe parse-cache failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum NativeParseCacheError {
    #[error("invalid native parse-cache {field}")]
    InvalidInput { field: &'static str },
    #[error("native parse-cache row violates its durable contract")]
    CorruptStoredValue,
    #[error("native parse-cache identity produced conflicting immutable facts")]
    PayloadConflict,
    #[error("Cartograph PostgreSQL parse-cache operation failed during {operation}")]
    DatabaseOperation { operation: &'static str },
}

impl CartographDatabase {
    /// Load one exact path/content/extractor result and refresh only its usage timestamp.
    pub async fn load_native_parse_cache(
        &self,
        key: &NativeParseCacheKey,
    ) -> Result<Option<NativeParseCacheRecord>, NativeParseCacheError> {
        validate_key(key)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"UPDATE {schema}."native_parse_cache"
               SET last_used_at = clock_timestamp()
               WHERE project_id = $1::uuid
                 AND extractor_contract_digest = $2
                 AND path_digest = $3
                 AND language = $4
                 AND content_hash = $5
                 AND normalized_path = $6
               RETURNING payload, payload_digest, source_bytes"#
        );
        let row = query(AssertSqlSafe(statement))
            .bind(key.project_id.as_str())
            .bind(key.extractor_contract_digest.as_str())
            .bind(path_digest(&key.path))
            .bind(key.language.as_str())
            .bind(key.content_hash.as_str())
            .bind(key.path.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("load"))?;
        row.map(decode_record).transpose()
    }

    /// Persist one immutable extraction result and discard older content for the same path.
    pub async fn store_native_parse_cache(
        &self,
        key: &NativeParseCacheKey,
        payload: &[u8],
    ) -> Result<NativeParseCacheWrite, NativeParseCacheError> {
        validate_key(key)?;
        if payload.is_empty() || payload.len() > MAX_NATIVE_PARSE_CACHE_PAYLOAD_BYTES {
            return Err(NativeParseCacheError::InvalidInput { field: "payload" });
        }
        let source_bytes =
            i64::try_from(key.source_bytes).map_err(|_| NativeParseCacheError::InvalidInput {
                field: "source_bytes",
            })?;
        let payload_digest = ContentDigest::from_bytes(*blake3::hash(payload).as_bytes());
        let path_digest = path_digest(&key.path);
        let schema = quoted_schema(&self.schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("begin"))?;
        set_local_statement_timeout(&mut transaction, CACHE_OPERATION_TIMEOUT)
            .await
            .map_err(|()| database_error("timeout"))?;
        let prune = format!(
            r#"DELETE FROM {schema}."native_parse_cache"
               WHERE project_id = $1::uuid
                 AND extractor_contract_digest = $2
                 AND path_digest = $3
                 AND normalized_path = $4
                 AND (language <> $5 OR content_hash <> $6)"#
        );
        query(AssertSqlSafe(prune))
            .bind(key.project_id.as_str())
            .bind(key.extractor_contract_digest.as_str())
            .bind(&path_digest)
            .bind(key.path.as_str())
            .bind(key.language.as_str())
            .bind(key.content_hash.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("prune-path"))?;
        let insert = format!(
            r#"INSERT INTO {schema}."native_parse_cache" (
                   project_id, extractor_contract_digest, path_digest, normalized_path,
                   language, content_hash, source_bytes, payload, payload_digest
               ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (
                   project_id, extractor_contract_digest, path_digest, language, content_hash
               ) DO UPDATE SET last_used_at = clock_timestamp()
               RETURNING payload_digest, source_bytes, (xmax = 0) AS inserted"#
        );
        let row = query(AssertSqlSafe(insert))
            .bind(key.project_id.as_str())
            .bind(key.extractor_contract_digest.as_str())
            .bind(path_digest)
            .bind(key.path.as_str())
            .bind(key.language.as_str())
            .bind(key.content_hash.as_str())
            .bind(source_bytes)
            .bind(payload)
            .bind(payload_digest.as_str())
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| database_error("store"))?;
        let stored_digest = row
            .try_get::<String, _>(0)
            .ok()
            .and_then(|value| ContentDigest::parse(&value).ok())
            .ok_or(NativeParseCacheError::CorruptStoredValue)?;
        let stored_source_bytes = row
            .try_get::<i64, _>(1)
            .ok()
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(NativeParseCacheError::CorruptStoredValue)?;
        if stored_digest != payload_digest || stored_source_bytes != key.source_bytes {
            return Err(NativeParseCacheError::PayloadConflict);
        }
        let inserted = row
            .try_get::<bool, _>(2)
            .map_err(|_| NativeParseCacheError::CorruptStoredValue)?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error("commit"))?;
        Ok(if inserted {
            NativeParseCacheWrite::Inserted
        } else {
            NativeParseCacheWrite::AlreadyPresent
        })
    }

    /// Evict one exact invalid row without touching another path/content contract.
    pub async fn evict_native_parse_cache(
        &self,
        key: &NativeParseCacheKey,
    ) -> Result<bool, NativeParseCacheError> {
        validate_key(key)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"DELETE FROM {schema}."native_parse_cache"
               WHERE project_id = $1::uuid
                 AND extractor_contract_digest = $2
                 AND path_digest = $3
                 AND language = $4
                 AND content_hash = $5
                 AND normalized_path = $6"#
        );
        query(AssertSqlSafe(statement))
            .bind(key.project_id.as_str())
            .bind(key.extractor_contract_digest.as_str())
            .bind(path_digest(&key.path))
            .bind(key.language.as_str())
            .bind(key.content_hash.as_str())
            .bind(key.path.as_str())
            .execute(&self.pool)
            .await
            .map(|result| result.rows_affected() == 1)
            .map_err(|_| database_error("evict"))
    }
}

fn validate_key(key: &NativeParseCacheKey) -> Result<(), NativeParseCacheError> {
    i64::try_from(key.source_bytes)
        .map(|_| ())
        .map_err(|_| NativeParseCacheError::InvalidInput {
            field: "source_bytes",
        })
}

fn decode_record(
    row: sqlx_postgres::PgRow,
) -> Result<NativeParseCacheRecord, NativeParseCacheError> {
    let payload = row
        .try_get::<Vec<u8>, _>(0)
        .map_err(|_| NativeParseCacheError::CorruptStoredValue)?;
    if payload.is_empty() || payload.len() > MAX_NATIVE_PARSE_CACHE_PAYLOAD_BYTES {
        return Err(NativeParseCacheError::CorruptStoredValue);
    }
    let payload_digest = row
        .try_get::<String, _>(1)
        .ok()
        .and_then(|value| ContentDigest::parse(&value).ok())
        .ok_or(NativeParseCacheError::CorruptStoredValue)?;
    let source_bytes = row
        .try_get::<i64, _>(2)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(NativeParseCacheError::CorruptStoredValue)?;
    Ok(NativeParseCacheRecord {
        payload,
        payload_digest,
        source_bytes,
    })
}

fn path_digest(path: &NormalizedPath) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(PATH_DIGEST_DOMAIN);
    hasher.update(path.as_str().as_bytes());
    hasher.finalize().to_hex().to_string()
}

const fn database_error(operation: &'static str) -> NativeParseCacheError {
    NativeParseCacheError::DatabaseOperation { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_identity_is_bounded_and_domain_separated() {
        let first = NormalizedPath::parse("src/lib.rs").unwrap_or_else(|_| unreachable!());
        let second = NormalizedPath::parse("src/main.rs").unwrap_or_else(|_| unreachable!());
        assert_eq!(path_digest(&first).len(), 64);
        assert_ne!(path_digest(&first), path_digest(&second));
    }
}
