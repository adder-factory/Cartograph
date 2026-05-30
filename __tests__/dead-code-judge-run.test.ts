/**
 * Orchestration tests for `judgeDeadCode` / `DeadCodeJudgeRun`
 * (src/llm/dead-code.ts).
 *
 * `judgeDeadCode` is the public entry — it does
 * `new DeadCodeJudgeRun(queries, client, options).run()`. `run()`
 * spawns `concurrency` workers; each `worker()` pulls batches off a
 * shared cursor (`st.nextStart`) and calls `judgeBatch()`, which calls
 * `client.chat(...)` then `applyBatchVerdicts()`.
 *
 * Before this file `run` / `worker` had NO direct coverage — the
 * existing dead-code tests only exercise `findGraphCandidates` (the
 * graph pre-filter) and the parsing helpers. These tests close that
 * gap by driving the full judge pass over a real in-memory index of
 * genuine graph orphans, with a stubbed `LlmClient.chat()`.
 *
 * Scenarios:
 *   1. Happy path — a valid `{"results":[...]}` batch; verdicts land,
 *      results sorted dead → uncertain → live.
 *   2. Missing-from-batch — the stub omits an entry; that position is
 *      synthesised as `uncertain` / "missing from batch response".
 *   3. Chat failure — `chat()` throws an `LlmEndpointError`; `errors`
 *      is incremented by the batch size and `run()` still resolves.
 *   4. Concurrency — `concurrency > 1` with a small `batchSize`; every
 *      candidate is judged exactly once (the shared-cursor `worker`).
 *   5. Abort — a pre-aborted `AbortSignal`; `run()` returns promptly
 *      without judging.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { judgeDeadCode } from '../src/llm/dead-code.js';
import { LlmEndpointError, type ChatMessage } from '../src/llm/client.js';
import { FakeLlmClient } from './helpers/fake-chat-client.js';

/**
 * Parse the zero-indexed symbol block out of a batch judge prompt.
 * `buildBatchPrompt` emits `Symbols (zero-indexed):\n0. name (...)\n...`.
 */
function batchSize(userText: string): number {
  const m = userText.match(/Symbols \(zero-indexed\):\n([\s\S]*?)\n\n/);
  const lines = (m?.[1] ?? '').split('\n').filter((l) => /^\d+\./.test(l));
  return lines.length;
}

/** A handler returning a complete, valid verdict set for the batch. */
function verdictHandler(messages: ChatMessage[]): string {
  const n = batchSize(messages[0]?.content ?? '');
  const entries = Array.from({ length: n }, (_, i) => {
    // Vary verdicts so the dead → uncertain → live sort is observable.
    const verdict = i % 3 === 0 ? 'dead' : i % 3 === 1 ? 'live' : 'uncertain';
    return `{"i":${i},"verdict":"${verdict}","confidence":0.9,"reason":"stub ${i}"}`;
  });
  return `{"results":[${entries.join(',')}]}`;
}

describe('judgeDeadCode — DeadCodeJudgeRun.run / worker orchestration', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deadcode-judge-'));
    fs.mkdirSync(path.join(testDir, 'src'));

    // Six genuine graph orphans: not exported, zero incoming edges, in
    // a non-test path — so `findGraphCandidates` returns all six. Each
    // is a top-level function with no caller.
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      lines.push(`function orphan${i}(): number { return ${i}; }`);
    }
    // One live, exported function so the index also has a non-orphan —
    // it must NOT appear among the judged candidates.
    lines.push('export function reachable(): number { return 99; }');
    fs.writeFileSync(path.join(testDir, 'src', 'mod.ts'), lines.join('\n'));

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('happy path — judges every candidate and sorts dead → uncertain → live', async () => {
    const client = new FakeLlmClient(verdictHandler);
    const result = await judgeDeadCode(cg.queries, client, { concurrency: 1, batchSize: 8 });

    // All six orphans were found and judged; `reachable` is excluded.
    expect(result.candidates).toBe(6);
    expect(result.judged).toBe(6);
    expect(result.errors).toBe(0);
    expect(result.results).toHaveLength(6);
    expect(result.results.every((r) => r.node.name.startsWith('orphan'))).toBe(true);
    expect(result.results.some((r) => r.node.name === 'reachable')).toBe(false);

    // One chat call — six candidates fit in a single batch of 8.
    expect(client.chatCalls).toBe(1);

    // Verdicts are surfaced dead first, then uncertain, then live.
    const order = { dead: 0, uncertain: 1, live: 2 } as const;
    const seq = result.results.map((r) => order[r.verdict]);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    // The stub assigned each verdict at least once across six entries.
    expect(result.results.filter((r) => r.verdict === 'dead').length).toBeGreaterThan(0);
    expect(result.results.filter((r) => r.verdict === 'live').length).toBeGreaterThan(0);

    // Real verdicts carry the stub's confidence, not the synthesised
    // 0.3 fallback — every candidate was present in the batch reply.
    expect(result.results.every((r) => r.confidence === 0.9)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('missing-from-batch — an omitted entry is synthesised as uncertain', async () => {
    // Drop index 2 from the verdict set; `applyBatchVerdicts` must fill
    // that position with an `uncertain` / "missing from batch response"
    // candidate rather than losing it.
    const client = new FakeLlmClient((messages) => {
      const n = batchSize(messages[0]?.content ?? '');
      const entries = Array.from(
        { length: n },
        (_, i) => `{"i":${i},"verdict":"dead","confidence":0.8,"reason":"present ${i}"}`,
      ).filter((_, i) => i !== 2);
      return `{"results":[${entries.join(',')}]}`;
    });

    const result = await judgeDeadCode(cg.queries, client, { concurrency: 1, batchSize: 8 });

    // Every candidate is still accounted for — none silently dropped.
    expect(result.candidates).toBe(6);
    expect(result.judged).toBe(6);
    expect(result.results).toHaveLength(6);

    // Exactly one synthesised `uncertain` placeholder for the gap.
    const synthesised = result.results.filter(
      (r) => r.verdict === 'uncertain' && r.reason === 'missing from batch response',
    );
    expect(synthesised).toHaveLength(1);
    // The synthesised entry carries the unparseable-confidence fallback.
    expect(synthesised[0]!.confidence).toBe(0.3);
    // The other five came through with the real verdict.
    expect(result.results.filter((r) => r.verdict === 'dead')).toHaveLength(5);
  });

  it('chat failure — an LlmEndpointError errors the whole batch and run() still resolves', async () => {
    const client = new FakeLlmClient(() => {
      throw new LlmEndpointError('backend down', 503);
    });

    const result = await judgeDeadCode(cg.queries, client, { concurrency: 1, batchSize: 8 });

    // The single batch of six failed wholesale: `errors` is bumped by
    // the batch size, nothing was judged, and run() resolved cleanly.
    expect(result.candidates).toBe(6);
    expect(result.errors).toBe(6);
    expect(result.judged).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('chat failure across multiple batches — every batch is errored, not just the first', async () => {
    // batchSize 2 over 6 candidates = three batches; all three throw.
    const client = new FakeLlmClient(() => {
      throw new LlmEndpointError('backend down', 503);
    });

    const result = await judgeDeadCode(cg.queries, client, { concurrency: 1, batchSize: 2 });

    expect(result.candidates).toBe(6);
    // 3 batches × 2 = 6 — the full candidate set is counted as errored.
    expect(result.errors).toBe(6);
    expect(result.judged).toBe(0);
  });

  it('concurrency — several workers share the cursor; every candidate is judged exactly once', async () => {
    // concurrency 4, batchSize 1 → up to four workers race on the
    // shared `st.nextStart` cursor. The invariant under test: no
    // candidate is skipped and none is judged twice.
    const client = new FakeLlmClient(verdictHandler);
    const result = await judgeDeadCode(cg.queries, client, { concurrency: 4, batchSize: 1 });

    expect(result.candidates).toBe(6);
    expect(result.judged).toBe(6);
    expect(result.errors).toBe(0);
    expect(result.results).toHaveLength(6);

    // Each of the six orphans appears exactly once in the results.
    const names = result.results.map((r) => r.node.name).sort();
    expect(names).toEqual(['orphan0', 'orphan1', 'orphan2', 'orphan3', 'orphan4', 'orphan5']);

    // batchSize 1 means one chat call per candidate — six in total,
    // confirming the shared cursor handed out exactly six slices.
    expect(client.chatCalls).toBe(6);
  });

  it('abort — a pre-aborted signal makes run() return promptly without judging', async () => {
    const ac = new AbortController();
    ac.abort();

    let chatInvoked = false;
    const client = new FakeLlmClient((messages) => {
      chatInvoked = true;
      return verdictHandler(messages);
    });

    const result = await judgeDeadCode(cg.queries, client, {
      concurrency: 2,
      batchSize: 1,
      signal: ac.signal,
    });

    // The worker checks `signal.aborted` at the top of its loop, so it
    // returns before pulling any batch — nothing is judged, the chat
    // stub is never reached.
    expect(chatInvoked).toBe(false);
    expect(result.judged).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.results).toHaveLength(0);
    // `candidates` is the graph pre-filter count, computed in the
    // constructor before the abort check — it still reflects the six.
    expect(result.candidates).toBe(6);
  });

  it('onProgress fires once per judged candidate', async () => {
    const client = new FakeLlmClient(verdictHandler);
    const events: Array<{ done: number; total: number }> = [];

    const result = await judgeDeadCode(cg.queries, client, {
      concurrency: 1,
      batchSize: 8,
      onProgress: (done, total) => events.push({ done, total }),
    });

    // applyBatchVerdicts calls onProgress for each of the six entries.
    expect(events).toHaveLength(6);
    expect(events.at(-1)!.done).toBe(6);
    expect(events.every((e) => e.total === result.candidates)).toBe(true);
  });
});

/**
 * Regression test for bug #15 — methods on classes that implement an
 * interface are static-graph orphans because callers route through the
 * interface type, hiding the concrete implementor's methods from the
 * reference graph. A boilerplate `[DEAD 100%]` heading on such a method
 * invited deletion of code that was, in fact, the live implementation
 * of an interface contract. {@link INTERFACE_DISPATCH_CONFIDENCE_CAP}
 * caps the verdict at 0.6 with a reason annotation regardless of what
 * the LLM said.
 */
describe('judgeDeadCode — bug #15: interface-dispatch confidence cap', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deadcode-iface-'));
    fs.mkdirSync(path.join(testDir, 'src'));

    // A real TypeScript interface + a class that implements it. The
    // method's only "callers" route through the SqliteLike interface
    // type so the static graph sees zero direct callers on the
    // concrete `transaction` method — the same shape as the
    // src/db/sqlite-adapter.ts BunSqliteAdapter false-positive that
    // motivated this fix.
    const src = [
      'export interface SqliteLike {',
      '  transaction(fn: () => number): number;',
      '}',
      '',
      'class FakeSqlite implements SqliteLike {',
      '  transaction(fn: () => number): number {',
      '    return fn();',
      '  }',
      '}',
      '',
      "// Force at least one other true orphan so the candidate set isn't",
      '// dominated by a single entry.',
      'function trulyOrphan(): number { return 42; }',
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'src', 'adapter.ts'), src);

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('caps a 100% [DEAD] verdict on an interface-implementor method at INTERFACE_DISPATCH_CONFIDENCE_CAP', async () => {
    // Stub returns a confident DEAD 100% verdict for every candidate.
    // The interface-dispatched `transaction` method must be capped at
    // 0.6; `trulyOrphan` (a plain top-level function, no interface
    // anywhere on its parent chain) must keep the full 1.0.
    const client = new FakeLlmClient((messages) => {
      const n = batchSize(messages[0]?.content ?? '');
      const entries = Array.from(
        { length: n },
        (_, i) =>
          `{"i":${i},"verdict":"dead","confidence":1.0,"reason":"No dynamic dispatch, framework hooks, or external references found."}`,
      );
      return `{"results":[${entries.join(',')}]}`;
    });

    const result = await judgeDeadCode(cg.queries, client, { concurrency: 1, batchSize: 8 });

    const tx = result.results.find((r) => r.node.name === 'transaction' && r.node.kind === 'method');
    expect(tx).toBeDefined();
    // Cap applied: confidence drops from 1.0 to 0.6, reason gets a
    // prefix flagging the structural reason for the downgrade.
    expect(tx!.confidence).toBeLessThanOrEqual(0.6);
    expect(tx!.reason).toMatch(/hedge: interface-dispatch/i);

    // Sanity: a plain top-level function with no interface in its
    // parent chain is NOT capped — the downgrade only fires for
    // interface-implementor methods.
    const orph = result.results.find((r) => r.node.name === 'trulyOrphan');
    if (orph) {
      expect(orph.confidence).toBe(1.0);
      expect(orph.reason).not.toMatch(/hedge:/i);
    }
  });

  it('does not cap an uncertain verdict on an interface-implementor method (only dead/live affected)', async () => {
    // Same wiring as above but the stub returns `uncertain` — the cap
    // only applies to confident definite verdicts (dead/live) since
    // an `uncertain` verdict is already self-hedged.
    const client = new FakeLlmClient((messages) => {
      const n = batchSize(messages[0]?.content ?? '');
      const entries = Array.from(
        { length: n },
        (_, i) => `{"i":${i},"verdict":"uncertain","confidence":0.95,"reason":"plausibly used"}`,
      );
      return `{"results":[${entries.join(',')}]}`;
    });

    const result = await judgeDeadCode(cg.queries, client, { concurrency: 1, batchSize: 8 });
    const tx = result.results.find((r) => r.node.name === 'transaction' && r.node.kind === 'method');
    expect(tx).toBeDefined();
    expect(tx!.verdict).toBe('uncertain');
    expect(tx!.confidence).toBe(0.95);
    expect(tx!.reason).not.toMatch(/hedge:/i);
  });
});
