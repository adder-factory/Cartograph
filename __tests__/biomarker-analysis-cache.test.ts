import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { analyseProject, isBiomarkerCacheCold } from '../src/biomarkers/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-biomarker-cache-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeProject(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-cache', version: '0.0.0' }));
  fs.writeFileSync(
    path.join(dir, 'src', 'work.ts'),
    [
      'export function computeThing(input: number): number {',
      '  let total = 0;',
      '  if (input > 0) total += input;',
      '  if (input > 10) total += 10;',
      '  return total;',
      '}',
      '',
    ].join('\n'),
  );
}

describe('analyseProject biomarker cache', () => {
  it('persists a warm cache and skips unchanged files on the next full pass', async () => {
    const dir = tempDir();
    try {
      writeProject(dir);
      const cg = Cartograph.initSync(dir, {
        config: { enableWatcher: false, enableBiomarkers: false, include: ['src/**/*.ts'] },
      });
      try {
        await cg.indexAll({ summarize: false });

        expect(isBiomarkerCacheCold(cg.queries)).toBe(true);
        const first = await analyseProject(cg.queries, cg.projectRoot);
        expect(first.filesScanned).toBeGreaterThanOrEqual(1);
        expect(first.errors).toBe(0);
        expect(isBiomarkerCacheCold(cg.queries)).toBe(false);

        const second = await analyseProject(cg.queries, cg.projectRoot);
        expect(second.filesSkippedByCache).toBeGreaterThanOrEqual(1);
        expect(second.errors).toBe(0);

        fs.writeFileSync(
          path.join(dir, 'src', 'work.ts'),
          [
            'export function computeThing(input: number): number {',
            '  let total = 1;',
            '  if (input > 0) total += input;',
            '  if (input > 10) total += 10;',
            '  if (input > 20) total += 20;',
            '  return total;',
            '}',
            '',
          ].join('\n'),
        );
        await cg.sync({ summarize: false });
        const partial = await analyseProject(cg.queries, cg.projectRoot, { filePaths: ['src/work.ts'] });
        expect(partial.filesScanned).toBeGreaterThanOrEqual(1);
        expect(partial.errors).toBe(0);
      } finally {
        cg.close();
      }
    } finally {
      cleanup(dir);
    }
  });
});
