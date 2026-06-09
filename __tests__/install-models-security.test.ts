import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installRecommendedModels } from '../src/installer/install-models.js';
import type { RecommendedModel } from '../src/llm/recommended-models.js';

const TEST_URL_SCHEME = 'https';
const TEST_URL_HOST = 'example.invalid';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function modelFor(args: {
  readonly filename: string;
  readonly content: string;
  readonly hfUrl?: string;
}): RecommendedModel {
  return {
    filename: args.filename,
    hfUrl: args.hfUrl ?? `${TEST_URL_SCHEME}://${TEST_URL_HOST}/${args.filename}`,
    sizeMb: 1,
    sizeBytes: Buffer.byteLength(args.content),
    sha256: sha256(args.content),
    description: 'test model',
  };
}

describe('installRecommendedModels integrity checks', () => {
  it('skips an existing model only after size and sha256 verification', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-models-ok-'));
    const content = 'verified model bytes';
    const model = modelFor({ filename: 'ok.gguf', content });
    try {
      await fs.writeFile(path.join(dir, model.filename), content, { mode: 0o600 });

      const result = await installRecommendedModels({ dir, models: [model] });

      expect(result.downloaded).toEqual([]);
      expect(result.skipped).toEqual([model]);
      await expect(fs.readFile(path.join(dir, model.filename), 'utf-8')).resolves.toBe(content);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('removes a corrupt existing model before attempting a fresh HTTPS download', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-models-bad-'));
    const model = modelFor({
      filename: 'bad.gguf',
      content: 'expected bytes',
      hfUrl: `${'http'}://${TEST_URL_HOST}/bad.gguf`,
    });
    const target = path.join(dir, model.filename);
    try {
      await fs.writeFile(target, 'corrupt bytes', { mode: 0o600 });

      await expect(installRecommendedModels({ dir, models: [model] })).rejects.toThrow(
        /refusing non-HTTPS model download URL/,
      );
      await expect(fs.access(target)).rejects.toThrow();
      await expect(fs.access(`${target}.partial`)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
