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
import { registerLlmSmokeCommand } from '../src/features/llm-smoke/index.js';
import type { CliOptionCommand } from '../src/features/shared/cli-command.js';

interface LlmSmokeCliOptions {
  readonly timeoutMs?: string;
  readonly json?: boolean;
}

type LlmSmokeCliAction = (pathArg: string | undefined, options: LlmSmokeCliOptions) => Promise<void>;

function isLlmSmokeCliAction(value: unknown): value is LlmSmokeCliAction {
  return typeof value === 'function';
}

function captureLlmSmokeAction(): { command: CliOptionCommand; action: () => LlmSmokeCliAction } {
  let registeredAction: unknown;
  const command: CliOptionCommand = {
    command() {
      return command;
    },
    description() {
      return command;
    },
    option() {
      return command;
    },
    action<Args extends unknown[]>(fn: (...args: Args) => unknown) {
      registeredAction = fn;
      return command;
    },
  };

  return {
    command,
    action() {
      if (!isLlmSmokeCliAction(registeredAction)) throw new Error('llm smoke CLI action was not registered');
      return registeredAction;
    },
  };
}

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

describe('llm smoke feature CLI', () => {
  it('sets exitCode instead of calling process.exit when smoke fails', async () => {
    const failingResult: LlmSmokeResult = {
      projectPath: '/repo',
      overallStatus: 'fail',
      durationMs: 4,
      rows: [{ tier: 'embedding', status: 'fail', detail: 'embeddingLlm is not configured.' }],
    };
    const { command, action } = captureLlmSmokeAction();
    const stdout: string[] = [];
    const errors: string[] = [];
    let smokeOptions: unknown;
    let exitCalled = false;
    const originalExit = process.exit;
    process.exitCode = 0;
    process.exit = (code?: string | number | null | undefined): never => {
      exitCalled = true;
      throw new Error(`unexpected process.exit(${String(code)})`);
    };

    try {
      registerLlmSmokeCommand({
        llmCmd: command,
        resolveProjectPath: (pathArg) => pathArg ?? '/resolved',
        error: (message) => errors.push(message),
        writeStdout: (message = '') => stdout.push(message),
        loadLlmSmoke: async () => ({
          runLlmSmoke: async (options) => {
            smokeOptions = options;
            return failingResult;
          },
          formatLlmSmokeReport: () => 'smoke report',
          formatLlmSmokeJson: () => '{"overallStatus":"fail"}',
        }),
      });

      await expect(action()('/repo', { timeoutMs: '123' })).resolves.toBeUndefined();

      expect(exitCalled).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(smokeOptions).toEqual({ projectPath: '/repo', timeoutMs: 123 });
      expect(stdout).toEqual(['smoke report']);
      expect(errors).toEqual([]);
    } finally {
      process.exit = originalExit;
      process.exitCode = 0;
    }
  });
});
