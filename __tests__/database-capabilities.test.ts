import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  POSTGRES_MIN_SERVER_VERSION_NUM,
  assertPostgresServerVersionSupported,
  parsePostgresServerVersionNum,
} from '../src/db/database-config.js';
import {
  SQLITE_MIN_VERSION,
  compareSqliteVersions,
  createDatabase,
  readSqliteRuntimeCapabilities,
} from '../src/db/sqlite-adapter.js';

let currentDir: string | undefined;

afterEach(() => {
  if (currentDir && fs.existsSync(currentDir)) fs.rmSync(currentDir, { recursive: true, force: true });
  currentDir = undefined;
});

describe('database runtime capability gates', () => {
  it('parses and enforces the PostgreSQL 18 server-version floor', () => {
    expect(parsePostgresServerVersionNum('180000')).toBe(POSTGRES_MIN_SERVER_VERSION_NUM);
    expect(parsePostgresServerVersionNum(180002)).toBe(180002);
    expect(parsePostgresServerVersionNum('not-a-version')).toBeNull();

    expect(() =>
      assertPostgresServerVersionSupported({
        version: '17.6',
        versionNum: 170006,
        ioMethod: null,
      }),
    ).toThrow('requires PostgreSQL 18 or newer');

    expect(() =>
      assertPostgresServerVersionSupported({
        version: '18.1',
        versionNum: 180001,
        ioMethod: 'worker',
      }),
    ).not.toThrow();
  });

  it('verifies the bundled SQLite features Cartograph depends on', () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-sqlite-capabilities-'));
    const opened = createDatabase(path.join(currentDir, 'cartograph.db'));
    try {
      const capabilities = readSqliteRuntimeCapabilities(opened.db);
      expect(compareSqliteVersions(capabilities.version, SQLITE_MIN_VERSION)).toBeGreaterThanOrEqual(0);
      expect(capabilities.strictTables).toBe(true);
      expect(capabilities.fts5).toBe(true);
      expect(capabilities.rtree).toBe(true);
      expect(capabilities.json).toBe(true);
    } finally {
      opened.db.close();
    }
  });
});
