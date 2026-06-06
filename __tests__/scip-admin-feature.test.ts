import { describe, expect, it, vi } from 'vitest';
import type { QueryBuilder } from '../src/db/queries.js';
import { runScipExport, runScipImport, type ScipAdminRuntimeDeps } from '../src/features/scip-admin/runtime.js';

const EXPORT_DOCUMENTS = 2;
const EXPORT_SYMBOLS = 3;
const EXPORT_OCCURRENCES = 4;
const EXPORT_BYTES = 99;
const EXPORT_DISAMBIGUATED = 1;
const IMPORT_DOCUMENTS = 2;
const IMPORT_FILES = 1;
const IMPORT_NODES = 3;
const IMPORT_EDGES = 4;
const IMPORT_SKIPPED_DOCUMENTS = 1;
const IMPORT_UNRESOLVED_EDGES = 2;
const TEST_SCIP_BYTES = new Uint8Array([1, 2, 3]);

function deps(overrides: Partial<ScipAdminRuntimeDeps> = {}): ScipAdminRuntimeDeps {
  return {
    isInitialized: () => true,
    openCartograph: vi.fn(async () => ({
      queries: { db: true } as unknown as QueryBuilder,
      projectRoot: '/repo',
      close: vi.fn(),
    })),
    writeScipExport: vi.fn(() => ({
      outPath: '/repo/index.scip',
      stats: {
        documents: EXPORT_DOCUMENTS,
        symbols: EXPORT_SYMBOLS,
        occurrences: EXPORT_OCCURRENCES,
        bytes: EXPORT_BYTES,
        disambiguated: EXPORT_DISAMBIGUATED,
      },
    })),
    writeScipImport: vi.fn(() => ({
      stats: {
        documents: IMPORT_DOCUMENTS,
        files: IMPORT_FILES,
        nodes: IMPORT_NODES,
        edges: IMPORT_EDGES,
        skippedDocuments: IMPORT_SKIPPED_DOCUMENTS,
        unresolvedEdges: IMPORT_UNRESOLVED_EDGES,
      },
    })),
    readFile: vi.fn(() => TEST_SCIP_BYTES),
    ...overrides,
  };
}

describe('SCIP admin feature runtime', () => {
  it('exports to the default project index.scip path and renders stats', async () => {
    const runtime = deps();

    const result = await runScipExport({ projectPath: '/repo' }, runtime);

    expect(result).toEqual({
      ok: true,
      messages: [
        'Exported SCIP index → /repo/index.scip',
        '2 documents, 3 symbols, 4 occurrences (99 bytes)',
        '1 symbol(s) disambiguated (name collision)',
      ],
    });
    expect(runtime.writeScipExport).toHaveBeenCalledWith(
      { db: true } as unknown as QueryBuilder,
      '/repo',
      '/repo/index.scip',
    );
  });

  it('imports the configured SCIP file and renders skipped/unresolved stats', async () => {
    const runtime = deps();

    const result = await runScipImport({ projectPath: '/repo', inPath: '/tmp/input.scip' }, runtime);

    expect(result).toEqual({
      ok: true,
      messages: [
        'Imported SCIP index ← /tmp/input.scip',
        '2 documents, 1 files, 3 nodes, 4 edges',
        '1 document(s) skipped (unsafe path)',
        '2 edge(s) dropped (target symbol had no definition)',
      ],
    });
    expect(runtime.readFile).toHaveBeenCalledWith('/tmp/input.scip');
  });

  it('returns expected failures as values for uninitialized projects and missing files', async () => {
    await expect(runScipExport({ projectPath: '/repo' }, deps({ isInitialized: () => false }))).resolves.toEqual({
      ok: false,
      error: 'Cartograph not initialized in /repo',
    });

    await expect(
      runScipImport(
        { projectPath: '/repo', inPath: '/missing.scip' },
        deps({
          readFile: () => {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          },
        }),
      ),
    ).resolves.toEqual({ ok: false, error: 'SCIP file not found: /missing.scip' });
  });

  it('closes the graph when export or import writers throw', async () => {
    const exportClose = vi.fn();
    const exportRuntime = deps({
      openCartograph: vi.fn(async () => ({ queries: {} as QueryBuilder, projectRoot: '/repo', close: exportClose })),
      writeScipExport: () => {
        throw new Error('boom');
      },
    });

    await expect(runScipExport({ projectPath: '/repo' }, exportRuntime)).resolves.toEqual({
      ok: false,
      error: 'SCIP export failed: boom',
    });
    expect(exportClose).toHaveBeenCalledTimes(1);

    const importClose = vi.fn();
    const importRuntime = deps({
      openCartograph: vi.fn(async () => ({ queries: {} as QueryBuilder, projectRoot: '/repo', close: importClose })),
      writeScipImport: () => {
        throw new Error('boom');
      },
    });

    await expect(runScipImport({ projectPath: '/repo' }, importRuntime)).resolves.toEqual({
      ok: false,
      error: 'SCIP import failed: boom',
    });
    expect(importClose).toHaveBeenCalledTimes(1);
  });
});
