use std::time::Duration;

use cartograph_domain::{
    ContentDigest, NormalizedPath, ProjectId, ProjectOperation, SourceLanguage,
};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use thiserror::Error;

use crate::{
    CartographDatabase,
    database::{quoted_schema, set_local_statement_timeout},
};

const CACHE_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const CACHE_USAGE_TOUCH_INTERVAL: Duration = Duration::from_hours(1);
const PATH_DIGEST_DOMAIN: &[u8] = b"cartograph-v2-native-parse-cache-path-v1";
const MAXIMUM_RETAINED_CONTRACTS: u16 = 8;
const MAXIMUM_RETAINED_ROWS: u64 = 1_000_000;
const MAXIMUM_RETAINED_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAXIMUM_RETENTION_DELETIONS: u32 = 100_000;
const DEFAULT_RETAINED_CONTRACTS: u16 = 2;
const DEFAULT_RETAINED_ROWS: u64 = 20_000;
const DEFAULT_RETAINED_PAYLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_RETENTION_DELETIONS: u32 = 10_000;
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
    /// Stable project ID for this record.
    pub project_id: ProjectId,
    /// Digest-fenced extractor contract digest for this record.
    pub extractor_contract_digest: ContentDigest,
    /// Project-relative path for this record.
    pub path: NormalizedPath,
    /// Language for this record.
    pub language: SourceLanguage,
    /// Digest-fenced content hash for this record.
    pub content_hash: ContentDigest,
    /// Number of bytes used by the source.
    pub source_bytes: u64,
}

impl NativeParseCacheKey {
    #[must_use]
    /// Creates a validated native parse cache key.
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
    /// Returns the project ID.
    pub const fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    #[must_use]
    /// Returns the extractor contract digest.
    pub const fn extractor_contract_digest(&self) -> &ContentDigest {
        &self.extractor_contract_digest
    }

    #[must_use]
    /// Returns the path.
    pub const fn path(&self) -> &NormalizedPath {
        &self.path
    }

    #[must_use]
    /// Returns the language.
    pub const fn language(&self) -> SourceLanguage {
        self.language
    }

    #[must_use]
    /// Returns the content hash.
    pub const fn content_hash(&self) -> &ContentDigest {
        &self.content_hash
    }

    #[must_use]
    /// Returns the source bytes.
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
    /// Returns the payload.
    pub const fn payload(&self) -> &[u8] {
        self.payload.as_slice()
    }

    #[must_use]
    /// Returns the payload digest.
    pub const fn payload_digest(&self) -> &ContentDigest {
        &self.payload_digest
    }

    #[must_use]
    /// Returns the source bytes.
    pub const fn source_bytes(&self) -> u64 {
        self.source_bytes
    }
}

/// Outcome of an immutable cache write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeParseCacheWrite {
    /// Represents the inserted native parse cache write.
    Inserted,
    /// Represents the already present native parse cache write.
    AlreadyPresent,
}

/// Cross-contract row and byte ceilings for one project's native parse cache.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeParseCacheRetentionPolicy {
    capacity: NativeParseCacheRetentionCapacity,
    deletion_batch: u32,
}

/// Cross-contract logical capacity retained for one project's native parse cache.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeParseCacheRetentionCapacity {
    /// Number of contracts.
    pub contracts: u16,
    /// Number of rows.
    pub rows: u64,
    /// Number of bytes used by the payload.
    pub payload_bytes: u64,
}

/// Caller-selected parse-cache ceilings validated as one typed input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeParseCacheRetentionPolicyInput {
    /// Capacity for this record.
    pub capacity: NativeParseCacheRetentionCapacity,
    /// Maximum rows removed by one bounded cleanup transaction.
    pub deletion_batch: u32,
}

impl NativeParseCacheRetentionPolicy {
    /// Validate one bounded cache-retention policy.
    /// # Errors
    ///
    /// Returns an error if retained contract, row, payload-byte, or deletion
    /// limits are zero or exceed their cache-retention hard caps.
    pub const fn new(
        input: NativeParseCacheRetentionPolicyInput,
    ) -> Result<Self, NativeParseCacheError> {
        if input.capacity.contracts == 0 || input.capacity.contracts > MAXIMUM_RETAINED_CONTRACTS {
            return Err(NativeParseCacheError::InvalidRetentionPolicy);
        }
        if input.capacity.rows == 0 || input.capacity.rows > MAXIMUM_RETAINED_ROWS {
            return Err(NativeParseCacheError::InvalidRetentionPolicy);
        }
        if input.capacity.payload_bytes == 0
            || input.capacity.payload_bytes > MAXIMUM_RETAINED_PAYLOAD_BYTES
        {
            return Err(NativeParseCacheError::InvalidRetentionPolicy);
        }
        if input.deletion_batch == 0 || input.deletion_batch > MAXIMUM_RETENTION_DELETIONS {
            return Err(NativeParseCacheError::InvalidRetentionPolicy);
        }
        Ok(Self {
            capacity: input.capacity,
            deletion_batch: input.deletion_batch,
        })
    }

    /// Conservative automatic policy: current plus one recent contract, with
    /// independent row, logical-payload-byte, and per-call deletion caps.
    #[must_use]
    pub const fn automatic() -> Self {
        Self {
            capacity: NativeParseCacheRetentionCapacity {
                contracts: DEFAULT_RETAINED_CONTRACTS,
                rows: DEFAULT_RETAINED_ROWS,
                payload_bytes: DEFAULT_RETAINED_PAYLOAD_BYTES,
            },
            deletion_batch: DEFAULT_RETENTION_DELETIONS,
        }
    }

    #[must_use]
    /// Returns the maximum contracts.
    pub const fn maximum_contracts(self) -> u16 {
        self.capacity.contracts
    }

    #[must_use]
    /// Returns the maximum rows.
    pub const fn maximum_rows(self) -> u64 {
        self.capacity.rows
    }

    #[must_use]
    /// Returns the maximum payload bytes.
    pub const fn maximum_payload_bytes(self) -> u64 {
        self.capacity.payload_bytes
    }

    #[must_use]
    /// Returns the maximum deletions.
    pub const fn maximum_deletions(self) -> u32 {
        self.deletion_batch
    }
}

impl Default for NativeParseCacheRetentionPolicy {
    fn default() -> Self {
        Self::automatic()
    }
}

/// Exact project, current extractor contract, lease fence, and deadline for
/// one bounded cache-retention transaction.
pub struct NativeParseCacheRetentionRequest<'a> {
    /// Stable project ID for this record.
    pub project_id: &'a ProjectId,
    /// Digest-fenced protected contract digest for this record.
    pub protected_contract_digest: &'a ContentDigest,
    /// Policy for this record.
    pub policy: NativeParseCacheRetentionPolicy,
    /// Fence for this record.
    pub fence: &'a crate::LeaseFence,
    /// Statement timeout for this record.
    pub statement_timeout: Duration,
}

/// Exact logical cache pressure before or after bounded cleanup.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeParseCacheStats {
    /// Number of rows.
    pub rows: u64,
    /// Number of contracts.
    pub contracts: u64,
    /// Number of bytes used by the payload.
    pub payload_bytes: u64,
}

/// Bounded cache cleanup result. Physical heap/TOAST reclamation remains a
/// separate explicit database-maintenance concern.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeParseCacheRetentionReport {
    /// Before for this record.
    pub before: NativeParseCacheStats,
    /// After for this record.
    pub after: NativeParseCacheStats,
    /// Number of rows removed.
    pub rows_removed: u64,
    /// Number of payload bytes removed.
    pub payload_bytes_removed: u64,
    /// Whether this value is deletion limit reached.
    pub deletion_limit_reached: bool,
    #[serde(flatten)]
    /// Pressure for this record.
    pub pressure: NativeParseCacheBudgetPressure,
}

/// Remaining logical budget pressure after bounded parse-cache cleanup.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeParseCacheBudgetPressure {
    /// Whether this value is over row budget.
    pub over_row_budget: bool,
    /// Whether this value is over payload byte budget.
    pub over_payload_byte_budget: bool,
    /// Whether this value is over contract budget.
    pub over_contract_budget: bool,
}

/// Credential- and source-safe parse-cache failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum NativeParseCacheError {
    #[error("invalid native parse-cache {field}")]
    /// Supplied input violates a documented bound or invariant.
    InvalidInput {
        /// Caller-controlled field that violated its documented bound.
        field: &'static str,
    },
    #[error("native parse-cache row violates its durable contract")]
    /// A stored row violates its durable typed contract.
    CorruptStoredValue,
    #[error("native parse-cache identity produced conflicting immutable facts")]
    /// An existing cache key has different validated payload bytes.
    PayloadConflict,
    #[error("invalid native parse-cache retention policy")]
    /// Retention limits are zero, inconsistent, or exceed hard ceilings.
    InvalidRetentionPolicy,
    #[error("native parse-cache cleanup lost its exact migration lease fence")]
    /// The operation lost its exact project lease fence.
    LeaseFenceLost,
    #[error("Cartograph PostgreSQL parse-cache operation failed during {operation}")]
    /// PostgreSQL could not complete the named operation.
    DatabaseOperation {
        /// Bounded operation label identifying the failed PostgreSQL phase.
        operation: &'static str,
    },
}

impl CartographDatabase {
    /// Load one exact path/content/extractor result and refresh its usage
    /// timestamp at most once per bounded touch interval.
    /// # Errors
    ///
    /// Returns an error if the cache key is invalid, timestamp arithmetic
    /// overflows, PostgreSQL fails, or stored payload metadata is inconsistent.
    pub async fn load_native_parse_cache(
        &self,
        key: &NativeParseCacheKey,
    ) -> Result<Option<NativeParseCacheRecord>, NativeParseCacheError> {
        validate_key(key)?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"SELECT payload, payload_digest, source_bytes,
                      last_used_at <= clock_timestamp() - $7 * interval '1 millisecond'
                          AS touch_required
               FROM {schema}."native_parse_cache"
               WHERE project_id = $1::uuid
                 AND extractor_contract_digest = $2
                 AND path_digest = $3
                 AND language = $4
                 AND content_hash = $5
                 AND normalized_path = $6"#
        );
        let touch_interval_millis = i64::try_from(CACHE_USAGE_TOUCH_INTERVAL.as_millis())
            .map_err(|_| database_error("load"))?;
        let row = query(AssertSqlSafe(statement))
            .bind(key.project_id.as_str())
            .bind(key.extractor_contract_digest.as_str())
            .bind(path_digest(&key.path))
            .bind(key.language.as_str())
            .bind(key.content_hash.as_str())
            .bind(key.path.as_str())
            .bind(touch_interval_millis)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("load"))?;
        let Some(row) = row else {
            return Ok(None);
        };
        let touch_required = row
            .try_get::<bool, _>(3)
            .map_err(|_| NativeParseCacheError::CorruptStoredValue)?;
        let record = decode_record(&row)?;
        if touch_required {
            let touch = format!(
                r#"UPDATE {schema}."native_parse_cache"
                   SET last_used_at = clock_timestamp()
                   WHERE project_id = $1::uuid
                     AND extractor_contract_digest = $2
                     AND path_digest = $3
                     AND language = $4
                     AND content_hash = $5
                     AND normalized_path = $6
                     AND last_used_at <= clock_timestamp() - $7 * interval '1 millisecond'"#
            );
            query(AssertSqlSafe(touch))
                .bind(key.project_id.as_str())
                .bind(key.extractor_contract_digest.as_str())
                .bind(path_digest(&key.path))
                .bind(key.language.as_str())
                .bind(key.content_hash.as_str())
                .bind(key.path.as_str())
                .bind(touch_interval_millis)
                .execute(&self.pool)
                .await
                .map_err(|_| database_error("touch"))?;
        }
        Ok(Some(record))
    }

    /// Persist one immutable extraction result and discard older content for the same path.
    /// # Errors
    ///
    /// Returns an error if the key/source size or payload is invalid, or the
    /// transactional upsert and obsolete-content deletion cannot commit.
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
    /// # Errors
    ///
    /// Returns an error if the exact cache key is invalid or PostgreSQL cannot
    /// delete the matching path/content/contract row.
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

    /// Delete a bounded oldest-first batch outside the current extractor
    /// contract and configured cross-contract row/byte ceilings.
    /// # Errors
    ///
    /// Returns an error if retention/deadline bounds or the lease fence are
    /// invalid, or the bounded oldest-first cleanup cannot commit.
    pub async fn cleanup_native_parse_cache(
        &self,
        request: NativeParseCacheRetentionRequest<'_>,
    ) -> Result<NativeParseCacheRetentionReport, NativeParseCacheError> {
        validate_retention_request(&request)?;
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("retention-begin"))?;
        set_local_statement_timeout(&mut transaction, request.statement_timeout)
            .await
            .map_err(|()| NativeParseCacheError::InvalidRetentionPolicy)?;
        let result = cleanup_native_parse_cache_transaction(&mut transaction, self, &request).await;
        match result {
            Ok(report) => {
                transaction
                    .commit()
                    .await
                    .map_err(|_| database_error("retention-commit"))?;
                Ok(report)
            }
            Err(error) => {
                transaction
                    .rollback()
                    .await
                    .map_err(|_| database_error("retention-rollback"))?;
                Err(error)
            }
        }
    }
}

const NATIVE_PARSE_CACHE_RETENTION_SQL: &str = r#"WITH recent_contracts AS MATERIALIZED (
        SELECT extractor_contract_digest
        FROM {schema}."native_parse_cache"
        WHERE project_id = $1::uuid
          AND extractor_contract_digest <> $2
        GROUP BY extractor_contract_digest
        ORDER BY max(last_used_at) DESC, extractor_contract_digest
        LIMIT $3
    ), protected_totals AS MATERIALIZED (
        SELECT count(*)::bigint AS rows,
               COALESCE(sum(payload_bytes), 0)::bigint AS payload_bytes
        FROM {schema}."native_parse_cache"
        WHERE project_id = $1::uuid
          AND extractor_contract_digest = $2
    ), optional_ranked AS MATERIALIZED (
        SELECT cache.project_id, cache.extractor_contract_digest,
               cache.path_digest, cache.language, cache.content_hash,
               cache.last_used_at, cache.payload_bytes,
               row_number() OVER (
                   ORDER BY cache.last_used_at DESC, cache.created_at DESC,
                            cache.extractor_contract_digest, cache.path_digest,
                            cache.language, cache.content_hash
               )::bigint AS retained_rank,
               sum(cache.payload_bytes) OVER (
                   ORDER BY cache.last_used_at DESC, cache.created_at DESC,
                            cache.extractor_contract_digest, cache.path_digest,
                            cache.language, cache.content_hash
               )::bigint AS retained_payload_bytes
        FROM {schema}."native_parse_cache" AS cache
        INNER JOIN recent_contracts USING (extractor_contract_digest)
        WHERE cache.project_id = $1::uuid
    ), candidates AS MATERIALIZED (
        SELECT cache.project_id, cache.extractor_contract_digest,
               cache.path_digest, cache.language, cache.content_hash,
               cache.last_used_at, cache.payload_bytes, 0 AS priority
        FROM {schema}."native_parse_cache" AS cache
        WHERE cache.project_id = $1::uuid
          AND cache.extractor_contract_digest <> $2
          AND NOT EXISTS (
              SELECT 1 FROM recent_contracts
              WHERE recent_contracts.extractor_contract_digest = cache.extractor_contract_digest
          )
        UNION ALL
        SELECT optional.project_id, optional.extractor_contract_digest,
               optional.path_digest, optional.language, optional.content_hash,
               optional.last_used_at, optional.payload_bytes, 1 AS priority
        FROM optional_ranked AS optional
        CROSS JOIN protected_totals AS protected
        WHERE protected.rows + optional.retained_rank > $4
           OR protected.payload_bytes + optional.retained_payload_bytes > $5
    ), bounded AS MATERIALIZED (
        SELECT project_id, extractor_contract_digest, path_digest,
               language, content_hash, payload_bytes
        FROM candidates
        ORDER BY priority, last_used_at, extractor_contract_digest,
                 path_digest, language, content_hash
        LIMIT $6
    ), deleted AS (
        DELETE FROM {schema}."native_parse_cache" AS cache
        USING bounded
        WHERE cache.project_id = bounded.project_id
          AND cache.extractor_contract_digest = bounded.extractor_contract_digest
          AND cache.path_digest = bounded.path_digest
          AND cache.language = bounded.language
          AND cache.content_hash = bounded.content_hash
        RETURNING cache.payload_bytes
    )
    SELECT count(*)::bigint AS rows_removed,
           COALESCE(sum(payload_bytes), 0)::bigint AS payload_bytes_removed
    FROM deleted"#;

async fn cleanup_native_parse_cache_transaction(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &NativeParseCacheRetentionRequest<'_>,
) -> Result<NativeParseCacheRetentionReport, NativeParseCacheError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(crate::leases::project_lock_key(
            &database.schema,
            request.project_id,
        ))
        .execute(&mut *connection)
        .await
        .map_err(|_| database_error("retention-lock"))?;
    require_live_retention_fence(connection, database, request).await?;
    let before = load_cache_stats(connection, database, request.project_id).await?;
    let schema = quoted_schema(&database.schema);
    let recent_contracts = i64::from(request.policy.maximum_contracts().saturating_sub(1));
    let maximum_rows = i64::try_from(request.policy.maximum_rows())
        .map_err(|_| NativeParseCacheError::InvalidRetentionPolicy)?;
    let maximum_payload_bytes = i64::try_from(request.policy.maximum_payload_bytes())
        .map_err(|_| NativeParseCacheError::InvalidRetentionPolicy)?;
    let maximum_deletions = i64::from(request.policy.maximum_deletions());
    let statement = NATIVE_PARSE_CACHE_RETENTION_SQL.replace("{schema}", &schema);
    let deleted = query(AssertSqlSafe(statement))
        .bind(request.project_id.as_str())
        .bind(request.protected_contract_digest.as_str())
        .bind(recent_contracts)
        .bind(maximum_rows)
        .bind(maximum_payload_bytes)
        .bind(maximum_deletions)
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| database_error("retention-delete"))?;
    let rows_removed = read_nonnegative(&deleted, "rows_removed")?;
    let payload_bytes_removed = read_nonnegative(&deleted, "payload_bytes_removed")?;
    let after = load_cache_stats(connection, database, request.project_id).await?;
    require_live_retention_fence(connection, database, request).await?;
    Ok(NativeParseCacheRetentionReport {
        before,
        after,
        rows_removed,
        payload_bytes_removed,
        deletion_limit_reached: rows_removed == u64::from(request.policy.maximum_deletions()),
        pressure: NativeParseCacheBudgetPressure {
            over_row_budget: after.rows > request.policy.maximum_rows(),
            over_payload_byte_budget: after.payload_bytes > request.policy.maximum_payload_bytes(),
            over_contract_budget: after.contracts > u64::from(request.policy.maximum_contracts()),
        },
    })
}

async fn load_cache_stats(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    project_id: &ProjectId,
) -> Result<NativeParseCacheStats, NativeParseCacheError> {
    let schema = quoted_schema(&database.schema);
    let statement = format!(
        r#"SELECT count(*)::bigint AS rows,
                  count(DISTINCT extractor_contract_digest)::bigint AS contracts,
                  COALESCE(sum(payload_bytes), 0)::bigint AS payload_bytes
           FROM {schema}."native_parse_cache"
           WHERE project_id = $1::uuid"#
    );
    let row = query(AssertSqlSafe(statement))
        .bind(project_id.as_str())
        .fetch_one(connection)
        .await
        .map_err(|_| database_error("retention-stats"))?;
    Ok(NativeParseCacheStats {
        rows: read_nonnegative(&row, "rows")?,
        contracts: read_nonnegative(&row, "contracts")?,
        payload_bytes: read_nonnegative(&row, "payload_bytes")?,
    })
}

async fn require_live_retention_fence(
    connection: &mut sqlx_postgres::PgConnection,
    database: &CartographDatabase,
    request: &NativeParseCacheRetentionRequest<'_>,
) -> Result<(), NativeParseCacheError> {
    let schema = quoted_schema(&database.schema);
    let statement = format!(
        r#"SELECT 1 FROM {schema}."project_operation_leases"
           WHERE project_id = $1::uuid
             AND operation = 'migration'
             AND lease_id = $2::uuid
             AND generation_id IS NULL
             AND expires_at > clock_timestamp()
           FOR UPDATE"#
    );
    if query(AssertSqlSafe(statement))
        .bind(request.project_id.as_str())
        .bind(request.fence.lease_id().as_str())
        .fetch_optional(connection)
        .await
        .map_err(|_| database_error("retention-fence"))?
        .is_some()
    {
        Ok(())
    } else {
        Err(NativeParseCacheError::LeaseFenceLost)
    }
}

fn validate_retention_request(
    request: &NativeParseCacheRetentionRequest<'_>,
) -> Result<(), NativeParseCacheError> {
    if request.statement_timeout.is_zero()
        || request.fence.target().project_id() != request.project_id
        || request.fence.target().operation() != ProjectOperation::Migration
        || request.fence.target().generation_id().is_some()
    {
        Err(NativeParseCacheError::LeaseFenceLost)
    } else {
        NativeParseCacheRetentionPolicy::new(NativeParseCacheRetentionPolicyInput {
            capacity: request.policy.capacity,
            deletion_batch: request.policy.deletion_batch,
        })
        .map(|_| ())
    }
}

fn read_nonnegative(
    row: &sqlx_postgres::PgRow,
    column: &'static str,
) -> Result<u64, NativeParseCacheError> {
    row.try_get::<i64, _>(column)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(NativeParseCacheError::CorruptStoredValue)
}

fn validate_key(key: &NativeParseCacheKey) -> Result<(), NativeParseCacheError> {
    i64::try_from(key.source_bytes)
        .map(|_| ())
        .map_err(|_| NativeParseCacheError::InvalidInput {
            field: "source_bytes",
        })
}

fn decode_record(
    row: &sqlx_postgres::PgRow,
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
