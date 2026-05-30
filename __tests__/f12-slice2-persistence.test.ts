import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import {
  lookupNestedFnsByName,
  resolveNestedFnManifest,
  searchNestedFnsFts,
} from '../src/db/queries-nested-functions.js';

// F#12 slice 2: end-to-end persistence of the nested-function manifest
// through the orchestrator's extract → persist transaction. Each test
// drives a real `indexAll()` against a tempdir TS fixture that's been
// pushed over the manifest-mode threshold via a tiny env override.

const SAVED = process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-f12-slice2-'));
}
function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('F#12 slice 2 — manifest persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    // Force every fixture into manifest mode regardless of size.
    process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = '3';
  });

  afterEach(() => {
    cleanup(tempDir);
    if (SAVED === undefined) {
      delete process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
    } else {
      process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = SAVED;
    }
  });

  it('persists one row per nested-function declaration', async () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'mega.ts'),
      `
export function megaFn() {
  function getTypeOfSymbol(s) {
    return s.type;
  }
  function checkSourceFile(f) {
    return f.path;
  }
  return getTypeOfSymbol(checkSourceFile({}));
}
`,
    );

    const cg = Cartograph.initSync(tempDir, { config: { largeFunctionThreshold: 3 } });
    const result = await cg.indexAll();
    expect(result.success).toBe(true);

    const rows = lookupNestedFnsByName(cg.queries, 'getTypeOfSymbol');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe('getTypeOfSymbol');
    expect(row.filePath).toBe('src/mega.ts');
    expect(row.parentName).toBe('megaFn');
    expect(row.bodyHash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.hitCount).toBe(0);
    expect(row.promotedNodeId).toBeNull();

    cg.close();
  });

  it('FTS5 search matches the manifest name corpus', async () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'mega.ts'),
      `
export function megaFn() {
  function widget() {
    return 1;
  }
  function gadget() {
    return 2;
  }
  return widget() + gadget();
}
`,
    );

    const cg = Cartograph.initSync(tempDir, { config: { largeFunctionThreshold: 3 } });
    await cg.indexAll();

    const widgetHits = searchNestedFnsFts(cg.queries, 'widget');
    expect(widgetHits.map((r) => r.name)).toContain('widget');
    expect(widgetHits.map((r) => r.name)).not.toContain('gadget');

    cg.close();
  });

  it('refreshes manifest rows when the file is re-extracted', async () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'mega.ts'),
      `
export function megaFn() {
  function before() {
    return 1;
  }
  return before();
}
`,
    );

    const cg = Cartograph.initSync(tempDir, { config: { largeFunctionThreshold: 3 } });
    await cg.indexAll();
    expect(lookupNestedFnsByName(cg.queries, 'before')).toHaveLength(1);

    fs.writeFileSync(
      path.join(srcDir, 'mega.ts'),
      `
export function megaFn() {
  function after() {
    return 2;
  }
  return after();
}
`,
    );

    await cg.sync();

    expect(lookupNestedFnsByName(cg.queries, 'before')).toHaveLength(0);
    expect(lookupNestedFnsByName(cg.queries, 'after')).toHaveLength(1);

    cg.close();
  });

  it('cascade-deletes manifest rows when the parent file is removed', async () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    const filePath = path.join(srcDir, 'mega.ts');
    fs.writeFileSync(
      filePath,
      `
export function megaFn() {
  function doomed() {
    return 1;
  }
  return doomed();
}
`,
    );

    const cg = Cartograph.initSync(tempDir, { config: { largeFunctionThreshold: 3 } });
    await cg.indexAll();
    expect(lookupNestedFnsByName(cg.queries, 'doomed')).toHaveLength(1);

    fs.unlinkSync(filePath);
    await cg.sync();

    expect(lookupNestedFnsByName(cg.queries, 'doomed')).toHaveLength(0);

    cg.close();
  });

  it('resolveNestedFnManifest disambiguates by file_path + start_line', async () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      `
export function aFn() {
  function shared() {
    return 'a';
  }
  return shared();
}
`,
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      `
export function bFn() {
  function shared() {
    return 'b';
  }
  return shared();
}
`,
    );

    const cg = Cartograph.initSync(tempDir, { config: { largeFunctionThreshold: 3 } });
    await cg.indexAll();

    const allShared = lookupNestedFnsByName(cg.queries, 'shared');
    expect(allShared).toHaveLength(2);

    const byFile = resolveNestedFnManifest(cg.queries, { name: 'shared', filePath: 'src/a.ts' });
    expect(byFile).toHaveLength(1);
    expect(byFile[0]!.filePath).toBe('src/a.ts');

    const byPosition = resolveNestedFnManifest(cg.queries, {
      name: 'shared',
      filePath: 'src/a.ts',
      startLine: byFile[0]!.startLine,
    });
    expect(byPosition).toHaveLength(1);
    expect(byPosition[0]!.filePath).toBe('src/a.ts');

    cg.close();
  });
});
