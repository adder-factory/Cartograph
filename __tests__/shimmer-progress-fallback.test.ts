/**
 * Unit tests for the text-mode progress fallback (#41). The fallback
 * runs when the shimmer worker can't load (tsx-from-source) or when
 * stdout isn't a TTY (`npm run summarize > log.txt`, CI pipes, MCP
 * stdio). Without it, long-running summarize/embed runs produced
 * "ONE log line and silence" — diagnosis confirmed in friction
 * tracker #41.
 *
 * The fallback is deterministic on its own: every call to onProgress
 * uses Date.now(). bun:test has `setSystemTime` (we drive it
 * explicitly between assertions) but no fake-timer support for
 * setTimeout / setInterval — which is fine here because the fallback
 * doesn't schedule timers; it just reads Date.now() per call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setSystemTime, spyOn, type Mock } from 'bun:test';
import { createTextProgressFallback } from '../src/ui/shimmer-progress.js';

const START = new Date('2026-05-09T00:00:00Z');

describe('createTextProgressFallback (#41)', () => {
  let stderrSpy: Mock<typeof process.stderr.write>;
  let lines: string[];
  let now: number;

  beforeEach(() => {
    setSystemTime(START);
    now = START.getTime();
    lines = [];
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setSystemTime(); // restore real clock
  });

  /** Advance the system clock by `ms` milliseconds. The fallback only
   *  reads Date.now() — no setTimeout — so a clock jump is sufficient. */
  function advance(ms: number): void {
    now += ms;
    setSystemTime(new Date(now));
  }

  it('emits a line on the first onProgress call (phase start)', () => {
    const progress = createTextProgressFallback();
    progress.onProgress({ phase: 'parsing', current: 0, total: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[Parsing code]');
    expect(lines[0]).toContain('starting');
    expect(lines[0]!.endsWith('\n')).toBe(true);
  });

  it('emits a line on phase change without waiting for the heartbeat', () => {
    const progress = createTextProgressFallback();
    progress.onProgress({ phase: 'parsing', current: 0, total: 0 });
    expect(lines).toHaveLength(1);
    // 1ms later — phase change still emits.
    advance(1);
    progress.onProgress({ phase: 'storing', current: 0, total: 0 });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('[Storing data]');
  });

  it('throttles within-phase emits to the heartbeat interval', () => {
    const progress = createTextProgressFallback();
    progress.onProgress({ phase: 'parsing', current: 0, total: 100 });
    expect(lines).toHaveLength(1);

    // Two updates inside the 5-second heartbeat — only the first emit counts.
    advance(1_000);
    progress.onProgress({ phase: 'parsing', current: 10, total: 100 });
    advance(1_000);
    progress.onProgress({ phase: 'parsing', current: 20, total: 100 });
    expect(lines).toHaveLength(1);

    // Cross the heartbeat — next call emits.
    advance(4_000);
    progress.onProgress({ phase: 'parsing', current: 50, total: 100 });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('50/100');
    expect(lines[1]).toContain('(50%)');
  });

  it('renders an ETA based on elapsed-vs-progress rate', () => {
    const progress = createTextProgressFallback();
    // Initial call at t=0 — phase starts.
    progress.onProgress({ phase: 'parsing', current: 0, total: 100 });
    // 10s later, 25 of 100 done. Rate = 25/10s; remaining 75 → ~30s eta.
    advance(10_000);
    progress.onProgress({ phase: 'parsing', current: 25, total: 100 });
    expect(lines).toHaveLength(2);
    const last = lines[1]!;
    expect(last).toContain('25/100');
    expect(last).toContain('(25%)');
    expect(last).toContain('eta');
    // 75 / 2.5 per second = 30 seconds.
    expect(last).toContain('30s');
  });

  it('omits the ETA when total is unknown (counter-only mode)', () => {
    const progress = createTextProgressFallback();
    progress.onProgress({ phase: 'scanning', current: 1, total: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1 found');
    expect(lines[0]).not.toContain('eta');
  });

  it('omits the ETA when finished (current === total)', () => {
    const progress = createTextProgressFallback();
    progress.onProgress({ phase: 'parsing', current: 0, total: 100 });
    advance(10_000);
    progress.onProgress({ phase: 'parsing', current: 100, total: 100 });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('100/100');
    expect(lines[1]).toContain('(100%)');
    expect(lines[1]).not.toContain('eta');
  });
});
