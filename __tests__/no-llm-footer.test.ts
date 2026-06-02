/**
 * F#29 — `buildNoLlmFooter` is the index-result footer the agent reads
 * after `cartograph_admin({action: 'index'})` on a project whose
 * `config.llm` has no `summarizeLlm`. The old behaviour was a bare
 * "No LLM configured" message; the new behaviour is to port-scan for
 * OpenAI-compat backends and, when at least one is running, list it
 * so the user sees what's already on standard ports without a
 * separate `llm-plan` round-trip.
 */
import { describe, expect, it } from 'vitest';
import { buildNoLlmFooter } from '../src/mcp/tools/admin.js';

describe('buildNoLlmFooter — F#29', () => {
  it('falls back to the bare message when the scan returns no backends', async () => {
    const text = await buildNoLlmFooter(async () => []);
    expect(text).toMatch(/No LLM configured/);
    expect(text).toMatch(/cartograph llm setup/);
    expect(text).toMatch(/llm-plan/);
  });

  it('lists a single detected backend with its endpoint and points at llm-plan', async () => {
    const text = await buildNoLlmFooter(async () => [{ kind: 'llama-server', endpoint: 'http://localhost:8080' }]);
    expect(text).toMatch(/1 OpenAI-compat backend detected/);
    expect(text).toMatch(/llama-server http:\/\/localhost:8080/);
    expect(text).toMatch(/llm-plan/);
    expect(text).not.toMatch(/No LLM configured/);
  });

  it('lists multiple detected backends with the plural noun', async () => {
    const text = await buildNoLlmFooter(async () => [
      { kind: 'llama-server', endpoint: 'http://localhost:8080' },
      { kind: 'llama-server', endpoint: 'http://localhost:8081' },
      { kind: 'ollama', endpoint: 'http://localhost:11434' },
    ]);
    expect(text).toMatch(/3 OpenAI-compat backends detected/);
    expect(text).toMatch(/llama-server http:\/\/localhost:8080/);
    expect(text).toMatch(/llama-server http:\/\/localhost:8081/);
    expect(text).toMatch(/ollama http:\/\/localhost:11434/);
  });

  it('falls back to the bare message when the scanner throws', async () => {
    const text = await buildNoLlmFooter(async () => {
      throw new Error('network down');
    });
    expect(text).toMatch(/No LLM configured/);
  });
});
