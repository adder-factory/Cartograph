import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const actions = new Map<string, (...args: any[]) => unknown>();
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

  action(fn: (...args: any[]) => unknown): this {
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

vi.mock('../src/bin/_cli-core.js', () => ({
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
}));

vi.mock('../src/ui/shimmer-progress.js', () => ({
  createShimmerProgress: vi.fn(() => ({
    onProgress: vi.fn(),
    stop: vi.fn(async () => calls.push('progress.stop')),
  })),
}));

vi.mock('../src/llm/concurrency.js', () => ({
  parseConcurrency: vi.fn((raw?: string) => (raw === undefined ? 4 : Number(raw))),
}));

vi.mock('../src/embeddings/similar-edges.js', () => ({
  buildSimilarToEdges: vi.fn(async () => ({ written: 5, processed: 2, reason: 'some skipped' })),
}));

vi.mock('../src/db/queries-summaries.js', () => ({
  MS_PER_DAY: 24 * 60 * 60 * 1000,
  PRUNE_STORE_DEFAULT_DAYS: 30,
  pruneOrphanStoreRows: vi.fn(() => ({
    summariesPruned: 2,
    embeddingsPruned: 1,
  })),
}));

vi.mock('../src/db/index.js', () => ({
  dbReclaimAfterBulkDelete: vi.fn(),
}));

vi.mock('../src/scip/index.js', () => ({
  writeScipExport: vi.fn(() => ({
    outPath: '/repo/index.scip',
    stats: { documents: 2, symbols: 3, occurrences: 4, bytes: 99, disambiguated: 1 },
  })),
  writeScipImport: vi.fn(() => ({
    stats: { documents: 2, files: 1, nodes: 3, edges: 4, skippedDocuments: 1, unresolvedEdges: 2 },
  })),
}));

vi.mock('../src/installer/install-models.js', () => ({
  installRecommendedModels: vi.fn(async () => ({
    downloaded: [{ filename: 'embed.gguf', description: 'embedding model' }],
    skipped: [{ filename: 'chat.gguf' }],
  })),
}));

vi.mock('../src/llm/recommended-models.js', () => ({
  RECOMMENDED_MODELS: [{ filename: 'full.gguf' }],
  MINIMAL_MODELS: [{ filename: 'minimal.gguf' }],
}));

vi.mock('../src/installer/recommended-config.js', () => ({
  writeRecommendedLlmConfig: vi.fn(() => ({
    configPath: '/repo/.cartograph/config.json',
    backupPath: '/repo/.cartograph/config.json.bak',
    diff: { addedOrUpdated: ['llm.embeddingLlm'] },
  })),
}));

vi.mock('../src/installer/doctor.js', () => ({
  runDoctor: vi.fn(async () => ({ overallStatus: 'pass', checks: [] })),
  formatDoctorReport: vi.fn(() => '# Doctor\n\nAll checks passed.'),
}));

vi.mock('../src/installer/llm-setup-plan.js', () => ({
  planLlmSetup: vi.fn(async () => ({
    recommendedPresetId: 'install-ollama',
    detectedBackends: [{ label: 'Ollama', endpoint: 'http://localhost:11434', models: ['qwen'] }],
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
    concurrency: 4,
  })),
}));

vi.mock('../src/installer/hardware-tuning.js', () => ({
  describeHardware: vi.fn(() => '8-core test host'),
  recommendedTuning: vi.fn(() => ({
    embed: { cartographConcurrency: 2 },
    chat: { cartographConcurrency: 1 },
    ask: { cartographConcurrency: 1 },
    reranker: { cartographConcurrency: 1 },
  })),
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn((message: string) => calls.push(`intro:${message}`)),
  outro: vi.fn((message: string) => calls.push(`outro:${message}`)),
  log: {
    success: vi.fn((message: string) => calls.push(`clack.success:${message}`)),
    info: vi.fn((message: string) => calls.push(`clack.info:${message}`)),
    warn: vi.fn((message: string) => calls.push(`clack.warn:${message}`)),
    error: vi.fn((message: string) => calls.push(`clack.error:${message}`)),
  },
  note: vi.fn((message: string) => calls.push(`clack.note:${message}`)),
}));

await import('../src/bin/commands/admin.js');

describe('admin command action bodies', () => {
  beforeEach(() => {
    calls.length = 0;
    activeCg = fakeCg();
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-admin-cli-'));
    fs.mkdirSync(path.join(projectPath, '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.cartograph', 'cartograph.db'), '');
    vi.clearAllMocks();
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
    await actions.get('llm-plan')!();
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
    expect(text).toContain('success:Applied preset install-ollama');
    expect(text).toContain('success:Updated /repo/.cartograph/config.json');
  });
});
