mod credentials;
mod docker;
mod maintenance;

use std::{path::Path, time::Duration};

use cartograph_config::{DatabaseSchema, DatabaseSettings};
use credentials::{CredentialStore, DatabaseCredentials};
use docker::{
    ContainerCreateSpec, ContainerInspection, DockerCli, has_expected_data_mount,
    initialize_extensions, verify_volume,
};
use secrecy::ExposeSecret;
use serde::Serialize;
use thiserror::Error;
use tokio::time::{sleep, timeout};

use crate::{CapabilityReport, CartographDatabase, MigrationReport, connect, probe_capabilities};

/// Exact upstream multi-architecture image accepted by Cartograph v2.
pub const MANAGED_DATABASE_IMAGE: &str = concat!(
    "paradedb/paradedb:0.25.0@sha256:",
    "6e35d14c72f1eef9be6c8d9ac40185f877f8e119f691ece20906793d765fb8f7"
);
/// Default loopback port for the first managed Cartograph database.
pub const DEFAULT_MANAGED_DATABASE_PORT: u16 = 55_432;
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const DEFAULT_MAINTENANCE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Owned Cartograph PostgreSQL lifecycle manager.
pub struct ManagedDatabase {
    identity: ManagedResourceIdentity,
    credentials: CredentialStore,
    docker: DockerCli,
    schema: DatabaseSchema,
    port: u16,
    timeouts: ManagedDatabaseTimeouts,
}

struct ManagedDatabaseTimeouts {
    startup: Duration,
    maintenance: Duration,
}

/// Focused lifecycle operations for an owned Cartograph PostgreSQL container.
pub struct ManagedDatabaseLifecycle<'a> {
    database: &'a ManagedDatabase,
}

/// Focused archive operations for an owned Cartograph PostgreSQL database.
pub struct ManagedDatabaseArchives<'a> {
    database: &'a ManagedDatabase,
}

/// Focused administrative operations for an owned Cartograph PostgreSQL database.
pub struct ManagedDatabaseMaintenance<'a> {
    database: &'a ManagedDatabase,
}

struct ManagedResourceIdentity {
    project_hash: String,
    container_name: String,
    volume_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartTransition {
    None,
    Stop,
    Pause,
}

struct PreparedStart {
    credentials: DatabaseCredentials,
    credentials_created: bool,
    container_created: bool,
    transition: StartTransition,
}

struct ManagedInitialization {
    capabilities: CapabilityReport,
    migrations: MigrationReport,
}

/// Stable state surfaced by `cartograph-v2 db status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManagedContainerState {
    /// No managed container exists for this project.
    Missing,
    /// Docker created the container but has not started it.
    Created,
    /// PostgreSQL is running but its health check has not passed.
    Starting,
    /// PostgreSQL reports healthy.
    Healthy,
    /// Docker exhausted the PostgreSQL health retries.
    Unhealthy,
    /// Docker has paused every process in the container.
    Paused,
    /// Docker's restart policy is retrying the container process.
    Restarting,
    /// The managed container exists but is not running.
    Stopped,
    /// Docker reported a state that does not map to a normal lifecycle state.
    Unknown,
}

/// Read-only managed database status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ManagedDatabaseStatus {
    /// Docker-safe name derived from the canonical project root.
    pub container_name: String,
    /// Current lifecycle state.
    pub state: ManagedContainerState,
    /// Loopback host port assigned to PostgreSQL.
    pub port: u16,
    /// Whether the running/stopped container uses the supported image digest.
    pub image_matches: bool,
}

/// Result of a successful idempotent managed start.
#[derive(Clone, Debug, Serialize)]
pub struct ManagedStartReport {
    /// True when this invocation generated a new private credential file.
    pub credentials_created: bool,
    /// True when this invocation created the Docker container.
    pub container_created: bool,
    /// Live Postgres/ParadeDB/pgvector readiness evidence.
    pub capabilities: CapabilityReport,
    /// Append-only schema versions applied by this start invocation.
    pub migrations: MigrationReport,
    /// Validated PostgreSQL schema migrated by this start invocation.
    pub schema: String,
}

/// Destructive managed operations that require an explicit, project-bound capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManagedDestructiveOperation {
    /// Replace the live database contents from a verified custom-format archive.
    Restore,
    /// Permanently remove the owned container, volume, and credential file.
    Remove,
    /// Replace an owned container with the exact supported image digest.
    Upgrade,
    /// Repair required generation-local ParadeDB BM25 relations.
    RebuildDerivedIndexes,
}

impl ManagedDestructiveOperation {
    /// Exact acknowledgement text required to mint this operation's capability.
    #[must_use]
    pub const fn confirmation_phrase(self) -> &'static str {
        match self {
            Self::Restore => "restore-managed-database",
            Self::Remove => "remove-managed-database",
            Self::Upgrade => "upgrade-managed-database",
            Self::RebuildDerivedIndexes => "rebuild-managed-derived-indexes",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Restore => "restore",
            Self::Remove => "remove",
            Self::Upgrade => "upgrade",
            Self::RebuildDerivedIndexes => "rebuild-derived-indexes",
        }
    }
}

/// Single-use proof that a caller explicitly acknowledged one destructive operation.
///
/// The capability is bound to the canonical project's private resource identity and
/// cannot authorize another [`ManagedDatabase`] or another operation.
pub struct ManagedDestructiveConfirmation {
    project_hash: String,
    operation: ManagedDestructiveOperation,
}

/// Verified custom-format PostgreSQL backup metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ManagedBackupReport {
    /// Exact bytes atomically persisted at the caller-selected destination.
    pub bytes: u64,
}

/// Result of a verified restore followed by capability and migration proof.
#[derive(Clone, Debug, Serialize)]
pub struct ManagedRestoreReport {
    /// Live Postgres/ParadeDB/pgvector readiness evidence after restoration.
    pub capabilities: CapabilityReport,
    /// Append-only migrations applied after the restored archive was loaded.
    pub migrations: MigrationReport,
    /// Validated PostgreSQL schema restored and migrated.
    pub schema: String,
}

/// Result of explicitly removing project-owned managed database state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ManagedRemoveReport {
    /// Whether an owned container existed and was removed.
    pub container_removed: bool,
    /// Whether an owned named volume existed and was removed.
    pub volume_removed: bool,
    /// Whether the private project credential file existed and was removed.
    pub credentials_removed: bool,
}

/// Result of an idempotent pinned-image upgrade.
#[derive(Clone, Debug, Serialize)]
pub struct ManagedUpgradeReport {
    /// Whether this invocation replaced an older owned container image.
    pub upgraded: bool,
    /// Live Postgres/ParadeDB/pgvector readiness evidence after upgrade.
    pub capabilities: CapabilityReport,
    /// Append-only migrations applied after the upgraded container started.
    pub migrations: MigrationReport,
    /// Validated PostgreSQL schema used by the upgraded container.
    pub schema: String,
}

/// Aggregate catalog health for required generation-local ParadeDB BM25 relations.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ManagedDerivedIndexHealth {
    /// Whether the generation-relation catalog exists.
    pub present: bool,
    /// Whether every required generation relation has a valid index.
    pub valid: bool,
    /// Whether every required generation relation has an index ready for use.
    pub ready: bool,
    /// The catalog reports ParadeDB's BM25-capable access method.
    pub bm25_access_method: bool,
}

impl ManagedDerivedIndexHealth {
    /// Whether all catalog invariants required for BM25 queries hold.
    #[must_use]
    pub const fn healthy(self) -> bool {
        self.present && self.valid && self.ready && self.bm25_access_method
    }
}

impl ManagedDatabase {
    /// Build a lifecycle manager for one existing project root and loopback port.
    pub fn new(project_root: impl AsRef<Path>, port: u16) -> Result<Self, ManagedDatabaseError> {
        let schema =
            DatabaseSchema::from_env().map_err(|_| ManagedDatabaseError::DatabaseSchema)?;
        managed_database_with_schema(project_root, port, schema)
    }

    /// Override the bounded startup wait, primarily for integration tests and
    /// slow first image starts.
    #[must_use]
    pub fn with_startup_timeout(mut self, startup_timeout: Duration) -> Self {
        self.timeouts.startup = startup_timeout;
        self
    }

    /// Override the bounded post-restore and derived-index query wait.
    #[must_use]
    pub fn with_maintenance_timeout(mut self, maintenance_timeout: Duration) -> Self {
        self.timeouts.maintenance = maintenance_timeout;
        self
    }

    /// Load secret-safe connection settings for this project's existing managed database.
    ///
    /// This never creates credentials or starts Docker; callers use
    /// [`Self::lifecycle`] first.
    pub fn connection_settings(&self) -> Result<DatabaseSettings, ManagedDatabaseError> {
        let credentials = self.credentials.load()?;
        let url = credentials.database_url(self.port)?;
        DatabaseSettings::parse(url.expose_secret(), Some("8"), Some("10000"))
            .and_then(|settings| settings.with_schema(self.schema.as_str()))
            .map_err(|_| ManagedDatabaseError::CredentialFormat)
    }

    /// Mint a single-use destructive capability only for the exact acknowledgement.
    pub fn confirm_destructive_operation(
        &self,
        operation: ManagedDestructiveOperation,
        acknowledgement: &str,
    ) -> Result<ManagedDestructiveConfirmation, ManagedDatabaseError> {
        if acknowledgement != operation.confirmation_phrase() {
            return Err(ManagedDatabaseError::DestructiveConfirmationRequired {
                operation: operation.label(),
            });
        }
        Ok(ManagedDestructiveConfirmation {
            project_hash: self.identity.project_hash.clone(),
            operation,
        })
    }

    /// Borrow the container lifecycle surface.
    #[must_use]
    pub const fn lifecycle(&self) -> ManagedDatabaseLifecycle<'_> {
        ManagedDatabaseLifecycle { database: self }
    }

    /// Borrow the backup and restore surface.
    #[must_use]
    pub const fn archives(&self) -> ManagedDatabaseArchives<'_> {
        ManagedDatabaseArchives { database: self }
    }

    /// Borrow the destructive and derived-index maintenance surface.
    #[must_use]
    pub const fn maintenance(&self) -> ManagedDatabaseMaintenance<'_> {
        ManagedDatabaseMaintenance { database: self }
    }
}

fn validate_destructive_confirmation(
    database: &ManagedDatabase,
    confirmation: &ManagedDestructiveConfirmation,
    expected: ManagedDestructiveOperation,
) -> Result<(), ManagedDatabaseError> {
    if confirmation.operation != expected
        || confirmation.project_hash != database.identity.project_hash
    {
        Err(ManagedDatabaseError::DestructiveConfirmationMismatch)
    } else {
        Ok(())
    }
}

impl ManagedDatabaseLifecycle<'_> {
    /// Start or reuse the owned database, initialize extensions, and prove all
    /// v2 capabilities live.
    pub async fn start(&self) -> Result<ManagedStartReport, ManagedDatabaseError> {
        self.database.docker.ensure_available().await?;
        let _lifecycle_lock = self.database.credentials.acquire_lifecycle_lock()?;
        let existing = self
            .database
            .docker
            .containers()
            .inspect_container(&self.database.identity.container_name)
            .await?;
        let prepared = match existing {
            Some(inspection) => self.prepare_existing_start(inspection).await?,
            None => self.prepare_new_start().await?,
        };

        let initialized = match self
            .finish_start(
                &prepared.credentials,
                prepared.transition == StartTransition::Pause,
            )
            .await
        {
            Ok(initialized) => initialized,
            Err(error) => {
                self.rollback_or_fail(prepared.transition).await?;
                return Err(error);
            }
        };

        Ok(ManagedStartReport {
            credentials_created: prepared.credentials_created,
            container_created: prepared.container_created,
            capabilities: initialized.capabilities,
            migrations: initialized.migrations,
            schema: self.database.schema.as_str().to_owned(),
        })
    }

    async fn prepare_existing_start(
        &self,
        inspection: ContainerInspection,
    ) -> Result<PreparedStart, ManagedDatabaseError> {
        validate_owned_container(&self.database.identity, &inspection, true)?;
        verify_volume(&self.database.docker.volumes(), &self.database.identity).await?;
        validate_configured_port(self.database.port, &inspection)?;
        let credentials = match self.database.credentials.load() {
            Err(ManagedDatabaseError::CredentialRead)
                if !self.database.credentials.path().exists() =>
            {
                return Err(ManagedDatabaseError::CredentialsMissingForContainer);
            }
            result => result?,
        };
        let transition = self
            .transition_existing_container(container_state(&inspection))
            .await?;
        Ok(PreparedStart {
            credentials,
            credentials_created: false,
            container_created: false,
            transition,
        })
    }

    async fn transition_existing_container(
        &self,
        state: ManagedContainerState,
    ) -> Result<StartTransition, ManagedDatabaseError> {
        match state {
            ManagedContainerState::Created | ManagedContainerState::Stopped => {
                ensure_loopback_port_available(self.database.port)?;
                if let Err(error) = self
                    .database
                    .docker
                    .containers()
                    .install_password_file(
                        &self.database.identity.container_name,
                        self.database.credentials.path(),
                    )
                    .await
                {
                    self.rollback_or_fail(StartTransition::Stop).await?;
                    return Err(error);
                }
                if let Err(error) = self
                    .database
                    .docker
                    .containers()
                    .start_container(&self.database.identity.container_name, self.database.port)
                    .await
                {
                    self.rollback_or_fail(StartTransition::Stop).await?;
                    return Err(error);
                }
                Ok(StartTransition::Stop)
            }
            ManagedContainerState::Paused => {
                if let Err(error) = self
                    .database
                    .docker
                    .containers()
                    .unpause_container(&self.database.identity.container_name)
                    .await
                {
                    self.rollback_or_fail(StartTransition::Pause).await?;
                    return Err(error);
                }
                Ok(StartTransition::Pause)
            }
            ManagedContainerState::Starting
            | ManagedContainerState::Healthy
            | ManagedContainerState::Unhealthy
            | ManagedContainerState::Restarting => Ok(StartTransition::None),
            ManagedContainerState::Missing | ManagedContainerState::Unknown => {
                Err(ManagedDatabaseError::UnsupportedContainerState)
            }
        }
    }

    async fn prepare_new_start(&self) -> Result<PreparedStart, ManagedDatabaseError> {
        ensure_loopback_port_available(self.database.port)?;
        self.database
            .docker
            .ensure_image(MANAGED_DATABASE_IMAGE)
            .await?;
        let volume_created = self
            .database
            .docker
            .volumes()
            .ensure_volume(&self.database.identity)
            .await?;
        if !volume_created && !self.database.credentials.path().exists() {
            return Err(ManagedDatabaseError::CredentialsMissingForVolume);
        }
        let loaded = self.database.credentials.load_or_create()?;
        if let Err(error) = self
            .database
            .docker
            .containers()
            .create_container(&ContainerCreateSpec {
                identity: &self.database.identity,
                port: self.database.port,
                image: MANAGED_DATABASE_IMAGE,
            })
            .await
        {
            self.cleanup_failed_create_or_fail().await?;
            return Err(error);
        }
        if let Err(error) = self
            .database
            .docker
            .containers()
            .install_password_file(
                &self.database.identity.container_name,
                self.database.credentials.path(),
            )
            .await
        {
            self.cleanup_failed_create_or_fail().await?;
            return Err(error);
        }
        if let Err(error) = self
            .database
            .docker
            .containers()
            .start_container(&self.database.identity.container_name, self.database.port)
            .await
        {
            self.cleanup_failed_create_or_fail().await?;
            return Err(error);
        }
        Ok(PreparedStart {
            credentials: loaded.credentials,
            credentials_created: loaded.created,
            container_created: true,
            transition: StartTransition::Stop,
        })
    }

    /// Return state without creating credentials, volumes, or containers.
    pub async fn status(&self) -> Result<ManagedDatabaseStatus, ManagedDatabaseError> {
        self.database.docker.ensure_available().await?;
        let Some(inspection) = self
            .database
            .docker
            .containers()
            .inspect_container(&self.database.identity.container_name)
            .await?
        else {
            return Ok(ManagedDatabaseStatus {
                container_name: self.database.identity.container_name.clone(),
                state: ManagedContainerState::Missing,
                port: self.database.port,
                image_matches: false,
            });
        };
        validate_owned_container(&self.database.identity, &inspection, false)?;
        verify_volume(&self.database.docker.volumes(), &self.database.identity).await?;
        let port = validate_published_port(&inspection)?;
        Ok(ManagedDatabaseStatus {
            container_name: self.database.identity.container_name.clone(),
            state: container_state(&inspection),
            port,
            image_matches: inspection.image == MANAGED_DATABASE_IMAGE,
        })
    }

    /// Return exact filesystem bytes available to the validated project-owned
    /// database mount. External PostgreSQL deployments must supply equivalent
    /// operator-observed headroom themselves.
    pub async fn available_storage_bytes(&self) -> Result<u64, ManagedDatabaseError> {
        self.database.docker.ensure_available().await?;
        let inspection = self
            .database
            .docker
            .containers()
            .inspect_container(&self.database.identity.container_name)
            .await?
            .ok_or(ManagedDatabaseError::ManagedContainerMissing)?;
        validate_owned_container(&self.database.identity, &inspection, false)?;
        verify_volume(&self.database.docker.volumes(), &self.database.identity).await?;
        if container_state(&inspection) != ManagedContainerState::Healthy {
            return Err(ManagedDatabaseError::DatabaseNotHealthyForMaintenance);
        }
        self.database
            .docker
            .containers()
            .available_data_bytes(&self.database.identity.container_name)
            .await
    }

    /// Stop only the project-owned container. Missing/stopped is an idempotent
    /// success; a foreign name collision is refused.
    pub async fn stop(&self) -> Result<bool, ManagedDatabaseError> {
        self.database.docker.ensure_available().await?;
        let _lifecycle_lock = self.database.credentials.acquire_lifecycle_lock()?;
        let Some(inspection) = self
            .database
            .docker
            .containers()
            .inspect_container(&self.database.identity.container_name)
            .await?
        else {
            return Ok(false);
        };
        validate_owned_container(&self.database.identity, &inspection, false)?;
        match inspection.process_state.as_str() {
            "running" | "restarting" => {
                self.database
                    .docker
                    .containers()
                    .stop_container(&self.database.identity.container_name)
                    .await?;
                Ok(true)
            }
            "paused" => {
                self.database
                    .docker
                    .containers()
                    .unpause_container(&self.database.identity.container_name)
                    .await?;
                if let Err(error) = self
                    .database
                    .docker
                    .containers()
                    .stop_container(&self.database.identity.container_name)
                    .await
                {
                    if self
                        .database
                        .docker
                        .containers()
                        .pause_container(&self.database.identity.container_name)
                        .await
                        .is_err()
                    {
                        return Err(ManagedDatabaseError::StopRollbackFailed);
                    }
                    return Err(error);
                }
                Ok(true)
            }
            "created" | "exited" | "dead" => Ok(false),
            _ => Err(ManagedDatabaseError::UnsupportedContainerState),
        }
    }

    /// Read a bounded tail from only the project-owned container.
    pub async fn logs(&self, tail: u16) -> Result<String, ManagedDatabaseError> {
        self.database.docker.ensure_available().await?;
        let inspection = self
            .database
            .docker
            .containers()
            .inspect_container(&self.database.identity.container_name)
            .await?
            .ok_or(ManagedDatabaseError::ManagedContainerMissing)?;
        validate_owned_container(&self.database.identity, &inspection, false)?;
        self.database
            .docker
            .containers()
            .logs(&self.database.identity.container_name, tail)
            .await
    }

    async fn cleanup_failed_create_or_fail(&self) -> Result<(), ManagedDatabaseError> {
        let cleanup = async {
            let Some(inspection) = self
                .database
                .docker
                .containers()
                .inspect_container(&self.database.identity.container_name)
                .await?
            else {
                return Ok(());
            };
            if validate_owned_container(&self.database.identity, &inspection, true).is_err() {
                return Ok(());
            }
            self.rollback_transition(StartTransition::Stop).await
        }
        .await;
        cleanup.map_err(|_| ManagedDatabaseError::StartupRollbackFailed)
    }

    async fn rollback_or_fail(
        &self,
        transition: StartTransition,
    ) -> Result<(), ManagedDatabaseError> {
        self.rollback_transition(transition)
            .await
            .map_err(|_| ManagedDatabaseError::StartupRollbackFailed)
    }

    async fn rollback_transition(
        &self,
        transition: StartTransition,
    ) -> Result<(), ManagedDatabaseError> {
        if transition == StartTransition::None {
            return Ok(());
        }
        let inspection = self
            .database
            .docker
            .containers()
            .inspect_container(&self.database.identity.container_name)
            .await?;
        let Some(inspection) = inspection else {
            return if transition == StartTransition::Stop {
                Ok(())
            } else {
                Err(ManagedDatabaseError::ManagedContainerMissing)
            };
        };
        validate_owned_container(&self.database.identity, &inspection, true)?;
        match (transition, inspection.process_state.as_str()) {
            (StartTransition::Stop, "running" | "restarting") => {
                self.database
                    .docker
                    .containers()
                    .rollback_container(&self.database.identity.container_name)
                    .await
            }
            (StartTransition::Stop, "paused") => {
                self.database
                    .docker
                    .containers()
                    .unpause_container(&self.database.identity.container_name)
                    .await?;
                self.database
                    .docker
                    .containers()
                    .rollback_container(&self.database.identity.container_name)
                    .await
            }
            (StartTransition::Stop, "created" | "exited" | "dead")
            | (StartTransition::Pause, "paused") => Ok(()),
            (StartTransition::Pause, "running") => {
                self.database
                    .docker
                    .containers()
                    .pause_container(&self.database.identity.container_name)
                    .await
            }
            (StartTransition::None, _) => Ok(()),
            (StartTransition::Pause, _) | (StartTransition::Stop, _) => {
                Err(ManagedDatabaseError::UnsupportedContainerState)
            }
        }
    }

    async fn wait_until_healthy(
        &self,
        allow_unhealthy_recovery: bool,
    ) -> Result<(), ManagedDatabaseError> {
        loop {
            let inspection = self
                .database
                .docker
                .containers()
                .inspect_container(&self.database.identity.container_name)
                .await?
                .ok_or(ManagedDatabaseError::ManagedContainerMissing)?;
            validate_owned_container(&self.database.identity, &inspection, true)?;
            match container_state(&inspection) {
                ManagedContainerState::Healthy => return Ok(()),
                ManagedContainerState::Unhealthy if !allow_unhealthy_recovery => {
                    return Err(ManagedDatabaseError::DatabaseUnhealthy);
                }
                ManagedContainerState::Paused
                | ManagedContainerState::Stopped
                | ManagedContainerState::Unknown => {
                    return Err(ManagedDatabaseError::DatabaseStoppedDuringStart);
                }
                ManagedContainerState::Missing
                | ManagedContainerState::Created
                | ManagedContainerState::Starting
                | ManagedContainerState::Unhealthy
                | ManagedContainerState::Restarting => sleep(HEALTH_POLL_INTERVAL).await,
            }
        }
    }

    async fn finish_start(
        &self,
        credentials: &DatabaseCredentials,
        allow_unhealthy_recovery: bool,
    ) -> Result<ManagedInitialization, ManagedDatabaseError> {
        timeout(self.database.timeouts.startup, async {
            self.wait_until_healthy(allow_unhealthy_recovery).await?;
            self.database
                .docker
                .containers()
                .verify_loopback_port(&self.database.identity.container_name, self.database.port)
                .await?;
            initialize_extensions(
                &self.database.docker,
                &self.database.identity.container_name,
            )
            .await?;
            initialize_managed_database(credentials, self.database.port, &self.database.schema)
                .await
        })
        .await
        .map_err(|_| ManagedDatabaseError::DatabaseStartupTimeout)?
    }
}

fn managed_database_with_schema(
    project_root: impl AsRef<Path>,
    port: u16,
    schema: DatabaseSchema,
) -> Result<ManagedDatabase, ManagedDatabaseError> {
    if port == 0 {
        return Err(ManagedDatabaseError::InvalidPort);
    }
    let project_root = project_root
        .as_ref()
        .canonicalize()
        .map_err(|_| ManagedDatabaseError::ProjectRoot)?;
    let project_hash = project_hash(&project_root);
    let identity = ManagedResourceIdentity {
        container_name: format!("cartograph-v2-{project_hash}"),
        volume_name: format!("cartograph-v2-{project_hash}-data"),
        project_hash,
    };
    let credentials = CredentialStore::new(project_root.join(".cartograph/v2/postgres.password"));
    Ok(ManagedDatabase {
        identity,
        credentials,
        docker: DockerCli::new(),
        schema,
        port,
        timeouts: ManagedDatabaseTimeouts {
            startup: DEFAULT_STARTUP_TIMEOUT,
            maintenance: DEFAULT_MAINTENANCE_TIMEOUT,
        },
    })
}

fn validate_owned_container(
    identity: &ManagedResourceIdentity,
    inspection: &ContainerInspection,
    require_supported_image: bool,
) -> Result<(), ManagedDatabaseError> {
    if !inspection.managed || inspection.project_hash != identity.project_hash {
        return Err(ManagedDatabaseError::ForeignContainer);
    }
    if !has_expected_data_mount(inspection, identity) {
        return Err(ManagedDatabaseError::InvalidManagedStorageMount);
    }
    if require_supported_image && inspection.image != MANAGED_DATABASE_IMAGE {
        return Err(ManagedDatabaseError::UnsupportedManagedImage);
    }
    Ok(())
}

fn validate_configured_port(
    configured: u16,
    inspection: &ContainerInspection,
) -> Result<(), ManagedDatabaseError> {
    let published = validate_published_port(inspection)?;
    if published != configured {
        return Err(ManagedDatabaseError::ManagedPortMismatch {
            configured,
            published,
        });
    }
    Ok(())
}

fn validate_published_port(inspection: &ContainerInspection) -> Result<u16, ManagedDatabaseError> {
    if inspection.host_ip != "127.0.0.1" {
        return Err(ManagedDatabaseError::UnsafePortPublication);
    }
    inspection
        .host_port
        .parse::<u16>()
        .map_err(|_| ManagedDatabaseError::UnsafePortPublication)
}

async fn initialize_managed_database(
    credentials: &DatabaseCredentials,
    port: u16,
    schema: &DatabaseSchema,
) -> Result<ManagedInitialization, ManagedDatabaseError> {
    let url = credentials.database_url(port)?;
    let settings = DatabaseSettings::parse(url.expose_secret(), Some("4"), Some("10000"))
        .and_then(|settings| settings.with_schema(schema.as_str()))
        .map_err(|_| ManagedDatabaseError::CredentialFormat)?;
    let pool = connect(&settings)
        .await
        .map_err(|_| ManagedDatabaseError::DatabaseConnection)?;
    let report = probe_capabilities(&pool)
        .await
        .map_err(|_| ManagedDatabaseError::DatabaseCapabilityProbe)?;
    if !report.ready {
        pool.close().await;
        return Err(ManagedDatabaseError::CapabilitiesNotReady);
    }
    let database = CartographDatabase::new(pool.clone(), settings.schema().clone());
    let migrations = database.migrate().await;
    pool.close().await;
    Ok(ManagedInitialization {
        capabilities: report,
        migrations: migrations.map_err(|_| ManagedDatabaseError::SchemaMigration)?,
    })
}

/// Safe lifecycle failures. No variant stores a database password or command
/// argument list.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ManagedDatabaseError {
    /// Project root must exist before managed lifecycle starts.
    #[error("managed database project root does not exist")]
    ProjectRoot,
    /// TCP port zero is never valid.
    #[error("managed database port must be between 1 and 65535")]
    InvalidPort,
    /// Credential path could not be represented safely.
    #[error("managed database credential path is invalid")]
    CredentialPath,
    /// Secure randomness failed.
    #[error("could not generate managed database credentials")]
    CredentialRandom,
    /// Private credential creation failed.
    #[error("could not write managed database credentials")]
    CredentialWrite,
    /// Private credential reading failed.
    #[error("could not read managed database credentials")]
    CredentialRead,
    /// The password file was malformed.
    #[error("managed database credential file is malformed")]
    CredentialFormat,
    /// Files with special blocking/device semantics are never accepted.
    #[error("managed database secret state must use regular files")]
    CredentialNotRegular,
    /// Secret state has a deliberately tiny memory/read bound.
    #[error("managed database secret state file is larger than allowed")]
    CredentialTooLarge,
    /// Credential file/state directory may not be symlinked.
    #[error("managed database credential path must not contain a symlinked state entry")]
    CredentialSymlink,
    /// Credential file permissions permit group/other access.
    #[error("managed database credential file must not be accessible by group or other users")]
    CredentialPermissions,
    /// Secret state ancestors must not be replaceable by other users.
    #[error("managed database secret state is writable by group or other users")]
    CredentialStatePermissions,
    /// macOS ACLs can grant access independently from private mode bits.
    #[error("managed database secret state must not have an extended ACL")]
    CredentialExtendedAcl,
    /// The preview cannot yet prove private ACLs on this operating system.
    #[error(
        "managed database credential ACL hardening is not implemented on this operating system"
    )]
    CredentialAclUnsupported,
    /// The configured PostgreSQL schema is not a safe identifier.
    #[error("managed database schema configuration is invalid")]
    DatabaseSchema,
    /// Another process owns the project mutation lease.
    #[error("another managed database lifecycle operation is already running for this project")]
    LifecycleBusy,
    /// A destructive operation needs its exact acknowledgement before effects begin.
    #[error("explicit confirmation is required before managed database {operation}")]
    DestructiveConfirmationRequired {
        /// Stable operation name without caller-controlled data.
        operation: &'static str,
    },
    /// A capability was minted for another project or destructive operation.
    #[error("managed database destructive confirmation does not match this operation")]
    DestructiveConfirmationMismatch,
    /// Existing container without its matching credential file cannot be used.
    #[error("managed database container exists but its credential file is missing")]
    CredentialsMissingForContainer,
    /// An initialized/reused volume cannot be paired with a new random password.
    #[error("managed database volume exists but its credential file is missing")]
    CredentialsMissingForVolume,
    /// Docker executable is absent.
    #[error("Docker is required for the managed Cartograph database")]
    DockerUnavailable,
    /// Remote daemons would receive credentials and publish ports remotely.
    #[error("managed database requires a local Docker endpoint")]
    NonLocalDockerEndpoint,
    /// Every effectful command must use the endpoint proven local once.
    #[error("Docker endpoint was not pinned before a managed operation")]
    DockerEndpointNotPinned,
    /// Docker exceeded the bounded command timeout.
    #[error("Docker command timed out")]
    DockerTimeout,
    /// A cold digest pull gets a separate, longer but still finite deadline.
    #[error("timed out pulling the managed database image")]
    DockerImagePullTimeout,
    /// A named Docker operation failed.
    #[error("Docker failed to {operation}")]
    DockerOperation {
        /// Safe operation label without command arguments.
        operation: &'static str,
    },
    /// Docker returned an incompatible inspect response.
    #[error("Docker returned an invalid managed-resource response")]
    DockerResponse,
    /// Requested loopback host port is already occupied.
    #[error("managed database loopback port {port} is already in use")]
    PortUnavailable {
        /// Occupied host port.
        port: u16,
    },
    /// A same-named container is not owned by this project.
    #[error("refusing to operate on a container not owned by this Cartograph project")]
    ForeignContainer,
    /// A same-named volume is not owned by this project.
    #[error("refusing to use a volume not owned by this Cartograph project")]
    ForeignVolume,
    /// Existing owned container uses another image and needs an explicit upgrade.
    #[error("managed database image differs from the supported digest; run the upgrade workflow")]
    UnsupportedManagedImage,
    /// Owned labels are insufficient without the exact persistent data mount.
    #[error("managed database container does not use the expected owned data volume")]
    InvalidManagedStorageMount,
    /// An existing managed container references a volume Docker cannot find.
    #[error("managed database data volume does not exist")]
    ManagedVolumeMissing,
    /// Docker reported a state that cannot be transitioned safely.
    #[error("managed database container is in an unsupported Docker state")]
    UnsupportedContainerState,
    /// Start failed and Cartograph could not restore the prior safe state.
    #[error("managed database start failed and rollback could not be verified")]
    StartupRollbackFailed,
    /// Stop failed after unpausing and the prior paused state could not be restored.
    #[error("managed database stop failed and the paused state could not be restored")]
    StopRollbackFailed,
    /// No managed container exists for logs/strict operations.
    #[error("managed database container does not exist")]
    ManagedContainerMissing,
    /// Docker published PostgreSQL beyond the expected loopback address.
    #[error("managed database PostgreSQL port is not bound exclusively to loopback")]
    UnsafePortPublication,
    /// Caller supplied a different port than the owned container publishes.
    #[error(
        "managed database publishes loopback port {published}, not requested port {configured}"
    )]
    ManagedPortMismatch {
        /// Requested port.
        configured: u16,
        /// Existing container port.
        published: u16,
    },
    /// Health retries reported unhealthy.
    #[error("managed database became unhealthy during startup")]
    DatabaseUnhealthy,
    /// Container stopped before reaching healthy.
    #[error("managed database stopped before startup completed")]
    DatabaseStoppedDuringStart,
    /// Readiness, extension initialization, or capability proof exceeded the deadline.
    #[error("timed out proving managed database readiness")]
    DatabaseStartupTimeout,
    /// A maintenance query or derived-index rebuild exceeded its bounded deadline.
    #[error("managed database maintenance operation timed out")]
    MaintenanceTimeout,
    /// Backup, restore, or maintenance requires the owned container to be healthy.
    #[error("managed database must be healthy before maintenance")]
    DatabaseNotHealthyForMaintenance,
    /// Rust driver could not connect after Docker health passed.
    #[error("managed database health passed but PostgreSQL connection failed")]
    DatabaseConnection,
    /// Capability query failed.
    #[error("managed database capability probe failed")]
    DatabaseCapabilityProbe,
    /// One or more hard capabilities failed.
    #[error("managed database is missing a required PostgreSQL, ParadeDB, or pgvector capability")]
    CapabilitiesNotReady,
    /// The append-only Cartograph schema migration did not commit.
    #[error("managed database Cartograph schema migration failed")]
    SchemaMigration,
    /// Backup destination exists, is not a regular file target, or cannot be persisted atomically.
    #[error("managed database backup destination is not a new writable regular file")]
    BackupDestination,
    /// The source is not a nonempty custom-format PostgreSQL archive in a regular file.
    #[error("managed database restore archive is invalid")]
    RestoreArchiveInvalid,
    /// PostgreSQL could not create a verified custom-format archive.
    #[error("managed database backup failed")]
    BackupFailed,
    /// PostgreSQL refused the requested archive without committing a partial restore.
    #[error("managed database restore failed")]
    RestoreFailed,
    /// Restored data failed the live capability or migration proof.
    #[error("managed database restore did not pass post-restore verification")]
    RestoreVerificationFailed,
    /// Restore verification failed and the pre-restore archive could not be recovered.
    #[error("managed database restore rollback could not be verified")]
    RestoreRollbackFailed,
    /// Temporary archive material could not be removed from the owned container.
    #[error("managed database temporary archive cleanup failed")]
    ArchiveCleanupFailed,
    /// The old owned container could not be restored after a pinned-image upgrade failed.
    #[error("managed database image upgrade rollback could not be verified")]
    UpgradeRollbackFailed,
    /// Removal could not safely delete the private credential file.
    #[error("managed database credential removal failed")]
    CredentialRemove,
    /// The derived BM25 catalog entry is absent or invalid.
    #[error("managed database derived BM25 index is not healthy")]
    DerivedIndexUnhealthy,
}

fn project_hash(project_root: &Path) -> String {
    let digest = blake3::hash(project_root.as_os_str().as_encoded_bytes());
    let mut encoded = String::with_capacity(16);
    for byte in &digest.as_bytes()[..8] {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn ensure_loopback_port_available(port: u16) -> Result<(), ManagedDatabaseError> {
    std::net::TcpListener::bind(("127.0.0.1", port))
        .map(drop)
        .map_err(|_| ManagedDatabaseError::PortUnavailable { port })
}

fn container_state(inspection: &ContainerInspection) -> ManagedContainerState {
    match (
        inspection.process_state.as_str(),
        inspection.health_state.as_str(),
    ) {
        ("created", _) => ManagedContainerState::Created,
        ("running", "healthy") => ManagedContainerState::Healthy,
        ("running", "starting" | "none") => ManagedContainerState::Starting,
        ("running", "unhealthy") => ManagedContainerState::Unhealthy,
        ("paused", _) => ManagedContainerState::Paused,
        ("restarting", _) => ManagedContainerState::Restarting,
        ("exited" | "dead", _) => ManagedContainerState::Stopped,
        _ => ManagedContainerState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::expected_migration_versions;

    const IDENTITY_TEST_PORT: u16 = 55_432;
    const TEST_DATABASE_PORT: u16 = 55_433;
    const TEST_STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
    const RESTART_POLL_ATTEMPTS: usize = 20;
    const RESTART_POLL_INTERVAL: Duration = Duration::from_millis(50);
    const RESTARTING_FIXTURE_COMMAND: &str = "exit 17";
    const LOG_TAIL_LINES: u16 = 5;
    const TEST_DATABASE_SCHEMA: &str = "cartograph_managed_test";
    #[cfg(unix)]
    const OTHER_ACCESS_MODE_MASK: u32 = 0o077;

    struct DockerCleanup {
        container_name: String,
        volume_name: String,
    }

    impl Drop for DockerCleanup {
        fn drop(&mut self) {
            let _ = std::process::Command::new("docker")
                .args([
                    "container",
                    "rm",
                    "--force",
                    "--volumes",
                    &self.container_name,
                ])
                .output();
            let _ = std::process::Command::new("docker")
                .args(["volume", "rm", "--force", &self.volume_name])
                .output();
        }
    }

    #[test]
    fn project_identity_is_stable_private_and_distinct() {
        let first = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create test directory: {error}"),
        };
        let second = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create test directory: {error}"),
        };
        let first_database = match ManagedDatabase::new(first.path(), IDENTITY_TEST_PORT) {
            Ok(database) => database,
            Err(error) => panic!("could not build manager: {error}"),
        };
        let repeated = match ManagedDatabase::new(first.path(), TEST_DATABASE_PORT) {
            Ok(database) => database,
            Err(error) => panic!("could not build manager: {error}"),
        };
        let second_database = match ManagedDatabase::new(second.path(), IDENTITY_TEST_PORT) {
            Ok(database) => database,
            Err(error) => panic!("could not build manager: {error}"),
        };

        assert_eq!(
            first_database.identity.container_name,
            repeated.identity.container_name
        );
        assert_ne!(
            first_database.identity.container_name,
            second_database.identity.container_name
        );
        assert!(
            !first_database
                .identity
                .container_name
                .contains(&first.path().to_string_lossy().to_string())
        );
        assert!(
            first_database
                .identity
                .container_name
                .starts_with("cartograph-v2-")
        );
    }

    #[test]
    fn container_state_is_explicit_for_health_and_process_transitions() {
        let inspection = |process_state: &str, health_state: &str| ContainerInspection {
            managed: true,
            project_hash: "hash".to_owned(),
            process_state: process_state.to_owned(),
            health_state: health_state.to_owned(),
            image: MANAGED_DATABASE_IMAGE.to_owned(),
            host_ip: "127.0.0.1".to_owned(),
            host_port: "55432".to_owned(),
            data_mount: None,
        };

        assert_eq!(
            container_state(&inspection("running", "healthy")),
            ManagedContainerState::Healthy
        );
        assert_eq!(
            container_state(&inspection("running", "starting")),
            ManagedContainerState::Starting
        );
        assert_eq!(
            container_state(&inspection("running", "unhealthy")),
            ManagedContainerState::Unhealthy
        );
        assert_eq!(
            container_state(&inspection("paused", "healthy")),
            ManagedContainerState::Paused
        );
        assert_eq!(
            container_state(&inspection("restarting", "unhealthy")),
            ManagedContainerState::Restarting
        );
        assert_eq!(
            container_state(&inspection("exited", "none")),
            ManagedContainerState::Stopped
        );
    }

    #[test]
    fn rejects_zero_port_before_any_runtime_effect() {
        let directory = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create test directory: {error}"),
        };

        assert!(matches!(
            ManagedDatabase::new(directory.path(), 0),
            Err(ManagedDatabaseError::InvalidPort)
        ));
    }

    #[test]
    fn connection_settings_are_read_only_when_managed_credentials_do_not_exist() {
        let directory = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create test project: {error}"),
        };
        let database = match ManagedDatabase::new(directory.path(), TEST_DATABASE_PORT) {
            Ok(database) => database,
            Err(error) => panic!("could not build managed database: {error}"),
        };

        assert!(matches!(
            database.connection_settings(),
            Err(ManagedDatabaseError::CredentialRead)
        ));
        assert!(!database.credentials.path().exists());
    }

    #[test]
    fn destructive_confirmations_are_explicit_operation_and_project_capabilities() {
        let first = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("could not create first confirmation root: {error}"));
        let second = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("could not create second confirmation root: {error}"));
        let first_database = ManagedDatabase::new(first.path(), IDENTITY_TEST_PORT)
            .unwrap_or_else(|error| panic!("could not build first confirmation manager: {error}"));
        let second_database = ManagedDatabase::new(second.path(), IDENTITY_TEST_PORT)
            .unwrap_or_else(|error| panic!("could not build second confirmation manager: {error}"));

        assert!(matches!(
            first_database.confirm_destructive_operation(
                ManagedDestructiveOperation::Remove,
                "remove-something-else",
            ),
            Err(ManagedDatabaseError::DestructiveConfirmationRequired {
                operation: "remove"
            })
        ));
        let confirmation = first_database
            .confirm_destructive_operation(
                ManagedDestructiveOperation::Remove,
                ManagedDestructiveOperation::Remove.confirmation_phrase(),
            )
            .unwrap_or_else(|error| panic!("valid removal confirmation failed: {error}"));
        assert!(
            validate_destructive_confirmation(
                &first_database,
                &confirmation,
                ManagedDestructiveOperation::Remove,
            )
            .is_ok()
        );
        assert!(matches!(
            validate_destructive_confirmation(
                &second_database,
                &confirmation,
                ManagedDestructiveOperation::Remove,
            ),
            Err(ManagedDatabaseError::DestructiveConfirmationMismatch)
        ));
        assert!(matches!(
            validate_destructive_confirmation(
                &first_database,
                &confirmation,
                ManagedDestructiveOperation::Restore,
            ),
            Err(ManagedDatabaseError::DestructiveConfirmationMismatch)
        ));
    }

    #[tokio::test]
    #[ignore = "starts a real digest-pinned ParadeDB container"]
    async fn managed_database_lifecycle_is_idempotent_private_and_owned() {
        let directory = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create test directory: {error}"),
        };
        let schema = match DatabaseSchema::parse(TEST_DATABASE_SCHEMA) {
            Ok(schema) => schema,
            Err(error) => panic!("managed test schema is invalid: {error}"),
        };
        let live_port = available_loopback_port();
        let database = match managed_database_with_schema(directory.path(), live_port, schema) {
            Ok(database) => database.with_startup_timeout(TEST_STARTUP_TIMEOUT),
            Err(error) => panic!("could not build manager: {error}"),
        };
        let _cleanup = DockerCleanup {
            container_name: database.identity.container_name.clone(),
            volume_name: database.identity.volume_name.clone(),
        };

        assert_lifecycle_lock_refusal(&database).await;
        assert_foreign_container_refusal(&database).await;
        assert_owned_container_without_data_mount_is_refused(&database).await;
        assert_foreign_volume_refusal(&database).await;
        assert_restarting_container_can_be_stopped(&database).await;
        assert_normal_lifecycle(&database).await;
        assert_readiness_timeout_rolls_back(directory.path(), live_port).await;
        assert_existing_volume_without_password_is_refused(&database).await;
    }

    async fn assert_lifecycle_lock_refusal(database: &ManagedDatabase) {
        let held_lock = match database.credentials.acquire_lifecycle_lock() {
            Ok(lock) => lock,
            Err(error) => panic!("could not hold lifecycle lock fixture: {error}"),
        };
        assert!(matches!(
            database.lifecycle().start().await,
            Err(ManagedDatabaseError::LifecycleBusy)
        ));
        drop(held_lock);
        assert!(!database.credentials.path().exists());
    }

    async fn assert_foreign_container_refusal(database: &ManagedDatabase) {
        let foreign = std::process::Command::new("docker")
            .args([
                "container",
                "create",
                "--name",
                &database.identity.container_name,
                MANAGED_DATABASE_IMAGE,
                "postgres",
                "--version",
            ])
            .output();
        let foreign = match foreign {
            Ok(output) => output,
            Err(error) => panic!("could not create foreign collision fixture: {error}"),
        };
        assert!(foreign.status.success());
        let foreign_status = database.lifecycle().status().await;
        assert!(
            matches!(foreign_status, Err(ManagedDatabaseError::ForeignContainer)),
            "unexpected foreign-container result: {foreign_status:?}"
        );
        assert!(!database.credentials.path().exists());
        let removed = std::process::Command::new("docker")
            .args([
                "container",
                "rm",
                "--force",
                "--volumes",
                &database.identity.container_name,
            ])
            .output();
        assert!(matches!(removed, Ok(output) if output.status.success()));
    }

    async fn assert_foreign_volume_refusal(database: &ManagedDatabase) {
        let foreign_volume = std::process::Command::new("docker")
            .args(["volume", "create", &database.identity.volume_name])
            .output();
        let foreign_volume = match foreign_volume {
            Ok(output) => output,
            Err(error) => panic!("could not create foreign volume fixture: {error}"),
        };
        assert!(foreign_volume.status.success());
        let foreign_volume_start = database.lifecycle().start().await;
        assert!(
            matches!(
                foreign_volume_start,
                Err(ManagedDatabaseError::ForeignVolume)
            ),
            "unexpected foreign-volume result: {foreign_volume_start:?}"
        );
        assert!(!database.credentials.path().exists());
        let removed_volume = std::process::Command::new("docker")
            .args(["volume", "rm", "--force", &database.identity.volume_name])
            .output();
        assert!(matches!(removed_volume, Ok(output) if output.status.success()));
    }

    async fn assert_owned_container_without_data_mount_is_refused(database: &ManagedDatabase) {
        let malformed = std::process::Command::new("docker")
            .args([
                "container",
                "create",
                "--name",
                &database.identity.container_name,
                "--label",
                "io.cartograph.managed=true",
                "--label",
                &format!("io.cartograph.project={}", database.identity.project_hash),
                MANAGED_DATABASE_IMAGE,
                "postgres",
                "--version",
            ])
            .output();
        let malformed = match malformed {
            Ok(output) => output,
            Err(error) => panic!("could not create missing-mount fixture: {error}"),
        };
        assert!(malformed.status.success());
        assert!(matches!(
            database.lifecycle().status().await,
            Err(ManagedDatabaseError::InvalidManagedStorageMount)
        ));
        assert!(!database.credentials.path().exists());
        let removed = std::process::Command::new("docker")
            .args([
                "container",
                "rm",
                "--force",
                "--volumes",
                &database.identity.container_name,
            ])
            .output();
        assert!(matches!(removed, Ok(output) if output.status.success()));
    }

    async fn assert_restarting_container_can_be_stopped(database: &ManagedDatabase) {
        let volume = std::process::Command::new("docker")
            .args([
                "volume",
                "create",
                "--label",
                "io.cartograph.managed=true",
                "--label",
                &format!("io.cartograph.project={}", database.identity.project_hash),
                &database.identity.volume_name,
            ])
            .output();
        assert!(matches!(volume, Ok(output) if output.status.success()));
        let restarting = std::process::Command::new("docker")
            .args([
                "run",
                "--detach",
                "--name",
                &database.identity.container_name,
                "--label",
                "io.cartograph.managed=true",
                "--label",
                &format!("io.cartograph.project={}", database.identity.project_hash),
                "--restart",
                "always",
                "--mount",
                &format!(
                    "type=volume,source={},target=/var/lib/postgresql/",
                    database.identity.volume_name
                ),
                MANAGED_DATABASE_IMAGE,
                "sh",
                "-c",
                RESTARTING_FIXTURE_COMMAND,
            ])
            .output();
        let restarting = match restarting {
            Ok(output) => output,
            Err(error) => panic!("could not create restarting fixture: {error}"),
        };
        assert!(restarting.status.success());
        let mut observed_restarting = false;
        for _ in 0..RESTART_POLL_ATTEMPTS {
            let state = std::process::Command::new("docker")
                .args([
                    "container",
                    "inspect",
                    "--format",
                    "{{.State.Status}}",
                    &database.identity.container_name,
                ])
                .output();
            if matches!(state, Ok(output) if String::from_utf8_lossy(&output.stdout).trim() == "restarting")
            {
                observed_restarting = true;
                break;
            }
            std::thread::sleep(RESTART_POLL_INTERVAL);
        }
        assert!(observed_restarting);
        assert!(matches!(database.lifecycle().stop().await, Ok(true)));
        let removed_restarting = std::process::Command::new("docker")
            .args([
                "container",
                "rm",
                "--force",
                "--volumes",
                &database.identity.container_name,
            ])
            .output();
        assert!(matches!(removed_restarting, Ok(output) if output.status.success()));
        let removed_volume = std::process::Command::new("docker")
            .args(["volume", "rm", "--force", &database.identity.volume_name])
            .output();
        assert!(matches!(removed_volume, Ok(output) if output.status.success()));
    }

    async fn assert_normal_lifecycle(database: &ManagedDatabase) {
        assert_first_start_and_idempotent_reuse(database).await;
        assert_pause_logs_and_stop(database).await;
    }

    async fn assert_first_start_and_idempotent_reuse(database: &ManagedDatabase) {
        let first = match database.lifecycle().start().await {
            Ok(report) => report,
            Err(error) => panic!("first managed start failed: {error}"),
        };
        assert!(first.credentials_created);
        assert!(first.container_created);
        assert!(first.capabilities.ready);
        assert_eq!(
            first.migrations.applied_versions,
            expected_migration_versions()
        );
        assert_eq!(first.schema, TEST_DATABASE_SCHEMA);

        let status = match database.lifecycle().status().await {
            Ok(status) => status,
            Err(error) => panic!("managed status failed: {error}"),
        };
        assert_eq!(status.state, ManagedContainerState::Healthy);
        assert_eq!(status.port, database.port);
        assert!(status.image_matches);
        assert_container_metadata_uses_password_file(database);

        let available_storage = match database.lifecycle().available_storage_bytes().await {
            Ok(bytes) => bytes,
            Err(error) => panic!("managed storage headroom inspection failed: {error}"),
        };
        assert!(available_storage > 0);

        let second = match database.lifecycle().start().await {
            Ok(report) => report,
            Err(error) => panic!("second managed start failed: {error}"),
        };
        assert!(!second.credentials_created);
        assert!(!second.container_created);
        assert!(second.capabilities.ready);
        assert!(second.migrations.applied_versions.is_empty());
        assert_eq!(second.schema, TEST_DATABASE_SCHEMA);
    }

    async fn assert_pause_logs_and_stop(database: &ManagedDatabase) {
        let paused = std::process::Command::new("docker")
            .args(["container", "pause", &database.identity.container_name])
            .output();
        assert!(matches!(paused, Ok(output) if output.status.success()));
        let paused_status = match database.lifecycle().status().await {
            Ok(status) => status,
            Err(error) => panic!("paused status failed: {error}"),
        };
        assert_eq!(paused_status.state, ManagedContainerState::Paused);
        let resumed = match database.lifecycle().start().await {
            Ok(report) => report,
            Err(error) => panic!("paused managed start failed: {error}"),
        };
        assert!(resumed.capabilities.ready);
        assert!(resumed.migrations.applied_versions.is_empty());

        let paused = std::process::Command::new("docker")
            .args(["container", "pause", &database.identity.container_name])
            .output();
        assert!(matches!(paused, Ok(output) if output.status.success()));

        let logs = match database.lifecycle().logs(LOG_TAIL_LINES).await {
            Ok(logs) => logs,
            Err(error) => panic!("managed logs failed: {error}"),
        };
        assert!(!logs.trim().is_empty());
        assert!(!logs.contains("POSTGRES_PASSWORD"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = match std::fs::metadata(database.credentials.path()) {
                Ok(metadata) => metadata.permissions().mode(),
                Err(error) => panic!("could not stat managed credentials: {error}"),
            };
            assert_eq!(mode & OTHER_ACCESS_MODE_MASK, 0);
        }

        let stopped = match database.lifecycle().stop().await {
            Ok(stopped) => stopped,
            Err(error) => panic!("managed stop failed: {error}"),
        };
        assert!(stopped);
        let stopped_status = match database.lifecycle().status().await {
            Ok(status) => status,
            Err(error) => panic!("stopped status failed: {error}"),
        };
        assert_eq!(stopped_status.state, ManagedContainerState::Stopped);
        assert!(!match database.lifecycle().stop().await {
            Ok(stopped) => stopped,
            Err(error) => panic!("idempotent stop failed: {error}"),
        });
    }

    async fn assert_readiness_timeout_rolls_back(project_root: &Path, port: u16) {
        let zero_timeout = match ManagedDatabase::new(project_root, port) {
            Ok(database) => database.with_startup_timeout(Duration::ZERO),
            Err(error) => panic!("could not build timeout manager: {error}"),
        };
        assert!(matches!(
            zero_timeout.lifecycle().start().await,
            Err(ManagedDatabaseError::DatabaseStartupTimeout)
        ));
        let rolled_back = match zero_timeout.lifecycle().status().await {
            Ok(status) => status,
            Err(error) => panic!("rollback status failed: {error}"),
        };
        assert_eq!(rolled_back.state, ManagedContainerState::Stopped);
    }

    fn available_loopback_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap_or_else(|error| panic!("could not reserve managed test port: {error}"));
        listener
            .local_addr()
            .unwrap_or_else(|error| panic!("could not inspect managed test port: {error}"))
            .port()
    }

    async fn assert_existing_volume_without_password_is_refused(database: &ManagedDatabase) {
        let removed_container = std::process::Command::new("docker")
            .args([
                "container",
                "rm",
                "--force",
                "--volumes",
                &database.identity.container_name,
            ])
            .output();
        assert!(matches!(removed_container, Ok(output) if output.status.success()));
        wait_for_loopback_port_release(database.port).await;
        if let Err(error) = std::fs::remove_file(database.credentials.path()) {
            panic!("could not remove password fixture: {error}");
        }

        let missing_credentials = database.lifecycle().start().await;
        assert!(
            matches!(
                missing_credentials,
                Err(ManagedDatabaseError::CredentialsMissingForVolume)
            ),
            "unexpected missing-credentials result: {missing_credentials:?}"
        );
        let status = match database.lifecycle().status().await {
            Ok(status) => status,
            Err(error) => panic!("missing-container status failed: {error}"),
        };
        assert_eq!(status.state, ManagedContainerState::Missing);
        assert!(!database.credentials.path().exists());
    }

    async fn wait_for_loopback_port_release(port: u16) {
        for _ in 0..RESTART_POLL_ATTEMPTS * 4 {
            if ensure_loopback_port_available(port).is_ok() {
                return;
            }
            sleep(RESTART_POLL_INTERVAL).await;
        }
        panic!("managed test port {port} remained occupied after container removal");
    }

    fn assert_container_metadata_uses_password_file(database: &ManagedDatabase) {
        let inspection = std::process::Command::new("docker")
            .args([
                "container",
                "inspect",
                "--format",
                "{{json .Config.Env}}",
                &database.identity.container_name,
            ])
            .output();
        let inspection = match inspection {
            Ok(output) if output.status.success() => output,
            Ok(_) => panic!("container environment inspection failed"),
            Err(error) => panic!("could not inspect container environment: {error}"),
        };
        let environment = String::from_utf8_lossy(&inspection.stdout);

        assert!(environment.contains("POSTGRES_PASSWORD_FILE="));
        assert!(!environment.contains("\"POSTGRES_PASSWORD="));
    }

    #[tokio::test]
    #[ignore = "starts Docker to verify occupied-port failure handling"]
    async fn occupied_loopback_port_is_actionable_and_leaves_no_container() {
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(error) => panic!("could not reserve a test port: {error}"),
        };
        let port = match listener.local_addr() {
            Ok(address) => address.port(),
            Err(error) => panic!("could not inspect test port: {error}"),
        };
        let directory = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create test directory: {error}"),
        };
        let database = match ManagedDatabase::new(directory.path(), port) {
            Ok(database) => database,
            Err(error) => panic!("could not build manager: {error}"),
        };
        let _cleanup = DockerCleanup {
            container_name: database.identity.container_name.clone(),
            volume_name: database.identity.volume_name.clone(),
        };

        let occupied_start = database.lifecycle().start().await;
        assert!(
            matches!(
                occupied_start,
                Err(ManagedDatabaseError::PortUnavailable { port: failed_port }) if failed_port == port
            ),
            "unexpected occupied-port result: {occupied_start:?}"
        );
        let status = match database.lifecycle().status().await {
            Ok(status) => status,
            Err(error) => panic!("managed status failed: {error}"),
        };
        assert_eq!(status.state, ManagedContainerState::Missing);
        assert!(!database.credentials.path().exists());
    }
}
