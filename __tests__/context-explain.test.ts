/**
 * Tests for `cartograph_context`'s `explain` mode — the per-candidate
 * score trace (`src/context/score-trace.ts` + the `explain` option on
 * `findRelevantContext` / `buildContext`).
 *
 * Backlog item #2 from the 2026-05-15 friction-workout review: the
 * multi-channel retrieval scorer was opaque; `explain` makes it legible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Cartograph from '../src/index.js';
import { ScoreTrace, renderScoreExplanation } from '../src/context/score-trace.js';
import { annotateScoreTraceEntryMarkers } from '../src/mcp/tools/context.js';
import type { ScoreExplanation } from '../src/types.js';

describe('context explain mode — score trace', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explain-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'payment.ts'),
      [
        'export interface PaymentResult { ok: boolean; }',
        'export class PaymentService {',
        '  processPayment(amount: number): PaymentResult {',
        '    return { ok: amount > 0 };',
        '  }',
        '}',
        'export function refundPayment(id: string): void { void id; }',
      ].join('\n'),
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('omits scoreTrace by default', async () => {
    const sub = await cg.internals.contextBuilder.findRelevantContext('PaymentService');
    expect(sub.scoreTrace).toBeUndefined();
  });

  it('attaches a populated scoreTrace under explain: true', async () => {
    const sub = await cg.internals.contextBuilder.findRelevantContext('PaymentService', {
      explain: true,
    });
    expect(sub.scoreTrace).toBeDefined();
    const trace = sub.scoreTrace!;
    expect(trace.query).toBe('PaymentService');
    // At least the lexical-merge pass always runs.
    expect(trace.passNames).toContain('lexical-merge');
    expect(trace.candidates.length).toBeGreaterThan(0);
    // The surviving candidates are the subgraph roots.
    const survivors = trace.candidates.filter((c) => c.survived);
    expect(survivors.length).toBeGreaterThan(0);
    for (const c of survivors) {
      expect(sub.roots).toContain(c.nodeId);
    }
    // Every traced candidate carries at least one pass entry, and the
    // final score equals the score after its last recorded pass.
    for (const c of trace.candidates) {
      if (c.passes.length === 0) continue; // import-resolution swap-in
      expect(c.finalScore).toBe(c.passes[c.passes.length - 1]!.score);
    }
  });

  it('exposes the trace through buildContext (format: object)', async () => {
    const ctx = await cg.internals.contextBuilder.buildContext('PaymentService', {
      format: 'object',
      explain: true,
    });
    expect(typeof ctx).not.toBe('string');
    if (typeof ctx === 'string') return;
    expect(ctx.subgraph.scoreTrace).toBeDefined();
    expect(ctx.subgraph.scoreTrace!.candidates.length).toBeGreaterThan(0);
  });
});

describe('ScoreTrace collector', () => {
  const node = (id: string) =>
    ({
      id,
      name: id,
      kind: 'function',
      filePath: `src/${id}.ts`,
      startLine: 1,
    }) as never;

  it('back-fills candidates first seen at a later pass', () => {
    const t = new ScoreTrace();
    t.snapshot('lexical-merge', [{ node: node('a'), score: 10 }]);
    // `b` enters only at the second pass.
    t.snapshot('semantic-extras', [
      { node: node('a'), score: 12 },
      { node: node('b'), score: 22 },
    ]);
    const exp = t.finalize('q', [{ node: node('a'), score: 12 }]);
    const a = exp.candidates.find((c) => c.nodeId === 'a')!;
    const b = exp.candidates.find((c) => c.nodeId === 'b')!;
    // `a` was present for both passes; `b` only for the second.
    expect(a.passes.map((p) => p.pass)).toEqual(['lexical-merge', 'semantic-extras']);
    expect(b.passes.map((p) => p.pass)).toEqual(['semantic-extras']);
    expect(a.survived).toBe(true);
    expect(b.survived).toBe(false);
  });

  it('orders survivors ahead of near-misses and caps near-misses', () => {
    const t = new ScoreTrace();
    const results = ['a', 'b', 'c', 'd'].map((id, i) => ({ node: node(id), score: 100 - i }));
    t.snapshot('lexical-merge', results);
    const exp = t.finalize('q', [{ node: node('c'), score: 97 }], 2);
    expect(exp.candidates[0]!.nodeId).toBe('c');
    expect(exp.candidates[0]!.survived).toBe(true);
    // Three non-survivors, capped to 2.
    expect(exp.candidates.filter((c) => !c.survived)).toHaveLength(2);
  });

  it('keeps survivor rows in the caller-passed order, not final-score order (task #14)', () => {
    const t = new ScoreTrace();
    // Three candidates whose final scores DISAGREE with the order the
    // caller selects them in — `b` has the highest score but the
    // context output puts `a` first.
    t.snapshot('lexical-merge', [
      { node: node('a'), score: 10 },
      { node: node('b'), score: 99 },
      { node: node('c'), score: 50 },
    ]);
    const exp = t.finalize('q', [
      { node: node('a'), score: 10 },
      { node: node('b'), score: 99 },
      { node: node('c'), score: 50 },
    ]);
    // Survivor rows must mirror the input order (a, b, c) so the trace
    // agrees with the context output — NOT re-sorted to (b, c, a).
    expect(exp.candidates.map((c) => c.nodeId)).toEqual(['a', 'b', 'c']);
  });

  it('surfaces a survivor absent from the trace with an empty pass list', () => {
    const t = new ScoreTrace();
    t.snapshot('lexical-merge', [{ node: node('a'), score: 10 }]);
    // `z` never appeared in a snapshot (e.g. import-resolved swap-in).
    const exp = t.finalize('q', [{ node: node('z'), score: 5 }]);
    const z = exp.candidates.find((c) => c.nodeId === 'z')!;
    expect(z.survived).toBe(true);
    expect(z.passes).toHaveLength(0);
    expect(z.finalScore).toBe(5);
  });
});

describe('renderScoreExplanation', () => {
  it('returns empty string when there are no candidates', () => {
    const exp: ScoreExplanation = { query: 'q', passNames: [], candidates: [] };
    expect(renderScoreExplanation(exp)).toBe('');
  });

  it('renders a fenced score-trace section with per-pass deltas', () => {
    const exp: ScoreExplanation = {
      query: 'how does payment work',
      passNames: ['lexical-merge', 'centrality'],
      candidates: [
        {
          nodeId: 'p',
          name: 'processPayment',
          kind: 'method',
          filePath: 'src/payment.ts',
          line: 3,
          finalScore: 13.2,
          survived: true,
          passes: [
            { pass: 'lexical-merge', score: 12 },
            { pass: 'centrality', score: 13.2 },
          ],
        },
      ],
    };
    const md = renderScoreExplanation(exp);
    expect(md).toContain('### Score trace (explain mode)');
    expect(md).toContain('[+] processPayment (method)');
    expect(md).toContain('lexical-merge');
    expect(md).toContain('(+1.20)'); // 13.2 - 12
    expect(md).toContain('```'); // fenced for alignment
  });
});

describe('annotateScoreTraceEntryMarkers — friction-23: per-candidate "entered at pass" marker', () => {
  /** Two candidates: `early` is seeded at pass 0, `late` enters at the
   *  second pass — its trace has no `lexical-merge` row. */
  const traceWithMidPipelineCandidate: ScoreExplanation = {
    query: 'how does the file watcher trigger a sync',
    passNames: ['lexical-merge', 'semantic-extras', 'centrality'],
    candidates: [
      {
        nodeId: 'early',
        name: 'WatcherStats',
        kind: 'interface',
        filePath: 'src/sync/watcher.ts',
        line: 79,
        finalScore: 124.16,
        survived: true,
        passes: [
          { pass: 'lexical-merge', score: 84.8 },
          { pass: 'semantic-extras', score: 84.8 },
          { pass: 'centrality', score: 124.16 },
        ],
      },
      {
        nodeId: 'late',
        name: 'FileWatcherArgs',
        kind: 'interface',
        filePath: 'src/sync/watcher.ts',
        line: 309,
        finalScore: 22.0,
        survived: true,
        passes: [
          { pass: 'semantic-extras', score: 22.0 },
          { pass: 'centrality', score: 22.0 },
        ],
      },
    ],
  };

  it('appends "(entered at <pass>)" only to candidates that entered after pass 0', () => {
    const rendered = renderScoreExplanation(traceWithMidPipelineCandidate);
    const annotated = annotateScoreTraceEntryMarkers(rendered, traceWithMidPipelineCandidate);
    // The mid-pipeline candidate gets the marker on its header line.
    expect(annotated).toContain(
      '[+] FileWatcherArgs (interface)  src/sync/watcher.ts:309  final 22.00  (entered at semantic-extras)',
    );
    // The pass-0 candidate is left unmarked — a marker there would be noise.
    expect(annotated).toContain('[+] WatcherStats (interface)  src/sync/watcher.ts:79  final 124.16\n');
    expect(annotated).not.toContain('WatcherStats (interface)  src/sync/watcher.ts:79  final 124.16  (entered');
  });

  it('is a no-op when every candidate was seeded at the first pass', () => {
    const exp: ScoreExplanation = {
      query: 'q',
      passNames: ['lexical-merge', 'centrality'],
      candidates: [
        {
          nodeId: 'p',
          name: 'processPayment',
          kind: 'method',
          filePath: 'src/payment.ts',
          line: 3,
          finalScore: 13.2,
          survived: true,
          passes: [
            { pass: 'lexical-merge', score: 12 },
            { pass: 'centrality', score: 13.2 },
          ],
        },
      ],
    };
    const rendered = renderScoreExplanation(exp);
    expect(annotateScoreTraceEntryMarkers(rendered, exp)).toBe(rendered);
  });

  it('is a no-op on an empty rendered trace', () => {
    const exp: ScoreExplanation = { query: 'q', passNames: [], candidates: [] };
    expect(annotateScoreTraceEntryMarkers('', exp)).toBe('');
  });

  it('marks a near-miss candidate ([-]) that entered late, too', () => {
    const exp: ScoreExplanation = {
      query: 'q',
      passNames: ['lexical-merge', 'semantic-extras'],
      candidates: [
        {
          nodeId: 'm',
          name: 'lateMiss',
          kind: 'function',
          filePath: 'src/x.ts',
          line: 5,
          finalScore: 4.0,
          survived: false,
          passes: [{ pass: 'semantic-extras', score: 4.0 }],
        },
      ],
    };
    const rendered = renderScoreExplanation(exp);
    const annotated = annotateScoreTraceEntryMarkers(rendered, exp);
    expect(annotated).toContain('[-] lateMiss (function)  src/x.ts:5  final 4.00  (entered at semantic-extras)');
  });
});
