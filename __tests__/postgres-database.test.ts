import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { DatabaseConnection } from '../src/db/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { QueryBuilder } from '../src/db/queries.js';
import { getOutgoingEdges, insertEdges } from '../src/db/queries-edges.js';
import { upsertFile } from '../src/db/queries-files.js';
import { applyIssueAttributions, getSymbolCoChanges } from '../src/db/queries-history.js';
import { getNodesAtRange } from '../src/db/queries-rtree.js';
import { findSignatureTokenOwner, searchNodes } from '../src/db/queries-search.js';
import { upsertSymbolEmbedding } from '../src/db/queries-embeddings.js';
import { getWeightedSummaryCoverage, upsertSymbolSummary } from '../src/db/queries-summaries.js';
import { resolveDatabaseConfig } from '../src/db/database-config.js';
import { findSimilarViaPgvector, isPgvectorAvailable } from '../src/db/pgvector-helpers.js';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations.js';
import { buildSimilarToEdges } from '../src/embeddings/similar-edges.js';
import { isHnswAvailable } from '../src/embeddings/hnsw-index.js';
import {
  migratePostgresProjectToSqlite,
  migrateSqliteProjectToPostgres,
} from '../src/features/admin-storage-migrate/runtime.js';
import { runDoctor } from '../src/installer/doctor.js';
import { vectorToBytes } from '../src/llm/embeddings.js';
import { isolateBunInstall } from './support/bun-install-isolation.js';

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
const POSTGRES_INTENT_INDEXES = [
  'idx_nodes_docstring_intent_fts',
  'idx_summary_store_intent_fts',
  'idx_test_names_intent_fts',
] as const;

let currentDir: string | undefined;
let currentSchema: string | undefined;
let currentConn: DatabaseConnection | undefined;
let currentPostgresUrl: string | undefined;
let intentSchemaSequence = 0;

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
  // A `runDoctor` case below reads BUN_INSTALL via the global-link check
  // (issue #68); isolate it so the host's real `bun link` state can't leak.
  isolateBunInstall();

  it('searches summaries, docstrings, and test descriptions in intent mode', async () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-intent-test-'));
    fs.mkdirSync(path.join(currentDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(currentDir, 'src', 'auth.ts'),
      [
        'export function verifyJwt(token: string): boolean { return token.length > 0; }',
        'export function parseCookieHeader(header: string): string { return header.trim(); }',
      ].join('\n'),
    );
    currentSchema = `cg_intent_${process.pid}_${intentSchemaSequence++}`;
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };
    const cg = Cartograph.initSync(currentDir, { config: { database, enableWatcher: false } });
    currentConn = cg.db;
    const indexed = await cg.indexAll({ summarize: false });
    expect(indexed.success).toBe(true);

    const db = cg.db.getDb();
    const verifyJwt = db
      .prepare("SELECT id, body_hash FROM nodes WHERE name = 'verifyJwt' AND kind = 'function'")
      .get<{ id: string; body_hash: string }>();
    expect(verifyJwt).toBeDefined();
    expect(
      upsertSymbolSummary({
        qb: cg.queries,
        nodeId: verifyJwt!.id,
        contentHash: verifyJwt!.body_hash,
        summary: 'Verifies a JWT cryptographic signature before accepting the token',
        model: 'intent-test',
      }),
    ).toBe(true);
    db.prepare("UPDATE nodes SET docstring = ? WHERE name = 'parseCookieHeader'").run(
      'Parses the HTTP Cookie header into normalized values.',
    );
    db.prepare('INSERT INTO test_names (file_path, line, description) VALUES (?, ?, ?)').run(
      'src/auth.ts',
      20,
      'rejects a JWT when its cryptographic signature is invalid',
    );

    const handler = new ToolHandler(cg);
    try {
      const summaryAndTest = await handler.execute('cartograph_find', {
        by: 'name',
        mode: 'intent',
        query: 'JWT cryptographic signature',
      });
      const summaryText = summaryAndTest.content[0]?.text ?? '';
      expect(summaryAndTest.isError).not.toBe(true);
      expect(summaryText).toContain('verifyJwt');
      expect(summaryText).toContain('Test-description matches');

      const docstring = await handler.execute('cartograph_find', {
        by: 'name',
        mode: 'intent',
        query: 'parse cookie header',
      });
      const docstringText = docstring.content[0]?.text ?? '';
      expect(docstring.isError).not.toBe(true);
      expect(docstringText).toContain('parseCookieHeader');
      expect(docstringText).toContain('via docstring');
    } finally {
      handler.closeAll();
    }
  });

  it('bootstraps intent indexes only on explicit write or admin opens', () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-intent-bootstrap-test-'));
    currentSchema = `cg_intent_bootstrap_${process.pid}_${intentSchemaSequence++}`;
    const dbPath = path.join(currentDir, 'cartograph.db');
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };

    currentConn = DatabaseConnection.initialize(dbPath, { database });
    expect(readIntentIndexNames(currentConn, currentSchema)).toEqual([...POSTGRES_INTENT_INDEXES]);
    for (const indexName of POSTGRES_INTENT_INDEXES) {
      currentConn.getDb().exec(`DROP INDEX IF EXISTS ${quoteIdent(indexName)}`);
    }
    expect(readIntentIndexNames(currentConn, currentSchema)).toEqual([]);

    currentConn.close();
    currentConn = DatabaseConnection.open(dbPath, { database });
    expect(readIntentIndexNames(currentConn, currentSchema)).toEqual([]);

    currentConn.close();
    currentConn = DatabaseConnection.open(dbPath, { database, autoMigrate: true });
    expect(readIntentIndexNames(currentConn, currentSchema)).toEqual([...POSTGRES_INTENT_INDEXES]);
  });

  it('builds the batched reverse file-dependency index with PostgreSQL-safe row aliases', async () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-file-dependents-test-'));
    fs.mkdirSync(path.join(currentDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(currentDir, 'src', 'subject.ts'), 'export function subject(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(currentDir, 'src', 'subject.test.ts'),
      [
        "import { describe, expect, it } from 'vitest';",
        "import { subject } from './subject.js';",
        "describe('subject', () => { it('works', () => { expect(subject()).toBe(1); }); });",
      ].join('\n'),
    );
    currentSchema = `cg_file_dependents_${process.pid}_${intentSchemaSequence++}`;
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };
    const cg = Cartograph.initSync(currentDir, { config: { database, enableWatcher: false } });
    currentConn = cg.db;
    expect((await cg.indexAll({ summarize: false })).success).toBe(true);

    const dependentIndex = cg.internals.graphManager.getFileDependentIndex();
    expect(dependentIndex.get('src/subject.ts')).toContain('src/subject.test.ts');
  });

  it('skips no-op sync maintenance and analyzes only the active schema after writes', async () => {
    const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-maintenance-a-'));
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-maintenance-b-'));
    const nonce = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const schemaA = `cg_maintenance_a_${nonce}`;
    const schemaB = `cg_maintenance_b_${nonce}`;
    const admin = new Bun.SQL(POSTGRES_URL!);
    let cgA: Cartograph | undefined;
    let cgB: Cartograph | undefined;

    try {
      fs.mkdirSync(path.join(projectA, 'src'), { recursive: true });
      fs.mkdirSync(path.join(projectB, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(projectA, 'src', 'index.ts'),
        `export function helper(): number { return 42; }
export function caller(): number { return helper(); }
`,
      );
      fs.writeFileSync(path.join(projectB, 'src', 'index.ts'), 'export const unrelatedProbe = 1;\n');
      initializeStableGitHistory(projectA);

      cgA = Cartograph.initSync(projectA, {
        config: {
          database: { provider: 'postgres', url: POSTGRES_URL!, schema: schemaA },
          enableWatcher: false,
          include: ['src/**/*.ts'],
        },
      });
      cgB = Cartograph.initSync(projectB, {
        config: {
          database: { provider: 'postgres', url: POSTGRES_URL!, schema: schemaB },
          enableWatcher: false,
          include: ['src/**/*.ts'],
        },
      });

      const indexed = await cgA.indexAll({ summarize: false });
      expect(indexed.success).toBe(true);

      const beforeIdleA = readAnalyzeCount(cgA.db, schemaA);
      const beforeIdleB = readAnalyzeCount(cgA.db, schemaB);
      const idle = await cgA.sync({ summarize: false });

      expect(idle).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0 });
      expect(readAnalyzeCount(cgA.db, schemaA)).toBe(beforeIdleA);
      expect(readAnalyzeCount(cgA.db, schemaB)).toBe(beforeIdleB);

      const helper = cgA.db
        .getDb()
        .prepare("SELECT id, body_hash FROM nodes WHERE name = 'helper' AND kind = 'function'")
        .get<{ id: string; body_hash: string }>();
      expect(helper?.body_hash).not.toBe('');
      const assignmentWrite = cgA.db
        .getDb()
        .prepare(
          `INSERT INTO role_assignments (node_id, role, role_model, body_hash, generated_at)
           VALUES (?, 'business_logic', 'maintenance-test', ?, 0)
           ON CONFLICT(node_id) DO UPDATE SET
             role = excluded.role,
             role_model = excluded.role_model,
             body_hash = excluded.body_hash`,
        )
        .run(helper!.id, helper!.body_hash);
      const roleClearWrite = cgA.db.getDb().prepare('UPDATE nodes SET role = NULL WHERE id = ?').run(helper!.id);
      expect(assignmentWrite.changes).toBe(1);
      expect(roleClearWrite.changes).toBe(1);
      const beforeHookOnlyA = readAnalyzeCount(cgA.db, schemaA);
      const beforeHookOnlyB = readAnalyzeCount(cgA.db, schemaB);

      const hookOnly = await cgA.sync({ summarize: false });

      expect(hookOnly).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0 });
      const restored = cgA.db
        .getDb()
        .prepare('SELECT role FROM nodes WHERE id = ?')
        .get<{ role: string | null }>(helper!.id);
      expect(restored?.role).toBe('business_logic');
      expect(readAnalyzeCount(cgA.db, schemaA)).toBeGreaterThan(beforeHookOnlyA);
      expect(readAnalyzeCount(cgA.db, schemaB)).toBe(beforeHookOnlyB);

      fs.writeFileSync(path.join(projectA, 'src', 'index.ts'), 'export const maintenanceProbe = 2;\n');
      const writeBearing = await cgA.sync({ summarize: false });

      expect(writeBearing.filesModified).toBe(1);
      expect(readAnalyzeCount(cgA.db, schemaA)).toBeGreaterThan(beforeIdleA);
      expect(readAnalyzeCount(cgA.db, schemaB)).toBe(beforeIdleB);
    } finally {
      cgA?.close();
      cgB?.close();
      try {
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaA)} CASCADE`).simple();
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaB)} CASCADE`).simple();
      } finally {
        await admin.close();
        fs.rmSync(projectA, { recursive: true, force: true });
        fs.rmSync(projectB, { recursive: true, force: true });
      }
    }
  });

  it('discovers the active PostgreSQL schema through cartograph_sql', async () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-sql-schema-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };
    const cg = Cartograph.initSync(currentDir, { config: { database } });
    currentConn = cg.db;
    const handler = new ToolHandler(cg, { profile: 'full' });

    const result = await handler.execute('cartograph_sql', { schema: true, tables: ['nodes'] });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).not.toBe(true);
    expect(text).toContain('`nodes` (table)');
    expect(text).toContain('CREATE TABLE "nodes"');
    expect(text).toContain('file_path');
    expect(text).not.toContain('no tables in this database');
  });

  it('enforces read-only execution at the PostgreSQL database boundary', () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-read-only-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };
    const cg = Cartograph.initSync(currentDir, { config: { database } });
    currentConn = cg.db;

    expect(typeof cg.db.prepareReadOnly).toBe('function');
    expect(() =>
      cg.db
        .prepareReadOnly(
          "INSERT INTO nodes (id, kind, name, file_path) VALUES ('blocked', 'function', 'blocked', 'src/a.ts')",
        )
        .run(),
    ).toThrow(/read-only transaction|cannot execute insert/i);

    expect(cg.queries.getNodesByIds(['blocked']).size).toBe(0);
  });

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

    const reverseResult = await migratePostgresProjectToSqlite({ projectPath: currentDir });

    expect(reverseResult.ok).toBe(true);
    if (!reverseResult.ok) throw new Error(reverseResult.error.message);
    expect(reverseResult.summary.targetProvider).toBe('sqlite');
    if (reverseResult.summary.targetProvider !== 'sqlite') throw new Error('expected SQLite migration summary');
    expect(fs.existsSync(reverseResult.summary.sqlitePath)).toBe(true);
    expect(fs.existsSync(reverseResult.summary.postgresSentinelBackupPath)).toBe(true);
    expect(fs.existsSync(reverseResult.summary.configBackupPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(currentDir, '.cartograph', 'config.json'), 'utf-8')).database).toBe(
      undefined,
    );

    const reopenedSqliteCg = Cartograph.openSync(currentDir);
    try {
      expect(reopenedSqliteCg.db.getBackend()).toBe('bun-sqlite');
      expect(reopenedSqliteCg.getConfig().database).toBeUndefined();
      expect(reopenedSqliteCg.queries.getNodeById('n:migrate-source')?.name).toBe('source');
      expect(getOutgoingEdges(reopenedSqliteCg.queries, 'n:migrate-source')[0]?.target).toBe('n:migrate-target');
    } finally {
      reopenedSqliteCg.close();
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

  it('normalizes PostgreSQL aggregate aliases used by weighted summary coverage', () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-coverage-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const dbPath = path.join(currentDir, 'cartograph.db');
    const database = { provider: 'postgres' as const, url: POSTGRES_URL!, schema: currentSchema };

    currentConn = DatabaseConnection.initialize(dbPath, { database });
    const qb = new QueryBuilder(currentConn.getDb(), currentConn.hasVecExtension());
    upsertFile(qb, {
      path: 'src/coverage.ts',
      contentHash: 'hash-coverage',
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
        id: 'n:covered',
        kind: 'function',
        name: 'covered',
        qualifiedName: 'covered',
        filePath: 'src/coverage.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 5,
        startColumn: 0,
        endColumn: 1,
        docstring: null,
        signature: 'function covered()',
        visibility: 'public',
        isExported: true,
        isAsync: false,
        isStatic: false,
        decorators: [],
        decoratorArgs: null,
        updatedAt: Date.now(),
        centrality: 0.75,
        betweenness: null,
        bodyHash: 'body-covered',
      },
      {
        id: 'n:uncovered',
        kind: 'function',
        name: 'uncovered',
        qualifiedName: 'uncovered',
        filePath: 'src/coverage.ts',
        language: 'typescript',
        startLine: 10,
        endLine: 15,
        startColumn: 0,
        endColumn: 1,
        docstring: null,
        signature: 'function uncovered()',
        visibility: 'public',
        isExported: true,
        isAsync: false,
        isStatic: false,
        decorators: [],
        decoratorArgs: null,
        updatedAt: Date.now(),
        centrality: 0.25,
        betweenness: null,
        bodyHash: 'body-uncovered',
      },
    ]);
    upsertSymbolSummary({
      qb,
      nodeId: 'n:covered',
      contentHash: 'summary-covered',
      summary: 'Covered test function.',
      model: 'test-model',
    });

    expect(getWeightedSummaryCoverage(qb, new Set(['function']))).toMatchObject({
      totalNodes: 2,
      coveredNodes: 1,
      totalWeight: 1,
      coveredWeight: 0.75,
    });
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
  // A `runDoctor` case below reads BUN_INSTALL via the global-link check
  // (issue #68); isolate it so the host's real `bun link` state can't leak.
  isolateBunInstall();

  it('serves graph direction=similar from pgvector without persisted edges', async () => {
    currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-pgvector-similar-tool-test-'));
    currentSchema = `cg_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    currentPostgresUrl = PGVECTOR_URL;
    const database = { provider: 'postgres' as const, url: PGVECTOR_URL!, schema: currentSchema, pgvector: 'require' };
    const cg = Cartograph.initSync(currentDir, {
      config: {
        database,
        llm: {
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://127.0.0.1:1',
            model: VECTOR_MODEL,
          },
        },
      },
    });
    currentConn = cg.db;
    seedEmbeddingGraph(cg);
    const handler = new ToolHandler(cg);

    const result = await handler.execute('cartograph_graph', {
      direction: 'similar',
      start: 'VectorA',
      k: 2,
      minScore: VECTOR_MIN_SCORE,
    });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).not.toBe(true);
    expect(text).toContain('**VectorB**');
    expect(text).toContain('on-demand semantic KNN');
    expect(text).not.toContain('No similar symbols found');
  });

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

function readIntentIndexNames(connection: DatabaseConnection, schema: string): string[] {
  const rows = connection
    .getDb()
    .prepare(
      `SELECT indexname AS name
       FROM pg_indexes
       WHERE schemaname = ? AND indexname LIKE '%_intent_fts'
       ORDER BY indexname`,
    )
    .all(schema) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function readAnalyzeCount(connection: DatabaseConnection, schema: string): number {
  connection.getDb().prepare('SELECT pg_stat_clear_snapshot()').get();
  const row = connection
    .getDb()
    .prepare(
      `SELECT COALESCE(SUM(analyze_count), 0)::bigint AS analyze_count
       FROM pg_stat_user_tables
       WHERE schemaname = ?`,
    )
    .get<{ analyze_count: bigint | number | string }>(schema);
  if (!row) throw new Error(`PostgreSQL did not return analyze counters for schema ${schema}`);
  return Number(row.analyze_count);
}

function initializeStableGitHistory(projectRoot: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  };
  git('init', '-q');
  git('config', 'user.email', 'cartograph-test@example.com');
  git('config', 'user.name', 'Cartograph Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(projectRoot, 'history.txt'), 'first\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  fs.writeFileSync(path.join(projectRoot, 'history.txt'), 'second\n');
  git('add', 'history.txt');
  git('commit', '-q', '-m', 'second');
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
