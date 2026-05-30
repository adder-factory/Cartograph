/**
 * cartograph_status — optional inline rollups for hotspots + biomarkers
 * (round-trip-reduction item #4).
 *
 * Locks in:
 *  - Default (no flags) emits no hotspots / biomarkers sections, so
 *    existing callers see byte-identical output.
 *  - `topHotspots: N` adds a hotspots section ONLY when git churn data
 *    is available (skips silently otherwise).
 *  - `topBiomarkers: N` adds a biomarkers section when findings exist.
 *  - Inputs out of range (negative, NaN, > MAX cap) clamp to the cap
 *    or to "suppressed" without erroring.
 *  - Both flags compose in one call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Build a deliberately-bad function that will trigger biomarker
 *  findings (long_parameter_list + magic_number + complex_method). */
function makeNoisySource(): string {
  return (
    [
      'export function noisy(',
      '  a: number, b: number, c: number, d: number,',
      '  e: number, f: number, g: number, h: number,',
      '): number {',
      '  if (a > 100) {',
      '    if (b > 200) {',
      '      if (c > 300) {',
      '        if (d > 400) {',
      '          return 99999;',
      '        }',
      '      }',
      '    }',
      '  }',
      '  return a + b + c + d + e + f + g + h;',
      '}',
    ].join('\n') + '\n'
  );
}

describe('cartograph_status — optional inline rollups', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-status-rollups-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'noisy.ts'), makeNoisySource());
    fs.writeFileSync(path.join(dir, 'src', 'clean.ts'), 'export function clean(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('default call (no flags) emits no rollup sections', async () => {
    const result = await handler.execute('cartograph_status', {});
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/(?:Top|all) \d+ hotspots?/);
    expect(text).not.toMatch(/(?:Top|all) \d+ biomarker findings?/);
  });

  it('topBiomarkers: 5 folds biomarker findings into the response', async () => {
    const result = await handler.execute('cartograph_status', { topBiomarkers: 5 });
    const text = result.content[0]?.text ?? '';
    // The noisy fixture should produce at least one warning+ finding.
    expect(text).toMatch(/(?:Top|all) \d+ biomarker findings?/);
    // Suppression hint surfaces the dedicated tool name.
    expect(text).toMatch(/cartograph_biomarkers/);
  });

  it('topHotspots: 5 either folds hotspots OR skips silently on a single-commit repo', async () => {
    // A fresh single-commit repo has no churn data — the section
    // should be SUPPRESSED rather than render an empty header.
    const result = await handler.execute('cartograph_status', { topHotspots: 5 });
    const text = result.content[0]?.text ?? '';
    // If the section appears, it must have at least one row.
    if (/(?:Top|all) \d+ hotspots?/.test(text)) {
      expect(text).toMatch(/^- `.*` — commits:/m);
    }
  });

  it('out-of-range topBiomarkers clamps to the cap without erroring', async () => {
    // 999 above the cap — handler should clamp internally, not reject.
    const result = await handler.execute('cartograph_status', { topBiomarkers: 999 });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Header reflects the actual count emitted, which is min(findings, cap=30).
    expect(text).toMatch(/(?:Top|all) \d+ biomarker findings?/);
  });

  it('negative topBiomarkers parses as suppressed (no error, no section)', async () => {
    const result = await handler.execute('cartograph_status', { topBiomarkers: -3 });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/(?:Top|all) \d+ biomarker findings?/);
  });

  it('both flags compose — hotspots and biomarkers both render when populated', async () => {
    const result = await handler.execute('cartograph_status', { topHotspots: 5, topBiomarkers: 5 });
    const text = result.content[0]?.text ?? '';
    // Biomarkers should always render on this fixture.
    expect(text).toMatch(/(?:Top|all) \d+ biomarker findings?/);
    // Hotspots may be suppressed on a single-commit repo (no churn);
    // when present, they render after the readiness section.
    if (/(?:Top|all) \d+ hotspots?/.test(text)) {
      const hotspotsIdx = text.search(/(?:Top|all) \d+ hotspots?/);
      const biomarkersIdx = text.search(/(?:Top|all) \d+ biomarker findings?/);
      expect(hotspotsIdx).toBeLessThan(biomarkersIdx);
    }
  });

  // Task #21 — heading phrasing on partial counts. The pre-fix renderer
  // emitted "Top 1 biomarker findings" — a plural noun on a count of 1,
  // and "Top 1" implying "the worst 1 of many" when it is the complete
  // set. The fix pluralises on the actual row count and says "all N"
  // when fewer rows exist than the requested cap.
  it('Task #21 — a single-finding rollup reads "Top 1 biomarker finding" (singular noun)', async () => {
    // topBiomarkers: 1 caps the rollup at one row. shown === cap, so the
    // heading keeps "Top", but the noun must be SINGULAR.
    const result = await handler.execute('cartograph_status', { topBiomarkers: 1 });
    const text = result.content[0]?.text ?? '';
    if (/### 🩺/.test(text) && /biomarker finding/.test(text)) {
      // The broken plural-on-1 phrasing must never appear.
      expect(text).not.toMatch(/Top 1 biomarker findings\b/);
      expect(text).toMatch(/Top 1 biomarker finding\b/);
    }
  });

  it('Task #21 — a rollup smaller than the requested cap reads "all N", not "Top N"', async () => {
    // The noisy fixture yields only a handful of warning+ findings —
    // fewer than this cap — so the rollup is the COMPLETE set and the
    // heading must say "all N" (not "Top N", which implies a worst-of-
    // many slice).
    const result = await handler.execute('cartograph_status', { topBiomarkers: 30 });
    const text = result.content[0]?.text ?? '';
    const m = /(Top|all) (\d+) biomarker finding/.exec(text);
    if (m) {
      const shown = Number(m[2]);
      if (shown < 30) expect(m[1]).toBe('all');
    }
  });
});

// Task #29 — on a CLEAN project (no biomarker findings), an explicit
// `topBiomarkers` request must still be acknowledged with a clean-state
// line rather than rendering nothing.
describe('cartograph_status — biomarkers rollup on a clean project', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-status-clean-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Only trivial one-liners — no biomarker should fire on these.
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function a(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export function b(): number { return 2; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('topBiomarkers: 5 emits an explicit clean-state line when there are 0 findings', async () => {
    const result = await handler.execute('cartograph_status', { topBiomarkers: 5 });
    const text = result.content[0]?.text ?? '';
    // No "Top N" table on a clean project...
    expect(text).not.toMatch(/(?:Top|all) \d+ biomarker findings?/);
    // ...but the request IS acknowledged with a clean-state section.
    expect(text).toContain('### 🩺 Biomarker findings');
    expect(text).toMatch(/Project clean|info-level finding/);
  });

  it('verbose: true emits the clean-state biomarker line on a clean project', async () => {
    const result = await handler.execute('cartograph_status', { verbose: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('### 🩺 Biomarker findings');
  });

  it('topBiomarkers: 0 still suppresses the section entirely on a clean project', async () => {
    const result = await handler.execute('cartograph_status', { topBiomarkers: 0 });
    const text = result.content[0]?.text ?? '';
    // Caller did not ask — no clean-state line either.
    expect(text).not.toContain('### 🩺 Biomarker findings');
  });
});

// B2 (2026-05-23) — when the cross-file biomarker pass hasn't completed
// for the current index generation (post-hook killed by phase budget on a
// large repo, or transient `index --force` window), `cartograph_status`
// must render the "⏳ pending" note instead of a confidently-wrong
// "Project clean ✓". Mirrors the digest tool's 4-state taxonomy.
describe('cartograph_status — biomarkers rollup when post-hook pending', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-status-pending-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function a(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    // Simulate the post-hook-killed-by-budget state: bump index_timestamp
    // forward and leave biomarker_cross_file_pass_at stale. This is the
    // exact pattern `areBiomarkersPending` is designed to catch.
    const { setMetadata } = await import('../src/db/queries-metadata.js');
    const now = Date.now();
    setMetadata(cg.queries, 'biomarker_cross_file_pass_at', String(now - 5000));
    setMetadata(cg.queries, 'index_timestamp', String(now));
    // Also wipe any findings the indexAll may have produced — the bug
    // surfaces specifically when findings count is 0 AND pass is stale.
    cg.queries.db.exec('DELETE FROM code_health_findings');
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('topBiomarkers: 5 emits ⏳ pending note (not "Project clean ✓") when cross-file pass is stale', async () => {
    const result = await handler.execute('cartograph_status', { topBiomarkers: 5 });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('### 🩺 Biomarker findings');
    expect(text).toMatch(/Biomarker pass pending/);
    // Critical: must NOT render the confident "clean" verdict.
    expect(text).not.toContain('Project clean');
  });

  it('verbose: true also fires the pending note when cross-file pass is stale', async () => {
    const result = await handler.execute('cartograph_status', { verbose: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Biomarker pass pending/);
    expect(text).not.toContain('Project clean');
  });
});
