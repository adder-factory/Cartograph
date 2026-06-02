/**
 * LLM layer tests — openai-compat / claude-bridge / anthropic-api paths.
 *
 * Smoke-level coverage of `getChatModel` / `getAskModel` /
 * `getEmbeddingModel` accessors + the no-LLM Cartograph happy path.
 * In-process backend tests (mini-nllc + libcgshim) were removed
 * 2026-05-24c when the in-process pathway was deleted in step 4c of
 * the migration.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';

// ── getChatModel / getAskModel / getEmbeddingModel — split-shape reads ────────

describe('getChatModel / getAskModel / getEmbeddingModel — split shape', () => {
  it('getChatModel reads new shape', async () => {
    const { getChatModel, getEmbeddingModel } = await import('../src/llm/provider.js');

    expect(getChatModel(null)).toBeUndefined();
    expect(getChatModel(undefined)).toBeUndefined();
    expect(getChatModel({})).toBeUndefined();

    // Split shape — what `resolveLlmProviders` produces.
    expect(
      getChatModel({
        summarizeLlm: { provider: 'claude-bridge', model: 'claude-haiku-4-5' },
      }),
    ).toBe('claude-haiku-4-5');
    expect(
      getEmbeddingModel({
        embeddingLlm: {
          provider: 'openai-compat',
          endpoint: 'http://localhost:8080',
          model: '/path/embed.gguf',
        },
      }),
    ).toBe('/path/embed.gguf');

    // Split shape wins when both happen to be present.
    expect(
      getChatModel({
        summarizeLlm: { provider: 'claude-bridge', model: 'claude-haiku-4-5' },
      }),
    ).toBe('claude-haiku-4-5');
  });
});

// ── Cartograph no-LLM smoke ─────────────────────────────────────────────────────

describe('Cartograph no-LLM smoke', () => {
  let tempDir: string;

  it('hasLlm returns false when no llm configured', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-llm-'));
    fs.writeFileSync(
      path.join(tempDir, 'sample.ts'),
      'export function greet(name: string): string { return `hi ${name}`; }\n',
    );
    const cg = await Cartograph.init(tempDir, { config: {} });
    try {
      expect(cg.llm.config.hasLlm()).toBe(false);
    } finally {
      cg.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ── handleAsk bails with "No LLM available" when nothing is configured ─────────

describe('handleAsk with no LLM configured', () => {
  let tempDir: string;

  it('returns "No LLM available" when nothing is configured', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ask-'));
    fs.writeFileSync(
      path.join(tempDir, 'sample.ts'),
      'export function greet(name: string): string { return `hi ${name}`; }\n',
    );
    const { ToolHandler } = await import('../src/mcp/tools.js');
    const cg = await Cartograph.init(tempDir, { config: {} });
    try {
      await cg.indexAll();
      const handler = new ToolHandler(cg);
      const result = await handler.runHandler('cartograph_ask', { question: 'irrelevant' });
      const text = result.content?.[0]?.text ?? '';
      expect(text).toMatch(/No LLM available/i);
    } finally {
      cg.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
