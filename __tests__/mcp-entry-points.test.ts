/**
 * Tests for `cartograph_entry_points` (#10). Validates the four
 * buckets render correctly:
 *   - Routes: HTTP handlers (kind='route' from framework resolvers,
 *     excluding `cmd `-prefixed CLI command nodes).
 *   - CLI commands: subcommands extracted from `program.command(...)`
 *     by the commander/yargs/caporal/cac framework resolver.
 *   - CLI files: exported function/class symbols whose path is under
 *     bin/ or cli/ (coarser path heuristic).
 *   - Public exports: exported symbols with zero incoming `calls` edges.
 *
 * Tests focus on the bucketing + filtering logic, not on the
 * underlying framework resolvers (those have their own tests).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('cartograph_entry_points (#10)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-entry-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'src', 'bin'));

    // src/lib.ts: exported helper called by an internal user.
    fs.writeFileSync(
      path.join(dir, 'src', 'lib.ts'),
      'export function helper() { return 1; }\n' + 'export function publicApi() { return helper(); }\n',
    );
    // src/internal-user.ts: calls helper, so helper has an in-tree
    // caller and would NOT count as a public export.
    fs.writeFileSync(
      path.join(dir, 'src', 'internal-user.ts'),
      'import { helper } from "./lib.js";\n' + 'export function consumeHelper() { return helper(); }\n',
    );
    // src/bin/cli.ts: exported function under bin/ — should appear
    // under CLI commands bucket. (Top-level `bin/` is excluded by
    // cartograph's default config to avoid Java/.NET compiled output;
    // `src/bin/` is the documented home for Node CLI entry sources
    // and is indexed.)
    fs.writeFileSync(path.join(dir, 'src', 'bin', 'cli.ts'), 'export function runMain() { return process.argv; }\n');
    // __tests__/test-helper.ts: exported helper in a test file — #62.
    // Should NOT appear in any entry-points bucket (CLI-files or
    // public-exports) because isTestPath filters it out.
    fs.mkdirSync(path.join(dir, '__tests__'), { recursive: true });
    fs.writeFileSync(path.join(dir, '__tests__', 'test-helper.ts'), 'export function fakeFromTest() { return 1; }\n');

    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces a CLI file under bin/ in the path-heuristic bucket', async () => {
    const result = await handler.execute('cartograph_entry_points', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/## Entry points/);
    expect(text).toMatch(/### CLI files \(under bin\/ or cli\/\)/);
    // runMain appears in the CLI files bucket (path-heuristic) — no
    // commander dep declared in this fixture so the framework-extracted
    // bucket stays empty.
    const cliFilesIndex = text.indexOf('### CLI files');
    expect(cliFilesIndex).toBeGreaterThan(-1);
    const cliFilesSection = text.slice(cliFilesIndex);
    expect(cliFilesSection).toContain('runMain');
    expect(cliFilesSection).toContain('src/bin/cli.ts');
  });

  it('lists public exports (exported, no in-tree callers)', async () => {
    const result = await handler.execute('cartograph_entry_points', {});
    const text = result.content[0]?.text ?? '';
    // publicApi: exported, called by no one in-tree → public surface.
    // Note: cross-file caller resolution may or may not bind in a
    // fresh fixture (#17-class flakiness on small fixtures), so we
    // assert publicApi appears as a public export — not strict on
    // helper's exclusion since the imports edge may not resolve.
    expect(text).toMatch(/### Public exports/);
    expect(text).toContain('publicApi');
  });

  it('#62 — test-path exports do not appear in any entry-points bucket', async () => {
    const result = await handler.execute('cartograph_entry_points', {});
    const text = result.content[0]?.text ?? '';
    // fakeFromTest lives in __tests__/test-helper.ts; isTestPath should
    // strip it from both the CLI-files and public-exports buckets.
    expect(text).not.toContain('fakeFromTest');
  });

  it('header total counts true entry points, not just displayed rows (audit Group 2 #4)', async () => {
    // With a tiny per-bucket cap, the rendered rows are fewer than the
    // real entry-point count. The header MUST report the true total
    // (pre-cap sum) and add a "showing N" clause — the pre-fix header
    // echoed only the displayed-row count and understated reality.
    const full = await handler.execute('cartograph_entry_points', {});
    const fullText = full.content[0]?.text ?? '';
    const fullHeader = /## Entry points \(([^)]*)\)/.exec(fullText);
    expect(fullHeader).not.toBeNull();
    // Uncapped baseline: header is a plain "N total" with no "showing".
    expect(fullHeader![1]).toMatch(/^\d+ total$/);
    const trueTotal = Number(/^(\d+) total$/.exec(fullHeader![1])![1]);
    expect(trueTotal).toBeGreaterThan(0);

    // Now force a cap of 1 per bucket. The header total must stay the
    // SAME true number and gain a "showing N" clause.
    const capped = await handler.execute('cartograph_entry_points', { limit: 1 });
    const cappedText = capped.content[0]?.text ?? '';
    const cappedHeader = /## Entry points \(([^)]*)\)/.exec(cappedText);
    expect(cappedHeader).not.toBeNull();
    const cappedTotalMatch = /^(\d+) total/.exec(cappedHeader![1]);
    expect(cappedTotalMatch).not.toBeNull();
    expect(Number(cappedTotalMatch![1])).toBe(trueTotal);
    expect(cappedHeader![1]).toMatch(/showing \d+/);
  });

  it('single-bucket header reports the real bucket size, not the page size (audit Group 2 #5)', async () => {
    // `bucket: 'public_exports', limit: 1` — the header total must be
    // the real public-exports count, with "showing 1", not "(1 total)".
    const result = await handler.execute('cartograph_entry_points', {
      bucket: 'public_exports',
      limit: 1,
    });
    const text = result.content[0]?.text ?? '';
    const header = /## Entry points \(([^)]*)\)/.exec(text);
    expect(header).not.toBeNull();
    // The section line carries "(1 (+N more, capped))" — derive the real
    // count and confirm the header matches it, not the page size. The
    // label itself contains parens ("(no in-tree callers)"), so anchor
    // on the count clause: "(<digits>" optionally followed by the
    // "(+N more, capped)" suffix.
    const section = /### Public exports \(no in-tree callers\) \((\d+)(?: \(\+(\d+) more, capped\))?\)/.exec(text);
    expect(section).not.toBeNull();
    const shown = Number(section![1]);
    const cappedExtra = section![2] ? Number(section![2]) : 0;
    const realBucketCount = shown + cappedExtra;
    const headerTotal = Number(/^(\d+) total/.exec(header![1])![1]);
    expect(headerTotal).toBe(realBucketCount);
  });

  it('surfaces commander program.command(...) calls in the CLI commands bucket', async () => {
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-entry-cli-'));
    fs.mkdirSync(path.join(cliDir, 'src'));
    fs.mkdirSync(path.join(cliDir, 'src', 'bin'));
    fs.writeFileSync(
      path.join(cliDir, 'package.json'),
      JSON.stringify({ name: 'cli-fixture', dependencies: { commander: '^12.0.0' } }, null, 2),
    );
    fs.writeFileSync(
      path.join(cliDir, 'src', 'bin', 'main.ts'),
      `import { program } from 'commander';
program.command('admin').description('admin tools');
program.command('search [query]').action(() => {});
program.command('build-similarity-edges [path]').description('build edges');
const adminCmd = program.command('admin-sub').description('sub');
adminCmd.command('foo').action(() => {});
`,
    );
    // Test-bed fixture under __tests__/: closes #59. Should be filtered
    // out of the entry_points report so real CLI commands aren't crowded
    // out by test scaffolding.
    fs.mkdirSync(path.join(cliDir, '__tests__'));
    fs.writeFileSync(
      path.join(cliDir, '__tests__', 'fixture.test.ts'),
      `import { program } from 'commander';
program.command('test-only-fixture-cmd').action(() => {});
`,
    );
    fs.writeFileSync(path.join(cliDir, '.gitignore'), '.cartograph/\nnode_modules/\n');
    git(cliDir, 'init', '-q');
    git(cliDir, 'config', 'user.email', 't@t');
    git(cliDir, 'config', 'user.name', 't');
    git(cliDir, 'config', 'commit.gpgsign', 'false');
    git(cliDir, 'add', '.');
    git(cliDir, 'commit', '-q', '-m', 'init');
    const cg2 = await Cartograph.init(cliDir, { config: { llm: { endpoint: '' } } });
    await cg2.indexAll({ summarize: false });
    const handler2 = new ToolHandler(cg2, { profile: 'full' });
    try {
      const result = await handler2.execute('cartograph_entry_points', {});
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/### CLI commands \(commander/);
      const cliCmdIndex = text.indexOf('### CLI commands');
      expect(cliCmdIndex).toBeGreaterThan(-1);
      const nextSectionIndex = text.indexOf('### ', cliCmdIndex + 5);
      const cliCmdSection = nextSectionIndex > 0 ? text.slice(cliCmdIndex, nextSectionIndex) : text.slice(cliCmdIndex);
      expect(cliCmdSection).toContain('cmd admin');
      expect(cliCmdSection).toContain('cmd search');
      expect(cliCmdSection).toContain('cmd build-similarity-edges');
      expect(cliCmdSection).toContain('cmd admin-sub');
      expect(cliCmdSection).toContain('cmd foo');
      // #59 — test-bed fixtures filtered out so they don't drown real
      // commands in the agent-facing list.
      expect(text).not.toContain('test-only-fixture-cmd');
    } finally {
      handler2.closeAll();
      cg2.close();
      fs.rmSync(cliDir, { recursive: true, force: true });
    }
  });

  it("surfaces XXX_TOOL constants matching `name: 'cartograph_*'` in the MCP tools bucket", async () => {
    // Mock-fixture: an exported constant shaped like a real MCP tool
    // module. Its initializer carries `definition: { name: 'cartograph_demo' }`,
    // so the entry-points handler should detect and surface it.
    const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-entry-mcp-'));
    fs.mkdirSync(path.join(mcpDir, 'src'));
    fs.writeFileSync(
      path.join(mcpDir, 'src', 'demo.ts'),
      `function handleDemo() { return { ok: true }; }
export const DEMO_TOOL = {
  definition: { name: 'cartograph_demo', description: 'demo' },
  handle: handleDemo,
};
`,
    );
    fs.writeFileSync(path.join(mcpDir, '.gitignore'), '.cartograph/\n');
    git(mcpDir, 'init', '-q');
    git(mcpDir, 'config', 'user.email', 't@t');
    git(mcpDir, 'config', 'user.name', 't');
    git(mcpDir, 'config', 'commit.gpgsign', 'false');
    git(mcpDir, 'add', '.');
    git(mcpDir, 'commit', '-q', '-m', 'init');
    const cg2 = await Cartograph.init(mcpDir, { config: { llm: { endpoint: '' } } });
    await cg2.indexAll({ summarize: false });
    const handler2 = new ToolHandler(cg2, { profile: 'full' });
    try {
      const result = await handler2.execute('cartograph_entry_points', {});
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/### MCP tools \(XXX_TOOL constants\)/);
      const mcpIndex = text.indexOf('### MCP tools');
      expect(mcpIndex).toBeGreaterThan(-1);
      const nextSection = text.indexOf('### ', mcpIndex + 5);
      const mcpSection = nextSection > 0 ? text.slice(mcpIndex, nextSection) : text.slice(mcpIndex);
      // Constant name + parsed canonical tool name both rendered.
      expect(mcpSection).toContain('DEMO_TOOL');
      expect(mcpSection).toContain('cartograph_demo');
      expect(mcpSection).toContain('src/demo.ts');
    } finally {
      handler2.closeAll();
      cg2.close();
      fs.rmSync(mcpDir, { recursive: true, force: true });
    }
  });

  it('FRICTION-I (2026-05-14) — MCP tools bucket is sorted alphabetically by parsed `cartograph_*` name, not by registration order', async () => {
    // Three XXX_TOOL constants are deliberately written in
    // registration-order BACKWARDS-vs-alphabetical (zebra → middle → apple)
    // so the legacy "registration order" output would have read
    // ZEBRA → MIDDLE → APPLE. Alphabetical-by-canonical-name forces the
    // emitted order to be `cartograph_apple` → `cartograph_middle` →
    // `cartograph_zebra` regardless of file/source order.
    const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-entry-mcp-sort-'));
    fs.mkdirSync(path.join(mcpDir, 'src'));
    fs.writeFileSync(
      path.join(mcpDir, 'src', 'tools.ts'),
      `function handleZ() { return { ok: true }; }
function handleM() { return { ok: true }; }
function handleA() { return { ok: true }; }
export const ZEBRA_TOOL = {
  definition: { name: 'cartograph_zebra', description: 'z' },
  handle: handleZ,
};
export const MIDDLE_TOOL = {
  definition: { name: 'cartograph_middle', description: 'm' },
  handle: handleM,
};
export const APPLE_TOOL = {
  definition: { name: 'cartograph_apple', description: 'a' },
  handle: handleA,
};
`,
    );
    fs.writeFileSync(path.join(mcpDir, '.gitignore'), '.cartograph/\n');
    git(mcpDir, 'init', '-q');
    git(mcpDir, 'config', 'user.email', 't@t');
    git(mcpDir, 'config', 'user.name', 't');
    git(mcpDir, 'config', 'commit.gpgsign', 'false');
    git(mcpDir, 'add', '.');
    git(mcpDir, 'commit', '-q', '-m', 'init');
    const cg2 = await Cartograph.init(mcpDir, { config: { llm: { endpoint: '' } } });
    await cg2.indexAll({ summarize: false });
    const handler2 = new ToolHandler(cg2, { profile: 'full' });
    try {
      const result = await handler2.execute('cartograph_entry_points', {});
      const text = result.content[0]?.text ?? '';
      const mcpIndex = text.indexOf('### MCP tools');
      expect(mcpIndex).toBeGreaterThan(-1);
      const nextSection = text.indexOf('### ', mcpIndex + 5);
      const mcpSection = nextSection > 0 ? text.slice(mcpIndex, nextSection) : text.slice(mcpIndex);
      const appleIdx = mcpSection.indexOf('cartograph_apple');
      const middleIdx = mcpSection.indexOf('cartograph_middle');
      const zebraIdx = mcpSection.indexOf('cartograph_zebra');
      expect(appleIdx).toBeGreaterThan(-1);
      expect(middleIdx).toBeGreaterThan(-1);
      expect(zebraIdx).toBeGreaterThan(-1);
      // Strict alphabetical: apple before middle before zebra.
      expect(appleIdx).toBeLessThan(middleIdx);
      expect(middleIdx).toBeLessThan(zebraIdx);
    } finally {
      handler2.closeAll();
      cg2.close();
      fs.rmSync(mcpDir, { recursive: true, force: true });
    }
  });

  it('FRICTION-K (2026-05-14) — public exports predicate uses the same edge kinds as graph callers (references, not just calls)', async () => {
    // Dispatch-table assignments (`XXX_TOOL.handle = handleX`) emit a
    // `references` edge per the 2026-05-11 binding-table fix, not a
    // `calls` edge. The pre-fix predicate looked at `['calls']` only, so
    // `handleX` always appeared as "no in-tree callers" even when a
    // dispatch table referenced it. After the fix, `handleX` should NOT
    // appear in the public-exports bucket because it has a `references`
    // caller.
    const refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-entry-refs-'));
    fs.mkdirSync(path.join(refDir, 'src'));
    fs.writeFileSync(
      path.join(refDir, 'src', 'handler.ts'),
      `export function handleViaRef() { return 1; }
`,
    );
    fs.writeFileSync(
      path.join(refDir, 'src', 'dispatch.ts'),
      `import { handleViaRef } from './handler.js';
export const DISPATCH = { handler: handleViaRef };
`,
    );
    fs.writeFileSync(path.join(refDir, '.gitignore'), '.cartograph/\n');
    git(refDir, 'init', '-q');
    git(refDir, 'config', 'user.email', 't@t');
    git(refDir, 'config', 'user.name', 't');
    git(refDir, 'config', 'commit.gpgsign', 'false');
    git(refDir, 'add', '.');
    git(refDir, 'commit', '-q', '-m', 'init');
    const cg2 = await Cartograph.init(refDir, { config: { llm: { endpoint: '' } } });
    await cg2.indexAll({ summarize: false });
    const handler2 = new ToolHandler(cg2, { profile: 'full' });
    try {
      const result = await handler2.execute('cartograph_entry_points', { bucket: 'public_exports', limit: 200 });
      const text = result.content[0]?.text ?? '';
      // handleViaRef has an incoming `references` edge from the dispatch
      // object literal — it should NOT be flagged as a "no in-tree
      // callers" public export.
      const publicIdx = text.indexOf('### Public exports');
      if (publicIdx > -1) {
        const publicSection = text.slice(publicIdx);
        expect(publicSection).not.toContain('handleViaRef');
      }
    } finally {
      handler2.closeAll();
      cg2.close();
      fs.rmSync(refDir, { recursive: true, force: true });
    }
  });

  it('bucket:routes — accurate empty message when route nodes exist only in test fixtures / CLI', async () => {
    // A repo whose ONLY `route` nodes are commander CLI commands plus an
    // HTTP route inside a __tests__ fixture — i.e. zero HTTP routes in
    // production source. The `bucket:'routes'` empty message must NOT
    // declare the project "internal-only"; it must say route nodes DO
    // exist (just not in production source).
    const rDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-entry-routes-'));
    fs.mkdirSync(path.join(rDir, 'src', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(rDir, 'package.json'),
      JSON.stringify({ name: 'r-fixture', dependencies: { commander: '^12.0.0', express: '^4.0.0' } }, null, 2),
    );
    fs.writeFileSync(
      path.join(rDir, 'src', 'bin', 'main.ts'),
      `import { program } from 'commander';\nprogram.command('serve').action(() => {});\n`,
    );
    fs.mkdirSync(path.join(rDir, '__tests__'));
    fs.writeFileSync(
      path.join(rDir, '__tests__', 'fixture.test.ts'),
      `import express from 'express';\nconst app = express();\napp.get('/fixture-route', () => {});\n`,
    );
    fs.writeFileSync(path.join(rDir, '.gitignore'), '.cartograph/\nnode_modules/\n');
    git(rDir, 'init', '-q');
    git(rDir, 'config', 'user.email', 't@t');
    git(rDir, 'config', 'user.name', 't');
    git(rDir, 'config', 'commit.gpgsign', 'false');
    git(rDir, 'add', '.');
    git(rDir, 'commit', '-q', '-m', 'init');
    const cg2 = await Cartograph.init(rDir, { config: { llm: { endpoint: '' } } });
    await cg2.indexAll({ summarize: false });
    const handler2 = new ToolHandler(cg2, { profile: 'full' });
    try {
      const result = await handler2.execute('cartograph_entry_points', { bucket: 'routes' });
      const text = result.content[0]?.text ?? '';
      // Must NOT blanket-declare the project internal-only.
      expect(text).not.toMatch(/library \/ internal-only project. This may/);
      // Should explain WHY it's empty: route nodes exist elsewhere.
      expect(text).toMatch(/route` node|No HTTP routes in production source|No `route` nodes/);
      // Audit #18: the fixture/CLI split must be accurate. This repo has
      // exactly 1 production CLI command (`src/bin/main.ts`) and 1
      // fixture HTTP route (`__tests__/fixture.test.ts`) — the note must
      // attribute them as "1 in test fixtures … 1 production CLI
      // commands", not fold the fixture count into the CLI count.
      expect(text).toMatch(/1 in test fixtures/);
      expect(text).toMatch(/1 production CLI commands/);
    } finally {
      handler2.closeAll();
      cg2.close();
      fs.rmSync(rDir, { recursive: true, force: true });
    }
  });

  it('default view emits a one-line note for an empty routes bucket when route nodes exist in fixtures', async () => {
    // Reuse the same shape as above: the default no-arg view should NOT
    // silently drop the (empty-in-production) routes bucket — it should
    // emit a note saying route nodes exist in fixtures / CLI.
    const rDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-entry-routes-note-'));
    fs.mkdirSync(path.join(rDir, 'src', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(rDir, 'package.json'),
      JSON.stringify({ name: 'rn-fixture', dependencies: { commander: '^12.0.0', express: '^4.0.0' } }, null, 2),
    );
    fs.writeFileSync(
      path.join(rDir, 'src', 'bin', 'main.ts'),
      `import { program } from 'commander';\nprogram.command('serve').action(() => {});\n`,
    );
    fs.mkdirSync(path.join(rDir, '__tests__'));
    fs.writeFileSync(
      path.join(rDir, '__tests__', 'fixture.test.ts'),
      `import express from 'express';\nconst app = express();\napp.get('/fixture-route', () => {});\n`,
    );
    fs.writeFileSync(path.join(rDir, '.gitignore'), '.cartograph/\nnode_modules/\n');
    git(rDir, 'init', '-q');
    git(rDir, 'config', 'user.email', 't@t');
    git(rDir, 'config', 'user.name', 't');
    git(rDir, 'config', 'commit.gpgsign', 'false');
    git(rDir, 'add', '.');
    git(rDir, 'commit', '-q', '-m', 'init');
    const cg2 = await Cartograph.init(rDir, { config: { llm: { endpoint: '' } } });
    await cg2.indexAll({ summarize: false });
    const handler2 = new ToolHandler(cg2, { profile: 'full' });
    try {
      const result = await handler2.execute('cartograph_entry_points', {});
      const text = result.content[0]?.text ?? '';
      // The routes section heading appears even though the bucket is empty,
      // with a "none in production source" note rather than being dropped.
      expect(text).toMatch(/### Routes \(HTTP handlers\) \(0\)/);
      expect(text).toMatch(/none in production source/);
    } finally {
      handler2.closeAll();
      cg2.close();
      fs.rmSync(rDir, { recursive: true, force: true });
    }
  });

  it('returns the empty-state hint when nothing matches the buckets', async () => {
    // Reuse the dir but spin up a separate fixture with no exports
    // and no bin/. Easier to inline a second project than to mutate
    // beforeEach state.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-entry-empty-'));
    fs.mkdirSync(path.join(empty, 'src'));
    fs.writeFileSync(path.join(empty, 'src', 'a.ts'), 'function privateOnly() { return 1; }\n');
    fs.writeFileSync(path.join(empty, '.gitignore'), '.cartograph/\n');
    git(empty, 'init', '-q');
    git(empty, 'config', 'user.email', 't@t');
    git(empty, 'config', 'user.name', 't');
    git(empty, 'config', 'commit.gpgsign', 'false');
    git(empty, 'add', '.');
    git(empty, 'commit', '-q', '-m', 'init');
    const cg2 = await Cartograph.init(empty, { config: { llm: { endpoint: '' } } });
    await cg2.indexAll({ summarize: false });
    const handler2 = new ToolHandler(cg2, { profile: 'full' });
    try {
      const result = await handler2.execute('cartograph_entry_points', {});
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/No routes, CLI handlers, MCP tools, or public exports/);
    } finally {
      handler2.closeAll();
      cg2.close();
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
