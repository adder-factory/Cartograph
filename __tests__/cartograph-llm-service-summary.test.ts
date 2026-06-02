import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedLlm } from '../src/llm/provider.js';

const state = {
  reachable: true,
  summaryResult: { candidates: 2, generated: 1, cacheHits: 1, errors: 0, deferred: 0, durationMs: 7 },
  summarizeCalls: [] as unknown[],
  fileSummaryCalls: [] as unknown[],
  dirSummaryCalls: [] as unknown[],
  filePrunes: 0,
  dirPrunes: 0,
  classifyCalls: [] as unknown[],
  phaseCalls: [] as string[],
  probeReachable: true,
};

vi.mock('../src/llm/client.js', () => ({
  LlmEndpointError: class extends Error {},
  BATCH_PARSE_FAILURE_LOG_CHARS: 120,
  normalizeEndpointConfig: (c: unknown) => c,
  LlmClient: class {
    async isReachable(): Promise<boolean> {
      return state.reachable;
    }
  },
}));

vi.mock('../src/llm/summarizer.js', () => ({
  SUMMARIZABLE_KINDS: new Set(['function', 'class', 'method', 'route']),
  MIN_BODY_LINES: 4,
  MIN_BODY_LINES_BY_KIND: new Map([['route', 1]]),
  DEFAULT_DOC_CHAR_THRESHOLD: 20,
  buildSummaryUserPrompt: vi.fn(() => 'prompt'),
  parseBatchSummaries: vi.fn(() => new Map()),
  contentHashFor: vi.fn(() => 'hash'),
  stripPreamble: vi.fn((s: string) => s),
  summarizeAll: vi.fn(async (args: unknown) => {
    state.summarizeCalls.push(args);
    return state.summaryResult;
  }),
}));

vi.mock('../src/llm/file-summarizer.js', () => ({
  summarizeAllFiles: vi.fn(async (args: unknown) => {
    state.fileSummaryCalls.push(args);
  }),
}));

vi.mock('../src/db/queries-file-summaries.js', () => ({
  pruneOrphanFileSummaries: vi.fn(() => {
    state.filePrunes++;
  }),
}));

vi.mock('../src/llm/dir-summarizer.js', () => ({
  summarizeAllDirectories: vi.fn(async (args: unknown) => {
    state.dirSummaryCalls.push(args);
  }),
}));

vi.mock('../src/db/queries-directory-summaries.js', () => ({
  pruneOrphanDirectorySummaries: vi.fn(() => {
    state.dirPrunes++;
  }),
}));

vi.mock('../src/llm/classifier.js', () => ({
  ROLE_LABELS: ['api', 'utility', 'domain', 'infra', 'test', 'unknown'],
  STRUCTURAL_ROLE_MODEL: 'structural:v2',
  API_PARAM_DECORATOR_RE: /(?:^|[\s([{,])(?:[A-Z][A-Za-z0-9_]*Decorator|Param)\b/,
  classifyByStructure: vi.fn(() => null),
  sanitizeApiEndpointRole: vi.fn((role: string) => role),
  parseBatchRoles: vi.fn(() => new Map()),
  classifyAllRoles: vi.fn(async (args: unknown) => {
    state.classifyCalls.push(args);
    return { candidates: 3, classified: 2, cacheHits: 1, errors: 0, durationMs: 5 };
  }),
}));

vi.mock('../src/cartograph-llm-pass.js', () => ({
  probeChatBackend: vi.fn(async () => state.probeReachable),
  runStructuralPhase: vi.fn(async () => {
    state.phaseCalls.push('structural');
  }),
  runEmbedPhase: vi.fn(async () => {
    state.phaseCalls.push('embed');
  }),
  runNeighborPropagationPhase: vi.fn(async () => {
    state.phaseCalls.push('neighbor');
  }),
  runSummaryPhase: vi.fn(async () => {
    state.phaseCalls.push('summary');
  }),
  runFileSummaryPhase: vi.fn(async () => {
    state.phaseCalls.push('file');
  }),
  runDirectorySummaryPhase: vi.fn(async () => {
    state.phaseCalls.push('directory');
  }),
  runClassifyPhase: vi.fn(async () => {
    state.phaseCalls.push('classify');
  }),
  runCommitIntentResiduePhase: vi.fn(async () => {
    state.phaseCalls.push('commit-intent');
  }),
}));

const { CartographLlmService } = await import('../src/cartograph-llm-service.js');

function resolved(overrides: Partial<ResolvedLlm> = {}): ResolvedLlm {
  return {
    summarizeLlm: {
      provider: 'openai-compat',
      endpoint: 'http://localhost:8081',
      model: 'chat-model',
    },
    embeddingLlm: {
      provider: 'openai-compat',
      endpoint: 'http://localhost:8080',
      model: 'embed-model',
    },
    resolutionTrace: 'test-trace',
    ...overrides,
  } as ResolvedLlm;
}

function service(config: ResolvedLlm | null): CartographLlmService {
  const svc = new CartographLlmService({
    config: { llm: { summarizeEagerLimit: 9 } },
    projectRoot: '/tmp/cartograph-llm-summary',
    queries: {},
    db: { getDb: () => ({}) },
  } as never);
  vi.spyOn(svc.config, 'resolveLlmConfig').mockResolvedValue(config);
  vi.spyOn(svc.embed, 'runOptionalEmbedPhase').mockResolvedValue({
    candidates: 1,
    generated: 1,
    errors: 0,
    skipped: 0,
    durationMs: 3,
  });
  return svc;
}

describe('CartographLlmService summarizeAll and classifyAll', () => {
  beforeEach(() => {
    state.reachable = true;
    state.summarizeCalls = [];
    state.fileSummaryCalls = [];
    state.dirSummaryCalls = [];
    state.filePrunes = 0;
    state.dirPrunes = 0;
    state.classifyCalls = [];
    state.phaseCalls = [];
    state.probeReachable = true;
    vi.clearAllMocks();
  });

  it('throws when summarizeAll has no chat provider or an unreachable backend', async () => {
    await expect(service(null).summarizeAll()).rejects.toThrow(/No summarize provider/);

    state.reachable = false;
    await expect(service(resolved()).summarizeAll()).rejects.toThrow(/Summarize backend not reachable/);
  });

  it('summarizes symbols, refreshes embeddings, file summaries, and directory summaries', async () => {
    const svc = service(
      resolved({ summarizeLlm: { provider: 'anthropic-api', model: 'claude', apiKey: 'sk' } } as never),
    );

    const result = await svc.summarizeAll({ concurrency: 2 });

    expect(result.embed?.generated).toBe(1);
    expect(state.summarizeCalls).toHaveLength(1);
    const summarizeArgs = state.summarizeCalls[0] as {
      modelLabel: string;
      options: { concurrency?: number; summaryBatchSize?: number; eagerLimit?: number };
    };
    expect(summarizeArgs.modelLabel).toBe('claude');
    expect(summarizeArgs.options.concurrency).toBe(2);
    expect(summarizeArgs.options.summaryBatchSize).toBe(3);
    expect(summarizeArgs.options.eagerLimit).toBe(9);
    expect(state.fileSummaryCalls).toHaveLength(1);
    expect(state.dirSummaryCalls).toHaveLength(1);
    expect(state.filePrunes).toBe(1);
    expect(state.dirPrunes).toBe(1);
  });

  it('honors caller batch size, explicit eager limit, and abort skips follow-up phases', async () => {
    const controller = new AbortController();
    controller.abort();
    const svc = service(resolved());

    const result = await svc.summarizeAll({ signal: controller.signal, summaryBatchSize: 4, eagerLimit: Infinity });

    expect(result.embed).toBeNull();
    const summarizeArgs = state.summarizeCalls[0] as { options: { summaryBatchSize?: number; eagerLimit?: number } };
    expect(summarizeArgs.options.summaryBatchSize).toBe(4);
    expect(summarizeArgs.options.eagerLimit).toBe(Infinity);
    expect(state.fileSummaryCalls).toHaveLength(0);
    expect(state.dirSummaryCalls).toHaveLength(0);
  });

  it('classifies roles with configured provider and forwards options', async () => {
    const svc = service(resolved());
    const progress: Array<[number, number]> = [];

    const result = await svc.classifyAll({ concurrency: 6, onProgress: (done, total) => progress.push([done, total]) });

    expect(result.classified).toBe(2);
    expect(state.classifyCalls).toHaveLength(1);
    const args = state.classifyCalls[0] as {
      modelLabel: string;
      options: { concurrency?: number; onProgress?: unknown };
    };
    expect(args.modelLabel).toBe('chat-model');
    expect(args.options.concurrency).toBe(6);
    expect(typeof args.options.onProgress).toBe('function');
  });

  it('throws classification setup errors clearly', async () => {
    await expect(service(null).classifyAll()).rejects.toThrow(/No summarize provider/);

    state.reachable = false;
    await expect(service(resolved()).classifyAll()).rejects.toThrow(/Summarize backend not reachable/);
  });

  it('runs the background LLM phases in order and reports idle progress after completion', async () => {
    const svc = service(resolved());

    await svc.bgCtrl.start();
    await svc.bgCtrl.awaitCompletion();

    expect(state.phaseCalls).toEqual([
      'structural',
      'embed',
      'neighbor',
      'summary',
      'embed',
      'file',
      'directory',
      'classify',
      'commit-intent',
    ]);
    expect(svc.bgCtrl.getProgress()).toBeNull();
  });

  it('skips chat-dependent background phases when the chat probe fails', async () => {
    state.probeReachable = false;
    const svc = service(resolved());

    await svc.bgCtrl.start();

    expect(state.phaseCalls).toEqual([]);
    expect(svc.bgCtrl.getProgress()).toBeNull();
  });

  it('runs structural-only background work when only embeddings are configured', async () => {
    const svc = service(resolved({ summarizeLlm: null }));

    await svc.bgCtrl.start();

    expect(state.phaseCalls).toEqual(['structural', 'embed', 'neighbor', 'embed']);
  });
});
