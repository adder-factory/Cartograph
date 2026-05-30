/**
 * Lever C — eager-summary limit.
 *
 * The summarize pass orders candidates by importance (priority-queue
 * items first, then PageRank centrality) and stops after `eagerLimit`
 * cache-MISS generations; the tail is left for the demand-driven
 * priority queue. These tests verify the cap, the `deferred` count,
 * the uncapped escape hatch, and the priority-queue exemption.
 *
 * Uses vi.spyOn on LlmClient so no real GGUF backend is needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { LlmClient } from '../src/llm/client.js';
import { defaultChatHandler } from './helpers/fake-chat-client.js';
import { enqueueForPrioritySummary } from '../src/db/queries-summary-priority.js';
import { getSymbolSummary } from '../src/db/queries-summaries.js';

/** Five functions, each with a 4+-line body so all clear
 *  `getSummarizableNodes`' MIN_BODY_LINES gate. */
const FIXTURE = `export function alpha(n: number): number {
  const a = n + 1;
  const b = a * 2;
  const c = b - 3;
  return c;
}

export function bravo(s: string): string {
  const t = s.trim();
  const u = t.toUpperCase();
  const v = u + '!';
  return v;
}

export function charlie(xs: number[]): number {
  let sum = 0;
  for (const x of xs) sum += x;
  const avg = sum / xs.length;
  return avg;
}

export function delta(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const span = hi - lo;
  return span;
}

export function echo(flag: boolean): string {
  const yes = 'on';
  const no = 'off';
  const out = flag ? yes : no;
  return out;
}
`;

describe('Lever C — eager-summary limit', () => {
  let tempDir: string;
  let cg: Cartograph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-eager-limit-'));
    fs.writeFileSync(path.join(tempDir, 'sample.ts'), FIXTURE);
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: defaultChatHandler(msgs),
      durationMs: 1,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (cg) {
      try {
        cg.close();
      } catch {
        /* noop */
      }
      cg = null;
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Index the fixture with summaries deferred to an explicit pass.
   *  No `embeddingLlm` → the chained embed phase is skipped. */
  async function openIndexed(): Promise<Cartograph> {
    const graph = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: '/fake/chat.gguf' },
        },
      },
    });
    await graph.indexAll({ summarize: false });
    return graph;
  }

  it('caps generations at eagerLimit and reports the deferred tail', async () => {
    cg = await openIndexed();
    const result = await cg.llm.summarizeAll({ eagerLimit: 2 });

    expect(result.candidates).toBe(5);
    expect(result.generated).toBe(2);
    expect(result.cacheHits).toBe(0);
    // 5 candidates − 2 generated = 3 left for the priority queue.
    expect(result.deferred).toBe(3);
  });

  it('eagerLimit 0 is ad-hoc only — generates nothing eagerly', async () => {
    cg = await openIndexed();
    const result = await cg.llm.summarizeAll({ eagerLimit: 0 });

    // No priority-queue items → every candidate defers.
    expect(result.generated).toBe(0);
    expect(result.deferred).toBe(5);
  });

  it('negative eagerLimit runs an uncapped full pass', async () => {
    cg = await openIndexed();
    const result = await cg.llm.summarizeAll({ eagerLimit: -1 });

    expect(result.generated).toBe(5);
    expect(result.deferred).toBe(0);
  });

  it('ad-hoc mode (eagerLimit 0) still summarises explicitly-queued symbols', async () => {
    cg = await openIndexed();
    const echoId = (
      cg.db.getDb().prepare("SELECT id FROM nodes WHERE name = 'echo'").get() as { id: string } | undefined
    )?.id;
    expect(echoId).toBeTruthy();

    // Ad-hoc only, but `echo` was explicitly requested → it is exempt
    // from the budget and still summarised. This is the on-demand loop.
    enqueueForPrioritySummary({ qb: cg.queries, nodeIds: [echoId!] });
    const result = await cg.llm.summarizeAll({ eagerLimit: 0 });

    expect(result.generated).toBe(1);
    expect(result.deferred).toBe(4);
    expect(getSymbolSummary(cg.queries, echoId!)?.summary).toBeTruthy();
  });

  it('omitting eagerLimit summarises everything when the corpus is under the default cap', async () => {
    cg = await openIndexed();
    // 5 candidates ≪ DEFAULT_EAGER_SUMMARY_LIMIT (~600) → all summarised.
    const result = await cg.llm.summarizeAll({});

    expect(result.generated).toBe(5);
    expect(result.deferred).toBe(0);
  });

  it('priority-queue items are summarised even when they exceed the budget', async () => {
    cg = await openIndexed();
    const echoId = (
      cg.db.getDb().prepare("SELECT id FROM nodes WHERE name = 'echo'").get() as { id: string } | undefined
    )?.id;
    expect(echoId).toBeTruthy();

    // Demand-driven: `echo` was explicitly requested via an intent-search
    // miss. With eagerLimit 1 it must still be summarised — priority
    // items are exempt from the budget — so generated = 1 (priority) + 1.
    enqueueForPrioritySummary({ qb: cg.queries, nodeIds: [echoId!] });
    const result = await cg.llm.summarizeAll({ eagerLimit: 1 });

    expect(result.generated).toBe(2);
    expect(result.deferred).toBe(3);
    // The explicitly-requested symbol is among those summarised.
    expect(getSymbolSummary(cg.queries, echoId!)?.summary).toBeTruthy();
  });
});
