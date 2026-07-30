use std::time::Duration;

use thiserror::Error;

const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const DEFAULT_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_PROGRESS_TIMEOUT: Duration = Duration::from_mins(1);
const DEFAULT_CANCELLATION_GRACE: Duration = Duration::from_secs(5);
const DEFAULT_MAX_WORKER_TASKS: usize = 64;
const DEFAULT_MAX_WORKER_BYTES: u64 = 256 * 1024 * 1024;
const MAX_WORKER_TASKS: usize = 1_024;
const MAX_WORKER_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_hours(24);
const MIN_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(2);
const FINISH_DATABASE_STEPS: u32 = 5;
const COPY_TIMEOUT_DIVISOR: u32 = 4;

/// Bounded deadlines used by one supervised indexing operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SupervisorConfig {
    pub(crate) deadlines: SupervisorDeadlines,
    pub(crate) workers: WorkerLimits,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SupervisorDeadlines {
    pub(crate) operation: Duration,
    pub(crate) heartbeat_interval: Duration,
    pub(crate) heartbeat_request: Duration,
    pub(crate) progress: Duration,
    pub(crate) cancellation_grace: Duration,
    copy: Option<Duration>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WorkerLimits {
    pub(crate) tasks: usize,
    pub(crate) bytes: u64,
}

impl SupervisorConfig {
    /// Create production-oriented defaults around an explicit whole-operation deadline.
    #[must_use]
    pub const fn new(operation_timeout: Duration) -> Self {
        Self {
            deadlines: SupervisorDeadlines {
                operation: operation_timeout,
                heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL,
                heartbeat_request: DEFAULT_HEARTBEAT_TIMEOUT,
                progress: DEFAULT_PROGRESS_TIMEOUT,
                cancellation_grace: DEFAULT_CANCELLATION_GRACE,
                copy: None,
            },
            workers: WorkerLimits {
                tasks: DEFAULT_MAX_WORKER_TASKS,
                bytes: DEFAULT_MAX_WORKER_BYTES,
            },
        }
    }

    /// Override how often PostgreSQL ownership is renewed.
    #[must_use]
    pub const fn with_heartbeat_interval(mut self, value: Duration) -> Self {
        self.deadlines.heartbeat_interval = value;
        self
    }

    /// Override the bound for one heartbeat/acquire/release database request.
    #[must_use]
    pub const fn with_heartbeat_timeout(mut self, value: Duration) -> Self {
        self.deadlines.heartbeat_request = value;
        self
    }

    /// Override the maximum time without a stage/progress update.
    #[must_use]
    pub const fn with_progress_timeout(mut self, value: Duration) -> Self {
        self.deadlines.progress = value;
        self
    }

    /// Override the grace period given to cooperative cancellation.
    #[must_use]
    pub const fn with_cancellation_grace(mut self, value: Duration) -> Self {
        self.deadlines.cancellation_grace = value;
        self
    }

    /// Override the server-side deadline for each PostgreSQL COPY statement.
    ///
    /// By default this is one quarter of the whole operation budget, entirely
    /// independent of the short lease-heartbeat request timeout.
    #[must_use]
    pub const fn with_copy_timeout(mut self, value: Duration) -> Self {
        self.deadlines.copy = Some(value);
        self
    }

    /// Set the hard number of running or completed-unobserved worker tasks.
    ///
    /// The scope has no hidden queue: admission is rejected when this cap is
    /// exhausted so a pipeline must apply its own bounded backpressure.
    #[must_use]
    pub const fn with_max_worker_tasks(mut self, value: usize) -> Self {
        self.workers.tasks = value;
        self
    }

    /// Set the hard byte reservation shared by supervisor-owned workers.
    #[must_use]
    pub const fn with_max_worker_bytes(mut self, value: u64) -> Self {
        self.workers.bytes = value;
        self
    }

    pub(crate) fn validate_for(
        self,
        lease_duration: Duration,
    ) -> Result<(), InvalidSupervisorConfig> {
        let deadlines = self.deadlines;
        require_nonzero_bounded(deadlines.operation, "operation_timeout")?;
        require_nonzero(deadlines.heartbeat_interval, "heartbeat_interval")?;
        require_nonzero(deadlines.heartbeat_request, "heartbeat_timeout")?;
        if deadlines.heartbeat_request < MIN_HEARTBEAT_TIMEOUT {
            return Err(invalid("heartbeat_timeout"));
        }
        require_nonzero(deadlines.progress, "progress_timeout")?;
        require_nonzero(deadlines.cancellation_grace, "cancellation_grace")?;
        require_nonzero(deadlines.copy_timeout(), "copy_timeout")?;
        require_nonzero(lease_duration, "lease_duration")?;
        if self.workers.tasks == 0 || self.workers.tasks > MAX_WORKER_TASKS {
            return Err(invalid("max_worker_tasks"));
        }
        if self.workers.bytes == 0 || self.workers.bytes > MAX_WORKER_BYTES {
            return Err(invalid("max_worker_bytes"));
        }
        if deadlines.heartbeat_interval >= lease_duration {
            return Err(invalid("heartbeat_interval"));
        }
        let database_finish_budget = deadlines
            .heartbeat_request
            .checked_mul(FINISH_DATABASE_STEPS)
            .ok_or(invalid("heartbeat_timeout"))?;
        let finish_budget = deadlines
            .cancellation_grace
            .checked_add(deadlines.copy_timeout())
            .ok_or(invalid("copy_timeout"))?
            .checked_add(database_finish_budget)
            .ok_or(invalid("cancellation_grace"))?;
        let lease_database_budget = deadlines
            .heartbeat_interval
            .checked_add(database_finish_budget)
            .ok_or(invalid("heartbeat_timeout"))?;
        if lease_database_budget >= lease_duration {
            return Err(invalid("heartbeat_timeout"));
        }
        let lease_cleanup_budget = lease_database_budget
            .checked_add(deadlines.cancellation_grace)
            .ok_or(invalid("cancellation_grace"))?;
        let lease_cleanup_budget = lease_cleanup_budget
            .checked_add(deadlines.copy_timeout())
            .ok_or(invalid("copy_timeout"))?;
        if lease_cleanup_budget >= lease_duration {
            return Err(invalid("cancellation_grace"));
        }
        let active_budget = deadlines
            .operation
            .checked_sub(finish_budget)
            .ok_or(invalid("operation_timeout"))?;
        if active_budget <= deadlines.heartbeat_request {
            return Err(invalid("operation_timeout"));
        }
        if deadlines.progress >= active_budget {
            return Err(invalid("progress_timeout"));
        }
        if deadlines.cancellation_grace >= deadlines.operation {
            return Err(invalid("cancellation_grace"));
        }
        Ok(())
    }
}

impl SupervisorDeadlines {
    pub(crate) fn statement_timeout(self) -> Duration {
        self.heartbeat_request / 2
    }

    pub(crate) fn copy_timeout(self) -> Duration {
        self.copy.unwrap_or(self.operation / COPY_TIMEOUT_DIVISOR)
    }

    pub(crate) fn finish_reserve(self) -> Duration {
        self.cancellation_grace + self.copy_timeout() + self.database_finish_reserve()
    }

    pub(crate) fn database_finish_reserve(self) -> Duration {
        self.heartbeat_request * FINISH_DATABASE_STEPS
    }
}

/// A supervisor deadline relation is zero, unbounded, or internally unsafe.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[error("invalid {field} in Cartograph indexer supervisor configuration")]
pub struct InvalidSupervisorConfig {
    field: &'static str,
}

impl InvalidSupervisorConfig {
    /// Stable field identifier; no deployment data is included.
    #[must_use]
    pub const fn field(self) -> &'static str {
        self.field
    }
}

fn require_nonzero(value: Duration, field: &'static str) -> Result<(), InvalidSupervisorConfig> {
    if value.is_zero() {
        Err(invalid(field))
    } else {
        Ok(())
    }
}

fn require_nonzero_bounded(
    value: Duration,
    field: &'static str,
) -> Result<(), InvalidSupervisorConfig> {
    require_nonzero(value, field)?;
    if value > MAX_OPERATION_TIMEOUT {
        Err(invalid(field))
    } else {
        Ok(())
    }
}

const fn invalid(field: &'static str) -> InvalidSupervisorConfig {
    InvalidSupervisorConfig { field }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
    const TEST_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
    const TEST_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(1);
    const TEST_PROGRESS_TIMEOUT: Duration = Duration::from_secs(10);
    const TEST_CANCELLATION_GRACE: Duration = Duration::from_secs(3);
    const TEST_COPY_TIMEOUT: Duration = Duration::from_secs(1);
    const TEST_LEASE_DURATION: Duration = Duration::from_secs(15);
    const INVALID_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(8);
    const INVALID_CANCELLATION_GRACE: Duration = Duration::from_secs(9);

    fn valid_config() -> SupervisorConfig {
        SupervisorConfig::new(TEST_OPERATION_TIMEOUT)
            .with_heartbeat_interval(TEST_HEARTBEAT_INTERVAL)
            .with_heartbeat_timeout(TEST_HEARTBEAT_TIMEOUT)
            .with_progress_timeout(TEST_PROGRESS_TIMEOUT)
            .with_cancellation_grace(TEST_CANCELLATION_GRACE)
            .with_copy_timeout(TEST_COPY_TIMEOUT)
    }

    #[test]
    fn deadline_relations_are_validated_before_lease_acquisition() {
        assert!(valid_config().validate_for(TEST_LEASE_DURATION).is_ok());
        assert_eq!(
            valid_config()
                .with_heartbeat_timeout(INVALID_HEARTBEAT_TIMEOUT)
                .validate_for(TEST_LEASE_DURATION),
            Err(invalid("heartbeat_timeout"))
        );
        assert_eq!(
            valid_config().validate_for(TEST_HEARTBEAT_INTERVAL),
            Err(invalid("heartbeat_interval"))
        );
        assert_eq!(
            valid_config()
                .with_progress_timeout(TEST_OPERATION_TIMEOUT)
                .validate_for(TEST_LEASE_DURATION),
            Err(invalid("progress_timeout"))
        );
        assert_eq!(
            valid_config()
                .with_cancellation_grace(Duration::ZERO)
                .validate_for(TEST_LEASE_DURATION),
            Err(invalid("cancellation_grace"))
        );
        assert_eq!(
            valid_config()
                .with_copy_timeout(Duration::ZERO)
                .validate_for(TEST_LEASE_DURATION),
            Err(invalid("copy_timeout"))
        );
        assert_eq!(
            valid_config()
                .with_cancellation_grace(INVALID_CANCELLATION_GRACE)
                .validate_for(TEST_LEASE_DURATION),
            Err(invalid("cancellation_grace"))
        );
        assert_eq!(
            valid_config()
                .with_max_worker_tasks(0)
                .validate_for(TEST_LEASE_DURATION),
            Err(invalid("max_worker_tasks"))
        );
        assert_eq!(
            valid_config()
                .with_max_worker_tasks(MAX_WORKER_TASKS + 1)
                .validate_for(TEST_LEASE_DURATION),
            Err(invalid("max_worker_tasks"))
        );
        assert_eq!(
            valid_config()
                .with_max_worker_bytes(0)
                .validate_for(TEST_LEASE_DURATION),
            Err(invalid("max_worker_bytes"))
        );
        assert_eq!(
            valid_config()
                .with_max_worker_bytes(MAX_WORKER_BYTES + 1)
                .validate_for(TEST_LEASE_DURATION),
            Err(invalid("max_worker_bytes"))
        );
    }
}
