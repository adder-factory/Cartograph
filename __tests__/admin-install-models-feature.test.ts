import { describe, expect, it } from 'vitest';
import {
  buildRecommendedConfigWriteOptions,
  bytesToMiBText,
  formatInstallModelProgress,
  printInstallModelResults,
  registerAdminInstallModelsCommand,
} from '../src/features/admin-install-models/index.js';

describe('admin install-models feature runtime', () => {
  it('formats progress and config write options explicitly', () => {
    expect(bytesToMiBText(1024 * 1024)).toBe('1');
    expect(
      formatInstallModelProgress({
        model: { filename: 'embed.gguf' },
        downloaded: 1024 * 1024,
        total: 2 * 1024 * 1024,
      }),
    ).toBe('\rembed.gguf: 1/2 MB (50%)   ');
    expect(
      buildRecommendedConfigWriteOptions({
        projectRoot: '/repo',
        dir: '/models',
        minimal: true,
      }),
    ).toEqual({
      projectRoot: '/repo',
      dir: '/models',
      includeAsk: false,
      includeReranker: false,
    });
  });

  it('renders downloaded and skipped models through injected output functions', () => {
    const calls: string[] = [];
    printInstallModelResults(
      {
        downloaded: [{ filename: 'embed.gguf', description: 'embedding model' }],
        skipped: [{ filename: 'chat.gguf' }],
      },
      {
        success: (message) => calls.push(`success:${message}`),
        info: (message) => calls.push(`info:${message}`),
      },
    );

    expect(calls).toEqual([
      'success:Downloaded 1 model:',
      'info:  embed.gguf — embedding model',
      'info:Already present (skipped): chat.gguf',
      'info:',
    ]);
  });
});

describe('admin install-models feature CLI', () => {
  it('installs minimal models and writes the matching recommended config', async () => {
    let action:
      | ((options: { dir?: string; minimal?: boolean; writeConfig?: boolean; projectPath?: string }) => Promise<void>)
      | undefined;
    const calls: string[] = [];
    const stderr: string[] = [];
    const minimalModels = [{ filename: 'minimal.gguf' }];
    const fullModels = [{ filename: 'full.gguf' }];

    registerAdminInstallModelsCommand({
      adminCmd: fakeCommand((fn) => {
        action = fn;
      }),
      resolveProjectPath: (pathArg) => pathArg ?? '/repo',
      writeStderr: (message) => stderr.push(message),
      success: (message) => calls.push(`success:${message}`),
      info: (message) => calls.push(`info:${message}`),
      error: (message) => calls.push(`error:${message}`),
      loadInstallModels: async () => ({
        installRecommendedModels: async (opts) => {
          calls.push(`install:${JSON.stringify({ dir: opts.dir, models: opts.models })}`);
          opts.onProgress({
            model: { filename: 'minimal.gguf' },
            downloaded: 1024 * 1024,
            total: 2 * 1024 * 1024,
          });
          return {
            downloaded: [{ filename: 'minimal.gguf', description: 'small model' }],
            skipped: [{ filename: 'embed.gguf' }],
          };
        },
      }),
      loadRecommendedModels: async () => ({
        RECOMMENDED_MODELS: fullModels,
        MINIMAL_MODELS: minimalModels,
      }),
      loadRecommendedConfig: async () => ({
        writeRecommendedLlmConfig: (opts) => {
          calls.push(`config:${JSON.stringify(opts)}`);
          return {
            configPath: '/repo/.cartograph/config.json',
            backupPath: '/repo/.cartograph/config.json.bak',
            diff: { addedOrUpdated: ['llm.embeddingLlm'] },
          };
        },
      }),
    });

    expect(action).toBeDefined();
    await action!({ dir: '/models', minimal: true, writeConfig: true, projectPath: '/repo' });

    expect(stderr.join('')).toContain('minimal.gguf: 1/2 MB (50%)');
    expect(calls).toContain('install:{"dir":"/models","models":[{"filename":"minimal.gguf"}]}');
    expect(calls).toContain(
      'config:{"projectRoot":"/repo","dir":"/models","includeAsk":false,"includeReranker":false}',
    );
    expect(calls).toContain('success:Downloaded 1 model:');
    expect(calls).toContain('success:Updated /repo/.cartograph/config.json');
    expect(calls).toContain('info:Next: cartograph backend start /repo');
  });
});

function fakeCommand(
  setAction: (
    fn: (options: { dir?: string; minimal?: boolean; writeConfig?: boolean; projectPath?: string }) => Promise<void>,
  ) => void,
) {
  return {
    command() {
      return this;
    },
    description() {
      return this;
    },
    option() {
      return this;
    },
    action(
      fn: (options: { dir?: string; minimal?: boolean; writeConfig?: boolean; projectPath?: string }) => Promise<void>,
    ) {
      setAction(fn);
      return this;
    },
  };
}
