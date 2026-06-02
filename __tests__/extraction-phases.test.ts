import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  eoAbortIndexResult,
  eoApplyExtractionEnvFromConfig,
  eoFinalIndexResult,
  eoReadFileWithValidation,
  eoRetryFreshHeap,
  eoRetryStripped,
  isMinifiedJsFamily,
  type EoIndexCounters,
} from '../src/extraction/extraction-phases.js';
import type { ExtractionOrchestratorState } from '../src/extraction/index.js';
import type { ExtractionError } from '../src/types.js';

const ORIGINAL_LARGE = process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
const ORIGINAL_PROMOTION = process.env['CARTOGRAPH_NESTED_PROMOTION_THRESHOLD'];

afterEach(() => {
  if (ORIGINAL_LARGE === undefined) {
    delete process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
  } else {
    process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = ORIGINAL_LARGE;
  }
  if (ORIGINAL_PROMOTION === undefined) {
    delete process.env['CARTOGRAPH_NESTED_PROMOTION_THRESHOLD'];
  } else {
    process.env['CARTOGRAPH_NESTED_PROMOTION_THRESHOLD'] = ORIGINAL_PROMOTION;
  }
});

function state(rootDir: string, config: Record<string, unknown> = {}): ExtractionOrchestratorState {
  return { rootDir, config } as unknown as ExtractionOrchestratorState;
}

describe('extraction phase helpers', () => {
  it('builds an abort result that preserves counters and prepends the abort error', () => {
    const errors: ExtractionError[] = [{ message: 'scan failed', severity: 'error', filePath: 'src/a.ts' }];
    const result = eoAbortIndexResult(Date.now(), errors, {
      filesIndexed: 2,
      filesSkipped: 3,
      filesErrored: 4,
      totalNodes: 5,
      totalEdges: 6,
    });

    expect(result.success).toBe(false);
    expect(result).toMatchObject({
      filesIndexed: 2,
      filesSkipped: 3,
      filesErrored: 4,
      nodesCreated: 5,
      edgesCreated: 6,
    });
    expect(result.errors.map((e) => e.message)).toEqual(['Aborted', 'scan failed']);
  });

  it('marks final index success when only warnings were collected', () => {
    const counters: EoIndexCounters = {
      filesIndexed: 0,
      filesSkipped: 1,
      filesErrored: 0,
      totalNodes: 0,
      totalEdges: 0,
      processed: 1,
    };
    const result = eoFinalIndexResult({
      counters,
      errors: [{ message: 'skipped generated file', severity: 'warning' }],
      totalMs: 10,
      scanMs: 2,
      parseStoreMs: 7,
      retryMs: 1,
    });

    expect(result.success).toBe(true);
    expect(result.profile).toEqual({ scanMs: 2, parseStoreMs: 7, retryMs: 1, extractionMs: 10 });
  });

  it('exports configured extraction thresholds for in-process and worker parsing', () => {
    eoApplyExtractionEnvFromConfig(
      state('/tmp/project', { largeFunctionThreshold: Number.POSITIVE_INFINITY, nestedPromotionThreshold: 12 }),
    );
    expect(process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD']).toBe('Infinity');
    expect(process.env['CARTOGRAPH_NESTED_PROMOTION_THRESHOLD']).toBe('12');

    eoApplyExtractionEnvFromConfig(state('/tmp/project'));
    expect(process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD']).toBe('500');
    expect(process.env['CARTOGRAPH_NESTED_PROMOTION_THRESHOLD']).toBe('5');
  });

  it('reads files only after root-relative path validation succeeds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extraction-phases-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'safe.ts'), 'export const safe = true;\n');

      const ok = await eoReadFileWithValidation(state(root), 'src/safe.ts');
      expect(ok.error).toBeNull();
      expect(ok.content).toContain('safe');
      expect(ok.stats?.isFile()).toBe(true);

      const blocked = await eoReadFileWithValidation(state(root), '../outside.ts');
      expect(blocked.content).toBeNull();
      expect(blocked.stats).toBeNull();
      expect(blocked.error?.message).toContain('Path traversal blocked');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects minified JavaScript-family content by average line length only for JS-family languages', () => {
    const minified = `const a='${'x'.repeat(260)}';`;
    const formatted = ['function demo() {', '  return 1;', '}'].join('\n');

    expect(isMinifiedJsFamily('javascript', minified)).toBe(true);
    expect(isMinifiedJsFamily('typescript', minified)).toBe(true);
    expect(isMinifiedJsFamily('tsx', minified)).toBe(true);
    expect(isMinifiedJsFamily('javascript', formatted)).toBe(false);
    expect(isMinifiedJsFamily('python', minified)).toBe(false);
    expect(isMinifiedJsFamily('javascript', '')).toBe(false);
  });

  it('fresh-heap retry skips blocked/missing paths and returns parse failures for stripped retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extraction-retry-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src/fails.ts'), 'export const value = 1;\n');
      const errors: ExtractionError[] = [
        { message: 'blocked', severity: 'error', code: 'parse_error', filePath: '../blocked.ts' },
        { message: 'missing', severity: 'error', code: 'parse_error', filePath: 'src/missing.ts' },
        { message: 'fails', severity: 'error', code: 'parse_error', filePath: 'src/fails.ts' },
      ];
      let recycled = 0;

      const stillFailing = await eoRetryFreshHeap(state(root), {
        candidates: errors,
        errors,
        counters: { filesIndexed: 0, filesErrored: 3, totalNodes: 0, totalEdges: 0 },
        recycleWorker: async () => {
          recycled += 1;
        },
        requestParse: async () => {
          throw new Error('still broken');
        },
        signal: undefined,
        log: () => {},
      });

      expect(recycled).toBe(3);
      expect(stillFailing.map((error) => error.filePath)).toEqual(['src/fails.ts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stripped retry stops on abort and tolerates blocked, missing, and parse-failing files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extraction-stripped-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src/fails.ts'), '// comment\nexport const value = 1;\n');
      const candidates: ExtractionError[] = [
        { message: 'blocked', severity: 'error', code: 'parse_error', filePath: '../blocked.ts' },
        { message: 'missing', severity: 'error', code: 'parse_error', filePath: 'src/missing.ts' },
        { message: 'fails', severity: 'error', code: 'parse_error', filePath: 'src/fails.ts' },
      ];
      let parsed = 0;

      await eoRetryStripped(state(root), {
        candidates,
        errors: [...candidates],
        counters: { filesIndexed: 0, filesErrored: 3, totalNodes: 0, totalEdges: 0 },
        recycleWorker: async () => {},
        requestParse: async () => {
          parsed += 1;
          throw new Error('still broken');
        },
        signal: undefined,
        log: () => {},
      });

      expect(parsed).toBe(1);

      const controller = new AbortController();
      controller.abort();
      await eoRetryStripped(state(root), {
        candidates,
        errors: [...candidates],
        counters: { filesIndexed: 0, filesErrored: 3, totalNodes: 0, totalEdges: 0 },
        recycleWorker: async () => {
          throw new Error('should not recycle after abort');
        },
        requestParse: async () => {
          throw new Error('should not parse after abort');
        },
        signal: controller.signal,
        log: () => {},
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
