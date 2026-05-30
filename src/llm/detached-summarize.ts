/**
 * Detached background summarization.
 *
 * Base indexing (`admin index`) is fast — seconds. The LLM summary
 * pass is the slow tail (minutes). To keep the CLI from making a
 * first-run user sit and wait, `admin index` finishes the base graph,
 * then hands the summary pass to a DETACHED child process and returns
 * immediately. The child outlives the parent CLI and writes summaries
 * into the same `.cartograph/` SQLite DB as they land.
 *
 * Observability: the child's pid is recorded in `.cartograph/summarize.pid`;
 * `getDetachedSummarizeState` liveness-checks it so `status` can report
 * "background summarization running" vs idle. Progress itself is the
 * summary-coverage delta in the DB — summaries persist incrementally,
 * so `cartograph status` reflects how far the pass has got.
 *
 * Why a separate process and not an in-process background pass: a CLI
 * process exits when its command returns, which would kill any
 * in-flight work. The long-lived MCP server has no such problem and
 * uses an in-process background pass instead (see `bgCtrl`).
 *
 * Single-GPU note: ONE detached process already saturates the GPU at
 * its configured sequence count — running several summary processes in
 * parallel does NOT help on one GPU (they contend for the same
 * compute). So this spawns exactly one, guarded by the pidfile.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isProcessAlive } from '../utils-concurrency.js';

/** Pidfile + log basenames under the project's `.cartograph/` dir. */
const PIDFILE_BASENAME = 'summarize.pid';
const LOGFILE_BASENAME = 'summarize.log';

function pidfilePath(projectPath: string): string {
  return path.join(projectPath, '.cartograph', PIDFILE_BASENAME);
}

function logfilePath(projectPath: string): string {
  return path.join(projectPath, '.cartograph', LOGFILE_BASENAME);
}

export interface DetachedSummarizeState {
  /** A detached summarizer recorded in the pidfile is still alive. */
  running: boolean;
  /** The recorded pid (alive or not), or null when no pidfile exists. */
  pid: number | null;
}

/**
 * Read `.cartograph/summarize.pid` and liveness-check it. A pidfile
 * pointing at a dead process (the common case after a pass finishes —
 * the child does not clean up) reports `running: false`; callers treat
 * that as idle.
 */
export function getDetachedSummarizeState(projectPath: string): DetachedSummarizeState {
  let raw: string;
  try {
    raw = fs.readFileSync(pidfilePath(projectPath), 'utf-8').trim();
  } catch {
    return { running: false, pid: null };
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null };
  return { running: isProcessAlive(pid), pid };
}

export interface SpawnDetachedSummarizeResult {
  /** True when a new detached process was started. */
  spawned: boolean;
  /** The detached child's pid (when spawned) or the live prior one. */
  pid: number | null;
  /** Set when `spawned` is false — why nothing was started. */
  reason?: string;
  /** Absolute path the child's stdout/stderr is redirected to. */
  logPath: string;
}

/**
 * Spawn a detached `cartograph admin summarize <projectPath> --quiet`
 * that outlives this process. Idempotent-ish: if the pidfile names a
 * still-running summarizer, no second process is started (one already
 * saturates the GPU).
 *
 * The child re-invokes the SAME CLI entrypoint that launched the
 * parent (`process.execPath` + `process.execArgv` + `process.argv[1]`),
 * so it works both for the built `dist/bin/cartograph.js` and a
 * `bun src/bin/cartograph.ts` dev run.
 */
export function spawnDetachedSummarize(projectPath: string): SpawnDetachedSummarizeResult {
  const logPath = logfilePath(projectPath);
  const prior = getDetachedSummarizeState(projectPath);
  if (prior.running) {
    return { spawned: false, pid: prior.pid, reason: `already running (pid ${prior.pid})`, logPath };
  }

  // Redirect the child's output to a log file — a detached process has
  // no terminal, and a crash trace there is the only post-mortem.
  const logFd = fs.openSync(logPath, 'w');
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1]!, 'admin', 'summarize', projectPath, '--quiet'],
      { detached: true, stdio: ['ignore', logFd, logFd] },
    );
    child.unref();
    const pid = child.pid ?? null;
    if (pid !== null) {
      // Best-effort: a reader liveness-checks this, so a stale pidfile
      // left after the child exits is harmless.
      fs.writeFileSync(pidfilePath(projectPath), String(pid), 'utf-8');
    }
    return { spawned: true, pid, logPath };
  } finally {
    fs.closeSync(logFd);
  }
}
