use std::time::Duration;

use cartograph_domain::{GenerationId, LeaseId, ProjectId, ProjectOperation};
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::{PgConnection, PgRow};
use thiserror::Error;

use crate::CartographDatabase;

const LEASE_LOCK_NAMESPACE: &str = "cartograph-v2-operation";
const MIN_LEASE_DURATION: Duration = Duration::from_secs(1);
const MAX_LEASE_DURATION: Duration = Duration::from_secs(5 * 60);
const MAX_PROCESS_START_BYTES: usize = 256;
const STATUS_LEASE_ID_COLUMN: usize = 0;
const STATUS_OWNER_PID_COLUMN: usize = 1;
const STATUS_OWNER_PROCESS_START_COLUMN: usize = 2;
const STATUS_GENERATION_ID_COLUMN: usize = 3;
const STATUS_ACQUIRED_AT_COLUMN: usize = 4;
const STATUS_HEARTBEAT_AT_COLUMN: usize = 5;
const STATUS_EXPIRES_AT_COLUMN: usize = 6;
const STATUS_EXPIRED_COLUMN: usize = 7;

/// Stable process identity recorded with a project-operation lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseOwner {
    pid: u32,
    process_start: String,
}

impl LeaseOwner {
    /// Build owner metadata. It is validated at the database boundary.
    #[must_use]
    pub fn new(pid: u32, process_start: impl Into<String>) -> Self {
        Self {
            pid,
            process_start: process_start.into(),
        }
    }

    /// Operating-system process identifier.
    #[must_use]
    pub const fn pid(&self) -> u32 {
        self.pid
    }

    /// Boot/session-qualified process start marker supplied by the runtime.
    #[must_use]
    pub fn process_start(&self) -> &str {
        &self.process_start
    }
}

/// One project-local mutating operation protected by a durable lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseTarget {
    project_id: ProjectId,
    operation: ProjectOperation,
    generation_id: Option<GenerationId>,
}

impl LeaseTarget {
    /// Bind an operation to a project and, when relevant, one generation.
    #[must_use]
    pub const fn new(
        project_id: ProjectId,
        operation: ProjectOperation,
        generation_id: Option<GenerationId>,
    ) -> Self {
        Self {
            project_id,
            operation,
            generation_id,
        }
    }

    /// Project whose mutation is serialized.
    #[must_use]
    pub const fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    /// Stable operation category.
    #[must_use]
    pub const fn operation(&self) -> ProjectOperation {
        self.operation
    }

    /// Optional generation associated with the mutation.
    #[must_use]
    pub const fn generation_id(&self) -> Option<&GenerationId> {
        self.generation_id.as_ref()
    }
}

/// Validated-at-write request to acquire or take over an expired lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseRequest {
    target: LeaseTarget,
    owner: LeaseOwner,
    duration: Duration,
}

impl LeaseRequest {
    /// Build a lease request. Bounds are enforced immediately before mutation.
    #[must_use]
    pub const fn new(target: LeaseTarget, owner: LeaseOwner, duration: Duration) -> Self {
        Self {
            target,
            owner,
            duration,
        }
    }
}

/// Opaque proof that this process acquired the current database lease token.
#[derive(Debug)]
pub struct ProjectLease {
    target: LeaseTarget,
    lease_id: LeaseId,
    duration: Duration,
    expires_at: String,
}

impl ProjectLease {
    /// Protected project operation.
    #[must_use]
    pub const fn target(&self) -> &LeaseTarget {
        &self.target
    }

    /// Unique ownership token changed on every stale-owner takeover.
    #[must_use]
    pub const fn lease_id(&self) -> &LeaseId {
        &self.lease_id
    }

    /// Database-rendered expiry timestamp from the latest acquire/heartbeat.
    #[must_use]
    pub fn expires_at(&self) -> &str {
        &self.expires_at
    }
}

/// Observable lease metadata suitable for diagnostics and agent status output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LeaseStatus {
    /// Protected project.
    pub project_id: ProjectId,
    /// Protected operation category.
    pub operation: ProjectOperation,
    /// Unique current ownership token.
    pub lease_id: LeaseId,
    /// Owner process identifier.
    pub owner_pid: u32,
    /// Boot/session-qualified process start marker.
    pub owner_process_start: String,
    /// Optional generation associated with the mutation.
    pub generation_id: Option<GenerationId>,
    /// Database acquisition timestamp.
    pub acquired_at: String,
    /// Database timestamp of the most recent heartbeat.
    pub heartbeat_at: String,
    /// Database expiry timestamp.
    pub expires_at: String,
    /// Whether PostgreSQL's clock considers the row eligible for takeover.
    pub expired: bool,
}

/// Lease failures with credential-safe and query-safe public messages.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum LeaseError {
    /// A caller supplied invalid owner or duration metadata.
    #[error("invalid {field} in Cartograph lease request")]
    InvalidInput {
        /// Stable field name; input contents are intentionally omitted.
        field: &'static str,
    },
    /// Another non-expired owner currently holds the project operation.
    #[error("Cartograph project operation is already leased")]
    Busy,
    /// The token expired, was taken over, or was already released.
    #[error("Cartograph project operation lease is no longer owned by this token")]
    Lost,
    /// A PostgreSQL operation failed without exposing driver or query text.
    #[error("Cartograph PostgreSQL lease operation failed during {operation}")]
    DatabaseOperation {
        /// Stable operation identifier.
        operation: &'static str,
    },
    /// A durable lease row violated a branded-ID or metadata contract.
    #[error("Cartograph PostgreSQL lease data violates the {field} domain contract")]
    CorruptStoredValue {
        /// Stable field name; stored contents are intentionally omitted.
        field: &'static str,
    },
}

struct AcquiredLease {
    lease_id: LeaseId,
    expires_at: String,
}

struct AcquireTransactionInput<'a> {
    schema: &'a cartograph_config::DatabaseSchema,
    request: &'a LeaseRequest,
    duration_millis: i64,
}

impl CartographDatabase {
    /// Acquire an operation lease, or atomically take over its expired row,
    /// under a transaction-scoped advisory lock.
    pub async fn acquire_lease(&self, request: LeaseRequest) -> Result<ProjectLease, LeaseError> {
        let duration_millis = validate_request(&request)?;
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| database_error("acquire-begin"))?;
        let acquired = acquire_transaction(
            &mut transaction,
            AcquireTransactionInput {
                schema: &self.schema,
                request: &request,
                duration_millis,
            },
        )
        .await;
        let acquired = match acquired {
            Ok(acquired) => acquired,
            Err(error) => {
                return match transaction.rollback().await {
                    Ok(()) => Err(error),
                    Err(_) => Err(database_error("acquire-rollback")),
                };
            }
        };
        transaction
            .commit()
            .await
            .map_err(|_| database_error("acquire-commit"))?;
        Ok(ProjectLease {
            target: request.target,
            lease_id: acquired.lease_id,
            duration: request.duration,
            expires_at: acquired.expires_at,
        })
    }

    /// Extend a lease only when its exact token is still current and unexpired.
    pub async fn heartbeat_lease(&self, lease: &mut ProjectLease) -> Result<(), LeaseError> {
        let duration_millis = duration_millis(lease.duration)?;
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"WITH lease_clock AS (SELECT clock_timestamp() AS now)
                UPDATE {schema}."project_operation_leases" AS leases
                SET heartbeat_at = lease_clock.now,
                    expires_at = lease_clock.now + $4 * interval '1 millisecond'
                FROM lease_clock
                WHERE leases.project_id = CAST($1 AS uuid)
                  AND leases.operation = $2
                  AND leases.lease_id = CAST($3 AS uuid)
                  AND leases.expires_at > lease_clock.now
                RETURNING leases.expires_at::text"#
        );
        let row = audited_query(sql)
            .bind(lease.target.project_id().as_str())
            .bind(lease.target.operation().as_str())
            .bind(lease.lease_id.as_str())
            .bind(duration_millis)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("heartbeat"))?
            .ok_or(LeaseError::Lost)?;
        lease.expires_at = read_nonempty_string(&row, 0, "expires_at")?;
        Ok(())
    }

    /// Release a lease only when its exact token is still current and unexpired.
    pub async fn release_lease(&self, lease: &ProjectLease) -> Result<(), LeaseError> {
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"DELETE FROM {schema}."project_operation_leases"
                WHERE project_id = CAST($1 AS uuid)
                  AND operation = $2
                  AND lease_id = CAST($3 AS uuid)
                  AND expires_at > clock_timestamp()"#
        );
        let result = audited_query(sql)
            .bind(lease.target.project_id().as_str())
            .bind(lease.target.operation().as_str())
            .bind(lease.lease_id.as_str())
            .execute(&self.pool)
            .await
            .map_err(|_| database_error("release"))?;
        if result.rows_affected() == 1 {
            Ok(())
        } else {
            Err(LeaseError::Lost)
        }
    }

    /// Read current or expired owner metadata without mutating lease state.
    pub async fn lease_status(
        &self,
        target: &LeaseTarget,
    ) -> Result<Option<LeaseStatus>, LeaseError> {
        let schema = crate::database::quoted_schema(&self.schema);
        let sql = format!(
            r#"WITH lease_clock AS (SELECT clock_timestamp() AS now)
                SELECT
                    leases.lease_id::text,
                    leases.owner_pid,
                    leases.owner_process_start,
                    leases.generation_id::text,
                    leases.acquired_at::text,
                    leases.heartbeat_at::text,
                    leases.expires_at::text,
                    leases.expires_at <= lease_clock.now
                FROM {schema}."project_operation_leases" AS leases
                CROSS JOIN lease_clock
                WHERE leases.project_id = CAST($1 AS uuid)
                  AND leases.operation = $2"#
        );
        let row = audited_query(sql)
            .bind(target.project_id().as_str())
            .bind(target.operation().as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| database_error("status"))?;
        row.map(|row| decode_status(&row, target)).transpose()
    }
}

async fn acquire_transaction(
    connection: &mut PgConnection,
    input: AcquireTransactionInput<'_>,
) -> Result<AcquiredLease, LeaseError> {
    let lock_row = query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{LEASE_LOCK_NAMESPACE}:{}:{}:{}",
            input.schema.as_str(),
            input.request.target.project_id(),
            input.request.target.operation().as_str()
        ))
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| database_error("advisory-lock"))?;
    let acquired_lock = lock_row
        .try_get::<bool, _>(0)
        .map_err(|_| corrupt("advisory_lock"))?;
    if !acquired_lock {
        return Err(LeaseError::Busy);
    }
    let schema = crate::database::quoted_schema(input.schema);
    let sql = format!(
        r#"WITH lease_clock AS (SELECT clock_timestamp() AS now)
            INSERT INTO {schema}."project_operation_leases" (
                project_id, operation, lease_id, owner_pid, owner_process_start,
                generation_id, acquired_at, heartbeat_at, expires_at
            )
            SELECT
                CAST($1 AS uuid), $2, gen_random_uuid(), $3, $4, CAST($5 AS uuid),
                lease_clock.now, lease_clock.now,
                lease_clock.now + $6 * interval '1 millisecond'
            FROM lease_clock
            ON CONFLICT (project_id, operation) DO UPDATE
            SET lease_id = EXCLUDED.lease_id,
                owner_pid = EXCLUDED.owner_pid,
                owner_process_start = EXCLUDED.owner_process_start,
                generation_id = EXCLUDED.generation_id,
                acquired_at = EXCLUDED.acquired_at,
                heartbeat_at = EXCLUDED.heartbeat_at,
                expires_at = EXCLUDED.expires_at
            WHERE project_operation_leases.expires_at <= EXCLUDED.acquired_at
            RETURNING lease_id::text, expires_at::text"#
    );
    let row = audited_query(sql)
        .bind(input.request.target.project_id().as_str())
        .bind(input.request.target.operation().as_str())
        .bind(i64::from(input.request.owner.pid))
        .bind(&input.request.owner.process_start)
        .bind(
            input
                .request
                .target
                .generation_id()
                .map(GenerationId::as_str),
        )
        .bind(input.duration_millis)
        .fetch_optional(connection)
        .await
        .map_err(|_| database_error("acquire"))?
        .ok_or(LeaseError::Busy)?;
    let raw_id = read_nonempty_string(&row, 0, "lease_id")?;
    let lease_id = LeaseId::parse(&raw_id).map_err(|_| corrupt("lease_id"))?;
    let expires_at = read_nonempty_string(&row, 1, "expires_at")?;
    Ok(AcquiredLease {
        lease_id,
        expires_at,
    })
}

fn decode_status(row: &PgRow, target: &LeaseTarget) -> Result<LeaseStatus, LeaseError> {
    let raw_id = read_nonempty_string(row, STATUS_LEASE_ID_COLUMN, "lease_id")?;
    let lease_id = LeaseId::parse(&raw_id).map_err(|_| corrupt("lease_id"))?;
    let raw_pid = row
        .try_get::<i64, _>(STATUS_OWNER_PID_COLUMN)
        .map_err(|_| corrupt("owner_pid"))?;
    let owner_pid = u32::try_from(raw_pid).map_err(|_| corrupt("owner_pid"))?;
    if owner_pid == 0 {
        return Err(corrupt("owner_pid"));
    }
    let owner_process_start = read_nonempty_string(
        row,
        STATUS_OWNER_PROCESS_START_COLUMN,
        "owner_process_start",
    )?;
    if owner_process_start.len() > MAX_PROCESS_START_BYTES || owner_process_start.contains('\0') {
        return Err(corrupt("owner_process_start"));
    }
    let generation_id = row
        .try_get::<Option<String>, _>(STATUS_GENERATION_ID_COLUMN)
        .map_err(|_| corrupt("generation_id"))?
        .map(|raw| GenerationId::parse(&raw).map_err(|_| corrupt("generation_id")))
        .transpose()?;
    let acquired_at = read_nonempty_string(row, STATUS_ACQUIRED_AT_COLUMN, "acquired_at")?;
    let heartbeat_at = read_nonempty_string(row, STATUS_HEARTBEAT_AT_COLUMN, "heartbeat_at")?;
    let expires_at = read_nonempty_string(row, STATUS_EXPIRES_AT_COLUMN, "expires_at")?;
    let expired = row
        .try_get::<bool, _>(STATUS_EXPIRED_COLUMN)
        .map_err(|_| corrupt("expired"))?;
    Ok(LeaseStatus {
        project_id: target.project_id().clone(),
        operation: target.operation(),
        lease_id,
        owner_pid,
        owner_process_start,
        generation_id,
        acquired_at,
        heartbeat_at,
        expires_at,
        expired,
    })
}

fn validate_request(request: &LeaseRequest) -> Result<i64, LeaseError> {
    if request.owner.pid == 0 {
        return Err(LeaseError::InvalidInput { field: "owner_pid" });
    }
    if request.owner.process_start.trim().is_empty()
        || request.owner.process_start.len() > MAX_PROCESS_START_BYTES
        || request.owner.process_start.contains('\0')
    {
        return Err(LeaseError::InvalidInput {
            field: "owner_process_start",
        });
    }
    duration_millis(request.duration)
}

fn duration_millis(duration: Duration) -> Result<i64, LeaseError> {
    if !(MIN_LEASE_DURATION..=MAX_LEASE_DURATION).contains(&duration) {
        return Err(LeaseError::InvalidInput {
            field: "lease_duration",
        });
    }
    i64::try_from(duration.as_millis()).map_err(|_| LeaseError::InvalidInput {
        field: "lease_duration",
    })
}

fn read_nonempty_string(
    row: &PgRow,
    index: usize,
    field: &'static str,
) -> Result<String, LeaseError> {
    let value = row
        .try_get::<String, _>(index)
        .map_err(|_| corrupt(field))?;
    if value.is_empty() || value.contains('\0') {
        Err(corrupt(field))
    } else {
        Ok(value)
    }
}

fn audited_query(
    sql: String,
) -> sqlx_core::query::Query<'static, sqlx_postgres::Postgres, sqlx_postgres::PgArguments> {
    // Dynamic content is limited to a conservatively validated DatabaseSchema
    // and is always double-quoted before insertion into the audited SQL.
    query(AssertSqlSafe(sql))
}

const fn database_error(operation: &'static str) -> LeaseError {
    LeaseError::DatabaseOperation { operation }
}

const fn corrupt(field: &'static str) -> LeaseError {
    LeaseError::CorruptStoredValue { field }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_OWNER_PID: u32 = 10;
    const ACCESSOR_OWNER_PID: u32 = 42;
    const VALID_DURATION_SECONDS: u64 = 30;
    const TOO_SHORT_DURATION_MILLIS: u64 = 999;
    const EXPECTED_DURATION_MILLIS: i64 = 30_000;

    fn target() -> LeaseTarget {
        let project_id = match ProjectId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
            Ok(project_id) => project_id,
            Err(error) => panic!("fixture project UUID is invalid: {error}"),
        };
        LeaseTarget::new(project_id, ProjectOperation::Index, None)
    }

    #[test]
    fn request_validation_rejects_ambiguous_owners_and_unbounded_durations() {
        let missing_pid = LeaseRequest::new(
            target(),
            LeaseOwner::new(0, "boot-a:100"),
            Duration::from_secs(VALID_DURATION_SECONDS),
        );
        let blank_start = LeaseRequest::new(
            target(),
            LeaseOwner::new(VALID_OWNER_PID, "   "),
            Duration::from_secs(VALID_DURATION_SECONDS),
        );
        let too_short = LeaseRequest::new(
            target(),
            LeaseOwner::new(VALID_OWNER_PID, "boot-a:100"),
            Duration::from_millis(TOO_SHORT_DURATION_MILLIS),
        );
        let too_long = LeaseRequest::new(
            target(),
            LeaseOwner::new(VALID_OWNER_PID, "boot-a:100"),
            MAX_LEASE_DURATION + Duration::from_secs(1),
        );

        assert_eq!(
            validate_request(&missing_pid),
            Err(LeaseError::InvalidInput { field: "owner_pid" })
        );
        assert_eq!(
            validate_request(&blank_start),
            Err(LeaseError::InvalidInput {
                field: "owner_process_start"
            })
        );
        assert_eq!(
            validate_request(&too_short),
            Err(LeaseError::InvalidInput {
                field: "lease_duration"
            })
        );
        assert_eq!(
            validate_request(&too_long),
            Err(LeaseError::InvalidInput {
                field: "lease_duration"
            })
        );
    }

    #[test]
    fn target_and_owner_accessors_preserve_branded_metadata() {
        let target = target();
        let owner = LeaseOwner::new(ACCESSOR_OWNER_PID, "boot-a:100");

        assert_eq!(target.operation(), ProjectOperation::Index);
        assert!(target.generation_id().is_none());
        assert_eq!(owner.pid(), ACCESSOR_OWNER_PID);
        assert_eq!(owner.process_start(), "boot-a:100");
        assert_eq!(
            duration_millis(Duration::from_secs(VALID_DURATION_SECONDS)),
            Ok(EXPECTED_DURATION_MILLIS)
        );
    }
}
