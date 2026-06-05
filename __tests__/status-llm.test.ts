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
