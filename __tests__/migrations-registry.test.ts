/**
 * Migration registry: structural invariants.
 *
 * Guards against the silent-no-op bug class that motivated this
 * refactor. If a future PR introduces a duplicate version,
 * out-of-order versions, or fails to register a new migration
 * file, one of these tests fails loudly.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_MIGRATIONS, CURRENT_SCHEMA_VERSION } from '../src/db/migrations.js';

describe('migration registry — structural invariants', () => {
  it('registry is non-empty', () => {
    expect(ALL_MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('versions are unique', () => {
    const seen = new Set<number>();
    for (const m of ALL_MIGRATIONS) {
      expect(seen.has(m.version)).toBe(false);
      seen.add(m.version);
    }
  });

  it('versions are strictly ascending', () => {
    for (let i = 1; i < ALL_MIGRATIONS.length; i++) {
      expect(ALL_MIGRATIONS[i]!.version).toBeGreaterThan(ALL_MIGRATIONS[i - 1]!.version);
    }
  });

  it('each migration has a non-empty description and a function up()', () => {
    for (const m of ALL_MIGRATIONS) {
      expect(m.description.length).toBeGreaterThan(0);
      expect(typeof m.up).toBe('function');
    }
  });

  it('CURRENT_SCHEMA_VERSION matches the highest registered version', () => {
    const max = ALL_MIGRATIONS.at(-1)!.version;
    expect(CURRENT_SCHEMA_VERSION).toBe(max);
  });

  it('requiresFkDisable defaults to false and propagates from the module', () => {
    // Every entry resolves the optional flag to a concrete boolean — no
    // `undefined` leaks past validation, so the runner can read it
    // without a defensive `??` on the read side.
    for (const m of ALL_MIGRATIONS) {
      expect(typeof m.requiresFkDisable).toBe('boolean');
    }
    // The decoupling migration is the canonical case: it does a
    // table-rebuild swap of `symbol_embeddings`, which only runs cleanly
    // with FKs disabled outside the transaction.
    const m033 = ALL_MIGRATIONS.find((m) => m.version === 33);
    expect(m033?.requiresFkDisable).toBe(true);
  });
});

describe('migration files — filename ↔ version coupling', () => {
  // Read the actual filenames on disk and assert each matches an
  // entry in the registry. Catches the case where someone drops a
  // new file in src/db/migrations/ but forgets to register it.
  const migrationsDir = path.resolve(__dirname, '../src/db/migrations');
  const SUPPORT_FILES = new Set(['index.ts', 'types.ts']);
  const STRICT_NNN_PATTERN = /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/;

  function listMigrationFiles(): string[] {
    return fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.ts') && !SUPPORT_FILES.has(f));
  }

  it('every migration file matches the strict `NNN-kebab-name.ts` pattern', () => {
    const offenders: string[] = [];
    for (const f of listMigrationFiles()) {
      if (!STRICT_NNN_PATTERN.test(f)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every src/db/migrations/NNN-*.ts file is registered (no orphan files)', () => {
    const files = listMigrationFiles().filter((f) => STRICT_NNN_PATTERN.test(f));
    expect(files.length).toBeGreaterThan(0);
    const registeredVersions = new Set(ALL_MIGRATIONS.map((m) => m.version));
    for (const f of files) {
      const version = parseInt(f.slice(0, 3), 10);
      if (!registeredVersions.has(version)) {
        throw new Error(
          `Migration file ${f} exists on disk but is not registered in src/db/migrations/index.ts. ` +
            `Add an import + array entry for it.`,
        );
      }
    }
  });

  it('every registered version has a matching NNN-*.ts file (no phantom registrations)', () => {
    const files = listMigrationFiles().filter((f) => STRICT_NNN_PATTERN.test(f));
    const filenameVersions = new Set(files.map((f) => parseInt(f.slice(0, 3), 10)));
    for (const m of ALL_MIGRATIONS) {
      expect(filenameVersions.has(m.version)).toBe(true);
    }
  });
});
