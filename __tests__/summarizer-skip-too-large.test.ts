/**
 * Reactive #27 — context-too-large summary skips.
 *
 * When a summary prompt exceeds the chat backend's per-slot context the
 * backend returns HTTP 400. The summariser records a skip (keyed by the
 * failing body_hash) so the symbol stops re-attempting every pass and
 * leaves the retryable `pending` set, surfacing instead as a distinct
 * "too large" bucket. `summarize --all` (uncapped) clears the skips to
 * retry — e.g. after the operator raises the backend's `-c`.
 *
 * Uses vi.spyOn on LlmClient so no real GGUF backend is needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { LlmClient, LlmEndpointError } from '../src/llm/client.js';
import { defaultChatHandler } from './helpers/fake-chat-client.js';
import { countCurrentSummarySkips } from '../src/db/queries-summary-skips.js';
import { getSymbolSummary } from '../src/db/queries-summaries.js';

/** Two functions, each with a 4+-line body so both clear the
 *  MIN_BODY_LINES summarizable gate. */
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
`;

/** A single function with a >12-line body so the degraded retry's head/tail
 *  truncation (eliding the middle) actually shrinks the prompt — small bodies
 *  short-circuit `truncateBodyForContextRetry` to a no-op and skip directly. */
const LARGE_FIXTURE = `export function gamma(input: number[]): number {
  let total = 0;
  for (let i = 0; i < input.length; i++) {
    const v = input[i] ?? 0;
    total += v;
    total *= 1.0001;
    total -= 0.5;
    if (total > 1000) total = 1000;
    if (total < -1000) total = -1000;
    const adjusted = total / 2;
    const squared = adjusted * adjusted;
    total += squared * 0.0001;
    const tweak = Math.sin(i) * 3;
    total += tweak;
    const damp = Math.cos(i) * 2;
    total -= damp;
    total = Math.round(total * 100) / 100;
  }
  const finalValue = total + input.length;
  return finalValue;
}
`;

/** A llama.cpp-shaped context-window 400 (matched by isContextWindowError). */
const CONTEXT_400 =
  'chat endpoint returned 400: request (1200 tokens) exceeds the available context size, try increasing it';

/** Marker the degraded-retry prompt carries (head/tail body elision) — lets a
 *  chat mock tell the full-body call from the truncated retry. */
const ELISION_MARKER = 'body elided for context';

describe('Reactive #27 — context-too-large summary skips', () => {
  let tempDir: string;
  let cg: Cartograph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-skip-toolarge-'));
    fs.writeFileSync(path.join(tempDir, 'sample.ts'), FIXTURE);
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
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

  function symbolIds(graph: Cartograph): string[] {
    return (
      graph.db.getDb().prepare("SELECT id FROM nodes WHERE name IN ('alpha','bravo')").all() as Array<{ id: string }>
    ).map((r) => r.id);
  }

  it('records a skip on a context-window 400 (not an error) and stops re-attempting', async () => {
    cg = await openIndexed();
    vi.spyOn(LlmClient.prototype, 'chat').mockRejectedValue(new LlmEndpointError(CONTEXT_400, 400));

    const first = await cg.llm.summarizeAll({ concurrency: 1 });
    expect(first.candidates).toBe(2);
    expect(first.skippedTooLarge).toBe(2);
    expect(first.errors).toBe(0);
    expect(first.generated).toBe(0);
    // Recorded as a distinct bucket; no summaries written.
    expect(countCurrentSummarySkips(cg.queries)).toBe(2);
    const ids = symbolIds(cg);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(getSymbolSummary(cg.queries, id)).toBeNull();

    // Second capped pass: skipped symbols are no longer candidates — the
    // per-pass retry loop has stopped (not re-attempted forever).
    const second = await cg.llm.summarizeAll({ concurrency: 1 });
    expect(second.candidates).toBe(0);
    expect(second.skippedTooLarge).toBe(0);
  });

  it('`summarize --all` (uncapped) clears skips so a now-fitting backend retries them', async () => {
    cg = await openIndexed();
    vi.spyOn(LlmClient.prototype, 'chat').mockRejectedValue(new LlmEndpointError(CONTEXT_400, 400));
    await cg.llm.summarizeAll({ concurrency: 1 });
    expect(countCurrentSummarySkips(cg.queries)).toBe(2);

    // Backend fixed (operator raised -c): chat now succeeds. The uncapped
    // pass clears the skips and re-summarises both symbols.
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: defaultChatHandler(msgs),
      durationMs: 1,
    }));
    const all = await cg.llm.summarizeAll({ eagerLimit: -1, concurrency: 1 });
    expect(all.candidates).toBe(2);
    expect(all.generated).toBe(2);
    expect(all.skippedTooLarge).toBe(0);
    expect(countCurrentSummarySkips(cg.queries)).toBe(0);
  });

  it('a non-context endpoint error still counts as an error, not a skip', async () => {
    cg = await openIndexed();
    vi.spyOn(LlmClient.prototype, 'chat').mockRejectedValue(
      new LlmEndpointError('chat endpoint returned 400: malformed request', 400),
    );
    const result = await cg.llm.summarizeAll({ concurrency: 1 });
    expect(result.skippedTooLarge).toBe(0);
    expect(result.errors).toBe(2);
    expect(countCurrentSummarySkips(cg.queries)).toBe(0);
  });

  function gammaSummary(graph: Cartograph): ReturnType<typeof getSymbolSummary> {
    const row = graph.db.getDb().prepare("SELECT id FROM nodes WHERE name = 'gamma'").get() as
      | { id: string }
      | undefined;
    expect(row).toBeDefined();
    return getSymbolSummary(graph.queries, row!.id);
  }

  /** Did a degraded retry actually fire? True iff some chat call carried a
   *  user message with the head/tail elision marker. Robust to the unrelated
   *  file/dir summary chat calls the service makes when a symbol succeeds
   *  (so it beats asserting an exact total call count). */
  function truncatedRetryIssued(spy: ReturnType<typeof vi.spyOn>): boolean {
    return spy.mock.calls.some((call) => {
      const msgs = call[0] as Array<{ role: string; content: string }> | undefined;
      return msgs?.some((m) => m.role === 'user' && m.content.includes(ELISION_MARKER)) ?? false;
    });
  }

  it('recovers a too-large symbol via a truncated retry (no skip, summary persisted)', async () => {
    fs.writeFileSync(path.join(tempDir, 'sample.ts'), LARGE_FIXTURE);
    cg = await openIndexed();
    // Full prompt overflows the slot; the hard-truncated retry (carrying the
    // elision marker) fits and succeeds — the summary is the degraded path's.
    const chatSpy = vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => {
      const user = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (user.includes(ELISION_MARKER)) {
        return { text: 'aggregates the input array into a damped running total', durationMs: 1 };
      }
      throw new LlmEndpointError(CONTEXT_400, 400);
    });

    const result = await cg.llm.summarizeAll({ concurrency: 1 });
    expect(result.candidates).toBe(1);
    expect(result.generated).toBe(1);
    expect(result.skippedTooLarge).toBe(0);
    expect(result.errors).toBe(0);
    expect(countCurrentSummarySkips(cg.queries)).toBe(0);
    expect(truncatedRetryIssued(chatSpy)).toBe(true); // the degraded retry produced it
    expect(gammaSummary(cg)?.summary).toBe('aggregates the input array into a damped running total');
  });

  it('records a skip when even the truncated retry exceeds context', async () => {
    fs.writeFileSync(path.join(tempDir, 'sample.ts'), LARGE_FIXTURE);
    cg = await openIndexed();
    // Both the full and the truncated prompt overflow → genuinely unsummarizable.
    const chatSpy = vi.spyOn(LlmClient.prototype, 'chat').mockRejectedValue(new LlmEndpointError(CONTEXT_400, 400));

    const result = await cg.llm.summarizeAll({ concurrency: 1 });
    expect(result.candidates).toBe(1);
    expect(result.skippedTooLarge).toBe(1);
    expect(result.generated).toBe(0);
    expect(result.errors).toBe(0);
    expect(countCurrentSummarySkips(cg.queries)).toBe(1);
    expect(truncatedRetryIssued(chatSpy)).toBe(true); // the degraded retry WAS attempted before skipping
    expect(gammaSummary(cg)).toBeNull();
  });

  it('counts a transient failure on the truncated retry as an error, not a skip', async () => {
    fs.writeFileSync(path.join(tempDir, 'sample.ts'), LARGE_FIXTURE);
    cg = await openIndexed();
    // Full prompt is a context-400, but the degraded retry hits a transient
    // 503 — must NOT be poison-skipped (it could succeed on a later pass).
    const chatSpy = vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => {
      const user = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (user.includes(ELISION_MARKER)) {
        throw new LlmEndpointError('chat endpoint returned 503: service unavailable', 503);
      }
      throw new LlmEndpointError(CONTEXT_400, 400);
    });

    const result = await cg.llm.summarizeAll({ concurrency: 1 });
    expect(result.errors).toBe(1);
    expect(result.skippedTooLarge).toBe(0);
    expect(countCurrentSummarySkips(cg.queries)).toBe(0);
    expect(truncatedRetryIssued(chatSpy)).toBe(true);
  });
});
