use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use cartograph_config::DatabaseSettings;
use secrecy::ExposeSecret;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use tempfile::NamedTempFile;
use tokio::time::timeout;

use super::{
    ManagedBackupReport, ManagedContainerState, ManagedDatabase, ManagedDatabaseError,
    ManagedDerivedIndexHealth, ManagedDestructiveConfirmation, ManagedDestructiveOperation,
    ManagedInitialization, ManagedRemoveReport, ManagedRestoreReport, ManagedUpgradeReport,
    container_state,
    credentials::DatabaseCredentials,
    docker::{ContainerCreateSpec, ContainerInspection},
    initialize_managed_database, validate_configured_port, validate_owned_container,
};
use crate::{CartographDatabase, connect};

const ARCHIVE_MAGIC: &[u8; 5] = b"PGDMP";
const ARCHIVE_MAGIC_BYTES: u64 = 5;
const BACKUP_CONTAINER_PATH: &str = "/tmp/cartograph-managed-backup.dump";
const RESTORE_CONTAINER_PATH: &str = "/tmp/cartograph-managed-restore.dump";
const ROLLBACK_CONTAINER_PATH: &str = "/tmp/cartograph-managed-rollback.dump";
const UPGRADE_ROLLBACK_SUFFIX: &str = "-upgrade-rollback";
const BM25_INDEX_NAME: &str = "search_documents_bm25_idx";
const BM25_REBUILD_LOCK_NAMESPACE: &str = "cartograph-v2-bm25-rebuild";

#[derive(Clone, Copy)]
enum OriginalContainerState {
    Running,
    Paused,
    Stopped,
}

impl ManagedDatabase {
    /// Create and atomically persist a verified custom-format PostgreSQL archive.
    pub async fn backup(
        &self,
        destination: impl AsRef<Path>,
    ) -> Result<ManagedBackupReport, ManagedDatabaseError> {
        let destination = destination.as_ref();
        validate_new_backup_destination(destination)?;
        self.docker.ensure_available().await?;
        let _lifecycle_lock = self.credentials.acquire_lifecycle_lock()?;
        self.require_healthy_owned_container(true).await?;
        let _credentials = self.credentials.load()?;

        let result = self.backup_locked(destination).await;
        let cleanup = self
            .docker
            .remove_container_archive(&self.identity.container_name, BACKUP_CONTAINER_PATH)
            .await;
        prefer_archive_cleanup(result, cleanup)
    }

    async fn backup_locked(
        &self,
        destination: &Path,
    ) -> Result<ManagedBackupReport, ManagedDatabaseError> {
        self.docker
            .remove_container_archive(&self.identity.container_name, BACKUP_CONTAINER_PATH)
            .await?;
        self.docker
            .create_database_archive(&self.identity.container_name, BACKUP_CONTAINER_PATH)
            .await?;
        self.docker
            .verify_database_archive(&self.identity.container_name, BACKUP_CONTAINER_PATH)
            .await?;

        let parent = destination
            .parent()
            .filter(|parent| parent.is_dir())
            .ok_or(ManagedDatabaseError::BackupDestination)?;
        let temporary =
            NamedTempFile::new_in(parent).map_err(|_| ManagedDatabaseError::BackupDestination)?;
        self.docker
            .copy_from_container(
                &self.identity.container_name,
                BACKUP_CONTAINER_PATH,
                temporary.path(),
            )
            .await?;
        set_private_archive_permissions(temporary.path())?;
        let bytes = verify_archive_file(temporary.path())?;
        open_archive(temporary.path())?
            .sync_all()
            .map_err(|_| ManagedDatabaseError::BackupDestination)?;
        temporary
            .persist_noclobber(destination)
            .map_err(|_| ManagedDatabaseError::BackupDestination)?;
        sync_parent(parent)?;
        Ok(ManagedBackupReport { bytes })
    }

    /// Replace live contents from a verified archive and recover the old state
    /// if either restore or post-restore capability proof fails.
    pub async fn restore(
        &self,
        source: impl AsRef<Path>,
        confirmation: ManagedDestructiveConfirmation,
    ) -> Result<ManagedRestoreReport, ManagedDatabaseError> {
        self.validate_destructive_confirmation(
            &confirmation,
            ManagedDestructiveOperation::Restore,
        )?;
        self.docker.ensure_available().await?;
        let _lifecycle_lock = self.credentials.acquire_lifecycle_lock()?;
        let staged = stage_restore_archive(source.as_ref(), self.credentials.path())?;
        self.require_healthy_owned_container(true).await?;
        let credentials = self.credentials.load()?;

        let result = self.restore_locked(staged.path(), &credentials).await;
        let cleanup = self.cleanup_restore_archives().await;
        prefer_archive_cleanup(result, cleanup)
    }

    async fn restore_locked(
        &self,
        source: &Path,
        credentials: &DatabaseCredentials,
    ) -> Result<ManagedRestoreReport, ManagedDatabaseError> {
        self.docker
            .copy_to_container(
                &self.identity.container_name,
                source,
                RESTORE_CONTAINER_PATH,
            )
            .await?;
        self.docker
            .verify_database_archive(&self.identity.container_name, RESTORE_CONTAINER_PATH)
            .await?;
        self.docker
            .remove_container_archive(&self.identity.container_name, ROLLBACK_CONTAINER_PATH)
            .await?;
        self.docker
            .create_database_archive(&self.identity.container_name, ROLLBACK_CONTAINER_PATH)
            .await?;
        self.docker
            .verify_database_archive(&self.identity.container_name, ROLLBACK_CONTAINER_PATH)
            .await?;

        if self
            .docker
            .restore_database_archive(&self.identity.container_name, RESTORE_CONTAINER_PATH)
            .await
            .is_err()
        {
            self.restore_rollback(credentials).await?;
            return Err(ManagedDatabaseError::RestoreFailed);
        }
        match self.verify_restored_database(credentials).await {
            Ok(initialized) => Ok(restore_report(initialized, &self.schema)),
            Err(_) => {
                self.restore_rollback(credentials).await?;
                Err(ManagedDatabaseError::RestoreVerificationFailed)
            }
        }
    }

    async fn restore_rollback(
        &self,
        credentials: &DatabaseCredentials,
    ) -> Result<(), ManagedDatabaseError> {
        self.docker
            .restore_database_archive(&self.identity.container_name, ROLLBACK_CONTAINER_PATH)
            .await
            .map_err(|_| ManagedDatabaseError::RestoreRollbackFailed)?;
        self.verify_restored_database(credentials)
            .await
            .map(|_| ())
            .map_err(|_| ManagedDatabaseError::RestoreRollbackFailed)
    }

    async fn verify_restored_database(
        &self,
        credentials: &DatabaseCredentials,
    ) -> Result<ManagedInitialization, ManagedDatabaseError> {
        let initialized = initialize_managed_database(credentials, self.port, &self.schema).await?;
        let database = open_managed_database(credentials, self.port, &self.schema).await?;
        let health = timeout(self.maintenance_timeout, read_bm25_health(&database)).await;
        database.pool.close().await;
        let health = health.map_err(|_| ManagedDatabaseError::MaintenanceTimeout)??;
        if !health.healthy() {
            return Err(ManagedDatabaseError::DerivedIndexUnhealthy);
        }
        Ok(initialized)
    }

    async fn cleanup_restore_archives(&self) -> Result<(), ManagedDatabaseError> {
        let restore = self
            .docker
            .remove_container_archive(&self.identity.container_name, RESTORE_CONTAINER_PATH)
            .await;
        let rollback = self
            .docker
            .remove_container_archive(&self.identity.container_name, ROLLBACK_CONTAINER_PATH)
            .await;
        restore.and(rollback)
    }

    /// Remove only resources whose labels, project identity, and data mount all match.
    pub async fn remove(
        &self,
        confirmation: ManagedDestructiveConfirmation,
    ) -> Result<ManagedRemoveReport, ManagedDatabaseError> {
        self.validate_destructive_confirmation(&confirmation, ManagedDestructiveOperation::Remove)?;
        self.docker.ensure_available().await?;
        let _lifecycle_lock = self.credentials.acquire_lifecycle_lock()?;
        let inspection = self
            .docker
            .inspect_container(&self.identity.container_name)
            .await?;
        if let Some(inspection) = inspection.as_ref() {
            validate_owned_container(&self.identity, inspection, false)?;
        }
        let volume_exists = self.docker.volume_exists_owned(&self.identity).await?;
        if inspection.is_some() && !volume_exists {
            return Err(ManagedDatabaseError::ManagedVolumeMissing);
        }
        let credentials_exist = self.credentials.validate_for_removal()?;

        if inspection.is_some() {
            self.docker
                .remove_container(&self.identity.container_name)
                .await?;
        }
        if volume_exists {
            self.docker
                .remove_volume(&self.identity.volume_name)
                .await?;
        }
        let credentials_removed = if credentials_exist {
            self.credentials.remove()?
        } else {
            false
        };
        Ok(ManagedRemoveReport {
            container_removed: inspection.is_some(),
            volume_removed: volume_exists,
            credentials_removed,
        })
    }

    /// Replace an owned non-pinned container while retaining the old container
    /// until the new exact-digest instance passes readiness and migration proof.
    pub async fn upgrade(
        &self,
        confirmation: ManagedDestructiveConfirmation,
    ) -> Result<ManagedUpgradeReport, ManagedDatabaseError> {
        self.validate_destructive_confirmation(
            &confirmation,
            ManagedDestructiveOperation::Upgrade,
        )?;
        self.docker.ensure_available().await?;
        let _lifecycle_lock = self.credentials.acquire_lifecycle_lock()?;
        let inspection = self
            .docker
            .inspect_container(&self.identity.container_name)
            .await?
            .ok_or(ManagedDatabaseError::ManagedContainerMissing)?;
        validate_owned_container(&self.identity, &inspection, false)?;
        if !self.docker.volume_exists_owned(&self.identity).await? {
            return Err(ManagedDatabaseError::ManagedVolumeMissing);
        }
        validate_configured_port(self.port, &inspection)?;
        let credentials = self.credentials.load()?;
        if inspection.image == super::MANAGED_DATABASE_IMAGE {
            let initialized = self
                .initialize_supported_existing(&inspection, &credentials)
                .await?;
            return Ok(upgrade_report(false, initialized, &self.schema));
        }

        let original_state = original_container_state(&inspection)?;
        let rollback_name = format!("{}{UPGRADE_ROLLBACK_SUFFIX}", self.identity.container_name);
        if self
            .docker
            .inspect_container(&rollback_name)
            .await?
            .is_some()
        {
            return Err(ManagedDatabaseError::UpgradeRollbackFailed);
        }
        self.docker
            .ensure_image(super::MANAGED_DATABASE_IMAGE)
            .await?;
        self.quiesce_for_upgrade(original_state).await?;
        if let Err(error) = self
            .docker
            .rename_container(&self.identity.container_name, &rollback_name)
            .await
        {
            self.restore_original_container_state(&self.identity.container_name, original_state)
                .await?;
            return Err(error);
        }

        let replacement = self.create_and_initialize_upgrade(&credentials).await;
        match replacement {
            Ok(initialized) => {
                self.docker.remove_container(&rollback_name).await?;
                Ok(upgrade_report(true, initialized, &self.schema))
            }
            Err(error) => {
                self.rollback_upgrade(&rollback_name, original_state)
                    .await?;
                Err(error)
            }
        }
    }

    async fn initialize_supported_existing(
        &self,
        inspection: &ContainerInspection,
        credentials: &DatabaseCredentials,
    ) -> Result<ManagedInitialization, ManagedDatabaseError> {
        let state = container_state(inspection);
        let transition = self.transition_existing_container(state).await?;
        match self
            .finish_start(credentials, transition == super::StartTransition::Pause)
            .await
        {
            Ok(initialized) => Ok(initialized),
            Err(error) => {
                self.rollback_or_fail(transition).await?;
                Err(error)
            }
        }
    }

    async fn quiesce_for_upgrade(
        &self,
        state: OriginalContainerState,
    ) -> Result<(), ManagedDatabaseError> {
        let result = match state {
            OriginalContainerState::Running => {
                self.docker
                    .stop_container(&self.identity.container_name)
                    .await
            }
            OriginalContainerState::Paused => match self
                .docker
                .unpause_container(&self.identity.container_name)
                .await
            {
                Ok(()) => {
                    self.docker
                        .stop_container(&self.identity.container_name)
                        .await
                }
                Err(error) => Err(error),
            },
            OriginalContainerState::Stopped => Ok(()),
        };
        if let Err(error) = result {
            self.restore_original_container_state(&self.identity.container_name, state)
                .await?;
            return Err(error);
        }
        Ok(())
    }

    async fn create_and_initialize_upgrade(
        &self,
        credentials: &DatabaseCredentials,
    ) -> Result<ManagedInitialization, ManagedDatabaseError> {
        self.docker
            .create_container(&ContainerCreateSpec {
                identity: &self.identity,
                port: self.port,
                image: super::MANAGED_DATABASE_IMAGE,
            })
            .await?;
        self.docker
            .install_password_file(&self.identity.container_name, self.credentials.path())
            .await?;
        self.docker
            .start_container(&self.identity.container_name, self.port)
            .await?;
        self.finish_start(credentials, false).await
    }

    async fn rollback_upgrade(
        &self,
        rollback_name: &str,
        state: OriginalContainerState,
    ) -> Result<(), ManagedDatabaseError> {
        if let Some(replacement) = self
            .docker
            .inspect_container(&self.identity.container_name)
            .await
            .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?
        {
            validate_owned_container(&self.identity, &replacement, true)
                .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
            self.docker
                .remove_container(&self.identity.container_name)
                .await
                .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
        }
        let rollback = self
            .docker
            .inspect_container(rollback_name)
            .await
            .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?
            .ok_or(ManagedDatabaseError::UpgradeRollbackFailed)?;
        validate_owned_container(&self.identity, &rollback, false)
            .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
        self.docker
            .rename_container(rollback_name, &self.identity.container_name)
            .await
            .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
        self.restore_original_container_state(&self.identity.container_name, state)
            .await
    }

    async fn restore_original_container_state(
        &self,
        name: &str,
        state: OriginalContainerState,
    ) -> Result<(), ManagedDatabaseError> {
        let inspection = self
            .docker
            .inspect_container(name)
            .await
            .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?
            .ok_or(ManagedDatabaseError::UpgradeRollbackFailed)?;
        validate_owned_container(&self.identity, &inspection, false)
            .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
        let current = original_container_state(&inspection)
            .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
        match (state, current) {
            (OriginalContainerState::Running, OriginalContainerState::Running)
            | (OriginalContainerState::Paused, OriginalContainerState::Paused)
            | (OriginalContainerState::Stopped, OriginalContainerState::Stopped) => Ok(()),
            (OriginalContainerState::Running, OriginalContainerState::Paused) => self
                .docker
                .unpause_container(name)
                .await
                .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed),
            (OriginalContainerState::Paused, OriginalContainerState::Running) => self
                .docker
                .pause_container(name)
                .await
                .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed),
            (
                OriginalContainerState::Running | OriginalContainerState::Paused,
                OriginalContainerState::Stopped,
            ) => {
                self.docker
                    .install_password_file(name, self.credentials.path())
                    .await
                    .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
                self.docker
                    .start_container(name, self.port)
                    .await
                    .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
                if matches!(state, OriginalContainerState::Paused) {
                    self.docker
                        .pause_container(name)
                        .await
                        .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
                }
                Ok(())
            }
            (OriginalContainerState::Stopped, OriginalContainerState::Running) => self
                .docker
                .stop_container(name)
                .await
                .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed),
            (OriginalContainerState::Stopped, OriginalContainerState::Paused) => {
                self.docker
                    .unpause_container(name)
                    .await
                    .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)?;
                self.docker
                    .stop_container(name)
                    .await
                    .map_err(|_| ManagedDatabaseError::UpgradeRollbackFailed)
            }
        }
    }

    /// Read the schema-qualified ParadeDB BM25 catalog state without mutation.
    pub async fn derived_index_health(
        &self,
    ) -> Result<ManagedDerivedIndexHealth, ManagedDatabaseError> {
        self.docker.ensure_available().await?;
        let _lifecycle_lock = self.credentials.acquire_lifecycle_lock()?;
        self.require_healthy_owned_container(true).await?;
        let credentials = self.credentials.load()?;
        let database = open_managed_database(&credentials, self.port, &self.schema).await?;
        let result = timeout(self.maintenance_timeout, read_bm25_health(&database)).await;
        database.pool.close().await;
        result.map_err(|_| ManagedDatabaseError::MaintenanceTimeout)?
    }

    /// Transactionally rebuild the derived ParadeDB BM25 index and prove its catalog health.
    pub async fn rebuild_derived_indexes(
        &self,
        confirmation: ManagedDestructiveConfirmation,
    ) -> Result<ManagedDerivedIndexHealth, ManagedDatabaseError> {
        self.validate_destructive_confirmation(
            &confirmation,
            ManagedDestructiveOperation::RebuildDerivedIndexes,
        )?;
        self.docker.ensure_available().await?;
        let _lifecycle_lock = self.credentials.acquire_lifecycle_lock()?;
        self.require_healthy_owned_container(true).await?;
        let credentials = self.credentials.load()?;
        let database = open_managed_database(&credentials, self.port, &self.schema).await?;
        let result = timeout(
            self.maintenance_timeout,
            rebuild_bm25_index(&database, self.maintenance_timeout),
        )
        .await;
        database.pool.close().await;
        result.map_err(|_| ManagedDatabaseError::MaintenanceTimeout)?
    }

    async fn require_healthy_owned_container(
        &self,
        require_supported_image: bool,
    ) -> Result<ContainerInspection, ManagedDatabaseError> {
        let inspection = self
            .docker
            .inspect_container(&self.identity.container_name)
            .await?
            .ok_or(ManagedDatabaseError::ManagedContainerMissing)?;
        validate_owned_container(&self.identity, &inspection, require_supported_image)?;
        super::verify_volume(&self.docker, &self.identity).await?;
        validate_configured_port(self.port, &inspection)?;
        if container_state(&inspection) != ManagedContainerState::Healthy {
            return Err(ManagedDatabaseError::DatabaseNotHealthyForMaintenance);
        }
        Ok(inspection)
    }
}

fn original_container_state(
    inspection: &ContainerInspection,
) -> Result<OriginalContainerState, ManagedDatabaseError> {
    match inspection.process_state.as_str() {
        "running" | "restarting" => Ok(OriginalContainerState::Running),
        "paused" => Ok(OriginalContainerState::Paused),
        "created" | "exited" | "dead" => Ok(OriginalContainerState::Stopped),
        _ => Err(ManagedDatabaseError::UnsupportedContainerState),
    }
}

fn restore_report(
    initialized: ManagedInitialization,
    schema: &cartograph_config::DatabaseSchema,
) -> ManagedRestoreReport {
    ManagedRestoreReport {
        capabilities: initialized.capabilities,
        migrations: initialized.migrations,
        schema: schema.as_str().to_owned(),
    }
}

fn upgrade_report(
    upgraded: bool,
    initialized: ManagedInitialization,
    schema: &cartograph_config::DatabaseSchema,
) -> ManagedUpgradeReport {
    ManagedUpgradeReport {
        upgraded,
        capabilities: initialized.capabilities,
        migrations: initialized.migrations,
        schema: schema.as_str().to_owned(),
    }
}

fn validate_new_backup_destination(destination: &Path) -> Result<(), ManagedDatabaseError> {
    if destination.file_name().is_none() || fs::symlink_metadata(destination).is_ok() {
        return Err(ManagedDatabaseError::BackupDestination);
    }
    destination
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or(ManagedDatabaseError::BackupDestination)?;
    Ok(())
}

fn verify_archive_file(path: &Path) -> Result<u64, ManagedDatabaseError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ManagedDatabaseError::RestoreArchiveInvalid)?;
    if !metadata.file_type().is_file() || metadata.len() <= ARCHIVE_MAGIC_BYTES {
        return Err(ManagedDatabaseError::RestoreArchiveInvalid);
    }
    let mut file = open_archive(path)?;
    let mut magic = [0_u8; ARCHIVE_MAGIC.len()];
    file.read_exact(&mut magic)
        .map_err(|_| ManagedDatabaseError::RestoreArchiveInvalid)?;
    if &magic != ARCHIVE_MAGIC {
        return Err(ManagedDatabaseError::RestoreArchiveInvalid);
    }
    Ok(metadata.len())
}

fn stage_restore_archive(
    source: &Path,
    credential_path: &Path,
) -> Result<NamedTempFile, ManagedDatabaseError> {
    verify_archive_file(source)?;
    let mut source_file = open_archive(source)?;
    source_file
        .seek(SeekFrom::Start(0))
        .map_err(|_| ManagedDatabaseError::RestoreArchiveInvalid)?;
    let parent = credential_path
        .parent()
        .ok_or(ManagedDatabaseError::CredentialPath)?;
    let mut staged =
        NamedTempFile::new_in(parent).map_err(|_| ManagedDatabaseError::RestoreArchiveInvalid)?;
    std::io::copy(&mut source_file, &mut staged)
        .map_err(|_| ManagedDatabaseError::RestoreArchiveInvalid)?;
    staged
        .flush()
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|_| ManagedDatabaseError::RestoreArchiveInvalid)?;
    verify_archive_file(staged.path())?;
    Ok(staged)
}

#[cfg(unix)]
fn open_archive(path: &Path) -> Result<File, ManagedDatabaseError> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| ManagedDatabaseError::RestoreArchiveInvalid)
}

#[cfg(not(unix))]
fn open_archive(path: &Path) -> Result<File, ManagedDatabaseError> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| ManagedDatabaseError::RestoreArchiveInvalid)
}

fn sync_parent(parent: &Path) -> Result<(), ManagedDatabaseError> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ManagedDatabaseError::BackupDestination)
}

#[cfg(unix)]
fn set_private_archive_permissions(path: &Path) -> Result<(), ManagedDatabaseError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| ManagedDatabaseError::BackupDestination)
}

#[cfg(not(unix))]
fn set_private_archive_permissions(_path: &Path) -> Result<(), ManagedDatabaseError> {
    Ok(())
}

fn prefer_archive_cleanup<T>(
    result: Result<T, ManagedDatabaseError>,
    cleanup: Result<(), ManagedDatabaseError>,
) -> Result<T, ManagedDatabaseError> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(_)) => Err(ManagedDatabaseError::ArchiveCleanupFailed),
        (Err(error), _) => Err(error),
    }
}

async fn open_managed_database(
    credentials: &DatabaseCredentials,
    port: u16,
    schema: &cartograph_config::DatabaseSchema,
) -> Result<CartographDatabase, ManagedDatabaseError> {
    let url = credentials.database_url(port)?;
    let settings = DatabaseSettings::parse(url.expose_secret(), Some("2"), Some("10000"))
        .and_then(|settings| settings.with_schema(schema.as_str()))
        .map_err(|_| ManagedDatabaseError::CredentialFormat)?;
    let pool = connect(&settings)
        .await
        .map_err(|_| ManagedDatabaseError::DatabaseConnection)?;
    Ok(CartographDatabase::new(pool, settings.schema().clone()))
}

async fn read_bm25_health(
    database: &CartographDatabase,
) -> Result<ManagedDerivedIndexHealth, ManagedDatabaseError> {
    let row = query(
        r#"SELECT indexes.indisvalid, indexes.indisready, methods.amname
            FROM pg_class AS classes
            JOIN pg_namespace AS namespaces ON namespaces.oid = classes.relnamespace
            JOIN pg_index AS indexes ON indexes.indexrelid = classes.oid
            JOIN pg_am AS methods ON methods.oid = classes.relam
            WHERE namespaces.nspname = $1 AND classes.relname = $2"#,
    )
    .bind(database.schema().as_str())
    .bind(BM25_INDEX_NAME)
    .fetch_optional(&database.pool)
    .await
    .map_err(|_| ManagedDatabaseError::DatabaseCapabilityProbe)?;
    decode_bm25_health(row.as_ref())
}

fn decode_bm25_health(
    row: Option<&sqlx_postgres::PgRow>,
) -> Result<ManagedDerivedIndexHealth, ManagedDatabaseError> {
    let Some(row) = row else {
        return Ok(ManagedDerivedIndexHealth {
            present: false,
            valid: false,
            ready: false,
            bm25_access_method: false,
        });
    };
    Ok(ManagedDerivedIndexHealth {
        present: true,
        valid: row
            .try_get::<bool, _>(0)
            .map_err(|_| ManagedDatabaseError::DatabaseCapabilityProbe)?,
        ready: row
            .try_get::<bool, _>(1)
            .map_err(|_| ManagedDatabaseError::DatabaseCapabilityProbe)?,
        bm25_access_method: row
            .try_get::<String, _>(2)
            .map_err(|_| ManagedDatabaseError::DatabaseCapabilityProbe)?
            == "bm25",
    })
}

async fn rebuild_bm25_index(
    database: &CartographDatabase,
    statement_timeout: std::time::Duration,
) -> Result<ManagedDerivedIndexHealth, ManagedDatabaseError> {
    let mut transaction = database
        .pool
        .begin()
        .await
        .map_err(|_| ManagedDatabaseError::DatabaseConnection)?;
    if crate::database::set_local_statement_timeout(&mut transaction, statement_timeout)
        .await
        .is_err()
    {
        let _ = transaction.rollback().await;
        return Err(ManagedDatabaseError::MaintenanceTimeout);
    }
    let lock_key = format!(
        "{BM25_REBUILD_LOCK_NAMESPACE}:{}",
        database.schema().as_str()
    );
    if query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(lock_key)
        .execute(&mut *transaction)
        .await
        .is_err()
    {
        let _ = transaction.rollback().await;
        return Err(ManagedDatabaseError::DatabaseCapabilityProbe);
    }
    let quoted_schema = crate::database::quoted_schema(database.schema());
    let drop_statement = format!("DROP INDEX IF EXISTS {quoted_schema}.\"{BM25_INDEX_NAME}\"");
    let create_statement = crate::migrations::SEARCH_DOCUMENTS_BM25_INDEX_SQL_TEMPLATE
        .replace("{schema}", &quoted_schema);
    let rebuilt = async {
        query(AssertSqlSafe(drop_statement))
            .execute(&mut *transaction)
            .await
            .map_err(|_| ManagedDatabaseError::DerivedIndexUnhealthy)?;
        query(AssertSqlSafe(create_statement))
            .execute(&mut *transaction)
            .await
            .map_err(|_| ManagedDatabaseError::DerivedIndexUnhealthy)?;
        let health_statement = r#"SELECT indexes.indisvalid, indexes.indisready, methods.amname
                FROM pg_class AS classes
                JOIN pg_namespace AS namespaces ON namespaces.oid = classes.relnamespace
                JOIN pg_index AS indexes ON indexes.indexrelid = classes.oid
                JOIN pg_am AS methods ON methods.oid = classes.relam
                WHERE namespaces.nspname = $1 AND classes.relname = $2"#;
        let row = query(health_statement)
            .bind(database.schema().as_str())
            .bind(BM25_INDEX_NAME)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| ManagedDatabaseError::DerivedIndexUnhealthy)?;
        let health = decode_bm25_health(row.as_ref())?;
        if !health.healthy() {
            return Err(ManagedDatabaseError::DerivedIndexUnhealthy);
        }
        Ok(health)
    }
    .await;
    let health = match rebuilt {
        Ok(health) => health,
        Err(error) => {
            let _ = transaction.rollback().await;
            return Err(error);
        }
    };
    transaction
        .commit()
        .await
        .map_err(|_| ManagedDatabaseError::DerivedIndexUnhealthy)?;
    Ok(health)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE_SCHEMA: &str = "cartograph_managed_maintenance_test";
    const LIVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

    struct LiveDockerCleanup {
        container_name: String,
        rollback_name: String,
        volume_name: String,
        image: Option<String>,
    }

    impl Drop for LiveDockerCleanup {
        fn drop(&mut self) {
            for name in [&self.container_name, &self.rollback_name] {
                let _ = std::process::Command::new("docker")
                    .args(["container", "rm", "--force", name])
                    .output();
            }
            let _ = std::process::Command::new("docker")
                .args(["volume", "rm", "--force", &self.volume_name])
                .output();
            if let Some(image) = self.image.as_deref() {
                let _ = std::process::Command::new("docker")
                    .args(["image", "rm", "--force", image])
                    .output();
            }
        }
    }

    #[test]
    fn archive_validation_rejects_symlinks_empty_and_non_custom_files() {
        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("could not create archive fixture root: {error}"));
        let empty = directory.path().join("empty.dump");
        fs::write(&empty, b"")
            .unwrap_or_else(|error| panic!("could not write empty archive: {error}"));
        assert!(matches!(
            verify_archive_file(&empty),
            Err(ManagedDatabaseError::RestoreArchiveInvalid)
        ));
        let plain = directory.path().join("plain.dump");
        fs::write(&plain, b"not a postgres archive")
            .unwrap_or_else(|error| panic!("could not write plain archive: {error}"));
        assert!(matches!(
            verify_archive_file(&plain),
            Err(ManagedDatabaseError::RestoreArchiveInvalid)
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let archive = directory.path().join("archive.dump");
            fs::write(&archive, b"PGDMPpayload")
                .unwrap_or_else(|error| panic!("could not write archive fixture: {error}"));
            let link = directory.path().join("archive-link.dump");
            symlink(&archive, &link)
                .unwrap_or_else(|error| panic!("could not create archive symlink: {error}"));
            assert!(matches!(
                verify_archive_file(&link),
                Err(ManagedDatabaseError::RestoreArchiveInvalid)
            ));
        }
    }

    #[test]
    #[cfg(unix)]
    fn backup_archive_permissions_are_forced_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("could not create archive permission root: {error}"));
        let archive = directory.path().join("archive.dump");
        fs::write(&archive, b"PGDMPpayload")
            .unwrap_or_else(|error| panic!("could not write archive permission fixture: {error}"));
        fs::set_permissions(&archive, fs::Permissions::from_mode(0o644))
            .unwrap_or_else(|error| panic!("could not loosen archive fixture: {error}"));

        set_private_archive_permissions(&archive)
            .unwrap_or_else(|error| panic!("could not harden archive permissions: {error}"));
        let mode = fs::metadata(&archive)
            .unwrap_or_else(|error| panic!("could not stat hardened archive: {error}"))
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);
    }

    #[test]
    fn derived_index_health_requires_every_catalog_invariant() {
        let healthy = ManagedDerivedIndexHealth {
            present: true,
            valid: true,
            ready: true,
            bm25_access_method: true,
        };
        assert!(healthy.healthy());
        assert!(
            !ManagedDerivedIndexHealth {
                valid: false,
                ..healthy
            }
            .healthy()
        );
        assert!(
            !ManagedDerivedIndexHealth {
                ready: false,
                ..healthy
            }
            .healthy()
        );
        assert!(
            !ManagedDerivedIndexHealth {
                bm25_access_method: false,
                ..healthy
            }
            .healthy()
        );
    }

    #[tokio::test]
    #[ignore = "starts a real digest-pinned ParadeDB container and exercises archive rollback"]
    async fn managed_backup_restore_rebuild_and_remove_are_verified() {
        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("could not create maintenance project: {error}"));
        let database = live_database(directory.path());
        let _cleanup = live_cleanup(&database, None);
        let started = database
            .start()
            .await
            .unwrap_or_else(|error| panic!("could not start maintenance database: {error}"));
        assert!(started.capabilities.ready);

        execute_test_sql(
            &database,
            r#"CREATE TABLE "cartograph_managed_maintenance_test"."maintenance_marker" (
                value text NOT NULL
            )"#,
        )
        .await;
        execute_test_sql(
            &database,
            r#"INSERT INTO "cartograph_managed_maintenance_test"."maintenance_marker" (value)
                VALUES ('from-backup')"#,
        )
        .await;
        let good_archive = directory.path().join("good.dump");
        let backup = database
            .backup(&good_archive)
            .await
            .unwrap_or_else(|error| panic!("managed backup failed: {error}"));
        assert!(backup.bytes > ARCHIVE_MAGIC_BYTES);

        execute_test_sql(
            &database,
            r#"UPDATE "cartograph_managed_maintenance_test"."maintenance_marker"
                SET value = 'mutated'"#,
        )
        .await;
        let restored = database
            .restore(
                &good_archive,
                confirmation(&database, ManagedDestructiveOperation::Restore),
            )
            .await
            .unwrap_or_else(|error| panic!("verified restore failed: {error}"));
        assert!(restored.capabilities.ready);
        assert_eq!(read_marker(&database).await, "from-backup");
        assert!(live_health(&database).await.healthy());

        execute_test_sql(
            &database,
            r#"DROP INDEX "cartograph_managed_maintenance_test"."search_documents_bm25_idx""#,
        )
        .await;
        assert!(!live_health(&database).await.healthy());
        let incomplete_archive = directory.path().join("missing-derived-index.dump");
        database
            .backup(&incomplete_archive)
            .await
            .unwrap_or_else(|error| panic!("could not back up incomplete fixture: {error}"));
        let rebuilt = database
            .rebuild_derived_indexes(confirmation(
                &database,
                ManagedDestructiveOperation::RebuildDerivedIndexes,
            ))
            .await
            .unwrap_or_else(|error| panic!("derived-index rebuild failed: {error}"));
        assert!(rebuilt.healthy());
        execute_test_sql(
            &database,
            r#"UPDATE "cartograph_managed_maintenance_test"."maintenance_marker"
                SET value = 'rollback-protected'"#,
        )
        .await;

        let failed_restore = database
            .restore(
                &incomplete_archive,
                confirmation(&database, ManagedDestructiveOperation::Restore),
            )
            .await;
        assert!(matches!(
            failed_restore,
            Err(ManagedDatabaseError::RestoreVerificationFailed)
        ));
        assert_eq!(read_marker(&database).await, "rollback-protected");
        assert!(live_health(&database).await.healthy());

        let malformed_archive = directory.path().join("malformed.dump");
        fs::write(&malformed_archive, b"PGDMPnot-a-real-custom-archive")
            .unwrap_or_else(|error| panic!("could not write malformed archive: {error}"));
        let malformed_restore = database
            .restore(
                &malformed_archive,
                confirmation(&database, ManagedDestructiveOperation::Restore),
            )
            .await;
        assert!(matches!(
            malformed_restore,
            Err(ManagedDatabaseError::RestoreArchiveInvalid)
        ));
        assert_eq!(read_marker(&database).await, "rollback-protected");

        let removed = database
            .remove(confirmation(&database, ManagedDestructiveOperation::Remove))
            .await
            .unwrap_or_else(|error| panic!("managed removal failed: {error}"));
        assert!(removed.container_removed);
        assert!(removed.volume_removed);
        assert!(removed.credentials_removed);
        assert!(!database.credentials.path().exists());
        let status = database
            .status()
            .await
            .unwrap_or_else(|error| panic!("could not inspect removed database: {error}"));
        assert_eq!(status.state, ManagedContainerState::Missing);
    }

    #[tokio::test]
    #[ignore = "starts a real ParadeDB container and forces pinned-image upgrade rollback"]
    async fn managed_upgrade_restores_old_container_after_readiness_failure() {
        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("could not create upgrade project: {error}"));
        let database = live_database(directory.path());
        database
            .start()
            .await
            .unwrap_or_else(|error| panic!("could not start upgrade fixture: {error}"));
        let old_image = format!(
            "cartograph-maintenance-upgrade-old:{}",
            database.identity.project_hash
        );
        let _cleanup = live_cleanup(&database, Some(old_image.clone()));
        assert_docker_success(&[
            "image",
            "tag",
            super::super::MANAGED_DATABASE_IMAGE,
            &old_image,
        ]);
        database
            .stop()
            .await
            .unwrap_or_else(|error| panic!("could not stop upgrade fixture: {error}"));
        database
            .docker
            .remove_container(&database.identity.container_name)
            .await
            .unwrap_or_else(|error| panic!("could not replace upgrade fixture: {error}"));
        database
            .docker
            .create_container(&ContainerCreateSpec {
                identity: &database.identity,
                port: database.port,
                image: &old_image,
            })
            .await
            .unwrap_or_else(|error| panic!("could not create old-image fixture: {error}"));
        database
            .docker
            .install_password_file(
                &database.identity.container_name,
                database.credentials.path(),
            )
            .await
            .unwrap_or_else(|error| panic!("could not install old-image password: {error}"));
        database
            .docker
            .start_container(&database.identity.container_name, database.port)
            .await
            .unwrap_or_else(|error| panic!("could not start old-image fixture: {error}"));
        wait_for_owned_health(&database, false).await;

        let zero_timeout = live_database_with_port(directory.path(), database.port)
            .with_startup_timeout(std::time::Duration::ZERO);
        let failed_upgrade = zero_timeout
            .upgrade(confirmation(
                &zero_timeout,
                ManagedDestructiveOperation::Upgrade,
            ))
            .await;
        assert!(matches!(
            failed_upgrade,
            Err(ManagedDatabaseError::DatabaseStartupTimeout)
        ));
        wait_for_owned_health(&database, false).await;
        let rolled_back = database
            .docker
            .inspect_container(&database.identity.container_name)
            .await
            .unwrap_or_else(|error| panic!("could not inspect rollback container: {error}"))
            .unwrap_or_else(|| panic!("rollback container is missing"));
        assert_eq!(rolled_back.image, old_image);
        let rollback_name = format!(
            "{}{UPGRADE_ROLLBACK_SUFFIX}",
            database.identity.container_name
        );
        let retained_rollback = database
            .docker
            .inspect_container(&rollback_name)
            .await
            .unwrap_or_else(|error| panic!("could not inspect rollback slot: {error}"));
        assert!(retained_rollback.is_none());

        let upgraded = database
            .upgrade(confirmation(
                &database,
                ManagedDestructiveOperation::Upgrade,
            ))
            .await
            .unwrap_or_else(|error| panic!("pinned-image upgrade failed: {error}"));
        assert!(upgraded.upgraded);
        assert!(upgraded.capabilities.ready);
        let inspection = database
            .docker
            .inspect_container(&database.identity.container_name)
            .await
            .unwrap_or_else(|error| panic!("could not inspect upgraded container: {error}"))
            .unwrap_or_else(|| panic!("upgraded container is missing"));
        assert_eq!(inspection.image, super::super::MANAGED_DATABASE_IMAGE);

        database
            .remove(confirmation(&database, ManagedDestructiveOperation::Remove))
            .await
            .unwrap_or_else(|error| panic!("could not remove upgrade fixture: {error}"));
    }

    fn live_database(project_root: &Path) -> ManagedDatabase {
        live_database_with_port(project_root, available_loopback_port())
    }

    fn live_database_with_port(project_root: &Path, port: u16) -> ManagedDatabase {
        let schema = cartograph_config::DatabaseSchema::parse(LIVE_SCHEMA)
            .unwrap_or_else(|error| panic!("live maintenance schema is invalid: {error}"));
        super::super::managed_database_with_schema(project_root, port, schema)
            .unwrap_or_else(|error| panic!("could not build live maintenance manager: {error}"))
            .with_startup_timeout(LIVE_TIMEOUT)
            .with_maintenance_timeout(LIVE_TIMEOUT)
    }

    fn available_loopback_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap_or_else(|error| panic!("could not reserve maintenance port: {error}"));
        listener
            .local_addr()
            .unwrap_or_else(|error| panic!("could not inspect maintenance port: {error}"))
            .port()
    }

    fn live_cleanup(database: &ManagedDatabase, image: Option<String>) -> LiveDockerCleanup {
        LiveDockerCleanup {
            container_name: database.identity.container_name.clone(),
            rollback_name: format!(
                "{}{UPGRADE_ROLLBACK_SUFFIX}",
                database.identity.container_name
            ),
            volume_name: database.identity.volume_name.clone(),
            image,
        }
    }

    fn confirmation(
        database: &ManagedDatabase,
        operation: ManagedDestructiveOperation,
    ) -> ManagedDestructiveConfirmation {
        database
            .confirm_destructive_operation(operation, operation.confirmation_phrase())
            .unwrap_or_else(|error| panic!("could not confirm destructive operation: {error}"))
    }

    async fn execute_test_sql(database: &ManagedDatabase, statement: &'static str) {
        let credentials = database
            .credentials
            .load()
            .unwrap_or_else(|error| panic!("could not load maintenance credentials: {error}"));
        let connection = open_managed_database(&credentials, database.port, &database.schema)
            .await
            .unwrap_or_else(|error| panic!("could not open maintenance database: {error}"));
        query(AssertSqlSafe(statement))
            .execute(&connection.pool)
            .await
            .unwrap_or_else(|error| panic!("maintenance fixture statement failed: {error}"));
        connection.pool.close().await;
    }

    async fn read_marker(database: &ManagedDatabase) -> String {
        let credentials = database
            .credentials
            .load()
            .unwrap_or_else(|error| panic!("could not load marker credentials: {error}"));
        let connection = open_managed_database(&credentials, database.port, &database.schema)
            .await
            .unwrap_or_else(|error| panic!("could not open marker database: {error}"));
        let row = query(
            r#"SELECT value
                FROM "cartograph_managed_maintenance_test"."maintenance_marker""#,
        )
        .fetch_one(&connection.pool)
        .await
        .unwrap_or_else(|error| panic!("could not read marker: {error}"));
        let value = row
            .try_get::<String, _>(0)
            .unwrap_or_else(|error| panic!("marker value was invalid: {error}"));
        connection.pool.close().await;
        value
    }

    async fn live_health(database: &ManagedDatabase) -> ManagedDerivedIndexHealth {
        database
            .derived_index_health()
            .await
            .unwrap_or_else(|error| panic!("could not read derived-index health: {error}"))
    }

    async fn wait_for_owned_health(database: &ManagedDatabase, require_supported_image: bool) {
        let waited = timeout(LIVE_TIMEOUT, async {
            loop {
                let inspection = database
                    .docker
                    .inspect_container(&database.identity.container_name)
                    .await
                    .unwrap_or_else(|error| panic!("could not inspect live fixture: {error}"))
                    .unwrap_or_else(|| panic!("live fixture container is missing"));
                validate_owned_container(&database.identity, &inspection, require_supported_image)
                    .unwrap_or_else(|error| panic!("live fixture ownership changed: {error}"));
                match container_state(&inspection) {
                    ManagedContainerState::Healthy => break,
                    ManagedContainerState::Created
                    | ManagedContainerState::Starting
                    | ManagedContainerState::Restarting => {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                    state => panic!("live fixture entered unexpected state: {state:?}"),
                }
            }
        })
        .await;
        assert!(waited.is_ok(), "live fixture health timed out");
    }

    fn assert_docker_success(arguments: &[&str]) {
        let output = std::process::Command::new("docker")
            .args(arguments)
            .output()
            .unwrap_or_else(|error| panic!("could not run Docker fixture command: {error}"));
        assert!(
            output.status.success(),
            "Docker fixture command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
