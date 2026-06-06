import { describe, expect, it, vi } from 'vitest';
import {
  indexAllOptions,
  parseParseWorkersValue,
  phaseTimingLines,
  registerAdminIndexingCommands,
  reportBackgroundSummaryStatus,
  runQuietIndex,
  syncResultMessages,
  type AdminIndexGraph,
  type AdminIndexingCommandDeps,
} from '../src/features/admin-indexing/index.js';

const TEST_FILES_INDEXED = 1;
const TEST_NODES_CREATED = 2;
const TEST_EDGES_CREATED = 3;
const TEST_INDEX_DURATION_MS = 10;
const TEST_PROFILE_SCAN_MS = 1;

describe('admin indexing feature runtime', () => {
  it('parses workers and builds index options with explicit contracts', () => {
    expect(parseParseWorkersValue(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseParseWorkersValue('3')).toEqual({ ok: true, value: 3 });
    expect(parseParseWorkersValue('0')).toEqual({
      ok: false,
      error: '--parse-workers must be a positive integer (got "0")',
    });
    expect(indexAllOptions({ force: true, profile: true }, 4)).toEqual({
      summarize: false,
      profile: true,
      clearStructural: true,
      parseWorkers: 4,
    });
  });

  it('renders phase timing and sync result messages as data', () => {
    const lines = phaseTimingLines(
      {
        success: true,
        filesIndexed: 0,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [],
        durationMs: 1000,
        profile: {
          scanMs: 100,
          parseStoreMs: 200,
          retryMs: 50,
          resolveMs: 150,
          postHooksMs: 300,
          postHooksByHook: { biomarkers: 120 },
          maintenanceMs: 25,
        },
      },
      { formatDuration: (ms) => `${ms}ms` },
    );

    expect(lines.join('\n')).toContain('retry');
    expect(lines.join('\n')).toContain('biomarkers');
    expect(lines.join('\n')).toContain('total');
    expect(syncResultMessages(noChangeSyncResult(), testFormatters())).toEqual([
      { level: 'info', message: 'Already up to date' },
    ]);
    expect(syncResultMessages({ ...noChangeSyncResult(), filesAdded: 1, nodesUpdated: 5 }, testFormatters())).toEqual([
      { level: 'success', message: 'Synced 1 changed files' },
      { level: 'info', message: 'Added: 1 — 5 nodes in 10ms' },
    ]);
  });
});

describe('admin indexing feature CLI', () => {
  it('runs quiet indexing with parse-cache clearing, profile output, and graph cleanup', async () => {
    const { deps, calls } = fakeDeps();
    const graph = fakeGraph(calls);

    await runQuietIndex({
      cg: graph,
      options: { force: true, profile: true, clearParseCache: 'typescript' },
      parseWorkers: 2,
      deps,
    });

    expect(calls).toContain('clearParseCache:typescript');
    expect(calls).toContain('indexAll:{"summarize":false,"profile":true,"clearStructural":true,"parseWorkers":2}');
    expect(calls).toContain('stdout:{"scanMs":1}\n');
    expect(calls).toContain('close');
  });

  it('reports no-LLM and ad-hoc-only summary states after closing the graph', async () => {
    const noLlm = fakeClack();
    const noLlmGraph = fakeGraph(noLlm.calls, {
      llmConfig: null,
      summarizeEagerLimit: undefined,
    });
    await reportBackgroundSummaryStatus({
      cg: noLlmGraph,
      clack: noLlm.clack as any,
      projectPath: '/repo',
      deps: fakeDeps().deps,
    });
    expect(noLlm.calls.join('\n')).toContain('close');
    expect(noLlm.calls.join('\n')).toContain('symbol summaries skipped');

    const adhoc = fakeClack();
    const adhocGraph = fakeGraph(adhoc.calls, {
      llmConfig: { summarizeLlm: { model: 'qwen' } },
      summarizeEagerLimit: 0,
    });
    await reportBackgroundSummaryStatus({
      cg: adhocGraph,
      clack: adhoc.clack as any,
      projectPath: '/repo',
      deps: fakeDeps().deps,
    });
    expect(adhoc.calls.join('\n')).toContain('close');
    expect(adhoc.calls.join('\n')).toContain('ad-hoc only');
  });

  it('registers index, embed-only, and sync command actions through injected dependencies', async () => {
    const { actions, calls, deps } = fakeDeps();

    await actions.get('index [path]')!('/repo', { quiet: true, force: true, profile: false, parseWorkers: '2' });
    await actions.get('embed-only [path]')!('/repo', { quiet: true });
    await actions.get('sync [path]')!('/repo', { quiet: false });

    const text = calls.join('\n');
    expect(text.match(/open:\/repo/g)?.length).toBe(3);
    expect(text).toContain('indexAll:{"summarize":false,"profile":false,"clearStructural":true,"parseWorkers":2}');
    expect(text).toContain('indexAll:{"summarize":false,"embedOnly":true}');
    expect(text).toContain('embedAll:{}');
    expect(text).toContain('sync:{}');
    expect(text).toContain('awaitSummarisationWithProgress');
    expect(deps.loadClack).toHaveBeenCalled();
  });
});

function noChangeSyncResult() {
  return {
    filesAdded: 0,
    filesModified: 0,
    filesRemoved: 0,
    nodesUpdated: 0,
    durationMs: 10,
  };
}

function testFormatters() {
  return {
    formatNumber: (n: number) => String(n),
    formatDuration: (ms: number) => `${ms}ms`,
  };
}

function fakeGraph(calls: string[], opts: { llmConfig?: unknown; summarizeEagerLimit?: number } = {}): AdminIndexGraph {
  const llmValue = Object.hasOwn(opts, 'llmConfig') ? opts.llmConfig : { summarizeLlm: { model: 'qwen' } };
  return {
    queries: {},
    config: { llm: { summarizeEagerLimit: opts.summarizeEagerLimit } },
    close: () => calls.push('close'),
    indexAll: async (indexOpts) => {
      calls.push(`indexAll:${JSON.stringify(indexOpts)}`);
      return {
        success: true,
        filesIndexed: TEST_FILES_INDEXED,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: TEST_NODES_CREATED,
        edgesCreated: TEST_EDGES_CREATED,
        errors: [],
        durationMs: TEST_INDEX_DURATION_MS,
        profile: { scanMs: TEST_PROFILE_SCAN_MS },
      };
    },
    sync: async (syncOpts) => {
      calls.push(`sync:${JSON.stringify(syncOpts)}`);
      return { ...noChangeSyncResult(), filesAdded: 1, nodesUpdated: 2 };
    },
    llm: {
      config: { getEffectiveLlmConfig: async () => llmValue },
      embed: {
        embedAll: async (embedOpts = {}) => {
          calls.push(`embedAll:${JSON.stringify(embedOpts)}`);
          return { generated: 1, candidates: 1, errors: 0, skipped: 0, durationMs: 5 };
        },
      },
    },
  };
}

function fakeClack() {
  const calls: string[] = [];
  return {
    calls,
    clack: {
      intro: (message: string) => calls.push(`intro:${message}`),
      outro: (message: string) => calls.push(`outro:${message}`),
      log: {
        info: (message: string) => calls.push(`info:${message}`),
        success: (message: string) => calls.push(`success:${message}`),
        warn: (message: string) => calls.push(`warn:${message}`),
        error: (message: string) => calls.push(`error:${message}`),
      },
      note: (message: string, title?: string) => calls.push(`note:${title}:${message}`),
    },
  };
}

function fakeDeps() {
  const actions = new Map<string, (...args: any[]) => Promise<void>>();
  const calls: string[] = [];
  const clack = fakeClack();
  const graph = fakeGraph(calls);
  const deps: AdminIndexingCommandDeps = {
    adminCmd: new FakeCommand(actions),
    colors: { dim: 'dim', reset: 'reset' },
    error: (message) => calls.push(`error:${message}`),
    info: (message) => calls.push(`info:${message}`),
    formatNumber: (n) => String(n),
    formatDuration: (ms) => `${ms}ms`,
    createVerboseProgress: () => () => undefined,
    createShimmerProgress: () => ({
      onProgress: () => undefined,
      stop: async () => calls.push('progress.stop'),
    }),
    awaitSummarisationWithProgress: async () => calls.push('awaitSummarisationWithProgress'),
    printIndexResult: (_clack, _result, projectPath) => calls.push(`printIndexResult:${projectPath}`),
    isInitialized: () => true,
    loadCartograph: async () => ({
      default: {
        open: async (projectPath) => {
          calls.push(`open:${projectPath}`);
          return graph;
        },
      },
    }),
    loadClack: vi.fn(async () => clack.clack as any),
    loadParseCache: async () => ({
      clearParseCache: (_queries, language) => {
        calls.push(`clearParseCache:${language ?? 'all'}`);
        return 4;
      },
    }),
    loadDetachedSummarize: async () => ({
      spawnDetachedSummarize: (projectPath) => {
        calls.push(`spawnDetachedSummarize:${projectPath}`);
        return { spawned: false, reason: 'not started' };
      },
    }),
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    writeStdout: (message) => calls.push(`stdout:${message}`),
    writeStderr: (message) => calls.push(`stderr:${message}`),
  };

  registerAdminIndexingCommands(deps);
  return { actions, calls, deps };
}

class FakeCommand {
  constructor(
    private readonly actions: Map<string, (...args: any[]) => Promise<void>>,
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

  action(fn: (...args: any[]) => Promise<void>): this {
    this.actions.set(this.name, fn);
    return this;
  }
}
