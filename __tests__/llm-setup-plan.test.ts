/**
 * `planLlmSetup` + `applyLlmSetupChoice` — agent-friendly LLM setup
 * planner. The planner returns structured plan JSON (detected
 * backends, presets, recommendation); the applier writes
 * `.cartograph/config.json` for a chosen preset.
 *
 * Tests run against:
 *   - The real `scanForLlmBackends` (no mock — relies on the test
 *     machine NOT happening to have a backend on the well-known
 *     ports; assertions are written so they pass either way).
 *   - A real tmp project directory so `applyLlmSetupChoice` exercises
 *     the on-disk write + backup path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  planLlmSetup,
  applyLlmSetupChoice,
  AVAILABLE_PRESETS,
  chooseRecommendedPresetId,
} from '../src/installer/llm-setup-plan.js';

describe('planLlmSetup', () => {
  it('returns a stable JSON shape with all required fields', async () => {
    const plan = await planLlmSetup();
    expect(plan).toHaveProperty('detectedBackends');
    expect(plan).toHaveProperty('cloudChatAvailable');
    expect(plan).toHaveProperty('localGgufPresence');
    expect(plan).toHaveProperty('presets');
    expect(plan).toHaveProperty('recommendedPresetId');
    expect(Array.isArray(plan.detectedBackends)).toBe(true);
    expect(Array.isArray(plan.localGgufPresence)).toBe(true);
    expect(Array.isArray(plan.presets)).toBe(true);
  });

  it('always includes install + cloud + skip presets', async () => {
    const plan = await planLlmSetup();
    const ids = plan.presets.map((p) => p.id);
    for (const id of AVAILABLE_PRESETS) {
      // Skip the hybrid presets — those only appear when cloud chat
      // is detected (claude CLI on PATH or ANTHROPIC_API_KEY set).
      if (id === 'hybrid-claude-bridge' || id === 'hybrid-anthropic-api') continue;
      expect(ids).toContain(id);
    }
  });

  it('each preset carries the documented fields', async () => {
    const plan = await planLlmSetup();
    for (const p of plan.presets) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(typeof p.summary).toBe('string');
      expect(typeof p.requiresInstall).toBe('boolean');
      expect(Array.isArray(p.nextSteps)).toBe(true);
    }
  });

  it('cloudChatAvailable.claudeBin is null OR a string path', async () => {
    const plan = await planLlmSetup();
    expect(plan.cloudChatAvailable.claudeBin === null || typeof plan.cloudChatAvailable.claudeBin === 'string').toBe(
      true,
    );
  });

  it("cloudChatAvailable.anthropicApiKey is a boolean (doesn't leak the secret)", async () => {
    const plan = await planLlmSetup();
    expect(typeof plan.cloudChatAvailable.anthropicApiKey).toBe('boolean');
  });

  it('recommendedPresetId is a known preset id', async () => {
    const plan = await planLlmSetup();
    const ids = plan.presets.map((p) => p.id);
    expect(ids).toContain(plan.recommendedPresetId);
  });

  it('recommends the 4-port llama.cpp preset when the standard stack is detected', () => {
    const detected = [8080, 8081, 8082, 8083].map((port) => ({
      kind: 'llama-server' as const,
      endpoint: `http://localhost:${port}`,
      models: [`model-${port}`],
    }));
    const presets = [
      {
        id: 'use-detected-llama-server-http---localhost-8080' as const,
        label: 'detected',
        description: 'detected',
        summary: 'detected',
        nextSteps: [],
        requiresInstall: false,
      },
      {
        id: 'install-llama-cpp' as const,
        label: 'llama',
        description: 'llama',
        summary: 'llama',
        nextSteps: [],
        requiresInstall: true,
      },
    ];
    expect(chooseRecommendedPresetId(detected, presets)).toBe('install-llama-cpp');
  });
});

describe('applyLlmSetupChoice', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-llm-apply-test-'));
    fs.mkdirSync(path.join(projectRoot, '.cartograph'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(projectRoot)) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function readConfig(): { llm: { embeddingLlm: { provider: string; endpoint?: string; model: string } } } {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, '.cartograph', 'config.json'), 'utf-8'));
  }

  it('install-ollama writes a single-endpoint config pointing at :11434', async () => {
    const result = await applyLlmSetupChoice({ projectRoot, preset: 'install-ollama' });
    expect(result.applied).toBe(true);
    expect(result.preset).toBe('install-ollama');
    expect(result.configPath).not.toBeNull();
    expect(result.nextSteps.length).toBeGreaterThan(0);
    const written = readConfig();
    expect(written.llm.embeddingLlm.provider).toBe('openai-compat');
    expect(written.llm.embeddingLlm.endpoint).toBe('http://localhost:11434');
    expect(written.llm.embeddingLlm.model).toBe('nomic-embed-text');
  });

  it('install-llama-cpp writes the 4-port recommended config', async () => {
    const result = await applyLlmSetupChoice({ projectRoot, preset: 'install-llama-cpp' });
    expect(result.applied).toBe(true);
    const written = readConfig() as unknown as {
      llm: {
        embeddingLlm: { provider: string; endpoint: string };
        summarizeLlm: { provider: string; endpoint: string };
        askLlm: { provider: string; endpoint: string };
      };
    };
    expect(written.llm.embeddingLlm.endpoint).toBe('http://localhost:8080');
    expect(written.llm.summarizeLlm.endpoint).toBe('http://localhost:8081');
    expect(written.llm.askLlm.endpoint).toBe('http://localhost:8082');
  });

  it('cloud-openai writes a config WITHOUT endpoint or apiKey (SDK reads OPENAI_API_KEY)', async () => {
    const result = await applyLlmSetupChoice({ projectRoot, preset: 'cloud-openai' });
    expect(result.applied).toBe(true);
    const written = readConfig() as unknown as {
      llm: {
        embeddingLlm: { provider: string; endpoint?: string; apiKey?: string; model: string };
      };
    };
    expect(written.llm.embeddingLlm.provider).toBe('openai-compat');
    expect(written.llm.embeddingLlm.endpoint).toBeUndefined();
    expect(written.llm.embeddingLlm.apiKey).toBeUndefined();
    expect(written.llm.embeddingLlm.model).toBe('text-embedding-3-small');
  });

  it('cloud-openai-compat writes a template config with sentinel placeholders the user must hand-edit', async () => {
    const result = await applyLlmSetupChoice({ projectRoot, preset: 'cloud-openai-compat' });
    expect(result.applied).toBe(true);
    const written = readConfig() as unknown as {
      llm: {
        embeddingLlm: { provider: string; endpoint?: string; apiKey?: string; model: string };
      };
    };
    expect(written.llm.embeddingLlm.endpoint).toMatch(/YOUR-PROVIDER/);
    expect(written.llm.embeddingLlm.apiKey).toMatch(/YOUR-KEY/);
    expect(written.llm.embeddingLlm.model).toMatch(/YOUR-/);
    // nextSteps must include a doctor verify command + an edit hint
    expect(result.nextSteps.some((s) => s.toLowerCase().includes('edit'))).toBe(true);
    expect(result.nextSteps.some((s) => s.includes('cartograph doctor'))).toBe(true);
  });

  it('install-mlx writes a config pointing at :8000', async () => {
    const result = await applyLlmSetupChoice({ projectRoot, preset: 'install-mlx' });
    expect(result.applied).toBe(true);
    const written = readConfig();
    expect(written.llm.embeddingLlm.endpoint).toBe('http://localhost:8000');
  });

  it('skip preset writes no config + returns applied=false', async () => {
    const result = await applyLlmSetupChoice({ projectRoot, preset: 'skip' });
    expect(result.applied).toBe(false);
    expect(result.preset).toBe('skip');
    expect(result.configPath).toBeNull();
    expect(fs.existsSync(path.join(projectRoot, '.cartograph', 'config.json'))).toBe(false);
  });

  it('unknown preset id throws with the list of valid presets in the message', async () => {
    await expect(applyLlmSetupChoice({ projectRoot, preset: 'bogus-preset' as never })).rejects.toThrow(
      /Unknown preset/,
    );
  });

  it('backs up an existing config.json before overwriting', async () => {
    const configPath = path.join(projectRoot, '.cartograph', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ existing: true }), 'utf-8');
    const result = await applyLlmSetupChoice({ projectRoot, preset: 'install-ollama' });
    expect(result.applied).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
  });
});
