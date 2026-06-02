import { describe, expect, it, mock } from 'bun:test';
import type { LlmEnvironment } from '../src/installer/llm-setup.js';
import type { DetectedBackend } from '../src/installer/scan-backends.js';

mock.module('../src/installer/install-models.js', () => ({
  installRecommendedModels: async ({ models }: { models: unknown[] }) => ({
    downloaded: models,
    skipped: [],
    failed: [],
  }),
}));

const { runLlmSetup } = await import('../src/installer/llm-setup.js');

function baseEnv(overrides: Partial<LlmEnvironment> = {}): LlmEnvironment {
  return {
    detectedBackends: [],
    claudeBin: null,
    anthropicApiKey: null,
    presentModels: new Map(),
    ...overrides,
  };
}

function makeBackend(kind: DetectedBackend['kind'], endpoint: string, models: string[] = []): DetectedBackend {
  return { kind, endpoint, models };
}

function makeClack(selectChoice: unknown, confirmChoice: unknown = false) {
  const notes: Array<{ message: string; title?: string }> = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const spinnerEvents: string[] = [];
  const selectCalls: unknown[] = [];
  const confirmCalls: unknown[] = [];

  return {
    notes,
    infos,
    errors,
    spinnerEvents,
    selectCalls,
    confirmCalls,
    clack: {
      note(message: string, title?: string) {
        notes.push({ message, title });
      },
      log: {
        info(message: string) {
          infos.push(message);
        },
        error(message: string) {
          errors.push(message);
        },
      },
      spinner() {
        return {
          start(message: string) {
            spinnerEvents.push(`start:${message}`);
          },
          message(message: string) {
            spinnerEvents.push(`message:${message}`);
          },
          stop(message: string) {
            spinnerEvents.push(`stop:${message}`);
          },
        };
      },
      select(args: unknown) {
        selectCalls.push(args);
        return selectChoice;
      },
      confirm(args: unknown) {
        confirmCalls.push(args);
        return confirmChoice;
      },
      isCancel(value: unknown) {
        return value === Symbol.for('cancel');
      },
    },
  };
}

describe('runLlmSetup', () => {
  it('returns null and leaves config untouched when the user skips', async () => {
    const choice = { kind: 'skip' };
    const fake = makeClack(choice);

    const cfg = await runLlmSetup(fake.clack as never, baseEnv());

    expect(cfg).toBeNull();
    expect(fake.infos[0]).toContain('Skipping LLM setup');
    expect(fake.notes.some((n) => n.title === 'Detected backends')).toBe(true);
    expect(fake.selectCalls).toHaveLength(1);
  });

  it('wires a detected non-Ollama backend to every tier with the loaded model', async () => {
    const backend = makeBackend('lm-studio', 'http://localhost:1234', ['qwen-local']);
    const fake = makeClack({ kind: 'detected', backend });

    const cfg = await runLlmSetup(fake.clack as never, baseEnv({ detectedBackends: [backend] }));

    expect(cfg?.summarizeLlm?.provider).toBe('openai-compat');
    expect(cfg?.summarizeLlm?.model).toBe('qwen-local');
    expect(cfg?.embeddingLlm?.model).toBe('qwen-local');
    expect(fake.infos[0]).toContain('Wiring every tier');
  });

  it('detected Ollama path offers missing pulls and writes the canonical Ollama model ids', async () => {
    const backend = makeBackend('ollama', 'http://localhost:11434', []);
    const fake = makeClack({ kind: 'detected', backend }, false);

    const cfg = await runLlmSetup(fake.clack as never, baseEnv({ detectedBackends: [backend] }));

    expect(fake.confirmCalls).toHaveLength(1);
    expect(cfg?.embeddingLlm?.model).toBe('nomic-embed-text');
    expect(cfg?.summarizeLlm?.model).toBe('qwen2.5-coder:3b');
    expect(cfg?.askLlm?.model).toBe('qwen2.5-coder:7b');
    expect(cfg?.rerankerLlm).toBeFalsy();
  });

  it('install Ollama path prints next steps and targets the default endpoint', async () => {
    const fake = makeClack({ kind: 'install-ollama' });

    const cfg = await runLlmSetup(fake.clack as never, baseEnv());

    expect(cfg?.embeddingLlm?.endpoint).toBe('http://localhost:11434');
    expect(fake.notes.some((n) => n.title === 'Install Ollama')).toBe(true);
    expect(fake.notes.some((n) => n.title === 'Next steps' && n.message.includes('ollama pull'))).toBe(true);
  });

  it('install MLX path prints guidance and targets the MLX endpoint', async () => {
    const fake = makeClack({ kind: 'install-mlx' });

    const cfg = await runLlmSetup(fake.clack as never, baseEnv());

    expect(cfg?.embeddingLlm?.endpoint).toBe('http://localhost:8000');
    expect(fake.notes.some((n) => n.title?.includes('MLX'))).toBe(true);
  });

  it('hybrid path overlays Claude ask provider on the recommended local config', async () => {
    const fake = makeClack({ kind: 'hybrid' });

    const cfg = await runLlmSetup(fake.clack as never, baseEnv({ claudeBin: '/usr/bin/claude' }));

    expect(cfg?.summarizeLlm?.provider).toBe('openai-compat');
    expect(cfg?.askLlm?.provider).toBe('claude-bridge');
    expect(fake.spinnerEvents.some((e) => e.startsWith('start:Downloading recommended GGUFs'))).toBe(true);
  });
});
