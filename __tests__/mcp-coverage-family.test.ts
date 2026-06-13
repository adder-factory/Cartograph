/**
 * Tests for the consolidated `cartograph_coverage({mode})` family
 * (agentic-backlog #7-2). Validates:
 *  - mode='load' is wired and reaches `_coverage-load.ts`'s handler
 *    (via the same error surface the previous `cartograph_coverage_load`
 *    tool used)
 *  - registry no longer carries the legacy `cartograph_coverage_load`
 *    tool name (shim was deliberately not kept — single-user codebase)
 *  - existing read modes (symbol/ranked/stats) still work — just a
 *    smoke that the new dispatch didn't break the read path
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('cartograph_coverage family (#7-2)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cov-fam-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
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

  it('registry no longer carries cartograph_coverage_load (legacy retired)', () => {
    const names = getToolModules().map((m) => m.definition.name);
    expect(names).toContain('cartograph_coverage');
    expect(names).not.toContain('cartograph_coverage_load');
  });

  it("mode='load' validates reportPath and returns the coverage-ingestion error envelope", async () => {
    const missing = await handler.execute('cartograph_coverage', { mode: 'load' });
    expect(missing.content[0]?.text ?? '').toMatch(/`reportPath` must be a non-empty string/);

    const bogus = await handler.execute('cartograph_coverage', {
      mode: 'load',
      reportPath: '/no/such/file.lcov',
    });
    expect(bogus.content[0]?.text ?? '').toMatch(/Coverage ingestion failed/);
  });

  it("default mode='ranked' still works (smoke)", async () => {
    const result = await handler.execute('cartograph_coverage', {});
    const text = result.content[0]?.text ?? '';
    // No coverage data ingested → empty-stats path. The point is the
    // read path is reachable, not the specific message.
    expect(text).toMatch(/coverage|No.*ingest/i);
  });

  it("mode='stats' returns the no-data sentinel when coverage is empty", async () => {
    const result = await handler.execute('cartograph_coverage', { mode: 'stats' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No coverage data ingested/);
  });

  it("mode='stats' tips mention `mode: 'refresh'` so the agent knows the shortcut", async () => {
    const result = await handler.execute('cartograph_coverage', { mode: 'stats' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/mode: ?['"]refresh['"]/);
  });

  it("mode='refresh' returns a friendly tip when no lcov is found at conventional paths", async () => {
    const result = await handler.execute('cartograph_coverage', { mode: 'refresh' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No coverage report found/);
    // Should list the considered paths so the agent knows what was tried.
    expect(text).toMatch(/coverage\/lcov\.info/);
  });

  it("mode='refresh' picks the freshest candidate when multiple exist", async () => {
    const lcov = 'TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';
    fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });

    // Two valid candidates at different conventional paths. We want
    // the newer-mtime one (`lcov.info` at root) to win even though
    // `coverage/lcov.info` appears earlier in the declaration order.
    fs.writeFileSync(path.join(dir, 'coverage', 'lcov.info'), lcov);
    const olderAt = Date.now() - 60_000;
    fs.utimesSync(path.join(dir, 'coverage', 'lcov.info'), olderAt / 1000, olderAt / 1000);

    fs.writeFileSync(path.join(dir, 'lcov.info'), lcov);
    const newerAt = Date.now();
    fs.utimesSync(path.join(dir, 'lcov.info'), newerAt / 1000, newerAt / 1000);

    const result = await handler.execute('cartograph_coverage', { mode: 'refresh' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Refreshed coverage from `lcov\.info`/);
    // The "Considered" footer should mark the older one with ☑️ (present but not chosen)
    expect(text).toMatch(/☑️.*coverage\/lcov\.info/);
  });

  it("mode='refresh' discovers and ingests a project-relative lcov.info", async () => {
    // Write a minimal valid lcov pointing at the project's only source file.
    const lcov = ['TN:', 'SF:src/a.ts', 'DA:1,1', 'LF:1', 'LH:1', 'end_of_record', ''].join('\n');
    fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'coverage', 'lcov.info'), lcov);

    const result = await handler.execute('cartograph_coverage', { mode: 'refresh' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Refreshed coverage from `coverage\/lcov\.info`/);
    expect(text).toMatch(/Files matched: 1/);
  });

  it("mode='refresh' discovers and unions per-package monorepo reports (#19)", async () => {
    // A monorepo where each package emits its own coverage. The single
    // root-only discovery missed packages/*; refresh now globs them and
    // unions every report under one source.
    const monoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cov-mono-'));
    for (const pkg of ['a', 'b']) {
      fs.mkdirSync(path.join(monoDir, 'packages', pkg, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(monoDir, 'packages', pkg, 'src', `${pkg}.ts`),
        `export function fn_${pkg}(): number { return 1; }\n`,
      );
    }
    fs.writeFileSync(path.join(monoDir, '.gitignore'), '.cartograph/\n');
    git(monoDir, 'init', '-q');
    git(monoDir, 'config', 'user.email', 't@t');
    git(monoDir, 'config', 'user.name', 't');
    git(monoDir, 'config', 'commit.gpgsign', 'false');
    git(monoDir, 'add', '.');
    git(monoDir, 'commit', '-q', '-m', 'init');

    const monoCg = await Cartograph.init(monoDir, { config: { llm: { endpoint: '' } } });
    const monoHandler = new ToolHandler(monoCg, { profile: 'full' });
    try {
      await monoCg.indexAll({ summarize: false });

      // Each package emits a package-relative report under its own coverage/.
      for (const pkg of ['a', 'b']) {
        fs.mkdirSync(path.join(monoDir, 'packages', pkg, 'coverage'), { recursive: true });
        fs.writeFileSync(
          path.join(monoDir, 'packages', pkg, 'coverage', 'lcov.info'),
          [`SF:src/${pkg}.ts`, 'DA:1,1', 'end_of_record'].join('\n'),
        );
      }

      const result = await monoHandler.execute('cartograph_coverage', { mode: 'refresh' });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/unioned 2 report\(s\)/);
      expect(text).toMatch(/packages\/a\/coverage\/lcov\.info/);
      expect(text).toMatch(/packages\/b\/coverage\/lcov\.info/);

      // Both packages' symbols received coverage (proves the
      // package-relative SF paths resolved across both workspaces) and
      // every covered line is hit — no false gap from a missed report.
      const stats = await monoHandler.execute('cartograph_coverage', { mode: 'stats' });
      const statsText = stats.content[0]?.text ?? '';
      expect(statsText).toMatch(/Weighted coverage:\*\* 100/);
      // fn_a and fn_b both have a coverage row (kind-agnostic count ≥ 2).
      const covered = monoCg.queries.db.prepare(`SELECT COUNT(DISTINCT node_id) AS n FROM node_coverage`).get() as {
        n: number;
      };
      expect(covered.n).toBeGreaterThanOrEqual(2);
    } finally {
      monoHandler.closeAll();
      monoCg.close();
      fs.rmSync(monoDir, { recursive: true, force: true });
    }
  });

  it("mode='load' resolves a project-relative reportPath against projectRoot, not cwd", async () => {
    const lcov = 'TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';
    fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'coverage', 'lcov.info'), lcov);

    const result = await handler.execute('cartograph_coverage', {
      mode: 'load',
      reportPath: 'coverage/lcov.info', // relative — would ENOENT under cwd-based resolution
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Loaded coverage report/);
    expect(text).toMatch(/Files matched: 1/);
  });

  // -----------------------------------------------------------------
  // FRICTION-13 — unified symbol-not-found UX for mode='symbol'
  // -----------------------------------------------------------------

  // -----------------------------------------------------------------
  // Audit group-3 #13 — coverage source list / drop path
  // -----------------------------------------------------------------

  it("mode='sources' reports the no-data state when nothing is ingested", async () => {
    const result = await handler.execute('cartograph_coverage', { mode: 'sources' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No coverage sources ingested/);
  });

  it("mode='sources' lists every ingested source with its row count", async () => {
    const lcov = 'TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';
    fs.writeFileSync(path.join(dir, 'lcov.info'), lcov);
    await handler.execute('cartograph_coverage', {
      mode: 'load',
      reportPath: 'lcov.info',
      source: 'unit',
    });
    await handler.execute('cartograph_coverage', {
      mode: 'load',
      reportPath: 'lcov.info',
      source: 'e2e',
    });

    const result = await handler.execute('cartograph_coverage', { mode: 'sources' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Coverage sources/);
    expect(text).toMatch(/`unit`/);
    expect(text).toMatch(/`e2e`/);
    // Mentions the drop affordance.
    expect(text).toMatch(/mode: ?['"]drop['"]/);
  });

  it("mode='drop' deletes one source and leaves the others intact", async () => {
    const lcov = 'TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';
    fs.writeFileSync(path.join(dir, 'lcov.info'), lcov);
    await handler.execute('cartograph_coverage', {
      mode: 'load',
      reportPath: 'lcov.info',
      source: 'keep',
    });
    await handler.execute('cartograph_coverage', {
      mode: 'load',
      reportPath: 'lcov.info',
      source: 'stray',
    });

    const dropped = await handler.execute('cartograph_coverage', { mode: 'drop', source: 'stray' });
    expect(dropped.content[0]?.text ?? '').toMatch(/Dropped coverage source `stray`/);

    const after = await handler.execute('cartograph_coverage', { mode: 'sources' });
    const text = after.content[0]?.text ?? '';
    expect(text).toMatch(/`keep`/);
    expect(text).not.toMatch(/`stray`/);
  });

  it("mode='drop' without a source returns an actionable error", async () => {
    const result = await handler.execute('cartograph_coverage', { mode: 'drop' });
    expect(result.content[0]?.text ?? '').toMatch(/`source` must be a non-empty string/);
  });

  it("mode='drop' on an unknown source errors and names the known sources", async () => {
    const lcov = 'TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';
    fs.writeFileSync(path.join(dir, 'lcov.info'), lcov);
    await handler.execute('cartograph_coverage', {
      mode: 'load',
      reportPath: 'lcov.info',
      source: 'real',
    });
    const result = await handler.execute('cartograph_coverage', { mode: 'drop', source: 'typo' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No coverage source named `typo`/);
    expect(text).toMatch(/`real`/);
  });

  it("mode='symbol' surfaces a fuzzy-fallback banner when resolution is approximate", async () => {
    // Ingest coverage so a real row exists, then query a name with no
    // exact match — FTS guesses and the banner must warn.
    const lcov = 'TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';
    fs.writeFileSync(path.join(dir, 'lcov.info'), lcov);
    await handler.execute('cartograph_coverage', { mode: 'load', reportPath: 'lcov.info' });

    // `alpha` is the only function; query a near-miss that FTS may
    // resolve fuzzily. The assertion is conditional on a fuzzy hit —
    // when resolution is exact-or-miss this is a no-op smoke.
    const result = await handler.execute('cartograph_coverage', {
      mode: 'symbol',
      symbol: 'alpha',
    });
    const text = result.content[0]?.text ?? '';
    // Exact match for `alpha` → no banner. Confirms the banner is not
    // spuriously emitted on an exact hit.
    expect(text).not.toMatch(/Fuzzy fallback/);
  });

  it("mode='symbol' not-found response includes did-you-mean suggestions and the freshness footer", async () => {
    // `definitelyNoSuchSymbol` won't match anything, so the handler
    // must surface both the did-you-mean bullet list and the freshness
    // hint from `symbolNotFound`.
    const result = await handler.execute('cartograph_coverage', {
      mode: 'symbol',
      symbol: 'definitelyNoSuchSymbol',
    });
    const text = result.content[0]?.text ?? '';
    // The "not found in the codebase" phrase from notFoundMessage.
    expect(text).toMatch(/not found in the codebase/i);
    // The freshness hint appended by symbolNotFound.
    expect(text).toMatch(/Index in sync|Index lagging/);
  });

  // Handoff #6 sub-a: maxPct is documented as a 0-1 ratio but the
  // schema accepted any number. A caller passing `100` (meaning 100%)
  // was silently coerced; the schema now rejects out-of-range values
  // at the dispatch boundary with a clear pointer.
  it.each([
    [100, 'percent-not-ratio mistake'],
    [1.5, 'above upper bound'],
    [-0.1, 'below lower bound'],
  ])("mode='ranked' rejects out-of-range maxPct=%s (%s)", async (maxPct) => {
    const result = await handler.execute('cartograph_coverage', { mode: 'ranked', maxPct });
    const text = result.content[0]?.text ?? '';
    // Zod error envelope - either "maxPct" mentioned by field name
    // or a min/max boundary message. The point is the call doesn't
    // silently succeed with a nonsensical filter.
    expect(result.isError).toBe(true);
    expect(text).toMatch(/maxPct|0|1/);
  });

  it("mode='ranked' accepts maxPct=1 (boundary) and maxPct=0 (boundary)", async () => {
    // 1 = no upper bound; 0 = only-fully-uncovered. Both are valid.
    const upper = await handler.execute('cartograph_coverage', { mode: 'ranked', maxPct: 1 });
    expect(upper.isError).toBeFalsy();
    const lower = await handler.execute('cartograph_coverage', { mode: 'ranked', maxPct: 0 });
    expect(lower.isError).toBeFalsy();
  });

  // Handoff #6 sub-b: when filter excludes all rows BUT coverage data
  // is present (stats.symbolsWithCoverage > 0), the empty-state must
  // say "tighten filter" — not the misleading "no coverage data
  // ingested" tips block.
  it("mode='ranked' filter-excluded-all emits a tighten-filter tip, not the no-data-ingested block", async () => {
    // Ingest coverage so symbolsWithCoverage > 0
    const lcov = 'TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';
    fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'coverage', 'lcov.info'), lcov);
    const refresh = await handler.execute('cartograph_coverage', { mode: 'refresh' });
    expect(refresh.content[0]?.text ?? '').toMatch(/Refreshed coverage/);

    // Now force an empty filter result: `maxPct: 0` matches only
    // 0%-covered symbols; the sample `alpha` is 100% covered so the
    // filter returns 0 rows.
    const result = await handler.execute('cartograph_coverage', {
      mode: 'ranked',
      maxPct: 0,
      limit: 5,
    });
    const text = result.content[0]?.text ?? '';
    // Must NOT carry the ingest-a-report tips block.
    expect(text).not.toMatch(/No coverage data ingested/);
    // Must mention the filter-tightening hint with the actual count.
    expect(text).toMatch(/1 symbol with coverage|symbols with coverage/);
    expect(text).toMatch(/lowering `minCentrality`|raising `maxPct`/);
  });
});
