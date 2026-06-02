/**
 * FakeEmbeddingProvider — test double for `OpenAiSdkEmbeddingClient`.
 *
 * Returns deterministic 8-dim vectors derived from input text so tests
 * can assert ordering without a real HTTP backend / GGUF model.
 * Satisfies the `EmbeddingProvider` interface exported by
 * `src/llm/embedding-client.ts`.
 */

import type { EmbeddingProvider } from '../../src/llm/embedding-client.js';
import { LlmEndpointError } from '../../src/llm/client.js';

const EMBED_DIM = 8;

/** Deterministic 8-dim float vector keyed off character codes. */
function fakeEmbedVector(text: string, index: number = 0): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  for (let i = 0; i < text.length; i++) {
    v[i % EMBED_DIM] += ((text.codePointAt(i) ?? 0) + index) % 17;
  }
  return v;
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly isConfigured = true;
  embedCalls = 0;

  /** Optionally simulate HTTP 500 "input too large" for any input over `capChars`. */
  constructor(public readonly capChars: number = Infinity) {}

  async embed(inputs: string[], _opts?: { signal?: AbortSignal }): Promise<Float32Array[]> {
    this.embedCalls++;

    // Simulate size-cap rejection the same way llama-server does.
    // Must throw LlmEndpointError so `isInputTooLargeError` recognises it.
    const offending = inputs.find((t) => t.length > this.capChars);
    if (offending) {
      throw new LlmEndpointError(
        `input (${offending.length} tokens) is too large to process. ` +
          `increase the physical batch size (current batch size: ${this.capChars})`,
        500,
      );
    }

    return inputs.map((t, i) => fakeEmbedVector(t, i));
  }

  async isReachable(): Promise<boolean> {
    return true;
  }

  reachabilityError(): string | null {
    return null;
  }

  async listModels(): Promise<string[]> {
    return ['fake-embed-model'];
  }
}
