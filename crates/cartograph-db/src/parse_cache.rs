use std::{collections::BTreeSet, time::Duration};

use cartograph_domain::{
    ContentDigest, NormalizedPath, ProjectId, ProjectOperation, SourceLanguage,
};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::PgRow;
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
const MAXIMUM_CACHE_BATCH_ENTRIES: usize = 256;
const MAXIMUM_CACHE_BATCH_LOAD_BYTES: i64 = 64 * 1024 * 1024;
const MAXIMUM_CACHE_BATCH_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;
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

/// One owned immutable parse-cache row for bounded bulk publication.
pub struct NativeParseCacheEntry {
    key: NativeParseCacheKey,
    payload: Vec<u8>,
}

impl NativeParseCacheEntry {
    /// Bind one exact cache identity to its serialized extraction payload.
    #[must_use]
    pub fn new(key: NativeParseCacheKey, payload: Vec<u8>) -> Self {
        Self { key, payload }
    }
}

/// Insert/no-op counts from one atomic bounded cache publication.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NativeParseCacheBatchWrite {
    /// Newly inserted immutable rows.
    pub inserted: u64,
    /// Exact rows that were already present and only had usage refreshed.
    pub already_present: u64,
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

struct CacheKeyArrays {
    project_ids: Vec<String>,
    contracts: Vec<String>,
    path_digests: Vec<String>,
    languages: Vec<String>,
    content_hashes: Vec<String>,
    paths: Vec<String>,
}

struct CacheStoreBatch {
    keys: CacheKeyArrays,
    source_bytes: Vec<i64>,
    payloads: Vec<Vec<u8>>,
    payload_digests: Vec<String>,
    row_count: usize,
}

impl CacheKeyArrays {
    fn new(keys: &[NativeParseCacheKey]) -> Result<Self, NativeParseCacheError> {
        let mut arrays = Self {
            project_ids: Vec::new(),
            contracts: Vec::new(),
            path_digests: Vec::new(),
            languages: Vec::new(),
            content_hashes: Vec::new(),
            paths: Vec::new(),
        };
        arrays
            .project_ids
            .try_reserve_exact(keys.len())
            .map_err(|_| database_error("key-batch-reserve"))?;
        arrays
            .contracts
            .try_reserve_exact(keys.len())
            .map_err(|_| database_error("key-batch-reserve"))?;
        arrays
            .path_digests
            .try_reserve_exact(keys.len())
            .map_err(|_| database_error("key-batch-reserve"))?;
        arrays
            .languages
            .try_reserve_exact(keys.len())
            .map_err(|_| database_error("key-batch-reserve"))?;
        arrays
            .content_hashes
            .try_reserve_exact(keys.len())
            .map_err(|_| database_error("key-batch-reserve"))?;
        arrays
            .paths
            .try_reserve_exact(keys.len())
            .map_err(|_| database_error("key-batch-reserve"))?;
        for key in keys {
            arrays.project_ids.push(key.project_id.as_str().to_owned());
            arrays
                .contracts
                .push(key.extractor_contract_digest.as_str().to_owned());
            arrays.path_digests.push(path_digest(&key.path));
            arrays.languages.push(key.language.as_str().to_owned());
            arrays
                .content_hashes
                .push(key.content_hash.as_str().to_owned());
            arrays.paths.push(key.path.as_str().to_owned());
        }
        Ok(arrays)
    }
}

fn validate_cache_key_batch(keys: &[NativeParseCacheKey]) -> Result<(), NativeParseCacheError> {
    if keys.is_empty() || keys.len() > MAXIMUM_CACHE_BATCH_ENTRIES {
        return Err(NativeParseCacheError::InvalidInput { field: "keys" });
    }
    let mut unique = BTreeSet::new();
    for key in keys {
        validate_key(key)?;
        if !unique.insert((
            key.project_id.as_str(),
            key.extractor_contract_digest.as_str(),
            key.path.as_str(),
            key.language.as_str(),
            key.content_hash.as_str(),
        )) {
            return Err(NativeParseCacheError::InvalidInput { field: "keys" });
        }
    }
    Ok(())
}

fn prepare_cache_store_batch(
    entries: Vec<NativeParseCacheEntry>,
) -> Result<CacheStoreBatch, NativeParseCacheError> {
    if entries.is_empty() || entries.len() > MAXIMUM_CACHE_BATCH_ENTRIES {
        return Err(NativeParseCacheError::InvalidInput { field: "entries" });
    }
    let mut unique_paths = BTreeSet::new();
    let mut total_payload_bytes = 0_usize;
    for entry in &entries {
        validate_key(&entry.key)?;
        if entry.payload.is_empty() || entry.payload.len() > MAX_NATIVE_PARSE_CACHE_PAYLOAD_BYTES {
            return Err(NativeParseCacheError::InvalidInput { field: "payload" });
        }
        total_payload_bytes = total_payload_bytes
            .checked_add(entry.payload.len())
            .filter(|bytes| *bytes <= MAXIMUM_CACHE_BATCH_PAYLOAD_BYTES)
            .ok_or(NativeParseCacheError::InvalidInput { field: "payload" })?;
        if !unique_paths.insert((
            entry.key.project_id.as_str(),
            entry.key.extractor_contract_digest.as_str(),
            entry.key.path.as_str(),
        )) {
            return Err(NativeParseCacheError::InvalidInput { field: "entries" });
        }
    }
    let owned_keys = entries
        .iter()
        .map(|entry| entry.key.clone())
        .collect::<Vec<_>>();
    validate_cache_key_batch(&owned_keys)?;
    let keys = CacheKeyArrays::new(&owned_keys)?;
    drop(unique_paths);
    let row_count = entries.len();
    let mut source_bytes = Vec::new();
    let mut payloads = Vec::new();
    let mut payload_digests = Vec::new();
    source_bytes
        .try_reserve_exact(row_count)
        .map_err(|_| database_error("store-batch-reserve"))?;
    payloads
        .try_reserve_exact(row_count)
        .map_err(|_| database_error("store-batch-reserve"))?;
    payload_digests
        .try_reserve_exact(row_count)
        .map_err(|_| database_error("store-batch-reserve"))?;
    for entry in entries {
        source_bytes.push(i64::try_from(entry.key.source_bytes).map_err(|_| {
            NativeParseCacheError::InvalidInput {
                field: "source_bytes",
            }
        })?);
        payload_digests.push(
            ContentDigest::from_bytes(*blake3::hash(&entry.payload).as_bytes())
                .as_str()
                .to_owned(),
        );
        payloads.push(entry.payload);
    }
    Ok(CacheStoreBatch {
        keys,
        source_bytes,
        payloads,
        payload_digests,
        row_count,
    })
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

    /// Load a bounded ordered group of exact cache identities in one round trip.
    ///
    /// The returned vector preserves input order and refreshes stale usage timestamps
    /// in the same statement without exposing cache contents through errors.
    /// # Errors
    ///
    /// Returns an error when the group is empty/oversized/duplicated, a key is
    /// invalid, or PostgreSQL returns incomplete or corrupt stored metadata.
    pub async fn load_native_parse_cache_batch(
        &self,
        keys: &[NativeParseCacheKey],
    ) -> Result<Vec<Option<NativeParseCacheRecord>>, NativeParseCacheError> {
        validate_cache_key_batch(keys)?;
        let input = CacheKeyArrays::new(keys)?;
        let touch_interval_millis = i64::try_from(CACHE_USAGE_TOUCH_INTERVAL.as_millis())
            .map_err(|_| database_error("load-batch"))?;
        let schema = quoted_schema(&self.schema);
        let statement = format!(
            r#"WITH input AS (
                    SELECT project_id, extractor_contract_digest, path_digest,
                           language, content_hash, normalized_path, ordinality
                    FROM unnest(
                        CAST($1 AS uuid[]), CAST($2 AS text[]), CAST($3 AS text[]),
                        CAST($4 AS text[]), CAST($5 AS text[]), CAST($6 AS text[])
                    ) WITH ORDINALITY AS rows(
                        project_id, extractor_contract_digest, path_digest,
                        language, content_hash, normalized_path, ordinality
                    )
                ), matched AS (
                    SELECT input.ordinality, cache.payload, cache.payload_digest,
                           cache.source_bytes
                    FROM input
                    LEFT JOIN {schema}."native_parse_cache" AS cache
                      ON cache.project_id = input.project_id
                     AND cache.extractor_contract_digest = input.extractor_contract_digest
                     AND cache.path_digest = input.path_digest
                     AND cache.language = input.language
                     AND cache.content_hash = input.content_hash
                     AND cache.normalized_path = input.normalized_path
                ), stats AS (
                    SELECT COALESCE(sum(octet_length(payload)), 0) AS payload_bytes
                    FROM matched
                ), touched AS (
                    UPDATE {schema}."native_parse_cache" AS cache
                    SET last_used_at = clock_timestamp()
                    FROM input
                    WHERE cache.project_id = input.project_id
                      AND cache.extractor_contract_digest = input.extractor_contract_digest
                      AND cache.path_digest = input.path_digest
                      AND cache.language = input.language
                      AND cache.content_hash = input.content_hash
                      AND cache.normalized_path = input.normalized_path
                      AND cache.last_used_at <= clock_timestamp() - $7 * interval '1 millisecond'
                    RETURNING 1
                )
                SELECT matched.ordinality, matched.payload, matched.payload_digest,
                       matched.source_bytes, (SELECT count(*) FROM touched)
                FROM matched CROSS JOIN stats
                WHERE stats.payload_bytes <= $8
                ORDER BY matched.ordinality"#
        );
        let rows = query(AssertSqlSafe(statement))
            .bind(input.project_ids)
            .bind(input.contracts)
            .bind(input.path_digests)
            .bind(input.languages)
            .bind(input.content_hashes)
            .bind(input.paths)
            .bind(touch_interval_millis)
            .bind(MAXIMUM_CACHE_BATCH_LOAD_BYTES)
            .fetch_all(&self.pool)
            .await
            .map_err(|_| database_error("load-batch"))?;
        if rows.len() != keys.len() {
            return Err(NativeParseCacheError::CorruptStoredValue);
        }
        let mut records = Vec::new();
        records
            .try_reserve_exact(rows.len())
            .map_err(|_| database_error("load-batch-reserve"))?;
        for (index, row) in rows.iter().enumerate() {
            records.push(decode_batch_record(row, index)?);
        }
        Ok(records)
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

    /// Persist a bounded group of immutable extraction results atomically.
    ///
    /// Obsolete content for every included path is removed once, then exact rows
    /// are inserted or usage-refreshed through one array-backed statement.
    /// # Errors
    ///
    /// Returns an error when the group, key, payload, same-path identity, existing
    /// immutable payload, or complete PostgreSQL transaction is invalid.
    pub async fn store_native_parse_cache_batch(
        &self,
        entries: Vec<NativeParseCacheEntry>,
    ) -> Result<NativeParseCacheBatchWrite, NativeParseCacheError> {
        let batch = prepare_cache_store_batch(entries)?;
        let input = batch.keys;
        let schema = quoted_schema(&self.schema);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("store-batch-begin"))?;
        set_local_statement_timeout(&mut transaction, CACHE_OPERATION_TIMEOUT)
            .await
            .map_err(|()| database_error("store-batch-timeout"))?;
        let prune = format!(
            r#"DELETE FROM {schema}."native_parse_cache" AS cache
               USING unnest(
                   CAST($1 AS uuid[]), CAST($2 AS text[]), CAST($3 AS text[]),
                   CAST($4 AS text[]), CAST($5 AS text[]), CAST($6 AS text[])
               ) AS input(
                   project_id, extractor_contract_digest, path_digest,
                   normalized_path, language, content_hash
               )
               WHERE cache.project_id = input.project_id
                 AND cache.extractor_contract_digest = input.extractor_contract_digest
                 AND cache.path_digest = input.path_digest
                 AND cache.normalized_path = input.normalized_path
                 AND (cache.language <> input.language OR cache.content_hash <> input.content_hash)"#
        );
        query(AssertSqlSafe(prune))
            .bind(&input.project_ids)
            .bind(&input.contracts)
            .bind(&input.path_digests)
            .bind(&input.paths)
            .bind(&input.languages)
            .bind(&input.content_hashes)
            .execute(&mut *transaction)
            .await
            .map_err(|_| database_error("store-batch-prune"))?;
        let insert = format!(
            r#"INSERT INTO {schema}."native_parse_cache" (
                   project_id, extractor_contract_digest, path_digest, normalized_path,
                   language, content_hash, source_bytes, payload, payload_digest
               )
               SELECT project_id, extractor_contract_digest, path_digest, normalized_path,
                      language, content_hash, source_bytes, payload, payload_digest
               FROM unnest(
                   CAST($1 AS uuid[]), CAST($2 AS text[]), CAST($3 AS text[]),
                   CAST($4 AS text[]), CAST($5 AS text[]), CAST($6 AS text[]),
                   CAST($7 AS bigint[]), CAST($8 AS bytea[]), CAST($9 AS text[])
               ) AS input(
                   project_id, extractor_contract_digest, path_digest, normalized_path,
                   language, content_hash, source_bytes, payload, payload_digest
               )
               ON CONFLICT (
                   project_id, extractor_contract_digest, path_digest, language, content_hash
               ) DO UPDATE SET last_used_at = clock_timestamp()
                 WHERE {schema}."native_parse_cache".normalized_path = EXCLUDED.normalized_path
                   AND {schema}."native_parse_cache".payload_digest = EXCLUDED.payload_digest
                   AND {schema}."native_parse_cache".source_bytes = EXCLUDED.source_bytes
               RETURNING (xmax = 0) AS inserted"#
        );
        let rows = query(AssertSqlSafe(insert))
            .bind(&input.project_ids)
            .bind(&input.contracts)
            .bind(&input.path_digests)
            .bind(&input.paths)
            .bind(&input.languages)
            .bind(&input.content_hashes)
            .bind(batch.source_bytes)
            .bind(batch.payloads)
            .bind(batch.payload_digests)
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| database_error("store-batch"))?;
        if rows.len() != batch.row_count {
            return Err(NativeParseCacheError::PayloadConflict);
        }
        let inserted = rows.iter().try_fold(0_u64, |count, row| {
            row.try_get::<bool, _>(0)
                .ok()
                .and_then(|value| count.checked_add(u64::from(value)))
        });
        let inserted = inserted.ok_or(NativeParseCacheError::CorruptStoredValue)?;
        let total = u64::try_from(rows.len()).map_err(|_| database_error("store-batch-count"))?;
        transaction
            .commit()
            .await
            .map_err(|_| database_error("store-batch-commit"))?;
        Ok(NativeParseCacheBatchWrite {
            inserted,
            already_present: total.saturating_sub(inserted),
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
          AND NOT EXISTS (
              SELECT 1
              FROM {schema}."native_generation_spill_rows" AS spill
              WHERE spill.project_id = cache.project_id
                AND spill.cache_extractor_contract_digest = cache.extractor_contract_digest
                AND spill.cache_path_digest = cache.path_digest
                AND spill.cache_language = cache.language
                AND spill.cache_content_hash = cache.content_hash
          )
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
          AND NOT EXISTS (
              SELECT 1
              FROM {schema}."native_generation_spill_rows" AS spill
              WHERE spill.project_id = cache.project_id
                AND spill.cache_extractor_contract_digest = cache.extractor_contract_digest
                AND spill.cache_path_digest = cache.path_digest
                AND spill.cache_language = cache.language
                AND spill.cache_content_hash = cache.content_hash
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

fn decode_batch_record(
    row: &PgRow,
    index: usize,
) -> Result<Option<NativeParseCacheRecord>, NativeParseCacheError> {
    let ordinal = row
        .try_get::<i64, _>(0)
        .ok()
        .and_then(|value| usize::try_from(value).ok());
    if ordinal != Some(index.saturating_add(1)) {
        return Err(NativeParseCacheError::CorruptStoredValue);
    }
    let payload = row
        .try_get::<Option<Vec<u8>>, _>(1)
        .map_err(|_| NativeParseCacheError::CorruptStoredValue)?;
    let Some(payload) = payload else {
        return Ok(None);
    };
    if payload.is_empty() || payload.len() > MAX_NATIVE_PARSE_CACHE_PAYLOAD_BYTES {
        return Err(NativeParseCacheError::CorruptStoredValue);
    }
    let payload_digest = row
        .try_get::<Option<String>, _>(2)
        .ok()
        .flatten()
        .and_then(|value| ContentDigest::parse(&value).ok())
        .ok_or(NativeParseCacheError::CorruptStoredValue)?;
    let source_bytes = row
        .try_get::<Option<i64>, _>(3)
        .ok()
        .flatten()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(NativeParseCacheError::CorruptStoredValue)?;
    Ok(Some(NativeParseCacheRecord {
        payload,
        payload_digest,
        source_bytes,
    }))
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

pub(crate) fn path_digest(path: &NormalizedPath) -> String {
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
