/**
 * Tier 1 #3, Tier 2 #4/#5, Tier 3 #7/#8: directory summaries, role
 * classifier, change-intent, dead-code judge, naming drift.
 *
 * Uses vi.spyOn on LlmClient.prototype and FakeEmbeddingProvider
 * instead of the openai-compat HTTP fake server (deleted 2026-05-15).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findNodesByRole, getRoleCounts } from '../src/db/queries-roles.js';
import { getAllDirectorySummaries } from '../src/db/queries-directory-summaries.js';
import { pendingSummariesBatch, saveAgentSummaries } from '../src/llm/agent-bridge.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { getSummaryByContentHash, getSummaryCoverage } from '../src/db/queries-summaries.js';
import { llmSummarizeChange, llmFindDeadCode, llmCheckNamingDrift } from '../src/cartograph-llm-service.js';
import { LlmClient } from '../src/llm/client.js';
import * as embeddingClientModule from '../src/llm/embedding-client.js';
import { defaultChatHandler, createFakeLlmClient } from './helpers/fake-chat-client.js';
import { FakeEmbeddingProvider } from './helpers/fake-embedding-provider.js';

// ── chat response helpers ─────────────────────────────────────────────────────

// Mirrors the old fake-Ollama `/chat/completions` logic. These are re-used
// by tests that override the spy to inject deterministic responses.

/** Count the number of items in a batched LLM prompt. */
function countBatchedItems(userText: string, isSummary: boolean): number {
  if (isSummary) {
    const headers = userText.match(/^###\s+\d+\./gm);
    return headers?.length ?? 1;
  }
  const m = /Symbols \(zero-indexed\):\n([\s\S]*?)\n\n/.exec(userText);
  const lines = (m?.[1] ?? '').split('\n').filter((l) => /^\d+\./.test(l));
  return lines.length || 1;
}

function batchedChatText(userText: string): string {
  const isSummary = userText.includes('Write a SINGLE LINE summary');
  const n = countBatchedItems(userText, isSummary);
  // Classifier + dead-code judge moved to object-rooted structured
  // output (queue item 9); the batch summarizer is still a bare array.
  if (userText.includes('reviewing whether symbols are dead code')) {
    const entries = Array.from(
      { length: n },
      (_, i) => `{"i":${i},"verdict":"uncertain","confidence":0.5,"reason":"batch stub"}`,
    ).join(',');
    return `{"results":[${entries}]}`;
  }
  if (isSummary) {
    return (
      '[' + Array.from({ length: n }, (_, i) => `{"i":${i},"summary":"Batched stub summary ${i}"}`).join(',') + ']'
    );
  }
  const roles = Array.from({ length: n }, (_, i) => `{"i":${i},"role":"business_logic"}`).join(',');
  return `{"results":[${roles}]}`;
}

function singleItemChatText(userText: string): string {
  if (userText.includes('Reply with EXACTLY one JSON object')) {
    if (userText.includes('"verdict"')) {
      return '{"verdict": "uncertain", "confidence": 0.5, "reason": "test stub"}';
    }
    if (userText.includes('"consistent"')) {
      return '{"consistent": true, "suggestion": "", "reason": "test stub"}';
    }
    return 'unknown';
  }
  if (userText.includes('Classify the following code symbol')) return 'business_logic';
  if (userText.includes('Module summary:')) return 'Coordinates a small module that does test things.';
  return 'Test stub summary line.';
}

/** Full chat handler that mirrors the old fake-Ollama server. */
function tiersChatHandler(messages: Array<{ role: string; content: string }>): string {
  const userText = messages[0]?.content ?? '';
  if (userText.includes('Symbols (zero-indexed):')) return batchedChatText(userText);
  return singleItemChatText(userText);
}

// ── suite ─────────────────────────────────────────────────────────────────────

const FAKE_CHAT_MODEL = '/fake/models/qwen2.5-coder.gguf';
const FAKE_EMBED_MODEL = '/fake/models/nomic-embed.gguf';

describe('Tier extensions', () => {
  let tempDir: string;
  let fakeEmbed: FakeEmbeddingProvider;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tiers-'));
    fakeEmbed = new FakeEmbeddingProvider();

    // Global spy: all LlmClient.prototype.chat calls route through
    // tiersChatHandler. Individual tests can override with vi.spyOn again
    // to inject their own response for one call.
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: tiersChatHandler(msgs),
      durationMs: 1,
    }));
    vi.spyOn(embeddingClientModule, 'createEmbeddingClient').mockReturnValue(fakeEmbed);

    // Two files in two different dirs to give the directory summarizer
    // and naming-drift checker enough siblings to be meaningful.
    fs.mkdirSync(path.join(tempDir, 'src', 'auth'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src', 'util'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'auth', 'token.ts'),
      `export function createToken(user: string): string {
  const payload = { user };
  const sig = 'fake';
  return JSON.stringify(payload) + sig;
}

export function verifyToken(token: string): boolean {
  const valid = token.length > 0;
  const checked = true;
  return valid && checked;
}

export class TokenStore {
  private bag: Map<string, string> = new Map();
  put(k: string, v: string): void { this.bag.set(k, v); }
  get(k: string): string | undefined { return this.bag.get(k); }
  size(): number { return this.bag.size; }
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'util', 'helpers.ts'),
      `export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth();
  return y + '-' + m;
}

export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
`,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('directory summary text round-trips correctly (column-order regression)', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL },
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();

      const all = getAllDirectorySummaries(cg.queries);
      expect(all.length).toBeGreaterThan(0);
      for (const { summary } of all) {
        // Summaries must be prose, not 32-char hex (which would be
        // a content_hash bleeding into the wrong column).
        expect(summary).not.toMatch(/^[0-9a-f]{32}$/);
        expect(summary.length).toBeGreaterThan(20);
      }
    } finally {
      cg.close();
    }
  });

  it('background pass writes directory summaries and role labels', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL },
          embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8080', model: FAKE_EMBED_MODEL },
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();

      // Directory summaries: at least one of the two source dirs
      // should have one (3+ symbol threshold).
      const dirs = getAllDirectorySummaries(cg.queries);
      expect(dirs.length).toBeGreaterThan(0);

      // Role classification: every summarised symbol should have a
      // role assigned (classifier returns "business_logic" for our
      // fake responses).
      const counts = getRoleCounts(cg.queries);
      expect([...counts.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

      // findNodesByRole returns the matching nodes
      const businessLogic = findNodesByRole(cg.queries, 'business_logic', 100);
      expect(businessLogic.length).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });

  it('classifier input cascade: docstring-only node gets classified when summary is absent', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL },
          embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8080', model: FAKE_EMBED_MODEL },
        },
      },
    });
    try {
      await cg.indexAll({ summarize: false });

      // Manually attach a docstring to one node, leave summaries empty.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (cg.queries as any).db;
      const target = db
        .prepare(`SELECT id FROM nodes WHERE kind IN ('function', 'method') ORDER BY id LIMIT 1`)
        .get() as { id: string } | undefined;
      expect(target).toBeDefined();
      db.prepare(`UPDATE nodes SET docstring = ? WHERE id = ?`).run(
        'Persists a fresh user record into the SQLite store.',
        target!.id,
      );

      const hasSummary = db.prepare(`SELECT COUNT(*) AS c FROM symbol_summaries WHERE node_id = ?`).get(target!.id) as {
        c: number;
      };
      expect(hasSummary.c).toBe(0);

      const result = await cg.llm.classifyAll({ concurrency: 1 });
      expect(result.candidates).toBeGreaterThan(0);
      expect(result.classified).toBeGreaterThan(0);

      // The docstring-only node now has a role on nodes.role.
      const role = db.prepare(`SELECT role FROM nodes WHERE id = ?`).get(target!.id) as { role: string | null };
      expect(role.role).not.toBeNull();
      expect(role.role).not.toBe('');
    } finally {
      cg.close();
    }
  });

  it('cg.llm.classifyAll() repopulates roles without re-summarising', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: { summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL } },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();

      const summarisedBefore = getSummaryCoverage(cg.queries).summarised;
      expect(summarisedBefore).toBeGreaterThan(0);

      const rolesBefore = getRoleCounts(cg.queries);
      expect([...rolesBefore.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

      // Wipe role assignments. Summaries themselves stay intact.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (cg.queries as any).db;
      db.exec(`UPDATE nodes SET role = NULL, role_model = NULL`);

      const rolesAfterWipe = getRoleCounts(cg.queries);
      expect([...rolesAfterWipe.values()].reduce((a, b) => a + b, 0)).toBe(0);

      const chatSpy = LlmClient.prototype.chat as unknown as { mock: { calls: unknown[][] } };
      const callsBefore = chatSpy.mock.calls.length;
      const result = await cg.llm.classifyAll({ concurrency: 2 });
      expect(result.candidates).toBeGreaterThan(0);
      expect(result.classified).toBeGreaterThan(0);

      // Roles came back. Summaries are still the same count.
      const rolesAfter = getRoleCounts(cg.queries);
      expect([...rolesAfter.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
      const summarisedAfter = getSummaryCoverage(cg.queries).summarised;
      expect(summarisedAfter).toBe(summarisedBefore);

      // The spy logged classifier chat calls but no summariser calls.
      expect(chatSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      cg.close();
    }
  });

  it('clearStructural preserves symbol_summaries across re-index (cochange hook does not wipe)', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: { summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL } },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();
      const summariesAfterFirst = getSummaryCoverage(cg.queries).summarised;
      expect(summariesAfterFirst).toBeGreaterThan(0);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queries = (cg as any).queries as import('../src/db/queries.js').QueryBuilder;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (queries as any).db;
      const rowCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM symbol_summaries').get() as { c: number }).c;
      expect(rowCountBefore).toBe(summariesAfterFirst);

      cg.clearStructural();

      const rowCountAfterClear = (db.prepare('SELECT COUNT(*) AS c FROM symbol_summaries').get() as { c: number }).c;
      // Strict equality — clearStructural must NOT touch summaries.
      expect(rowCountAfterClear).toBe(rowCountBefore);

      const chatSpy = LlmClient.prototype.chat as unknown as { mock: { calls: unknown[][] } };
      const callsAfterFirst = chatSpy.mock.calls.length;

      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();

      const rowCountAfterReindex = (db.prepare('SELECT COUNT(*) AS c FROM symbol_summaries').get() as { c: number }).c;
      expect(rowCountAfterReindex).toBe(rowCountBefore);

      const incremental = chatSpy.mock.calls.length - callsAfterFirst;
      expect(incremental).toBeLessThan(callsAfterFirst);
    } finally {
      cg.close();
    }
  });

  it('content-hash fallback reuses summary when node_id changes', async () => {
    const { contentHashFor } = await import('../src/llm/summarizer.js');
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: { summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL } },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queries = (cg as any).queries as import('../src/db/queries.js').QueryBuilder;
      const allSummaries = queries[
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'db'
      ]
        .prepare('SELECT node_id, content_hash, model FROM symbol_summaries LIMIT 1')
        .all() as Array<{ node_id: string; content_hash: string; model: string }>;
      expect(allSummaries.length).toBeGreaterThan(0);
      const seed = allSummaries[0]!;

      const hit = getSummaryByContentHash(queries, seed.content_hash, seed.model);
      expect(hit).not.toBeNull();
      // Content-addressed reuse returns the cached summary text only — it no
      // longer reports an originating node_id (the lookup hits summary_store
      // directly, so it works even when every ref has been evicted).
      expect(hit!.summary.length).toBeGreaterThan(0);

      expect(getSummaryByContentHash(queries, seed.content_hash, 'different-model')).toBeNull();
      expect(getSummaryByContentHash(queries, '00'.repeat(16), seed.model)).toBeNull();

      expect(typeof contentHashFor).toBe('function');
    } finally {
      cg.close();
    }
  });

  it('parseBatchSummaries extracts summaries, tolerates prose, rejects under-coverage', async () => {
    const { parseBatchSummaries } = await import('../src/llm/summarizer.js');
    const clean = '[{"i":0,"summary":"Builds a thing."},{"i":1,"summary":"Tears it down."}]';
    const m = parseBatchSummaries(clean, 2);
    expect(m).not.toBeNull();
    expect(m!.get(0)).toBe('Builds a thing.');
    expect(m!.get(1)).toBe('Tears it down.');

    const noisy = 'Sure: [{"i":0,"summary":"Does X."}] hope this helps';
    expect(parseBatchSummaries(noisy, 1)?.get(0)).toBe('Does X.');

    const tricky = '[{"i":0,"summary":"Handles arrays like [1,2,3] correctly"}]';
    expect(parseBatchSummaries(tricky, 1)?.get(0)).toContain('[1,2,3]');

    const sparse = '[{"i":0,"summary":"only one"}]';
    expect(parseBatchSummaries(sparse, 5)).toBeNull();

    expect(parseBatchSummaries('not json', 3)).toBeNull();
    expect(parseBatchSummaries('', 1)).toBeNull();
  });

  it('summary batching reduces chat-call count when batchSize > 1', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: { summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL } },
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queries = (cg as any).queries;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projectRoot = (cg as any).projectRoot;
      const { summarizeAll } = await import('../src/llm/summarizer.js');
      const client = createFakeLlmClient(defaultChatHandler);

      const result = await summarizeAll({
        projectRoot,
        queries,
        client,
        modelLabel: FAKE_CHAT_MODEL,
        options: {
          concurrency: 1,
          summaryBatchSize: 3,
        },
      });

      expect(result.generated).toBeGreaterThan(0);

      // The key invariant — number of LLM calls is roughly
      // ceil(generated / batchSize), not equal to generated.
      const expectedMaxCalls = Math.ceil(result.generated / 3) + 2;
      expect(client.chatCalls).toBeLessThanOrEqual(expectedMaxCalls);
      expect(client.chatCalls).toBeLessThan(result.generated);
    } finally {
      cg.close();
    }
  });

  it('summary batching: cache hits never burn batch slots', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: { summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL } },
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queries = (cg as any).queries;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projectRoot = (cg as any).projectRoot;
      const { summarizeAll } = await import('../src/llm/summarizer.js');
      const client = createFakeLlmClient(defaultChatHandler);

      const firstPass = await summarizeAll({
        projectRoot,
        queries,
        client,
        modelLabel: FAKE_CHAT_MODEL,
        options: { concurrency: 1, summaryBatchSize: 3 },
      });
      expect(firstPass.generated).toBeGreaterThan(0);

      const callsAfterFirst = client.chatCalls;

      const secondPass = await summarizeAll({
        projectRoot,
        queries,
        client,
        modelLabel: FAKE_CHAT_MODEL,
        options: { concurrency: 1, summaryBatchSize: 3 },
      });
      const incremental = client.chatCalls - callsAfterFirst;

      expect(secondPass.cacheHits).toBe(firstPass.cacheHits + firstPass.generated);
      expect(secondPass.generated).toBe(0);
      expect(incremental).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('parseBatchSummaries: ≥80% coverage gate works at batch=5 (4 of 5 ok, 3 of 5 fails)', async () => {
    const { parseBatchSummaries } = await import('../src/llm/summarizer.js');
    const fourOfFive = '[' + Array.from({ length: 4 }, (_, i) => `{"i":${i},"summary":"s${i}"}`).join(',') + ']';
    expect(parseBatchSummaries(fourOfFive, 5)?.size).toBe(4);
    const threeOfFive = '[' + Array.from({ length: 3 }, (_, i) => `{"i":${i},"summary":"s${i}"}`).join(',') + ']';
    expect(parseBatchSummaries(threeOfFive, 5)).toBeNull();
  });

  it('summarizeChange honors before-only and after-only modes', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: { summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL } },
      },
    });
    try {
      const added = await llmSummarizeChange(cg.llm, {
        name: 'newFn',
        kind: 'function',
        beforeBody: '',
        afterBody: 'function newFn() { return 1; }',
      });
      expect(added.intent.length).toBeGreaterThan(0);

      const removed = await llmSummarizeChange(cg.llm, {
        name: 'oldFn',
        kind: 'function',
        beforeBody: 'function oldFn() { return 1; }',
        afterBody: '',
      });
      expect(removed.intent.length).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });

  it('findDeadCodeCandidates returns parsed verdicts', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: { summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL } },
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      const result = await llmFindDeadCode(cg.llm, { maxCandidates: 5 });
      expect(result.candidates).toBeGreaterThanOrEqual(result.judged);
      expect(result.errors).toBe(0);
      for (const r of result.results) {
        expect(['dead', 'live', 'uncertain']).toContain(r.verdict);
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    } finally {
      cg.close();
    }
  });

  it('parseBatchRoles maps roles by index from a results document', async () => {
    // Grammar-constrained output (queue item 9): the reply is the
    // object-rooted `{"results":[…]}` document, with `role` an enum
    // the constrained backends cannot violate. `parseBatchRoles` is a
    // thin guard — no prose tolerance, no null path.
    const { parseBatchRoles } = await import('../src/llm/classifier.js');
    const clean = '{"results":[{"i":0,"role":"business_logic"},{"i":1,"role":"util"},{"i":2,"role":"data_model"}]}';
    const m = parseBatchRoles(clean, 3);
    expect(m.get(0)).toBe('business_logic');
    expect(m.get(1)).toBe('util');
    expect(m.get(2)).toBe('data_model');

    // A non-label role is dropped (the position defaults to unknown downstream).
    expect(parseBatchRoles('{"results":[{"i":0,"role":"Business Logic"}]}', 1).size).toBe(0);
    // An out-of-range index is dropped.
    expect(parseBatchRoles('{"results":[{"i":9,"role":"util"}]}', 3).size).toBe(0);
    // Malformed JSON, or a bare array that isn't the object-rooted shape → empty map.
    expect(parseBatchRoles('not json', 3).size).toBe(0);
    expect(parseBatchRoles('[{"i":0,"role":"util"}]', 1).size).toBe(0);
  });

  it('parseBatchJudges maps verdicts by index, clamping + whitelisting', async () => {
    const { parseBatchJudges } = await import('../src/llm/dead-code.js');
    const ok =
      '{"results":[{"i":0,"verdict":"dead","confidence":0.9,"reason":"never called"},' +
      '{"i":1,"verdict":"live","confidence":0.7,"reason":"CLI handler"}]}';
    const m = parseBatchJudges(ok, 2);
    expect(m.get(0)?.verdict).toBe('dead');
    expect(m.get(0)?.confidence).toBeCloseTo(0.9);
    expect(m.get(1)?.verdict).toBe('live');

    expect(
      parseBatchJudges('{"results":[{"i":0,"verdict":"dead","confidence":2.5,"reason":"x"}]}', 1).get(0)?.confidence,
    ).toBe(1);
    expect(
      parseBatchJudges('{"results":[{"i":0,"verdict":"maybe","confidence":0.5,"reason":"x"}]}', 1).get(0)?.verdict,
    ).toBe('uncertain');
    expect(parseBatchJudges('not json', 5).size).toBe(0);
  });

  it('agent bridge: pendingSummariesBatch + saveAgentSummaries round-trip without LLM', async () => {
    // No config.llm — exercises the path users without a model would take.
    const cg = await Cartograph.init(tempDir);
    try {
      await cg.indexAll({ summarize: false });

      const batch = pendingSummariesBatch(cg.projectRoot, cg.queries, { limit: 5, modelHint: 'claude-test' });
      expect(batch.items.length).toBeGreaterThan(0);
      expect(batch.total).toBeGreaterThanOrEqual(batch.items.length);
      for (const it of batch.items) {
        expect(it.body.length).toBeGreaterThan(0);
        expect(it.contentHash.length).toBe(32);
      }

      const saved = saveAgentSummaries({
        projectRoot: cg.projectRoot,
        queries: cg.queries,
        items: batch.items.map((it) => ({
          nodeId: it.nodeId,
          contentHash: it.contentHash,
          summary: `Agent-summarised ${it.name}`,
        })),
        modelLabel: 'claude-test',
      });
      expect(saved.saved).toBe(batch.items.length);
      expect(saved.skipped).toBe(0);

      const cov = getSummaryCoverage(cg.queries);
      expect(cov.summarised).toBeGreaterThanOrEqual(batch.items.length);

      const batch2 = pendingSummariesBatch(cg.projectRoot, cg.queries, { limit: 5, modelHint: 'claude-test' });
      const overlap = batch2.items.filter((b) => batch.items.some((a) => a.nodeId === b.nodeId));
      expect(overlap.length).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('agent bridge: stale content_hash is rejected with a clear error', async () => {
    const cg = await Cartograph.init(tempDir);
    try {
      await cg.indexAll({ summarize: false });
      const batch = pendingSummariesBatch(cg.projectRoot, cg.queries, { limit: 1 });
      const item = batch.items[0]!;
      const result = saveAgentSummaries({
        projectRoot: cg.projectRoot,
        queries: cg.queries,
        items: [
          {
            nodeId: item.nodeId,
            contentHash: 'cccccccccccccccccccccccccccccccc', // stale
            summary: 'wrong cache key',
          },
        ],
        modelLabel: 'claude-test',
      });
      expect(result.saved).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]).toMatch(/content_hash drifted/);
    } finally {
      cg.close();
    }
  });

  it('checkNamingDrift returns advisory consistent/suggestion shape', async () => {
    // Override the spy for one call to return an inconsistent verdict.
    const chatSpy = LlmClient.prototype.chat as unknown as { mock: { calls: unknown[][] } };
    let callCount = 0;
    chatSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '{"consistent": false, "suggestion": "createSession", "reason": "siblings use create* prefix"}',
          durationMs: 1,
        };
      }
      return { text: tiersChatHandler([{ role: 'user', content: '' }]), durationMs: 1 };
    });

    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: { summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: FAKE_CHAT_MODEL } },
      },
    });
    try {
      await cg.indexAll({ summarize: false });

      const verdict = await llmCheckNamingDrift(cg.llm, {
        name: 'makeSession',
        kind: 'function',
        filePath: 'src/auth/new.ts',
      });
      expect(verdict.consistent).toBe(false);
      expect(verdict.suggestion).toBe('createSession');
    } finally {
      cg.close();
    }
  });
});
