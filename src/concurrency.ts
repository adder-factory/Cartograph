/**
 * `streamingDispatch` — bounded-concurrency iterator without a batch
 * synchronization barrier.
 *
 * Walks `items` in order, keeping at most `maxInflight` promises in
 * flight at any time. When the cap is reached, awaits the FIRST in-
 * flight promise to settle (via `Promise.race`) before dispatching the
 * next item — so a slow item occupies its own slot for as long as it
 * needs, but the other slots keep flowing. Contrast with the
 * batched-`Promise.all` shape, which holds every batch member's slot
 * until the slowest member of the batch finishes (B12, 2026-05-23):
 * on microsoft/TypeScript a single 410-second outlier (`reallyLargeFile.ts`)
 * was idling 5 of 6 parse-pool workers for those 410 seconds.
 *
 * Properties guaranteed (locked by `__tests__/concurrency.test.ts`):
 *  - Concurrency never exceeds `maxInflight`. Worker pools / file-
 *    handle quotas relying on this bound stay safe.
 *  - A slow item NEVER blocks completion of a faster item dispatched
 *    AFTER it.
 *  - Returns only after every in-flight item settles, even when
 *    `signal` aborts mid-iteration. The caller's `work` function is
 *    responsible for short-circuiting cheaply on abort.
 *  - Errors from `work` reject the returned promise (after draining
 *    in-flight peers). Catch in `work` if you want errors to be
 *    per-item logs instead of fatal.
 *
 * Generic over the item type — `eoRunParseAndStoreLoop` uses it with
 * `string` file paths, but anything iterable works.
 */
export async function streamingDispatch<T>(args: {
  items: Iterable<T>;
  maxInflight: number;
  work: (item: T) => Promise<void>;
  signal?: AbortSignal | undefined;
}): Promise<{ aborted: boolean }> {
  const { items, maxInflight, work, signal } = args;
  if (maxInflight < 1) {
    throw new Error(`streamingDispatch: maxInflight must be >= 1 (got ${maxInflight})`);
  }
  const inflight = new Set<Promise<void>>();
  const errors: unknown[] = [];
  let aborted = false;

  // Wrap each work() call so:
  //  - The inflight Set entry NEVER rejects on its own — it always
  //    settles successfully, so `Promise.race(inflight)` is safe to
  //    await even when one of the in-flight work() calls threw.
  //    Without this, the .finally cleanup can remove a rejected
  //    promise from the set BEFORE any await observes it, silently
  //    swallowing the error.
  //  - Errors are captured into `errors[]` so the outer return can
  //    re-throw the first after draining peers.
  //  - The finally still runs to delete from inflight, so the size
  //    check on the next iteration sees the drained slot.
  const wrap = (item: T): Promise<void> => {
    const p: Promise<void> = Promise.resolve()
      .then(() => work(item))
      .catch((err: unknown) => {
        errors.push(err);
      })
      .finally(() => {
        inflight.delete(p);
      });
    return p;
  };

  for (const item of items) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    if (inflight.size >= maxInflight) {
      // Wait for at least one slot to free. Safe: inflight promises
      // are wrapped to never reject (errors recorded in `errors[]`).
      await Promise.race(inflight);
    }
    inflight.add(wrap(item));
  }
  // Drain remaining work even on abort, so the caller never observes
  // an unresolved promise. `work` is expected to short-circuit cheaply
  // when `signal?.aborted` is set; if it doesn't, drain time bounds at
  // the slowest remaining item.
  if (inflight.size > 0) await Promise.all(inflight);
  if (errors.length > 0) {
    // Re-throw the FIRST captured error so the caller surfaces it
    // (matches Promise.all's first-rejection semantics). Subsequent
    // errors are dropped here — in the cartograph extraction loop the
    // `work` callback already routes per-file errors into the
    // `errors[]` accumulator on the orchestrator, so an outer throw
    // is reserved for genuinely unexpected helper-level breakage.
    throw errors[0];
  }
  return { aborted: aborted || (signal?.aborted ?? false) };
}
