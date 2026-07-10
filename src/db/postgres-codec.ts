import { z } from 'zod';
import { asJsonObject, type JsonObject } from '../json-object.js';

const WorkerSqlOptionValueSchema = z.union([z.string(), z.boolean(), z.number()]);

const PostgresWorkerSqlOptionsSchema = z.strictObject({
  url: z.string().min(1),
  adapter: z.literal('postgres'),
  max: z.number().int().positive().optional(),
  connectionTimeout: z.number().positive().optional(),
  connection: z.record(z.string(), WorkerSqlOptionValueSchema).optional(),
  idleTimeout: z.number().nonnegative().optional(),
  maxLifetime: z.number().nonnegative().optional(),
  tls: z.boolean().optional(),
});

const PostgresWorkerInitSchema = z.strictObject({
  control: z.instanceof(SharedArrayBuffer),
  requestPath: z.string().min(1),
  responsePath: z.string().min(1),
  sqlOptions: PostgresWorkerSqlOptionsSchema,
  url: z.string().min(1),
  schema: z.string().min(1),
});

export type PostgresWorkerInit = z.infer<typeof PostgresWorkerInitSchema>;

export function parsePostgresWorkerInit(raw: unknown, label: string): PostgresWorkerInit {
  const result = PostgresWorkerInitSchema.safeParse(asJsonObject(raw) ?? raw);
  if (!result.success) {
    throw new Error(`Invalid PostgreSQL worker ${label} envelope: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function parsePostgresWorkerJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid PostgreSQL worker ${label} JSON: ${message}`);
  }
}

const WorkerRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('query'),
    sql: z.string().optional(),
    mode: z.enum(['run', 'get', 'all']).optional(),
    params: z.array(z.unknown()).optional(),
    readOnly: z.boolean().optional(),
  }),
  z.strictObject({
    op: z.literal('batch'),
    sql: z.string().optional(),
    mode: z.literal('run').optional(),
    paramSets: z.array(z.array(z.unknown())).optional(),
  }),
  z.strictObject({
    op: z.literal('exec'),
    sql: z.string().optional(),
  }),
  z.strictObject({
    op: z.literal('pragma'),
    pragma: z.string().optional(),
  }),
  z.strictObject({
    op: z.literal('close'),
  }),
]);

export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

type QueryWorkerRequest = Extract<WorkerRequest, { op: 'query' }>;
type BatchWorkerRequest = Extract<WorkerRequest, { op: 'batch' }>;
type ExecWorkerRequest = Extract<WorkerRequest, { op: 'exec' }>;
type PragmaWorkerRequest = Extract<WorkerRequest, { op: 'pragma' }>;

const WorkerRequestOpSchema = z.enum(['query', 'batch', 'exec', 'pragma', 'close']);
const QueryModeSchema = z.enum(['run', 'get', 'all']);
const BatchModeSchema = z.literal('run');
const UnknownArraySchema = z.array(z.unknown());
const UnknownArrayArraySchema = z.array(UnknownArraySchema);

const QUERY_REQUEST_KEYS = new Set(['op', 'sql', 'mode', 'params', 'readOnly']);
const BATCH_REQUEST_KEYS = new Set(['op', 'sql', 'mode', 'paramSets']);
const EXEC_REQUEST_KEYS = new Set(['op', 'sql']);
const PRAGMA_REQUEST_KEYS = new Set(['op', 'pragma']);
const CLOSE_REQUEST_KEYS = new Set(['op']);

export function parseWorkerRequest(decoded: unknown, label: string): WorkerRequest {
  const input = asJsonObject(decoded);
  if (!input) invalidWorkerEnvelope(label, 'expected object');

  const op = parseField(WorkerRequestOpSchema, input['op'], label);
  switch (op) {
    case 'query':
      return parseQueryWorkerRequest(input, label);
    case 'batch':
      return parseBatchWorkerRequest(input, label);
    case 'exec':
      return parseExecWorkerRequest(input, label);
    case 'pragma':
      return parsePragmaWorkerRequest(input, label);
    case 'close':
      assertOnlyKeys(input, CLOSE_REQUEST_KEYS, label);
      return { op: 'close' };
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

/**
 * Envelope the PostgreSQL worker subprocess returns for every request.
 * `rows`/`value` stay `unknown` — individual rows are validated by the
 * typed-query row schemas downstream; this guards only the envelope
 * shape so a crashed/OOM/hung worker can't smuggle a malformed
 * `ok`/`error` past the adapter via an unchecked cast.
 */
const WorkerResponseSchema = z.object({
  ok: z.boolean(),
  rows: z.array(z.unknown()).optional(),
  changes: z.number().optional(),
  lastInsertRowid: z.union([z.number(), z.bigint()]).optional(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});

export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;

const BooleanSchema = z.boolean();
const OptionalRowsSchema = z.array(z.unknown()).optional();
const OptionalNumberSchema = z.number().optional();
const OptionalLastInsertRowIdSchema = z.union([z.number(), z.bigint()]).optional();
const OptionalStringSchema = z.string().optional();

/**
 * Validate a decoded worker response envelope. Throws a clear,
 * labelled error (instead of letting an `as WorkerResponse` cast hide
 * the corruption) when the worker emits a structurally invalid
 * envelope. Call after `decodeValue` so bigint/binary fields are in
 * their decoded form.
 */
export function parseWorkerResponse(decoded: unknown, label: string): WorkerResponse {
  const input = asJsonObject(decoded);
  if (!input) invalidWorkerEnvelope(label, 'expected object');
  const response: WorkerResponse = {
    ok: parseField(BooleanSchema, input['ok'], label),
  };
  const rows = parseField(OptionalRowsSchema, input['rows'], label);
  if (rows !== undefined) response.rows = rows;
  const changes = parseField(OptionalNumberSchema, input['changes'], label);
  if (changes !== undefined) response.changes = changes;
  const lastInsertRowid = parseField(OptionalLastInsertRowIdSchema, input['lastInsertRowid'], label);
  if (lastInsertRowid !== undefined) response.lastInsertRowid = lastInsertRowid;
  if (Object.hasOwn(input, 'value')) response.value = input['value'];
  const error = parseField(OptionalStringSchema, input['error'], label);
  if (error !== undefined) response.error = error;
  return response;
}

function parseQueryWorkerRequest(input: JsonObject, label: string): QueryWorkerRequest {
  assertOnlyKeys(input, QUERY_REQUEST_KEYS, label);
  const request: QueryWorkerRequest = { op: 'query' };
  const sql = parseField(OptionalStringSchema, input['sql'], label);
  if (sql !== undefined) request.sql = sql;
  const mode = parseField(QueryModeSchema.optional(), input['mode'], label);
  if (mode !== undefined) request.mode = mode;
  const params = parseField(UnknownArraySchema.optional(), input['params'], label);
  if (params !== undefined) request.params = params;
  const readOnly = parseField(BooleanSchema.optional(), input['readOnly'], label);
  if (readOnly !== undefined) request.readOnly = readOnly;
  return request;
}

function parseBatchWorkerRequest(input: JsonObject, label: string): BatchWorkerRequest {
  assertOnlyKeys(input, BATCH_REQUEST_KEYS, label);
  const request: BatchWorkerRequest = { op: 'batch' };
  const sql = parseField(OptionalStringSchema, input['sql'], label);
  if (sql !== undefined) request.sql = sql;
  const mode = parseField(BatchModeSchema.optional(), input['mode'], label);
  if (mode !== undefined) request.mode = mode;
  const paramSets = parseField(UnknownArrayArraySchema.optional(), input['paramSets'], label);
  if (paramSets !== undefined) request.paramSets = paramSets;
  return request;
}

function parseExecWorkerRequest(input: JsonObject, label: string): ExecWorkerRequest {
  assertOnlyKeys(input, EXEC_REQUEST_KEYS, label);
  const request: ExecWorkerRequest = { op: 'exec' };
  const sql = parseField(OptionalStringSchema, input['sql'], label);
  if (sql !== undefined) request.sql = sql;
  return request;
}

function parsePragmaWorkerRequest(input: JsonObject, label: string): PragmaWorkerRequest {
  assertOnlyKeys(input, PRAGMA_REQUEST_KEYS, label);
  const request: PragmaWorkerRequest = { op: 'pragma' };
  const pragma = parseField(OptionalStringSchema, input['pragma'], label);
  if (pragma !== undefined) request.pragma = pragma;
  return request;
}

function assertOnlyKeys(input: JsonObject, allowedKeys: ReadonlySet<string>, label: string): void {
  assertKnownKeys(input, allowedKeys, label);
}

function assertKnownKeys(input: JsonObject, allowedKeys: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) invalidWorkerEnvelope(label, `unexpected key "${key}"`);
  }
}

function parseField<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) invalidWorkerEnvelope(label, z.prettifyError(result.error));
  return result.data;
}

function invalidWorkerEnvelope(label: string, reason: string): never {
  throw new Error(`Invalid PostgreSQL worker ${label} envelope: ${reason}`);
}
