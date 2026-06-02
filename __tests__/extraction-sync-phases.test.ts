import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashContent, type ExtractionOrchestratorState, type SyncState } from '../src/extraction/index.js';
import type { FileRecord } from '../src/types.js';

const files = new Map<string, FileRecord>();
const removed: string[] = [];
const oracle = {
  healFlagged: [] as string[],
  contentDrift: [] as string[],
};
let vanished: string[] = [];
let reconciled = 0;

vi.mock('../src/db/queries-files.js', () => ({
  getAllFiles: vi.fn(() => [...files.values()]),
  getFileByPath: vi.fn((_queries: unknown, filePath: string) => files.get(filePath) ?? null),
  reconcileFileNodeCounts: vi.fn(() => {
    reconciled++;
  }),
  removeFileFromIndex: vi.fn((_queries: unknown, filePath: string) => {
    removed.push(filePath);
    files.delete(filePath);
  }),
  removeFileFromIndexInTx: vi.fn((_queries: unknown, filePath: string) => {
    removed.push(filePath);
    files.delete(filePath);
  }),
  upsertFile: vi.fn(),
}));

vi.mock('../src/change-oracle/index.js', () => ({
  whatChanged: vi.fn(() => oracle),
}));

vi.mock('../src/freshness.js', () => ({
  findVanishedFiles: vi.fn(() => vanished),
}));

const { eoApplySyncChanges, eoCollectFullScanChanges, eoCollectGitChanges } = await import(
  '../src/extraction/extraction-phases.js'
);

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-phases-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function record(root: string, rel: string, content: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    path: rel,
    contentHash: hashContent(content),
    language: rel.endsWith('.py') ? 'python' : 'typescript',
    size: content.length,
    modifiedAt: Date.now(),
    indexedAt: Date.now(),
    nodeCount: 1,
    ...overrides,
  } as FileRecord;
}

function state(rootDir: string): ExtractionOrchestratorState {
  return {
    rootDir,
    config: {
      include: ['**/*.ts', '**/*.py'],
      exclude: [],
      maxFileSize: 1_000_000,
    },
    queries: {},
    cacheHits: { count: 0 },
  } as unknown as ExtractionOrchestratorState;
}

function syncState(): SyncState {
  return {
    filesChecked: 0,
    filesAdded: 0,
    filesModified: 0,
    filesRemoved: 0,
    filesToIndex: [],
    changedFilePaths: [],
    nodesUpdated: 0,
  };
}

beforeEach(() => {
  files.clear();
  removed.length = 0;
  oracle.healFlagged = [];
  oracle.contentDrift = [];
  vanished = [];
  reconciled = 0;
});

describe('extraction sync phase orchestration', () => {
  it('applies git changes, vanished-file reaping, and heal/drift unions', () => {
    const root = tempProject();
    try {
      write(root, 'src/modified.ts', 'export const modified = 2;\n');
      write(root, 'src/added.ts', 'export const added = 1;\n');
      write(root, 'src/heal.ts', 'export const heal = 1;\n');
      write(root, 'src/drift.ts', 'export const drift = 2;\n');

      files.set('src/deleted.ts', record(root, 'src/deleted.ts', 'export const deleted = 1;\n'));
      files.set('src/vanished.ts', record(root, 'src/vanished.ts', 'export const vanished = 1;\n'));
      files.set('src/modified.ts', record(root, 'src/modified.ts', 'export const modified = 1;\n'));
      files.set('src/heal.ts', record(root, 'src/heal.ts', 'export const heal = 1;\n', { needsReextract: true }));
      files.set('src/drift.ts', record(root, 'src/drift.ts', 'export const drift = 1;\n'));
      vanished = ['src/vanished.ts'];
      oracle.healFlagged = ['src/heal.ts', 'src/modified.ts'];
      oracle.contentDrift = ['src/drift.ts', 'src/added.ts'];

      const s = syncState();
      eoApplySyncChanges(
        state(root),
        { deleted: ['src/deleted.ts'], modified: ['src/modified.ts'], added: ['src/added.ts'] },
        s,
      );

      expect(removed).toEqual(['src/deleted.ts', 'src/vanished.ts']);
      expect(reconciled).toBe(1);
      expect(s.filesRemoved).toBe(2);
      expect(s.filesAdded).toBe(1);
      expect(s.filesModified).toBe(3);
      expect(s.filesChecked).toBe(5);
      expect(s.filesToIndex).toEqual(['src/modified.ts', 'src/added.ts', 'src/heal.ts', 'src/drift.ts']);
      expect(s.changedFilePaths).toEqual(['src/modified.ts', 'src/added.ts', 'src/heal.ts', 'src/drift.ts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to a full scan when git changes are unavailable', () => {
    const root = tempProject();
    try {
      write(root, 'src/current.ts', 'export const current = 1;\n');
      write(root, 'src/changed.py', 'value = 2\n');
      files.set('src/current.ts', record(root, 'src/current.ts', 'export const current = 1;\n'));
      files.set('src/changed.py', record(root, 'src/changed.py', 'value = 1\n'));
      files.set('src/removed.ts', record(root, 'src/removed.ts', 'export const removed = 1;\n'));

      const s = syncState();
      eoApplySyncChanges(state(root), null as never, s);

      expect(removed).toEqual(['src/removed.ts']);
      expect(s.filesChecked).toBe(2);
      expect(s.filesRemoved).toBe(1);
      expect(s.filesAdded).toBe(0);
      expect(s.filesModified).toBe(1);
      expect(s.filesToIndex).toEqual(['src/changed.py']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('collects git and full-scan changes without mutating the index', () => {
    const root = tempProject();
    try {
      write(root, 'src/git-modified.ts', 'export const value = 2;\n');
      write(root, 'src/git-added.ts', 'export const added = 1;\n');
      write(root, 'src/full-current.ts', 'export const full = 1;\n');
      write(root, 'src/full-added.py', 'added = 1\n');
      files.set('src/git-deleted.ts', record(root, 'src/git-deleted.ts', 'export const gone = 1;\n'));
      files.set('src/ghost.ts', record(root, 'src/ghost.ts', 'export const ghost = 1;\n'));
      files.set('src/git-modified.ts', record(root, 'src/git-modified.ts', 'export const value = 1;\n'));
      files.set('src/full-current.ts', record(root, 'src/full-current.ts', 'export const full = 1;\n'));
      vanished = ['src/ghost.ts'];

      expect(
        eoCollectGitChanges(state(root), {
          deleted: ['src/git-deleted.ts'],
          modified: ['src/git-modified.ts'],
          added: ['src/git-added.ts'],
        }),
      ).toEqual({
        added: ['src/git-added.ts'],
        modified: ['src/git-modified.ts'],
        removed: ['src/git-deleted.ts', 'src/ghost.ts'],
      });

      const fullScanChanges = eoCollectFullScanChanges(state(root));
      expect(fullScanChanges.added.toSorted()).toEqual(['src/full-added.py', 'src/git-added.ts']);
      expect(fullScanChanges.modified).toEqual(['src/git-modified.ts']);
      expect(fullScanChanges.removed).toEqual(['src/git-deleted.ts', 'src/ghost.ts']);
      expect(removed).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
