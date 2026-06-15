/**
 * Coverage-focused tests for `src/llm/dead-code.ts`.
 *
 * The existing dead-code suite (`dead-code-graph-candidates`,
 * `dead-code-judge-run`, `dead-code-parser`, `dead-code-pagination`,
 * `go-dead-code-liveness`, `rust-dead-code-liveness`) covers the main
 * happy paths. This file deliberately exercises the remaining branches
 * so the module's exported surface is driven end-to-end:
 *
 *   - The exported pure predicates / helpers used by the graph
 *     pre-filter and the judge post-pass: `isPublicApiShim`,
 *     `isMethodOnInterfaceImplementor`, `downgradeForHedgeSignals`,
 *     `truncateReason`, `parseBatchJudges`.
 *   - The constant `PUBLIC_API_SHIM_ALLOWLIST` /
 *     `INTERFACE_DISPATCH_CONFIDENCE_CAP` / `HEDGE_SIGNALS` registry
 *     shape these helpers depend on.
 *   - `findGraphCandidates` over a real indexed multi-file fixture with
 *     KNOWN dead code: a genuine unused export-less orphan, a used
 *     export that must NOT be flagged, an entry-point-shaped symbol, a
 *     re-export chain, `pathFilter` scoping, and the `includeTests`
 *     toggle.
 *   - The empty-graph case (no orphans → no candidates, judge resolves
 *     with zeroes).
 *   - The over-context retry path in `judgeDeadCode` (a context-window
 *     error splits the batch and the irreducible single candidate is
 *     marked `uncertain`).
 *
 * Every assertion pins exact symbol names — no tautological checks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import {
  findGraphCandidates,
  judgeDeadCode,
  isPublicApiShim,
  isMethodOnInterfaceImplementor,
  downgradeForHedgeSignals,
  truncateReason,
  parseBatchJudges,
  PUBLIC_API_SHIM_ALLOWLIST,
  INTERFACE_DISPATCH_CONFIDENCE_CAP,
  HEDGE_SIGNALS,
} from '../src/llm/dead-code.js';
import type { Node } from '../src/types.js';
import { LlmEndpointError, type ChatMessage } from '../src/llm/client.js';
import { FakeLlmClient } from './helpers/fake-chat-client.js';
import { isFixturePath } from '../src/mcp/tools/shared.js';

const node = (over: Partial<Node>): Node =>
  ({
    id: over.id ?? 'n',
    name: over.name ?? 'x',
    kind: over.kind ?? 'function',
    filePath: over.filePath ?? 'src/x.ts',
    startLine: over.startLine ?? 1,
    endLine: over.endLine ?? 2,
    isExported: over.isExported ?? false,
    ...over,
  }) as Node;

// ---------------------------------------------------------------------------
// Pure exported helpers — no DB needed.
// ---------------------------------------------------------------------------

describe('isPublicApiShim + PUBLIC_API_SHIM_ALLOWLIST', () => {
  it('matches an exact allowlist entry on (filePath, kind, name)', () => {
    // Every allowlisted shim is recognised.
    for (const entry of PUBLIC_API_SHIM_ALLOWLIST) {
      expect(isPublicApiShim({ filePath: entry.filePath, kind: entry.kind, name: entry.name })).toBe(true);
    }
    // Pin a known member so the allowlist can't silently empty out.
    expect(isPublicApiShim({ filePath: 'src/cartograph-llm-service.ts', kind: 'method', name: 'hasLlm' })).toBe(true);
  });

  it('does not match when any one of (filePath, kind, name) differs', () => {
    expect(isPublicApiShim({ filePath: 'src/db/index.ts', kind: 'method', name: 'getPath' })).toBe(true);
    // wrong file
    expect(isPublicApiShim({ filePath: 'src/other.ts', kind: 'method', name: 'getPath' })).toBe(false);
    // wrong kind
    expect(isPublicApiShim({ filePath: 'src/db/index.ts', kind: 'function', name: 'getPath' })).toBe(false);
    // wrong name
    expect(isPublicApiShim({ filePath: 'src/db/index.ts', kind: 'method', name: 'unrelated' })).toBe(false);
  });
});

describe('truncateReason', () => {
  it('returns a within-cap reason unchanged (no ellipsis)', () => {
    const short = 'no callers, not a framework hook';
    expect(truncateReason(short)).toBe(short);
    expect(truncateReason(short).endsWith('…')).toBe(false);
  });

  it('trims on a word boundary and appends a single ellipsis when over the cap', () => {
    const reason = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(8).trim();
    const out = truncateReason(reason);
    expect(out.length).toBeLessThanOrEqual(281);
    expect(out.endsWith('…')).toBe(true);
    const head = out.slice(0, -1);
    // The cut landed on a whitespace boundary — the head is a clean prefix.
    expect(reason.startsWith(head)).toBe(true);
    expect(reason[head.length]).toBe(' ');
  });

  it('hard-slices a single unbroken token (no whitespace before the cap)', () => {
    // One 500-char token: there is no space to cut on, so the head is the
    // raw 280-char window + ellipsis (exercises the `lastSpace <= 0` arm).
    const out = truncateReason('z'.repeat(500));
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(281);
    expect(out.slice(0, -1)).toBe('z'.repeat(280));
  });
});

describe('parseBatchJudges — self-healing per-entry arms', () => {
  it('coerces a string index and rejects a fractional one', () => {
    // `i:"1"` coerces to 1 (z.coerce); `i:0.5` is rejected by `.int()`.
    const m = parseBatchJudges(
      '{"results":[{"i":"1","verdict":"dead","confidence":0.9,"reason":"a"},' +
        '{"i":0.5,"verdict":"dead","confidence":0.9,"reason":"frac"}]}',
      3,
    );
    expect(m.get(1)?.verdict).toBe('dead');
    // The fractional-index entry is dropped, not mapped to 0.
    expect(m.get(0)).toBeUndefined();
    expect(m.size).toBe(1);
  });

  it('falls back to the default confidence when confidence is missing / non-numeric', () => {
    // A non-number confidence is NOT coerced — it self-heals to the 0.5
    // default (then clamps, a no-op here).
    const m = parseBatchJudges('{"results":[{"i":0,"verdict":"dead","confidence":"high","reason":"r"}]}', 1);
    expect(m.get(0)?.confidence).toBe(0.5);
  });

  it('collapses a non-string reason to an empty string', () => {
    const m = parseBatchJudges('{"results":[{"i":0,"verdict":"live","confidence":0.4,"reason":123}]}', 1);
    expect(m.get(0)?.reason).toBe('');
    expect(m.get(0)?.verdict).toBe('live');
  });

  it('uppercases verdicts are lower-cased then whitelisted', () => {
    const m = parseBatchJudges('{"results":[{"i":0,"verdict":"DEAD","confidence":0.9,"reason":"x"}]}', 1);
    expect(m.get(0)?.verdict).toBe('dead');
  });

  it('drops a non-object entry but keeps a valid sibling', () => {
    const m = parseBatchJudges('{"results":["garbage",{"i":1,"verdict":"live","confidence":0.7,"reason":"ok"}]}', 2);
    expect(m.size).toBe(1);
    expect(m.get(1)?.verdict).toBe('live');
  });
});

describe('downgradeForHedgeSignals (pure post-pass)', () => {
  const sigName = HEDGE_SIGNALS[0]!.name;

  it('exposes the interface-dispatch signal and its 0.6 cap', () => {
    expect(sigName).toBe('interface-dispatch');
    expect(INTERFACE_DISPATCH_CONFIDENCE_CAP).toBe(0.6);
    expect(HEDGE_SIGNALS.some((s) => s.confidenceCap === INTERFACE_DISPATCH_CONFIDENCE_CAP)).toBe(true);
  });

  it('passes through an `uncertain` verdict untouched even when a signal fired', () => {
    const item = { node: node({ name: 'm', kind: 'method' }), summary: null, hedgeSignals: new Set([sigName]) };
    const out = downgradeForHedgeSignals(item, { verdict: 'uncertain', confidence: 0.95, reason: 'maybe' });
    expect(out.verdict).toBe('uncertain');
    expect(out.confidence).toBe(0.95);
    expect(out.reason).toBe('maybe');
  });

  it('passes through a definite verdict when NO signal fired', () => {
    const item = { node: node({ name: 'm' }), summary: null, hedgeSignals: new Set<string>() };
    const out = downgradeForHedgeSignals(item, { verdict: 'dead', confidence: 1, reason: 'orphan' });
    expect(out.confidence).toBe(1);
    expect(out.reason).toBe('orphan');
  });

  it('caps a confident dead verdict at the fired signal cap and annotates the reason', () => {
    const item = { node: node({ name: 'm', kind: 'method' }), summary: null, hedgeSignals: new Set([sigName]) };
    const out = downgradeForHedgeSignals(item, { verdict: 'dead', confidence: 1, reason: 'looks unused' });
    expect(out.confidence).toBe(INTERFACE_DISPATCH_CONFIDENCE_CAP);
    expect(out.reason).toMatch(/^\(hedge: interface-dispatch; confidence capped\)/);
    expect(out.reason).toMatch(/looks unused/);
  });

  it('does NOT cap a verdict already at or below the cap (signal binds only above)', () => {
    // confidence 0.5 <= cap 0.6 — the signal does not bind, so the
    // verdict passes through with no annotation.
    const item = { node: node({ name: 'm', kind: 'method' }), summary: null, hedgeSignals: new Set([sigName]) };
    const out = downgradeForHedgeSignals(item, { verdict: 'dead', confidence: 0.5, reason: 'plain' });
    expect(out.confidence).toBe(0.5);
    expect(out.reason).toBe('plain');
  });
});

// ---------------------------------------------------------------------------
// findGraphCandidates over a real indexed fixture with KNOWN dead code.
// ---------------------------------------------------------------------------

describe('findGraphCandidates over a real multi-file index', () => {
  let testDir: string;
  let cg: Cartograph;
  const names = (nodes: Node[]): string[] => nodes.map((n) => n.name);

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cov-deadcode-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'src', 'feature'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '__tests__'), { recursive: true });

    // util.ts: a USED export (consumed by entry.ts), a genuinely dead
    // non-exported orphan, and an unused export. is_exported = 1 is
    // filtered upstream by findOrphanedSymbols, so the unused *export*
    // never reaches findGraphCandidates — the dead *non-exported*
    // helper is the one true candidate here.
    fs.writeFileSync(
      path.join(testDir, 'src', 'util.ts'),
      [
        'export function usedHelper(): number { return 1; }',
        '// Exported but no in-repo caller — filtered upstream (is_exported=1).',
        'export function unusedExport(): number { return 2; }',
        '// NOT exported, never called anywhere — a genuine graph orphan.',
        'function deadInternal(): number { return 3; }',
        '// NOT exported, but called by deadInternal? No — only by entry below.',
        'function liveInternal(): number { return 4; }',
        'export function caller(): number { return liveInternal(); }',
      ].join('\n'),
    );

    // entry.ts: imports + calls usedHelper, so it is live. Re-exports
    // unusedExport (a re-export chain) — the re-export must not make the
    // non-exported deadInternal look used.
    fs.writeFileSync(
      path.join(testDir, 'src', 'entry.ts'),
      [
        "import { usedHelper } from './util.js';",
        "export { unusedExport } from './util.js';",
        'export function main(): number { return usedHelper(); }',
      ].join('\n'),
    );

    // feature/orphans.ts: two non-exported orphan classes/functions plus
    // a decorated framework hook (must be exempt) and a framework
    // convention name (`render`, must be exempt).
    fs.writeFileSync(
      path.join(testDir, 'src', 'feature', 'orphans.ts'),
      [
        'function Get(_p: string): MethodDecorator { return () => undefined; }',
        'class Widget {',
        '  @Get("/x")',
        '  handler(): void {}',
        '  render(): void {}',
        '}',
        '// Non-exported orphan class with no incoming edges at all.',
        'class AbandonedThing {}',
        '// Non-exported orphan function.',
        'function strandedFn(): number { return 7; }',
      ].join('\n'),
    );

    // __tests__/helper.test.ts: a test-path orphan — exempt by default,
    // surfaced only with includeTests:true.
    fs.writeFileSync(
      path.join(testDir, '__tests__', 'helper.test.ts'),
      ['function testOnlyHelper(): number { return 11; }'].join('\n'),
    );

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterAll(() => {
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('flags the genuine non-exported orphans and never the used / exported symbols', () => {
    const got = names(findGraphCandidates({ queries: cg.queries, max: 100 }));
    // Genuine dead code, non-exported, zero incoming edges.
    expect(got).toContain('deadInternal');
    expect(got).toContain('strandedFn');
    expect(got).toContain('AbandonedThing');
    // Used / live symbols must NOT be flagged.
    expect(got).not.toContain('usedHelper'); // called from entry.ts (also exported)
    expect(got).not.toContain('liveInternal'); // called by caller()
    expect(got).not.toContain('main'); // exported, filtered upstream
    expect(got).not.toContain('caller'); // exported, filtered upstream
    // Exported-but-unused is filtered upstream (is_exported=1), not a candidate.
    expect(got).not.toContain('unusedExport');
  });

  it('exempts decorated framework hooks and framework-convention method names', () => {
    const got = names(findGraphCandidates({ queries: cg.queries, max: 100 }));
    // @Get-decorated handler — decorated framework hook, exempt.
    expect(got).not.toContain('handler');
    // `render` — framework-dispatched convention name, exempt.
    expect(got).not.toContain('render');
  });

  it('drops test-path orphans by default and surfaces them with includeTests', () => {
    const def = names(findGraphCandidates({ queries: cg.queries, max: 100 }));
    expect(def).not.toContain('testOnlyHelper');

    const withTests = names(findGraphCandidates({ queries: cg.queries, max: 100, includeTests: true }));
    expect(withTests).toContain('testOnlyHelper');
    // The genuine src/ orphans are still present in the includeTests pass.
    expect(withTests).toContain('deadInternal');
  });

  it('scopes candidates to a literal path prefix via pathFilter', () => {
    const scoped = findGraphCandidates({ queries: cg.queries, max: 100, pathFilter: 'src/feature/' });
    expect(scoped.length).toBeGreaterThan(0);
    // Only feature/ orphans survive; util.ts orphans are excluded.
    expect(scoped.every((n) => n.filePath.startsWith('src/feature/'))).toBe(true);
    const scopedNames = scoped.map((n) => n.name);
    expect(scopedNames).toContain('strandedFn');
    expect(scopedNames).not.toContain('deadInternal');
  });

  it('isExempt callback drops matching paths inline (fixture predicate is a no-op here)', () => {
    // No fixture paths in this corpus, so isFixturePath drops nothing —
    // the result is identical to the no-callback run, proving the hook
    // is applied without over-filtering real src/ orphans.
    const withCb = names(findGraphCandidates({ queries: cg.queries, max: 100, isExempt: isFixturePath }));
    expect(withCb).toContain('deadInternal');
    expect(withCb).toContain('strandedFn');
  });

  it('isMethodOnInterfaceImplementor returns false for a non-method and a plain class method', () => {
    // A top-level function is never a method-on-implementor.
    const fns = findGraphCandidates({ queries: cg.queries, max: 100 }).filter((n) => n.name === 'strandedFn');
    expect(fns.length).toBeGreaterThan(0);
    expect(isMethodOnInterfaceImplementor(cg.queries, fns[0]!)).toBe(false);
    // Widget has no implements/extends edge, so its (exempt) methods are
    // not interface-dispatched either. Construct a method-shaped probe.
    const probe = node({ name: 'handler', kind: 'method', filePath: 'src/feature/orphans.ts' });
    expect(isMethodOnInterfaceImplementor(cg.queries, probe)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interface-implementor positive case + empty graph + oversized batch.
// ---------------------------------------------------------------------------

describe('isMethodOnInterfaceImplementor — positive interface-dispatch case', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cov-iface-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'src', 'svc.ts'),
      [
        'export interface Greeter {',
        '  greet(): string;',
        '}',
        'class Impl implements Greeter {',
        '  greet(): string { return "hi"; }',
        '}',
      ].join('\n'),
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterAll(() => {
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns true for a method on a class that implements an interface', () => {
    // `greet` is a static-graph orphan (callers route through Greeter),
    // so findGraphCandidates surfaces it; the predicate confirms the
    // interface-dispatch path.
    const cand = findGraphCandidates({ queries: cg.queries, max: 50 }).find((n) => n.name === 'greet');
    expect(cand).toBeDefined();
    expect(cand!.kind).toBe('method');
    expect(isMethodOnInterfaceImplementor(cg.queries, cand!)).toBe(true);
  });
});

describe('empty graph', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cov-empty-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    // Only fully-wired, mutually-referenced exported code → no orphans.
    fs.writeFileSync(
      path.join(testDir, 'src', 'app.ts'),
      ['export function a(): number { return b() + 1; }', 'export function b(): number { return 2; }'].join('\n'),
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterAll(() => {
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns no candidates when there are no non-exported orphans', () => {
    const got = findGraphCandidates({ queries: cg.queries, max: 50 });
    // `a` and `b` are both exported (filtered upstream) and mutually
    // referenced — nothing for the pre-filter to surface.
    expect(got).toHaveLength(0);
  });

  it('judgeDeadCode over an orphan-free graph resolves with zero candidates', async () => {
    const client = new FakeLlmClient(() => '{"results":[]}');
    const result = await judgeDeadCode(cg.queries, client, { concurrency: 1, batchSize: 8 });
    expect(result.candidates).toBe(0);
    expect(result.judged).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.results).toHaveLength(0);
    // No batch was ever dispatched — no orphans to judge.
    expect(client.chatCalls).toBe(0);
  });
});

describe('judgeDeadCode — context-window retry splits the batch', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cov-ctx-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    // Four genuine orphans so a context-window error has something to
    // split (batchSize 4 → split 2/2 → split 1/1).
    fs.writeFileSync(
      path.join(testDir, 'src', 'big.ts'),
      Array.from({ length: 4 }, (_, i) => `function orphan${i}(): number { return ${i}; }`).join('\n'),
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterAll(() => {
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('every batch that exceeds context recurses down to single candidates marked uncertain', async () => {
    // The handler ALWAYS throws a context-window error. retryOversizedBatch
    // halves the batch until each is a single candidate, then records it
    // as `uncertain` / "prompt exceeded model context window".
    let calls = 0;
    const client = new FakeLlmClient((_messages: ChatMessage[]) => {
      calls++;
      throw new LlmEndpointError('the request exceeds the available context size of the model', 400);
    });

    const result = await judgeDeadCode(cg.queries, client, { concurrency: 1, batchSize: 4 });

    expect(result.candidates).toBe(4);
    // Each of the four candidates ends up judged (as uncertain), not errored.
    expect(result.judged).toBe(4);
    expect(result.errors).toBe(0);
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r) => r.verdict === 'uncertain')).toBe(true);
    expect(result.results.every((r) => r.reason === 'prompt exceeded model context window')).toBe(true);
    expect(result.results.every((r) => r.confidence === 0.3)).toBe(true);
    // The split walked 4 → 2+2 → (1+1)+(1+1): 1 (top) + 2 (halves) + 4
    // (singles) = 7 chat attempts, all throwing.
    expect(calls).toBe(7);
  });

  it('marks a non-context endpoint error as errored, not retried', async () => {
    const client = new FakeLlmClient(() => {
      throw new LlmEndpointError('service unavailable', 503);
    });
    const result = await judgeDeadCode(cg.queries, client, { concurrency: 1, batchSize: 4 });
    // A plain 503 is not a context-window error: the whole batch is
    // counted as errored and nothing is judged.
    expect(result.candidates).toBe(4);
    expect(result.errors).toBe(4);
    expect(result.judged).toBe(0);
  });
});
