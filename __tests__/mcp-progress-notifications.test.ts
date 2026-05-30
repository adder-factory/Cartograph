/**
 * MCP `notifications/progress` (B13) — long-running write tools
 * (admin sync/index, summarize, embed) emit standard progress
 * events when the client supplies a `progressToken`. Tests the
 * end-to-end thread: ToolHandler.execute(opts.onProgress) →
 * ToolCtx.reportProgress → cg.sync({ onProgress }) → callback
 * fires.
 *
 * Tests skip the LLM-bound paths (summarize / embed) — those need
 * a configured chat / embedding provider. The dispatch + callback
 * shape is identical to the verified admin paths, so the LLM
 * coverage would only re-prove what's already in the cg.llm
 * unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

interface ProgressEvent {
  current: number;
  total?: number;
  message?: string;
}

describe('MCP notifications/progress (B13)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;
  let events: ProgressEvent[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-progress-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    // Two small files so sync has something to walk on first touch
    // but the test stays fast.
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(tempDir, 'src/b.ts'), 'export function beta() { return 2; }\n');
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg);
    events = [];
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('admin sync forwards IndexProgress to onProgress', async () => {
    // Modify a file so sync has work to do.
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function alpha() { return 99; }\n');
    fs.writeFileSync(path.join(tempDir, 'src/c.ts'), 'export function gamma() { return 3; }\n');

    const result = await handler.execute(
      'cartograph_admin',
      { action: 'sync' },
      {
        onProgress: (current, total, message) => {
          events.push({
            current,
            ...(total === undefined ? {} : { total }),
            ...(message === undefined ? {} : { message }),
          });
        },
      },
    );
    expect(result.isError).toBeFalsy();
    // Progress should have fired at least once for the changed/added files.
    expect(events.length).toBeGreaterThan(0);
    // Each event carries a numeric current; phase string in message.
    for (const e of events) {
      expect(typeof e.current).toBe('number');
      expect(e.message).toMatch(/scanning|parsing|storing|resolving/);
    }
  });

  it('admin index forwards IndexProgress to onProgress', async () => {
    const result = await handler.execute(
      'cartograph_admin',
      { action: 'index', force: true },
      {
        onProgress: (current, _total, message) => {
          events.push({ current, ...(message === undefined ? {} : { message }) });
        },
      },
    );
    expect(result.isError).toBeFalsy();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.message?.includes('parsing') || e.message?.includes('storing'))).toBe(true);
  });

  it('no progress callback → no events fired (zero-cost path)', async () => {
    fs.writeFileSync(path.join(tempDir, 'src/d.ts'), 'export function delta() { return 4; }\n');
    // Execute WITHOUT opts.onProgress. The handler must run normally
    // and not crash even though ctx.reportProgress is undefined.
    const result = await handler.execute('cartograph_admin', { action: 'sync' });
    expect(result.isError).toBeFalsy();
    // Sanity: events array is bound to this test's closure, no
    // callback was wired, so zero events regardless of how many
    // files sync touched.
    expect(events).toEqual([]);
  });

  it('progress events ordered by current value (monotonic within phase)', async () => {
    fs.writeFileSync(path.join(tempDir, 'src/e.ts'), 'export function epsilon() { return 5; }\n');
    fs.writeFileSync(path.join(tempDir, 'src/f.ts'), 'export function zeta() { return 6; }\n');
    fs.writeFileSync(path.join(tempDir, 'src/g.ts'), 'export function eta() { return 7; }\n');

    await handler.execute(
      'cartograph_admin',
      { action: 'sync' },
      {
        onProgress: (current, total, message) => {
          events.push({
            current,
            ...(total === undefined ? {} : { total }),
            ...(message === undefined ? {} : { message }),
          });
        },
      },
    );
    // Group events by phase, assert monotonic-or-equal within each
    // phase's run. Per-phase resets are fine (parsing's current
    // restarts from 0 after scanning's current=N); the property
    // we want is "within a phase, current never goes backwards".
    const byPhase = new Map<string, ProgressEvent[]>();
    for (const e of events) {
      const phase = e.message?.split(':')[0]?.trim() ?? 'unknown';
      const arr = byPhase.get(phase) ?? [];
      arr.push(e);
      byPhase.set(phase, arr);
    }
    for (const [, phaseEvents] of byPhase) {
      for (let i = 1; i < phaseEvents.length; i++) {
        expect(phaseEvents[i]!.current).toBeGreaterThanOrEqual(phaseEvents[i - 1]!.current);
      }
    }
  });
});
