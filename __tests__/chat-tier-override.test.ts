import { describe, expect, it } from 'vitest';
import { applyChatTierOverride, chatOverrideActive } from '../src/cartograph-llm-service.js';
import { chatOverrideFromOptions } from '../src/features/shared/cli-args.js';
import type { ChatProviderConfig } from '../src/llm/client.js';

/**
 * Per-invocation chat-backend override (issue #26 enhancement) — point a
 * single `summarize` / `ask` call at a different model / endpoint without
 * editing config or restarting the backend.
 */
describe('chatOverrideFromOptions — CLI flags → override', () => {
  it('returns undefined when neither flag is given', () => {
    expect(chatOverrideFromOptions({})).toBeUndefined();
    expect(chatOverrideFromOptions({ model: undefined, endpoint: undefined })).toBeUndefined();
  });

  it('carries only the provided flags', () => {
    expect(chatOverrideFromOptions({ model: '/m/b.gguf' })).toEqual({ model: '/m/b.gguf' });
    expect(chatOverrideFromOptions({ endpoint: 'http://h:9' })).toEqual({ endpoint: 'http://h:9' });
    expect(chatOverrideFromOptions({ model: '/m/b.gguf', endpoint: 'http://h:9' })).toEqual({
      model: '/m/b.gguf',
      endpoint: 'http://h:9',
    });
  });
});

describe('chatOverrideActive', () => {
  it('is false for undefined / empty, true when a field is set', () => {
    expect(chatOverrideActive(undefined)).toBe(false);
    expect(chatOverrideActive({})).toBe(false);
    expect(chatOverrideActive({ model: '/m/b.gguf' })).toBe(true);
    expect(chatOverrideActive({ endpoint: 'http://h:9' })).toBe(true);
  });
});

describe('applyChatTierOverride', () => {
  const base: ChatProviderConfig = {
    provider: 'openai-compat',
    model: '/m/a.gguf',
    endpoint: 'http://localhost:8081',
    apiKey: 'k',
    timeoutMs: 1234,
  };

  it('replaces the model and carries unspecified fields over', () => {
    expect(applyChatTierOverride(base, { model: '/m/b.gguf' })).toEqual({
      provider: 'openai-compat',
      model: '/m/b.gguf',
      endpoint: 'http://localhost:8081',
      apiKey: 'k',
      timeoutMs: 1234,
    });
  });

  it('an endpoint override forces an openai-compat HTTP backend', () => {
    const claude: ChatProviderConfig = { provider: 'claude-bridge', model: 'claude-haiku-4-5' };
    const out = applyChatTierOverride(claude, { endpoint: 'http://localhost:9091' });
    expect(out.provider).toBe('openai-compat');
    expect(out.endpoint).toBe('http://localhost:9091');
    expect(out.model).toBe('claude-haiku-4-5'); // model untouched when not overridden
  });

  it('drops provider-specific auth (claudeBin / apiKey) when flipping a non-HTTP base to openai-compat', () => {
    const claude: ChatProviderConfig = {
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: '/usr/local/bin/claude',
    };
    const out = applyChatTierOverride(claude, { endpoint: 'http://localhost:9091' });
    expect(out.claudeBin).toBeUndefined();

    const anthropic: ChatProviderConfig = { provider: 'anthropic-api', model: 'claude-haiku-4-5', apiKey: 'sk-ant' };
    expect(applyChatTierOverride(anthropic, { endpoint: 'http://localhost:9091' }).apiKey).toBeUndefined();
  });

  it('keeps apiKey when the base is already openai-compat (same auth scheme, new endpoint)', () => {
    const out = applyChatTierOverride(base, { endpoint: 'http://localhost:9091' });
    expect(out.apiKey).toBe('k');
  });

  it('applies both model and endpoint together (the A/B case)', () => {
    const out = applyChatTierOverride(base, { model: '/m/b.gguf', endpoint: 'http://localhost:9091' });
    expect(out.model).toBe('/m/b.gguf');
    expect(out.endpoint).toBe('http://localhost:9091');
    expect(out.apiKey).toBe('k');
  });
});
