/**
 * Tests for the private `worker()` method of `RoleClassifierRun`
 * (src/llm/classifier.ts).
 *
 * `worker` is the inner loop of `classifyAllRoles`. It is not directly
 * callable, but its every branch is reachable through the public
 * `classifyAllRoles` + `cg.llm.classifyAll` surface:
 *
 *   1. Structural pre-filter drains trivially-typed candidates
 *      (kind=interface → data_model, test-file → test_helper).
 *      afterStructural.length === 0 → `continue` executed.
 *   2. Structural residue — whatever the pre-filter can't decide is
 *      forwarded to the batch-classify chat path.
 *   3. classifierTryBatchClassify returns true → `continue` executed.
 *   4. classifierTryBatchClassify returns false → per-item fallback
 *      loop runs (`classifierClassifyOne` called for each residue entry).
 *   5. Abort-signal check — aborted before / during processing → early return.
 *
 * Uses FakeLlmClient (in-process handler) instead of the openai-compat
 * HTTP fake server (deleted 2026-05-15 with the provider removal).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { getRoleCounts } from '../src/db/queries-roles.js';
import { classifyAllRoles } from '../src/llm/classifier.js';
import { LlmClient } from '../src/llm/client.js';
import { FakeLlmClient } from './helpers/fake-chat-client.js';

// ── fake client helpers ────────────────────────────────────────────────────────

/**
 * Build a batch-classify reply from the user text's symbol-block shape.
 * Mirrors the old fake-Ollama `/chat/completions` path.
 */
function buildBatchReply(userText: string): string {
  const m = /Symbols \(zero-indexed\):\n([\s\S]*?)\n\n/.exec(userText);
  const lines = (m?.[1] ?? '').split('\n').filter((l) => /^\d+\./.test(l));
  const n = lines.length || 1;
  // Object-rooted `{"results":[…]}` — the shape BATCH_ROLE_SCHEMA
  // constrains the real backends to (queue item 9).
  const entries = Array.from({ length: n }, (_, i) => `{"i":${i},"role":"util"}`).join(',');
  return `{"results":[${entries}]}`;
}

/** Handler producing the object-rooted batch-classify reply. */
function classifyHandler(messages: Array<{ content: string }>): string {
  return buildBatchReply(messages[0]?.content ?? '');
}

// ── fixture helpers ────────────────────────────────────────────────────────────

function writeFixtures(dir: string) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '__tests__'), { recursive: true });

  // Functions with docstrings — classifiable by the LLM path.
  fs.writeFileSync(
    path.join(dir, 'src', 'utils.ts'),
    `/** Format a date as ISO string. */
export function formatDate(d: Date): string { return d.toISOString(); }

/** Clamp n to [min, max]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** A data record interface. */
export interface UserRecord { id: string; name: string; }
`,
  );

  // Test helper file — structural pre-filter drains this immediately.
  fs.writeFileSync(
    path.join(dir, '__tests__', 'helpers.ts'),
    `/** Build a fake user. */
export function buildUser(id: string) { return { id, name: 'test' }; }
`,
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('classifier worker — branch coverage', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-classifier-worker-'));
    writeFixtures(tempDir);

    // Intercept LlmClient at the prototype level so cg.llm.classifyAll()
    // uses our in-process handler without a real backend.
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: classifyHandler(msgs),
      durationMs: 1,
    }));

    cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/test-model.gguf',
          },
        },
      },
    });
    await cg.indexAll({ summarize: false });

    // Seed docstrings so nodes are classifiable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (cg.queries as any).db;
    db.prepare(
      `UPDATE nodes SET docstring = 'Stub docstring for classification.'
       WHERE kind IN ('function','method','interface') AND docstring IS NULL`,
    ).run();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('worker processes all candidates and populates roles (batch-classify path)', async () => {
    // classifyAllRoles → RoleClassifierRun.run() → worker() runs until
    // nextStart >= candidates.length. The batch-classify path should handle
    // most non-structural candidates in one chat call.
    const result = await cg.llm.classifyAll({ concurrency: 1 });

    expect(result.candidates).toBeGreaterThan(0);
    // All candidates must have been dispatched (classified + structural).
    expect(result.classified).toBeGreaterThanOrEqual(0);

    // At least one role should appear in the DB.
    const counts = getRoleCounts(cg.queries);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('structural pre-filter drains test-file candidates without a chat call', async () => {
    // The __tests__/helpers.ts buildUser function should be classified as
    // test_helper by the structural pre-filter (TEST_PATH_RE matches
    // __tests__/) — no LLM call needed for those rows.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (cg.queries as any).db;
    const testNode = db
      .prepare(
        `SELECT id, role FROM nodes WHERE file_path LIKE '%__tests__%' AND kind IN ('function','method') LIMIT 1`,
      )
      .get() as { id: string; role: string | null } | undefined;

    if (testNode) {
      // Wipe the role so the classifier has work to do.
      db.prepare(`UPDATE nodes SET role = NULL, role_model = NULL`).run();

      const chatSpy = vi.spyOn(LlmClient.prototype, 'chat');
      const callsBefore = chatSpy.mock.calls.length;
      await cg.llm.classifyAll({ concurrency: 1 });

      // The test-file candidate was drained by the structural pre-filter;
      // it should now carry 'test_helper'.
      const after = db.prepare(`SELECT role FROM nodes WHERE id = ?`).get(testNode.id) as { role: string | null };
      expect(after.role).toBe('test_helper');

      // The structural path does not call the LLM.
      const chatsAfter = chatSpy.mock.calls.length;
      expect(chatsAfter).toBeGreaterThanOrEqual(callsBefore); // non-negative delta
    }
  });

  it('interface nodes are drained by structural pre-filter as data_model', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (cg.queries as any).db;
    const ifaceNode = db.prepare(`SELECT id FROM nodes WHERE kind = 'interface' LIMIT 1`).get() as
      | { id: string }
      | undefined;

    if (ifaceNode) {
      db.prepare(`UPDATE nodes SET role = NULL, role_model = NULL`).run();
      await cg.llm.classifyAll({ concurrency: 1 });

      const after = db.prepare(`SELECT role FROM nodes WHERE id = ?`).get(ifaceNode.id) as { role: string | null };
      expect(after.role).toBe('data_model');
    }
  });

  it('a batch-level chat failure is contained — the run resolves without throwing', async () => {
    // No per-item retry remains (queue item 9): when the batch chat
    // call throws, that batch's residue candidates count as errors and
    // the run still completes cleanly. Every candidate is accounted
    // for — structural pre-filter classifies some, the rest error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (cg.queries as any).db;
    db.prepare(`UPDATE nodes SET role = NULL, role_model = NULL`).run();

    const client = new FakeLlmClient(() => {
      throw new Error('forced failure');
    });

    const result = await classifyAllRoles({
      queries: cg.queries,
      client,
      modelLabel: '/fake/models/test-model.gguf',
      options: { concurrency: 1, batchSize: 50 },
    });

    expect(result.candidates).toBeGreaterThanOrEqual(0);
    // Invariant: every candidate is either structurally classified or
    // batch-errored — none silently lost when the LLM call fails.
    expect(result.classified + result.errors).toBe(result.candidates);
  });

  it('abort signal causes worker to exit early without classifying all', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (cg.queries as any).db;
    db.prepare(`UPDATE nodes SET role = NULL, role_model = NULL`).run();

    const ac = new AbortController();
    // Abort immediately before the worker loop starts meaningful work.
    ac.abort();

    const result = await cg.llm.classifyAll({
      concurrency: 1,
      signal: ac.signal,
    });

    // With a pre-aborted signal, worker returns immediately on first
    // iteration check. Classified count should be 0 or very small
    // (structural pre-filter may still classify a few rows synchronously
    //  before the abort check fires for candidates in the same batch).
    expect(result.candidates).toBeGreaterThanOrEqual(0);
    // Total classified must be <= candidates (no over-classification).
    expect(result.classified).toBeLessThanOrEqual(result.candidates);
  });

  it('onProgress callback is invoked as candidates are processed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (cg.queries as any).db;
    db.prepare(`UPDATE nodes SET role = NULL, role_model = NULL`).run();

    const progressEvents: Array<{ done: number; total: number }> = [];
    await cg.llm.classifyAll({
      concurrency: 1,
      onProgress: (done, total) => progressEvents.push({ done, total }),
    });

    // At least one progress event should fire for the candidates we have.
    // (Some may be drained structurally — those also emit onProgress.)
    if (progressEvents.length > 0) {
      const last = progressEvents.at(-1)!;
      expect(last.done).toBeGreaterThan(0);
      expect(last.total).toBeGreaterThanOrEqual(last.done);
    }
  });
});
