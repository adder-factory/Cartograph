/**
 * Tests for `cartograph_digest` (#12). Validates:
 *  - well-formed report on a populated repo (all sections render
 *    in stable order, headline counts present, suggested queries
 *    appear)
 *  - graceful degradation when individual sections have no data
 *    (empty repo) — falls back to per-section hints, never throws
 *  - section caps respected
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

describe('cartograph_digest (#12)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-digest-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // A few exported functions, one with no in-tree caller (public).
    fs.writeFileSync(
      path.join(dir, 'src', 'lib.ts'),
      'export function publicApi() { return 42; }\n' +
        'export function helper() { return 1; }\n' +
        'export function consumer() { return helper(); }\n',
    );
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

  it('renders a well-formed digest with all top-level sections', async () => {
    const result = await handler.execute('cartograph_digest', {});
    const text = result.content[0]?.text ?? '';
    // Headline + every section in order.
    expect(text).toMatch(/^# 📊 Cartograph digest/m);
    expect(text).toContain('files');
    expect(text).toContain('symbols');
    expect(text).toMatch(/## 🔥 Hotspots/);
    expect(text).toMatch(/## 🩺 Code Health/);
    expect(text).toMatch(/## 🚪 Entry points/);
    expect(text).toMatch(/## 🕒 Recently touched files/);
    expect(text).toMatch(/## 🧭 Suggested next queries/);
  });

  it('Task #8 — recent-churn section labels the commit count as lifetime, not windowed', async () => {
    // The `recencyDays` filter selects files TOUCHED in the window, but
    // the index has no per-file windowed commit count — `getHotspots`
    // returns the lifetime `commit_count`. The digest must NOT present
    // that figure under wording that implies "commits in the last 30
    // days"; it must say "lifetime commits" and add the genuine
    // windowed signal (when the file was last touched).
    const result = await handler.execute('cartograph_digest', {});
    const text = result.content[0]?.text ?? '';
    const idx = text.indexOf('## 🕒 Recently touched files');
    expect(idx).toBeGreaterThan(-1);
    const nextSection = text.indexOf('## ', idx + 5);
    const section = nextSection > 0 ? text.slice(idx, nextSection) : text.slice(idx);
    // Heading frames the window as "touched in last N days", not "N days of churn".
    expect(section).toMatch(/touched in last \d+ days/);
    if (/^- `/m.test(section)) {
      // Populated rows must say "lifetime commits" and carry a
      // last-touched relative-age token — never a bare "N commits".
      expect(section).toMatch(/lifetime commits/);
      expect(section).toMatch(/touched (today|\d+ days? ago)|last touched: unknown/);
      expect(section).not.toMatch(/\d+ commits,/);
    }
  });

  it('surfaces public exports under entry points (zero in-tree callers)', async () => {
    const result = await handler.execute('cartograph_digest', {});
    const text = result.content[0]?.text ?? '';
    // publicApi has no in-tree callers → should appear under
    // "Public exports". helper IS called by consumer → should NOT.
    expect(text).toContain('publicApi');
  });

  it('includes context-sensitive suggested queries', async () => {
    const result = await handler.execute('cartograph_digest', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/cartograph_files/);
    expect(text).toMatch(/cartograph_entry_points/);
    expect(text).toMatch(/cartograph_context/);
    expect(text).toMatch(/cartograph_find/);
  });

  it('falls back to per-section hints when data is missing (graceful)', async () => {
    // Fresh tiny repo: no biomarker findings (no big functions to
    // trigger them), no git churn beyond the init commit.
    // The digest should render headers + the "no data, run X" hints
    // for the empty sections rather than crashing.
    const result = await handler.execute('cartograph_digest', {});
    const text = result.content[0]?.text ?? '';
    // At least one section should report no data (likely Hotspots
    // or Code Health on this minimal fixture).
    const hasFallback = /Project clean ✓|No biomarker data|No hotspot data|No HTTP routes|No files touched/.test(text);
    expect(hasFallback).toBe(true);
  });

  it('FRICTION-1 — Code Health says "clean" (not "not analyzed") on an indexed project with 0 findings', async () => {
    // A genuinely-clean indexed repo: one tiny exported function that
    // IS consumed in-tree (so no unused_export finding) and is too
    // small to trip any per-symbol biomarker. The Code Health section
    // must report an affirmative clean result, NOT the "run `cartograph
    // admin index`" unrun hint — the project HAS been indexed.
    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-digest-clean-'));
    fs.mkdirSync(path.join(cleanDir, 'src'));
    fs.writeFileSync(
      path.join(cleanDir, 'src', 'index.ts'),
      'function add(a: number, b: number) { return a + b; }\n' +
        'export function main() { return add(1, 2); }\n' +
        'main();\n',
    );
    fs.writeFileSync(path.join(cleanDir, '.gitignore'), '.cartograph/\n');
    git(cleanDir, 'init', '-q');
    git(cleanDir, 'config', 'user.email', 't@t');
    git(cleanDir, 'config', 'user.name', 't');
    git(cleanDir, 'config', 'commit.gpgsign', 'false');
    git(cleanDir, 'add', '.');
    git(cleanDir, 'commit', '-q', '-m', 'init');
    const cleanCg = await Cartograph.init(cleanDir, { config: { llm: { endpoint: '' } } });
    await cleanCg.indexAll({ summarize: false });
    const cleanHandler = new ToolHandler(cleanCg);
    try {
      const result = await cleanHandler.execute('cartograph_digest', {});
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/## 🩺 Code Health/);
      // Guard the test premise: this fixture really must be clean.
      // If a future biomarker change makes it dirty, fail loudly here
      // rather than silently passing the wrong assertion.
      expect(text).toContain('Project clean ✓');
      // Must NOT conflate "clean" with "never analyzed".
      expect(text).not.toContain('No biomarker data');
      expect(text).not.toContain('analysis runs on');
    } finally {
      cleanHandler.closeAll();
      cleanCg.close();
      fs.rmSync(cleanDir, { recursive: true, force: true });
    }
  });

  it('Code Health reconciles header count with the (capped) finding list via an elision marker', async () => {
    // A repo with many unused exports → many info-tier findings. The
    // digest Code Health list caps at 5 rows, so on a >5-finding project
    // the header count ("N findings") and the rendered rows disagree
    // unless an explicit "+M more" elision marker is printed.
    const manyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-digest-elide-'));
    fs.mkdirSync(path.join(manyDir, 'src'));
    // 9 exported functions with zero callers — each trips unused_export.
    let body = '';
    for (let i = 0; i < 9; i++) {
      body += `export function unusedFn${i}() { return ${i}; }\n`;
    }
    fs.writeFileSync(path.join(manyDir, 'src', 'lib.ts'), body);
    fs.writeFileSync(path.join(manyDir, '.gitignore'), '.cartograph/\n');
    git(manyDir, 'init', '-q');
    git(manyDir, 'config', 'user.email', 't@t');
    git(manyDir, 'config', 'user.name', 't');
    git(manyDir, 'config', 'commit.gpgsign', 'false');
    git(manyDir, 'add', '.');
    git(manyDir, 'commit', '-q', '-m', 'init');
    const manyCg = await Cartograph.init(manyDir, { config: { llm: { endpoint: '' } } });
    await manyCg.indexAll({ summarize: false });
    const manyHandler = new ToolHandler(manyCg);
    try {
      const result = await manyHandler.execute('cartograph_digest', {});
      const text = result.content[0]?.text ?? '';
      const healthIdx = text.indexOf('## 🩺 Code Health');
      expect(healthIdx).toBeGreaterThan(-1);
      const nextSection = text.indexOf('## ', healthIdx + 5);
      const healthSection = nextSection > 0 ? text.slice(healthIdx, nextSection) : text.slice(healthIdx);
      // Parse "N findings" from the header.
      const headerMatch = /Code Health — (\d+) findings/.exec(healthSection);
      expect(headerMatch).not.toBeNull();
      const headerCount = Number(headerMatch![1]);
      // Count the rendered finding rows ("- `name` (kind) — ...").
      const rowCount = (healthSection.match(/^- `/gm) ?? []).length;
      if (headerCount > rowCount) {
        // Header claims more than is listed → the elision marker MUST
        // appear so the agent isn't misled into thinking data is missing.
        expect(healthSection).toMatch(/more finding\(s\) not shown/);
        expect(healthSection).toMatch(/cartograph_biomarkers/);
      }
    } finally {
      manyHandler.closeAll();
      manyCg.close();
      fs.rmSync(manyDir, { recursive: true, force: true });
    }
  });

  it('FRICTION-2 — digest public exports are a subset of entry_points public_exports (edge-kind parity)', async () => {
    // The pre-2026-05-15 digest checked only `calls` edges while
    // entry-points used the full set (calls + references + type-usage).
    // This test writes a fixture where a function is referenced from an
    // object literal (emits a `references` edge, not a `calls` edge) and
    // asserts that NEITHER digest nor entry-points flags it as a "public
    // export with no in-tree callers". Without the fix, digest would
    // include it because it only checked `['calls']`.
    const refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-digest-ref-'));
    fs.mkdirSync(path.join(refDir, 'src'));
    // referencedFn is "called" via an object-property reference — emits
    // a `references` edge from the object literal, not a `calls` edge.
    fs.writeFileSync(path.join(refDir, 'src', 'handler.ts'), 'export function referencedFn() { return 1; }\n');
    fs.writeFileSync(
      path.join(refDir, 'src', 'dispatch.ts'),
      'import { referencedFn } from "./handler.js";\n' + 'export const DISPATCH = { fn: referencedFn };\n',
    );
    // truePublicFn has no in-tree callers at all — must appear in both.
    fs.writeFileSync(path.join(refDir, 'src', 'public.ts'), 'export function truePublicFn() { return 2; }\n');
    fs.writeFileSync(path.join(refDir, '.gitignore'), '.cartograph/\n');
    const { execFileSync } = await import('child_process');
    function git2(cwd: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
    git2(refDir, 'init', '-q');
    git2(refDir, 'config', 'user.email', 't@t');
    git2(refDir, 'config', 'user.name', 't');
    git2(refDir, 'config', 'commit.gpgsign', 'false');
    git2(refDir, 'add', '.');
    git2(refDir, 'commit', '-q', '-m', 'init');
    const cg2 = await Cartograph.init(refDir, { config: { llm: { endpoint: '' } } });
    await cg2.indexAll({ summarize: false });
    const handler2 = new ToolHandler(cg2);
    try {
      const [digestResult, epResult] = await Promise.all([
        handler2.execute('cartograph_digest', {}),
        handler2.execute('cartograph_entry_points', { bucket: 'public_exports', limit: 200 }),
      ]);
      const digestText = digestResult.content[0]?.text ?? '';
      const epText = epResult.content[0]?.text ?? '';

      // truePublicFn should appear in entry_points public_exports.
      if (epText.includes('### Public exports')) {
        expect(epText).toContain('truePublicFn');
      }

      // referencedFn has a `references` edge — must NOT appear in either
      // tool's public-exports section after the fix.
      // entry-points already had the fix; digest is fixed in FRICTION-2.
      if (digestText.includes('Public exports')) {
        const digestPubIdx = digestText.indexOf('Public exports');
        const digestPubSection = digestText.slice(digestPubIdx);
        expect(digestPubSection).not.toContain('referencedFn');
      }
      if (epText.includes('### Public exports')) {
        const epPubIdx = epText.indexOf('### Public exports');
        const epPubSection = epText.slice(epPubIdx);
        expect(epPubSection).not.toContain('referencedFn');
      }
    } finally {
      handler2.closeAll();
      cg2.close();
      fs.rmSync(refDir, { recursive: true, force: true });
    }
  });
});
