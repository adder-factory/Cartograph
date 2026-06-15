import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { analyseProject, isBiomarkerCacheCold, BIOMARKER_CACHE_KEY } from '../src/biomarkers/index.js';
import { setMetadata } from '../src/db/queries-metadata.js';

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

  it('treats a shape-invalid cache blob as cold rather than silently trusting it', async () => {
    const dir = tempDir();
    try {
      writeProject(dir);
      const cg = Cartograph.initSync(dir, {
        config: { enableWatcher: false, enableBiomarkers: false, include: ['src/**/*.ts'] },
      });
      try {
        await cg.indexAll({ summarize: false });

        // A well-formed `path -> hash` blob loads (warm cache, not cold).
        setMetadata(cg.queries, BIOMARKER_CACHE_KEY, JSON.stringify({ 'src/work.ts': 'abc123' }));
        expect(isBiomarkerCacheCold(cg.queries)).toBe(false);

        // A blob with the right outer shape but a non-string value would,
        // under a bare `as Record<string, string>` cast, be trusted and
        // its bogus entry used as a content hash — skipping a file that
        // actually changed. The schema rejects it → cold (full rescan).
        setMetadata(cg.queries, BIOMARKER_CACHE_KEY, JSON.stringify({ 'src/work.ts': 123 }));
        expect(isBiomarkerCacheCold(cg.queries)).toBe(true);

        // Outright corrupt JSON is also cold, not a throw.
        setMetadata(cg.queries, BIOMARKER_CACHE_KEY, '{not json');
        expect(isBiomarkerCacheCold(cg.queries)).toBe(true);
      } finally {
        cg.close();
      }
    } finally {
      cleanup(dir);
    }
  });
});
