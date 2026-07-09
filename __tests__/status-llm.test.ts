import { describe, expect, it } from 'vitest';
import { collectMissingTierWarnings, renderReachabilitySection } from '../src/mcp/tools/status-llm.js';
import type { LlmEndpointConfig } from '../src/llm/client.js';

describe('status LLM rendering', () => {
  it('adds recovery guidance when configured openai-compatible tiers are unreachable', async () => {
    const cfg: LlmEndpointConfig = {
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: 'chat' },
      embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8080', model: 'embed' },
    };
    const fetchImpl = async () => new Response('{}', { status: 503 });

    const text = (await renderReachabilitySection(cfg, fetchImpl as typeof fetch)).join('\n');

    expect(text).toContain('**Backend reachability**');
    expect(text).toContain('✗ **embed**');
    expect(text).toContain('✗ **chat**');
    expect(text).toContain('LLM features are partially offline');
    expect(text).toContain('cartograph_admin({action: "llm-plan"})');
    expect(text).toContain('cartograph_admin({action: "doctor", fix: true})');
  });

  it('omits recovery guidance when every configured endpoint is reachable', async () => {
    const cfg: LlmEndpointConfig = {
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:11434', model: 'qwen' },
      embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:11434', model: 'nomic' },
    };
    const seen: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response('{}', { status: 200 });
    };

    const text = (await renderReachabilitySection(cfg, fetchImpl as typeof fetch)).join('\n');

    expect(seen).toEqual(['http://localhost:11434/v1/models']);
    expect(text).toContain('✓ **embed**');
    expect(text).toContain('✓ **chat**');
    expect(text).not.toContain('partially offline');
  });

  it('passes configured bearer auth when probing a protected endpoint', async () => {
    const cfg: LlmEndpointConfig = {
      summarizeLlm: {
        provider: 'openai-compat',
        endpoint: 'https://private.example.test',
        model: 'qwen',
        apiKey: 'status-token',
      },
      embeddingLlm: {
        provider: 'openai-compat',
        endpoint: 'https://private.example.test',
        model: 'nomic',
        apiKey: 'status-token',
      },
    };
    const seenAuth: string[] = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth.push(headers.get('authorization') ?? '');
      return new Response('{}', { status: 200 });
    };

    const text = (await renderReachabilitySection(cfg, fetchImpl as typeof fetch)).join('\n');

    expect(seenAuth).toEqual(['Bearer status-token']);
    expect(text).toContain('✓ **embed**');
    expect(text).toContain('✓ **chat**');
    expect(text).not.toContain('partially offline');
  });

  it('passes OPENROUTER_API_KEY when probing a configured OpenRouter endpoint', async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'or-status-token';
    try {
      const cfg: LlmEndpointConfig = {
        summarizeLlm: {
          provider: 'openai-compat',
          endpoint: 'https://openrouter.ai/api',
          model: 'google/gemini-2.5-flash-lite',
        },
      };
      const seen: Array<{ url: string; auth: string }> = [];
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization') ?? '',
        });
        return new Response('{}', { status: 200 });
      };

      const text = (await renderReachabilitySection(cfg, fetchImpl as typeof fetch)).join('\n');

      expect(seen).toEqual([{ url: 'https://openrouter.ai/api/v1/models', auth: 'Bearer or-status-token' }]);
      expect(text).toContain('✓ **chat**');
      expect(text).not.toContain('partially offline');
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it('does not mark ask as missing when summarize can satisfy the fallback', () => {
    const text = collectMissingTierWarnings({
      summarizeWired: true,
      askWired: false,
      embeddingWired: true,
      rerankerWired: false,
    }).join('\n');

    expect(text).not.toContain('Ask chat');
    expect(text).toContain('Reranker');
  });
});
