/**
 * Tooling-gaps item #7: `is_test` flag on files.
 *
 * Promoted from the (descoped) string-literal-fixture work. The
 * `is_test` flag itself is broadly useful — multiple downstream tools
 * benefit from it independent of the rewrite story:
 *   - dead-code analysis: a function only called from tests is
 *     effectively dead in prod, but currently looks live.
 *   - biomarker rollups: should test files count toward complexity
 *     centrality? Probably not.
 *   - co-change pairs that span only tests can be downweighted.
 *
 * Detection is glob-based on indexed paths — no AST work needed.
 *   **`/__tests__/**`, **`/*.test.{ts,tsx,js,jsx,mjs,cjs}`,
 *   **`/*_test.{go,py}`, **`/test_*.py`, **`/*Test.java`, etc.
 *
 * Expected: `files` table gains an `is_test INTEGER NOT NULL DEFAULT 0`
 * column populated during indexing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';

describe('Tooling-gaps #7: files.is_test flag', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-istest-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.mkdirSync(path.join(testDir, '__tests__'));
    fs.writeFileSync(path.join(testDir, 'src', 'foo.ts'), `export function foo(){return 1;}\n`);
    fs.writeFileSync(
      path.join(testDir, 'src', 'foo.test.ts'),
      `import { foo } from './foo'; export const t = foo();\n`,
    );
    fs.writeFileSync(path.join(testDir, '__tests__', 'bar.test.ts'), `export const bar = 'test';\n`);
    fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('the is_test column exists on the files table', () => {
    const q = (cg as any).queries;
    const cols = q.db.prepare(`PRAGMA table_info(files)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('is_test');
  });

  it('flags **/*.test.ts as test', () => {
    const q = (cg as any).queries;
    const row = q.db.prepare(`SELECT is_test FROM files WHERE path LIKE '%foo.test.ts'`).get() as { is_test: number };
    expect(row?.is_test).toBe(1);
  });

  it('flags files under __tests__/ as test', () => {
    const q = (cg as any).queries;
    const row = q.db.prepare(`SELECT is_test FROM files WHERE path LIKE '%__tests__/bar.test.ts'`).get() as {
      is_test: number;
    };
    expect(row?.is_test).toBe(1);
  });

  it('does NOT flag plain src/foo.ts as test', () => {
    const q = (cg as any).queries;
    const row = q.db
      .prepare(`SELECT is_test FROM files WHERE path LIKE '%src/foo.ts' AND path NOT LIKE '%test%'`)
      .get() as { is_test: number };
    expect(row?.is_test).toBe(0);
  });
});
