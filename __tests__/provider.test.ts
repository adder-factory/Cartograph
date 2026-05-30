/**
 * Tests for the provider resolution layer.
 *
 * Coverage focus: the fallback chain in `resolveLlmProviders`.
 * These are pure functions (besides the optional `findOnPath` for
 * claude-bridge), so most cases need no fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveLlmProviders } from '../src/llm/provider.js';
import { normalizeEndpointConfig } from '../src/llm/client.js';
import type { CartographConfig } from '../src/types.js';

function baseConfig(llm: NonNullable<CartographConfig['llm']> | undefined): CartographConfig {
  // Just enough fields for `resolveLlmProviders` — it only reads `llm`.
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

describe('resolveLlmProviders', () => {
  it('returns null when llm is unset', async () => {
    expect(await resolveLlmProviders(baseConfig(undefined))).toBeNull();
  });

  it('returns null when explicitly disabled', async () => {
    expect(
      await resolveLlmProviders(
        baseConfig({ enabled: false, summarizeLlm: { provider: 'anthropic-api', model: 'x' } }),
      ),
    ).toBeNull();
  });

  it('split shape resolves chat + embeddings independently (one openai-compat backend per tier)', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        enabled: true,
        summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: '/fake/chat.gguf' },
        embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8080', model: '/fake/embed.gguf' },
      }),
    );
    expect(r?.summarizeLlm?.provider).toBe('openai-compat');
    expect(r?.summarizeLlm?.model).toBe('/fake/chat.gguf');
    expect(r?.embeddingLlm?.provider).toBe('openai-compat');
    expect(r?.embeddingLlm?.model).toBe('/fake/embed.gguf');
  });

  it('anthropic-api without api key returns null chat (no env, no config)', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await resolveLlmProviders(
        baseConfig({
          summarizeLlm: { provider: 'anthropic-api', model: 'claude-haiku-4-5' },
        }),
      );
      expect(r).toBeNull();
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('anthropic-api picks up ANTHROPIC_API_KEY from env', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';
    try {
      const r = await resolveLlmProviders(
        baseConfig({
          summarizeLlm: { provider: 'anthropic-api', model: 'claude-haiku-4-5' },
        }),
      );
      expect(r?.summarizeLlm?.provider).toBe('anthropic-api');
      expect(r?.summarizeLlm?.apiKey).toBe('sk-from-env');
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('embeddings-only config still resolves (chat null, embeddings populated)', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8080', model: '/fake/embed.gguf' },
      }),
    );
    expect(r?.summarizeLlm).toBeFalsy();
    expect(r?.embeddingLlm?.model).toBe('/fake/embed.gguf');
  });

  it('openai-compat embedding config resolves to the openai-compat provider', async () => {
    // Step 2 of the LLM HTTP migration (2026-05-24c): the new default
    // `admin install-models --write-config` writes this shape.
    // Without the corresponding branch in `resolveEmbeddings`, the
    // config would silently produce null and the embed pipeline would
    // skip every node. This test pins the resolver routing.
    const r = await resolveLlmProviders(
      baseConfig({
        embeddingLlm: {
          provider: 'openai-compat',
          endpoint: 'http://localhost:11434',
          model: 'nomic-embed-text',
        },
      }),
    );
    expect(r?.embeddingLlm?.provider).toBe('openai-compat');
    expect(r?.embeddingLlm?.model).toBe('nomic-embed-text');
    expect((r?.embeddingLlm as { endpoint?: string }).endpoint).toBe('http://localhost:11434');
  });

  it('openai-compat embedding with apiKey only (cloud OpenAI) resolves without endpoint', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        embeddingLlm: {
          provider: 'openai-compat',
          apiKey: 'sk-cloud-secret',
          model: 'text-embedding-3-small',
        },
      }),
    );
    expect(r?.embeddingLlm?.provider).toBe('openai-compat');
    expect((r?.embeddingLlm as { apiKey?: string }).apiKey).toBe('sk-cloud-secret');
    expect((r?.embeddingLlm as { endpoint?: string }).endpoint).toBeUndefined();
  });

  it('openai-compat embedding without endpoint AND apiKey returns null with a clear warning', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        embeddingLlm: {
          provider: 'openai-compat',
          model: 'nomic-embed-text',
          // No endpoint, no apiKey — can't reach any backend.
        },
      }),
    );
    expect(r?.embeddingLlm).toBeFalsy();
  });

  it('unknown embedding provider returns null (not silently coerced)', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        embeddingLlm: { provider: 'bogus' as never, model: 'm' } as never,
      }),
    );
    expect(r?.embeddingLlm).toBeFalsy();
  });

  it('claude-bridge with explicit claudeBin path uses it', async () => {
    // Use a real existing binary so claudeBin doesn't get filtered.
    const r = await resolveLlmProviders(
      baseConfig({
        summarizeLlm: { provider: 'claude-bridge', model: 'claude-haiku-4-5', claudeBin: '/usr/bin/env' },
      }),
    );
    expect(r?.summarizeLlm?.provider).toBe('claude-bridge');
    expect(r?.summarizeLlm?.claudeBin).toBe('/usr/bin/env');
  });

  it('claude-bridge with missing claudeBin returns null', async () => {
    // Save and overwrite PATH so findOnPath finds nothing.
    const saved = process.env.PATH;
    process.env.PATH = '/var/empty';
    try {
      const r = await resolveLlmProviders(
        baseConfig({
          summarizeLlm: { provider: 'claude-bridge', model: 'claude-haiku-4-5' },
        }),
      );
      expect(r).toBeNull();
    } finally {
      process.env.PATH = saved;
    }
  });

  it('openai-compat trace includes endpoint + model', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        summarizeLlm: {
          provider: 'openai-compat',
          endpoint: 'http://localhost:8081',
          model: '/home/user/.cartograph/models/qwen2.5-coder-3b.gguf',
        },
      }),
    );
    expect(r?.resolutionTrace).toContain('chat=openai-compat');
    expect(r?.resolutionTrace).toContain('qwen2.5-coder-3b.gguf');
  });

  it('openai-compat summarizeLlm with model + endpoint resolves successfully', async () => {
    // Migration arc 2026-05-24c step 4 — openai-compat is now a
    // supported chat provider, parallel to the embedding side. A
    // config with model + endpoint set should resolve to a runtime
    // chat config carrying both.
    const r = await resolveLlmProviders(
      baseConfig({
        summarizeLlm: {
          provider: 'openai-compat',
          model: 'qwen',
          endpoint: 'http://localhost:11434',
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r?.summarizeLlm?.provider).toBe('openai-compat');
    expect((r?.summarizeLlm as { endpoint?: string }).endpoint).toBe('http://localhost:11434');
    expect(r?.summarizeLlm?.model).toBe('qwen');
    expect(r?.resolutionTrace).toContain('chat=openai-compat');
  });

  it('openai-compat summarizeLlm without model OR endpoint+apiKey returns null with warning', async () => {
    const r = await resolveLlmProviders(
      baseConfig({
        // Missing both endpoint and apiKey — resolver should drop.
        summarizeLlm: {
          provider: 'openai-compat',
          model: 'qwen',
        },
      }),
    );
    expect(r).toBeNull();
  });
});

describe('normalizeEndpointConfig', () => {
  it('passes split shape through untouched', () => {
    const norm = normalizeEndpointConfig({
      summarizeLlm: { provider: 'claude-bridge', model: 'm', claudeBin: '/x' },
      embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8080', model: '/fake/embed.gguf' },
    });
    expect(norm.summarizeLlm?.provider).toBe('claude-bridge');
    expect(norm.embeddingLlm?.model).toBe('/fake/embed.gguf');
  });

  it('null input fields produce null outputs', () => {
    const norm = normalizeEndpointConfig({});
    expect(norm.summarizeLlm).toBeNull();
    expect(norm.embeddingLlm).toBeNull();
    expect(norm.askLlm).toBeNull();
    expect(norm.localLlm).toBeNull();
    expect(norm.rerankerLlm).toBeNull();
  });

  it('openai-compat summarizeLlm is passed through', () => {
    const norm = normalizeEndpointConfig({
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: '/path/chat.gguf' },
    });
    expect(norm.summarizeLlm?.provider).toBe('openai-compat');
    expect(norm.summarizeLlm?.model).toBe('/path/chat.gguf');
  });
});

describe('Cartograph integration with new provider shape', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-prov-'));
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('hasLlm returns false when llm is unset', async () => {
    const { default: Cartograph } = await import('../src/index.js');
    const cg = await Cartograph.init(tempDir);
    try {
      expect(cg.llm.hasLlm()).toBe(false);
    } finally {
      cg.close();
    }
  });

  it('hasLlm returns true with anthropic-api split shape', async () => {
    const { default: Cartograph } = await import('../src/index.js');
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          enabled: true,
          summarizeLlm: { provider: 'anthropic-api', model: 'claude-haiku-4-5', apiKey: 'sk-stub' },
        },
      },
    });
    try {
      expect(cg.llm.hasLlm()).toBe(true);
    } finally {
      cg.close();
    }
  });

  it('hasLlm returns false when enabled=false even if chat is set', async () => {
    const { default: Cartograph } = await import('../src/index.js');
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          enabled: false,
          summarizeLlm: { provider: 'anthropic-api', model: 'claude-haiku-4-5' },
        },
      },
    });
    try {
      expect(cg.llm.hasLlm()).toBe(false);
    } finally {
      cg.close();
    }
  });
});
