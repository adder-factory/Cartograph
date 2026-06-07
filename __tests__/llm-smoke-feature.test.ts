import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  formatLlmSmokeJson,
  formatLlmSmokeReport,
  runLlmSmoke,
  type LlmSmokeResult,
} from '../src/features/llm-smoke/runtime.js';

describe('llm smoke feature runtime', () => {
  it('reports missing configured tiers without contacting a backend', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-llm-smoke-'));
    try {
      const result = await runLlmSmoke({ projectPath, timeoutMs: 5 });

      expect(result.overallStatus).toBe('fail');
      expect(result.rows.map((row) => [row.tier, row.status])).toEqual([
        ['embedding', 'fail'],
        ['summarize', 'fail'],
        ['ask', 'skip'],
        ['local', 'skip'],
        ['rerank', 'skip'],
      ]);

      const report = formatLlmSmokeReport(result);
      expect(report).toContain('embeddingLlm is not configured');
      expect(report).toContain('summarizeLlm is not configured');
      expect(report).toContain('askLlm is not configured; ask calls fall back to summarizeLlm');
      expect(report).toContain('localLlm is not configured; local chat calls fall back to summarizeLlm');
      expect(report).toContain('One or more required/configured LLM tiers failed');
    } finally {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it('formats successful rows with provider location and JSON output', () => {
    const result: LlmSmokeResult = {
      projectPath: '/repo',
      overallStatus: 'ok',
      durationMs: 12,
      rows: [
        {
          tier: 'summarize',
          status: 'ok',
          provider: 'openai-compat',
          endpoint: 'http://localhost:8081',
          model: 'qwen',
          durationMs: 7,
          detail: 'ok',
        },
      ],
    };

    expect(formatLlmSmokeReport(result)).toContain('openai-compat / http://localhost:8081 / qwen');
    expect(JSON.parse(formatLlmSmokeJson(result))).toMatchObject({ projectPath: '/repo', overallStatus: 'ok' });
  });
});
