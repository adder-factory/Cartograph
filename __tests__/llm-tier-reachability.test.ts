import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmClient } from '../src/llm/client.js';
import { OpenAiSdkChatBackend } from '../src/llm/openai-sdk-chat-client.js';

/**
 * Tier-independent reachability (issue #26): a summarize run must not
 * abort because an unrelated `askLlm` backend is down, and vice-versa.
 *
 * The per-backend HTTP probe is mocked to be reachable iff the tier's
 * configured model name ends with `:up`, so each assertion isolates
 * exactly which tier `isReachable` / `isAskReachable` consult.
 */
describe('LlmClient tier-independent reachability (issue #26)', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockReachabilityByModel(): void {
    vi.spyOn(OpenAiSdkChatBackend.prototype, 'isReachable').mockImplementation(async function (this: {
      cfg: { model: string };
    }) {
      return this.cfg.model.endsWith(':up');
    });
  }

  it('isReachable() consults only summarizeLlm — ignores a down askLlm', async () => {
    mockReachabilityByModel();
    const client = new LlmClient({
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://s', model: 'sum:up' },
      askLlm: { provider: 'openai-compat', endpoint: 'http://a', model: 'ask:down' },
    });
    expect(await client.isReachable()).toBe(true);
    expect(await client.isAskReachable()).toBe(false);
  });

  it('isAskReachable() consults only askLlm — ignores a down summarizeLlm', async () => {
    mockReachabilityByModel();
    const client = new LlmClient({
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://s', model: 'sum:down' },
      askLlm: { provider: 'openai-compat', endpoint: 'http://a', model: 'ask:up' },
    });
    expect(await client.isAskReachable()).toBe(true);
    expect(await client.isReachable()).toBe(false);
  });

  it('isAskReachable() falls back to summarizeLlm when askLlm is unset', async () => {
    mockReachabilityByModel();
    const client = new LlmClient({
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://s', model: 'sum:up' },
    });
    expect(await client.isAskReachable()).toBe(true);
  });
});
