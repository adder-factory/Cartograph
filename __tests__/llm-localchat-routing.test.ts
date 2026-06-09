import { describe, it, expect } from 'vitest';
import { LlmClient } from '../src/llm/client.js';

/**
 * `localLlm` routing — the optional config slot routes
 * `cartograph_ask({mode: 'local_chat'})` calls to a separate backend so users can
 * keep a larger model for bulk prose while the main backend runs a
 * small code-tuned model for summary passes.
 *
 * When `localLlm` is unset, calls fall through to the summarizeLlm
 * backend (single-provider behaviour). When set, `hasLocalLlmOverride()`
 * returns true so the MCP tool can surface the routing.
 *
 * Uses openai-compat provider with fake HTTP endpoints — these are
 * config-shape tests (no actual inference). The routing is verified
 * via the `hasLocalLlmOverride()` accessor and by inspecting the
 * constructed config state without making any real backend calls.
 */
describe('localLlm routing — config shape', () => {
  it('hasLocalLlmOverride() is true when localLlm is configured', () => {
    const client = new LlmClient({
      summarizeLlm: {
        provider: 'openai-compat',
        endpoint: 'http://localhost:8081',
        model: 'qwen2.5-coder-3b',
      },
      localLlm: {
        provider: 'openai-compat',
        endpoint: 'http://localhost:8082',
        model: 'qwen2.5-coder-7b',
      },
    });

    expect(client.hasLocalLlmOverride()).toBe(true);
  });

  it('hasLocalLlmOverride() is false when localLlm is unset', () => {
    const client = new LlmClient({
      summarizeLlm: {
        provider: 'openai-compat',
        endpoint: 'http://localhost:8081',
        model: 'qwen2.5-coder-3b',
      },
      // No localLlm.
    });

    expect(client.hasLocalLlmOverride()).toBe(false);
  });

  it('hasLocalLlmOverride() is false when only summarizeLlm is set', () => {
    const client = new LlmClient({
      summarizeLlm: {
        provider: 'claude-bridge',
        model: 'claude-haiku-4-5',
        claudeBin: '/usr/bin/env',
      },
    });

    expect(client.hasLocalLlmOverride()).toBe(false);
  });

  it('hasLocalLlmOverride() is true with claude-bridge localLlm override', () => {
    const client = new LlmClient({
      summarizeLlm: {
        provider: 'openai-compat',
        endpoint: 'http://localhost:8081',
        model: 'qwen2.5-coder-3b',
      },
      askLlm: {
        provider: 'claude-bridge',
        model: 'claude-sonnet-4-6',
        claudeBin: '/usr/bin/env',
      },
      localLlm: {
        provider: 'claude-bridge',
        model: 'claude-haiku-4-5',
        claudeBin: '/usr/bin/env',
      },
    });

    expect(client.hasLocalLlmOverride()).toBe(true);
  });

  it('listModels() always returns [] on the LlmClient surface', async () => {
    const client = new LlmClient({
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: 'm' },
    });
    expect(await client.listModels()).toEqual([]);
  });
});
