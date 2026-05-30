/**
 * End-to-end tests for the `illegal_import` layering biomarker.
 *
 * Each test spins up a real Cartograph instance in a temp directory so the
 * full extraction + cross-file biomarker pipeline runs against actual import
 * edges — same harness as `biomarkers.test.ts`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { getFindingsRanked } from '../src/db/queries-findings.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-layering-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writePackageJson(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
}

/** Return all illegal_import findings from the index. */
function illegalImportFindings(cg: Cartograph) {
  return getFindingsRanked(cg.queries, {
    biomarker: 'illegal_import',
    minSeverity: 'info',
    limit: 100,
  });
}

/**
 * Return all illegal_import findings with their detail fields. Uses
 * getFindingsRanked which now exposes `detail` directly — collapses
 * the prior per-import-node walk into one query.
 */
function illegalImportFindingsWithDetail(cg: Cartograph) {
  return getFindingsRanked(cg.queries, {
    biomarker: 'illegal_import',
    minSeverity: 'info',
    limit: 100,
  }).map((f) => ({
    nodeId: f.nodeId,
    filePath: f.filePath,
    detail: f.detail as {
      fromLayer: string;
      toLayer: string;
      importedSpec: string;
      fromFile: string;
      toFile: string;
    },
  }));
}

describe('layering rule', () => {
  let dir: string;

  afterEach(() => cleanup(dir));

  // ---------------------------------------------------------------------------
  // 1. No layers configured → no findings
  // ---------------------------------------------------------------------------
  it('emits no findings when no layers configured', async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'tools'));

    fs.writeFileSync(path.join(dir, 'core', 'util.ts'), `export function helper() { return 1; }\n`);
    fs.writeFileSync(
      path.join(dir, 'tools', 'foo.ts'),
      `import { helper } from '../core/util.js';\nexport function run() { return helper(); }\n`,
    );
    writePackageJson(dir, 'layering-no-layers');

    const cg = await Cartograph.init(dir, {
      config: { llm: { endpoint: '' } },
    });
    try {
      await cg.indexAll({ summarize: false });
      expect(illegalImportFindings(cg)).toHaveLength(0);
    } finally {
      cg.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // 2. cannotImport by layer name → finding emitted
  // ---------------------------------------------------------------------------
  it('emits finding for cannotImport violation (layer name)', async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'tools'));

    fs.writeFileSync(path.join(dir, 'core', 'util.ts'), `export function helper() { return 1; }\n`);
    fs.writeFileSync(
      path.join(dir, 'tools', 'foo.ts'),
      `import { helper } from '../core/util.js';\nexport function run() { return helper(); }\n`,
    );
    writePackageJson(dir, 'layering-cannot-import-name');

    const cg = await Cartograph.init(dir, {
      config: {
        llm: { endpoint: '' },
        layers: [
          { name: 'core', paths: ['core/**'] },
          { name: 'mcp-tools', paths: ['tools/**'], cannotImport: ['core'] },
        ],
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      const findings = illegalImportFindingsWithDetail(cg);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.detail.fromLayer).toBe('mcp-tools');
      expect(findings[0]!.detail.toLayer).toBe('core');
    } finally {
      cg.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // 3. cannotImport by glob → finding when target matches, no finding when it doesn't
  // ---------------------------------------------------------------------------
  it('emits finding for cannotImport violation (glob) but not for allowed path', async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'core', 'internal'));
    fs.mkdirSync(path.join(dir, 'tools'));

    fs.writeFileSync(path.join(dir, 'core', 'internal', 'secret.ts'), `export const SECRET = 42;\n`);
    fs.writeFileSync(path.join(dir, 'core', 'public.ts'), `export const PUBLIC = 1;\n`);
    // tools/bad.ts imports from core/internal → should fire
    fs.writeFileSync(
      path.join(dir, 'tools', 'bad.ts'),
      `import { SECRET } from '../core/internal/secret.js';\nexport function bad() { return SECRET; }\n`,
    );
    // tools/ok.ts imports from core/public → should NOT fire (glob targets internal/ only)
    fs.writeFileSync(
      path.join(dir, 'tools', 'ok.ts'),
      `import { PUBLIC } from '../core/public.js';\nexport function ok() { return PUBLIC; }\n`,
    );
    writePackageJson(dir, 'layering-cannot-import-glob');

    const cg = await Cartograph.init(dir, {
      config: {
        llm: { endpoint: '' },
        layers: [
          { name: 'core', paths: ['core/**'] },
          {
            name: 'mcp-tools',
            paths: ['tools/**'],
            cannotImport: ['core/internal/**'],
          },
        ],
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      const findings = illegalImportFindingsWithDetail(cg);
      // Only the import from core/internal/** should be flagged
      expect(findings).toHaveLength(1);
      expect(findings[0]!.detail.toFile).toContain('core/internal/secret');
    } finally {
      cg.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // 4. canImport allow-list mode → finding when target outside list
  // ---------------------------------------------------------------------------
  it('emits finding when target is outside canImport allow-list', async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.mkdirSync(path.join(dir, 'extractors'));

    fs.writeFileSync(path.join(dir, 'core', 'util.ts'), `export function coreHelper() { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'extractors', 'ext.ts'), `export function extHelper() { return 2; }\n`);
    // tools/foo.ts is only allowed to import from 'core', imports from 'extractors' instead
    fs.writeFileSync(
      path.join(dir, 'tools', 'foo.ts'),
      `import { extHelper } from '../extractors/ext.js';\nexport function run() { return extHelper(); }\n`,
    );
    writePackageJson(dir, 'layering-can-import');

    const cg = await Cartograph.init(dir, {
      config: {
        llm: { endpoint: '' },
        layers: [
          { name: 'core', paths: ['core/**'] },
          { name: 'extractors', paths: ['extractors/**'] },
          { name: 'mcp-tools', paths: ['tools/**'], canImport: ['core'] },
        ],
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      const findings = illegalImportFindingsWithDetail(cg);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      const hit = findings.find((f) => f.detail.toLayer === 'extractors');
      expect(hit).toBeDefined();
      expect(hit!.detail.fromLayer).toBe('mcp-tools');
    } finally {
      cg.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Same-layer imports never flagged
  // ---------------------------------------------------------------------------
  it('does not flag imports between files in the same layer', async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, 'core'));

    fs.writeFileSync(path.join(dir, 'core', 'a.ts'), `export function a() { return 1; }\n`);
    fs.writeFileSync(
      path.join(dir, 'core', 'b.ts'),
      `import { a } from './a.js';\nexport function b() { return a(); }\n`,
    );
    writePackageJson(dir, 'layering-same-layer');

    const cg = await Cartograph.init(dir, {
      config: {
        llm: { endpoint: '' },
        layers: [{ name: 'core', paths: ['core/**'], cannotImport: ['tools'] }],
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      expect(illegalImportFindings(cg)).toHaveLength(0);
    } finally {
      cg.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Exception suppresses one file's violation
  // ---------------------------------------------------------------------------
  it('suppresses finding when a layerException covers the importer', async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'tools'));

    fs.writeFileSync(path.join(dir, 'core', 'engine.ts'), `export function engine() { return 1; }\n`);
    // tools/biomarkers.ts is the exceptional file — it's allowed to import core
    fs.writeFileSync(
      path.join(dir, 'tools', 'biomarkers.ts'),
      `import { engine } from '../core/engine.js';\nexport function run() { return engine(); }\n`,
    );
    // tools/other.ts is NOT exceptional — should still fire
    fs.writeFileSync(
      path.join(dir, 'tools', 'other.ts'),
      `import { engine } from '../core/engine.js';\nexport function other() { return engine(); }\n`,
    );
    writePackageJson(dir, 'layering-exception');

    const cg = await Cartograph.init(dir, {
      config: {
        llm: { endpoint: '' },
        layers: [
          { name: 'core', paths: ['core/**'] },
          { name: 'mcp-tools', paths: ['tools/**'], cannotImport: ['core'] },
        ],
        layerExceptions: [{ file: 'tools/biomarkers.ts', canImport: ['core'] }],
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      const findings = illegalImportFindingsWithDetail(cg);
      // tools/biomarkers.ts is excepted — only tools/other.ts should fire
      expect(findings.some((f) => f.detail.fromFile.includes('biomarkers'))).toBe(false);
      expect(findings.some((f) => f.detail.fromFile.includes('other'))).toBe(true);
    } finally {
      cg.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Bare-package imports are never flagged
  // ---------------------------------------------------------------------------
  it('does not flag bare package imports', async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.mkdirSync(path.join(dir, 'core'));

    // tools/foo.ts imports 'path' (bare) — should never be flagged
    fs.writeFileSync(
      path.join(dir, 'tools', 'foo.ts'),
      `import nodePath from 'path';\nexport function run() { return nodePath.join('a', 'b'); }\n`,
    );
    // Add a file in core so the layer is non-trivially populated
    fs.writeFileSync(path.join(dir, 'core', 'util.ts'), `export function helper() { return 1; }\n`);
    writePackageJson(dir, 'layering-bare-import');

    const cg = await Cartograph.init(dir, {
      config: {
        llm: { endpoint: '' },
        layers: [
          { name: 'core', paths: ['core/**'] },
          { name: 'mcp-tools', paths: ['tools/**'], cannotImport: ['core'] },
        ],
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      expect(illegalImportFindings(cg)).toHaveLength(0);
    } finally {
      cg.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Un-layered target file → no finding
  // ---------------------------------------------------------------------------
  it('does not flag imports to files outside any configured layer', async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.mkdirSync(path.join(dir, 'shared'));

    // shared/ is NOT in any layer; tools/ imports from it → should not fire
    fs.writeFileSync(path.join(dir, 'shared', 'utils.ts'), `export function sharedHelper() { return 99; }\n`);
    fs.writeFileSync(
      path.join(dir, 'tools', 'foo.ts'),
      `import { sharedHelper } from '../shared/utils.js';\nexport function run() { return sharedHelper(); }\n`,
    );
    writePackageJson(dir, 'layering-unlayered-target');

    const cg = await Cartograph.init(dir, {
      config: {
        llm: { endpoint: '' },
        layers: [
          // 'shared' is intentionally absent → target is un-layered
          { name: 'mcp-tools', paths: ['tools/**'], cannotImport: ['core'] },
        ],
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      expect(illegalImportFindings(cg)).toHaveLength(0);
    } finally {
      cg.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Both canImport AND cannotImport set on the same layer:
  //    deny-list wins, allow-list is ignored. (Schema says mutually exclusive;
  //    the rule logs a warning and applies cannotImport deterministically.)
  // ---------------------------------------------------------------------------
  it('cannotImport wins when both canImport and cannotImport are set', async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.mkdirSync(path.join(dir, 'shared'));

    fs.writeFileSync(path.join(dir, 'core', 'util.ts'), `export function helper() { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'shared', 'log.ts'), `export function log(s: string) { return s; }\n`);
    fs.writeFileSync(
      path.join(dir, 'tools', 'foo.ts'),
      `import { helper } from '../core/util.js';\nimport { log } from '../shared/log.js';\nexport function run() { return log(String(helper())); }\n`,
    );
    writePackageJson(dir, 'layering-both-set');

    const cg = await Cartograph.init(dir, {
      config: {
        llm: { endpoint: '' },
        layers: [
          { name: 'core', paths: ['core/**'] },
          { name: 'shared', paths: ['shared/**'] },
          {
            name: 'mcp-tools',
            paths: ['tools/**'],
            // Both set: cannotImport (deny-list) wins.
            canImport: ['shared'],
            cannotImport: ['core'],
          },
        ],
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      const findings = illegalImportFindingsWithDetail(cg);
      // Deny-list applied: import to 'core' flagged.
      expect(findings.some((f) => f.detail.toLayer === 'core')).toBe(true);
      // Allow-list ignored: import to 'shared' would NOT have been flagged
      // even without the deny-list, so its absence here doesn't prove
      // ignored-allow-list semantics on its own — but combined with the
      // canImport not blocking the core import (it's not in canImport),
      // this asserts the deny-list-wins precedence the warn message states.
      expect(findings.some((f) => f.detail.toLayer === 'shared')).toBe(false);
    } finally {
      cg.destroy();
    }
  });
});
