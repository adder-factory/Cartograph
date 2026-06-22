import { describe, expect, it, vi } from 'vitest';
import {
  indexAllOptions,
  parseMaxFileSizeValue,
  parseParseWorkersValue,
  phaseTimingLines,
  registerAdminIndexingCommands,
  reportBackgroundSummaryStatus,
  runAdminIndexCommand,
  runQuietIndex,
  syncResultMessages,
  type AdminIndexGraph,
  type AdminIndexingCommandDeps,
  type AdminIndexResult,
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
    expect(parseParseWorkersValue('3x')).toEqual({
      ok: false,
      error: '--parse-workers must be a positive integer (got "3x")',
    });
    expect(parseParseWorkersValue('1e2')).toEqual({
      ok: false,
      error: '--parse-workers must be a positive integer (got "1e2")',
    });
    expect(parseMaxFileSizeValue(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseMaxFileSizeValue('4096')).toEqual({ ok: true, value: 4096 });
    expect(parseMaxFileSizeValue('512kb')).toEqual({ ok: true, value: 512 * 1024 });
    expect(parseMaxFileSizeValue('2 MB')).toEqual({ ok: true, value: 2 * 1024 * 1024 });
    expect(parseMaxFileSizeValue('10mb')).toEqual({ ok: true, value: 10 * 1024 * 1024 });
    expect(parseMaxFileSizeValue('0')).toEqual({
      ok: false,
      error: '--max-file-size must be between 1 byte and 10mb (got "0")',
    });
    expect(parseMaxFileSizeValue('1e3')).toEqual({
      ok: false,
      error: '--max-file-size must be between 1 byte and 10mb (got "1e3")',
    });
    expect(parseMaxFileSizeValue('2 MB trailing')).toEqual({
      ok: false,
      error: '--max-file-size must be between 1 byte and 10mb (got "2 MB trailing")',
    });
    expect(parseMaxFileSizeValue('1gb')).toEqual({
      ok: false,
      error: '--max-file-size must be between 1 byte and 10mb (got "1gb")',
    });
    expect(parseMaxFileSizeValue('11mb')).toEqual({
      ok: false,
      error: '--max-file-size must be between 1 byte and 10mb (got "11mb")',
    });
    expect(indexAllOptions({ force: true, profile: true }, 4, 4096)).toEqual({
      summarize: false,
      profile: true,
      clearStructural: true,
      parseWorkers: 4,
      maxFileSize: 4096,
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
  it('sets exitCode on invalid parse-worker values before opening the graph', async () => {
    const { deps, calls } = fakeDeps();

    const exitCode = await withProcessExitGuard(() => runAdminIndexCommand('/repo', { parseWorkers: '0' }, deps));

    expect(exitCode).toBe(1);
    expect(calls).toContain('error:--parse-workers must be a positive integer (got "0")');
    expect(calls.some((call) => call.startsWith('open:'))).toBe(false);
  });

  it('sets exitCode for uninitialized projects before opening the graph', async () => {
    const { deps, calls } = fakeDeps({ initialized: false });

    const exitCode = await withProcessExitGuard(() => runAdminIndexCommand('/repo', {}, deps));

    expect(exitCode).toBe(1);
    expect(calls).toContain('error:Cartograph not initialized in /repo');
    expect(calls).toContain('info:Run "cartograph admin init" first');
    expect(calls.some((call) => call.startsWith('open:'))).toBe(false);
  });

  it('sets exitCode on invalid max-file-size values before opening the graph', async () => {
    const { deps, calls } = fakeDeps();

    const exitCode = await withProcessExitGuard(() => runAdminIndexCommand('/repo', { maxFileSize: 'abc' }, deps));

    expect(exitCode).toBe(1);
    expect(calls).toContain('error:--max-file-size must be between 1 byte and 10mb (got "abc")');
    expect(calls.some((call) => call.startsWith('open:'))).toBe(false);
  });

  it('sets exitCode when index graph opening fails', async () => {
    const { deps, calls } = fakeDeps({ openError: new Error('database locked') });

    const exitCode = await withProcessExitGuard(() => runAdminIndexCommand('/repo', {}, deps));

    expect(exitCode).toBe(1);
    expect(calls).toContain('open:/repo');
    expect(calls).toContain('error:Failed to index: database locked');
  });

  it('runs quiet indexing with parse-cache clearing, profile output, and graph cleanup', async () => {
    const { deps, calls } = fakeDeps();
    const graph = fakeGraph(calls);

    await runQuietIndex({
      cg: graph,
      options: { force: true, profile: true, clearParseCache: 'typescript' },
      parseWorkers: 2,
      maxFileSize: 4096,
      deps,
    });

    expect(calls).toContain('clearParseCache:typescript');
    expect(calls).toContain(
      'indexAll:{"summarize":false,"profile":true,"clearStructural":true,"parseWorkers":2,"maxFileSize":4096}',
    );
    expect(calls).toContain('stdout:{"scanMs":1}\n');
    expect(calls).toContain('close');
  });

  it('prints quiet indexing errors before setting exitCode on failed results', async () => {
    const { deps, calls } = fakeDeps();
    const graph = fakeGraph(calls, {
      indexResult: {
        success: false,
        errors: [
          { severity: 'error', filePath: 'src/bad.ts', message: 'parse failed' },
          { severity: 'error', message: 'global failure' },
        ],
      },
    });

    const exitCode = await withProcessExitGuard(() =>
      runQuietIndex({
        cg: graph,
        options: { force: true },
        parseWorkers: undefined,
        maxFileSize: undefined,
        deps,
      }),
    );

    expect(exitCode).toBe(1);
    expect(calls).toContain('stderr:src/bad.ts: parse failed\n');
    expect(calls).toContain('stderr:global failure\n');
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
      clack: noLlm.clack,
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
      clack: adhoc.clack,
      projectPath: '/repo',
      deps: fakeDeps().deps,
    });
    expect(adhoc.calls.join('\n')).toContain('close');
    expect(adhoc.calls.join('\n')).toContain('ad-hoc only');
  });

  it('registers index, embed-only, and sync command actions through injected dependencies', async () => {
    const { actions, calls, deps } = fakeDeps();

    await actions.get('index [path]')!('/repo', {
      quiet: true,
      force: true,
      profile: false,
      parseWorkers: '2',
      maxFileSize: '4096',
    });
    await actions.get('embed-only [path]')!('/repo', { quiet: true, maxFileSize: '2048' });
    await actions.get('sync [path]')!('/repo', { quiet: false, maxFileSize: '1024' });

    const text = calls.join('\n');
    expect(text.match(/open:\/repo/g)?.length).toBe(3);
    expect(text).toContain(
      'indexAll:{"summarize":false,"profile":false,"clearStructural":true,"parseWorkers":2,"maxFileSize":4096}',
    );
    expect(text).toContain('indexAll:{"summarize":false,"embedOnly":true,"maxFileSize":2048}');
    expect(text).toContain('embedAll:{}');
    expect(text).toContain('sync:{"maxFileSize":1024}');
    expect(text).toContain('awaitSummarisationWithProgress');
    expect(deps.loadClack).toHaveBeenCalled();
  });

  it('runs interactive index and detached summary status through injected UI adapters', async () => {
    const { actions, calls } = fakeDeps({
      detached: { spawned: true, pid: 1234 },
    });

    await actions.get('index [path]')!('/repo', {
      quiet: false,
      force: true,
      profile: true,
      clearParseCache: true,
      parseWorkers: '1',
    });

    const text = calls.join('\n');
    expect(text).toContain('intro:Indexing project');
    expect(text).toContain('Full re-index (--force)');
    expect(text).toContain('clearParseCache:all');
    expect(text).toContain('progress.stop');
    expect(text).toContain('note:Phase timings');
    expect(text).toContain('spawnDetachedSummarize:/repo');
    expect(text).toContain('pid 1234');
    expect(text).toContain('outro:Done');
  });

  it('sets exitCode and skips detached summaries when interactive indexing fails', async () => {
    const { actions, calls } = fakeDeps({
      graphOptions: {
        indexResult: {
          success: false,
          errors: [{ severity: 'error', filePath: 'src/bad.ts', message: 'parse failed' }],
        },
      },
    });

    const exitCode = await withProcessExitGuard(() =>
      getAction(actions, 'index [path]')('/repo', { quiet: false, profile: true }),
    );

    const text = calls.join('\n');
    expect(exitCode).toBe(1);
    expect(text).toContain('printIndexResult:/repo');
    expect(text).not.toContain('spawnDetachedSummarize:/repo');
    expect(text).not.toContain('outro:Done');
  });

  it('runs non-quiet embed-only indexing with verbose progress and warning fallback', async () => {
    const { actions, calls } = fakeDeps({
      graphOptions: { embedError: new Error('backend offline') },
    });

    await actions.get('embed-only [path]')!('/repo', { quiet: false, verbose: true });

    const text = calls.join('\n');
    expect(text).toContain('intro:Embed-only indexing');
    expect(text).toContain('indexAll:{"verbose":true,"embedOnly":true,"summarize":false}');
    expect(text).toContain('info:Running embed pass');
    expect(text).toContain('warn:Embed pass skipped: backend offline');
    expect(text).toContain('outro:Done');
    expect(text).toContain('close');
  });

  it('sets exitCode for embed-only argument, initialization, and open failures', async () => {
    {
      const { actions, calls } = fakeDeps();
      const exitCode = await withProcessExitGuard(() =>
        getAction(actions, 'embed-only [path]')('/repo', { quiet: true, maxFileSize: 'huge' }),
      );
      expect(exitCode).toBe(1);
      expect(calls).toContain('error:--max-file-size must be between 1 byte and 10mb (got "huge")');
      expect(calls.some((call) => call.startsWith('open:'))).toBe(false);
    }

    {
      const { actions, calls } = fakeDeps({ initialized: false });
      const exitCode = await withProcessExitGuard(() => getAction(actions, 'embed-only [path]')('/repo', {}));
      expect(exitCode).toBe(1);
      expect(calls).toContain('error:Cartograph not initialized in /repo');
      expect(calls.some((call) => call.startsWith('open:'))).toBe(false);
    }

    {
      const { actions, calls } = fakeDeps({ openError: new Error('database unavailable') });
      const exitCode = await withProcessExitGuard(() => getAction(actions, 'embed-only [path]')('/repo', {}));
      expect(exitCode).toBe(1);
      expect(calls).toContain('open:/repo');
      expect(calls).toContain('error:Failed to embed-only index: database unavailable');
    }
  });

  it('sets exitCode for quiet embed-only failed index and embed pass failures', async () => {
    {
      const { actions, calls } = fakeDeps({
        graphOptions: {
          indexResult: {
            success: false,
            errors: [{ severity: 'error', filePath: 'src/bad.ts', message: 'parse failed' }],
          },
        },
      });
      const exitCode = await withProcessExitGuard(() =>
        getAction(actions, 'embed-only [path]')('/repo', { quiet: true }),
      );
      expect(exitCode).toBe(1);
      expect(calls).toContain('indexAll:{"summarize":false,"embedOnly":true}');
      expect(calls).not.toContain('embedAll:{}');
    }

    {
      const { actions, calls } = fakeDeps({
        graphOptions: { embedError: new Error('embedding backend offline') },
      });
      const exitCode = await withProcessExitGuard(() =>
        getAction(actions, 'embed-only [path]')('/repo', { quiet: true }),
      );
      expect(exitCode).toBe(1);
      expect(calls).toContain('embedAll:{}');
      expect(calls).toContain('error:Embed pass failed: embedding backend offline');
    }
  });

  it('sets exitCode and skips embed pass when interactive embed-only indexing fails', async () => {
    const { actions, calls } = fakeDeps({
      graphOptions: {
        indexResult: {
          success: false,
          errors: [{ severity: 'error', filePath: 'src/bad.ts', message: 'parse failed' }],
        },
      },
    });

    const exitCode = await withProcessExitGuard(() => getAction(actions, 'embed-only [path]')('/repo', {}));

    const text = calls.join('\n');
    expect(exitCode).toBe(1);
    expect(text).toContain('printIndexResult:/repo');
    expect(text).not.toContain('Running embed pass');
    expect(text).not.toContain('embedAll:{}');
    expect(text).not.toContain('outro:Done');
  });

  it('sets exitCode for sync argument, initialization, and runtime failures', async () => {
    {
      const { actions, calls } = fakeDeps();
      const exitCode = await withProcessExitGuard(() =>
        getAction(actions, 'sync [path]')('/repo', { maxFileSize: 'huge' }),
      );
      expect(exitCode).toBe(1);
      expect(calls).toContain('error:--max-file-size must be between 1 byte and 10mb (got "huge")');
      expect(calls.some((call) => call.startsWith('open:'))).toBe(false);
    }

    {
      const { actions, calls } = fakeDeps({ initialized: false });
      const exitCode = await withProcessExitGuard(() => getAction(actions, 'sync [path]')('/repo', {}));
      expect(exitCode).toBe(1);
      expect(calls).toContain('error:Cartograph not initialized in /repo');
      expect(calls.some((call) => call.startsWith('open:'))).toBe(false);
    }

    {
      const { actions, calls } = fakeDeps({ graphOptions: { syncError: new Error('scan failed') } });
      const exitCode = await withProcessExitGuard(() => getAction(actions, 'sync [path]')('/repo', {}));
      expect(exitCode).toBe(1);
      expect(calls).toContain('sync:{}');
      expect(calls).toContain('error:Failed to sync: scan failed');
      expect(calls).toContain('close');
    }
  });

  it('sets exitCode for biomarker refresh initialization and runtime failures', async () => {
    {
      const { actions, calls } = fakeDeps({ initialized: false });
      const exitCode = await withProcessExitGuard(() => getAction(actions, 'biomarkers-refresh [path]')('/repo', {}));
      expect(exitCode).toBe(1);
      expect(calls).toContain('error:Cartograph not initialized in /repo');
      expect(calls.some((call) => call.startsWith('open:'))).toBe(false);
    }

    {
      const { actions, calls } = fakeDeps({ graphOptions: { biomarkersError: new Error('rule crashed') } });
      const exitCode = await withProcessExitGuard(() => getAction(actions, 'biomarkers-refresh [path]')('/repo', {}));
      expect(exitCode).toBe(1);
      expect(calls).toContain('refreshBiomarkers');
      expect(calls).toContain('error:Failed to refresh biomarkers: rule crashed');
      expect(calls).toContain('close');
    }
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

function fakeGraph(
  calls: string[],
  opts: {
    llmConfig?: unknown;
    summarizeEagerLimit?: number;
    indexResult?: Partial<AdminIndexResult>;
    indexError?: Error;
    syncError?: Error;
    embedError?: Error;
    biomarkersError?: Error;
    biomarkersResult?: Awaited<ReturnType<AdminIndexGraph['stats']['refreshBiomarkers']>>;
  } = {},
): AdminIndexGraph {
  const llmValue = Object.hasOwn(opts, 'llmConfig') ? opts.llmConfig : { summarizeLlm: { model: 'qwen' } };
  return {
    queries: null,
    config: { llm: { summarizeEagerLimit: opts.summarizeEagerLimit } },
    close: () => calls.push('close'),
    indexAll: async (indexOpts) => {
      calls.push(`indexAll:${JSON.stringify(indexOpts)}`);
      if (opts.indexError) throw opts.indexError;
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
        ...opts.indexResult,
      };
    },
    sync: async (syncOpts) => {
      calls.push(`sync:${JSON.stringify(syncOpts)}`);
      if (opts.syncError) throw opts.syncError;
      return { ...noChangeSyncResult(), filesAdded: 1, nodesUpdated: 2 };
    },
    stats: {
      refreshBiomarkers: async () => {
        calls.push('refreshBiomarkers');
        if (opts.biomarkersError) throw opts.biomarkersError;
        return opts.biomarkersResult ?? { filesScanned: 2, findingsEmitted: 1, errors: 0, durationMs: 5 };
      },
    },
    llm: {
      config: { getEffectiveLlmConfig: async () => llmValue },
      bgCtrl: {
        promise: null,
        getProgress: () => null,
        awaitCompletion: async () => undefined,
      },
      embed: {
        embedAll: async (embedOpts = {}) => {
          calls.push(`embedAll:${JSON.stringify(embedOpts)}`);
          if (opts.embedError) throw opts.embedError;
          return { generated: 1, candidates: 1, errors: 0, skipped: 0, durationMs: 5 };
        },
      },
    },
  };
}

function fakeClack(existingCalls?: string[]) {
  const calls: string[] = existingCalls ?? [];
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

function fakeDeps(
  opts: {
    initialized?: boolean;
    detached?: { spawned: boolean; pid?: number; reason?: string };
    graphOptions?: Parameters<typeof fakeGraph>[1];
    openError?: Error;
  } = {},
) {
  const actions = new Map<string, (...args: unknown[]) => Promise<void>>();
  const calls: string[] = [];
  const clack = fakeClack(calls);
  const graph = fakeGraph(calls, opts.graphOptions);
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
    isInitialized: () => opts.initialized ?? true,
    loadCartograph: async () => ({
      default: {
        open: async (projectPath) => {
          calls.push(`open:${projectPath}`);
          if (opts.openError) throw opts.openError;
          return graph;
        },
      },
    }),
    loadClack: vi.fn(async () => clack.clack),
    loadParseCache: async () => ({
      clearParseCache: (_queries, language) => {
        calls.push(`clearParseCache:${language ?? 'all'}`);
        return 4;
      },
    }),
    loadDetachedSummarize: async () => ({
      spawnDetachedSummarize: (projectPath) => {
        calls.push(`spawnDetachedSummarize:${projectPath}`);
        return opts.detached ?? { spawned: false, reason: 'not started' };
      },
    }),
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    writeStdout: (message) => calls.push(`stdout:${message}`),
    writeStderr: (message) => calls.push(`stderr:${message}`),
  };

  registerAdminIndexingCommands(deps);
  return { actions, calls, deps };
}

function getAction(
  actions: Map<string, (...args: unknown[]) => Promise<void>>,
  name: string,
): (...args: unknown[]) => Promise<void> {
  const action = actions.get(name);
  if (!action) throw new Error(`missing action ${name}`);
  return action;
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
