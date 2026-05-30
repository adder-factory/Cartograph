/**
 * Tests for `expandQuery` — query expansion via local LLM.
 *
 * All tests start with a cleared cache (beforeEach) so ordering
 * doesn't affect results.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { expandQuery, clearExpansionCache, _expansionCacheSize } from '../src/llm/query-expansion.js';
import type { LlmClient } from '../src/llm/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal LlmClient stub that satisfies `expandQuery`'s usage. */
function makeStubLlmClient(
  textToReturn: string | (() => string),
  opts: {
    reachable?: boolean;
    shouldThrow?: boolean;
  } = {},
): { client: LlmClient; callCount: () => number } {
  let calls = 0;
  const stub = {
    isReachable: async () => opts.reachable ?? true,
    chat: async (_msgs: unknown, options?: Record<string, unknown>) => {
      calls += 1;
      if (opts.shouldThrow) throw new Error('stubbed LLM failure');
      const text = typeof textToReturn === 'function' ? textToReturn() : textToReturn;
      if ((options?.signal as AbortSignal | undefined)?.aborted) {
        throw new Error('aborted');
      }
      return { text, durationMs: 5 };
    },
  };
  return {
    client: stub as unknown as LlmClient,
    callCount: () => calls,
  };
}

/** A simple multi-line LLM response with 5 paraphrases. */
const FIVE_LINES = ['paraphrase one', 'paraphrase two', 'paraphrase three', 'paraphrase four', 'paraphrase five'].join(
  '\n',
);

beforeEach(() => {
  clearExpansionCache();
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('expandQuery — input validation', () => {
  it('returns [] for n=0 (no LLM call observed)', async () => {
    const { client, callCount } = makeStubLlmClient('irrelevant');
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: 'hello', n: 0 });
    expect(result).toEqual([]);
    expect(callCount()).toBe(0);
  });

  it('returns [] for n=-5 (no LLM call)', async () => {
    const { client, callCount } = makeStubLlmClient('irrelevant');
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: 'hello', n: -5 });
    expect(result).toEqual([]);
    expect(callCount()).toBe(0);
  });

  it('returns [] for empty string', async () => {
    const { client, callCount } = makeStubLlmClient('irrelevant');
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: '' });
    expect(result).toEqual([]);
    expect(callCount()).toBe(0);
  });

  it('returns [] for whitespace-only string', async () => {
    const { client, callCount } = makeStubLlmClient('irrelevant');
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: '   \t\n  ' });
    expect(result).toEqual([]);
    expect(callCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LLM call shape
// ---------------------------------------------------------------------------

describe('expandQuery — LLM call shape', () => {
  it('sends 2 messages (system + user) to chat()', async () => {
    let capturedMessages: unknown = null;
    const stub = {
      isReachable: async () => true,
      chat: async (msgs: unknown) => {
        capturedMessages = msgs;
        return { text: 'result one\nresult two\nresult three', durationMs: 5 };
      },
    } as unknown as LlmClient;

    await expandQuery({ llmClient: stub, model: 'stub-model', text: 'find auth middleware' });
    expect(Array.isArray(capturedMessages)).toBe(true);
    expect((capturedMessages as unknown[]).length).toBe(2);
    const [sys, usr] = capturedMessages as Array<{ role: string; content: string }>;
    expect(sys.role).toBe('system');
    expect(usr.role).toBe('user');
  });

  it('includes the query text in the user message', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const stub = {
      isReachable: async () => true,
      chat: async (msgs: unknown) => {
        capturedMessages = msgs as Array<{ role: string; content: string }>;
        return { text: 'alt a\nalt b\nalt c', durationMs: 5 };
      },
    } as unknown as LlmClient;

    const query = 'how does the parser handle comments';
    await expandQuery({ llmClient: stub, model: 'stub-model', text: query });
    const userMsg = capturedMessages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain(query);
  });

  it('includes the n count in the user message', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const stub = {
      isReachable: async () => true,
      chat: async (msgs: unknown) => {
        capturedMessages = msgs as Array<{ role: string; content: string }>;
        return { text: 'alt a\nalt b\nalt c\nalt d\nalt e', durationMs: 5 };
      },
    } as unknown as LlmClient;

    await expandQuery({ llmClient: stub, model: 'stub-model', text: 'graph traversal', n: 5 });
    const userMsg = capturedMessages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('5');
  });

  it('calls chat with temperature=0.7 and maxTokens=200', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const stub = {
      isReachable: async () => true,
      chat: async (_msgs: unknown, opts: Record<string, unknown>) => {
        capturedOpts = opts ?? {};
        return { text: 'a\nb\nc', durationMs: 5 };
      },
    } as unknown as LlmClient;

    await expandQuery({ llmClient: stub, model: 'stub-model', text: 'resolve imports' });
    expect(capturedOpts.temperature).toBe(0.7);
    expect(capturedOpts.maxTokens).toBe(200);
  });

  it('useLocalChat defaults to true', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const stub = {
      isReachable: async () => true,
      chat: async (_msgs: unknown, opts: Record<string, unknown>) => {
        capturedOpts = opts ?? {};
        return { text: 'a\nb\nc', durationMs: 5 };
      },
    } as unknown as LlmClient;

    await expandQuery({ llmClient: stub, model: 'stub-model', text: 'scope resolution' });
    expect(capturedOpts.useLocalChat).toBe(true);
  });

  it('useLocalChat: false is honored when caller passes it', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const stub = {
      isReachable: async () => true,
      chat: async (_msgs: unknown, opts: Record<string, unknown>) => {
        capturedOpts = opts ?? {};
        return { text: 'a\nb\nc', durationMs: 5 };
      },
    } as unknown as LlmClient;

    await expandQuery({ llmClient: stub, model: 'stub-model', text: 'scope resolution', useLocalChat: false });
    expect(capturedOpts.useLocalChat).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

describe('expandQuery — output parsing', () => {
  it('returns lines from result.text, trimmed', async () => {
    const { client } = makeStubLlmClient('  alt alpha  \n  alt beta  \n  alt gamma  ');
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: 'original query', n: 3 });
    expect(result).toEqual(['alt alpha', 'alt beta', 'alt gamma']);
  });

  it('strips leading numbering "1. foo" → "foo" and "- bar" → "bar"', async () => {
    const { client } = makeStubLlmClient('1. first paraphrase\n- second paraphrase\n3) third paraphrase');
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: 'original query', n: 3 });
    expect(result[0]).toBe('first paraphrase');
    expect(result[1]).toBe('second paraphrase');
    expect(result[2]).toBe('third paraphrase');
  });

  it('filters out empty lines', async () => {
    const { client } = makeStubLlmClient('line one\n\n\nline two\n\nline three');
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: 'query text', n: 5 });
    expect(result).toEqual(['line one', 'line two', 'line three']);
  });

  it('filters out lines >= 500 chars', async () => {
    const longLine = 'x'.repeat(500);
    const { client } = makeStubLlmClient(`good line\n${longLine}\nanother good line`);
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: 'query text', n: 5 });
    expect(result).not.toContain(longLine);
    expect(result).toContain('good line');
    expect(result).toContain('another good line');
  });

  it('filters out lines equal to the input text (de-dup against original)', async () => {
    const input = 'find auth middleware';
    const { client } = makeStubLlmClient(`locate auth middleware\n${input}\nauth middleware lookup`);
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: input, n: 5 });
    expect(result).not.toContain(input);
    expect(result).toContain('locate auth middleware');
    expect(result).toContain('auth middleware lookup');
  });

  it('slices to n=3 even when LLM returns 5 lines', async () => {
    const { client } = makeStubLlmClient(FIVE_LINES);
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: 'original query', n: 3 });
    expect(result.length).toBe(3);
  });

  it('returns [] when LLM returns whitespace-only response', async () => {
    const { client } = makeStubLlmClient('   \n  \n   ');
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: 'original query', n: 3 });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('expandQuery — error handling', () => {
  it('returns [] when chat() throws (LLM call was still observed)', async () => {
    const { client, callCount } = makeStubLlmClient('', { shouldThrow: true });
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: 'find imports', n: 3 });
    expect(result).toEqual([]);
    expect(callCount()).toBe(1); // call WAS made, it just threw
  });

  it('returns [] when signal is already aborted before chat', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = makeStubLlmClient('a\nb\nc');
    // With an already-aborted signal the stub throws "aborted"
    const result = await expandQuery({
      llmClient: client,
      model: 'stub-model',
      text: 'find imports',
      n: 3,
      signal: controller.signal,
    });
    expect(result).toEqual([]);
  });

  it('returns [] (with no chat call) when isReachable() is false', async () => {
    const { client, callCount } = makeStubLlmClient('a\nb\nc', { reachable: false });
    const result = await expandQuery({
      llmClient: client,
      model: 'stub-model',
      text: 'find imports',
      n: 3,
    });
    expect(result).toEqual([]);
    expect(callCount()).toBe(0);
  });

  it('returns [] when isReachable() throws', async () => {
    const stub = {
      isReachable: async () => {
        throw new Error('isReachable boom');
      },
      chat: async () => ({ text: 'a\nb\nc', durationMs: 1 }),
    };
    const result = await expandQuery({
      llmClient: stub as unknown as LlmClient,
      model: 'stub-model',
      text: 'find imports',
      n: 3,
    });
    expect(result).toEqual([]);
  });

  it('returns [] when signal is aborted mid-flight (chat throws)', async () => {
    const controller = new AbortController();
    const stub = {
      isReachable: async () => true,
      chat: async (_msgs: unknown, opts: Record<string, unknown>) => {
        // Simulate abort happening during the LLM call
        controller.abort();
        if ((opts?.signal as AbortSignal | undefined)?.aborted) {
          throw new Error('aborted');
        }
        return { text: 'a\nb\nc', durationMs: 5 };
      },
    } as unknown as LlmClient;

    const result = await expandQuery({
      llmClient: stub,
      text: 'find exports',
      n: 3,
      signal: controller.signal,
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe('expandQuery — caching', () => {
  it('second call with identical args → no second LLM call (spy hit only once)', async () => {
    const { client, callCount } = makeStubLlmClient('alt one\nalt two\nalt three');
    const text = 'how does resolution work';

    const first = await expandQuery({ llmClient: client, model: 'stub-model', text, n: 3 });
    const second = await expandQuery({ llmClient: client, model: 'stub-model', text, n: 3 });

    expect(callCount()).toBe(1);
    expect(second).toEqual(first);
  });

  it('clearExpansionCache() forces a fresh LLM call', async () => {
    const { client, callCount } = makeStubLlmClient('alt one\nalt two\nalt three');
    const text = 'traversal algorithm';

    await expandQuery({ llmClient: client, model: 'stub-model', text, n: 3 });
    clearExpansionCache();
    await expandQuery({ llmClient: client, model: 'stub-model', text, n: 3 });

    expect(callCount()).toBe(2);
  });

  it('different n produces a different cache entry (LLM called twice)', async () => {
    const { client, callCount } = makeStubLlmClient('a\nb\nc\nd\ne');
    const text = 'graph query';

    await expandQuery({ llmClient: client, model: 'stub-model', text, n: 2 });
    await expandQuery({ llmClient: client, model: 'stub-model', text, n: 4 });

    expect(callCount()).toBe(2);
  });

  it('different model produces a different cache entry (LLM called twice)', async () => {
    const { client, callCount } = makeStubLlmClient('a\nb\nc');

    await expandQuery({ llmClient: client, model: 'model-A', text: 'shared query', n: 3 });
    await expandQuery({ llmClient: client, model: 'model-B', text: 'shared query', n: 3 });

    expect(callCount()).toBe(2);
  });

  it('different text produces a different cache entry (LLM called twice)', async () => {
    const { client, callCount } = makeStubLlmClient('a\nb\nc');

    await expandQuery({ llmClient: client, model: 'stub-model', text: 'query A', n: 3 });
    await expandQuery({ llmClient: client, model: 'stub-model', text: 'query B', n: 3 });

    expect(callCount()).toBe(2);
  });

  it('cache size stays <= 256 after > 256 unique queries', async () => {
    // Fire 300 distinct queries; cache must not exceed CACHE_CAPACITY=256
    for (let i = 0; i < 300; i++) {
      const { client } = makeStubLlmClient(`alt ${i}a\nalt ${i}b\nalt ${i}c`);
      await expandQuery({ llmClient: client, model: 'stub-model', text: `unique query number ${i}`, n: 3 });
    }
    expect(_expansionCacheSize()).toBeLessThanOrEqual(256);
  });

  it('LRU: cache hit bumps recency — query A survives 256 inserts after a mid-point read', async () => {
    // Strategy: prime A, fill half the cache (255 unique entries = capacity-1),
    // then READ A (bumping it to most-recent), then fill one more entry which
    // would evict the oldest (the first filler, not A), so A must survive.
    const responseA = 'lru-a1\nlru-a2\nlru-a3';
    const { client: clientA } = makeStubLlmClient(responseA);
    const queryA = 'query A that must survive eviction';

    // 1. Prime A (cache size = 1)
    await expandQuery({ llmClient: clientA, model: 'stub-model', text: queryA, n: 3 });

    // 2. Fill to capacity-1 (255 fillers, cache size = 256 total)
    for (let i = 0; i < 255; i++) {
      const { client } = makeStubLlmClient(`filler ${i}a\nfiller ${i}b\nfiller ${i}c`);
      await expandQuery({ llmClient: client, model: 'stub-model', text: `filler query ${i}`, n: 3 });
    }

    // 3. Read A — bumps it to most-recent
    const { client: bumpClient, callCount: bumpCallCount } = makeStubLlmClient(responseA);
    await expandQuery({ llmClient: bumpClient, model: 'stub-model', text: queryA, n: 3 });
    expect(bumpCallCount()).toBe(0); // must come from cache

    // 4. One more insert → eviction fires, removes the oldest filler (not A)
    const { client: lastClient } = makeStubLlmClient('extra a\nextra b\nextra c');
    await expandQuery({ llmClient: lastClient, model: 'stub-model', text: 'one final unique filler query', n: 3 });

    // 5. A should still be in cache — probe with a new client
    const { client: probeClient, callCount: probeCallCount } = makeStubLlmClient(responseA);
    const result = await expandQuery({ llmClient: probeClient, model: 'stub-model', text: queryA, n: 3 });

    expect(probeCallCount()).toBe(0); // served from cache
    expect(result).toEqual(['lru-a1', 'lru-a2', 'lru-a3']);
  });
});

// ---------------------------------------------------------------------------
// Duplicate filtering
// ---------------------------------------------------------------------------

describe('expandQuery — duplicate filtering', () => {
  it('if LLM returns the original query among paraphrases, that line is dropped', async () => {
    const original = 'find authentication code';
    // LLM "helpfully" echoes the input back as one of its lines
    const { client } = makeStubLlmClient(`alternative phrasing one\n${original}\nalternative phrasing two`);
    const result = await expandQuery({ llmClient: client, model: 'stub-model', text: original, n: 5 });
    expect(result).not.toContain(original);
    expect(result).toContain('alternative phrasing one');
    expect(result).toContain('alternative phrasing two');
  });
});
