/**
 * Storage backend benchmark — SQLite default vs PostgreSQL opt-in.
 *
 * Runs the same synthetic QueryBuilder workload against both backends:
 * schema init, file/node/edge writes, and representative reads
 * (stats, search, range, history co-change).
 *
 * Run:
 *   bun bench/storage-backends.mts
 *   CARTOGRAPH_BENCH_POSTGRES_URL=postgres://user:pass@localhost:5432/cartograph bun bench/storage-backends.mts
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder, getStats } from '../src/db/queries.js';
import { insertEdges } from '../src/db/queries-edges.js';
import { upsertFile } from '../src/db/queries-files.js';
import { applyIssueAttributions, getSymbolCoChanges } from '../src/db/queries-history.js';
import { getNodesAtRange } from '../src/db/queries-rtree.js';
import { searchNodes } from '../src/db/queries-search.js';
import type { CartographConfig, Edge, Node } from '../src/types.js';

interface BenchConfig {
  fileCount: number;
  nodesPerFile: number;
  edgeFanout: number;
  readIterations: number;
  runs: number;
  postgresUrl: string | undefined;
}

interface BenchSample {
  backend: 'sqlite' | 'postgres';
  initMs: number;
  writeMs: number;
  readMs: number;
  totalMs: number;
  storageBytes: number;
  files: number;
  nodes: number;
  edges: number;
}

const DEFAULT_FILE_COUNT = 200;
const DEFAULT_NODES_PER_FILE = 8;
const DEFAULT_EDGE_FANOUT = 2;
const DEFAULT_READ_ITERATIONS = 40;
const DEFAULT_RUNS = 3;
const SYNTHETIC_FILE_SIZE_BYTES = 2048;
const COMMIT_COUNT_MODULUS = 13;
const LINES_PER_NODE = 3;
const FILE_LOC_PADDING = 2;
const TEST_FILE_MODULUS = 10;
const CLASS_NODE_MODULUS = 5;
const EXPORT_NODE_MODULUS = 2;
const ASYNC_NODE_MODULUS = 3;
const CENTRALITY_DENOMINATOR = 1000;
const NODE_END_COLUMN = 40;
const ISSUE_ROW_COUNT = 5;
const SEARCH_RESULT_LIMIT = 20;
const RANGE_START_LINE = 2;
const RANGE_END_LINE = 6;
const RANGE_RESULT_LIMIT = 10;
const COCHANGE_MIN_COUNT = 2;
const COCHANGE_RESULT_LIMIT = 5;
const BYTES_PER_KIB = 1024;
const SIZE_DECIMAL_PLACES = 2;

const config: BenchConfig = {
  fileCount: readPositiveIntEnv('BENCH_FILE_COUNT', DEFAULT_FILE_COUNT),
  nodesPerFile: readPositiveIntEnv('BENCH_NODES_PER_FILE', DEFAULT_NODES_PER_FILE),
  edgeFanout: readPositiveIntEnv('BENCH_EDGE_FANOUT', DEFAULT_EDGE_FANOUT),
  readIterations: readPositiveIntEnv('BENCH_READ_ITERATIONS', DEFAULT_READ_ITERATIONS),
  runs: readPositiveIntEnv('BENCH_RUNS', DEFAULT_RUNS),
  postgresUrl: process.env['CARTOGRAPH_BENCH_POSTGRES_URL'] ?? process.env['CARTOGRAPH_TEST_POSTGRES_URL'],
};

const backends: Array<'sqlite' | 'postgres'> = config.postgresUrl ? ['sqlite', 'postgres'] : ['sqlite'];
const samples: BenchSample[] = [];

for (const backend of backends) {
  for (let run = 0; run < config.runs; run++) {
    samples.push(await runBench(backend, run));
  }
}

writeReport(samples);

async function runBench(backend: 'sqlite' | 'postgres', run: number): Promise<BenchSample> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cartograph-storage-bench-${backend}-`));
  const dbPath = path.join(dir, 'cartograph.db');
  const schema = `cg_bench_${process.pid}_${Date.now()}_${run}`;
  const database = databaseConfig(backend, schema);
  let conn: DatabaseConnection | undefined;
  try {
    const initStart = performance.now();
    conn = DatabaseConnection.initialize(dbPath, database ? { database } : {});
    const initMs = performance.now() - initStart;

    const qb = new QueryBuilder(conn.getDb(), conn.hasVecExtension());
    const writeStart = performance.now();
    seedGraph(qb);
    const writeMs = performance.now() - writeStart;

    const readStart = performance.now();
    runReads(qb);
    const readMs = performance.now() - readStart;

    const stats = getStats(qb);
    return {
      backend,
      initMs,
      writeMs,
      readMs,
      totalMs: initMs + writeMs + readMs,
      storageBytes: await measureStorageBytes(conn, dbPath, database?.schema),
      files: stats.fileCount,
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
    };
  } finally {
    conn?.close();
    if (backend === 'postgres' && config.postgresUrl) await dropPostgresSchema(config.postgresUrl, schema);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function measureStorageBytes(
  conn: DatabaseConnection,
  dbPath: string,
  postgresSchema: string | undefined,
): Promise<number> {
  if (conn.getBackend() === 'postgres') {
    const row = conn
      .getDb()
      .prepare(
        `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS n
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = @schema
           AND c.relkind IN ('r', 'i', 'S', 't', 'm')`,
      )
      .get({ schema: postgresSchema ?? 'public' }) as { n?: number } | null;
    return row?.n ?? 0;
  }
  try {
    conn.getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* best effort */
  }
  return (await fileSize(dbPath)) + (await fileSize(`${dbPath}-wal`));
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fsp.stat(filePath)).size;
  } catch {
    return 0;
  }
}

function databaseConfig(backend: 'sqlite' | 'postgres', schema: string): CartographConfig['database'] | undefined {
  if (backend === 'sqlite') return undefined;
  return { provider: 'postgres', url: config.postgresUrl!, schema };
}

function seedGraph(qb: QueryBuilder): void {
  const nodes: Node[] = [];
  for (let fileIndex = 0; fileIndex < config.fileCount; fileIndex++) {
    const filePath = `src/file_${fileIndex}.ts`;
    upsertFile(qb, {
      path: filePath,
      contentHash: `hash-${fileIndex}`,
      language: 'typescript',
      size: SYNTHETIC_FILE_SIZE_BYTES,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: config.nodesPerFile,
      errors: [],
      commitCount: fileIndex % COMMIT_COUNT_MODULUS,
      loc: config.nodesPerFile * LINES_PER_NODE + FILE_LOC_PADDING,
      firstSeenTs: null,
      lastTouchedTs: null,
      isTest: fileIndex % TEST_FILE_MODULUS === 0,
      needsReextract: false,
    });
    for (let nodeIndex = 0; nodeIndex < config.nodesPerFile; nodeIndex++) {
      nodes.push(makeNode(fileIndex, nodeIndex, filePath));
    }
  }

  qb.insertNodes(nodes);
  insertEdges(qb, makeEdges(nodes));
  applyIssueAttributions(qb, makeIssueRows(nodes));
}

function makeNode(fileIndex: number, nodeIndex: number, filePath: string): Node {
  const id = `n:${fileIndex}:${nodeIndex}`;
  const name = `symbol_${nodeIndex}_${fileIndex}`;
  const startLine = nodeIndex * LINES_PER_NODE + 1;
  return {
    id,
    kind: nodeIndex % CLASS_NODE_MODULUS === 0 ? 'class' : 'function',
    name,
    qualifiedName: `${filePath.replace(/[^A-Za-z0-9_]/g, '_')}.${name}`,
    filePath,
    language: 'typescript',
    startLine,
    endLine: startLine + FILE_LOC_PADDING,
    startColumn: 0,
    endColumn: NODE_END_COLUMN,
    docstring: null,
    signature: `function ${name}()`,
    visibility: 'public',
    isExported: nodeIndex % EXPORT_NODE_MODULUS === 0,
    isAsync: nodeIndex % ASYNC_NODE_MODULUS === 0,
    isStatic: false,
    decorators: [],
    decoratorArgs: null,
    updatedAt: Date.now(),
    centrality: (fileIndex + nodeIndex) / CENTRALITY_DENOMINATOR,
    betweenness: null,
    bodyHash: `body-${fileIndex}-${nodeIndex}`,
  };
}

function makeEdges(nodes: readonly Node[]): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const source = nodes[i]!;
    for (let hop = 1; hop <= config.edgeFanout; hop++) {
      const target = nodes[(i + hop) % nodes.length]!;
      edges.push({
        source: source.id,
        target: target.id,
        kind: hop === 1 ? 'calls' : 'references',
        metadata: { bench: true, hop },
        line: source.startLine,
        column: 0,
        confidence: 'EXTRACTED',
      });
    }
  }
  return edges;
}

function makeIssueRows(nodes: readonly Node[]): Array<{
  nodeId: string;
  issueNumber: number;
  commitSha: string;
  kind: 'modified';
}> {
  if (nodes.length < DEFAULT_EDGE_FANOUT) return [];
  const source = nodes[0]!;
  const partner = nodes[1]!;
  const rows: Array<{ nodeId: string; issueNumber: number; commitSha: string; kind: 'modified' }> = [];
  for (let i = 0; i < ISSUE_ROW_COUNT; i++) {
    rows.push({ nodeId: source.id, issueNumber: i + 1, commitSha: `sha-${i}`, kind: 'modified' });
    rows.push({ nodeId: partner.id, issueNumber: i + 1, commitSha: `sha-${i}`, kind: 'modified' });
  }
  return rows;
}

function runReads(qb: QueryBuilder): void {
  for (let i = 0; i < config.readIterations; i++) {
    getStats(qb);
    searchNodes(qb, `symbol_${i % config.nodesPerFile}`, {
      kinds: ['function', 'class'],
      languages: ['typescript'],
      limit: SEARCH_RESULT_LIMIT,
    });
    getNodesAtRange(qb, {
      filePath: `src/file_${i % config.fileCount}.ts`,
      startLine: RANGE_START_LINE,
      endLine: RANGE_END_LINE,
      limit: RANGE_RESULT_LIMIT,
    });
    getSymbolCoChanges(qb, 'n:0:0', { minCount: COCHANGE_MIN_COUNT, limit: COCHANGE_RESULT_LIMIT });
  }
}

async function dropPostgresSchema(url: string, schema: string): Promise<void> {
  const sql = new Bun.SQL(url, { max: 1 });
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).simple();
  } finally {
    await sql.close();
  }
}

function writeReport(rows: readonly BenchSample[]): void {
  writeLine('# Storage Backend Benchmark');
  writeLine();
  writeLine(`- Bun: ${Bun.version}`);
  writeLine(`- Platform: ${process.platform} ${process.arch}`);
  writeLine(
    `- Workload: ${config.fileCount} files, ${config.fileCount * config.nodesPerFile} nodes, ` +
      `${config.fileCount * config.nodesPerFile * config.edgeFanout} candidate edges, ${config.readIterations} read iterations`,
  );
  writeLine(`- Runs per backend: ${config.runs}`);
  if (!config.postgresUrl) {
    writeLine('- PostgreSQL: skipped; set CARTOGRAPH_BENCH_POSTGRES_URL to include it.');
  }
  writeLine();
  writeLine('| Backend | Init median | Write median | Read median | Total median | DB size |');
  writeLine('|---|---:|---:|---:|---:|---:|');
  for (const backend of ['sqlite', 'postgres'] as const) {
    const backendRows = rows.filter((row) => row.backend === backend);
    if (backendRows.length === 0) continue;
    writeLine(
      `| ${backend} | ${formatMs(median(backendRows.map((row) => row.initMs)))} | ` +
        `${formatMs(median(backendRows.map((row) => row.writeMs)))} | ` +
        `${formatMs(median(backendRows.map((row) => row.readMs)))} | ` +
        `${formatMs(median(backendRows.map((row) => row.totalMs)))} | ` +
        `${formatBytes(median(backendRows.map((row) => row.storageBytes)))} |`,
    );
  }
  writeLine();
  writeLine('Per-run totals:');
  for (const row of rows) {
    writeLine(
      `- ${row.backend}: total=${formatMs(row.totalMs)} init=${formatMs(row.initMs)} ` +
        `write=${formatMs(row.writeMs)} read=${formatMs(row.readMs)} rows=${row.files}/${row.nodes}/${row.edges}`,
    );
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  const mib = BYTES_PER_KIB * BYTES_PER_KIB;
  const gib = mib * BYTES_PER_KIB;
  if (value >= gib) return `${(value / gib).toFixed(SIZE_DECIMAL_PLACES)} GB`;
  if (value >= mib) return `${(value / mib).toFixed(SIZE_DECIMAL_PLACES)} MB`;
  if (value >= BYTES_PER_KIB) return `${(value / BYTES_PER_KIB).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function writeLine(line = ''): void {
  process.stdout.write(`${line}\n`);
}
