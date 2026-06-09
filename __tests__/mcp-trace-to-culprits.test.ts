/**
 * cartograph_trace_to_culprits (#11). Two layers:
 *  - parseTrace: pure-function, multi-format stack-trace extractor.
 *  - end-to-end: spin a fixture, run tool, assert culprits + reasons.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { parseTrace } from '../src/mcp/tools/trace-to-culprits.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('parseTrace — multi-format', () => {
  it('extracts V8 / Node frames in order', () => {
    const trace = `
Error: kaboom
    at handleRequest (src/server.ts:42:13)
    at processIncoming (src/server.ts:88:9)
    at Server.<anonymous> (/abs/path/src/index.ts:120:5)
`;
    const frames = parseTrace(trace);
    expect(frames.map((f) => `${f.file}:${f.line}`)).toEqual([
      'src/server.ts:42',
      'src/server.ts:88',
      '/abs/path/src/index.ts:120',
    ]);
    expect(frames[0]!.rank).toBe(0);
  });

  it('extracts Python `File "x", line N` frames', () => {
    const trace = `
Traceback (most recent call last):
  File "/abs/path/foo/bar.py", line 88, in main
    handle()
  File "/abs/path/foo/handler.py", line 42, in handle
    raise ValueError
`;
    const frames = parseTrace(trace);
    expect(frames.map((f) => f.file)).toContain('/abs/path/foo/bar.py');
    expect(frames.map((f) => f.file)).toContain('/abs/path/foo/handler.py');
  });

  it('extracts Java `(File:N)` frames', () => {
    const trace = `
java.lang.RuntimeException: oops
    at com.foo.Bar.baz(Bar.java:42)
    at com.foo.Bar.qux(Bar.java:88)
`;
    const frames = parseTrace(trace);
    expect(frames.map((f) => `${f.file}:${f.line}`)).toEqual(['Bar.java:42', 'Bar.java:88']);
  });

  it('extracts Go frames', () => {
    const trace = `
goroutine 1 [running]:
main.handleRequest(...)
\t/abs/path/server.go:42 +0x1a
main.processIncoming(...)
\t/abs/path/server.go:88 +0x42
`;
    const frames = parseTrace(trace);
    expect(frames.map((f) => `${f.file}:${f.line}`)).toEqual(['/abs/path/server.go:42', '/abs/path/server.go:88']);
  });

  it('dedupes (file, line) pairs across regexes', () => {
    // The Java pattern AND the generic suffix pattern both match
    // `Bar.java:42`; the parser should emit only one frame.
    const trace = `at com.foo.Bar.baz(Bar.java:42)`;
    const frames = parseTrace(trace);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.file).toBe('Bar.java');
  });

  it('caps frames at MAX_FRAMES on a pathological trace', () => {
    // 500 generated frames; parser caps at 200.
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`  at fn (foo.ts:${i + 1}:0)`);
    const frames = parseTrace(lines.join('\n'));
    expect(frames.length).toBeLessThanOrEqual(200);
  });

  it('returns empty array on a trace with no file:line refs', () => {
    expect(parseTrace('something exploded but I forgot to print the stack')).toEqual([]);
  });

  it('normalizes Windows backslash paths', () => {
    const trace = String.raw`at fn (src\server.ts:42:13)`;
    const frames = parseTrace(trace);
    expect(frames[0]!.file).toBe('src/server.ts');
  });
});

describe('cartograph_trace_to_culprits end-to-end', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trace-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    // Fixture: two functions on different lines so the parser maps
    // each frame to its enclosing symbol via line number.
    fs.writeFileSync(
      path.join(tempDir, 'src/handler.ts'),
      [
        'export function handleRequest(): number {', // line 1
        '  return processIncoming();', // line 2
        '}', // line 3
        '', // line 4
        'export function processIncoming(): number {', // line 5
        '  throw new Error("kaboom");', // line 6
        '}', // line 7
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('maps a V8 trace to the enclosing symbols, top-of-stack ranked first', async () => {
    // Stack trace points line 6 (inside processIncoming) and line 2 (inside handleRequest).
    const trace = [
      'Error: kaboom',
      '    at processIncoming (src/handler.ts:6:9)',
      '    at handleRequest (src/handler.ts:2:9)',
    ].join('\n');
    const text = textOf(await handler.runHandler('cartograph_trace_to_culprits', { trace }));
    expect(text).toContain('Trace analysis');
    expect(text).toContain('processIncoming');
    expect(text).toContain('handleRequest');
    // Top-of-stack lands above the second frame.
    const procIdx = text.indexOf('processIncoming');
    const handIdx = text.indexOf('handleRequest');
    expect(procIdx).toBeLessThan(handIdx);
    // Reason annotations present.
    expect(text).toContain('top of stack');
    expect(text).toContain('stack frame 2');
  });

  it('reports unmapped frames in the footer when the file is not indexed', async () => {
    const trace = ['Error: x', '    at unknownFn (node_modules/foo/bar.js:10:5)'].join('\n');
    const text = textOf(await handler.runHandler('cartograph_trace_to_culprits', { trace }));
    // Locks the H2 "Trace analysis" heading on the empty-candidates
    // path — batch-17 reviewer round 1 caught a regression where the
    // heading was silently dropped when no frames mapped. The spec's
    // emptyState now embeds the title; this end-to-end test catches
    // any future drop.
    expect(text).toContain('Trace analysis');
    expect(text).toContain('Frames not mapped');
    expect(text).toContain('node_modules/foo/bar.js:10');
  });

  it('returns a clear error message when the trace has no file:line refs', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_trace_to_culprits', {
        trace: 'just an error message, no stack',
      }),
    );
    expect(text).toContain('No `file:line` references');
  });

  it('limit caps the number of candidates rendered', async () => {
    const trace = ['at fn1 (src/handler.ts:6:1)', 'at fn2 (src/handler.ts:2:1)'].join('\n');
    const text = textOf(await handler.runHandler('cartograph_trace_to_culprits', { trace, limit: 1 }));
    // Only the top-ranked candidate appears; the other is summarised.
    expect(text).toContain('processIncoming');
    expect(text).toContain('Showing top 1 of 2 candidates');
  });

  it('surfaces "recent churn" annotation when last_touched_ts is fresh (R1 regression guard)', async () => {
    // Reviewer-flagged BLOCK: recentCutoff was in ms but last_touched_ts
    // is unix seconds, making the >= comparison always false. Stamp a
    // fresh seconds-based timestamp on the file via the same helper
    // the churn miner uses, then verify the rendered output mentions
    // "recent churn" — would silently regress to absence under the
    // old ms/seconds bug.
    const { applyChurnDeltas } = await import('../src/db/queries-history.js');
    const nowSec = Math.floor(Date.now() / 1000);
    applyChurnDeltas(cg.queries, [
      {
        path: 'src/handler.ts',
        commitCountDelta: 3,
        lastTouchedTs: nowSec,
        firstSeenTs: nowSec - 86400 * 5,
      },
    ]);
    const trace = 'at processIncoming (src/handler.ts:6:9)';
    const text = textOf(await handler.runHandler('cartograph_trace_to_culprits', { trace }));
    expect(text).toContain('recent churn');
    // Audit #25: the churn reason is now explicit that the commit
    // count and "last touched" are FILE-level signals, not symbol-level.
    expect(text).toContain('3 file commits');
    expect(text).toContain('file-level signal, not symbol-level');
  });

  it('renders module-level frames with a non-misleading message (bug #11)', async () => {
    // Bug #11: a frame whose file IS indexed but whose line lives in
    // module-level top-level code (between two function bodies, the
    // export header, blank lines, comments) USED to render as "line is
    // in a gap between symbol bodies" — phrased as if the file didn't
    // have that line at all. The new wording says "module-level
    // top-level code, no enclosing symbol — try a wider hunk or check
    // the file directly", which is honest about what the index sees.
    //
    // Line 4 of the fixture is the blank line between handleRequest and
    // processIncoming — indexed file, attributable line range, but no
    // enclosing function/method/class/etc.
    const trace = 'Error: x\n    at module-init (src/handler.ts:4:0)';
    const text = textOf(await handler.runHandler('cartograph_trace_to_culprits', { trace }));
    // New section heading.
    expect(text).toContain('module-level / unenclosed lines');
    // New per-row explanation; the misleading "gap between symbol
    // bodies" phrasing MUST be gone.
    expect(text).toContain('module-level top-level code, no enclosing symbol');
    expect(text).toContain('try a wider hunk or check the file directly');
    expect(text).not.toContain('gap between symbol bodies');
  });
});
