import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerAdminCommands, type AdminCommandDeps } from '../src/bin/commands/admin.js';

const actions = new Map<string, (...args: unknown[]) => unknown>();
const calls: string[] = [];
let projectPath: string;

class FakeCommand {
  constructor(private readonly name = 'admin') {}

  command(name: string): FakeCommand {
    return new FakeCommand(name);
  }

  description(): this {
    return this;
  }

  option(): this {
    return this;
  }

  requiredOption(): this {
    return this;
  }

  action(fn: (...args: unknown[]) => unknown): this {
    actions.set(this.name, fn);
    return this;
  }
}

function fakeIndexResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    filesIndexed: 1,
    filesSkipped: 0,
    filesErrored: 0,
    nodesCreated: 2,
    edgesCreated: 3,
    errors: [],
    durationMs: 10,
    ...overrides,
  };
}

function fakeCg(overrides: Record<string, unknown> = {}) {
  return {
    queries: {},
    config: { llm: {} },
    indexAll: vi.fn(async () => fakeIndexResult()),
    sync: vi.fn(async () => ({ filesAdded: 1, filesModified: 1, filesRemoved: 0, nodesUpdated: 4, durationMs: 25 })),
    uninitialize: vi.fn(async () => calls.push('uninitialize')),
    close: vi.fn(() => calls.push('close')),
    llm: {
      config: { getEffectiveLlmConfig: vi.fn(async () => ({ summarizeLlm: { model: 'qwen' } })) },
      summarizeAll: vi.fn(async () => ({
        candidates: 2,
        generated: 1,
        errors: 0,
        cacheHits: 0,
        deferred: 0,
        durationMs: 20,
      })),
      embed: { embedAll: vi.fn(async () => ({ generated: 2, candidates: 2, errors: 0, skipped: 0, durationMs: 10 })) },
      classifyAll: vi.fn(async () => ({ classified: 2, candidates: 2, errors: 0, durationMs: 10 })),
    },
    db: { getSchemaVersion: () => ({ version: 99 }), getSize: () => 1024 },
    ...overrides,
  };
}

let activeCg = fakeCg();

const fakeCartograph = {
  init: vi.fn(async () => {
    calls.push('Cartograph.init');
    return activeCg;
  }),
  open: vi.fn(async () => {
    calls.push('Cartograph.open');
    return activeCg;
  }),
  openSync: vi.fn(() => {
    calls.push('Cartograph.openSync');
    return activeCg;
  }),
};

const TEST_OLLAMA_PORT = 11434;
const TEST_HTTP_SCHEME = 'http';
const TEST_OLLAMA_ENDPOINT = `${TEST_HTTP_SCHEME}://localhost:${TEST_OLLAMA_PORT}`;
const TEST_DEFAULT_CONCURRENCY = 4;
const TEST_SIMILAR_EDGES_WRITTEN = 5;
const TEST_SIMILAR_EDGES_PROCESSED = 2;
const TEST_MS_PER_DAY = 86_400_000;
const TEST_PRUNE_STORE_DAYS = 30;
const TEST_PRUNED_SUMMARIES = 2;
const TEST_PRUNED_EMBEDDINGS = 1;
const TEST_SCIP_EXPORT_STATS = { documents: 2, symbols: 3, occurrences: 4, bytes: 99, disambiguated: 1 };
const TEST_SCIP_IMPORT_STATS = {
  documents: 2,
  files: 1,
  nodes: 3,
  edges: 4,
  skippedDocuments: 1,
  unresolvedEdges: 2,
};

function projectHasCartographDb(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.cartograph', 'cartograph.db'));
}

function fakeClack() {
  return {
    intro: (message: string) => calls.push(`intro:${message}`),
    outro: (message: string) => calls.push(`outro:${message}`),
    log: {
      success: (message: string) => calls.push(`clack.success:${message}`),
      info: (message: string) => calls.push(`clack.info:${message}`),
      warn: (message: string) => calls.push(`clack.warn:${message}`),
      error: (message: string) => calls.push(`clack.error:${message}`),
    },
    note: (message: string) => calls.push(`clack.note:${message}`),
  };
}

function fakeCoreDeps(): Pick<
  AdminCommandDeps,
  | 'adminCmd'
  | 'loadCartograph'
  | 'resolveProjectPath'
  | 'chalk'
  | 'colors'
  | 'success'
  | 'error'
  | 'info'
  | 'warn'
  | 'formatNumber'
  | 'formatDuration'
  | 'formatBytes'
  | 'writeStdout'
  | 'writeStderr'
> {
  return {
    adminCmd: new FakeCommand(),
    loadCartograph: vi.fn(async () => ({ default: fakeCartograph })),
    resolveProjectPath: vi.fn((pathArg?: string) => pathArg ?? projectPath),
    chalk: { yellow: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s, dim: (s: string) => s },
    colors: { dim: '', reset: '' },
    success: vi.fn((message: string) => calls.push(`success:${message}`)),
    error: vi.fn((message: string) => calls.push(`error:${message}`)),
    info: vi.fn((message: string) => calls.push(`info:${message}`)),
    warn: vi.fn((message: string) => calls.push(`warn:${message}`)),
    formatNumber: (n: number) => String(n),
    formatDuration: (ms: number) => `${ms}ms`,
    formatBytes: (bytes: number) => `${bytes} B`,
    writeStdout: (message: string) => calls.push(`stdout:${message}`),
    writeStderr: (message: string) => calls.push(`stderr:${message}`),
  };
}

function fakeCommandHelpers(): Pick<
  AdminCommandDeps,
  | 'createVerboseProgress'
  | 'createShimmerProgress'
  | 'attachUnknownActionHandler'
  | 'assignIntArg'
  | 'assignFloatArg'
  | 'awaitSummarisationWithProgress'
  | 'printIndexResult'
  | 'getCartographDir'
  | 'isInitialized'
  | 'parseConcurrency'
> {
  return {
    createVerboseProgress: vi.fn(() => () => undefined),
    attachUnknownActionHandler: vi.fn(() => calls.push('attachUnknownActionHandler')),
    assignIntArg: vi.fn(({ args, key, raw }) => {
      if (raw !== undefined) args[key] = Number(raw);
      return true;
    }),
    assignFloatArg: vi.fn(({ args, key, raw }) => {
      if (raw !== undefined) args[key] = Number(raw);
      return true;
    }),
    awaitSummarisationWithProgress: vi.fn(async () => calls.push('awaitSummarisationWithProgress')),
    printIndexResult: vi.fn(() => calls.push('printIndexResult')),
    getCartographDir: (projectPath: string) => path.join(projectPath, '.cartograph'),
    isInitialized: projectHasCartographDb,
    parseConcurrency: vi.fn((raw?: string) => (raw === undefined ? TEST_DEFAULT_CONCURRENCY : Number(raw))),
    createShimmerProgress: vi.fn(() => ({
      onProgress: vi.fn(),
      stop: vi.fn(async () => calls.push('progress.stop')),
    })),
  };
}

function fakeScipDeps(): Pick<AdminCommandDeps, 'writeScipExport' | 'writeScipImport'> {
  return {
    writeScipExport: vi.fn(() => ({
      outPath: '/repo/index.scip',
      stats: TEST_SCIP_EXPORT_STATS,
    })),
    writeScipImport: vi.fn(() => ({
      stats: TEST_SCIP_IMPORT_STATS,
    })),
  };
}

function fakeProjectLoaders(): Pick<
  AdminCommandDeps,
  'loadClack' | 'loadReadline' | 'loadParseCache' | 'loadDetachedSummarize' | 'loadSimilarEdges'
> {
  return {
    loadClack: vi.fn(async () => fakeClack()),
    loadReadline: vi.fn(async () => ({ createInterface: vi.fn() })),
    loadParseCache: vi.fn(async () => ({ clearParseCache: vi.fn(() => 0) })),
    loadDetachedSummarize: vi.fn(async () => ({
      spawnDetachedSummarize: vi.fn(() => ({ spawned: false, reason: 'not started' })),
    })),
    loadSimilarEdges: vi.fn(async () => ({
      buildSimilarToEdges: vi.fn(async () => ({
        written: TEST_SIMILAR_EDGES_WRITTEN,
        processed: TEST_SIMILAR_EDGES_PROCESSED,
        reason: 'some skipped',
      })),
    })),
  };
}

function fakeStoreLoaders(): Pick<AdminCommandDeps, 'loadSummaryQueries' | 'loadDbIndex'> {
  return {
    loadSummaryQueries: vi.fn(async () => ({
      MS_PER_DAY: TEST_MS_PER_DAY,
      PRUNE_STORE_DEFAULT_DAYS: TEST_PRUNE_STORE_DAYS,
      pruneOrphanStoreRows: vi.fn(() => ({
        summariesPruned: TEST_PRUNED_SUMMARIES,
        embeddingsPruned: TEST_PRUNED_EMBEDDINGS,
      })),
    })),
    loadDbIndex: vi.fn(async () => ({ dbReclaimAfterBulkDelete: vi.fn() })),
  };
}

function fakeInstallLoaders(): Pick<
  AdminCommandDeps,
  'loadInstallModels' | 'loadRecommendedModels' | 'loadRecommendedConfig' | 'loadDoctor'
> {
  return {
    loadInstallModels: vi.fn(async () => ({
      installRecommendedModels: vi.fn(async () => ({
        downloaded: [{ filename: 'embed.gguf', description: 'embedding model' }],
        skipped: [{ filename: 'chat.gguf' }],
      })),
    })),
    loadRecommendedModels: vi.fn(async () => ({
      RECOMMENDED_MODELS: [{ filename: 'full.gguf' }],
      MINIMAL_MODELS: [{ filename: 'minimal.gguf' }],
    })),
    loadRecommendedConfig: vi.fn(async () => ({
      writeRecommendedLlmConfig: vi.fn((opts) => {
        calls.push(`writeRecommendedLlmConfig:${JSON.stringify(opts)}`);
        return {
          configPath: '/repo/.cartograph/config.json',
          backupPath: '/repo/.cartograph/config.json.bak',
          diff: { addedOrUpdated: ['llm.embeddingLlm'] },
        };
      }),
    })),
    loadDoctor: vi.fn(async () => ({
      runDoctor: vi.fn(async (opts) => {
        calls.push(`runDoctor:${JSON.stringify(opts)}`);
        return { overallStatus: 'pass', checks: [] };
      }),
      formatDoctorReport: vi.fn(() => '# Doctor\n\nAll checks passed.'),
      formatDoctorJson: vi.fn(() => '{"overallStatus":"pass"}'),
    })),
  };
}

function fakeLlmSetupLoaders(): Pick<AdminCommandDeps, 'loadLlmSetupPlan' | 'loadHardwareTuning'> {
  return {
    loadLlmSetupPlan: vi.fn(async () => ({
      planLlmSetup: vi.fn(async () => ({
        recommendedPresetId: 'install-ollama',
        detectedBackends: [{ label: 'Ollama', endpoint: TEST_OLLAMA_ENDPOINT, models: ['qwen'] }],
        presets: [{ id: 'install-ollama', summary: 'Ollama local' }],
      })),
      applyLlmSetupChoice: vi.fn(async () => ({
        applied: true,
        preset: 'install-ollama',
        configPath: '/repo/.cartograph/config.json',
        backupPath: '/repo/.cartograph/config.json.bak',
        notes: ['configured'],
        nextSteps: ['ollama serve'],
      })),
      writeLlmTierConcurrencyOverride: vi.fn(async () => ({
        configPath: '/repo/.cartograph/config.json',
        backupPath: '/repo/.cartograph/config.json.bak',
        configKey: 'summarizeLlm',
        previous: 2,
        concurrency: TEST_DEFAULT_CONCURRENCY,
      })),
    })),
    loadHardwareTuning: vi.fn(async () => ({
      describeHardware: vi.fn(() => '8-core test host'),
      recommendedTuning: vi.fn(() => ({
        embed: { cartographConcurrency: 2 },
        chat: { cartographConcurrency: 1 },
        ask: { cartographConcurrency: 1 },
        reranker: { cartographConcurrency: 1 },
      })),
    })),
  };
}

function fakeAdminDeps(): AdminCommandDeps {
  return {
    ...fakeCoreDeps(),
    ...fakeCommandHelpers(),
    ...fakeScipDeps(),
    ...fakeProjectLoaders(),
    ...fakeStoreLoaders(),
    ...fakeInstallLoaders(),
    ...fakeLlmSetupLoaders(),
  };
}

function loadAdminCommandActions(): void {
  actions.clear();
  registerAdminCommands(fakeAdminDeps());
}

describe('admin command action bodies', () => {
  beforeEach(() => {
    calls.length = 0;
    activeCg = fakeCg();
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-admin-cli-'));
    fs.mkdirSync(path.join(projectPath, '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.cartograph', 'cartograph.db'), '');
    vi.clearAllMocks();
    loadAdminCommandActions();
  });

  afterEach(() => {
    if (projectPath && fs.existsSync(projectPath)) fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('initializes and indexes a new project through the init action', async () => {
    fs.rmSync(path.join(projectPath, '.cartograph'), { recursive: true, force: true });

    await actions.get('init [path]')!(projectPath, { index: true, verbose: false });

    expect(calls).toContain('Cartograph.init');
    expect(calls).toContain('progress.stop');
    expect(calls).toContain('printIndexResult');
    expect(calls).toContain('close');
  });

  it('uninitializes with --force without prompting', async () => {
    await actions.get('uninit [path]')!(projectPath, { force: true });

    expect(calls).toContain('Cartograph.openSync');
    expect(calls).toContain('uninitialize');
    expect(calls.join('\n')).toContain('success:Removed Cartograph');
  });

  it('runs quiet index, embed-only, sync, summarize, embed, and classify paths', async () => {
    await actions.get('index [path]')!(projectPath, { quiet: true, force: true, profile: false, parseWorkers: '2' });
    await actions.get('embed-only [path]')!(projectPath, { quiet: true });
    await actions.get('sync [path]')!(projectPath, { quiet: false });
    await actions.get('summarize [path]')!(projectPath, { quiet: true, concurrency: '2', all: true });
    await actions.get('embed [path]')!(projectPath, { quiet: false, concurrency: '3' });
    await actions.get('classify [path]')!(projectPath, { quiet: false, concurrency: '2' });

    const text = calls.join('\n');
    expect(text.match(/Cartograph.open/g)?.length).toBeGreaterThanOrEqual(6);
    expect(text).toContain('awaitSummarisationWithProgress');
    expect(text).toContain('intro:Embedding indexed symbols');
    expect(text).toContain('intro:Classifying symbol roles');
    expect(text).toContain('clack.success:Embedded 2 new vectors in 10ms');
    expect(text).toContain('clack.success:Classified 2 symbols in 10ms');
  });

  it('runs migrate success branches for already-current and migrated schemas', async () => {
    await actions.get('migrate [path]')!(projectPath);
    expect(calls.join('\n')).toContain('Schema already current');

    calls.length = 0;
    let first = true;
    fakeCartograph.open.mockImplementationOnce(async () => {
      if (first) {
        first = false;
        throw new Error('behind');
      }
      return activeCg;
    });

    await actions.get('migrate [path]')!(projectPath);
    expect(calls.join('\n')).toContain('Schema migrated to v99');
  });

  it('runs late admin commands: similarity, prune, SCIP, models, doctor, and LLM setup', async () => {
    let sizeCall = 0;
    activeCg = fakeCg({
      projectRoot: projectPath,
      db: { getSchemaVersion: () => ({ version: 99 }), getSize: () => (sizeCall++ === 0 ? 4096 : 2048) },
    });

    await actions.get('build-similarity-edges [path]')!(projectPath, { k: '5', minScore: '0.8' });
    await actions.get('prune-store [path]')!(projectPath, { maxAgeDays: '7' });
    await actions.get('scip-export [path]')!(projectPath, { out: '/repo/index.scip' });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-admin-scip-'));
    fs.mkdirSync(path.join(dir, '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cartograph', 'cartograph.db'), '');
    const scipPath = path.join(dir, 'index.scip');
    fs.writeFileSync(scipPath, Buffer.from([1, 2, 3]));
    try {
      await actions.get('scip-import [path]')!(dir, { in: scipPath });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    await actions.get('install-models')!({ minimal: true, writeConfig: true, projectPath, dir: '/models' });
    await actions.get('doctor [path]')!(projectPath, { fix: true, skipProjectChecks: true });
    await actions.get('llm-plan [path]')!(projectPath);
    await actions.get('llm-apply')!({ preset: 'install-ollama', projectPath });
    await actions.get('llm-tune [path]')!(projectPath, {});
    await actions.get('llm-tune [path]')!(projectPath, { tier: 'chat', concurrency: '4' });

    const text = calls.join('\n');
    expect(text).toContain('success:Built similarity edges: 5 edges from 2 nodes.');
    expect(text).toContain('success:Pruned 2 summary_store + 1 embedding_store row(s)');
    expect(text).toContain('info:Exported SCIP index');
    expect(text).toContain('info:Imported SCIP index');
    expect(text).toContain('success:Downloaded 1 model');
    expect(text).toContain('success:Updated /repo/.cartograph/config.json');
    expect(text).toContain('"includeAsk":false');
    expect(text).toContain('"includeReranker":false');
    expect(text).toContain('runDoctor:{"projectPath":"');
    expect(text).toContain('"skipProjectChecks":true');
    expect(text).toContain('success:Applied preset install-ollama');
    expect(text).toContain('success:Updated /repo/.cartograph/config.json');
  });

  it('accepts --no-project-checks on admin doctor as an alias', async () => {
    await actions.get('doctor [path]')!(projectPath, { projectChecks: false });

    expect(calls.join('\n')).toContain(
      `runDoctor:{"projectPath":"${projectPath}","fix":false,"skipProjectChecks":true}`,
    );
  });

  it('uses the post-fix doctor status for admin doctor --fix exit handling', async () => {
    const deps = fakeAdminDeps();
    deps.loadDoctor = vi.fn(async () => ({
      runDoctor: vi.fn(async (opts) => {
        calls.push(`runDoctor:${JSON.stringify(opts)}`);
        return { overallStatus: 'fail', afterFix: { overallStatus: 'pass' } };
      }),
      formatDoctorReport: vi.fn(() => '# Doctor\n\nFixed.'),
      formatDoctorJson: vi.fn(() => '{"overallStatus":"fail"}'),
    }));
    actions.clear();
    registerAdminCommands(deps);

    const originalExit = process.exit;
    const exitSpy = vi.fn((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;
    process.exit = exitSpy;
    try {
      await expect(actions.get('doctor [path]')!(projectPath, { fix: true })).resolves.toBeUndefined();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
    }
  });
});
