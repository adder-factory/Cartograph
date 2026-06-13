/**
 * Tests for the optional `classifyLlm` tier — a separate (typically
 * smaller/faster) chat backend used only for role classification, so the
 * classify phase can run on a cheaper model than summarization.
 *
 * Coverage focus:
 *   - resolution: `resolveLlmProviders` populates `classifyLlm` (and the
 *     shared `resolveSplitChatTier` dispatch / trace) for each provider shape.
 *   - routing: `LlmClient.chat({ useClassifyModel: true })` routes to the
 *     `classifyLlm` backend when configured, and falls back to the
 *     summarize backend when it is not (backward-compatible).
 *
 * The resolver is a pure function (no network), so resolution cases need
 * no fixtures. The routing case points the classify backend at an
 * unreachable endpoint and asserts the call is *attempted* (rejects),
 * which exercises the lazy backend getter + the routing branch without a
 * live server.
 */

import { describe, it, expect } from 'vitest';
import { resolveLlmProviders } from '../src/llm/provider.js';
import { LlmClient, normalizeEndpointConfig, type ChatMessage } from '../src/llm/client.js';
import type { CartographConfig } from '../src/types.js';

function baseConfig(llm: NonNullable<CartographConfig['llm']>): CartographConfig {
  return {
    version: 1,
    rootDir: '/tmp/x',
    include: [],
    exclude: [],
    languages: [],
    frameworks: [],
    maxFileSize: 0,
    extractDocstrings: false,
    trackCallSites: false,
    llm,
  } as CartographConfig;
}

const SUMMARIZE = { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: '/fake/chat.gguf' } as const;

describe('classifyLlm resolution', () => {
  it('resolves an openai-compat classifyLlm into its own tier with a classifyLlm= trace', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        enabled: true,
        summarizeLlm: SUMMARIZE,
        classifyLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8084', model: '/fake/tiny.gguf' },
      }),
    );
    expect(r?.classifyLlm?.provider).toBe('openai-compat');
    expect(r?.classifyLlm?.model).toBe('/fake/tiny.gguf');
    expect((r?.classifyLlm as { endpoint?: string }).endpoint).toBe('http://localhost:8084');
    // Distinct from the summarize tier, and labelled in the resolution trace.
    expect(r?.summarizeLlm?.model).toBe('/fake/chat.gguf');
    expect(r?.resolutionTrace).toContain('classifyLlm=');
  });

  it('leaves classifyLlm null when unset (classification falls back to summarizeLlm)', async () => {
    const r = await resolveLlmProviders(baseConfig({ enabled: true, summarizeLlm: SUMMARIZE }));
    expect(r?.summarizeLlm?.model).toBe('/fake/chat.gguf');
    expect(r?.classifyLlm ?? null).toBeNull();
  });

  it('resolves a claude-bridge classifyLlm when the binary is found', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        enabled: true,
        summarizeLlm: SUMMARIZE,
        // `/usr/bin/env` always exists, so the bridge resolves without a real claude CLI.
        classifyLlm: { provider: 'claude-bridge', model: 'claude-haiku-4-5', claudeBin: '/usr/bin/env' },
      }),
    );
    expect(r?.classifyLlm?.provider).toBe('claude-bridge');
    expect(r?.classifyLlm?.model).toBe('claude-haiku-4-5');
  });

  it('drops an unsupported classifyLlm provider to null (rest of config still resolves)', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        enabled: true,
        summarizeLlm: SUMMARIZE,
        // Intentionally invalid provider to hit the unsupported-provider default branch.
        classifyLlm: { provider: 'bogus-provider', model: 'x' } as unknown as NonNullable<
          CartographConfig['llm']
        >['classifyLlm'],
      }),
    );
    expect(r?.summarizeLlm?.model).toBe('/fake/chat.gguf');
    expect(r?.classifyLlm ?? null).toBeNull();
  });
});

describe('classifyLlm normalization + routing', () => {
  it('normalizeEndpointConfig carries classifyLlm through', () => {
    const norm = normalizeEndpointConfig({
      summarizeLlm: SUMMARIZE,
      classifyLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8084', model: '/fake/tiny.gguf' },
    });
    expect(norm.classifyLlm?.model).toBe('/fake/tiny.gguf');
    expect(norm.askLlm).toBeNull();
  });

  const MSG: ChatMessage[] = [{ role: 'user', content: 'classify this' }];

  it('chat({ useClassifyModel: true }) routes to the classifyLlm backend (attempts the call)', async () => {
    const client = new LlmClient({
      summarizeLlm: SUMMARIZE,
      // Unreachable on purpose — the call should be *attempted* against this
      // backend, which exercises the lazy getter + the classify routing branch.
      classifyLlm: {
        provider: 'openai-compat',
        endpoint: 'http://127.0.0.1:9',
        model: '/fake/tiny.gguf',
        timeoutMs: 500,
      },
    });
    await expect(client.chat(MSG, { useClassifyModel: true })).rejects.toThrow();
  }, 20_000);

  it('chat({ useClassifyModel: true }) falls back to summarizeLlm when classifyLlm is unset', async () => {
    const client = new LlmClient({
      // No classifyLlm — the classify flag must fall through to this backend.
      summarizeLlm: {
        provider: 'openai-compat',
        endpoint: 'http://127.0.0.1:9',
        model: '/fake/chat.gguf',
        timeoutMs: 500,
      },
    });
    await expect(client.chat(MSG, { useClassifyModel: true })).rejects.toThrow();
  }, 20_000);
});
