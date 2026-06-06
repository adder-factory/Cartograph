export interface MigrationOutcome {
  migratedThisRun: boolean;
  version?: number | string | null;
}

export function schemaVersionLabel(version: MigrationOutcome['version']): string {
  return version === undefined || version === null ? '?' : String(version);
}

export function migrationSuccessMessage(outcome: MigrationOutcome): string {
  const version = schemaVersionLabel(outcome.version);
  return outcome.migratedThisRun
    ? `Schema migrated to v${version}.`
    : `Schema already current (v${version}). Nothing to migrate.`;
}
