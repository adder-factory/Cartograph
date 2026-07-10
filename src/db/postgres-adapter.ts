import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter.js';
import {
  parsePostgresWorkerJson,
  parseWorkerResponse,
  type WorkerRequest,
  type WorkerResponse,
} from './postgres-codec.js';
import { POSTGRES_DEFAULT_QUERY_TIMEOUT_MS, postgresSqlOptions, type DatabaseConfig } from './database-config.js';

type PostgresAdapterOptions = DatabaseConfig & { provider: 'postgres' };

interface PostgresAdapterState {
  worker: Worker;
  control: Int32Array;
  dir: string;
  requestPath: string;
  responsePath: string;
  queryTimeoutMs: number;
  open: boolean;
  txDepth: number;
}

const WORKER_READY = 10;
const WORKER_REQUEST = 1;
const WORKER_RESPONSE = 2;

export class PostgresAdapter implements SqliteDatabase {
  readonly dialect = 'postgres' as const;
  private readonly options: PostgresAdapterOptions;
  private state: PostgresAdapterState;

  constructor(options: PostgresAdapterOptions) {
    this.options = { ...options };
    this.state = createBridge(this.options);
  }

  get open(): boolean {
    return this.state.open;
  }

  prepare(sql: string): SqliteStatement {
    return new PostgresStatement(this, sql);
  }

  prepareReadOnly(sql: string): SqliteStatement {
    return new PostgresStatement(this, sql, true);
  }

  exec(sql: string): void {
    if (isNoopPragmaSql(sql)) return;
    this.call({ op: 'exec', sql });
  }

  pragma<T = unknown>(str: string): T {
    return this.call({ op: 'pragma', pragma: str }).value as T;
  }

  transaction<Args extends unknown[], T>(fn: (...args: Args) => T): (...args: Args) => T {
    return (...args: Args) => {
      const savepoint = `cartograph_sp_${this.state.txDepth}`;
      if (this.state.txDepth === 0) this.exec('BEGIN');
      else this.exec(`SAVEPOINT ${savepoint}`);
      this.state.txDepth++;
      try {
        const result = fn(...args);
        this.state.txDepth--;
        if (this.state.txDepth === 0) this.exec('COMMIT');
        else this.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (err) {
        this.state.txDepth--;
        this.rollbackBestEffort(savepoint);
        throw err;
      }
    };
  }

  /**
   * Roll back the current transaction/savepoint best-effort, NEVER letting
   * a rollback failure replace the caller's original error. A query timeout
   * closes the bridge (`call()` sets `state.open = false`), so a follow-up
   * ROLLBACK would throw "PostgreSQL connection is closed" and mask the real
   * timeout diagnostic — so skip it when the connection is already gone and
   * swallow any rollback throw.
   */
  private rollbackBestEffort(savepoint: string): void {
    if (!this.state.open) return;
    try {
      if (this.state.txDepth === 0) this.exec('ROLLBACK');
      else this.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    } catch {
      // Rollback failed; the caller's original error is the diagnostic payload.
    }
  }

  close(): void {
    if (!this.state.open) return;
    try {
      this.call({ op: 'close' });
    } catch {
      /* worker is already gone */
    }
    closeBridge(this.state);
  }

  call(request: WorkerRequest): WorkerResponse {
    try {
      return callOnce(this.state, request);
    } catch (err) {
      if (err instanceof PostgresWorkerResponseError && shouldRetryClosedConnection(this.state, request, err.message)) {
        this.restartBridgeForRetry();
        return callOnce(this.state, request);
      }
      throw err;
    }
  }

  private restartBridgeForRetry(): void {
    closeBridge(this.state);
    this.state = createBridge(this.options);
  }
}

function terminateWorker(worker: Worker): void {
  void worker.terminate().catch(() => undefined);
}

function createBridge(options: PostgresAdapterOptions): PostgresAdapterState {
  const control = new Int32Array(new SharedArrayBuffer(4));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-pg-'));
  const requestPath = path.join(dir, 'request.json');
  const responsePath = path.join(dir, 'response.json');
  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  const workerPath = fileURLToPath(new URL(`./postgres-worker${ext}`, import.meta.url));
  const worker = new Worker(workerPath, {
    workerData: {
      control: control.buffer,
      requestPath,
      responsePath,
      sqlOptions: postgresSqlOptions(options),
      url: options.url,
      schema: options.schema ?? 'public',
    },
  });
  const state: PostgresAdapterState = {
    worker,
    control,
    dir,
    requestPath,
    responsePath,
    queryTimeoutMs: options.queryTimeoutMs ?? POSTGRES_DEFAULT_QUERY_TIMEOUT_MS,
    open: true,
    txDepth: 0,
  };
  const ready = Atomics.wait(control, 0, 0, 30_000);
  if (ready === 'timed-out' || Atomics.load(control, 0) !== WORKER_READY) {
    terminateWorker(worker);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best effort */
    }
    throw new Error('PostgreSQL adapter worker did not become ready within 30s');
  }
  Atomics.store(control, 0, 0);
  return state;
}

function shouldRetryClosedConnection(state: PostgresAdapterState, request: WorkerRequest, error: string): boolean {
  return request.op !== 'close' && state.txDepth === 0 && isClosedPostgresConnectionError(error);
}

class PostgresWorkerResponseError extends Error {}

function callOnce(state: PostgresAdapterState, request: WorkerRequest): WorkerResponse {
  if (!state.open) throw new Error('PostgreSQL connection is closed');
  fs.writeFileSync(state.requestPath, JSON.stringify(encodeValue(request)), 'utf-8');
  Atomics.store(state.control, 0, WORKER_REQUEST);
  Atomics.notify(state.control, 0);
  const wait = Atomics.wait(state.control, 0, WORKER_REQUEST, state.queryTimeoutMs);
  if (wait === 'timed-out') {
    closeBridge(state);
    throw new Error(`PostgreSQL query timed out after ${state.queryTimeoutMs}ms; connection has been closed`);
  }
  if (Atomics.load(state.control, 0) !== WORKER_RESPONSE) {
    closeBridge(state);
    throw new Error('PostgreSQL worker returned an invalid state');
  }
  const raw = fs.readFileSync(state.responsePath, 'utf-8');
  Atomics.store(state.control, 0, 0);
  const response = parseWorkerResponse(decodeValue(parsePostgresWorkerJson(raw, 'response')), 'response');
  if (!response.ok) throw new PostgresWorkerResponseError(response.error ?? 'PostgreSQL query failed');
  return response;
}

function closeBridge(state: PostgresAdapterState): void {
  if (!state.open) return;
  state.open = false;
  terminateWorker(state.worker);
  try {
    fs.rmSync(state.dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best effort */
  }
}

function isClosedPostgresConnectionError(message: string): boolean {
  return (
    /\bconnection\s+is\s+closed\b/i.test(message) ||
    /\bconnection\s+terminated\b/i.test(message) ||
    /\bserver\s+closed\s+the\s+connection\b/i.test(message) ||
    /\bECONNRESET\b/i.test(message)
  );
}

class PostgresStatement implements SqliteStatement {
  constructor(
    private readonly adapter: PostgresAdapter,
    private readonly sql: string,
    private readonly readOnly = false,
  ) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const response = this.adapter.call(this.queryRequest('run', params));
    return {
      changes: response.changes ?? 0,
      lastInsertRowid: response.lastInsertRowid ?? 0,
    };
  }

  runBatch(paramSets: unknown[][]): { changes: number; lastInsertRowid: number | bigint } {
    if (this.readOnly) throw new Error('Read-only statements do not support batch execution.');
    if (paramSets.length === 0) return { changes: 0, lastInsertRowid: 0 };
    const response = this.adapter.call({ op: 'batch', sql: this.sql, mode: 'run', paramSets });
    return {
      changes: response.changes ?? 0,
      lastInsertRowid: response.lastInsertRowid ?? 0,
    };
  }

  get<TRow = unknown>(...params: unknown[]): TRow | null | undefined {
    const response = this.adapter.call(this.queryRequest('get', params));
    return (response.rows?.[0] ?? null) as TRow | null;
  }

  all<TRow = unknown>(...params: unknown[]): TRow[] {
    const response = this.adapter.call(this.queryRequest('all', params));
    return (response.rows ?? []) as TRow[];
  }

  iterate<TRow = unknown>(...params: unknown[]): IterableIterator<TRow> {
    return this.all<TRow>(...params)[Symbol.iterator]();
  }

  private queryRequest(mode: 'run' | 'get' | 'all', params: unknown[]): WorkerRequest {
    const request: WorkerRequest = { op: 'query', sql: this.sql, mode, params };
    if (this.readOnly) request.readOnly = true;
    return request;
  }
}

function isNoopPragmaSql(sql: string): boolean {
  return /^PRAGMA\b/i.test(sql.trim());
}

function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __cartographBinary: Buffer.from(value).toString('base64') };
  }
  if (typeof value === 'bigint') {
    return { __cartographBigInt: value.toString() };
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = encodeValue(inner);
    return out;
  }
  return value;
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['__cartographBinary'] === 'string') {
      return Buffer.from(obj['__cartographBinary'], 'base64');
    }
    if (typeof obj['__cartographBigInt'] === 'string') {
      return BigInt(obj['__cartographBigInt']);
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(obj)) out[key] = decodeValue(inner);
    return out;
  }
  return value;
}
