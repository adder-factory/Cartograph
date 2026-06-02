import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileLock,
  MemoryMonitor,
  Mutex,
  debounce,
  isProcessAlive,
  processInBatches,
  readFileInChunks,
  throttle,
} from '../src/utils-concurrency.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-utils-concurrency-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('FileLock', () => {
  it('acquires and releases a lock file owned by this process', () => {
    const lockPath = path.join(makeTempDir(), 'cartograph.lock');
    const lock = new FileLock(lockPath);

    lock.acquire();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('withLock releases even when the callback throws', () => {
    const lockPath = path.join(makeTempDir(), 'cartograph.lock');
    const lock = new FileLock(lockPath);

    expect(() =>
      lock.withLock(() => {
        expect(fs.existsSync(lockPath)).toBe(true);
        throw new Error('callback failed');
      }),
    ).toThrow('callback failed');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('withLockAsync releases after an awaited callback', async () => {
    const lockPath = path.join(makeTempDir(), 'cartograph.lock');
    const lock = new FileLock(lockPath);

    const value = await lock.withLockAsync(async () => {
      await delay(1);
      return 'done';
    });

    expect(value).toBe('done');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('rejects a fresh live-process lock and names the owning pid', () => {
    const lockPath = path.join(makeTempDir(), 'cartograph.lock');
    fs.writeFileSync(lockPath, String(process.pid));

    expect(() => new FileLock(lockPath).acquire()).toThrow(/locked by another process.*PID/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('clears corrupt and stale lock files before acquiring', () => {
    const dir = makeTempDir();
    const corruptPath = path.join(dir, 'corrupt.lock');
    fs.writeFileSync(corruptPath, 'not-a-pid');
    const corrupt = new FileLock(corruptPath);
    corrupt.acquire();
    expect(fs.readFileSync(corruptPath, 'utf8')).toBe(String(process.pid));
    corrupt.release();

    const stalePath = path.join(dir, 'stale.lock');
    fs.writeFileSync(stalePath, '1');
    const old = new Date(Date.now() - 3 * 60 * 1000);
    fs.utimesSync(stalePath, old, old);
    const stale = new FileLock(stalePath);
    stale.acquire();
    expect(fs.readFileSync(stalePath, 'utf8')).toBe(String(process.pid));
    stale.release();
  });
});

describe('processInBatches', () => {
  it('processes batches in order and reports completion counts', async () => {
    const completed: Array<[number, number]> = [];
    const seenIndexes: number[] = [];

    const result = await processInBatches({
      items: [10, 20, 30, 40, 50],
      batchSize: 2,
      processor: async (item, index) => {
        seenIndexes.push(index);
        return item + index;
      },
      onBatchComplete: (done, total) => completed.push([done, total]),
    });

    expect(result).toEqual([10, 21, 32, 43, 54]);
    expect(seenIndexes).toEqual([0, 1, 2, 3, 4]);
    expect(completed).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it('uses global gc between batches when available', async () => {
    const priorGc = globalThis.gc;
    let gcCalls = 0;
    globalThis.gc = () => {
      gcCalls++;
    };
    try {
      await processInBatches({
        items: [1, 2, 3],
        batchSize: 1,
        processor: async (x) => x,
      });
      expect(gcCalls).toBe(3);
    } finally {
      globalThis.gc = priorGc;
    }
  });
});

describe('Mutex', () => {
  it('serializes concurrent withLock calls and exposes lock state', async () => {
    const mutex = new Mutex();
    const events: string[] = [];

    const first = mutex.withLock(async () => {
      events.push('first:start');
      expect(mutex.isLocked()).toBe(true);
      await delay(10);
      events.push('first:end');
    });
    const second = mutex.withLock(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(mutex.isLocked()).toBe(false);
  });
});

describe('readFileInChunks', () => {
  it('yields every chunk and closes the file descriptor on early break', async () => {
    const file = path.join(makeTempDir(), 'large.txt');
    fs.writeFileSync(file, 'abcdefghi');

    const chunks: string[] = [];
    for await (const chunk of readFileInChunks(file, 3)) {
      chunks.push(chunk);
      if (chunks.length === 2) break;
    }

    expect(chunks).toEqual(['abc', 'def']);
    fs.unlinkSync(file);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('debounce and throttle', () => {
  it('debounce keeps only the last call in the delay window', async () => {
    const calls: string[] = [];
    const fn = debounce((value: string) => calls.push(value), 10);

    fn('first');
    fn('second');
    fn('third');
    await delay(25);

    expect(calls).toEqual(['third']);
  });

  it('throttle runs immediately, coalesces pending calls, and allows a later immediate call', async () => {
    const calls: string[] = [];
    const fn = throttle((value: string) => calls.push(value), 20);

    fn('first');
    fn('second');
    fn('third');
    await delay(30);
    await delay(25);
    fn('fourth');

    expect(calls).toEqual(['first', 'second', 'fourth']);
  });
});

describe('MemoryMonitor', () => {
  it('tracks peak usage and invokes the threshold callback', async () => {
    const seen: number[] = [];
    const monitor = new MemoryMonitor(0, (usage) => seen.push(usage));

    monitor.start(1);
    await delay(10);
    monitor.stop();

    expect(monitor.getCurrentUsage()).toBeGreaterThan(0);
    expect(monitor.getPeakUsage()).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('isProcessAlive', () => {
  it('returns true for this process and false for an invalid pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_647)).toBe(false);
  });
});
