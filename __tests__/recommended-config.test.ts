/**
 * Tests for the recommended-config writer (FRICTION-11).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  buildRecommendedLlmConfig,
  mergeRecommendedLlmConfig,
  writeRecommendedLlmConfig,
} from '../src/installer/recommended-config.js';
import { _resetLegacyLlmMigrationForTest, loadConfig } from '../src/config.js';
import { DEFAULT_CONFIG } from '../src/types.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-recommended-cfg-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('mergeRecommendedLlmConfig (FRICTION-11)', () => {
  it('overwrites recommended slots and preserves non-slot llm keys', () => {
    const current = {
      version: 1,
      include: ['**/*.ts'],
      llm: {
        enabled: true,
      },
    };
    const recommended = buildRecommendedLlmConfig({ dir: '/tmp/models-test' });

    const { nextConfig, diff } = mergeRecommendedLlmConfig(current, recommended);

    const llm = nextConfig['llm'] as Record<string, unknown>;
    expect(llm['enabled']).toBe(true); // preserved
    expect(diff.addedOrUpdated).toEqual(
      expect.arrayContaining(['summarizeLlm', 'localLlm', 'askLlm', 'embeddingLlm', 'rerankerLlm']),
    );
  });

  it('overwrites a prior summarizeLlm with the openai-compat recommended block', () => {
    const current = {
      llm: {
        summarizeLlm: {
          provider: 'claude-bridge',
          model: 'claude-haiku-4-5',
        },
      },
    };
    const recommended = buildRecommendedLlmConfig({ dir: '/tmp/models-test' });

    const { nextConfig } = mergeRecommendedLlmConfig(current, recommended);
    const llm = nextConfig['llm'] as Record<string, unknown>;
    const sum = llm['summarizeLlm'] as Record<string, unknown>;
    expect(sum['provider']).toBe('openai-compat');
    expect(sum['endpoint']).toBe('http://localhost:8081');
  });

  it('preserves non-llm top-level fields', () => {
    const current = {
      version: 1,
      include: ['**/*.ts'],
      exclude: ['**/node_modules/**'],
      maxFileSize: 12345,
      llm: { qaLlm: { provider: 'openai-compat' } },
    };
    const recommended = buildRecommendedLlmConfig({ dir: '/tmp/models-test' });
    const { nextConfig } = mergeRecommendedLlmConfig(current, recommended);

    expect(nextConfig['version']).toBe(1);
    expect(nextConfig['include']).toEqual(['**/*.ts']);
    expect(nextConfig['exclude']).toEqual(['**/node_modules/**']);
    expect(nextConfig['maxFileSize']).toBe(12345);
  });

  it('handles a config with no prior llm block', () => {
    const current = { version: 1, include: ['**/*.ts'] };
    const recommended = buildRecommendedLlmConfig({ dir: '/tmp/models-test' });
    const { nextConfig, diff } = mergeRecommendedLlmConfig(current, recommended);
    const llm = nextConfig['llm'] as Record<string, unknown>;
    expect(llm['summarizeLlm']).toBeDefined();
  });

  it('defaults every tier to openai-compat (one llama-server per port) 2026-05-24c step 4c', () => {
    // Migration step 4c: in-process pathway deleted. All four tiers
    // (summarize / local / ask / embedding) and the optional reranker
    // write provider: 'openai-compat' pointing at distinct ports
    // (8080 embed / 8081 summarize+local / 8082 ask / 8083 reranker)
    // so users run one llama-server per port, one model per process.
    const recommended = buildRecommendedLlmConfig({ dir: '/tmp/models-test' });

    const embed = recommended.embeddingLlm as { provider: string; endpoint?: string; model: string };
    expect(embed.provider).toBe('openai-compat');
    expect(embed.endpoint).toBe('http://localhost:8080');
    expect(embed.model).toContain('/tmp/models-test');
    expect(embed.model).toContain('jina-embeddings-v2-base-code');

    const summarize = recommended.summarizeLlm as { provider: string; endpoint?: string; model: string };
    expect(summarize.provider).toBe('openai-compat');
    expect(summarize.endpoint).toBe('http://localhost:8081');

    const ask = recommended.askLlm as { provider: string; endpoint?: string; model: string };
    expect(ask.provider).toBe('openai-compat');
    expect(ask.endpoint).toBe('http://localhost:8082');

    const reranker = recommended.rerankerLlm as { provider: string; endpoint?: string; model?: string };
    expect(reranker.provider).toBe('openai-compat');
    expect(reranker.endpoint).toBe('http://localhost:8083');
  });

  it('omits the reranker block when includeReranker:false', () => {
    const recommended = buildRecommendedLlmConfig({
      dir: '/tmp/models-test',
      includeReranker: false,
    });
    expect(recommended.rerankerLlm).toBeUndefined();
  });
});

describe('writeRecommendedLlmConfig (FRICTION-11)', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = createTempDir();
    fs.mkdirSync(path.join(tempDir, '.cartograph'), { recursive: true });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it('writes config + .bak.<ts> backup, applies the merge, and reports the diff', () => {
    const configPath = path.join(tempDir, '.cartograph', 'config.json');
    const priorConfig = {
      version: 1,
      include: ['**/*.ts'],
      exclude: ['**/node_modules/**'],
      maxFileSize: 5000000,
      llm: {
        summarizeLlm: {
          provider: 'openai-compat',
          model: 'qwen3-coder',
        },
        enabled: true,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(priorConfig, null, 2), 'utf-8');

    const modelsDir = path.join(tempDir, 'models');
    const result = writeRecommendedLlmConfig({ projectRoot: tempDir, dir: modelsDir });

    expect(result.configPath).toBe(configPath);
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(result.backupPath!).toMatch(/\.bak\.\d+$/);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.llm.summarizeLlm.provider).toBe('openai-compat');
    expect(written.llm.summarizeLlm.endpoint).toBe('http://localhost:8081');
    expect(written.llm.summarizeLlm.model).toContain(modelsDir);
    expect(written.llm.embeddingLlm).toBeDefined();
    expect(written.llm.rerankerLlm).toBeDefined();
    expect(written.llm.enabled).toBe(true);
    expect(written.include).toEqual(['**/*.ts']); // preserved
    expect(written.maxFileSize).toBe(5000000); // preserved

    expect(result.diff.addedOrUpdated).toContain('summarizeLlm');
    expect(result.diff.addedOrUpdated).toContain('askLlm');
  });

  it('creates a config when none exists (no backup)', () => {
    const result = writeRecommendedLlmConfig({
      projectRoot: tempDir,
      dir: path.join(tempDir, 'models'),
    });
    expect(result.backupPath).toBeNull();
    const written = JSON.parse(fs.readFileSync(result.configPath, 'utf-8'));
    expect(written.llm.summarizeLlm.provider).toBe('openai-compat');
  });

  it('output matches buildRecommendedLlmConfig for an empty prior llm block', () => {
    const modelsDir = path.join(tempDir, 'models');
    fs.writeFileSync(
      path.join(tempDir, '.cartograph', 'config.json'),
      JSON.stringify({ version: 1 }, null, 2),
      'utf-8',
    );
    const result = writeRecommendedLlmConfig({ projectRoot: tempDir, dir: modelsDir });
    const written = JSON.parse(fs.readFileSync(result.configPath, 'utf-8'));
    const expected = buildRecommendedLlmConfig({ dir: modelsDir });
    expect(written.llm).toEqual(expected);
  });
});

describe('loadConfig legacy-llm write-back guard (FRICTION-11)', () => {
  let tempDir: string;
  let stderrBuffer: string;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    tempDir = createTempDir();
    fs.mkdirSync(path.join(tempDir, '.cartograph'), { recursive: true });
    stderrBuffer = '';
    originalWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr writes without breaking the type signature.
    (process.stderr.write as unknown) = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
      stderrBuffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    };
    _resetLegacyLlmMigrationForTest();
  });

  afterEach(() => {
    (process.stderr.write as unknown) = originalWrite;
    cleanupTempDir(tempDir);
  });

  it('attempts the legacy-llm write-back at most once per process when it fails (FRICTION-11 follow-up)', () => {
    // A config carrying a LEGACY llm key (`chat` → `summarizeLlm`) so
    // migrateLegacyLlmFieldNames has changed=true on every load.
    const cgDir = path.join(tempDir, '.cartograph');
    const valid = {
      ...DEFAULT_CONFIG,
      // Legacy `chat` key (was renamed to `summarizeLlm`) drives the
      // write-back path. provider value is irrelevant here — the test
      // is about the renamed-field migration, not the provider enum.
      llm: { chat: { provider: 'claude-bridge', model: 'claude-haiku-4-5' } },
    };
    fs.writeFileSync(path.join(cgDir, 'config.json'), JSON.stringify(valid, null, 2), 'utf-8');

    // Read-only dir → the backup copy + write-back fail, so `changed`
    // stays true across loads (the file never gets migrated on disk).
    fs.chmodSync(cgDir, 0o555);
    try {
      loadConfig(tempDir);
      loadConfig(tempDir);
      loadConfig(tempDir);
    } finally {
      fs.chmodSync(cgDir, 0o755);
    }

    // Without the guard this would be 3 (one failed write-back per
    // load); the guard caps it at one attempt per path per process.
    const failures = stderrBuffer.split('\n').filter((l) => l.includes('failed to write back'));
    expect(failures.length).toBeLessThanOrEqual(1);
  });
});
