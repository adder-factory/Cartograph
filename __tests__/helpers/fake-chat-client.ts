/**
 * FakeLlmClient — test double for LlmClient.
 *
 * Replaces the HTTP-based `openai-compat` fake-server pattern (deleted
 * 2026-05-15 with the provider).  Tests that need deterministic chat
 * replies without a real backend (nllc GGUF / claude CLI / Anthropic HTTPS)
 * extend this class or use `FakeLlmClient.withHandler`.
 *
 * Tracks call counts so tests can assert which phases fired.
 */

import { LlmClient, type ChatMessage, type ChatOptions, type ChatResult } from '../../src/llm/client.js';

export type FakeChatHandler = (messages: ChatMessage[]) => string;

/**
 * LlmClient subclass whose `chat()` delegates to an in-process handler
 * instead of any real backend.  `isReachable()` always returns true.
 */
export class FakeLlmClient extends LlmClient {
  readonly calls: Array<{ messages: ChatMessage[] }> = [];
  private readonly handler: FakeChatHandler;

  constructor(handler: FakeChatHandler) {
    // Pass an empty config — backends are never instantiated because
    // chat() is fully overridden below.
    super({ summarizeLlm: null, askLlm: null, localLlm: null, embeddingLlm: null });
    this.handler = handler;
  }

  override async chat(
    messages: ChatMessage[],
    _options: ChatOptions & { useAskModel?: boolean; useLocalChat?: boolean } = {},
  ): Promise<ChatResult> {
    this.calls.push({ messages });
    const text = this.handler(messages);
    return { text, durationMs: 1 };
  }

  override async isReachable(): Promise<boolean> {
    return true;
  }

  override async listModels(): Promise<string[]> {
    return ['fake-model'];
  }

  get chatCalls(): number {
    return this.calls.length;
  }
}

// ---------------------------------------------------------------------------
// Pre-built handlers that mirror the old fake-Ollama HTTP server behaviour
// ---------------------------------------------------------------------------

const EMBED_DIM = 8;
const EMBED_MOD = 11;

/** Deterministic toy embedding so tests can correlate identical input → identical vector. */
export function fakeEmbedVector(s: string): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  for (let i = 0; i < s.length; i++) v[i % EMBED_DIM] += s.charCodeAt(i) % EMBED_MOD;
  return v;
}

/**
 * Count the number of items in a batched LLM prompt. Uses the
 * `### N.` headers when in summary mode, the `N.` line markers otherwise.
 */
function countBatchedItems(userText: string, isSummary: boolean): number {
  if (isSummary) {
    const headers = userText.match(/^###\s+\d+\./gm);
    return headers?.length ?? 1;
  }
  const m = userText.match(/Symbols \(zero-indexed\):\n([\s\S]*?)\n\n/);
  const lines = (m?.[1] ?? '').split('\n').filter((l) => /^\d+\./.test(l));
  return lines.length || 1;
}

/** Dead-code batch response — object-rooted `{"results":[…]}` to match
 *  the grammar-constrained structured output the judge now requests. */
function batchDeadCodeText(n: number): string {
  const entries = Array.from(
    { length: n },
    (_, i) => `{"i":${i},"verdict":"uncertain","confidence":0.5,"reason":"batch stub"}`,
  ).join(',');
  return `{"results":[${entries}]}`;
}

/** Summary batch response (array of summary objects). */
function batchSummaryText(n: number): string {
  return '[' + Array.from({ length: n }, (_, i) => `{"i":${i},"summary":"Batched stub summary ${i}"}`).join(',') + ']';
}

/** Classifier batch response — object-rooted `{"results":[…]}` to match
 *  the grammar-constrained structured output the classifier now requests. */
function batchClassifyText(n: number): string {
  const entries = Array.from({ length: n }, (_, i) => `{"i":${i},"role":"business_logic"}`).join(',');
  return `{"results":[${entries}]}`;
}

/** Chat handler that mimics the old fake-Ollama `/chat/completions` endpoint. */
export function defaultChatHandler(messages: ChatMessage[]): string {
  const userText = messages[0]?.content ?? '';

  // Batched paths (detected by prompt shape):
  if (userText.includes('Symbols (zero-indexed):')) {
    const isSummary = userText.includes('Write a SINGLE LINE summary');
    const n = countBatchedItems(userText, isSummary);
    if (userText.includes('reviewing whether symbols are dead code')) return batchDeadCodeText(n);
    if (isSummary) return batchSummaryText(n);
    return batchClassifyText(n);
  }

  // Per-item fallbacks:
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

  // Default: echo a short deterministic summary based on message tail.
  const last = userText.slice(-200).replace(/\s+/g, ' ').slice(0, 80);
  return 'Summary of: ' + last;
}

/** FakeLlmClient pre-wired with `defaultChatHandler`. */
export function createFakeLlmClient(handler: FakeChatHandler = defaultChatHandler): FakeLlmClient {
  return new FakeLlmClient(handler);
}
