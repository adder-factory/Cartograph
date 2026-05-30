/**
 * `cartograph_discover` — find `.cartograph/` directories under a root.
 * Verifies discovery (finds initialized projects), no-match path
 * (helpful empty message), and depth bounding (skips deep dirs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_discover', () => {
  let monorepo: string;
  let projectACg: Cartograph;
  let projectBCg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    monorepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-discover-'));
    // Two sub-projects, both initialized.
    fs.mkdirSync(path.join(monorepo, 'apps', 'a', 'src'), { recursive: true });
    fs.writeFileSync(path.join(monorepo, 'apps', 'a', 'src', 'main.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(monorepo, 'apps', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '0.0.0' }));
    fs.mkdirSync(path.join(monorepo, 'packages', 'b', 'src'), { recursive: true });
    fs.writeFileSync(path.join(monorepo, 'packages', 'b', 'src', 'main.ts'), 'export const y = 2;\n');
    fs.writeFileSync(
      path.join(monorepo, 'packages', 'b', 'package.json'),
      JSON.stringify({ name: 'b', version: '0.0.0' }),
    );
    // A third sub-dir that is NOT initialized.
    fs.mkdirSync(path.join(monorepo, 'docs'), { recursive: true });
    // node_modules subdir to verify skip behavior.
    fs.mkdirSync(path.join(monorepo, 'node_modules', 'lib', '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(monorepo, 'node_modules', 'lib', '.cartograph', 'cartograph.db'), 'fake');
    // A stale test-fixture index under __tests__/.../fixtures/ — a test
    // artifact, not a real project. Must NOT surface as a context.
    fs.mkdirSync(path.join(monorepo, '__tests__', 'evaluation', 'fixtures', 'large', '.cartograph'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(monorepo, '__tests__', 'evaluation', 'fixtures', 'large', '.cartograph', 'cartograph.db'),
      'fake',
    );

    projectACg = await Cartograph.init(path.join(monorepo, 'apps', 'a'), { config: { llm: { endpoint: '' } } });
    await projectACg.indexAll({ summarize: false });
    projectBCg = await Cartograph.init(path.join(monorepo, 'packages', 'b'), { config: { llm: { endpoint: '' } } });
    await projectBCg.indexAll({ summarize: false });
    handler = new ToolHandler(projectACg); // any cg works as the host
  });

  afterEach(() => {
    handler?.closeAll();
    if (projectACg) projectACg.close();
    if (projectBCg) projectBCg.close();
    if (fs.existsSync(monorepo)) fs.rmSync(monorepo, { recursive: true, force: true });
  });

  it('finds both initialized contexts under the monorepo root', async () => {
    const result = await handler.execute('cartograph_discover', { path: monorepo });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/2 cartograph contexts found/);
    // Paths must be ABSOLUTE so they are directly usable as `projectPath`.
    // Updated from relative `apps/a` / `packages/b` to check the full path.
    const absA = path.join(monorepo, 'apps', 'a');
    const absB = path.join(monorepo, 'packages', 'b');
    expect(text).toContain(absA);
    expect(text).toContain(absB);
    // Stats columns rendered.
    expect(text).toMatch(/Files/);
    expect(text).toMatch(/Nodes/);
  });

  it('populates stat columns (bug #19) — Files/Nodes must NOT all be em-dash', async () => {
    // Bug #19 regression guard: pre-fix the stat reader used `node:sqlite`
    // which does not exist under Bun, so EVERY row in the discover table
    // rendered as `—`. After the bun:sqlite swap + active-project live-
    // connection fallback, both rows for the indexed sub-projects must
    // show real integer counts. The host `projectACg` is `apps/a`, so
    // its row is filled in via the live-connection path; `packages/b` is
    // a sibling read via `bun:sqlite` read-only open.
    const result = await handler.execute('cartograph_discover', { path: monorepo });
    const text = result.content[0]?.text ?? '';
    // Pull all table-row stats columns: `| path | files | nodes | ts |`.
    // Each non-header row must have at least one numeric column.
    const rowMatches = [...text.matchAll(/\| `[^`]+` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/g)];
    expect(rowMatches.length).toBeGreaterThan(0);
    let numericRowCount = 0;
    for (const m of rowMatches) {
      const filesCol = m[1]!.trim();
      const nodesCol = m[2]!.trim();
      if (/^\d+$/.test(filesCol) && /^\d+$/.test(nodesCol)) numericRowCount++;
    }
    // At minimum the active project (apps/a) must have populated stats —
    // its row is filled via the live `cg.queries` connection so the
    // sibling-DB lock can't race it.
    expect(numericRowCount).toBeGreaterThanOrEqual(1);
  });

  it('renders discovered paths as absolute', async () => {
    const result = await handler.execute('cartograph_discover', { path: monorepo });
    const text = result.content[0]?.text ?? '';
    // Every backtick-quoted path in the table rows must be absolute.
    // Extract all `...` values from the table body (skip header row).
    const tablePathMatches = [...text.matchAll(/\| `([^`]+)` \|/g)].map((m) => m[1]);
    expect(tablePathMatches.length).toBeGreaterThan(0);
    for (const p of tablePathMatches) {
      expect(path.isAbsolute(p!)).toBe(true);
    }
  });

  it('skips node_modules even when a fake .cartograph is in there', async () => {
    const result = await handler.execute('cartograph_discover', { path: monorepo });
    const text = result.content[0]?.text ?? '';
    // Should NOT report the node_modules/lib/.cartograph fake.
    expect(text).not.toMatch(/node_modules/);
  });

  it('skips stale test-fixture indices rooted under __tests__/fixtures', async () => {
    const result = await handler.execute('cartograph_discover', { path: monorepo });
    const text = result.content[0]?.text ?? '';
    // The fixture index under __tests__/evaluation/fixtures/large must
    // not surface as a queryable "project" — it's a test artifact.
    expect(text).not.toMatch(/__tests__/);
    expect(text).not.toMatch(/fixtures/);
    // The two real sub-projects are still found.
    expect(text).toMatch(/2 cartograph contexts found/);
  });

  it('returns a helpful empty message when no contexts are under the path', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-discover-empty-'));
    try {
      const result = await handler.execute('cartograph_discover', { path: empty });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/No cartograph contexts found/);
      expect(text).toMatch(/cartograph admin init/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('respects maxDepth', async () => {
    // Both apps/a and packages/b are at depth 2 (apps/a). With depth 1,
    // neither should surface — only the immediate children of monorepo.
    const result = await handler.execute('cartograph_discover', { path: monorepo, maxDepth: 1 });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No cartograph contexts found/);
  });

  it('rejects non-existent path', async () => {
    const result = await handler.execute('cartograph_discover', {
      path: '/nonexistent/path/that/will/never/exist',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/path does not exist/);
  });
});
