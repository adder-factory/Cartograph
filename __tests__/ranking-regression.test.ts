/**
 * Ranking-regression gate (rough-edges backlog #4).
 *
 * The retrieval scorer is multi-channel and easy to regress silently —
 * historically ranking misses only surfaced when a friction workout
 * happened to catch them (e.g. F-r9-1: "how does the file watcher
 * trigger a sync" stopped surfacing the gating function `watcherHandle
 * FileEvent`). This test makes that mechanical: a curated corpus of
 * (query → expected ranking) cases over a purpose-built fixture
 * (`evaluation/fixtures/ranking-corpus.ts`), run as part of `npm test`
 * (this file lives at the top level of `__tests__/` so the default
 * `__tests__/*.test.ts` shard glob picks it up — it is NOT under
 * `__tests__/evaluation/`, which the default suite does not scan) and
 * the `test:eval` script, so a scorer change that regresses ranking
 * turns a test red.
 *
 * Every assertion is **entry-point (root) based** and ranking-sensitive
 * — a symbol merely present in the result subgraph proves little
 * (traversal pulls in neighbours); `subgraph.roots` is the ranked set.
 * Case shapes:
 *
 *  - **rank-first** — `roots[0]` must be a specific symbol. The
 *    strongest gate: catches a regression that reorders the top of the
 *    ranking (e.g. demotes the gating function below shape interfaces,
 *    which is exactly F-r9-1).
 *  - **rank-order** — symbol A must rank ahead of symbol B.
 *  - **theme-purity** — the roots must NOT contain symbols from an
 *    unrelated theme (catches a regression that floods cross-theme).
 *
 * The behaviour-question cases pass `behaviorBias: true` — that is what
 * the `cartograph_context` MCP layer sets for "how does…" tasks, so the
 * gate exercises the realistic path. `minScore` is the production
 * default (0.3). Expectations are calibrated to current-correct
 * behaviour; on an INTENTIONAL scorer/fixture change, re-run and
 * re-calibrate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { searchNodes } from '../src/db/queries-search.js';
import { RANKING_FIXTURE_FILES } from './evaluation/fixtures/ranking-corpus.js';

let testDir: string;
let cg: Cartograph;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ranking-'));
  for (const [rel, content] of Object.entries(RANKING_FIXTURE_FILES)) {
    const abs = path.join(testDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  cg = await Cartograph.init(testDir, { index: true, config: { llm: { endpoint: '' } } });
}, 120_000);

afterAll(() => {
  cg?.close();
  if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
});

/**
 * Entry-point (root) symbol names of a behaviour-query `findRelevant
 * Context` result, in rank order — `roots[0]` is the top entry point.
 * `behaviorBias: true` mirrors what `cartograph_context` sets for
 * "how does…" tasks; `minScore: 0.3` is the production default.
 */
async function behaviourRoots(query: string): Promise<string[]> {
  const sub = await cg.internals.contextBuilder.findRelevantContext(query, {
    searchLimit: 8,
    traversalDepth: 3,
    maxNodes: 80,
    minScore: 0.3,
    behaviorBias: true,
  });
  return sub.roots.map((id) => sub.nodes.get(id)?.name).filter((n): n is string => typeof n === 'string');
}

describe('ranking regression', () => {
  it('indexed the fixture into a populated graph', () => {
    // Sanity floor — a clear failure if indexing produced nothing,
    // rather than every ranking case failing cryptically downstream.
    const stats = cg.stats.getStats();
    expect(stats.nodeCount).toBeGreaterThan(30);
    expect(stats.edgeCount).toBeGreaterThan(20);
  });

  // F-r9-1 gate: a behaviour question must rank the gating FUNCTION
  // first, ahead of the three `Watcher*` shape interfaces that all
  // match the "watcher" token. This is the exact regression the
  // 2026-05-15 r9 workout had to catch by hand.
  it('ranks the watcher gating function first, ahead of the shape interfaces (F-r9-1)', async () => {
    const roots = await behaviourRoots('how does the file watcher trigger a sync');
    expect(roots[0]).toBe('watcherHandleFileEvent');
    // The subject class outranks every Watcher* shape interface.
    expect(roots.indexOf('FileWatcher')).toBeLessThan(roots.indexOf('WatcherStats'));
    expect(roots.indexOf('FileWatcher')).toBeLessThan(roots.indexOf('WatcherState'));
    expect(roots.indexOf('FileWatcher')).toBeLessThan(roots.indexOf('WatcherOptions'));
    // The watcher/sync cluster fills the searchLimit — making the
    // expected size explicit so a fixture edit that changes the
    // cluster is caught here rather than silently weakening the gate.
    expect(roots).toHaveLength(8);
  });

  it('keeps the watcher query on-theme — no cross-theme symbols ranked', async () => {
    const roots = await behaviourRoots('how does the file watcher trigger a sync');
    for (const offTheme of ['processPayment', 'authenticateUser', 'CacheStore', 'queryDatabase']) {
      expect(roots).not.toContain(offTheme);
    }
  });

  it('ranks the auth function first for an auth behaviour query', async () => {
    const roots = await behaviourRoots('how does the system authenticate a user with a token');
    expect(roots[0]).toBe('authenticateUser');
    expect(roots).toContain('validateToken');
  });

  it('ranks the payment function first for a payment behaviour query', async () => {
    const roots = await behaviourRoots('how does a payment get processed and refunded');
    expect(roots[0]).toBe('processPayment');
    expect(roots).toContain('refundPayment');
  });

  // searchNodes — symbol-name precision (no behaviorBias; this is the
  // exact-name retrieval path, not the behaviour-context path).
  it('ranks an exact function-name match first', () => {
    const results = searchNodes(cg.queries, 'processPayment', { limit: 10 });
    expect(results[0]?.node.name).toBe('processPayment');
  });

  it('ranks an exact class-name match first', () => {
    const results = searchNodes(cg.queries, 'CacheStore', { limit: 10 });
    expect(results[0]?.node.name).toBe('CacheStore');
  });

  it('finds a symbol from a multi-term query', () => {
    const results = searchNodes(cg.queries, 'invalidate cache', { limit: 10 });
    expect(results.map((r) => r.node.name)).toContain('invalidateCache');
  });
});
