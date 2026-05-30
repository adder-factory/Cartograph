/**
 * Tooling-gaps item #6 (doc gap #3): build-context references.
 *
 * `__dirname`, `__filename`, `import.meta.dirname`, `import.meta.url`,
 * `import.meta.filename` are surface-area for any module-format
 * migration. During the ESM migration the agent had to grep for these
 * — they were not first-class in cartograph.
 *
 * Expected: a new `build_context_refs` table modelled exactly on
 * `config_refs` (per-site occurrences with optional source_node_id),
 * a new `extractBuildContextRefs` extractor, and a way to query them
 * (either via cartograph_imports with a flag, or a dedicated tool).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import {
  BUILD_CONTEXT_REFS_ALGO_VERSION,
  LAST_MINED_BUILD_CONTEXT_REFS_ALGO_VERSION_KEY,
} from '../src/build-context-refs/index.js';
import { setMetadata, getMetadata } from '../src/db/queries-metadata.js';

describe('Tooling-gaps #6: build-context refs (__dirname / import.meta.*)', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-build-ctx-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'cjs-style.ts'),
      `export function loadAsset(){\n` +
        `  const root = __dirname;\n` +
        `  const me = __filename;\n` +
        `  return { root, me };\n` +
        `}\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'esm-style.ts'),
      `export function loadAssetEsm(){\n` +
        `  const root = import.meta.dirname;\n` +
        `  const me = import.meta.filename;\n` +
        `  const url = import.meta.url;\n` +
        `  return { root, me, url };\n` +
        `}\n`,
    );
    // A file that mentions the build-context identifiers ONLY inside
    // comments — these must NOT be mined as real usage sites.
    fs.writeFileSync(
      path.join(testDir, 'src', 'comments-only.ts'),
      `// __dirname is the CJS way to get the directory\n` +
        `/* migration note: replace __filename with import.meta.filename\n` +
        `   and __dirname with import.meta.dirname; import.meta.url too */\n` +
        `export const noop = () => 1; // import.meta.url goes here eventually\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'x', version: '0.0.0', type: 'module' }),
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('the build_context_refs table exists', () => {
    const q = (cg as any).queries;
    const row = q.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='build_context_refs'`).get();
    expect(row).toBeDefined();
  });

  it('captures __dirname and __filename in the CJS-style file', () => {
    const q = (cg as any).queries;
    const refs = q.db
      .prepare(`SELECT ref_kind, file_path FROM build_context_refs WHERE file_path LIKE '%cjs-style%'`)
      .all() as Array<{ ref_kind: string; file_path: string }>;
    const kinds = refs.map((r) => r.ref_kind);
    expect(kinds).toContain('__dirname');
    expect(kinds).toContain('__filename');
  });

  it('captures import.meta.dirname / .filename / .url in the ESM-style file', () => {
    const q = (cg as any).queries;
    const refs = q.db
      .prepare(`SELECT ref_kind FROM build_context_refs WHERE file_path LIKE '%esm-style%'`)
      .all() as Array<{ ref_kind: string }>;
    const kinds = refs.map((r) => r.ref_kind);
    expect(kinds).toContain('import.meta.dirname');
    expect(kinds).toContain('import.meta.filename');
    expect(kinds).toContain('import.meta.url');
  });

  it('does not mine build-context identifiers that appear only in comments', () => {
    const q = (cg as any).queries;
    const refs = q.db
      .prepare(`SELECT ref_kind FROM build_context_refs WHERE file_path LIKE '%comments-only%'`)
      .all() as Array<{ ref_kind: string }>;
    expect(refs).toEqual([]);
  });

  it('BUILD_CONTEXT_REFS_ALGO_VERSION is a source-derived algo-hash, not a hand-bumped literal', () => {
    expect(BUILD_CONTEXT_REFS_ALGO_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('build-context-refs hook self-heal on algo-version mismatch', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bcr-selfheal-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    // File A — has __dirname; this will be the "only changed file" in the sync.
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function fa() { return __dirname; }\n`);
    // File B — has import.meta.url; NOT in the sync's changed set.
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), `export function fb() { return import.meta.url; }\n`);
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'x', version: '0.0.0', type: 'module' }),
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('forces a full re-mine when stored algo version is stale', async () => {
    const q = (cg as any).queries;

    // Verify baseline: both files were mined after indexAll.
    const beforeRefs = q.db
      .prepare(`SELECT file_path, ref_kind FROM build_context_refs ORDER BY file_path`)
      .all() as Array<{ file_path: string; ref_kind: string }>;
    const beforeFiles = new Set(beforeRefs.map((r: { file_path: string }) => r.file_path));
    expect([...beforeFiles].some((p: string) => p.includes('a.ts'))).toBe(true);
    expect([...beforeFiles].some((p: string) => p.includes('b.ts'))).toBe(true);

    // Wipe the build_context_refs table to simulate stale state after a miner fix.
    q.db.exec('DELETE FROM build_context_refs');
    expect(q.db.prepare('SELECT COUNT(*) AS n FROM build_context_refs').get().n).toBe(0);

    // Stamp a bogus algo version to trigger the self-heal path.
    setMetadata(q, LAST_MINED_BUILD_CONTEXT_REFS_ALGO_VERSION_KEY, '0');

    // Modify only file A so the sync's changedFilePaths = ['src/a.ts'].
    // Without the self-heal, only a.ts would be re-mined; b.ts would
    // stay empty (stale). With the self-heal the hook does a full
    // re-mine and both files get their refs back.
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function fa() { return __dirname; }\n// touched\n`);
    await cg.sync();

    const afterRefs = q.db
      .prepare(`SELECT file_path, ref_kind FROM build_context_refs ORDER BY file_path`)
      .all() as Array<{ file_path: string; ref_kind: string }>;
    const afterFiles = new Set(afterRefs.map((r: { file_path: string }) => r.file_path));

    // Both files must be present — b.ts was NOT in the changed set but
    // must have been re-mined due to the algo-version mismatch.
    expect([...afterFiles].some((p: string) => p.includes('a.ts'))).toBe(true);
    expect([...afterFiles].some((p: string) => p.includes('b.ts'))).toBe(true);

    // The algo version key must be stamped to the current version.
    expect(getMetadata(q, LAST_MINED_BUILD_CONTEXT_REFS_ALGO_VERSION_KEY)).toBe(BUILD_CONTEXT_REFS_ALGO_VERSION);
  });

  it('stays incremental when the stored algo version matches', async () => {
    const q = (cg as any).queries;

    // Stamp the current version (already done by indexAll, but be explicit).
    setMetadata(q, LAST_MINED_BUILD_CONTEXT_REFS_ALGO_VERSION_KEY, BUILD_CONTEXT_REFS_ALGO_VERSION);

    // Wipe b.ts refs to simulate a scenario where b.ts has no refs
    // (so we can confirm the incremental path does NOT re-mine b.ts).
    q.db.prepare(`DELETE FROM build_context_refs WHERE file_path LIKE '%b.ts'`).run();

    // Only touch a.ts in the sync.
    fs.writeFileSync(
      path.join(testDir, 'src', 'a.ts'),
      `export function fa() { return __dirname; }\n// incremental touch\n`,
    );
    await cg.sync();

    const bRefs = q.db.prepare(`SELECT COUNT(*) AS n FROM build_context_refs WHERE file_path LIKE '%b.ts'`).get() as {
      n: number;
    };

    // Incremental path: b.ts was not in changedFilePaths and algo version
    // matched, so b.ts refs remain empty (not re-mined).
    expect(bRefs.n).toBe(0);
  });
});
