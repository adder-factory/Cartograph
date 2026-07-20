/**
 * Hook worker — runs the index-hook phase (centrality, biomarkers,
 * churn, co-change, …) in a SEPARATE PROCESS so the CPU-bound
 * synchronous passes never block the main event loop.
 *
 * THE BUG THIS FIXES
 * ------------------
 * `runAfterSync` / `runAfterIndexAll` walk ~15 derived-signal hooks.
 * Several are heavy *synchronous* compute — `centrality` runs PageRank
 * over the whole edge graph; `biomarkers` re-parses files and runs
 * clone detection. Run on the main thread (inside `Cartograph.sync`),
 * they freeze the event loop: an MCP server cannot answer tool calls,
 * and the `setTimeout`-based hook / auto-sync timeouts cannot even
 * fire — their callbacks queue behind the blocked loop. Running the
 * whole phase out-of-process keeps the main loop free; the main
 * thread's `await` on the child reply is genuinely async.
 *
 * WHY A FORKED CHILD PROCESS, NOT A `worker_threads` WORKER
 * ---------------------------------------------------------
 * The live `cartograph serve --mcp` runs under `tsx`. A `worker_threads`
 * Worker spawned from a tsx process does NOT inherit tsx's `.js`→`.ts`
 * module resolver — it can transform the entry `.ts` (Node's native
 * type-stripping) but then fails the entry's `.js`-suffixed relative
 * imports (`import '../db/index.js'`). A `child_process.fork`'d child
 * launched with the parent's loader flags in `execArgv` is a fresh
 * Node *main* process, so tsx activates fully (resolver included).
 * That is the deciding constraint behind the fork-over-Worker choice.
 *
 * DB ACCESS
 * ---------
 * The child opens its OWN connection to the same
 * `.cartograph/cartograph.db`. WAL mode lets the main process keep
 * READING (serving tool calls) while this child WRITES hook results.
 * The child opens with `autoMigrate: false` — it must never migrate:
 * the main process already did, and a migration here would race the
 * live connection. The child runs while the main process holds
 * `lock.file`; it deliberately does NOT take its own file lock — that
 * lock keeps OTHER projects' processes out, and this child is a
 * helper of the holder, not a competitor.
 *
 * The connection is opened per phase and closed in the `finally`, so a
 * long-lived child never pins a stale schema between syncs.
 */

import { DatabaseConnection } from '../db/index.js';
import { QueryBuilder } from '../db/queries.js';
import { runAfterSync, runAfterIndexAll } from './registry.js';
import type { IndexHookContext, IndexHookOutcome } from './types.js';
import { errMsg } from '../errors.js';
import { parseHookWorkerCommand, parseHookWorkerReply, type HookWorkerWireOutcome } from './hook-worker-contract.js';

// Emscripten prints `Aborted()` straight to stderr when a WASM grammar
// aborts (the biomarker pass re-parses files). The child's stderr is
// inherited by the parent, so each abort would leak a noise line even
// though the JS layer handles the failure. Filter those specific lines
// at the source — mirrors `src/extraction/parse-worker.ts`.
{
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (s.startsWith('Aborted(') || s.includes('Build with -sASSERTIONS for more info')) {
      // Honour the Writable contract — callbacks must still fire.
      if (typeof encoding === 'function') encoding();
      else if (cb) cb();
      return true;
    }
    if (typeof encoding === 'function') return realWrite(chunk, encoding);
    return realWrite(chunk, encoding, cb);
  };
}

function toWireOutcome(o: IndexHookOutcome): HookWorkerWireOutcome {
  return {
    name: o.name,
    phase: o.phase,
    durationMs: o.durationMs,
    ...(o.error ? { error: o.error.message } : {}),
  };
}

function rawMessageId(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  return Number.isInteger(id) && typeof id === 'number' && id >= 0 ? id : null;
}

function isRecord(value: unknown): value is { readonly id?: unknown } {
  return typeof value === 'object' && value !== null;
}

const send = process.send?.bind(process);
if (!send) {
  throw new Error('hook-worker.ts must be run as a forked child process (no IPC channel).');
}

process.on('message', async (raw: unknown) => {
  const msg = (() => {
    try {
      return parseHookWorkerCommand(raw);
    } catch (err) {
      const id = rawMessageId(raw);
      if (id !== null) {
        send(parseHookWorkerReply({ type: 'hooks-error', id, message: errMsg(err) }));
      }
      return null;
    }
  })();
  if (msg === null) return;
  let db: DatabaseConnection | null = null;
  try {
    // `autoMigrate: false` — see the file header. A schema-behind DB
    // throws here; the catch surfaces it as a phase error and the next
    // sync respawns the child rather than silently migrating.
    db = DatabaseConnection.open(msg.dbPath, { database: msg.config.database });
    const queries = new QueryBuilder(db.getDb(), db.hasVecExtension());
    const ctx: IndexHookContext = {
      projectRoot: msg.projectRoot,
      config: msg.config,
      queries,
      db,
    };
    const outcomes = msg.phase === 'sync' ? await runAfterSync(ctx, msg.syncResult) : await runAfterIndexAll(ctx);
    send(parseHookWorkerReply({ type: 'hooks-done', id: msg.id, outcomes: outcomes.map(toWireOutcome) }));
  } catch (err) {
    send(parseHookWorkerReply({ type: 'hooks-error', id: msg.id, message: errMsg(err) }));
  } finally {
    try {
      db?.close();
    } catch {
      /* connection already gone — nothing to release */
    }
  }
});

// The parent IPC channel closed (server shut down or crashed) — exit
// rather than orphaning a stray hook process.
process.on('disconnect', () => process.exit(0));

// Handshake: the message listener is attached, the child is ready to
// accept a `run-hooks` request. `HookWorkerClient.ensureSpawned`
// resolves its spawn promise on this.
send(parseHookWorkerReply({ type: 'ready' }));
