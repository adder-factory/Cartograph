import { describe, expect, it } from 'vitest';
import { buildStatusRollupConfig, createStatusPrinter } from '../src/features/status/runtime.js';
import {
  parseInlineTopN,
  resolveStatusRollups,
  STATUS_MAX_INLINE_TOP_N,
} from '../src/features/status/rollup-options.js';

const FAKE_FILE_COUNT = 3;
const FAKE_NODE_COUNT = 8;
const FAKE_EDGE_COUNT = 5;
const FAKE_DB_SIZE_BYTES = 4096;

describe('status feature runtime', () => {
  it('prints uninitialized status and initialized JSON status with rollup lines', () => {
    const printer = createTestStatusPrinter();

    const uninitialized = stripAnsi(captureOutput(() => printer.printUninitializedStatus('/repo', {})));
    expect(uninitialized).toContain('Cartograph Status');
    expect(uninitialized).toContain('Project: /repo');
    expect(uninitialized).toContain('Not initialized');

    const json = stripAnsi(
      captureOutput(() =>
        printer.printStatusJson({
          cg: fakeCg(),
          projectPath: '/repo',
          stats: fakeStats(),
          changes: { added: ['src/new.ts'], removed: [], healOnly: [] },
          healOnly: [],
          realModifiedCount: 1,
          hnswAvailable: true,
          rollups: fakeRollups(),
        }),
      ),
    );
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      initialized: true,
      projectPath: '/repo',
      fileCount: 3,
      pendingChanges: { added: 1, modified: 1, removed: 0, healFlagged: 0 },
    });
    expect(parsed.rollups).toEqual(expect.arrayContaining(['ready', 'hotspots:2', 'biomarkers:1']));
  });

  it('prints status sections, pending change states, and rollups', () => {
    const printer = createTestStatusPrinter();
    const out = stripAnsi(
      captureOutput(() => {
        printer.printStatusIndexStats(fakeStats(), fakeCg(), false);
        printer.printCountBreakdown('Nodes by Kind:', { function: 2, class: 1, file: 0 });
        printer.printPendingChanges({ added: ['src/a.ts'], removed: ['src/old.ts'] }, 2, ['src/heal.ts']);
        printer.printStatusRollups(fakeCg(), fakeRollups());
      }),
    );

    expect(out).toContain('Index Statistics');
    expect(out).toContain('Files:     3');
    expect(out).toContain('Nodes by Kind:');
    expect(out).toContain('Pending Changes');
    expect(out).toContain('Heal-flagged');
    expect(out).toContain('Readiness');
    expect(out).toContain('hotspots:2');
  });

  it('prints PostgreSQL backend status without sqlite-vec remediation', () => {
    const printer = createTestStatusPrinter();
    const out = stripAnsi(captureOutput(() => printer.printStatusIndexStats(fakeStats(), fakeCg('postgres'), false)));

    expect(out).toContain('Backend:   postgres');
    expect(out).toContain('PostgreSQL storage active');
    expect(out).not.toContain('sqlite-vec did not load');
  });

  it('normalizes rollup options and renders no-LLM status without provider work', async () => {
    const verboseRollups = await buildStatusRollupConfig({
      verbose: true,
      topHotspots: '0',
      topBiomarkers: '0',
      summaryBreakdown: false,
    });
    expect(verboseRollups.topHotspots).toBe(5);
    expect(verboseRollups.topBiomarkers).toBe(5);
    expect(verboseRollups.summaryBreakdown).toBe(false);

    const cappedRollups = await buildStatusRollupConfig({ topHotspots: '999', topBiomarkers: '-2' });
    expect(cappedRollups.topHotspots).toBe(30);
    expect(cappedRollups.topBiomarkers).toBe(0);

    const printer = createTestStatusPrinter();
    const out = stripAnsi(
      await captureAsyncOutput(() =>
        printer.printLlmStatus(
          {
            llm: {
              config: {
                getEffectiveLlmConfig: async () => null,
              },
            },
          },
          '/repo',
        ),
      ),
    );
    expect(out).toContain('LLM Enrichment');
    expect(out).toContain('No LLM configured');
  });

  it('owns inline rollup option normalization at the feature boundary', () => {
    expect([undefined, null, -1, 0, Number.NaN, 'nope'].map(parseInlineTopN)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(parseInlineTopN('1.9')).toBe(1);
    expect(parseInlineTopN(999)).toBe(STATUS_MAX_INLINE_TOP_N);
    expect(resolveStatusRollups({ verbose: true, topHotspots: 1, topBiomarkers: 0 })).toEqual({
      topHotspots: 1,
      topBiomarkers: 5,
      summaryBreakdown: true,
    });
  });
});

function createTestStatusPrinter() {
  return createStatusPrinter({
    writeLine: (message = '') => process.stdout.write(`${message}\n`),
    success: (message) => process.stdout.write(`${message}\n`),
    info: (message) => process.stdout.write(`${message}\n`),
    warn: (message) => process.stdout.write(`${message}\n`),
    formatNumber: (value) => value.toLocaleString(),
    style: {
      bold: (text) => text,
      cyan: (text) => text,
      dim: (text) => text,
      magenta: (text) => text,
      yellow: (text) => text,
    },
  });
}

function captureOutput(fn: () => unknown): string {
  const originalWrite = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('\n');
}

async function captureAsyncOutput(fn: () => Promise<unknown>): Promise<string> {
  const originalWrite = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('\n');
}

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(27);
  return text.replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

function fakeStats() {
  return {
    fileCount: FAKE_FILE_COUNT,
    nodeCount: FAKE_NODE_COUNT,
    edgeCount: FAKE_EDGE_COUNT,
    dbSizeBytes: FAKE_DB_SIZE_BYTES,
    nodesByKind: { function: 2, class: 1 },
    filesByLanguage: { typescript: 3 },
  };
}

function fakeCg(backend = 'bun-sqlite') {
  return {
    db: {
      getBackend: () => backend,
      hasVecExtension: () => backend !== 'postgres',
    },
    queries: {},
  };
}

function fakeRollups() {
  return {
    topHotspots: 2,
    topBiomarkers: 1,
    summaryBreakdown: true,
    appendFeatureReadiness: (lines: string[]) => lines.push('### Readiness', 'ready'),
    appendInlineHotspots: (lines: string[], _cg: unknown, topN: number) => lines.push(`hotspots:${topN}`),
    appendInlineBiomarkers: (lines: string[], _cg: unknown, topN: number) => lines.push(`biomarkers:${topN}`),
  };
}
