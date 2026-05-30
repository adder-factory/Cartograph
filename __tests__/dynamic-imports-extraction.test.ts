/**
 * Tooling-gaps item #5 (doc gap #2): Dynamic imports extraction.
 *
 * Today: extractor only recognizes `importTypes: ['import_statement']`,
 * so dynamic `import('foo')` and `require('foo')` are invisible to the
 * graph. During the ESM migration this meant the dynamic-import sed
 * pass had to be a separate hand-rolled regex (which had bugs).
 *
 * Expected: tree-sitter call_expression with `import` callee or
 * `require` identifier should produce import nodes/edges with a
 * metadata flag distinguishing them from static imports.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';

describe('Tooling-gaps #5: dynamic import extraction', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dyn-import-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'plugin.ts'), `export const name = 'plugin';\n`);
    fs.writeFileSync(path.join(testDir, 'src', 'cjs-dep.ts'), `export const value = 42;\n`);
    fs.writeFileSync(
      path.join(testDir, 'src', 'main.ts'),
      `export async function loadPlugin(){\n` +
        `  const mod = await import('./plugin');\n` +
        `  return mod;\n` +
        `}\n` +
        `export function loadCjs(){\n` +
        `  const m = require('./cjs-dep');\n` +
        `  return m;\n` +
        `}\n` +
        // TS-cast wrapper forms — common with packages that ship no
        // bundled types or whose types tickle TS strict-mode errors.
        // Without the unwrap, these are invisible and `cartograph_deps`
        // flags the package as unused. See `tsUnwrapStringArg` in
        // `src/extraction/tree-sitter.ts`.
        `export async function loadAsCast(){\n` +
        `  const m = await import('node-llama-cpp' as any);\n` +
        `  return m;\n` +
        `}\n` +
        `export async function loadParens(){\n` +
        `  const m = await import(('some-bare-pkg'));\n` +
        `  return m;\n` +
        `}\n` +
        `export async function loadSatisfies(){\n` +
        `  const m = await import('satisfies-pkg' satisfies string);\n` +
        `  return m;\n` +
        `}\n` +
        `export function requireAsCast(){\n` +
        `  const m = require('require-cast-pkg' as any);\n` +
        `  return m;\n` +
        `}\n` +
        // createRequire-bound aliases — canonical ESM bridge. Without
        // recognising the alias, packages loaded this way (e.g.
        // `sqlite-vec` in src/db/sqlite-adapter.ts) are invisible to
        // `cartograph_deps` and falsely reported as unused.
        `import { createRequire } from 'module';\n` +
        `const requireCjs = createRequire(import.meta.url);\n` +
        `export function loadViaRequireCjs(){\n` +
        `  return requireCjs('create-require-pkg');\n` +
        `}\n`,
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

  it("indexes dynamic `import('./plugin')` as an import node", () => {
    const q = (cg as any).queries;
    const rows = q.db
      .prepare(`SELECT name, qualified_name FROM nodes WHERE kind = 'import' AND name LIKE '%plugin%'`)
      .all() as Array<{ name: string; qualified_name: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("indexes `require('./cjs-dep')` as an import node", () => {
    const q = (cg as any).queries;
    const rows = q.db
      .prepare(`SELECT name, qualified_name FROM nodes WHERE kind = 'import' AND name LIKE '%cjs-dep%'`)
      .all() as Array<{ name: string; qualified_name: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("indexes `import('pkg' as any)` (TS-cast dynamic import) as an import node", () => {
    // Regression for `cartograph_deps` falsely flagging node-llama-cpp.
    // The `as any` wraps the string in an `as_expression` AST node — the
    // pre-fix extractor only inspected direct children of `arguments` and
    // missed the nested string.
    const q = (cg as any).queries;
    const rows = q.db
      .prepare(`SELECT name FROM nodes WHERE kind = 'import' AND name = 'node-llama-cpp'`)
      .all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("indexes parenthesised dynamic import `import(('pkg'))`", () => {
    const q = (cg as any).queries;
    const rows = q.db
      .prepare(`SELECT name FROM nodes WHERE kind = 'import' AND name = 'some-bare-pkg'`)
      .all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("indexes `import('pkg' satisfies string)` dynamic import", () => {
    const q = (cg as any).queries;
    const rows = q.db
      .prepare(`SELECT name FROM nodes WHERE kind = 'import' AND name = 'satisfies-pkg'`)
      .all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("indexes `require('pkg' as any)` (TS-cast CommonJS require)", () => {
    const q = (cg as any).queries;
    const rows = q.db
      .prepare(`SELECT name FROM nodes WHERE kind = 'import' AND name = 'require-cast-pkg'`)
      .all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("indexes `requireCjs('pkg')` (createRequire-bound alias) as an import node", () => {
    // Regression for `cartograph_deps` falsely flagging sqlite-vec.
    // The src/db/sqlite-adapter.ts pattern is
    // `const requireCjs = createRequire(import.meta.url)` followed by
    // `requireCjs('sqlite-vec')`. Without alias recognition, the
    // extractor's calleeName === 'require' check misses this and the
    // import node never emits.
    const q = (cg as any).queries;
    const rows = q.db
      .prepare(`SELECT name FROM nodes WHERE kind = 'import' AND name = 'create-require-pkg'`)
      .all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('marks dynamic imports distinctly from static imports (via signature)', () => {
    // Static imports have signatures like `import { foo } from './bar';`.
    // Dynamic imports / require calls have signatures starting with
    // `import(` or `require(`. An agent's filter for dynamic-only is a
    // signature LIKE pattern. Edge-level metadata could be a refinement
    // later, but the node-signature shape is enough for v1 filtering.
    const q = (cg as any).queries;
    const dynamic = q.db
      .prepare(
        `SELECT signature FROM nodes WHERE kind = 'import'
         AND (signature LIKE 'import(%' OR signature LIKE '%require(%')`,
      )
      .all() as Array<{ signature: string }>;
    expect(dynamic.length).toBeGreaterThan(0);
  });
});
