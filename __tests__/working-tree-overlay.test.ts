import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Cartograph } from '../src/index.js';
import { buildWorkingTreeOverlay } from '../src/features/working-tree-overlay/index.js';
import { getNodesByKind } from '../src/db/queries.js';

describe('working-tree context overlay', () => {
  let projectPath: string;
  let cg: Cartograph;

  beforeEach(async () => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-overlay-'));
    execFileSync('git', ['init', '-q'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.email', 'cartograph@example.test'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Cartograph Test'], { cwd: projectPath });
    fs.mkdirSync(path.join(projectPath, 'src'));
    fs.writeFileSync(
      path.join(projectPath, 'src', 'service.ts'),
      'export function indexedHandler(): string { return "indexed"; }\n',
    );
    cg = await Cartograph.init(projectPath, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll({ summarize: false });
    execFileSync('git', ['add', 'src/service.ts', '.gitignore'], { cwd: projectPath });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: projectPath });

    fs.writeFileSync(
      path.join(projectPath, 'src', 'service.ts'),
      'export function liveHandler(): string { return "live"; }\n',
    );
    fs.writeFileSync(
      path.join(projectPath, 'src', 'new-worker.ts'),
      'export function liveWorker(): string { return liveHandlerAlias(); }\nfunction liveHandlerAlias(): string { return "live"; }\n',
    );
    const future = Math.floor(Date.now() / 1000) + 60;
    fs.utimesSync(path.join(projectPath, 'src', 'service.ts'), future, future);
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('extracts modified and untracked source without mutating the persisted graph', async () => {
    const overlay = await buildWorkingTreeOverlay(cg, {
      task: 'fix liveHandler and liveWorker behavior',
      mode: 'live',
    });

    expect(overlay.report.changedFiles).toEqual(['src/new-worker.ts', 'src/service.ts']);
    expect(overlay.report.extractedFiles).toEqual(['src/new-worker.ts', 'src/service.ts']);
    expect(overlay.report.candidates.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(['liveHandler', 'liveWorker']),
    );
    expect(overlay.report.candidates.every((candidate) => candidate.provenance === 'working-tree')).toBe(true);
    expect(overlay.evidenceByNodeId.size).toBeGreaterThan(0);

    const persistedFunctions = getNodesByKind(cg.queries, 'function').map((node) => node.name);
    expect(persistedFunctions).toContain('indexedHandler');
    expect(persistedFunctions).not.toContain('liveHandler');
    expect(persistedFunctions).not.toContain('liveWorker');
  });

  it('can be disabled without consulting or extracting the working tree', async () => {
    const overlay = await buildWorkingTreeOverlay(cg, { task: 'liveHandler', mode: 'off' });

    expect(overlay.report.status).toBe('off');
    expect(overlay.report.changedFiles).toEqual([]);
    expect(overlay.extraCandidates).toEqual([]);
  });
});
