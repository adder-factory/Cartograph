import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  REBIND_ENV,
  canonicalProjectRoot,
  derivePostgresSchema,
  enforceProjectRootOwnership,
  withDerivedPostgresSchema,
} from '../src/db/project-ownership.js';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import type { DatabaseConfig } from '../src/db/database-config.js';

// PostgreSQL truncates identifiers at 63 bytes; a derived name that
// exceeds it would be SILENTLY truncated server-side and two long
// project names could collide post-truncation.
const PG_IDENTIFIER_MAX = 63;

describe('derivePostgresSchema — shared-instance separation without configuration', () => {
  it('is deterministic and unquoted-identifier safe', () => {
    const root = '/Users/dev/projects/my-api';
    const a = derivePostgresSchema(root);
    expect(a).toBe(derivePostgresSchema(root));
    expect(a).toMatch(/^cartograph_[a-z0-9_]+_[0-9a-f]{8}$/);
    expect(a.length).toBeLessThanOrEqual(PG_IDENTIFIER_MAX);
  });

  it('separates same-basename projects in different parents', () => {
    // The footgun the hash exists for: ~/work/api and ~/personal/api
    // would collide on a slug-only name.
    expect(derivePostgresSchema('/home/u/work/api')).not.toBe(derivePostgresSchema('/home/u/personal/api'));
  });

  it('sanitizes hostile basenames and stays within the identifier budget', () => {
    const schema = derivePostgresSchema('/tmp/My Project... (v2) — final-FINAL');
    expect(schema).toMatch(/^cartograph_[a-z0-9_]+_[0-9a-f]{8}$/);
    expect(schema.length).toBeLessThanOrEqual(PG_IDENTIFIER_MAX);
    // A basename with NO usable characters still produces a name.
    expect(derivePostgresSchema('/tmp/---')).toMatch(/^cartograph_project_[0-9a-f]{8}$/);
  });

  it('canonicalizes symlinked roots so aliases derive the same schema', () => {
    // macOS: /tmp is a symlink to /private/tmp — both spellings must
    // land on one schema or the "same project" would split in two.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sep-'));
    try {
      const viaTmp = path.join(os.tmpdir(), path.basename(real));
      expect(derivePostgresSchema(viaTmp)).toBe(derivePostgresSchema(canonicalProjectRoot(real)));
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('withDerivedPostgresSchema', () => {
  it('fills only the postgres-without-schema case', () => {
    const pg: DatabaseConfig = { provider: 'postgres', url: 'postgres://x' };
    expect(withDerivedPostgresSchema(pg, '/p/alpha').schema).toMatch(/^cartograph_alpha_/);

    const explicit: DatabaseConfig = { provider: 'postgres', url: 'postgres://x', schema: 'mine' };
    expect(withDerivedPostgresSchema(explicit, '/p/alpha').schema).toBe('mine');

    const sqlite: DatabaseConfig = { provider: 'sqlite' };
    expect(withDerivedPostgresSchema(sqlite, '/p/alpha').schema).toBeUndefined();
  });
});

describe('enforceProjectRootOwnership — one schema = one project, enforced', () => {
  let db: SqliteDatabase;
  let rootA: string;
  let rootB: string;
  let savedRebind: string | undefined;

  const dbPathFor = (root: string) => path.join(root, '.cartograph', 'cartograph.db');
  const stamped = () =>
    (db.prepare(`SELECT value FROM project_metadata WHERE key = 'project_root'`).get() as { value: string } | null)
      ?.value;

  beforeEach(() => {
    db = createDatabase(':memory:').db;
    db.exec(`CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL)`);
    rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-own-a-'));
    rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-own-b-'));
    savedRebind = process.env[REBIND_ENV];
    delete process.env[REBIND_ENV];
  });

  afterEach(() => {
    db.close();
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
    if (savedRebind === undefined) delete process.env[REBIND_ENV];
    else process.env[REBIND_ENV] = savedRebind;
  });

  it('stamps on first open, passes on every matching open', () => {
    enforceProjectRootOwnership(db, dbPathFor(rootA), 'cartograph_a_12345678');
    expect(stamped()).toBe(canonicalProjectRoot(rootA));
    // Second open from the same root: no throw, stamp unchanged.
    enforceProjectRootOwnership(db, dbPathFor(rootA), 'cartograph_a_12345678');
    expect(stamped()).toBe(canonicalProjectRoot(rootA));
  });

  it('fails loudly when a second project opens the same schema', () => {
    enforceProjectRootOwnership(db, dbPathFor(rootA), 'shared_schema');
    let message = '';
    try {
      enforceProjectRootOwnership(db, dbPathFor(rootB), 'shared_schema');
    } catch (err) {
      message = (err as Error).message;
    }
    // The error must carry everything needed to act on it: the schema,
    // both roots, and both remediations.
    expect(message).toContain('shared_schema');
    expect(message).toContain(canonicalProjectRoot(rootA));
    expect(message).toContain(canonicalProjectRoot(rootB));
    expect(message).toContain(REBIND_ENV);
    expect(message).toContain('--database-schema');
    // And the stamp is untouched — a failed open must not steal ownership.
    expect(stamped()).toBe(canonicalProjectRoot(rootA));
  });

  it('re-binds on mismatch when the override env is set (moved project)', () => {
    enforceProjectRootOwnership(db, dbPathFor(rootA), 's');
    process.env[REBIND_ENV] = '1';
    enforceProjectRootOwnership(db, dbPathFor(rootB), 's');
    expect(stamped()).toBe(canonicalProjectRoot(rootB));
  });
});
