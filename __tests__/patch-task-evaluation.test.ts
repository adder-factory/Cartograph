import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { PATCH_FIXTURE_FILES } from './evaluation/fixtures/patch-corpus.js';
import { patchFixtureCases } from './evaluation/cases-patch-fixture.js';
import { runPatchTaskEvaluation } from './evaluation/patch-evaluator.js';
import { scorePatchTaskObservation, summarizePatchMode } from './evaluation/patch-scoring.js';
import { comparePatchReports } from './evaluation/patch-compare.js';
import { PatchTaskEvalReportSchema } from './evaluation/patch-types.js';

describe('patch-task evaluation scoring', () => {
  it('measures edit-site hit@k, MRR, precision, test recall, abstention, latency, and payload', () => {
    const result = scorePatchTaskObservation(
      {
        id: 'watcher-fix',
        task: 'Fix watcher event gating',
        expectedSymbols: ['watcherHandleFileEvent', 'FileWatcher'],
        expectedEditFiles: ['src/watcher.ts'],
        expectedTestFiles: ['tests/watcher.test.ts'],
      },
      'deterministic',
      {
        rankedSymbols: [
          { name: 'WatcherOptions', filePath: 'src/watcher.ts' },
          { name: 'watcherHandleFileEvent', filePath: 'src/watcher.ts' },
          { name: 'unrelated', filePath: 'src/unrelated.ts' },
        ],
        predictedEditFiles: ['src/watcher.ts', 'src/unrelated.ts'],
        selectedTestFiles: ['tests/watcher.test.ts'],
        abstained: false,
        latencyMs: 12,
        payloadBytes: 400,
      },
      5,
    );

    expect(result).toMatchObject({
      hitAtK: 1,
      mrr: 0.5,
      editSitePrecision: 0.5,
      editSiteRecall: 1,
      testSelectionRecall: 1,
      abstentionCorrect: true,
      latencyMs: 12,
      payloadBytes: 400,
      estimatedTokens: 100,
      pass: true,
    });
  });

  it('scores an explicit abstention and excludes environmental hybrid skips from mode means', () => {
    const abstained = scorePatchTaskObservation(
      {
        id: 'unknown-feature',
        task: 'Change a subsystem absent from this repository',
        expectedSymbols: [],
        expectedEditFiles: [],
        expectedTestFiles: [],
        shouldAbstain: true,
      },
      'deterministic',
      {
        rankedSymbols: [],
        predictedEditFiles: [],
        selectedTestFiles: [],
        abstained: true,
        latencyMs: 2,
        payloadBytes: 20,
      },
      5,
    );
    const skipped = { ...abstained, caseId: 'hybrid-skip', mode: 'hybrid' as const, skipped: 'no-embeddings' as const };

    expect(abstained).toMatchObject({
      hitAtK: 1,
      editSitePrecision: 1,
      editSiteRecall: 1,
      testSelectionRecall: null,
      abstentionCorrect: true,
      pass: true,
    });
    expect(summarizePatchMode('hybrid', [skipped])).toMatchObject({ scored: 0, skipped: 1 });
  });

  it('rejects comparisons that change the evaluation corpus or omit the required mode', () => {
    const baselinePath = path.join(import.meta.dirname, 'evaluation', 'baseline-patch-deterministic.json');
    const baseline = PatchTaskEvalReportSchema.parse(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
    const mismatched = {
      ...baseline,
      topK: baseline.topK - 1,
      caseCount: baseline.caseCount - 1,
      caseIds: baseline.caseIds.slice(1),
      modes: [],
    };

    expect(comparePatchReports(baseline, mismatched)).toEqual({
      withinBudget: false,
      regressions: [
        'evaluation contract: topK changed (5 → 4)',
        'evaluation contract: caseCount changed (5 → 4)',
        'evaluation contract: case identities changed',
        'evaluation contract: required mode deterministic is missing',
      ],
    });
  });

  it('rejects a candidate that scores fewer cases than the baseline', () => {
    const baselinePath = path.join(import.meta.dirname, 'evaluation', 'baseline-patch-deterministic.json');
    const baseline = PatchTaskEvalReportSchema.parse(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
    const deterministic = baseline.modes[0]!;
    const fewerScored = {
      ...baseline,
      modes: [{ ...deterministic, scored: deterministic.scored - 1, skipped: deterministic.skipped + 1 }],
    };

    expect(comparePatchReports(baseline, fewerScored)).toEqual({
      withinBudget: false,
      regressions: ['evaluation contract: deterministic scored count changed (5 → 4)'],
    });
  });

  it('rejects changed task expectations even when case IDs stay the same', () => {
    const baselinePath = path.join(import.meta.dirname, 'evaluation', 'baseline-patch-deterministic.json');
    const baseline = PatchTaskEvalReportSchema.parse(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
    const changedCorpus = { ...baseline, corpusFingerprint: '0'.repeat(64) };

    expect(comparePatchReports(baseline, changedCorpus)).toEqual({
      withinBudget: false,
      regressions: ['evaluation contract: case definitions changed'],
    });
  });
});

describe('patch-task retrieval evaluation', () => {
  let projectRoot: string;
  let cg: Cartograph;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-patch-eval-'));
    for (const [relativePath, content] of Object.entries(PATCH_FIXTURE_FILES)) {
      const absolutePath = path.join(projectRoot, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content);
    }
    cg = await Cartograph.init(projectRoot, { index: true, config: { llm: { endpoint: '' } } });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('always runs deterministic and auto modes while explicitly skipping unavailable hybrid retrieval', async () => {
    const report = await runPatchTaskEvaluation(cg, patchFixtureCases, {
      modes: ['deterministic', 'auto', 'hybrid'],
      topK: 5,
    });

    const deterministic = report.modes.find((mode) => mode.mode === 'deterministic');
    const automatic = report.modes.find((mode) => mode.mode === 'auto');
    const hybrid = report.modes.find((mode) => mode.mode === 'hybrid');
    expect(deterministic).toMatchObject({ scored: patchFixtureCases.length, skipped: 0 });
    expect(automatic).toMatchObject({ scored: patchFixtureCases.length, skipped: 0 });
    expect(hybrid).toMatchObject({ scored: 0, skipped: patchFixtureCases.length });
    expect(report.results.filter((result) => result.mode === 'deterministic').every((result) => result.pass)).toBe(
      true,
    );
    expect(report.results.filter((result) => result.mode === 'hybrid').every((result) => result.skipped)).toBe(true);

    const baselinePath = path.join(import.meta.dirname, 'evaluation', 'baseline-patch-deterministic.json');
    const baseline = PatchTaskEvalReportSchema.parse(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
    expect(comparePatchReports(baseline, report)).toEqual({ withinBudget: true, regressions: [] });
  });
});
