import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeLlmConfig } from '../src/installer/llm-setup-cli.js';
import type { CartographConfig } from '../src/types.js';

type LlmConfig = NonNullable<CartographConfig['llm']>;

function configuredLlm(): LlmConfig {
  const endpoint = `${'http'}://${'localhost'}:${11434}`;
  return {
    summarizeLlm: {
      provider: 'openai-compat',
      endpoint,
      model: 'qwen2.5-coder:3b',
    },
    embeddingLlm: {
      provider: 'openai-compat',
      endpoint,
      model: 'nomic-embed-text',
    },
  };
}

describe('writeLlmConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-llm-setup-cli-'));
    fs.mkdirSync(path.join(tempDir, '.cartograph'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects an existing config root that is an array instead of reporting a successful write', () => {
    const configPath = path.join(tempDir, '.cartograph', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify([{ stale: true }]), 'utf-8');

    expect(() => writeLlmConfig(tempDir, configuredLlm())).toThrow('config.json root must be an object');

    const written: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written).toEqual([{ stale: true }]);
  });
});
