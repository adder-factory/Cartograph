/**
 * SQLite driver benchmark: bun:sqlite vs Bun.SQL's SQLite adapter.
 *
 * This is intentionally lower-level than storage-backends.mts. It measures
 * the driver/API shape Cartograph would have to choose between:
 * - bun:sqlite: synchronous prepared statements, matching today's adapter.
 * - Bun.SQL row-by-row: a mechanical async tagged-template port.
 * - Bun.SQL bulk: best-case writes using Bun.SQL's object-array helper.
 *
 * Run:
 *   bun bench/sqlite-driver.mts
 *
 * Optional knobs:
 *   BENCH_RUNS=7 BENCH_FILE_COUNT=1000 BENCH_NODES_PER_FILE=8 BENCH_READ_ITERATIONS=2000 bun bench/sqlite-driver.mts
 */

import { Database } from 'bun:sqlite';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

type Driver = 'bun:sqlite' | 'bun.sql-row' | 'bun.sql-bulk';

interface BenchConfig {
  files: number;
  nodesPerFile: number;
  reads: number;
  runs: number;
  warmupRuns: number;
  bulkChunkSize: number;
}

interface FileRow {
  path: string;
  language: string;
  size: number;
  modified_at: number;
  commit_count: number;
}

interface NodeRow {
  id: string;
  file_path: string;
  kind: string;
  name: string;
  start_line: number;
  body_hash: string;
}

interface BenchSample {
  driver: Driver;
  run: number;
  warmup: boolean;
  initMs: number;
  writeMs: number;
  readMs: number;
  totalMs: number;
  storageBytes: number;
}

interface DriverRunInput {
  dbPath: string;
  driver: Driver;
  run: number;
  rows: BenchRows;
}

interface BenchRows {
  files: FileRow[];
  nodes: NodeRow[];
}

interface SampleInput {
  driver: Driver;
  run: number;
  initMs: number;
  writeMs: number;
  readMs: number;
  storageBytes: number;
}

const DEFAULT_RUNS = 5;
const DEFAULT_WARMUP_RUNS = 1;
const DEFAULT_FILE_COUNT = 500;
const DEFAULT_NODES_PER_FILE = 8;
const DEFAULT_READ_ITERATIONS = 1000;
const DEFAULT_BULK_CHUNK_SIZE = 500;
const FILE_SIZE_BYTES = 2048;
const LINES_PER_NODE = 3;
const SIZE_DECIMAL_PLACES = 2;
const BYTES_PER_KIB = 1024;

const INSERT_FILE_SQL = `
  INSERT INTO files (path, language, size, modified_at, commit_count)
  VALUES ($1, $2, $3, $4, $5)
`;
const INSERT_NODE_SQL = `
  INSERT INTO nodes (id, file_path, kind, name, start_line, body_hash)
  VALUES ($1, $2, $3, $4, $5, $6)
`;
const SELECT_BY_ID_SQL = 'SELECT id, name, kind FROM nodes WHERE id = $1';
const SELECT_BY_FILE_RANGE_SQL =
  'SELECT count(*) AS n FROM nodes WHERE file_path = $1 AND start_line BETWEEN $2 AND $3';
const SELECT_BY_NAME_SQL = 'SELECT id FROM nodes WHERE name = $1 LIMIT 20';
const SELECT_AGGREGATE_SQL =
  'SELECT kind, count(*) AS n FROM nodes WHERE start_line >= $1 GROUP BY kind ORDER BY n DESC';
const FILE_COLUMNS = ['path', 'language', 'size', 'modified_at', 'commit_count'] as const;
const NODE_COLUMNS = ['id', 'file_path', 'kind', 'name', 'start_line', 'body_hash'] as const;

const config: BenchConfig = {
  files: readPositiveIntEnv('BENCH_FILE_COUNT', DEFAULT_FILE_COUNT),
  nodesPerFile: readPositiveIntEnv('BENCH_NODES_PER_FILE', DEFAULT_NODES_PER_FILE),
  reads: readPositiveIntEnv('BENCH_READ_ITERATIONS', DEFAULT_READ_ITERATIONS),
  runs: readPositiveIntEnv('BENCH_RUNS', DEFAULT_RUNS),
  warmupRuns: readPositiveIntEnv('BENCH_WARMUP_RUNS', DEFAULT_WARMUP_RUNS),
  bulkChunkSize: readPositiveIntEnv('BENCH_BULK_CHUNK_SIZE', DEFAULT_BULK_CHUNK_SIZE),
};

const drivers: Driver[] = ['bun:sqlite', 'bun.sql-row', 'bun.sql-bulk'];
const allSamples: BenchSample[] = [];

for (const driver of drivers) {
  for (let run = 0; run < config.runs + config.warmupRuns; run++) {
    allSamples.push(await runDriver(driver, run));
  }
}

writeReport(allSamples.filter((sample) => !sample.warmup));

async function runDriver(driver: Driver, run: number): Promise<BenchSample> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cartograph-sqlite-driver-${driver.replace(':', '-')}-`));
  const dbPath = path.join(dir, 'bench.db');
  const rows = makeRows();
  try {
    const input = { dbPath, driver, run, rows };
    if (driver === 'bun:sqlite') return await runBunSqlite(input);
    return await runBunSql(input);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function runBunSqlite(input: DriverRunInput): Promise<BenchSample> {
  let db: Database | undefined;
  const initStart = performance.now();
  db = new Database(input.dbPath, { strict: true });
  applyBunSqlitePragmas(db);
  db.exec(schemaSql());
  const initMs = performance.now() - initStart;

  try {
    const writeStart = performance.now();
    const insertFile = db.prepare(
      `INSERT INTO files (path, language, size, modified_at, commit_count)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertNode = db.prepare(
      `INSERT INTO nodes (id, file_path, kind, name, start_line, body_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (const file of input.rows.files) {
        insertFile.run(file.path, file.language, file.size, file.modified_at, file.commit_count);
      }
      for (const node of input.rows.nodes) {
        insertNode.run(node.id, node.file_path, node.kind, node.name, node.start_line, node.body_hash);
      }
    })();
    const writeMs = performance.now() - writeStart;

    const readStart = performance.now();
    runBunSqliteReads(db);
    const readMs = performance.now() - readStart;
    await checkpointBunSqlite(db);
    return sample({
      driver: input.driver,
      run: input.run,
      initMs,
      writeMs,
      readMs,
      storageBytes: await storageBytes(input.dbPath),
    });
  } finally {
    db.close();
  }
}

async function runBunSql(input: DriverRunInput): Promise<BenchSample> {
  const initStart = performance.now();
  const sql = new Bun.SQL({ adapter: 'sqlite', filename: input.dbPath, strict: true });
  await applyBunSqlPragmas(sql);
  await sql.unsafe(schemaSql()).simple();
  const initMs = performance.now() - initStart;

  try {
    const writeStart = performance.now();
    if (input.driver === 'bun.sql-row') await writeBunSqlRowByRow(sql, input.rows);
    else await writeBunSqlBulk(sql, input.rows);
    const writeMs = performance.now() - writeStart;

    const readStart = performance.now();
    await runBunSqlReads(sql);
    const readMs = performance.now() - readStart;
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    return sample({
      driver: input.driver,
      run: input.run,
      initMs,
      writeMs,
      readMs,
      storageBytes: await storageBytes(input.dbPath),
    });
  } finally {
    await sql.close();
  }
}

function applyBunSqlitePragmas(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -64000');
}

async function applyBunSqlPragmas(sql: Bun.SQL): Promise<void> {
  await sql`PRAGMA journal_mode = WAL`;
  await sql`PRAGMA synchronous = NORMAL`;
  await sql`PRAGMA temp_store = MEMORY`;
  await sql`PRAGMA cache_size = -64000`;
}

async function writeBunSqlRowByRow(sql: Bun.SQL, rows: BenchRows): Promise<void> {
  await sql.begin(async (tx) => {
    for (let i = 0; i < rows.files.length; i++) {
      const file = rows.files[i]!;
      await tx.unsafe(INSERT_FILE_SQL, [file.path, file.language, file.size, file.modified_at, file.commit_count]);
    }
    for (let i = 0; i < rows.nodes.length; i++) {
      const node = rows.nodes[i]!;
      await tx.unsafe(INSERT_NODE_SQL, [
        node.id,
        node.file_path,
        node.kind,
        node.name,
        node.start_line,
        node.body_hash,
      ]);
    }
  });
}

async function writeBunSqlBulk(sql: Bun.SQL, rows: BenchRows): Promise<void> {
  await sql.begin(async (tx) => {
    const insertFiles = tx`INSERT INTO files`;
    const insertNodes = tx`INSERT INTO nodes`;
    for (const chunk of chunks(rows.files, config.bulkChunkSize)) {
      const fileValues = tx(chunk, ...FILE_COLUMNS);
      await tx`${insertFiles} ${fileValues}`;
    }
    for (const chunk of chunks(rows.nodes, config.bulkChunkSize)) {
      const nodeValues = tx(chunk, ...NODE_COLUMNS);
      await tx`${insertNodes} ${nodeValues}`;
    }
  });
}

function runBunSqliteReads(db: Database): void {
  const byId = db.prepare('SELECT id, name, kind FROM nodes WHERE id = ?');
  const byFileRange = db.prepare('SELECT count(*) AS n FROM nodes WHERE file_path = ? AND start_line BETWEEN ? AND ?');
  const byName = db.prepare('SELECT id FROM nodes WHERE name = ? LIMIT 20');
  const aggregate = db.prepare(
    'SELECT kind, count(*) AS n FROM nodes WHERE start_line >= ? GROUP BY kind ORDER BY n DESC',
  );
  for (let i = 0; i < config.reads; i++) {
    const fileIndex = i % config.files;
    const nodeIndex = i % config.nodesPerFile;
    byId.get(nodeId(fileIndex, nodeIndex));
    byFileRange.get(filePath(fileIndex), 1, 15);
    byName.all(nodeName(fileIndex, nodeIndex));
    aggregate.all(nodeIndex);
  }
}

async function runBunSqlReads(sql: Bun.SQL): Promise<void> {
  for (let i = 0; i < config.reads; i++) {
    const fileIndex = i % config.files;
    const nodeIndex = i % config.nodesPerFile;
    await sql.unsafe(SELECT_BY_ID_SQL, [nodeId(fileIndex, nodeIndex)]);
    await sql.unsafe(SELECT_BY_FILE_RANGE_SQL, [filePath(fileIndex), 1, 15]);
    await sql.unsafe(SELECT_BY_NAME_SQL, [nodeName(fileIndex, nodeIndex)]);
    await sql.unsafe(SELECT_AGGREGATE_SQL, [nodeIndex]);
  }
}

async function checkpointBunSqlite(db: Database): Promise<void> {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

function schemaSql(): string {
  return `
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      language TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      commit_count INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      body_hash TEXT NOT NULL
    ) STRICT;

    CREATE INDEX idx_nodes_file_line ON nodes(file_path, start_line);
    CREATE INDEX idx_nodes_name ON nodes(name);
    CREATE INDEX idx_nodes_kind_line ON nodes(kind, start_line);
  `;
}

function makeRows(): BenchRows {
  const files: FileRow[] = [];
  const nodes: NodeRow[] = [];
  const now = Date.now();
  for (let fileIndex = 0; fileIndex < config.files; fileIndex++) {
    const currentPath = filePath(fileIndex);
    files.push({
      path: currentPath,
      language: 'typescript',
      size: FILE_SIZE_BYTES,
      modified_at: now,
      commit_count: fileIndex % 13,
    });
    for (let nodeIndex = 0; nodeIndex < config.nodesPerFile; nodeIndex++) {
      nodes.push({
        id: nodeId(fileIndex, nodeIndex),
        file_path: currentPath,
        kind: nodeIndex % 5 === 0 ? 'class' : 'function',
        name: nodeName(fileIndex, nodeIndex),
        start_line: nodeIndex * LINES_PER_NODE + 1,
        body_hash: `body-${fileIndex}-${nodeIndex}`,
      });
    }
  }
  return { files, nodes };
}

function nodeId(fileIndex: number, nodeIndex: number): string {
  return `n:${fileIndex}:${nodeIndex}`;
}

function filePath(fileIndex: number): string {
  return `src/file_${fileIndex}.ts`;
}

function nodeName(fileIndex: number, nodeIndex: number): string {
  return `symbol_${nodeIndex}_${fileIndex}`;
}

function sample(input: SampleInput): BenchSample {
  return {
    driver: input.driver,
    run: input.run,
    warmup: input.run < config.warmupRuns,
    initMs: input.initMs,
    writeMs: input.writeMs,
    readMs: input.readMs,
    totalMs: input.initMs + input.writeMs + input.readMs,
    storageBytes: input.storageBytes,
  };
}

async function storageBytes(dbPath: string): Promise<number> {
  return (await fileSize(dbPath)) + (await fileSize(`${dbPath}-wal`)) + (await fileSize(`${dbPath}-shm`));
}

async function fileSize(filePathValue: string): Promise<number> {
  try {
    return (await fsp.stat(filePathValue)).size;
  } catch {
    return 0;
  }
}

function* chunks<T>(rows: readonly T[], size: number): Iterable<T[]> {
  for (let i = 0; i < rows.length; i += size) {
    yield rows.slice(i, i + size);
  }
}

function writeReport(rows: readonly BenchSample[]): void {
  const nodeCount = config.files * config.nodesPerFile;
  writeLine('# SQLite Driver Benchmark');
  writeLine();
  writeLine(`- Bun: ${Bun.version}`);
  writeLine(`- Platform: ${process.platform} ${process.arch}`);
  writeLine(
    `- Workload: ${config.files} files, ${nodeCount} nodes, ${config.reads} read iterations ` +
      `(${config.reads * 4} SELECTs)`,
  );
  writeLine(`- Runs per driver: ${config.runs} (${config.warmupRuns} warmup discarded)`);
  writeLine(`- Bun.SQL bulk chunk size: ${config.bulkChunkSize}`);
  writeLine();
  writeLine('| Driver | Init median | Write median | Read median | Total median | DB size |');
  writeLine('|---|---:|---:|---:|---:|---:|');
  for (const driver of drivers) {
    const driverRows = rows.filter((row) => row.driver === driver);
    writeLine(
      `| ${driver} | ${formatMs(median(driverRows.map((row) => row.initMs)))} | ` +
        `${formatMs(median(driverRows.map((row) => row.writeMs)))} | ` +
        `${formatMs(median(driverRows.map((row) => row.readMs)))} | ` +
        `${formatMs(median(driverRows.map((row) => row.totalMs)))} | ` +
        `${formatBytes(median(driverRows.map((row) => row.storageBytes)))} |`,
    );
  }
  writeLine();
  writeLine('Per-run totals:');
  for (const row of rows) {
    writeLine(
      `- ${row.driver}: total=${formatMs(row.totalMs)} init=${formatMs(row.initMs)} ` +
        `write=${formatMs(row.writeMs)} read=${formatMs(row.readMs)} size=${formatBytes(row.storageBytes)}`,
    );
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  const mib = BYTES_PER_KIB * BYTES_PER_KIB;
  if (value >= mib) return `${(value / mib).toFixed(SIZE_DECIMAL_PLACES)} MB`;
  if (value >= BYTES_PER_KIB) return `${(value / BYTES_PER_KIB).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function writeLine(line = ''): void {
  process.stdout.write(`${line}\n`);
}
