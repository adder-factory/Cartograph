/**
 * Concurrency / time / memory primitives.
 *
 * Extracted from `utils.ts` because the rest of utils is path /
 * string / language-predicate helpers — pure functions with no
 * runtime side effects. This file holds the stateful, time-aware,
 * I/O-touching primitives:
 *
 *   - FileLock — cross-process file lock with PID staleness check
 *   - Mutex — in-process async mutex
 *   - MemoryMonitor — interval-based heap watch with threshold callback
 *   - processInBatches — bounded-parallelism batch runner
 *   - readFileInChunks — streaming file reader (avoids loading entire file into memory)
 *   - debounce / throttle — call-rate limiters
 *
 * `utils.ts` re-exports every name here so callers don't need to update
 * import paths. Future moves can flip imports over to this file
 * directly when convenient.
 */

import * as fs from 'fs';

/** Locks older than this are considered stale regardless of PID status. */
const LOCK_STALE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Thrown when an `acquire()` finds the lock already held by a live
 * process within the staleness window. Typed (rather than a plain
 * `Error` distinguished by `message.includes(...)`) so callers and
 * the recovery path can identify the case structurally.
 *
 * The thrown message preserves the legacy "locked by another
 * process" substring — `__tests__/security.test.ts` and operator
 * runbooks regex on it.
 */
class LockHeldError extends Error {
  readonly heldByPid: number | null;
  readonly lockPath: string;
  constructor(pid: number | null, lockPath: string) {
    const pidPart = pid === null ? '' : ` (PID ${pid})`;
    super(
      `Cartograph database is locked by another process${pidPart}. ` +
        `If this is stale, run 'cartograph unlock' or delete ${lockPath}`,
    );
    this.name = 'LockHeldError';
    this.heldByPid = pid;
    this.lockPath = lockPath;
  }
}

/** Snapshot of an on-disk lock file, parsed once. */
interface LockMetadata {
  readonly pid: number;
  readonly mtimeMs: number;
}

/**
 * Read + parse the lock file. Returns null on any unrecoverable read
 * (corrupt PID, race-unlinked between exists/read, permission flap)
 * — caller treats null as "lock is unrecoverable, force-clear it",
 * which lets a broken lock self-heal rather than hard-block forever.
 */
function readLockMetadata(lockPath: string): LockMetadata | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    const pid = Number.parseInt(content, 10);
    // Reject non-positive PIDs: `parseInt` returning 0 (e.g. corrupt
    // lock containing literal "0" or non-numeric junk before the
    // first digit) would otherwise pass `Number.isFinite` and reach
    // `process.kill(0, 0)` — which on POSIX signals the current
    // process group rather than checking PID 0, permanently blocking
    // acquire() against a malformed lock file.
    if (!Number.isFinite(pid) || pid <= 0) return null;
    const stat = fs.statSync(lockPath);
    return { pid, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** True iff the recorded PID is still running AND the lock is fresh. */
function isLockHeldByLiveProcess(meta: LockMetadata): boolean {
  const ageMs = Date.now() - meta.mtimeMs;
  if (ageMs >= LOCK_STALE_TIMEOUT_MS) return false;
  return isProcessAlive(meta.pid);
}

/** `kill -0` semantics — signal 0 only checks process existence. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Tolerant unlink — swallows ENOENT-style races where the lock has
 *  already disappeared. The whole point of this codepath is "the lock
 *  is unrecoverable, get rid of it" — re-raising on a concurrent
 *  unlink would defeat that. */
function forceUnlinkLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* tolerate race */
  }
}

/**
 * Cross-process file lock using a lock file with PID tracking.
 *
 * Prevents multiple processes (e.g., git hooks, CLI, MCP server) from
 * writing to the same database simultaneously.
 */
export class FileLock {
  private lockPath: string;
  private held = false;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  /**
   * Inspect any existing lock file and decide what to do:
   *   - lock file absent                → nothing to clear, return.
   *   - lock metadata unreadable        → unrecoverable; force-clear.
   *   - held by a live process & fresh  → throw `LockHeldError`.
   *   - dead PID, parse fail, or aged   → stale; force-clear.
   *
   * The "force-clear on unrecoverable read" path lets a corrupted
   * lock file recover automatically rather than hard-blocking the
   * next acquire.
   */
  private clearStaleLockIfPresent(): void {
    if (!fs.existsSync(this.lockPath)) return;

    const meta = readLockMetadata(this.lockPath);
    if (meta === null) {
      forceUnlinkLock(this.lockPath);
      return;
    }

    if (isLockHeldByLiveProcess(meta)) {
      throw new LockHeldError(meta.pid, this.lockPath);
    }

    forceUnlinkLock(this.lockPath);
  }

  /** Acquire the lock. Throws `LockHeldError` if the lock is held by
   *  another live process (either before our exclusive-create attempt
   *  or as a race in the gap between the staleness check and the
   *  write). */
  acquire(): void {
    this.clearStaleLockIfPresent();
    try {
      fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
      this.held = true;
    } catch (err: unknown) {
      if (isErrnoCode(err, 'EEXIST')) {
        // Race: another process grabbed the lock between our
        // clearStaleLockIfPresent and the exclusive-create write.
        // Surface as the same error type as the pre-write check so
        // callers can `instanceof LockHeldError` either way.
        throw new LockHeldError(null, this.lockPath);
      }
      throw err;
    }
  }

  /** Release the lock */
  release(): void {
    if (!this.held) return;
    try {
      // Only remove if we still own it (check PID)
      const content = fs.readFileSync(this.lockPath, 'utf-8').trim();
      if (Number.parseInt(content, 10) === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Lock file already gone - that's fine
    }
    this.held = false;
  }

  /** Execute a function while holding the lock */
  withLock<T>(fn: () => T): T {
    this.acquire();
    try {
      return fn();
    } finally {
      this.release();
    }
  }

  /** Execute an async function while holding the lock */
  async withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Narrow `unknown` to a NodeJS `errno`-shaped error with the given code. */
function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

/**
 * Process items in batches to manage memory.
 *
 * @param items - Array of items to process
 * @param batchSize - Number of items per batch
 * @param processor - Function to process each item
 * @param onBatchComplete - Optional callback after each batch
 * @returns Array of results
 */
interface ProcessInBatchesArgs<T, R> {
  items: T[];
  batchSize: number;
  processor: (item: T, index: number) => Promise<R>;
  onBatchComplete?: (completed: number, total: number) => void;
}

export async function processInBatches<T, R>(args: ProcessInBatchesArgs<T, R>): Promise<R[]> {
  const { items, batchSize, processor, onBatchComplete } = args;
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, Math.min(i + batchSize, items.length));
    const batchResults = await Promise.all(batch.map((item, idx) => processor(item, i + idx)));
    results.push(...batchResults);

    if (onBatchComplete) {
      onBatchComplete(Math.min(i + batchSize, items.length), items.length);
    }

    // Allow GC between batches
    if (global.gc) {
      global.gc();
    }
  }

  return results;
}

/** Simple mutex lock for preventing concurrent operations. */
export class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  /**
   * Acquire the lock.
   *
   * @returns A release function to call when done.
   */
  async acquire(): Promise<() => void> {
    while (this.locked) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    this.locked = true;

    return () => {
      this.locked = false;
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    };
  }

  /** Execute a function while holding the lock. */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Check if the lock is currently held. */
  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * Chunked file reader for large files. Reads a file in chunks to
 * avoid loading the entire file into memory.
 */
export async function* readFileInChunks(
  filePath: string,
  chunkSize: number = 64 * 1024,
): AsyncGenerator<string, void, undefined> {
  const fsmod = await import('fs');

  const fd = fsmod.openSync(filePath, 'r');
  const buffer = Buffer.alloc(chunkSize);

  try {
    let bytesRead: number;
    while ((bytesRead = fsmod.readSync(fd, buffer, 0, chunkSize, null)) > 0) {
      yield buffer.toString('utf-8', 0, bytesRead);
    }
  } finally {
    fsmod.closeSync(fd);
  }
}

/**
 * Debounce a function.
 *
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Throttle a function.
 *
 * @param fn - Function to throttle
 * @param limit - Minimum time between calls in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number,
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = limit - (now - lastCall);

    if (remaining <= 0) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastCall = now;
      fn(...args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        fn(...args);
      }, remaining);
    }
  };
}

/** Default heap-usage threshold (MB) for MemoryMonitor when no override is supplied. */
const DEFAULT_MEMORY_THRESHOLD_MB = 500;

/** Bytes per megabyte — used to convert the MB-denominated threshold to raw bytes for `process.memoryUsage`. */
const BYTES_PER_MB = 1024 * 1024;

/** Memory monitor for tracking usage during operations. */
export class MemoryMonitor {
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private peakUsage = 0;
  private threshold: number;
  private onThresholdExceeded?: ((usage: number) => void) | undefined;

  constructor(thresholdMB: number = DEFAULT_MEMORY_THRESHOLD_MB, onThresholdExceeded?: (usage: number) => void) {
    this.threshold = thresholdMB * BYTES_PER_MB;
    this.onThresholdExceeded = onThresholdExceeded;
  }

  /** Start monitoring memory usage */
  start(intervalMs: number = 1000): void {
    this.stop();
    this.peakUsage = 0;

    this.checkInterval = setInterval(() => {
      const usage = process.memoryUsage().heapUsed;
      if (usage > this.peakUsage) {
        this.peakUsage = usage;
      }
      if (usage > this.threshold && this.onThresholdExceeded) {
        this.onThresholdExceeded(usage);
      }
    }, intervalMs);
  }

  /** Stop monitoring */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /** Get peak memory usage in bytes */
  getPeakUsage(): number {
    return this.peakUsage;
  }

  /** Get current memory usage in bytes */
  getCurrentUsage(): number {
    return process.memoryUsage().heapUsed;
  }
}
