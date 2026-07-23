use std::collections::BTreeMap;

use cartograph_config::DatabaseSchema;
use serde::Serialize;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};
use sqlx_postgres::PgConnection;
use thiserror::Error;

use crate::{CartographDatabase, CheckStatus, probe_capabilities};

const INITIAL_SCHEMA_VERSION: i64 = 1;
const MIGRATION_LOCK_NAMESPACE: &str = "cartograph-v2-schema-migration";

struct Migration {
    version: i64,
    name: &'static str,
    statements: &'static [&'static str],
}

struct LedgerRecord {
    name: String,
    checksum: String,
}

struct ApplyMigrationInput<'a> {
    quoted_schema: &'a str,
    migration: &'a Migration,
    checksum: &'a str,
}

const INITIAL_SCHEMA: Migration = Migration {
    version: INITIAL_SCHEMA_VERSION,
    name: "generation_safe_core_and_bm25",
    statements: &[
        r#"CREATE TABLE {schema}."projects" (
            project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            root_identity text NOT NULL UNIQUE CHECK (length(root_identity) BETWEEN 1 AND 4096),
            repository_fingerprint text NOT NULL CHECK (repository_fingerprint ~ '^[0-9a-f]{64}$'),
            current_generation_id uuid,
            next_generation_sequence bigint NOT NULL DEFAULT 1
                CHECK (next_generation_sequence > 0),
            created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )"#,
        r#"CREATE TABLE {schema}."index_generations" (
            project_id uuid NOT NULL REFERENCES {schema}."projects"(project_id) ON DELETE CASCADE,
            generation_id uuid NOT NULL DEFAULT gen_random_uuid(),
            generation_sequence bigint NOT NULL CHECK (generation_sequence > 0),
            source_revision text NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 1024),
            state text NOT NULL DEFAULT 'staging'
                CHECK (state IN ('staging', 'ready', 'current', 'superseded', 'failed')),
            worker_count smallint NOT NULL CHECK (worker_count BETWEEN 1 AND 256),
            content_digest text CHECK (content_digest ~ '^[0-9a-f]{64}$'),
            started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            ready_at timestamptz,
            published_at timestamptz,
            PRIMARY KEY (project_id, generation_id),
            UNIQUE (project_id, generation_sequence)
        )"#,
        r#"ALTER TABLE {schema}."projects"
            ADD CONSTRAINT projects_current_generation_fk
            FOREIGN KEY (project_id, current_generation_id)
            REFERENCES {schema}."index_generations"(project_id, generation_id)
            DEFERRABLE INITIALLY DEFERRED"#,
        r#"CREATE UNIQUE INDEX index_generations_one_current_idx
            ON {schema}."index_generations" (project_id)
            WHERE state = 'current'"#,
        r#"CREATE INDEX index_generations_state_idx
            ON {schema}."index_generations" (project_id, state, started_at DESC)"#,
        r#"CREATE TABLE {schema}."files" (
            project_id uuid NOT NULL,
            generation_id uuid NOT NULL,
            file_id uuid NOT NULL,
            normalized_path text NOT NULL CHECK (length(normalized_path) BETWEEN 1 AND 4096),
            language text NOT NULL CHECK (length(language) BETWEEN 1 AND 64),
            content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
            byte_size bigint NOT NULL CHECK (byte_size >= 0),
            parse_status text NOT NULL CHECK (parse_status IN ('parsed', 'partial', 'failed', 'skipped')),
            PRIMARY KEY (project_id, generation_id, file_id),
            UNIQUE (project_id, generation_id, normalized_path),
            FOREIGN KEY (project_id, generation_id)
                REFERENCES {schema}."index_generations"(project_id, generation_id)
                ON DELETE CASCADE
        )"#,
        r#"CREATE TABLE {schema}."symbols" (
            project_id uuid NOT NULL,
            generation_id uuid NOT NULL,
            symbol_id uuid NOT NULL,
            file_id uuid NOT NULL,
            symbol_kind text NOT NULL CHECK (length(symbol_kind) BETWEEN 1 AND 64),
            qualified_name text NOT NULL CHECK (length(qualified_name) BETWEEN 1 AND 2048),
            signature text NOT NULL DEFAULT '',
            start_byte bigint NOT NULL CHECK (start_byte >= 0),
            end_byte bigint NOT NULL CHECK (end_byte >= start_byte),
            start_line integer NOT NULL CHECK (start_line >= 1),
            end_line integer NOT NULL CHECK (end_line >= start_line),
            structural_digest text NOT NULL CHECK (structural_digest ~ '^[0-9a-f]{64}$'),
            PRIMARY KEY (project_id, generation_id, symbol_id),
            FOREIGN KEY (project_id, generation_id, file_id)
                REFERENCES {schema}."files"(project_id, generation_id, file_id)
                ON DELETE CASCADE
        )"#,
        r#"CREATE INDEX symbols_file_span_idx
            ON {schema}."symbols" (project_id, generation_id, file_id, start_byte, end_byte)"#,
        r#"CREATE INDEX symbols_qualified_name_idx
            ON {schema}."symbols" (project_id, generation_id, qualified_name)"#,
        r#"CREATE TABLE {schema}."edges" (
            project_id uuid NOT NULL,
            generation_id uuid NOT NULL,
            source_symbol_id uuid NOT NULL,
            target_symbol_id uuid NOT NULL,
            edge_kind text NOT NULL
                CHECK (edge_kind IN ('calls', 'imports', 'references', 'implements', 'extends', 'tests', 'contains')),
            confidence real NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
            provenance text NOT NULL CHECK (length(provenance) BETWEEN 1 AND 256),
            PRIMARY KEY (
                project_id, generation_id, source_symbol_id, target_symbol_id, edge_kind, provenance
            ),
            FOREIGN KEY (project_id, generation_id, source_symbol_id)
                REFERENCES {schema}."symbols"(project_id, generation_id, symbol_id)
                ON DELETE CASCADE,
            FOREIGN KEY (project_id, generation_id, target_symbol_id)
                REFERENCES {schema}."symbols"(project_id, generation_id, symbol_id)
                ON DELETE CASCADE
        )"#,
        r#"CREATE INDEX edges_target_idx
            ON {schema}."edges" (project_id, generation_id, target_symbol_id, edge_kind)"#,
        r#"CREATE TABLE {schema}."references" (
            reference_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            project_id uuid NOT NULL,
            generation_id uuid NOT NULL,
            file_id uuid NOT NULL,
            target_symbol_id uuid,
            reference_kind text NOT NULL CHECK (length(reference_kind) BETWEEN 1 AND 64),
            start_byte bigint NOT NULL CHECK (start_byte >= 0),
            end_byte bigint NOT NULL CHECK (end_byte >= start_byte),
            confidence real NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
            FOREIGN KEY (project_id, generation_id, file_id)
                REFERENCES {schema}."files"(project_id, generation_id, file_id)
                ON DELETE CASCADE,
            FOREIGN KEY (project_id, generation_id, target_symbol_id)
                REFERENCES {schema}."symbols"(project_id, generation_id, symbol_id)
                ON DELETE CASCADE
        )"#,
        r#"CREATE INDEX references_file_span_idx
            ON {schema}."references" (project_id, generation_id, file_id, start_byte, end_byte)"#,
        r#"CREATE INDEX references_target_idx
            ON {schema}."references" (project_id, generation_id, target_symbol_id)
            WHERE target_symbol_id IS NOT NULL"#,
        r#"CREATE TABLE {schema}."search_documents" (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            project_id uuid NOT NULL,
            generation_id uuid NOT NULL,
            document_id uuid NOT NULL,
            file_id uuid,
            symbol_id uuid,
            path text NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
            language text NOT NULL CHECK (length(language) BETWEEN 1 AND 64),
            document_kind text NOT NULL
                CHECK (document_kind IN ('symbol', 'file', 'documentation', 'test', 'configuration')),
            qualified_name text NOT NULL DEFAULT '',
            code text NOT NULL DEFAULT '',
            natural_text text NOT NULL DEFAULT '',
            metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            UNIQUE (project_id, generation_id, document_id),
            CHECK (qualified_name <> '' OR code <> '' OR natural_text <> ''),
            FOREIGN KEY (project_id, generation_id)
                REFERENCES {schema}."index_generations"(project_id, generation_id)
                ON DELETE CASCADE,
            FOREIGN KEY (project_id, generation_id, file_id)
                REFERENCES {schema}."files"(project_id, generation_id, file_id)
                ON DELETE CASCADE,
            FOREIGN KEY (project_id, generation_id, symbol_id)
                REFERENCES {schema}."symbols"(project_id, generation_id, symbol_id)
                ON DELETE CASCADE
        )"#,
        r#"CREATE INDEX search_documents_project_generation_idx
            ON {schema}."search_documents" (project_id, generation_id, id)"#,
        r#"CREATE INDEX search_documents_path_idx
            ON {schema}."search_documents" (project_id, generation_id, path)"#,
        r#"CREATE INDEX search_documents_bm25_idx
            ON {schema}."search_documents"
            USING bm25 (
                id,
                project_id,
                generation_id,
                document_id,
                file_id,
                symbol_id,
                path,
                language,
                document_kind,
                (qualified_name::pdb.source_code),
                (code::pdb.source_code),
                natural_text,
                metadata
            )
            WITH (key_field = 'id')"#,
    ],
};

/// Result of applying the append-only schema migration ledger.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MigrationReport {
    /// Versions newly committed by this invocation.
    pub applied_versions: Vec<i64>,
    /// Highest schema version now recorded.
    pub current_version: i64,
}

/// Migration failures. No driver message or connection string is rendered.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum MigrationError {
    /// Required PostgreSQL/ParadeDB capabilities were absent before mutation.
    #[error("database is not ready for Cartograph migrations; failed checks: {checks:?}")]
    MissingCapabilities {
        /// Stable doctor check identifiers.
        checks: Vec<&'static str>,
    },
    /// A migration or ledger query failed.
    #[error("Cartograph schema migration failed during {operation}")]
    DatabaseOperation {
        /// Stable operation identifier.
        operation: &'static str,
    },
    /// An applied version's immutable name or checksum changed.
    #[error("migration ledger entry {version} does not match this Cartograph binary")]
    LedgerConflict {
        /// Conflicting migration version.
        version: i64,
    },
    /// The database was created by a newer Cartograph binary.
    #[error("database schema version {version} is newer than this Cartograph binary")]
    SchemaVersionAhead {
        /// Newer recorded migration version.
        version: i64,
    },
}

impl CartographDatabase {
    /// Verify hard capabilities, then apply append-only migrations under a
    /// transaction-scoped advisory lock.
    pub async fn migrate(&self) -> Result<MigrationReport, MigrationError> {
        let capabilities = probe_capabilities(&self.pool).await.map_err(|_| {
            MigrationError::DatabaseOperation {
                operation: "capability-probe",
            }
        })?;
        let failed_checks = capabilities
            .checks
            .iter()
            .filter(|check| check.status == CheckStatus::Fail)
            .map(|check| check.id)
            .collect::<Vec<_>>();
        if !failed_checks.is_empty() {
            return Err(MigrationError::MissingCapabilities {
                checks: failed_checks,
            });
        }

        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| MigrationError::DatabaseOperation { operation: "begin" })?;
        let result = migrate_transaction(&mut transaction, &self.schema).await;
        match result {
            Ok(report) => {
                transaction
                    .commit()
                    .await
                    .map_err(|_| MigrationError::DatabaseOperation {
                        operation: "commit",
                    })?;
                Ok(report)
            }
            Err(error) => {
                transaction
                    .rollback()
                    .await
                    .map_err(|_| MigrationError::DatabaseOperation {
                        operation: "rollback",
                    })?;
                Err(error)
            }
        }
    }
}

async fn migrate_transaction(
    connection: &mut PgConnection,
    schema: &DatabaseSchema,
) -> Result<MigrationReport, MigrationError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("{MIGRATION_LOCK_NAMESPACE}:{}", schema.as_str()))
        .execute(&mut *connection)
        .await
        .map_err(|_| MigrationError::DatabaseOperation {
            operation: "advisory-lock",
        })?;

    let quoted_schema = crate::database::quoted_schema(schema);
    execute_dynamic(
        connection,
        format!("CREATE SCHEMA IF NOT EXISTS {quoted_schema}"),
        "create-schema",
    )
    .await?;
    execute_dynamic(
        connection,
        format!(
            r#"CREATE TABLE IF NOT EXISTS {quoted_schema}."schema_migrations" (
                version bigint PRIMARY KEY CHECK (version > 0),
                name text NOT NULL,
                checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{{64}}$'),
                applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
            )"#
        ),
        "create-ledger",
    )
    .await?;

    let ledger = load_ledger(connection, &quoted_schema).await?;
    if let Some(version) = ledger
        .keys()
        .copied()
        .find(|version| *version > INITIAL_SCHEMA_VERSION)
    {
        return Err(MigrationError::SchemaVersionAhead { version });
    }

    let checksum = migration_checksum(&INITIAL_SCHEMA);
    let mut applied_versions = Vec::new();
    match ledger.get(&INITIAL_SCHEMA.version) {
        Some(record) if record.name != INITIAL_SCHEMA.name || record.checksum != checksum => {
            return Err(MigrationError::LedgerConflict {
                version: INITIAL_SCHEMA.version,
            });
        }
        Some(_) => {}
        None => {
            apply_migration(
                connection,
                ApplyMigrationInput {
                    quoted_schema: &quoted_schema,
                    migration: &INITIAL_SCHEMA,
                    checksum: &checksum,
                },
            )
            .await?;
            applied_versions.push(INITIAL_SCHEMA.version);
        }
    }

    Ok(MigrationReport {
        applied_versions,
        current_version: INITIAL_SCHEMA_VERSION,
    })
}

async fn load_ledger(
    connection: &mut PgConnection,
    quoted_schema: &str,
) -> Result<BTreeMap<i64, LedgerRecord>, MigrationError> {
    let sql = format!(
        r#"SELECT version, name, checksum FROM {quoted_schema}."schema_migrations" ORDER BY version"#
    );
    let rows = query(AssertSqlSafe(sql))
        .fetch_all(connection)
        .await
        .map_err(|_| MigrationError::DatabaseOperation {
            operation: "read-ledger",
        })?;
    let mut ledger = BTreeMap::new();
    for row in rows {
        let version = row
            .try_get::<i64, _>(0)
            .map_err(|_| MigrationError::DatabaseOperation {
                operation: "decode-ledger",
            })?;
        let name = row
            .try_get::<String, _>(1)
            .map_err(|_| MigrationError::DatabaseOperation {
                operation: "decode-ledger",
            })?;
        let checksum =
            row.try_get::<String, _>(2)
                .map_err(|_| MigrationError::DatabaseOperation {
                    operation: "decode-ledger",
                })?;
        ledger.insert(version, LedgerRecord { name, checksum });
    }
    Ok(ledger)
}

async fn apply_migration(
    connection: &mut PgConnection,
    input: ApplyMigrationInput<'_>,
) -> Result<(), MigrationError> {
    for template in input.migration.statements {
        execute_dynamic(
            connection,
            template.replace("{schema}", input.quoted_schema),
            "apply-version",
        )
        .await?;
    }
    let sql = format!(
        r#"INSERT INTO {schema}."schema_migrations" (version, name, checksum)
            VALUES ($1, $2, $3)"#,
        schema = input.quoted_schema,
    );
    query(AssertSqlSafe(sql))
        .bind(input.migration.version)
        .bind(input.migration.name)
        .bind(input.checksum)
        .execute(connection)
        .await
        .map_err(|_| MigrationError::DatabaseOperation {
            operation: "record-version",
        })?;
    Ok(())
}

async fn execute_dynamic(
    connection: &mut PgConnection,
    sql: String,
    operation: &'static str,
) -> Result<(), MigrationError> {
    // The only dynamic fragment comes from DatabaseSchema, which rejects every
    // byte outside [A-Za-z0-9_] and is quoted by quoted_schema(). Migration
    // templates are compile-time constants.
    query(AssertSqlSafe(sql))
        .execute(connection)
        .await
        .map_err(|_| MigrationError::DatabaseOperation { operation })?;
    Ok(())
}

fn migration_checksum(migration: &Migration) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&migration.version.to_be_bytes());
    hasher.update(migration.name.as_bytes());
    for statement in migration.statements {
        hasher.update(&[0]);
        hasher.update(statement.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_checksum_changes_with_schema_contract_content() {
        let changed = Migration {
            version: INITIAL_SCHEMA.version,
            name: INITIAL_SCHEMA.name,
            statements: &["CREATE TABLE {schema}.changed (id bigint PRIMARY KEY)"],
        };

        assert_ne!(
            migration_checksum(&INITIAL_SCHEMA),
            migration_checksum(&changed)
        );
        assert_eq!(migration_checksum(&INITIAL_SCHEMA).len(), 64);
    }
}
