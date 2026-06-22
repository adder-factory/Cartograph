/**
 * Config-editor endpoints for the viewer.
 *
 *  - GET  /api/config   — the curated, editable config subset + a
 *                         read-only database summary + capabilities.
 *  - POST /api/config   — validate + whitelist + persist the curated
 *                         subset (never the database / llm / rootDir).
 *  - POST /api/reindex  — run an in-process full index or incremental
 *                         sync, streaming progress as Server-Sent Events.
 *
 * The write endpoints are gated by `ctx.allowConfigEdit` (loopback bind
 * by default, else `--allow-config-edit`) and enforced server-side, so a
 * tampered client cannot reach them by un-hiding the UI.
 */
import type * as http from 'node:http';
import { z } from 'zod';
import { loadConfig, saveConfig } from '../../../config.js';
import { classifyConfigChange } from '../../../config/change-class.js';
import { assertValidCartographConfig } from '../../../config/schema.js';
import { MAX_INDEX_FILE_SIZE, MAX_INDEX_FILE_SIZE_LABEL } from '../../../default-config.js';
import { errMsg, logDebug } from '../../../errors.js';
import type { IndexProgress } from '../../../extraction/index.js';
import type { CartographConfig } from '../../../types.js';
import {
  CONFIG_BODY_BYTE_LIMIT,
  CONFIG_GLOB_CHAR_LIMIT,
  CONFIG_GLOB_LIST_LIMIT,
  CONFIG_REINDEX_BODY_BYTE_LIMIT,
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_FORBIDDEN,
  HTTP_INTERNAL_ERROR,
  HTTP_OK,
  HTTP_PAYLOAD_TOO_LARGE,
} from './constants.js';
import type { RequestContext } from './context.js';
import { ensureCartograph } from './context.js';
import { parseJsonObject, readBody, sendJson, writeSseEvent } from './http.js';
import { endReindexJob, isReindexInProgress, tryBeginReindexJob } from './reindex-job.js';

const CONFIG_EDIT_DISABLED_MSG =
  'config editing is disabled — the viewer is not bound to localhost (launch with --allow-config-edit to override)';

const BUSY_MESSAGE =
  'another indexer is already running (e.g. the MCP server) — the existing index was left intact. Try again shortly.';

/** A relative label for validation error messages so a 400 echoed to the
 *  browser never leaks the project's absolute filesystem path. */
const CONFIG_DISPLAY_PATH = '.cartograph/config.json';

/** The fields the editor is allowed to display and write. Everything
 *  else in the config (database, llm, rootDir, version, …) is never
 *  surfaced as editable nor overwritten from a client body.
 *
 *  `languages` is intentionally NOT here: the scan filters files via
 *  `shouldIncludeFile` (include/exclude globs) and auto-detects language
 *  by extension, so a language list does not control what gets indexed —
 *  exposing it as an indexing filter would mislead. */
interface CuratedConfig {
  include: string[];
  exclude: string[];
  maxFileSize: number;
  enableBiomarkers: boolean;
  enableCoChange: boolean;
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

const curatedConfigBodySchema = z.looseObject({});

function curatedFrom(config: CartographConfig): CuratedConfig {
  return {
    include: config.include,
    exclude: config.exclude,
    maxFileSize: config.maxFileSize,
    // Both default ON: the indexer treats only an explicit `false` as
    // disabled, so an unset field reads as enabled in the UI.
    enableBiomarkers: config.enableBiomarkers !== false,
    enableCoChange: config.enableCoChange !== false,
  };
}

/**
 * Mask credentials before the read-only database panel echoes the config
 * to the browser. A PostgreSQL `url` typically embeds `user:password@`,
 * and a `?password=` query param is also possible — anyone who can open
 * the viewer would otherwise see the DB password. Provider / schema /
 * pgvector stay visible for diagnostics. Exported for testing.
 */
export function redactUrlCredentials(url: string): string {
  return url.replace(/(\/\/[^:/@]*:)[^@/]+(@)/, '$1***$2').replaceAll(/([?&](?:password|pass|pwd)=)[^&]+/gi, '$1***');
}

/** Build the read-only database summary from an ALLOWLIST of known fields
 *  (provider, redacted url, schema, pgvector). The database config schema
 *  is `.loose()`, so unknown extra keys could carry sensitive values;
 *  returning only the allowlisted fields keeps them off the wire.
 *  Exported for testing. */
export function redactDatabase(db: CartographConfig['database']): unknown {
  if (!db) return null;
  const safe: Record<string, unknown> = {};
  if (db.provider !== undefined) safe['provider'] = db.provider;
  if (typeof db.url === 'string' && db.url !== '') safe['url'] = redactUrlCredentials(db.url);
  if (db.schema !== undefined) safe['schema'] = db.schema;
  if (db.pgvector !== undefined) safe['pgvector'] = db.pgvector;
  return safe;
}

// GET /api/config — always available (read-only display works even when
// editing is disallowed; the client hides the controls on allowConfigEdit:false).
export function handleConfigGet(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext): void {
  let config: CartographConfig;
  try {
    config = loadConfig(ctx.projectPath);
  } catch (err) {
    sendJson(res, HTTP_INTERNAL_ERROR, { error: `failed to load config: ${errMsg(err)}` });
    return;
  }
  sendJson(res, HTTP_OK, {
    allowConfigEdit: ctx.allowConfigEdit,
    reindexing: isReindexInProgress(),
    config: curatedFrom(config),
    database: redactDatabase(config.database),
    maxFileSizeCap: MAX_INDEX_FILE_SIZE,
    maxFileSizeCapLabel: MAX_INDEX_FILE_SIZE_LABEL,
  });
}

// POST /api/config — validate, whitelist, persist.
export async function handleConfigPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  if (!ctx.allowConfigEdit) {
    sendJson(res, HTTP_FORBIDDEN, { error: CONFIG_EDIT_DISABLED_MSG });
    return;
  }
  // Refuse to save while a re-index is running: indexAll/sync re-read
  // config at job start, so a write that lands mid-run would not be
  // applied by that job, leaving config.json and the graph out of sync.
  if (isReindexInProgress()) {
    sendJson(res, HTTP_CONFLICT, { error: 'a re-index is running — wait for it to finish before saving config' });
    return;
  }
  const body = await readBodyOr400(req, res, CONFIG_BODY_BYTE_LIMIT);
  if (body === null) return;

  const parsed = parseJsonObject(body);
  if (!parsed.ok) {
    if (parsed.reason === 'not-object') {
      sendJson(res, HTTP_BAD_REQUEST, { error: 'body must be a JSON object' });
      return;
    }
    sendJson(res, HTTP_BAD_REQUEST, { error: 'invalid JSON body' });
    return;
  }
  const parsedBody = curatedConfigBodySchema.safeParse(parsed.value);
  if (!parsedBody.success) {
    sendJson(res, HTTP_BAD_REQUEST, { error: 'body must be a JSON object' });
    return;
  }

  const validated = validateCuratedInput(parsedBody.data);
  if (!validated.ok) {
    sendJson(res, HTTP_BAD_REQUEST, { error: validated.error });
    return;
  }

  let current: CartographConfig;
  try {
    current = loadConfig(ctx.projectPath);
  } catch (err) {
    sendJson(res, HTTP_INTERNAL_ERROR, { error: `failed to load current config: ${errMsg(err)}` });
    return;
  }

  // Overlay ONLY the curated fields onto the freshly-loaded config. The
  // database / llm / rootDir / version blocks come from `current`, never
  // the client body — that is the whitelist guarantee.
  const merged: CartographConfig = { ...current, ...validated.value };

  // The feature toggles default ON when unset (the hook treats only an
  // explicit `false` as off), and the form re-submits that as an explicit
  // `true`. Don't persist that: a no-op save would otherwise write
  // `enableX: true` where the config had nothing — churning config.json
  // and reading as a spurious "reindex" change. Keep the field unset.
  if (merged.enableBiomarkers === true && current.enableBiomarkers === undefined) delete merged.enableBiomarkers;
  if (merged.enableCoChange === true && current.enableCoChange === undefined) delete merged.enableCoChange;

  // Validation failure is the client's fault → 400. Use a relative label
  // (not the absolute config path) so the echoed message never leaks the
  // user's filesystem layout to the browser.
  try {
    assertValidCartographConfig(CONFIG_DISPLAY_PATH, merged);
  } catch (err) {
    sendJson(res, HTTP_BAD_REQUEST, { error: errMsg(err) });
    return;
  }
  // Persistence failure (ENOSPC / EACCES / …) is a server fault → 500,
  // with a generic message rather than a raw I/O error string.
  try {
    saveConfig(ctx.projectPath, merged);
  } catch (err) {
    logDebug('viewer: saveConfig failed', { err: errMsg(err) });
    sendJson(res, HTTP_INTERNAL_ERROR, { error: 'failed to write config' });
    return;
  }
  sendJson(res, HTTP_OK, { ok: true, applyClass: classifyConfigChange(current, merged) });
}

// POST /api/reindex — stream an in-process index/sync as SSE.
export async function handleReindex(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  if (!ctx.allowConfigEdit) {
    sendJson(res, HTTP_FORBIDDEN, { error: CONFIG_EDIT_DISABLED_MSG });
    return;
  }
  const body = await readBodyOr400(req, res, CONFIG_REINDEX_BODY_BYTE_LIMIT);
  if (body === null) return;

  const mode = parseReindexMode(body);
  if (mode === null) {
    sendJson(res, HTTP_BAD_REQUEST, { error: "mode must be 'index' or 'sync'" });
    return;
  }

  // Single-flight: a fast in-process 409 instead of contending on the
  // index file-lock. Acquire BEFORE switching to the SSE response so the
  // 409 can still be a normal JSON error.
  if (!tryBeginReindexJob()) {
    sendJson(res, HTTP_CONFLICT, { error: 'a re-index is already running' });
    return;
  }

  let cg: Awaited<ReturnType<typeof ensureCartograph>>;
  try {
    cg = await ensureCartograph(ctx);
  } catch (err) {
    endReindexJob();
    sendJson(res, HTTP_INTERNAL_ERROR, { error: `failed to open project: ${errMsg(err)}` });
    return;
  }

  await streamReindexJob({ req, res, ctx, cg, mode });
}

type ReindexMode = 'index' | 'sync';

const reindexModeBodySchema = z.looseObject({
  mode: z.enum(['index', 'sync']),
});

interface ReindexJob {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  ctx: RequestContext;
  cg: Awaited<ReturnType<typeof ensureCartograph>>;
  mode: ReindexMode;
}

function parseReindexMode(body: string): ReindexMode | null {
  const parsed = parseJsonObject(body);
  if (!parsed.ok || !Object.hasOwn(parsed.value, 'mode')) return null;
  const result = reindexModeBodySchema.safeParse(parsed.value);
  return result.success ? result.data.mode : null;
}

/** Switch the response to an event stream and run the job. Once the SSE
 *  headers are out, every outcome (including failure) is an SSE frame —
 *  never a JSON status code. Always releases the single-flight guard. */
async function streamReindexJob(job: ReindexJob): Promise<void> {
  const { res, ctx } = job;
  // Run everything INSIDE the try — including writeHead — so a synchronous
  // throw there (headers already sent, socket already closed) still hits
  // `finally` and releases the single-flight guard. Otherwise one failed
  // writeHead would leak the guard and wedge every later re-index at 409.
  //
  // The job is deliberately NOT aborted when the client disconnects: a full
  // `clearStructural` index clears the structural tables before rebuilding,
  // so aborting mid-run could leave a partial / empty index. Letting it run
  // to completion is the safe choice — the single-flight guard prevents
  // pile-up, and the user just reloads to see the result.
  try {
    res.writeHead(HTTP_OK, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    await runReindex(job);
  } catch (err) {
    writeSseEvent(res, 'error', { message: errMsg(err) });
  } finally {
    endReindexJob();
    // The viewer's read cache (ctx.queries node/name LRU) is now stale —
    // the reindex wrote through cg's own connection. Drop it so the
    // frontend's follow-up reads reflect the new graph.
    ctx.queries.nodeCache.clear();
    if (!res.writableEnded) res.end();
  }
}

/** Distinguish indexAll's two `success:false` cases: lock contention
 *  (the lock couldn't be acquired, so nothing ran — retry later) vs a
 *  genuine failure. The contention path carries the sentinel lock-acquire
 *  error message (see `cgRunIndexUnderLock` in src/index.ts). Exported for
 *  testing. */
export function isLockContentionResult(errors: ReadonlyArray<{ message: string }>): boolean {
  return errors.some((e) => /acquire file lock/i.test(e.message));
}

async function runReindex(job: ReindexJob): Promise<void> {
  const { cg, mode, res } = job;
  const onProgress = (progress: IndexProgress): void => writeSseEvent(res, 'progress', progress);
  if (mode === 'index') {
    const result = await cg.indexAll({ onProgress, clearStructural: true, summarize: false });
    if (!result.success) {
      // indexAll returns success:false BOTH for lock contention (the lock
      // couldn't be acquired, nothing ran) and for a genuine failure
      // (0 files indexed with errors). Only the former is "busy / retry";
      // the latter is a real error the user should see.
      if (isLockContentionResult(result.errors)) {
        writeSseEvent(res, 'busy', { message: BUSY_MESSAGE });
      } else {
        const detail = result.errors.find((e) => e.severity === 'error')?.message ?? 'no files could be indexed';
        writeSseEvent(res, 'error', { message: `re-index failed: ${detail}` });
      }
      return;
    }
    writeSseEvent(res, 'done', {
      mode,
      filesIndexed: result.filesIndexed,
      filesSkipped: result.filesSkipped,
      filesErrored: result.filesErrored,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      durationMs: result.durationMs,
    });
    return;
  }
  const result = await cg.sync({ onProgress });
  if (result.lockContention) {
    writeSseEvent(res, 'busy', { message: BUSY_MESSAGE });
    return;
  }
  writeSseEvent(res, 'done', {
    mode,
    filesChecked: result.filesChecked,
    filesAdded: result.filesAdded,
    filesModified: result.filesModified,
    filesRemoved: result.filesRemoved,
    nodesUpdated: result.nodesUpdated,
    durationMs: result.durationMs,
  });
}

async function readBodyOr400(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  byteLimit: number,
): Promise<string | null> {
  try {
    return await readBody(req, byteLimit);
  } catch (err) {
    const msg = errMsg(err);
    sendJson(res, msg === 'body too large' ? HTTP_PAYLOAD_TOO_LARGE : HTTP_BAD_REQUEST, { error: msg });
    return null;
  }
}

/**
 * Validate + collect the whitelisted curated fields present in the body.
 * One table-driven pass: each present field is parsed and, on success,
 * written to `overrides` via its (concretely-typed) setter; the first
 * failure short-circuits with that field's error.
 */
function validateCuratedInput(input: Record<string, unknown>): FieldResult<Partial<CartographConfig>> {
  const overrides: Partial<CartographConfig> = {};
  const steps: ReadonlyArray<() => string | null> = [
    () =>
      pickField({
        input,
        key: 'include',
        parse: (v) => parseGlobList(v, 'include'),
        set: (val) => {
          overrides.include = val;
        },
      }),
    () =>
      pickField({
        input,
        key: 'exclude',
        parse: (v) => parseGlobList(v, 'exclude'),
        set: (val) => {
          overrides.exclude = val;
        },
      }),
    () =>
      pickField({
        input,
        key: 'maxFileSize',
        parse: parseMaxFileSize,
        set: (val) => {
          overrides.maxFileSize = val;
        },
      }),
    () =>
      pickField({
        input,
        key: 'enableBiomarkers',
        parse: (v) => parseBool(v, 'enableBiomarkers'),
        set: (val) => {
          overrides.enableBiomarkers = val;
        },
      }),
    () =>
      pickField({
        input,
        key: 'enableCoChange',
        parse: (v) => parseBool(v, 'enableCoChange'),
        set: (val) => {
          overrides.enableCoChange = val;
        },
      }),
  ];
  for (const step of steps) {
    const error = step();
    if (error !== null) return { ok: false, error };
  }
  return { ok: true, value: overrides };
}

interface PickFieldSpec<T> {
  input: Record<string, unknown>;
  key: string;
  parse: (value: unknown) => FieldResult<T>;
  set: (value: T) => void;
}

/** Parse one optional curated field. Returns an error string (→ 400) or
 *  null; on success calls `set` with the concretely-typed value. */
function pickField<T>(spec: PickFieldSpec<T>): string | null {
  const { input, key, parse, set } = spec;
  if (!Object.hasOwn(input, key)) return null;
  const r = parse(input[key]);
  if (!r.ok) return r.error;
  set(r.value);
  return null;
}

function parseGlobList(value: unknown, field: string): FieldResult<string[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be an array of strings` };
  if (value.length > CONFIG_GLOB_LIST_LIMIT) {
    return { ok: false, error: `${field} has too many entries (max ${CONFIG_GLOB_LIST_LIMIT})` };
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, error: `${field} must contain only strings` };
    const trimmed = item.trim();
    if (!trimmed) continue; // drop blank textarea lines
    if (trimmed.length > CONFIG_GLOB_CHAR_LIMIT) {
      return { ok: false, error: `${field} entry exceeds ${CONFIG_GLOB_CHAR_LIMIT} characters` };
    }
    out.push(trimmed);
  }
  return { ok: true, value: out };
}

function parseMaxFileSize(value: unknown): FieldResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: 'maxFileSize must be an integer number of bytes' };
  }
  if (value < 1 || value > MAX_INDEX_FILE_SIZE) {
    return {
      ok: false,
      error: `maxFileSize must be between 1 and ${MAX_INDEX_FILE_SIZE} bytes (${MAX_INDEX_FILE_SIZE_LABEL})`,
    };
  }
  return { ok: true, value };
}

function parseBool(value: unknown, field: string): FieldResult<boolean> {
  if (typeof value !== 'boolean') return { ok: false, error: `${field} must be a boolean` };
  return { ok: true, value };
}
