import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { getOutgoingEdges, insertEdges } from '../src/db/queries-edges.js';
import { upsertFile } from '../src/db/queries-files.js';
import { applyIssueAttributions, getSymbolCoChanges } from '../src/db/queries-history.js';
import { getNodesAtRange } from '../src/db/queries-rtree.js';
import { findSignatureTokenOwner, searchNodes } from '../src/db/queries-search.js';
import { upsertSymbolEmbedding } from '../src/db/queries-embeddings.js';
import { resolveDatabaseConfig } from '../src/db/database-config.js';
import { findSimilarViaPgvector, isPgvectorAvailable } from '../src/db/pgvector-helpers.js';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations.js';
import { buildSimilarToEdges } from '../src/embeddings/similar-edges.js';
import { isHnswAvailable } from '../src/embeddings/hnsw-index.js';
import { migrateSqliteProjectToPostgres } from '../src/features/admin-storage-migrate/runtime.js';
import { runDoctor } from '../src/installer/doctor.js';
import { vectorToBytes } from '../src/llm/embeddings.js';

const POSTGRES_URL = process.env['CARTOGRAPH_TEST_POSTGRES_URL'];
const PGVECTOR_URL = process.env['CARTOGRAPH_TEST_PGVECTOR_URL'];
const describePostgres = POSTGRES_URL ? describe : describe.skip;
const describePgvector = PGVECTOR_URL ? describe : describe.skip;
const VECTOR_FILE_SIZE = 200;
const VECTOR_NODE_COUNT = 3;
const VECTOR_LOC = 20;
const VECTOR_A_START = 1;
const VECTOR_B_START = 6;
const VECTOR_C_START = 12;
const VECTOR_LENGTH = 2;
const VECTOR_SIMILAR_X = 0.98;
const VECTOR_SIMILAR_Y = 0.02;
const VECTOR_BUILD_K = 1;
const VECTOR_MIN_SCORE = 0.5;
const VECTOR_MODEL = 'test-model';

let currentDir: string | undefined;
let currentSchema: string | undefined;
let currentConn: DatabaseConnection | undefined;
let currentPostgresUrl: string | undefined;

afterEach(async () => {
  currentConn?.close();
  currentConn = undefined;
  if (currentDir && fs.existsSync(currentDir)) fs.rmSync(currentDir, { recursive: true, force: true });
  currentDir = undefined;
  const cleanupUrl = currentPostgresUrl ?? POSTGRES_URL ?? PGVECTOR_URL;
  currentPostgresUrl = undefined;
  if (cleanupUrl && currentSchema) {
    const sql = new Bun.SQL(cleanupUrl);
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(currentSchema)} CASCADE`).simple();
    } finally {
      await sql.close();
      currentSchema = undefined;
    }
  }
});

describe('database provider selection', () => {
  it('keeps SQLite as an explicit database option', () => {
    expect(resolveDatabaseConfig({ provider: 'sqlite' }).provider).toBe('sqlite');
  });

  it('does not silently fall back when the provider is misspelled', () => {
    const previous = process.env['CARTOGRAPH_DATABASE_PROVIDER'];
    process.env['CARTOGRAPH_DATABASE_PROVIDER'] = 'postrge';
    try {
      expect(() => resolveDatabaseConfig()).toThrow('Database provider must be `sqlite` or `postgres`.');
    } finally {
      restoreEnv('CARTOGRAPH_DATABASE_PROVIDER', previous);
    }
  });

  it('resolves PostgreSQL connection tuning from config', () => {
    expect(
      resolveDatabaseConfig({
        provider: 'postgres',
        url: 'postgres://localhost/cartograph',
        schema: 'cartograph',
        pgvector: 'require',
        maxConnections: 2,
        connectionTimeoutSeconds: 4,
        queryTimeoutMs: 5_000,
        ssl: true,
      }),
    ).toMatchObject({
      provider: 'postgres',
      schema: 'cartograph',
      pgvector: 'require',
      maxConnections: 2,
      connectionTimeoutSeconds: 4,
      queryTimeoutMs: 5_000,
      ssl: true,
    });
  });

  it('resolves PostgreSQL pgvector mode from the environment', () => {
    const previous = process.env['CARTOGRAPH_DATABASE_PGVECTOR'];
    process.env['CARTOGRAPH_DATABASE_PGVECTOR'] = 'off';
    try {
      expect(resolveDatabaseConfig({ provider: 'postgres', url: 'postgres://localhost/cartograph' })).toMatchObject({
        provider: 'postgres',
        pgvector: 'off',
      });
    } finally {
      restoreEnv('CARTOGRAPH_DATABASE_PGVECTOR', previous);
    }
  });

  it('rejects invalid pgvector modes', () => {
    expect(() =>
      resolveDatabaseConfig({
        provider: 'postgres',
        url: 'postgres://localhost/cartograph',
        pgvector: 'always' as never,
      }),
    ).toThrow('`database.pgvector` must be `auto`, `off`, or `require`.');
  });
});

describePostgres('PostgreSQL database provider', () => {
  it('finishes initialization from a hand-authored PostgreSQL config', () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-partial-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const cartographDir = path.join(currentDir, '.cartograph');
    fs.mkdirSync(cartographDir, { recursive: true });
    fs.writeFileSync(
      path.join(cartographDir, 'config.json'),
      JSON.stringify({
        database: { provider: 'postgres', url: POSTGRES_URL!, schema: currentSchema },
      }),
    );

    expect(Cartograph.isInitialized(currentDir)).toBe(false);

    const cg = Cartograph.initSync(currentDir);

    expect(Cartograph.isInitialized(currentDir)).toBe(true);
    expect(cg.db.getBackend()).toBe('postgres');
    expect(cg.getConfig().database?.schema).toBe(currentSchema);

    cg.close();
  });

  it('migrates a SQLite-backed project to PostgreSQL storage', async () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-storage-migrate-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

    const sqliteCg = Cartograph.initSync(currentDir);
    upsertFile(sqliteCg.queries, {
      path: 'src/migrate.ts',
      contentHash: 'hash-migrate',
      language: 'typescript',
      size: 200,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 2,
      errors: [],
      commitCount: 0,
      loc: 20,
      firstSeenTs: null,
      lastTouchedTs: null,
      isTest: false,
      needsReextract: false,
    });
    sqliteCg.queries.insertNodes([
      {
        id: 'n:migrate-source',
        kind: 'function',
        name: 'source',
        qualifiedName: 'source',
        filePath: 'src/migrate.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 5,
        startColumn: 0,
        endColumn: 1,
        docstring: null,
        signature: 'function source()',
        visibility: 'public',
        isExported: true,
        isAsync: false,
        isStatic: false,
        decorators: [],
        decoratorArgs: null,
        updatedAt: Date.now(),
        centrality: null,
        betweenness: null,
        bodyHash: 'body-source',
      },
      {
        id: 'n:migrate-target',
        kind: 'function',
        name: 'target',
        qualifiedName: 'target',
        filePath: 'src/migrate.ts',
        language: 'typescript',
        startLine: 10,
        endLine: 15,
        startColumn: 0,
        endColumn: 1,
        docstring: null,
        signature: 'function target()',
        visibility: 'public',
        isExported: true,
        isAsync: false,
        isStatic: false,
        decorators: [],
        decoratorArgs: null,
        updatedAt: Date.now(),
        centrality: null,
        betweenness: null,
        bodyHash: 'body-target',
      },
    ]);
    insertEdges(sqliteCg.queries, [
      {
        source: 'n:migrate-source',
        target: 'n:migrate-target',
        kind: 'calls',
        metadata: { migrated: true },
        line: 3,
        column: 2,
        confidence: 'EXTRACTED',
      },
    ]);
    sqliteCg.close();

    const result = await migrateSqliteProjectToPostgres({
      projectPath: currentDir,
      database: { provider: 'postgres', url: POSTGRES_URL!, schema: currentSchema },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.summary.rowsCopied).toBeGreaterThanOrEqual(4);
    expect(fs.readFileSync(path.join(currentDir, '.cartograph', 'cartograph.db'), 'utf-8')).toContain(
      'postgres provider sentinel',
    );
    expect(fs.existsSync(result.summary.sqliteBackupPath)).toBe(true);

    const pgCg = Cartograph.openSync(currentDir);
    try {
      expect(pgCg.db.getBackend()).toBe('postgres');
      expect(pgCg.getConfig().database?.schema).toBe(currentSchema);
      expect(pgCg.queries.getNodeById('n:migrate-source')?.name).toBe('source');
      expect(getOutgoingEdges(pgCg.queries, 'n:migrate-source')[0]?.target).toBe('n:migrate-target');
    } finally {
      pgCg.close();
    }
  });

  it('initializes, writes, searches, range-queries, and reopens through PostgreSQL', () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const dbPath = path.join(currentDir, 'cartograph.db');
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };

    currentConn = DatabaseConnection.initialize(dbPath, { database });
    expect(currentConn.getBackend()).toBe('postgres');
    expect(currentConn.getDb().dialect).toBe('postgres');
    expect(currentConn.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);

    const qb = new QueryBuilder(currentConn.getDb(), currentConn.hasVecExtension());
    upsertFile(qb, {
      path: 'src/db/index.ts',
      contentHash: 'hash-1',
      language: 'typescript',
      size: 120,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 2,
      errors: [],
      commitCount: 0,
      loc: 10,
      firstSeenTs: null,
      lastTouchedTs: null,
      isTest: false,
      needsReextract: false,
    });
    qb.insertNodes([
      {
        id: 'n:database-connection',
        kind: 'class',
        name: 'DatabaseConnection',
        qualifiedName: 'DatabaseConnection',
        filePath: 'src/db/index.ts',
        language: 'typescript',
        startLine: 10,
        endLine: 40,
        startColumn: 0,
        endColumn: 1,
        docstring: null,
        signature: 'class DatabaseConnection',
        visibility: 'public',
        isExported: true,
        isAsync: false,
        isStatic: false,
        decorators: [],
        decoratorArgs: null,
        updatedAt: Date.now(),
        centrality: null,
        betweenness: null,
        bodyHash: 'body-hash',
      },
      {
        id: 'n:database-open',
        kind: 'method',
        name: 'open',
        qualifiedName: 'DatabaseConnection.open',
        filePath: 'src/db/index.ts',
        language: 'typescript',
        startLine: 20,
        endLine: 28,
        startColumn: 2,
        endColumn: 3,
        docstring: null,
        signature: 'static open()',
        visibility: 'public',
        isExported: true,
        isAsync: false,
        isStatic: true,
        decorators: [],
        decoratorArgs: null,
        updatedAt: Date.now(),
        centrality: null,
        betweenness: null,
        bodyHash: 'body-hash-open',
      },
    ]);
    expect(
      insertEdges(qb, [
        {
          source: 'n:database-connection',
          target: 'n:database-open',
          kind: 'calls',
          metadata: { reason: 'batch-smoke' },
          line: 21,
          column: 4,
          confidence: 'EXTRACTED',
        },
      ]),
    ).toHaveLength(1);

    expect(qb.getNodeById('n:database-connection')?.name).toBe('DatabaseConnection');
    expect(getOutgoingEdges(qb, 'n:database-connection')[0]?.target).toBe('n:database-open');
    const nodeColumns = currentConn.getDb().prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    expect(nodeColumns.map((col) => col.name)).toEqual(expect.arrayContaining(['id', 'name', 'file_path']));

    expect(
      searchNodes(qb, 'database', { kinds: ['class'], languages: ['typescript'], limit: 5 }).map((r) => r.node.name),
    ).toContain('DatabaseConnection');
    expect(findSignatureTokenOwner(qb, 'open')?.id).toBe('n:database-open');
    const indexes = currentConn
      .getDb()
      .prepare('SELECT indexname AS name FROM pg_indexes WHERE schemaname = @schema')
      .all({ schema: currentSchema }) as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(['idx_nodes_search_fts', 'idx_nodes_signature_fts']),
    );
    expect(
      getNodesAtRange(qb, { filePath: 'src/db/index.ts', startLine: 20, endLine: 21, limit: 5 }).map((n) => n.id),
    ).toContain('n:database-connection');

    currentConn.close();
    currentConn = DatabaseConnection.open(dbPath, { database });
    expect(currentConn.getBackend()).toBe('postgres');
    expect(currentConn.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('runs SQLite-compatible history and introspection queries through PostgreSQL', () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-history-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const dbPath = path.join(currentDir, 'cartograph.db');
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };

    currentConn = DatabaseConnection.initialize(dbPath, { database });
    const qb = new QueryBuilder(currentConn.getDb(), currentConn.hasVecExtension());
    upsertFile(qb, {
      path: 'src/db/history.ts',
      contentHash: 'hash-history',
      language: 'typescript',
      size: 120,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 2,
      errors: [],
      commitCount: 0,
      loc: 10,
      firstSeenTs: null,
      lastTouchedTs: null,
      isTest: false,
      needsReextract: false,
    });
    for (const [id, name, startLine] of [
      ['n:source', 'sourceSymbol', 1],
      ['n:partner', 'partnerSymbol', 10],
    ] as const) {
      qb.insertNode({
        id,
        kind: 'function',
        name,
        qualifiedName: name,
        filePath: 'src/db/history.ts',
        language: 'typescript',
        startLine,
        endLine: startLine + 4,
        startColumn: 0,
        endColumn: 1,
        docstring: null,
        signature: `function ${name}()`,
        visibility: 'public',
        isExported: true,
        isAsync: false,
        isStatic: false,
        decorators: [],
        decoratorArgs: null,
        updatedAt: Date.now(),
        centrality: null,
        betweenness: null,
        bodyHash: `body-${id}`,
      });
    }

    applyIssueAttributions(qb, [
      { nodeId: 'n:source', issueNumber: 1, commitSha: 'sha-a', kind: 'modified' },
      { nodeId: 'n:partner', issueNumber: 1, commitSha: 'sha-a', kind: 'modified' },
      { nodeId: 'n:source', issueNumber: 2, commitSha: 'sha-b', kind: 'modified' },
      { nodeId: 'n:partner', issueNumber: 2, commitSha: 'sha-b', kind: 'modified' },
    ]);

    const cochanges = getSymbolCoChanges(qb, 'n:source', { minCount: 2, limit: 5 });
    expect(cochanges).toHaveLength(1);
    expect(cochanges[0]).toMatchObject({ nodeId: 'n:partner', coOccurrences: 2 });
    expect(cochanges[0]?.sharedCommits.sort()).toEqual(['sha-a', 'sha-b']);

    const tableList = currentConn.getDb().prepare('PRAGMA table_list').all() as Array<{ name: string }>;
    expect(tableList.map((row) => row.name)).toContain('nodes');
  });

  it('reports PostgreSQL storage as reachable in doctor', async () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-doctor-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const cartographDir = path.join(currentDir, '.cartograph');
    fs.mkdirSync(cartographDir, { recursive: true });
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };
    fs.writeFileSync(path.join(cartographDir, 'config.json'), JSON.stringify({ database }, null, 2));

    currentConn = DatabaseConnection.initialize(path.join(cartographDir, 'cartograph.db'), { database });
    currentConn.close();
    currentConn = undefined;

    const result = await runDoctor({ projectPath: currentDir });
    const storage = result.checks.find((check) => check.id === 'database-storage');
    expect(storage).toMatchObject({
      name: 'Database storage',
      status: 'ok',
    });
    expect(storage?.detail).toContain(`schema "${currentSchema}"`);
    expect(storage?.detail).toContain('runtime writes ok');
    expect(storage?.detail).toContain('schema DDL ok');
    expect(storage?.detail).toContain('query timeout');
  });

  it('builds similar_to edges through HNSW on PostgreSQL when USearch is available', async () => {
    if (!(await isHnswAvailable())) return;
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-hnsw-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };
    const cg = Cartograph.initSync(currentDir, { config: { database } });
    currentConn = cg.db;
    seedEmbeddingGraph(cg);

    const result = await buildSimilarToEdges(cg, { k: VECTOR_BUILD_K, minScore: VECTOR_MIN_SCORE });

    expect(result.reason).toBeUndefined();
    expect(result.processed).toBe(3);
    expect(result.written).toBeGreaterThan(0);
    expect(getOutgoingEdges(cg.queries, 'n:vec-a').some((edge) => edge.kind === 'similar_to')).toBe(true);
  });
});

function seedEmbeddingGraph(cg: Cartograph): void {
  upsertFile(cg.queries, {
    path: 'src/vector.ts',
    contentHash: 'hash-vector',
    language: 'typescript',
    size: VECTOR_FILE_SIZE,
    modifiedAt: Date.now(),
    indexedAt: Date.now(),
    nodeCount: VECTOR_NODE_COUNT,
    errors: [],
    commitCount: 0,
    loc: VECTOR_LOC,
    firstSeenTs: null,
    lastTouchedTs: null,
    isTest: false,
    needsReextract: false,
  });
  const nodeSpecs = [
    ['n:vec-a', 'VectorA', 'body-vec-a', VECTOR_A_START],
    ['n:vec-b', 'VectorB', 'body-vec-b', VECTOR_B_START],
    ['n:vec-c', 'VectorC', 'body-vec-c', VECTOR_C_START],
  ] as const;
  cg.queries.insertNodes(
    nodeSpecs.map(([id, name, bodyHash, startLine]) => ({
      id,
      kind: 'function' as const,
      name,
      qualifiedName: name,
      filePath: 'src/vector.ts',
      language: 'typescript' as const,
      startLine,
      endLine: startLine + VECTOR_LENGTH,
      startColumn: 0,
      endColumn: 1,
      docstring: null,
      signature: `function ${name}()`,
      visibility: 'public',
      isExported: true,
      isAsync: false,
      isStatic: false,
      decorators: [],
      decoratorArgs: null,
      updatedAt: Date.now(),
      centrality: null,
      betweenness: null,
      bodyHash,
    })),
  );
  upsertSymbolEmbedding({
    qb: cg.queries,
    nodeId: 'n:vec-a',
    model: VECTOR_MODEL,
    embedding: vectorToBytes(Float32Array.from([1, 0])),
    summaryHashAtEmbed: '',
  });
  upsertSymbolEmbedding({
    qb: cg.queries,
    nodeId: 'n:vec-b',
    model: VECTOR_MODEL,
    embedding: vectorToBytes(Float32Array.from([VECTOR_SIMILAR_X, VECTOR_SIMILAR_Y])),
    summaryHashAtEmbed: '',
  });
  upsertSymbolEmbedding({
    qb: cg.queries,
    nodeId: 'n:vec-c',
    model: VECTOR_MODEL,
    embedding: vectorToBytes(Float32Array.from([0, 1])),
    summaryHashAtEmbed: '',
  });
}

describePgvector('PostgreSQL pgvector acceleration', () => {
  it('mirrors symbol embeddings and builds similar_to edges without USearch', async () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-pgvector-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    currentPostgresUrl = PGVECTOR_URL;
    const database = { provider: 'postgres' as const, url: PGVECTOR_URL!, schema: currentSchema, pgvector: 'require' };
    const cg = Cartograph.initSync(currentDir, { config: { database } });
    currentConn = cg.db;

    expect(isPgvectorAvailable(cg.db.getDb())).toBe(true);
    seedEmbeddingGraph(cg);

    const hits = findSimilarViaPgvector({
      db: cg.db.getDb(),
      queryVec: Float32Array.from([1, 0]),
      model: VECTOR_MODEL,
      k: 3,
      grain: 'symbol',
    });

    expect(hits.map((hit) => hit.nodeId)).toEqual(expect.arrayContaining(['n:vec-a', 'n:vec-b']));
    expect(hits[0]?.nodeId).toBe('n:vec-a');

    const result = await buildSimilarToEdges(cg, { k: VECTOR_BUILD_K, minScore: VECTOR_MIN_SCORE });
    expect(result.reason).toBeUndefined();
    expect(result.processed).toBe(3);
    expect(result.written).toBeGreaterThan(0);
    expect(getOutgoingEdges(cg.queries, 'n:vec-a').some((edge) => edge.kind === 'similar_to')).toBe(true);
  });

  it('reports required pgvector as available in doctor', async () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-pgvector-doctor-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    currentPostgresUrl = PGVECTOR_URL;
    const cartographDir = path.join(currentDir, '.cartograph');
    fs.mkdirSync(cartographDir, { recursive: true });
    const database = { provider: 'postgres' as const, url: PGVECTOR_URL!, schema: currentSchema, pgvector: 'require' };
    fs.writeFileSync(path.join(cartographDir, 'config.json'), JSON.stringify({ database }, null, 2));

    currentConn = DatabaseConnection.initialize(path.join(cartographDir, 'cartograph.db'), { database });
    currentConn.close();
    currentConn = undefined;

    const result = await runDoctor({ projectPath: currentDir });
    const storage = result.checks.find((check) => check.id === 'database-storage');
    expect(storage).toMatchObject({ name: 'Database storage', status: 'ok' });
    expect(storage?.detail).toContain('pgvector available');
  });
});

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
