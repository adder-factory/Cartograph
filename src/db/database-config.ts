import type { CartographConfig } from '../types.js';

export type DatabaseProvider = 'sqlite' | 'postgres';
export type PgvectorMode = 'auto' | 'off' | 'require';

export interface DatabaseConfig {
  provider: DatabaseProvider;
  url?: string;
  schema?: string;
  pgvector?: PgvectorMode;
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  maxLifetimeSeconds?: number;
  connectionTimeoutSeconds?: number;
  queryTimeoutMs?: number;
  ssl?: boolean;
}

export interface DatabaseOptionInput {
  databaseProvider?: unknown;
  databaseUrl?: unknown;
  databaseSchema?: unknown;
  databasePgvector?: unknown;
  databaseMaxConnections?: unknown;
  databaseIdleTimeoutSeconds?: unknown;
  databaseMaxLifetimeSeconds?: unknown;
  databaseConnectionTimeoutSeconds?: unknown;
  databaseQueryTimeoutMs?: unknown;
  databaseSsl?: unknown;
}

export const POSTGRES_DEFAULT_MAX_CONNECTIONS = 1;
export const POSTGRES_DEFAULT_CONNECTION_TIMEOUT_SECONDS = 30;
export const POSTGRES_DEFAULT_QUERY_TIMEOUT_MS = 120_000;

export function resolveDatabaseConfig(config?: CartographConfig['database']): DatabaseConfig {
  const envProvider = process.env['CARTOGRAPH_DATABASE_PROVIDER'];
  const provider = normalizeProvider(config?.provider ?? envProvider);
  const url = config?.url ?? process.env['CARTOGRAPH_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  const schema = config?.schema ?? process.env['CARTOGRAPH_DATABASE_SCHEMA'];
  const pgvector = parseOptionalPgvectorMode(
    config?.pgvector ?? process.env['CARTOGRAPH_DATABASE_PGVECTOR'],
    'database.pgvector',
  );
  const maxConnections = parseOptionalPositiveInteger(
    config?.maxConnections ?? process.env['CARTOGRAPH_DATABASE_MAX_CONNECTIONS'],
    'database.maxConnections',
  );
  const idleTimeoutSeconds = parseOptionalNonNegativeInteger(
    config?.idleTimeoutSeconds ?? process.env['CARTOGRAPH_DATABASE_IDLE_TIMEOUT_SECONDS'],
    'database.idleTimeoutSeconds',
  );
  const maxLifetimeSeconds = parseOptionalNonNegativeInteger(
    config?.maxLifetimeSeconds ?? process.env['CARTOGRAPH_DATABASE_MAX_LIFETIME_SECONDS'],
    'database.maxLifetimeSeconds',
  );
  const connectionTimeoutSeconds = parseOptionalPositiveInteger(
    config?.connectionTimeoutSeconds ?? process.env['CARTOGRAPH_DATABASE_CONNECTION_TIMEOUT_SECONDS'],
    'database.connectionTimeoutSeconds',
  );
  const queryTimeoutMs = parseOptionalPositiveInteger(
    config?.queryTimeoutMs ?? process.env['CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS'],
    'database.queryTimeoutMs',
  );
  const ssl = parseOptionalBoolean(config?.ssl ?? process.env['CARTOGRAPH_DATABASE_SSL'], 'database.ssl');
  if (provider === 'postgres' && !url) {
    throw new Error(
      'PostgreSQL database provider requires `database.url` in .cartograph/config.json, CARTOGRAPH_DATABASE_URL, or DATABASE_URL.',
    );
  }
  if (provider === 'sqlite') return { provider };
  const database: DatabaseConfig = {
    provider,
    url: url!,
    pgvector: pgvector ?? 'auto',
    maxConnections: maxConnections ?? POSTGRES_DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutSeconds: connectionTimeoutSeconds ?? POSTGRES_DEFAULT_CONNECTION_TIMEOUT_SECONDS,
    queryTimeoutMs: queryTimeoutMs ?? POSTGRES_DEFAULT_QUERY_TIMEOUT_MS,
  };
  if (schema) database.schema = schema;
  assignDefined(database, 'idleTimeoutSeconds', idleTimeoutSeconds);
  assignDefined(database, 'maxLifetimeSeconds', maxLifetimeSeconds);
  assignDefined(database, 'ssl', ssl);
  return database;
}

export function databaseConfigFromOptionInput(input: DatabaseOptionInput): CartographConfig['database'] | undefined {
  const provider = input.databaseProvider === undefined ? undefined : parseDatabaseProvider(input.databaseProvider);
  const url = parseOptionalString(input.databaseUrl, 'databaseUrl');
  const schema = parseOptionalString(input.databaseSchema, 'databaseSchema');
  const pgvector = parseOptionalPgvectorMode(input.databasePgvector, 'databasePgvector');
  const maxConnections = parseOptionalPositiveInteger(input.databaseMaxConnections, 'databaseMaxConnections');
  const idleTimeoutSeconds = parseOptionalNonNegativeInteger(
    input.databaseIdleTimeoutSeconds,
    'databaseIdleTimeoutSeconds',
  );
  const maxLifetimeSeconds = parseOptionalNonNegativeInteger(
    input.databaseMaxLifetimeSeconds,
    'databaseMaxLifetimeSeconds',
  );
  const connectionTimeoutSeconds = parseOptionalPositiveInteger(
    input.databaseConnectionTimeoutSeconds,
    'databaseConnectionTimeoutSeconds',
  );
  const queryTimeoutMs = parseOptionalPositiveInteger(input.databaseQueryTimeoutMs, 'databaseQueryTimeoutMs');
  const ssl = parseOptionalBoolean(input.databaseSsl, 'databaseSsl');
  const hasPostgresOnlyOption =
    url !== undefined ||
    schema !== undefined ||
    pgvector !== undefined ||
    maxConnections !== undefined ||
    idleTimeoutSeconds !== undefined ||
    maxLifetimeSeconds !== undefined ||
    connectionTimeoutSeconds !== undefined ||
    queryTimeoutMs !== undefined ||
    ssl !== undefined;
  if (provider === undefined && !hasPostgresOnlyOption) return undefined;
  if (hasPostgresOnlyOption && provider === 'sqlite') {
    throw new Error('PostgreSQL database options are only valid with `databaseProvider: "postgres"`.');
  }
  const resolvedProvider = provider ?? (hasPostgresOnlyOption ? 'postgres' : 'sqlite');
  const database: CartographConfig['database'] = {
    provider: resolvedProvider,
  };
  assignDefined(database, 'url', url);
  assignDefined(database, 'schema', schema);
  assignDefined(database, 'pgvector', pgvector);
  assignDefined(database, 'maxConnections', maxConnections);
  assignDefined(database, 'idleTimeoutSeconds', idleTimeoutSeconds);
  assignDefined(database, 'maxLifetimeSeconds', maxLifetimeSeconds);
  assignDefined(database, 'connectionTimeoutSeconds', connectionTimeoutSeconds);
  assignDefined(database, 'queryTimeoutMs', queryTimeoutMs);
  assignDefined(database, 'ssl', ssl);
  return database;
}

export function postgresSqlOptions(database: DatabaseConfig): Bun.SQL.Options {
  const connection: Record<string, string | boolean | number> = { application_name: 'cartograph' };
  if (database.queryTimeoutMs !== undefined) connection['statement_timeout'] = database.queryTimeoutMs;
  const options: Bun.SQL.Options = {
    url: database.url!,
    adapter: 'postgres',
    max: database.maxConnections ?? POSTGRES_DEFAULT_MAX_CONNECTIONS,
    connectionTimeout: database.connectionTimeoutSeconds ?? POSTGRES_DEFAULT_CONNECTION_TIMEOUT_SECONDS,
    connection,
  };
  assignDefined(options, 'idleTimeout', database.idleTimeoutSeconds);
  assignDefined(options, 'maxLifetime', database.maxLifetimeSeconds);
  assignDefined(options, 'tls', database.ssl);
  return options;
}

export function postgresConnectionSummary(database: DatabaseConfig): string {
  const maxConnections = database.maxConnections ?? POSTGRES_DEFAULT_MAX_CONNECTIONS;
  const connectionTimeout = database.connectionTimeoutSeconds ?? POSTGRES_DEFAULT_CONNECTION_TIMEOUT_SECONDS;
  const queryTimeout = database.queryTimeoutMs ?? POSTGRES_DEFAULT_QUERY_TIMEOUT_MS;
  let ssl = 'url/default';
  if (database.ssl === true) ssl = 'enabled';
  if (database.ssl === false) ssl = 'disabled';
  const pgvector = database.pgvector ?? 'auto';
  return `pool max ${maxConnections}, connect timeout ${connectionTimeout}s, query timeout ${queryTimeout}ms, SSL ${ssl}, pgvector ${pgvector}`;
}

export function parseDatabaseProvider(value: unknown): DatabaseProvider {
  if (value === 'sqlite') return 'sqlite';
  if (value === 'postgres' || value === 'postgresql') return 'postgres';
  throw new Error('Database provider must be `sqlite` or `postgres`.');
}

function parseOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`\`${name}\` must be a string.`);
  return value;
}

function parseOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  const parsed = parseOptionalInteger(value, name);
  if (parsed === undefined) return undefined;
  if (parsed < 1) throw new Error(`\`${name}\` must be a positive integer.`);
  return parsed;
}

function parseOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  const parsed = parseOptionalInteger(value, name);
  if (parsed === undefined) return undefined;
  if (parsed < 0) throw new Error(`\`${name}\` must be a non-negative integer.`);
  return parsed;
}

function parseOptionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let parsed = Number.NaN;
  if (typeof value === 'number') parsed = value;
  if (typeof value === 'string') parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`\`${name}\` must be an integer.`);
  return parsed;
}

function parseOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  throw new Error(`\`${name}\` must be a boolean.`);
}

function parseOptionalPgvectorMode(value: unknown, name: string): PgvectorMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'auto' || value === 'off' || value === 'require') return value;
  throw new Error(`\`${name}\` must be \`auto\`, \`off\`, or \`require\`.`);
}

function assignDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) return;
  target[key] = value;
}

function normalizeProvider(value: unknown): DatabaseProvider {
  if (value === undefined || value === null || value === '') return 'sqlite';
  if (value === 'postgres' || value === 'postgresql') return 'postgres';
  if (value === 'sqlite') return 'sqlite';
  throw new Error('Database provider must be `sqlite` or `postgres`.');
}
