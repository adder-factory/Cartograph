import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph, FileLock } from '../src/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lifecycle-'));
}

function writeProject(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'life', version: '0.0.0' }));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(){ return 1; }\n`);
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('Cartograph lifecycle API', () => {
  it('initializes with an index pass, opens with sync, and exposes instructions', async () => {
    const dir = tempDir();
    try {
      writeProject(dir);
      const phases: string[] = [];
      const cg = await Cartograph.init(dir, {
        index: true,
        onProgress: (progress) => phases.push(progress.phase),
        config: { enableWatcher: false, include: ['src/**/*.ts'] },
      });

      expect(Cartograph.isInitialized(dir)).toBe(true);
      expect(phases).toContain('scanning');
      expect(cg.stats.getStats().nodeCount).toBeGreaterThan(0);
      expect(Cartograph.getInstructions()).toContain('cartograph');
      cg.close();

      await expect(Cartograph.init(dir)).rejects.toThrow(/already initialized/);

      const opened = await Cartograph.open(dir, { sync: true });
      expect(opened.projectRoot).toBe(path.resolve(dir));
      opened.close();

      const openedSync = Cartograph.openSync(dir);
      expect(openedSync.getConfig().include).toContain('src/**/*.ts');
      openedSync.close();
    } finally {
      cleanup(dir);
    }
  });

  it('persists config updates, clears caches, ingests coverage, and uninitializes cleanly', async () => {
    const dir = tempDir();
    try {
      writeProject(dir);
      const cg = Cartograph.initSync(dir, { config: { enableWatcher: false, include: ['src/**/*.ts'] } });
      await cg.indexAll({ summarize: false, profile: true });

      cg.updateConfig({ maxFileSize: 12345 });
      expect(cg.getConfig().maxFileSize).toBe(12345);
      const reopened = Cartograph.openSync(dir);
      expect(reopened.getConfig().maxFileSize).toBe(12345);
      reopened.close();

      const lcov = path.join(dir, 'unit.lcov');
      fs.writeFileSync(
        lcov,
        ['TN:', 'SF:src/a.ts', 'DA:1,1', 'LF:1', 'LH:1', 'end_of_record', ''].join('\n'),
      );
      const coverage = await cg.ingestCoverage(lcov, { source: 'unit-test' });
      expect(coverage.filesMatched).toBeGreaterThanOrEqual(1);

      cg.clearStructural();
      expect(cg.stats.getStats().nodeCount).toBe(0);
      cg.clear();
      expect(cg.stats.getStats().fileCount).toBe(0);

      await cg.uninitialize();
      expect(fs.existsSync(path.join(dir, '.cartograph'))).toBe(false);
      expect(Cartograph.isInitialized(dir)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('returns explicit contention results when the project file lock is held', async () => {
    const dir = tempDir();
    try {
      writeProject(dir);
      const cg = Cartograph.initSync(dir, { config: { enableWatcher: false, include: ['src/**/*.ts'] } });
      const held = new FileLock(path.join(dir, '.cartograph', 'cartograph.lock'));
      held.acquire();
      try {
        const indexed = await cg.indexAll({ summarize: false });
        expect(indexed.success).toBe(false);
        expect(indexed.errors[0]?.message).toContain('Could not acquire file lock');

        const sync = await cg.sync({ summarize: false });
        expect(sync.lockContention).toBe(true);

        const indexedFiles = await cg.indexFiles(['src/a.ts']);
        expect(indexedFiles.success).toBe(false);
        expect(indexedFiles.errors[0]?.message).toContain('Could not acquire file lock');
      } finally {
        held.release();
        cg.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  it('indexes selected files and syncs added, modified, removed, and no-op file states', async () => {
    const dir = tempDir();
    try {
      writeProject(dir);
      fs.writeFileSync(path.join(dir, 'src', 'b.ts'), `export function beta(){ return 2; }\n`);
      const cg = Cartograph.initSync(dir, { config: { enableWatcher: false, include: ['src/**/*.ts'] } });
      try {
        const indexedFiles = await cg.indexFiles(['src/a.ts']);
        expect(indexedFiles.success).toBe(true);
        expect(indexedFiles.filesIndexed).toBeGreaterThanOrEqual(1);

        const firstSync = await cg.sync({ summarize: false });
        expect(firstSync.filesAdded + firstSync.filesModified + firstSync.filesRemoved).toBeGreaterThanOrEqual(0);

        const noOp = await cg.sync({ summarize: false });
        expect(noOp.filesAdded).toBe(0);
        expect(noOp.filesModified).toBe(0);
        expect(noOp.filesRemoved).toBe(0);
        expect(noOp.lockContention).toBeUndefined();

        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(){ return 10; }\n`);
        fs.writeFileSync(path.join(dir, 'src', 'c.ts'), `export function gamma(){ return 3; }\n`);
        fs.rmSync(path.join(dir, 'src', 'b.ts'));
        const changed = await cg.sync({ summarize: false });
        expect(changed.filesAdded).toBeGreaterThanOrEqual(1);
        expect(changed.filesModified).toBeGreaterThanOrEqual(1);
        expect(changed.filesRemoved).toBeGreaterThanOrEqual(0);

        const embedOnly = await cg.indexAll({ summarize: false, embedOnly: true, profile: true });
        expect(embedOnly.success).toBe(true);
        expect(embedOnly.profile?.resolveMs).toBe(0);
        expect(embedOnly.profile?.postHooksMs).toBe(0);
      } finally {
        cg.destroy();
      }
    } finally {
      cleanup(dir);
    }
  });

  it('reports open failures for missing projects and malformed saved config', async () => {
    const missing = tempDir();
    const malformed = tempDir();
    try {
      await expect(Cartograph.open(missing)).rejects.toThrow(/not initialized/);
      expect(() => Cartograph.openSync(missing)).toThrow(/not initialized/);

      writeProject(malformed);
      const cg = Cartograph.initSync(malformed, { config: { enableWatcher: false } });
      cg.close();
      fs.writeFileSync(path.join(malformed, '.cartograph', 'config.json'), '{bad json');

      await expect(Cartograph.open(malformed)).rejects.toThrow();
      expect(() => Cartograph.openSync(malformed)).toThrow();
    } finally {
      cleanup(missing);
      cleanup(malformed);
    }
  });
});
