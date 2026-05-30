/**
 * B13 (2026-05-23) — slow-parse detection regression guards.
 *
 * `renderSlowFilesSummary` is the user-facing wording contract for the
 * end-of-phase summary. The slow-file records themselves come from
 * `ParseWorkerPool.requestParse`'s in-flight timer + completion timer
 * (gated by `SLOW_PARSE_WARN_MS = 30_000`). These tests pin the
 * SUMMARY shape — the per-file timer firing is integration-tier and
 * would need a worker_threads fixture to exercise faithfully.
 *
 * Without these tests, the wording / sort / cap rules would be free to
 * drift and the user-facing surface that motivates the fix would
 * silently degrade.
 */
import { describe, it, expect } from 'vitest';
import { renderSlowFilesSummary } from '../src/extraction/extraction-phases.js';
import { SLOW_PARSE_WARN_MS, type SlowFileRecord } from '../src/extraction/parse-worker-pool.js';

function collect(): { log: (msg: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

describe('renderSlowFilesSummary (B13)', () => {
  it('is a no-op when no slow files were observed', () => {
    const { log, lines } = collect();
    renderSlowFilesSummary([], log);
    expect(lines).toEqual([]);
  });

  it('headers with the configured threshold and a count', () => {
    const { log, lines } = collect();
    const rec: SlowFileRecord = { filePath: 'a.ts', startMs: 0, status: 'done', elapsedMs: 35_000 };
    renderSlowFilesSummary([rec], log);
    expect(lines[0]).toContain(`≥${SLOW_PARSE_WARN_MS}ms`);
    expect(lines[0]).toContain('1 total');
  });

  it('ranks slowest first and renders elapsed ms left-padded', () => {
    const { log, lines } = collect();
    const recs: SlowFileRecord[] = [
      { filePath: 'medium.ts', startMs: 0, status: 'done', elapsedMs: 45_000 },
      { filePath: 'huge.ts', startMs: 0, status: 'done', elapsedMs: 410_000 },
      { filePath: 'small.ts', startMs: 0, status: 'done', elapsedMs: 31_000 },
    ];
    renderSlowFilesSummary(recs, log);
    // Header line, then 3 file lines, then the "exclude" hint.
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('huge.ts');
    expect(lines[2]).toContain('medium.ts');
    expect(lines[3]).toContain('small.ts');
  });

  it('caps the printed list at 10 rows even when more files are slow (header still reports total)', () => {
    const { log, lines } = collect();
    const recs: SlowFileRecord[] = Array.from({ length: 25 }, (_, i) => ({
      filePath: `f${i}.ts`,
      startMs: 0,
      status: 'done' as const,
      elapsedMs: 30_001 + i * 100,
    }));
    renderSlowFilesSummary(recs, log);
    // 1 header + 10 rows + 1 footer = 12 log calls
    expect(lines).toHaveLength(12);
    // Header still names the full population.
    expect(lines[0]).toContain('25 total');
    expect(lines[0]).toContain('top 10');
  });

  it('renders an inflight record as its status string (not ms)', () => {
    const { log, lines } = collect();
    const recs: SlowFileRecord[] = [
      { filePath: 'still-going.ts', startMs: Date.now(), status: 'inflight' },
      { filePath: 'finished.ts', startMs: 0, status: 'done', elapsedMs: 35_000 },
    ];
    renderSlowFilesSummary(recs, log);
    // finished sorts first (35000ms > 0 inflight).
    expect(lines[1]).toContain('finished.ts');
    expect(lines[1]).toMatch(/35000ms/);
    expect(lines[2]).toContain('still-going.ts');
    expect(lines[2]).toContain('inflight');
  });

  it('footer points the user at `.cartograph/config.json` "exclude"', () => {
    const { log, lines } = collect();
    renderSlowFilesSummary([{ filePath: 'huge.ts', startMs: 0, status: 'done', elapsedMs: 35_000 }], log);
    const footer = lines.at(-1)!;
    expect(footer).toContain('config.json');
    expect(footer).toContain('exclude');
  });
});
