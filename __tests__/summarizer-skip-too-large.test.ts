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

/** A llama.cpp-shaped context-window 400 (matched by isContextWindowError). */
const CONTEXT_400 =
  'chat endpoint returned 400: request (1200 tokens) exceeds the available context size, try increasing it';

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
});
