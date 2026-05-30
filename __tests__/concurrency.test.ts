/**
 * `streamingDispatch` — invariance tests pinning down the
 * bounded-concurrency semantics that B12 (2026-05-23) introduced to
 * replace the per-batch `Promise.all` barrier in
 * `eoRunParseAndStoreLoop`.
 *
 * The original bug shape on microsoft/TypeScript: one 410-second
 * outlier file (`reallyLargeFile.ts`) sitting in a batch of 10
 * trapped the OTHER 9 batch members' worker slots for those 410
 * seconds, AND blocked the next batch from starting. With 6 worker
 * pool slots, 5 of them sat idle the entire time. Net effect: 87.5%
 * of the parse-phase wall-clock (~2,900 s out of 3,321 s) was
 * barrier-wait, not actual work.
 *
 * These invariance tests exist because per-file functional tests
 * NEVER catch this kind of issue — the work all happens correctly,
 * just much slower. Wall-clock + ordering assertions are the only
 * reliable way to lock the streaming behaviour in.
 *
 * Each test is a tiny synthetic load — items[] with timed `work`
 * callbacks — so they run in milliseconds and don't touch the parser
 * pool, DB, or file I/O.
 */

import { describe, it, expect } from 'vitest';
import { streamingDispatch } from '../src/concurrency.js';

/** Resolve after the requested ms. Lighter than vitest fake timers
 *  for these straightforward delay tests. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('streamingDispatch', () => {
  it('respects the maxInflight cap (never more than N items running concurrently)', async () => {
    let running = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await streamingDispatch({
      items,
      maxInflight: 5,
      work: async () => {
        running++;
        if (running > maxObserved) maxObserved = running;
        await delay(5);
        running--;
      },
    });
    expect(maxObserved).toBeLessThanOrEqual(5);
    // Must ACTUALLY have been concurrent — if maxObserved is 1 then the
    // dispatcher accidentally serialized everything and the test would
    // pass for the wrong reason.
    expect(maxObserved).toBeGreaterThan(1);
  });

  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const seen: number[] = [];
    await streamingDispatch({
      items,
      maxInflight: 4,
      work: async (i) => {
        await delay(Math.floor(Math.random() * 5));
        seen.push(i);
      },
    });
    expect(seen).toHaveLength(items.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it('does NOT let a slow item block faster items dispatched after it (the B12 regression guard)', async () => {
    // Items[0] is the slow "reallyLargeFile.ts" analog; the rest are
    // fast files dispatched right behind it. With the prior batched
    // `Promise.all` shape, every item in the same batch would resolve
    // only when item 0 resolved — they'd all share the same finish
    // timestamp. With streaming, the fast items finish in order
    // BEFORE the slow one.
    const items = Array.from({ length: 10 }, (_, i) => i);
    const completionTs = new Map<number, number>();
    const start = Date.now();
    await streamingDispatch({
      items,
      maxInflight: 5,
      work: async (i) => {
        await delay(i === 0 ? 200 : 5);
        completionTs.set(i, Date.now() - start);
      },
    });
    const slowTs = completionTs.get(0)!;
    // The slow item finishes around its own delay; fast items finish well before.
    expect(slowTs).toBeGreaterThanOrEqual(190);
    for (let i = 1; i < items.length; i++) {
      const ts = completionTs.get(i)!;
      expect(ts).toBeLessThan(slowTs);
    }
  });

  it('wall-clock is bounded by max(slowest item, fast-work / poolSize) — NOT slowest * batchCount', async () => {
    // Synthesizes the exact failure mode the prior `Promise.all`-per-
    // batch shape exhibited. With 30 items split into batches of 5
    // and a 100ms outlier in each batch, the batched shape would take
    // ~6 × 100ms = 600ms wall-clock; streaming with maxInflight=5
    // should land at ~120ms (single slow item plus fast-work tail).
    const SLOW_MS = 100;
    const FAST_MS = 5;
    const N = 30;
    // One slow item every 5 to mimic the worst case for batching.
    const items = Array.from({ length: N }, (_, i) => ({ idx: i, slow: i % 5 === 0 }));
    const start = Date.now();
    await streamingDispatch({
      items,
      maxInflight: 5,
      work: async (item) => {
        await delay(item.slow ? SLOW_MS : FAST_MS);
      },
    });
    const elapsed = Date.now() - start;
    // Lower bound: at least one slow item's duration (streaming can't
    // compress a single item's runtime).
    expect(elapsed).toBeGreaterThanOrEqual(SLOW_MS);
    // Upper bound for streaming: tightly above (slow + slack). The
    // batched shape would land near 600ms. 250ms gives generous
    // slack against CI scheduler jitter while still catching a
    // regression to the barrier.
    expect(elapsed).toBeLessThan(250);
  });

  it('aborts mid-iteration when the signal fires, drains in-flight items, and returns aborted=true', async () => {
    const ctrl = new AbortController();
    const items = Array.from({ length: 100 }, (_, i) => i);
    let dispatched = 0;
    let completed = 0;
    const ran = streamingDispatch({
      items,
      maxInflight: 4,
      signal: ctrl.signal,
      work: async () => {
        dispatched++;
        await delay(10);
        completed++;
      },
    });
    // Abort after a short delay — well before all 100 items dispatch.
    setTimeout(() => ctrl.abort(), 15);
    const { aborted } = await ran;
    expect(aborted).toBe(true);
    // Far fewer than 100 dispatched.
    expect(dispatched).toBeLessThan(items.length);
    // Every dispatched item still ran to completion (drain semantics).
    expect(completed).toBe(dispatched);
  });

  it('handles maxInflight === 1 (degenerate serial case)', async () => {
    let concurrent = 0;
    let maxObserved = 0;
    const items = [1, 2, 3, 4, 5];
    const finishOrder: number[] = [];
    await streamingDispatch({
      items,
      maxInflight: 1,
      work: async (i) => {
        concurrent++;
        if (concurrent > maxObserved) maxObserved = concurrent;
        await delay(5);
        finishOrder.push(i);
        concurrent--;
      },
    });
    expect(maxObserved).toBe(1);
    // Serial mode preserves dispatch order.
    expect(finishOrder).toEqual(items);
  });

  it('rejects with an error when work throws (still drains peers)', async () => {
    const peers: number[] = [];
    const items = [1, 2, 3, 4, 5];
    await expect(
      streamingDispatch({
        items,
        maxInflight: 3,
        work: async (i) => {
          await delay(5);
          if (i === 2) throw new Error('boom');
          peers.push(i);
        },
      }),
    ).rejects.toThrow('boom');
    // Peers dispatched before the throw still completed before the
    // outer promise rejected.
    expect(peers.length).toBeGreaterThan(0);
  });

  it('rejects when maxInflight is not >= 1', async () => {
    await expect(
      streamingDispatch({
        items: [1],
        maxInflight: 0,
        work: async () => {},
      }),
    ).rejects.toThrow(/maxInflight/);
  });

  it('returns immediately on an empty item list', async () => {
    const start = Date.now();
    const { aborted } = await streamingDispatch({
      items: [],
      maxInflight: 4,
      work: async () => {
        throw new Error('should not be called on empty input');
      },
    });
    expect(aborted).toBe(false);
    expect(Date.now() - start).toBeLessThan(20);
  });
});
