/**
 * Tooling-gaps item #4 (doc gap #1): `cartograph_imports` MCP tool.
 *
 * The single largest pain in the ESM migration: agents need to ask
 * "list every relative import in this project, distinguishing imports
 * pointing at FILES from imports pointing at DIRECTORIES (with
 * implicit /index.* resolution)" — because that distinction drives
 * extension rewrites under NodeNext.
 *
 * Today: import edges exist in the graph (kind='imports') but the
 * resolver throws away the file/directory/bare/unresolvable
 * distinction after creating the edge. There is no MCP tool that
 * returns this projection.
 *
 * Expected:
 *   - new MCP tool `cartograph_imports` with filters
 *       target: 'file' | 'directory' | 'bare' | 'unresolvable'
 *       extMissing: boolean (relative import without extension)
 *       dynamic: boolean (covers item #5)
 *   - import nodes/edges store a `resolutionKind` so the projection
 *     is fast.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('Tooling-gaps #4: cartograph_imports tool', () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-imports-tool-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.mkdirSync(path.join(testDir, 'src', 'utils'));
    // src/utils/index.ts — directory-with-index target.
    fs.writeFileSync(path.join(testDir, 'src', 'utils', 'index.ts'), `export function help(){return 1;}\n`);
    // src/db.ts — file target.
    fs.writeFileSync(path.join(testDir, 'src', 'db.ts'), `export function open(){return 2;}\n`);
    // src/main.ts — has all three import shapes.
    fs.writeFileSync(
      path.join(testDir, 'src', 'main.ts'),
      `import { help } from './utils';\n` + // directory target (no extension)
        `import { open } from './db';\n` + // file target (no extension)
        `import * as fs from 'fs';\n` + // bare specifier
        `import { gone } from './missing';\n` + // unresolvable
        `export function go(){return help() + open();}\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'x', version: '0.0.0', type: 'module' }),
    );

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('the tool is registered', async () => {
    const result = await handler.execute('cartograph_imports', {});
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/unknown tool|not registered/i);
  });

  it('returns directory-target imports when target=directory', async () => {
    const result = await handler.execute('cartograph_imports', { target: 'directory' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/['"]\.\/utils['"]|src\/utils/);
    expect(text).not.toMatch(/['"]\.\/db['"]|src\/db['"]/);
  });

  it('returns file-target imports when target=file', async () => {
    const result = await handler.execute('cartograph_imports', { target: 'file' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/['"]\.\/db['"]/);
    expect(text).not.toMatch(/['"]\.\/utils['"]/);
  });

  it('flags ext-missing relative imports', async () => {
    const result = await handler.execute('cartograph_imports', { extMissing: true });
    const text = result.content[0]?.text ?? '';
    // Both './utils' and './db' are missing extensions — should appear.
    expect(text).toMatch(/['"]\.\/utils['"]/);
    expect(text).toMatch(/['"]\.\/db['"]/);
    // Bare 'fs' should NOT appear under extMissing.
    expect(text).not.toMatch(/^.*['"]fs['"]/m);
  });

  it('returns unresolvable imports when target=unresolvable', async () => {
    const result = await handler.execute('cartograph_imports', { target: 'unresolvable' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/['"]\.\/missing['"]/);
  });

  it('pathFilter restricts results to files starting with the prefix', async () => {
    // Only `src/main.ts` exists with imports; a non-matching prefix should drop everything.
    const matching = await handler.execute('cartograph_imports', { pathFilter: 'src/' });
    const matchingText = matching.content[0]?.text ?? '';
    expect(matchingText).toMatch(/['"]\.\/utils['"]/);

    const missing = await handler.execute('cartograph_imports', { pathFilter: 'nonexistent/' });
    const missingText = missing.content[0]?.text ?? '';
    expect(missingText).toMatch(/No imports match the given filters/);
  });
});

/**
 * Regression for the canonical NodeNext-migration audit use case
 * (`extMissing: true`): the default `excludeFixtures: true` MUST drop
 * `docs/test-beds/` fixture imports so the audit isn't drowned by
 * intentional ext-missing language-detection fixtures. Pass
 * `excludeFixtures: false` to re-include them.
 */
describe('cartograph_imports excludeFixtures defaults', () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-imports-fixtures-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.mkdirSync(path.join(testDir, 'docs', 'test-beds', 'typescript'), { recursive: true });
    // Real, prod-tree ext-missing import — should survive the default filter.
    fs.writeFileSync(path.join(testDir, 'src', 'real-helper.ts'), `export const x = 1;\n`);
    fs.writeFileSync(
      path.join(testDir, 'src', 'main.ts'),
      `import { x } from './real-helper';\n` + `export const y = x;\n`,
    );
    // Fixture ext-missing import — intentional, used by language-detection
    // tests; must NOT surface in the default extMissing audit.
    fs.writeFileSync(
      path.join(testDir, 'docs', 'test-beds', 'typescript', 'fixture.ts'),
      `import { helper } from './helper';\n` + `export const z = helper;\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'x', version: '0.0.0', type: 'module' }),
    );

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('extMissing: true does NOT surface docs/test-beds/ by default', async () => {
    const result = await handler.execute('cartograph_imports', { extMissing: true });
    const text = result.content[0]?.text ?? '';
    // Real prod-tree import survives.
    expect(text).toMatch(/['"]\.\/real-helper['"]/);
    // Fixture import was suppressed by the default excludeFixtures.
    expect(text).not.toMatch(/docs\/test-beds\//);
  });

  it('extMissing: true with excludeFixtures: false re-includes fixture hits', async () => {
    const result = await handler.execute('cartograph_imports', {
      extMissing: true,
      excludeFixtures: false,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/['"]\.\/real-helper['"]/);
    expect(text).toMatch(/docs\/test-beds\//);
  });
});
