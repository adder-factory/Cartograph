import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResolvedLlm } from '../src/llm/provider.js';

const phaseCalls: string[] = [];
const structuralGates: Array<() => void> = [];
let structuralGateEnabled = false;
let probeResult = true;

vi.mock('../src/llm/client.js', () => ({
  BATCH_PARSE_FAILURE_LOG_CHARS: 120,
  LlmEndpointError: class LlmEndpointError extends Error {
    status?: number;

    constructor(message: string, status?: number) {
      super(message);
      this.name = 'LlmEndpointError';
      this.status = status;
    }
  },
  normalizeEndpointConfig: (config: { endpoint?: string; apiKey?: string; model: string }) => ({
    baseURL: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
  }),
  LlmClient: class {
    isReachable = vi.fn(async () => true);
    chat = vi.fn(async () => ({ text: 'ok', durationMs: 1 }));
  },
}));

vi.mock('../src/llm/embedding-client.js', () => ({
  createEmbeddingClient: vi.fn(() => ({
    isReachable: vi.fn(async () => true),
    reachabilityError: vi.fn(() => null),
    embed: vi.fn(async () => [new Float32Array([1, 0])]),
  })),
}));

vi.mock('../src/cartograph-llm-pass.js', () => ({
  probeChatBackend: vi.fn(async () => probeResult),
  runStructuralPhase: vi.fn(async () => {
    phaseCalls.push('structural');
    if (structuralGateEnabled) {
      await new Promise<void>((resolve) => structuralGates.push(resolve));
    }
  }),
  runEmbedPhase: vi.fn(async () => phaseCalls.push('embed')),
  runNeighborPropagationPhase: vi.fn(async () => phaseCalls.push('neighbor')),
  runSummaryPhase: vi.fn(async (_ctx, concurrency: number) => phaseCalls.push(`summary:${concurrency}`)),
  runFileSummaryPhase: vi.fn(async () => phaseCalls.push('file')),
  runDirectorySummaryPhase: vi.fn(async () => phaseCalls.push('directory')),
  runClassifyPhase: vi.fn(async (_ctx, concurrency: number) => phaseCalls.push(`classify:${concurrency}`)),
  runCommitIntentResiduePhase: vi.fn(async () => phaseCalls.push('commit-intent')),
}));

function resolved(provider: ResolvedLlm['summarizeLlm']['provider'] = 'openai-compat'): ResolvedLlm {
  return {
    summarizeLlm: {
      provider,
      endpoint: 'http://localhost:8081',
      model: 'chat-model',
    },
    embeddingLlm: {
      provider: 'openai-compat',
      endpoint: 'http://localhost:8080',
      model: 'embed-model',
    },
    resolutionTrace: 'test',
  } as ResolvedLlm;
}

async function makeService(config: ResolvedLlm | null) {
  const { CartographLlmService } = await import('../src/cartograph-llm-service.js');
  const svc = new CartographLlmService({
    config: { llm: {} },
    projectRoot: '/tmp/cartograph-llm-service-bg',
    queries: {},
    db: { getDb: () => ({}) },
  } as never);
  vi.spyOn(svc.config, 'resolveLlmConfig').mockResolvedValue(config);
  return svc;
}

async function waitForGate(count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (structuralGates.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(structuralGates.length).toBeGreaterThanOrEqual(count);
}

describe('CartographLlmService background controller', () => {
  beforeEach(() => {
    phaseCalls.length = 0;
    structuralGates.length = 0;
    structuralGateEnabled = false;
    probeResult = true;
    vi.clearAllMocks();
  });

  it('runs the ordered background phases and uses openai-compatible chat concurrency', async () => {
    const svc = await makeService(resolved('openai-compat'));

    await svc.bgCtrl.start();

    expect(phaseCalls).toEqual([
      'structural',
      'embed',
      'neighbor',
      'summary:8',
      'embed',
      'file',
      'directory',
      'classify:8',
      'commit-intent',
    ]);
    expect(svc.bgCtrl.getProgress()).toBeNull();
    expect(svc.bgCtrl.promise).toBeNull();
  });

  it('uses lower chat concurrency for claude-bridge subprocess backends', async () => {
    const svc = await makeService(resolved('claude-bridge'));

    await svc.bgCtrl.start();

    expect(phaseCalls).toContain('summary:4');
    expect(phaseCalls).toContain('classify:4');
  });

  it('skips all phases when no LLM config resolves', async () => {
    const svc = await makeService(null);

    await svc.bgCtrl.start();

    expect(phaseCalls).toEqual([]);
    expect(svc.bgCtrl.promise).toBeNull();
  });

  it('stops before phase work when the chat probe fails', async () => {
    probeResult = false;
    const svc = await makeService(resolved('openai-compat'));

    await svc.bgCtrl.start();

    expect(phaseCalls).toEqual([]);
  });

  it('marks a running pass dirty and reruns once after the current pass finishes', async () => {
    structuralGateEnabled = true;
    const svc = await makeService(resolved('openai-compat'));

    const first = svc.bgCtrl.start();
    const second = svc.bgCtrl.start();
    expect(second).toBe(first);

    await waitForGate(1);
    structuralGates.shift()?.();
    await waitForGate(1);
    structuralGates.shift()?.();
    await first;
    await svc.bgCtrl.awaitCompletion();

    expect(phaseCalls.filter((name) => name === 'structural')).toHaveLength(2);
    expect(svc.bgCtrl.promise).toBeNull();
  });

  it('cancel aborts a pending pass and clears progress state', async () => {
    structuralGateEnabled = true;
    const svc = await makeService(resolved('openai-compat'));

    const pending = svc.bgCtrl.start();
    await waitForGate(1);
    svc.bgCtrl.cancel();
    structuralGates.shift()?.();
    await pending;

    expect(svc.bgCtrl.getProgress()).toBeNull();
    expect(svc.bgCtrl.promise).toBeNull();
    expect(phaseCalls).toEqual(['structural']);
  });
});
