import { describe, expect, it, vi } from 'vitest';
import {
  classifySuccessMessages,
  parseConcurrencyOptionValue,
  parseEagerLimitValue,
  registerAdminLlmEnrichmentCommands,
  summarizeDetailMessages,
  type AdminLlmEnrichmentCommandDeps,
  type LlmEmbedResult,
} from '../src/features/admin-llm-enrichment/index.js';

const TEST_DEFAULT_CONCURRENCY = 2;
const TEST_REQUESTED_CONCURRENCY = 3;
const TEST_EAGER_LIMIT = 5;
const TEST_SUMMARY_CANDIDATES = 8;
const TEST_SUMMARY_GENERATED = 3;
const TEST_SUMMARY_CACHE_HITS = 1;
const TEST_SUMMARY_DEFERRED = 1;
const TEST_SUMMARY_DURATION_MS = 25;
const TEST_EMBED_GENERATED = 4;
const TEST_EMBED_DURATION_MS = 9;
const TEST_CLASSIFIED = 6;
const TEST_CLASSIFY_DURATION_MS = 12;

describe('admin LLM enrichment feature runtime', () => {
  it('parses numeric options as explicit success or failure values', () => {
    expect(parseConcurrencyOptionValue(undefined, parseConcurrency)).toEqual({
      ok: true,
      value: TEST_DEFAULT_CONCURRENCY,
    });
    expect(parseConcurrencyOptionValue(String(TEST_REQUESTED_CONCURRENCY), parseConcurrency)).toEqual({
      ok: true,
      value: TEST_REQUESTED_CONCURRENCY,
    });
    expect(parseConcurrencyOptionValue('nope', parseConcurrency)).toEqual({
      ok: false,
      error: '--concurrency must be a positive integer',
    });

    expect(parseEagerLimitValue({})).toEqual({ ok: true, value: undefined });
    expect(parseEagerLimitValue({ all: true })).toEqual({ ok: true, value: Number.POSITIVE_INFINITY });
    expect(parseEagerLimitValue({ limit: String(TEST_EAGER_LIMIT) })).toEqual({
      ok: true,
      value: TEST_EAGER_LIMIT,
    });
    expect(parseEagerLimitValue({ limit: '-1' })).toEqual({
      ok: false,
      error: '--limit must be a non-negative integer (0 = ad-hoc only; use --all for an uncapped pass)',
    });
  });

  it('renders summarize and classify result messages as data', () => {
    const messages = summarizeDetailMessages(
      {
        candidates: TEST_SUMMARY_CANDIDATES,
        generated: TEST_SUMMARY_GENERATED,
        errors: 0,
        cacheHits: TEST_SUMMARY_CACHE_HITS,
        deferred: TEST_SUMMARY_DEFERRED,
        durationMs: TEST_SUMMARY_DURATION_MS,
        embed: embedResult(),
      },
      formatters(),
    );

    expect(messages.map((m) => m.message).join('\n')).toContain('Summarised 3 new symbols');
    expect(messages.map((m) => m.message).join('\n')).toContain('Cache hits: 1');
    expect(messages.map((m) => m.message).join('\n')).toContain('Deferred 1 lower-priority symbols');
    expect(messages.map((m) => m.message).join('\n')).toContain('Embedded 4 new vectors');

    expect(
      classifySuccessMessages(
        { classified: TEST_CLASSIFIED, candidates: 0, errors: 1, durationMs: TEST_CLASSIFY_DURATION_MS },
        formatters(),
      ).map((m) => m.message),
    ).toEqual([
      'Classified 6 symbols in 12ms (1 errors)',
      'No candidates — every symbol with a description (summary or docstring) already has a role from the active model.',
    ]);
  });

  it('emits an explicit "nothing to summarise" signal on a zero-candidate run (issue #25)', () => {
    const text = summarizeDetailMessages(
      { candidates: 0, generated: 0, errors: 0, cacheHits: 0, deferred: 0, durationMs: 5, embed: null },
      formatters(),
    )
      .map((m) => m.message)
      .join('\n');
    expect(text).toContain('Summarised 0 new symbols');
    expect(text).toContain('Nothing to summarise');
    expect(text).toContain('eager pass is complete');
  });
});

describe('admin LLM enrichment feature CLI', () => {
  it('registers summarize, embed, and classify actions through injected dependencies', async () => {
    const { actions, calls } = fakeDeps();

    await actions.get('summarize [path]')!('/repo', {
      quiet: false,
      concurrency: String(TEST_REQUESTED_CONCURRENCY),
      limit: String(TEST_EAGER_LIMIT),
    });
    await actions.get('embed [path]')!('/repo', {
      quiet: true,
      concurrency: String(TEST_REQUESTED_CONCURRENCY),
    });
    await actions.get('classify [path]')!('/repo', {
      quiet: false,
      concurrency: String(TEST_REQUESTED_CONCURRENCY),
    });

    const text = calls.join('\n');
    expect(text.match(/open:\/repo/g)?.length).toBe(3);
    expect(text).toContain('summarizeAll:{"concurrency":3,"eagerLimit":5,"hasProgress":true}');
    expect(text).toContain('progress.stop');
    expect(text).toContain('embedAll:{"concurrency":3}');
    expect(text).toContain('classifyAll:{"concurrency":3}');
    expect(text).toContain('success:Summarised 3 new symbols in 25ms');
    expect(text).toContain('success:Classified 6 symbols in 12ms');
    expect(text.match(/close/g)?.length).toBe(3);
  });

  it('reports invalid summarize concurrency without calling process.exit or opening the graph', async () => {
    const { actions, calls } = fakeDeps();

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('summarize [path]')!('/repo', { quiet: false, concurrency: 'nope' });
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain('error:--concurrency must be a positive integer');
    expect(calls).not.toContain('open:/repo');
  });

  it('reports invalid summarize eager limit without calling process.exit or opening the graph', async () => {
    const { actions, calls } = fakeDeps();

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('summarize [path]')!('/repo', { quiet: false, limit: '-1' });
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain(
      'error:--limit must be a non-negative integer (0 = ad-hoc only; use --all for an uncapped pass)',
    );
    expect(calls).not.toContain('open:/repo');
  });

  it('reports summarize on an uninitialized project without calling process.exit or opening the graph', async () => {
    const { actions, calls } = fakeDeps({ initialized: false });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('summarize [path]')!('/repo', { quiet: false });
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain('error:Cartograph not initialized in /repo');
    expect(calls).not.toContain('open:/repo');
  });

  it('reports missing summarize LLM config without calling process.exit and closes the graph', async () => {
    const { actions, calls } = fakeDeps({ llmConfig: null });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('summarize [path]')!('/repo', { quiet: false });
    });

    const text = calls.join('\n');
    expect(exitCode).toBe(1);
    expect(text).toContain('open:/repo');
    expect(text).toContain('error:No LLM available.');
    expect(text.match(/close/g)?.length).toBe(1);
  });

  it('reports summarize failures without calling process.exit and closes the graph', async () => {
    const { actions, calls } = fakeDeps({ summarizeError: new Error('summarize boom') });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('summarize [path]')!('/repo', { quiet: false });
    });

    const text = calls.join('\n');
    expect(exitCode).toBe(1);
    expect(text).toContain('progress.stop');
    expect(text).toContain('error:Failed to summarise: summarize boom');
    expect(text.match(/close/g)?.length).toBe(1);
  });

  it('reports embed on an uninitialized project without calling process.exit or opening the graph', async () => {
    const { actions, calls } = fakeDeps({ initialized: false });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('embed [path]')!('/repo', { quiet: false });
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain('error:Cartograph not initialized in /repo');
    expect(calls).not.toContain('open:/repo');
  });

  it('reports embed failures without calling process.exit and closes the graph', async () => {
    const { actions, calls } = fakeDeps({ embedError: new Error('embed boom') });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('embed [path]')!('/repo', { quiet: false });
    });

    const text = calls.join('\n');
    expect(exitCode).toBe(1);
    expect(text).toContain('error:Failed to embed: embed boom');
    expect(text.match(/close/g)?.length).toBe(1);
  });
});

function parseConcurrency(raw: string | undefined): number {
  return raw === undefined ? TEST_DEFAULT_CONCURRENCY : Number(raw);
}

function formatters() {
  return {
    formatNumber: (n: number) => String(n),
    formatDuration: (ms: number) => `${ms}ms`,
  };
}

function embedResult(): LlmEmbedResult {
  return {
    generated: TEST_EMBED_GENERATED,
    errors: 0,
    skipped: 0,
    durationMs: TEST_EMBED_DURATION_MS,
  };
}

interface FakeDepsOptions {
  initialized?: boolean;
  llmConfig?: unknown;
  summarizeError?: Error;
  embedError?: Error;
  classifyError?: Error;
}

async function withProcessExitGuard(run: () => Promise<void>): Promise<string | number | undefined> {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
    throw new Error(`process.exit(${String(code)})`);
  });
  try {
    await run();
    return process.exitCode;
  } finally {
    exitSpy.mockRestore();
    process.exitCode = originalExitCode ?? 0;
  }
}

function fakeDeps(options: FakeDepsOptions = {}) {
  const actions = new Map<string, (...args: unknown[]) => Promise<void>>();
  const calls: string[] = [];
  const deps: AdminLlmEnrichmentCommandDeps = {
    adminCmd: new FakeCommand(actions),
    createShimmerProgress: () => ({
      onProgress: (progress: unknown) => calls.push(`progress:${JSON.stringify(progress)}`),
      stop: async () => calls.push('progress.stop'),
    }),
    error: (message) => calls.push(`error:${message}`),
    ...formatters(),
    isInitialized: () => options.initialized ?? true,
    loadCartograph: async () => ({
      default: {
        open: async (projectPath) => {
          calls.push(`open:${projectPath}`);
          return fakeGraph(calls, options);
        },
      },
    }),
    loadClack: vi.fn(async () => fakeClack(calls)),
    parseConcurrency,
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
  };

  registerAdminLlmEnrichmentCommands(deps);
  return { actions, calls };
}

function fakeGraph(calls: string[], options: FakeDepsOptions = {}) {
  const llmConfig = options.llmConfig === undefined ? { summarizeLlm: { model: 'qwen' } } : options.llmConfig;

  return {
    close: () => calls.push('close'),
    llm: {
      config: { getEffectiveLlmConfig: async () => llmConfig },
      summarizeAll: async (opts: {
        concurrency: number;
        eagerLimit?: number;
        onProgress?: (done: number, total: number) => void;
      }) => {
        if (options.summarizeError) throw options.summarizeError;
        calls.push(
          `summarizeAll:${JSON.stringify({
            concurrency: opts.concurrency,
            eagerLimit: opts.eagerLimit,
            hasProgress: typeof opts.onProgress === 'function',
          })}`,
        );
        opts.onProgress?.(TEST_SUMMARY_GENERATED, TEST_SUMMARY_CANDIDATES);
        return {
          candidates: TEST_SUMMARY_CANDIDATES,
          generated: TEST_SUMMARY_GENERATED,
          errors: 0,
          cacheHits: TEST_SUMMARY_CACHE_HITS,
          deferred: TEST_SUMMARY_DEFERRED,
          durationMs: TEST_SUMMARY_DURATION_MS,
          embed: embedResult(),
        };
      },
      embed: {
        embedAll: async (opts = {}) => {
          if (options.embedError) throw options.embedError;
          calls.push(`embedAll:${JSON.stringify(opts)}`);
          return embedResult();
        },
      },
      classifyAll: async (opts: { concurrency: number }) => {
        if (options.classifyError) throw options.classifyError;
        calls.push(`classifyAll:${JSON.stringify(opts)}`);
        return {
          classified: TEST_CLASSIFIED,
          candidates: TEST_CLASSIFIED,
          errors: 0,
          durationMs: TEST_CLASSIFY_DURATION_MS,
        };
      },
    },
  };
}

function fakeClack(calls: string[]) {
  return {
    intro: (message: string) => calls.push(`intro:${message}`),
    outro: (message: string) => calls.push(`outro:${message}`),
    log: {
      info: (message: string) => calls.push(`info:${message}`),
      success: (message: string) => calls.push(`success:${message}`),
      warn: (message: string) => calls.push(`warn:${message}`),
      error: (message: string) => calls.push(`error:${message}`),
    },
    note: (message: string, title?: string) => calls.push(`note:${title}:${message}`),
  };
}

class FakeCommand {
  constructor(
    private readonly actions: Map<string, (...args: unknown[]) => Promise<void>>,
    private readonly name = 'admin',
  ) {}

  command(name: string): FakeCommand {
    return new FakeCommand(this.actions, name);
  }

  description(): this {
    return this;
  }

  option(): this {
    return this;
  }

  action(fn: (...args: unknown[]) => Promise<void>): this {
    this.actions.set(this.name, fn);
    return this;
  }
}
