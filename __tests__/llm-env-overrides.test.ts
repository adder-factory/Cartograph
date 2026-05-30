/**
 * Env-var fallbacks for LLM config — the CARTOGRAPH_LLM_ENDPOINT /
 * CARTOGRAPH_LLM_CHAT_MODEL env-var mechanism was removed 2026-05-15
 * (the openai-compat provider was reinstated 2026-05-24c via the
 * `openai` npm SDK). The remaining tests cover the residual
 * behaviour:
 *   - null config → null result (unchanged).
 *   - ANTHROPIC_API_KEY env var is still used by the anthropic-api provider.
 *   - Per-project openai-compat config is used as-is (no env override needed).
 */
import { describe, it, expect } from 'vitest';
import { resolveLlmProviders } from '../src/llm/provider.js';
import type { CartographConfig } from '../src/types.js';

describe('LLM provider resolution — no env-var synthesis', () => {
  it('returns null when neither config nor env supply LLM settings', async () => {
    const cfg: CartographConfig = { include: [], exclude: [] };
    expect(await resolveLlmProviders(cfg)).toBeNull();
  });

  it('anthropic-api picks up ANTHROPIC_API_KEY from env', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-env';
    try {
      const cfg: CartographConfig = {
        include: [],
        exclude: [],
        llm: {
          summarizeLlm: { provider: 'anthropic-api', model: 'claude-haiku-4-5' },
        },
      };
      const resolved = await resolveLlmProviders(cfg);
      expect(resolved?.summarizeLlm?.provider).toBe('anthropic-api');
      expect((resolved?.summarizeLlm as { apiKey?: string })?.apiKey).toBe('sk-test-env');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('per-project openai-compat config resolves without any env vars', async () => {
    const cfg: CartographConfig = {
      include: [],
      exclude: [],
      llm: {
        summarizeLlm: {
          provider: 'openai-compat',
          endpoint: 'http://localhost:8081',
          model: '/fake/models/qwen2.5-coder-3b.gguf',
        },
        embeddingLlm: {
          provider: 'openai-compat',
          endpoint: 'http://localhost:8080',
          model: '/fake/models/embed.gguf',
        },
      },
    };
    const resolved = await resolveLlmProviders(cfg);
    expect(resolved?.summarizeLlm?.provider).toBe('openai-compat');
    expect(resolved?.embeddingLlm?.provider).toBe('openai-compat');
  });

  it('openai-compat summarizeLlm without endpoint OR apiKey returns null with warning', async () => {
    // Symmetric with the embedding side: model alone isn't enough,
    // need either endpoint (local backend URL) or apiKey (cloud).
    const cfg: CartographConfig = {
      include: [],
      exclude: [],
      llm: {
        summarizeLlm: { provider: 'openai-compat', model: 'qwen2.5:7b' },
      },
    };
    const resolved = await resolveLlmProviders(cfg);
    expect(resolved).toBeNull();
  });

  it('openai-compat summarizeLlm with endpoint+model resolves successfully (parity with embedding side)', async () => {
    const cfg: CartographConfig = {
      include: [],
      exclude: [],
      llm: {
        summarizeLlm: { provider: 'openai-compat', model: 'qwen2.5:7b', endpoint: 'http://localhost:11434' },
      },
    };
    const resolved = await resolveLlmProviders(cfg);
    expect(resolved).not.toBeNull();
    expect(resolved?.summarizeLlm?.provider).toBe('openai-compat');
  });

  it('openai-compat embeddingLlm config resolves to HTTP backend (was rejected pre-2026-05-24c)', async () => {
    // The HTTP `openai-compat` embedding path was REMOVED 2026-05-15,
    // then REINSTATED 2026-05-24c via the official `openai` npm SDK
    // (see `project_llm_pivot_to_llama_server` in auto-memory). This
    // test pins the new accept-and-resolve behaviour.
    const cfg: CartographConfig = {
      include: [],
      exclude: [],
      llm: {
        summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: '/fake/chat.gguf' },
        embeddingLlm: {
          provider: 'openai-compat',
          model: 'nomic-embed-text',
          endpoint: 'http://localhost:11434',
        },
      },
    };
    const resolved = await resolveLlmProviders(cfg);
    expect(resolved?.summarizeLlm?.provider).toBe('openai-compat');
    expect(resolved?.embeddingLlm?.provider).toBe('openai-compat');
    expect(resolved?.embeddingLlm?.model).toBe('nomic-embed-text');
  });
});
