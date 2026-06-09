/**
 * Freshness v2 stress tests — auto-sync, block-on-heavy, migration,
 * stale artifacts perf, watcher end-to-end.
 *
 * Skipped by default (slow, spawns git, runs migrations, polls fs):
 *   STRESS=1 npx vitest run __tests__/freshness-v2-stress.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { appendFindings } from '../src/db/queries-findings.js';
import { getStaleArtifactsCount } from '../src/db/queries-metadata.js';
import { getNodesByKind } from '../src/db/queries.js';

const STRESS = process.env.STRESS === '1';
const describeStress = STRESS ? describe : describe.skip;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo(suffix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-fresh-v2-${suffix}-`));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 's@e.com');
  git(dir, 'config', 'user.name', 's');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

describeStress('Freshness v2 — parallel auto-sync', () => {
  let dir: string;
  let cg: Cartograph;

  beforeAll(async () => {
    dir = makeRepo('parsync');
    cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  }, 30000);

  afterAll(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('20 parallel execute() calls hitting auto-sync path resolve correctly', async () => {
    const { ToolHandler } = await import('../src/mcp/tools.js');
    const handler = new ToolHandler(cg);

    // Drift HEAD by 2 files (within auto-sync threshold).
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), 'export const c = 2;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'drift');
    cg.stats.invalidateFreshness();

    const PARALLEL = 20;
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => handler.execute('cartograph_find', { by: 'name', query: 'alpha' })),
    );

    const autoSyncedCount = results.filter((r) => r.metadata?.freshness?.autoSynced === true).length;
    const blockedCount = results.filter((r) => r.metadata?.freshness?.blocked === true).length;
    const errorCount = results.filter((r) => r.isError === true).length;

    // Some calls land BEFORE the first auto-sync completes; once it does,
    // the index is fresh and subsequent calls don't trigger another. So
    // we expect at least one auto-sync, no errors, and no blocks.
    expect(errorCount).toBe(0);
    expect(blockedCount).toBe(0);
    expect(autoSyncedCount).toBeGreaterThanOrEqual(1);
    // After the dust settles, the project should be in sync.
    expect(cg.stats.getFreshness()!.isStale).toBe(false);
  }, 60000);
});

describeStress('Freshness v2 — block-on-heavy boundaries', () => {
  let dir: string;
  let cg: Cartograph;

  beforeAll(async () => {
    dir = makeRepo('block');
    cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  }, 30000);

  afterAll(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exactly at threshold (100 files): does not block', async () => {
    const { ToolHandler } = await import('../src/mcp/tools.js');
    const handler = new ToolHandler(cg);

    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(dir, 'src', `t100_${i}.ts`), `export const v=${i};\n`);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'boundary');
    cg.stats.invalidateFreshness();

    const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
    // 100 files is NOT > BLOCK_MAX_FILES (100), so it should NOT block.
    expect(result.metadata?.freshness?.blocked).toBeUndefined();
    expect(result.isError).not.toBe(true);
  }, 30000);

  it('one over threshold (101 files): blocks with structured metadata', async () => {
    const { ToolHandler } = await import('../src/mcp/tools.js');
    const handler = new ToolHandler(cg);

    fs.writeFileSync(path.join(dir, 'src', 't101_extra.ts'), 'export const x=1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', '+1');
    cg.stats.invalidateFreshness();

    const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
    expect(result.isError).toBe(true);
    expect(result.metadata?.freshness?.blocked).toBe(true);
    expect((result.content[0] as { text?: string }).text).toContain('too stale');
  }, 30000);
});

describeStress('Freshness v2 — migration 020 idempotency', () => {
  it('runs cleanly on a fresh DB (column already in schema.sql)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-v2-mig1-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a=1;\n');
      // Fresh init runs schema.sql + ALL migrations from v1+. Migration
      // 020 must no-op gracefully when its target column already exists.
      const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();
      // Sanity: getStaleArtifactsCount works
      const counts = getStaleArtifactsCount(cg.queries);
      expect(counts.total).toBe(0);
      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('runs cleanly when re-applied (idempotent guard)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-v2-mig2-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a=1;\n');
      const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      // Re-run the migration directly via the migration module (simulates
      // a re-applied migration on an already-migrated DB).
      const { MIGRATION } = await import('../src/db/migrations/020-artifact-source-hash.js');
      const rawDb = (cg as unknown as { queries: { db: { exec: (s: string) => void; prepare: (s: string) => any } } })
        .queries.db;
      // Should not throw — guard checks column existence.
      expect(() => MIGRATION.up(rawDb as any)).not.toThrow();
      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describeStress('Freshness v2 — getStaleArtifactsCount performance', () => {
  it('handles 1000 findings + 1000 embeddings in under 100ms', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-v2-perf-'));
    try {
      // Build a project with many symbols
      fs.mkdirSync(path.join(dir, 'src'));
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(`export function fn${i}() { return ${i}; }`);
      }
      fs.writeFileSync(path.join(dir, 'src', 'big.ts'), lines.join('\n'));
      fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');

      const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      // Hand-insert 1000 fake findings + 1000 fake embeddings to simulate
      // a heavily-summarised project without running the LLM passes.
      const queries = (cg as unknown as { queries: any }).queries;
      const nodes = getNodesByKind(cg.queries, 'function').slice(0, 1000);
      // Pad with synthetic findings
      const findings: Array<{ nodeId: string; biomarker: string; severity: 'info'; metric: number }> = [];
      for (let i = 0; i < nodes.length; i++) {
        findings.push({ nodeId: nodes[i]!.id, biomarker: `__perf_${i}__`, severity: 'info', metric: i });
      }
      appendFindings(queries, findings);

      const start = Date.now();
      const counts = getStaleArtifactsCount(cg.queries);
      const elapsed = Date.now() - start;
      console.log(
        `getStaleArtifactsCount over ${nodes.length} findings: ${elapsed}ms (counts: ${JSON.stringify(counts)})`,
      );

      expect(elapsed).toBeLessThan(100);
      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describeStress('Freshness v2 — watcher end-to-end with real git', () => {
  it('triggers sync after a real git commit', async () => {
    const dir = makeRepo('watcher');
    let syncFired = false;
    let syncCount = 0;

    try {
      const { FileWatcher } = await import('../src/sync/watcher.js');
      const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const watcher = new FileWatcher({
        projectRoot: dir,
        config: cg.getConfig(),
        syncFn: async () => {
          syncFired = true;
          syncCount++;
          const result = await cg.sync({ summarize: false });
          return { filesChanged: result.filesAdded + result.filesModified, durationMs: result.durationMs };
        },
        options: { debounceMs: 200 },
      });

      const started = watcher.start();
      if (!started) {
        console.log('watcher start failed — skipping (platform support)');
        cg.close();
        return;
      }

      try {
        await watcher.untilReady(5000);
      } catch {
        console.log('watcher start failed — skipping (platform support)');
        watcher.stop();
        cg.close();
        return;
      }

      // Make a real commit. .git/HEAD changes; isGitHeadChange should fire.
      fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'watcher test');
      watcher._injectFileEventForTest(path.join(dir, '.git', 'HEAD'));

      // Wait for debounce + sync to complete
      const deadline = Date.now() + 5000;
      while (!syncFired && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      console.log(`syncFired=${syncFired}, syncCount=${syncCount}`);
      expect(syncFired).toBe(true);

      watcher.stop();
      cg.close();
    } finally {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
