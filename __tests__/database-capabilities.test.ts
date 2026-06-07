import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  databaseConfigFromOptionInput,
  postgresConnectionSummary,
  postgresServerMajor,
  postgresServerVersionInfoFromRow,
  postgresSqlOptions,
  postgresUnsupportedVersionMessage,
  POSTGRES_MIN_SERVER_VERSION_NUM,
  assertPostgresServerVersionSupported,
  parsePostgresServerVersionNum,
  readPostgresServerVersionInfo,
  resolveDatabaseConfig,
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
  it('normalizes database CLI options and rejects invalid combinations', () => {
    expect(databaseConfigFromOptionInput({})).toBeUndefined();
    expect(
      databaseConfigFromOptionInput({
        databaseUrl: 'postgres://localhost/cartograph',
        databaseSchema: 'cartograph',
        databasePgvector: 'require',
        databaseMaxConnections: '2',
        databaseIdleTimeoutSeconds: '0',
        databaseMaxLifetimeSeconds: 60,
        databaseConnectionTimeoutSeconds: '4',
        databaseQueryTimeoutMs: '5000',
        databaseSsl: 'yes',
      }),
    ).toEqual({
      provider: 'postgres',
      url: 'postgres://localhost/cartograph',
      schema: 'cartograph',
      pgvector: 'require',
      maxConnections: 2,
      idleTimeoutSeconds: 0,
      maxLifetimeSeconds: 60,
      connectionTimeoutSeconds: 4,
      queryTimeoutMs: 5000,
      ssl: true,
    });

    expect(() =>
      databaseConfigFromOptionInput({
        databaseProvider: 'sqlite',
        databaseUrl: 'postgres://localhost/cartograph',
      }),
    ).toThrow('PostgreSQL database options are only valid');
    expect(() => databaseConfigFromOptionInput({ databaseProvider: 'mysql' })).toThrow(
      'Database provider must be `sqlite` or `postgres`.',
    );
    expect(() => databaseConfigFromOptionInput({ databaseMaxConnections: 0 })).toThrow(
      '`databaseMaxConnections` must be a positive integer.',
    );
    expect(() => databaseConfigFromOptionInput({ databaseIdleTimeoutSeconds: -1 })).toThrow(
      '`databaseIdleTimeoutSeconds` must be a non-negative integer.',
    );
    expect(() => databaseConfigFromOptionInput({ databaseSsl: 'sometimes' })).toThrow(
      '`databaseSsl` must be a boolean.',
    );
  });

  it('resolves PostgreSQL config from environment defaults and config overrides', () => {
    const previousProvider = process.env['CARTOGRAPH_DATABASE_PROVIDER'];
    const previousUrl = process.env['CARTOGRAPH_DATABASE_URL'];
    const previousSchema = process.env['CARTOGRAPH_DATABASE_SCHEMA'];
    const previousPgvector = process.env['CARTOGRAPH_DATABASE_PGVECTOR'];
    const previousMaxConnections = process.env['CARTOGRAPH_DATABASE_MAX_CONNECTIONS'];
    const previousIdle = process.env['CARTOGRAPH_DATABASE_IDLE_TIMEOUT_SECONDS'];
    const previousLifetime = process.env['CARTOGRAPH_DATABASE_MAX_LIFETIME_SECONDS'];
    const previousConnectTimeout = process.env['CARTOGRAPH_DATABASE_CONNECTION_TIMEOUT_SECONDS'];
    const previousQueryTimeout = process.env['CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS'];
    const previousSsl = process.env['CARTOGRAPH_DATABASE_SSL'];
    try {
      process.env['CARTOGRAPH_DATABASE_PROVIDER'] = 'postgresql';
      process.env['CARTOGRAPH_DATABASE_URL'] = 'postgres://env/cartograph';
      process.env['CARTOGRAPH_DATABASE_SCHEMA'] = 'env_schema';
      process.env['CARTOGRAPH_DATABASE_PGVECTOR'] = 'off';
      process.env['CARTOGRAPH_DATABASE_MAX_CONNECTIONS'] = '3';
      process.env['CARTOGRAPH_DATABASE_IDLE_TIMEOUT_SECONDS'] = '7';
      process.env['CARTOGRAPH_DATABASE_MAX_LIFETIME_SECONDS'] = '11';
      process.env['CARTOGRAPH_DATABASE_CONNECTION_TIMEOUT_SECONDS'] = '13';
      process.env['CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS'] = '17000';
      process.env['CARTOGRAPH_DATABASE_SSL'] = 'no';

      expect(resolveDatabaseConfig()).toEqual({
        provider: 'postgres',
        url: 'postgres://env/cartograph',
        schema: 'env_schema',
        pgvector: 'off',
        maxConnections: 3,
        idleTimeoutSeconds: 7,
        maxLifetimeSeconds: 11,
        connectionTimeoutSeconds: 13,
        queryTimeoutMs: 17000,
        ssl: false,
      });
      expect(
        resolveDatabaseConfig({
          provider: 'postgres',
          url: 'postgres://config/cartograph',
          schema: 'config_schema',
          pgvector: 'auto',
          ssl: true,
        }),
      ).toMatchObject({
        url: 'postgres://config/cartograph',
        schema: 'config_schema',
        pgvector: 'auto',
        ssl: true,
      });
    } finally {
      restoreEnv('CARTOGRAPH_DATABASE_PROVIDER', previousProvider);
      restoreEnv('CARTOGRAPH_DATABASE_URL', previousUrl);
      restoreEnv('CARTOGRAPH_DATABASE_SCHEMA', previousSchema);
      restoreEnv('CARTOGRAPH_DATABASE_PGVECTOR', previousPgvector);
      restoreEnv('CARTOGRAPH_DATABASE_MAX_CONNECTIONS', previousMaxConnections);
      restoreEnv('CARTOGRAPH_DATABASE_IDLE_TIMEOUT_SECONDS', previousIdle);
      restoreEnv('CARTOGRAPH_DATABASE_MAX_LIFETIME_SECONDS', previousLifetime);
      restoreEnv('CARTOGRAPH_DATABASE_CONNECTION_TIMEOUT_SECONDS', previousConnectTimeout);
      restoreEnv('CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS', previousQueryTimeout);
      restoreEnv('CARTOGRAPH_DATABASE_SSL', previousSsl);
    }
  });

  it('builds PostgreSQL SQL options and diagnostics from database config', () => {
    const database = {
      provider: 'postgres' as const,
      url: 'postgres://localhost/cartograph',
      schema: 'cartograph',
      maxConnections: 5,
      idleTimeoutSeconds: 8,
      maxLifetimeSeconds: 30,
      connectionTimeoutSeconds: 12,
      queryTimeoutMs: 4000,
      ssl: true,
      pgvector: 'require' as const,
    };

    expect(postgresSqlOptions(database)).toMatchObject({
      url: database.url,
      adapter: 'postgres',
      max: 5,
      idleTimeout: 8,
      maxLifetime: 30,
      connectionTimeout: 12,
      tls: true,
      connection: { application_name: 'cartograph', statement_timeout: 4000 },
    });
    expect(postgresConnectionSummary(database)).toContain('pool max 5');
    expect(postgresConnectionSummary({ ...database, ssl: false, pgvector: 'off' })).toContain(
      'SSL disabled, pgvector off',
    );
  });

  it('parses and enforces the PostgreSQL 18 server-version floor', () => {
    expect(parsePostgresServerVersionNum('180000')).toBe(POSTGRES_MIN_SERVER_VERSION_NUM);
    expect(parsePostgresServerVersionNum(180002)).toBe(180002);
    expect(parsePostgresServerVersionNum('not-a-version')).toBeNull();
    expect(postgresServerMajor(180002)).toBe(18);
    expect(postgresServerMajor(null)).toBeNull();
    expect(
      postgresUnsupportedVersionMessage({
        version: '',
        versionNum: null,
      }),
    ).toContain('unknown server version');

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

  it('reads PostgreSQL server-version rows through the database adapter shape', () => {
    const row = {
      server_version_num: '180005',
      version: '18.5',
      io_method: 'worker',
    };
    expect(postgresServerVersionInfoFromRow(row)).toEqual({
      version: '18.5',
      versionNum: 180005,
      ioMethod: 'worker',
    });
    expect(
      readPostgresServerVersionInfo({
        prepare: () => ({
          get: () => row,
        }),
      } as never),
    ).toEqual({
      version: '18.5',
      versionNum: 180005,
      ioMethod: 'worker',
    });
    expect(postgresServerVersionInfoFromRow({ server_version_num: 'bad', io_method: '' })).toEqual({
      version: '',
      versionNum: null,
      ioMethod: null,
    });
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
