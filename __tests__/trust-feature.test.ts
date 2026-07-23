import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { buildTrustReport, type SemanticGoldenProbe } from '../src/features/trust/index.js';
import type { LlmSmokeResult } from '../src/features/llm-smoke/index.js';

describe('trust feature runtime', () => {
  let projectPath: string;
  let cg: Cartograph;

  beforeEach(async () => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trust-'));
    cg = await Cartograph.init(projectPath, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: 'summary-model',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: 'embedding-model',
          },
        },
      },
    });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('keeps endpoint execution and semantic usefulness as separate deep checks', async () => {
    let smokeOptions: { projectPath: string; timeoutMs?: number } | undefined;
    let semanticOptions: { model: string; timeoutMs: number } | undefined;
    const smoke: LlmSmokeResult = {
      projectPath,
      overallStatus: 'warn',
      durationMs: 17,
      rows: [
        { tier: 'embedding', status: 'ok', model: 'embedding-model', durationMs: 4, detail: 'vector returned' },
        { tier: 'summarize', status: 'ok', model: 'summary-model', durationMs: 5, detail: 'reply returned' },
        { tier: 'ask', status: 'skip', detail: 'fallback' },
        { tier: 'local', status: 'skip', detail: 'fallback' },
        { tier: 'rerank', status: 'skip', detail: 'not configured' },
      ],
    };
    const semantic: SemanticGoldenProbe = {
      status: 'ok',
      sourceNodeId: 'fn:golden',
      sourceName: 'goldenFunction',
      sourcePath: 'src/golden.ts',
      rank: 1,
      candidatesReturned: 5,
    };

    const report = await buildTrustReport(
      cg,
      { deep: true, timeoutMs: 1_234, isFixturePath: () => false },
      {
        runSmoke: async (options) => {
          smokeOptions = options;
          return smoke;
        },
        runSemanticProbe: async (_cartograph, model, timeoutMs) => {
          semanticOptions = { model, timeoutMs };
          return semantic;
        },
      },
    );

    expect(smokeOptions).toEqual({ projectPath, timeoutMs: 1_234 });
    expect(semanticOptions).toEqual({ model: 'embedding-model', timeoutMs: 1_234 });
    expect(report.checks.find((check) => check.label === 'Live LLM requests')).toMatchObject({ state: 'warn' });
    expect(report.checks.find((check) => check.label === 'Semantic golden probe')).toMatchObject({
      state: 'ok',
      detail: expect.stringContaining('rank 1/5'),
    });
  });
});
