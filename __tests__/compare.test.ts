/**
 * compareToRef — structural delta vs a git ref.
 *
 * Tests the cumulative `+/-/~` symbol diff that closes the agent's
 * edit loop. We commit a baseline, edit working-tree files, and
 * confirm the report matches what we did.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { compareToRef } from '../src/compare/index.js';
import { appendEdgesDelta } from '../src/mcp/tools/compare.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function setupRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

describe('compareToRef', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    await initGrammars();
    await loadAllGrammars();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-compare-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `export function alpha(): number { return 1; }\nexport function beta(): number { return 2; }\nexport function gamma(): number { return 3; }\n`,
    );
    fs.writeFileSync(path.join(testDir, '.gitignore'), '.cartograph/\n');
    fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'cg-compare', version: '0.0.0' }));
    setupRepo(testDir);
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'baseline');
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reports added/removed/modified symbols vs HEAD', async () => {
    // Edit the file: remove `gamma`, modify `alpha`'s signature, add `delta`.
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `export function alpha(x: number): number { return x; }\nexport function beta(): number { return 2; }\nexport function delta(): number { return 4; }\n`,
    );

    const result = await compareToRef(cg);
    expect(result.error).toBeUndefined();
    expect(result.ref).toBe('HEAD');
    expect(result.filesScanned).toBe(1);

    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file).toBeDefined();
    expect(file!.hadBaseline).toBe(true);
    expect(file!.hadCurrent).toBe(true);
    expect(file!.added.map((s) => s.name)).toContain('delta');
    expect(file!.removed.map((s) => s.name)).toContain('gamma');
    const alphaMod = file!.modified.find((s) => s.name === 'alpha');
    expect(alphaMod).toBeDefined();
    expect(alphaMod!.modifiedReasons).toContain('signature changed');

    expect(result.totals.added).toBeGreaterThanOrEqual(1);
    expect(result.totals.removed).toBeGreaterThanOrEqual(1);
    expect(result.totals.modified).toBeGreaterThanOrEqual(1);
  });

  it('treats untracked files as new additions', async () => {
    fs.writeFileSync(path.join(testDir, 'src', 'fresh.ts'), `export function brandNew(): void { return; }\n`);

    const result = await compareToRef(cg);
    const file = result.files.find((f) => f.filePath === 'src/fresh.ts');
    expect(file).toBeDefined();
    expect(file!.hadBaseline).toBe(false);
    expect(file!.added.map((s) => s.name)).toContain('brandNew');
    expect(file!.removed).toHaveLength(0);
  });

  it('honours config.largeFunctionThreshold (F#12 slice 1 — env-var priming)', async () => {
    // Drop a brand-new file with one outer + one nested helper. At the
    // default threshold (500) compareToRef extracts BOTH; at threshold=0
    // it extracts only the outer — the nested helper is suppressed,
    // confirming compareToRef's env-var priming actually reaches the
    // extractor in src/extraction/ts-extract-bodies.ts.
    fs.writeFileSync(
      path.join(testDir, 'src', 'nested-helper.ts'),
      [
        'export function withHelper(): number {',
        '  function helperFn(x: number): number { return x + 1; }',
        '  return helperFn(41);',
        '}',
        '',
      ].join('\n'),
    );

    // Default threshold path: helperFn shows up as added.
    cg.config.largeFunctionThreshold = 500;
    const eagerResult = await compareToRef(cg);
    const eagerFile = eagerResult.files.find((f) => f.filePath === 'src/nested-helper.ts');
    expect(eagerFile).toBeDefined();
    const eagerNames = new Set(eagerFile!.added.map((s) => s.name));
    expect(eagerNames.has('withHelper')).toBe(true);
    expect(eagerNames.has('helperFn')).toBe(true);

    // Opt-out path: threshold=0 disables eager nested-fn extraction; the
    // diff should NOT report helperFn as added.
    cg.config.largeFunctionThreshold = 0;
    const optOutResult = await compareToRef(cg);
    const optOutFile = optOutResult.files.find((f) => f.filePath === 'src/nested-helper.ts');
    expect(optOutFile).toBeDefined();
    const optOutNames = new Set(optOutFile!.added.map((s) => s.name));
    expect(optOutNames.has('withHelper')).toBe(true);
    expect(optOutNames.has('helperFn')).toBe(false);
  });

  it('treats deleted files as full-file removals', async () => {
    fs.unlinkSync(path.join(testDir, 'src', 'lib.ts'));

    const result = await compareToRef(cg);
    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file).toBeDefined();
    expect(file!.hadCurrent).toBe(false);
    expect(file!.added).toHaveLength(0);
    const removedNames = new Set(file!.removed.map((s) => s.name));
    expect(removedNames.has('alpha')).toBe(true);
    expect(removedNames.has('beta')).toBe(true);
    expect(removedNames.has('gamma')).toBe(true);
  });

  it('reports no changes when working tree matches the ref', async () => {
    const result = await compareToRef(cg);
    expect(result.error).toBeUndefined();
    expect(result.totals).toEqual({ added: 0, removed: 0, modified: 0 });
  });

  it('respects pathFilter to scope the diff', async () => {
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `export function alpha(): number { return 99; }\nexport function beta(): number { return 2; }\nexport function gamma(): number { return 3; }\n`,
    );
    fs.mkdirSync(path.join(testDir, 'other'));
    fs.writeFileSync(path.join(testDir, 'other', 'thing.ts'), `export function elsewhere(): void {}\n`);

    const result = await compareToRef(cg, { pathFilter: 'other/' });
    expect(result.filesScanned).toBe(1);
    expect(result.files[0]!.filePath).toBe('other/thing.ts');
  });

  it('records pathFilter context when the filter excludes every changed file', async () => {
    // Modify a tracked file so the tree genuinely differs from HEAD,
    // then apply a filter that matches none of the changed paths.
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `export function alpha(): number { return 42; }\nexport function beta(): number { return 2; }\nexport function gamma(): number { return 3; }\n`,
    );

    const result = await compareToRef(cg, { pathFilter: 'zzz-nonexistent/' });
    // The filter excluded everything — filesScanned is 0, but the
    // pathFilter context must record that files DID change overall so
    // the renderer doesn't print the misleading "No files differ".
    expect(result.filesScanned).toBe(0);
    expect(result.pathFilter).toBeDefined();
    expect(result.pathFilter!.value).toBe('zzz-nonexistent/');
    expect(result.pathFilter!.changedBeforeFilter).toBeGreaterThan(0);
    expect(result.pathFilter!.matched).toBe(0);
  });

  it('ref-to-ref reverse-direction diff is not silently empty (task #10)', async () => {
    // Commit a second revision so HEAD differs from the baseline commit.
    const baseline = git(testDir, 'rev-parse', 'HEAD');
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `export function alpha(): number { return 1; }\nexport function beta(): number { return 2; }\nexport function epsilon(): number { return 5; }\n`,
    );
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'add epsilon, drop gamma');
    const headRev = git(testDir, 'rev-parse', 'HEAD');

    // Reverse direction: ref = newer commit, head = older ancestor.
    // Under three-dot `ref...head` the merge-base IS head, so git
    // reports zero changed files — a silent empty result. Two-dot
    // `ref..head` (the fix) diffs the two refs directly and surfaces
    // the symbol-level delta.
    const result = await compareToRef(cg, { ref: headRev, head: baseline });
    expect(result.error).toBeUndefined();
    expect(result.filesChanged).toBe(1);
    // Label must match the two-dot direction actually diffed.
    expect(result.ref).toBe(`${headRev}..${baseline}`);
    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file).toBeDefined();
    // Going head→base: epsilon is removed, gamma comes back.
    expect(file!.removed.map((s) => s.name)).toContain('epsilon');
    expect(file!.added.map((s) => s.name)).toContain('gamma');
  });

  it('returns a structured error when git is unavailable on a non-repo', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-compare-nogit-'));
    fs.mkdirSync(path.join(nonRepo, 'src'));
    fs.writeFileSync(path.join(nonRepo, 'src', 'a.ts'), `export function a() {}\n`);
    fs.writeFileSync(path.join(nonRepo, 'package.json'), JSON.stringify({ name: 'no-git', version: '0.0.0' }));
    const cg2 = await Cartograph.init(nonRepo, { config: { llm: { endpoint: '' } } });
    try {
      await cg2.indexAll({ summarize: false });
      const result = await compareToRef(cg2);
      expect(result.error).toBeDefined();
      expect(result.totals).toEqual({ added: 0, removed: 0, modified: 0 });
    } finally {
      cg2.close();
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('treats `git mv` as deletion of old path + addition of new path', async () => {
    // Renames are reported with --no-renames so the agent sees the
    // structural shape: old name's symbols removed, new name's added.
    git(testDir, 'mv', 'src/lib.ts', 'src/renamed.ts');

    const result = await compareToRef(cg);
    const removed = result.files.find((f) => f.filePath === 'src/lib.ts');
    const added = result.files.find((f) => f.filePath === 'src/renamed.ts');
    expect(removed).toBeDefined();
    expect(added).toBeDefined();
    expect(removed!.hadCurrent).toBe(false);
    expect(added!.hadBaseline).toBe(false);
    const removedNames = new Set(removed!.removed.map((s) => s.name));
    expect(removedNames.has('alpha')).toBe(true);
    expect(removedNames.has('beta')).toBe(true);
    const addedNames = new Set(added!.added.map((s) => s.name));
    expect(addedNames.has('alpha')).toBe(true);
    expect(addedNames.has('beta')).toBe(true);
  });

  it('attaches biomarker findings when includeBiomarkers=true', async () => {
    // Replace alpha with a method that triggers nested_complexity.
    const gnarly = [
      'export function alpha(x: number): number {',
      '  if (x > 0) {',
      '    if (x > 1) {',
      '      if (x > 2) {',
      '        if (x > 3) {',
      '          if (x > 4) {',
      '            return 99;',
      '          }',
      '        }',
      '      }',
      '    }',
      '  }',
      '  return 0;',
      '}',
      'export function beta(): number { return 2; }',
      'export function gamma(): number { return 3; }',
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), gnarly + '\n');
    await cg.sync({ summarize: false });

    const result = await compareToRef(cg, { includeBiomarkers: true });
    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    const alpha = file!.modified.find((s) => s.name === 'alpha');
    expect(alpha).toBeDefined();
    // alpha's findings are attached when includeBiomarkers is on. The
    // exact set depends on thresholds, but at least one finding should
    // appear given how deeply nested we made it.
    expect(alpha!.findings).toBeDefined();
    expect(alpha!.findings!.length).toBeGreaterThan(0);
  });

  it('findingsDelta reports added findings when an edit introduces a regression', async () => {
    // Replace alpha (clean 1-liner) with deeply nested 80+ branches to
    // trigger large_method / complex_method / nested_complexity. The
    // baseline alpha had none of these.
    const gnarly = [
      'export function alpha(x: number): number {',
      '  let r = 0;',
      ...Array.from({ length: 80 }, (_, i) => `  if (x === ${i}) r += ${i};`),
      '  if (x > 0) {',
      '    if (x > 1) {',
      '      if (x > 2) {',
      '        if (x > 3) {',
      '          if (x > 4) return 99;',
      '        }',
      '      }',
      '    }',
      '  }',
      '  return r;',
      '}',
      'export function beta(): number { return 2; }',
      'export function gamma(): number { return 3; }',
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), gnarly + '\n');

    const result = await compareToRef(cg, { findingsDelta: true });
    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file).toBeDefined();
    expect(file!.findingsDelta).toBeDefined();
    const added = file!.findingsDelta!.added;
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((f) => f.qualifiedName.includes('alpha'))).toBe(true);
    expect(file!.findingsDelta!.cleared.length).toBe(0);
  });

  it('findingsDelta reports cleared findings when an edit refactors a gnarly symbol clean', async () => {
    // Start with a gnarly symbol committed as the baseline so cleared
    // findings have somewhere to come from.
    const gnarly = [
      'export function alpha(x: number): number {',
      '  let r = 0;',
      ...Array.from({ length: 80 }, (_, i) => `  if (x === ${i}) r += ${i};`),
      '  return r;',
      '}',
      'export function beta(): number { return 2; }',
      'export function gamma(): number { return 3; }',
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), gnarly + '\n');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'introduce-gnarly-alpha');

    // Now refactor alpha clean.
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `export function alpha(x: number): number { return x; }\nexport function beta(): number { return 2; }\nexport function gamma(): number { return 3; }\n`,
    );

    const result = await compareToRef(cg, { findingsDelta: true });
    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file).toBeDefined();
    expect(file!.findingsDelta).toBeDefined();
    const cleared = file!.findingsDelta!.cleared;
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared.every((f) => f.qualifiedName.includes('alpha'))).toBe(true);
    expect(file!.findingsDelta!.added.length).toBe(0);
  });

  it('findingsDelta carries pre-existing findings that still fire after the edit', async () => {
    // Commit a gnarly alpha so the baseline has findings on it.
    const gnarly = (multiplier: number): string =>
      [
        'export function alpha(x: number): number {',
        '  let r = 0;',
        ...Array.from({ length: 80 }, (_, i) => `  if (x === ${i * multiplier}) r += ${i};`),
        '  return r;',
        '}',
        'export function beta(): number { return 2; }',
        'export function gamma(): number { return 3; }',
      ].join('\n');
    fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), gnarly(1) + '\n');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'gnarly-baseline');

    // Slightly tweak the body — same shape, same threshold, just different
    // numeric literals. Findings should be CARRIED (same biomarkers fire),
    // not added/cleared.
    fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), gnarly(2) + '\n');

    const result = await compareToRef(cg, { findingsDelta: true });
    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file).toBeDefined();
    expect(file!.findingsDelta).toBeDefined();
    expect(file!.findingsDelta!.carried.length).toBeGreaterThan(0);
    expect(file!.findingsDelta!.added.length).toBe(0);
    expect(file!.findingsDelta!.cleared.length).toBe(0);
  });

  it('findingsDelta is empty when nothing changed', async () => {
    const result = await compareToRef(cg, { findingsDelta: true });
    expect(result.totals.added + result.totals.removed + result.totals.modified).toBe(0);
    for (const f of result.files) {
      if (!f.findingsDelta) continue;
      expect(f.findingsDelta.added).toHaveLength(0);
      expect(f.findingsDelta.cleared).toHaveLength(0);
    }
  });

  it('includeEdges reports added intra-file call edges', async () => {
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      [
        'export function alpha(): number {',
        '  return beta() + gamma();',
        '}',
        'export function beta(): number { return 2; }',
        'export function gamma(): number { return 3; }',
        'export function delta(): number {',
        '  return beta();',
        '}',
      ].join('\n'),
    );

    const result = await compareToRef(cg, { includeEdges: true });
    expect(result.totals.edgesAdded).toBeDefined();
    expect(result.totals.edgesAdded!).toBeGreaterThanOrEqual(1);
    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file?.edgesDelta).toBeDefined();
    expect(file!.edgesDelta!.added.length).toBeGreaterThanOrEqual(1);
  });

  it('includeEdges treats line-shift-only edits as no-edge-change', async () => {
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      [
        '',
        '',
        'export function alpha(): number { return 1; }',
        'export function beta(): number { return 2; }',
        'export function gamma(): number { return 3; }',
      ].join('\n'),
    );
    const result = await compareToRef(cg, { includeEdges: true });
    expect(result.totals.edgesAdded ?? 0).toBe(0);
    expect(result.totals.edgesRemoved ?? 0).toBe(0);
  });

  // ── Task #23: filesSkipped ───────────────────────────────────────────────

  it('filesSkipped counts non-indexable files that git reports changed', async () => {
    // Add a markdown file — not an indexable language, so it will get
    // a skipReason from fileDeltaForOnePath.
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Hello\n');
    fs.writeFileSync(path.join(testDir, 'data.unsupported'), 'key=value\n');

    const result = await compareToRef(cg);
    expect(result.error).toBeUndefined();
    // At least the two non-indexable files should be skipped.
    expect(result.filesSkipped).toBeGreaterThanOrEqual(2);
    // The skipped count should equal the number of files with a skipReason.
    const skippedInFiles = result.files.filter((f) => f.skipReason !== undefined).length;
    expect(result.filesSkipped).toBe(skippedInFiles);
  });

  it('filesSkipped is 0 when all changed files are TypeScript', async () => {
    // Edit only the TS file — no non-indexed files touched.
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `export function alpha(): number { return 99; }\nexport function beta(): number { return 2; }\nexport function gamma(): number { return 3; }\n`,
    );

    const result = await compareToRef(cg);
    expect(result.error).toBeUndefined();
    expect(result.filesSkipped).toBe(0);
    // Formatter should NOT add a skip line — verify via the files array.
    const anySkipped = result.files.some((f) => f.skipReason !== undefined);
    expect(anySkipped).toBe(false);
  });

  // ── Regression: findingsDelta=true on a clean diff should emit a confirmation ─

  it('findingsDelta=true on a clean diff emits a positive confirmation line', async () => {
    // Working tree matches HEAD (no changes) — a clean diff with no biomarker
    // findings anywhere. Passing findingsDelta=true should NOT be silent:
    // the rendered output must include the "0 introduced, 0 cleared" line so
    // the agent knows the flag was honoured.
    const handler = new ToolHandler(cg);
    try {
      const result = await handler.execute('cartograph_compare_to_ref', { findingsDelta: true });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('✓ findings delta computed — 0 per-file biomarker findings introduced, 0 cleared.');
    } finally {
      handler.closeAll();
    }
  });

  it('findingsDelta absent (not requested) does NOT emit the confirmation line on a clean diff', async () => {
    // Control: same clean-diff scenario but WITHOUT findingsDelta=true.
    // The confirmation line must be absent so the flag is not claimed when
    // the user did not ask for it.
    const handler = new ToolHandler(cg);
    try {
      const result = await handler.execute('cartograph_compare_to_ref', {});
      const text = result.content[0]?.text ?? '';
      expect(text).not.toContain('findings delta computed');
    } finally {
      handler.closeAll();
    }
  });

  // ── Task #24 (2026-05-14 redesign): suppressLineRangeOnly ───────────────
  //
  // Default flipped to `true` AND policy changed from per-FILE to per-SYMBOL:
  // each modified symbol whose only reason is `['line range changed']` is
  // independently moved into `lineRangeOnlyCount`. Real modifications in the
  // same file still surface individually. Pass `suppressLineRangeOnly: false`
  // to opt back into the verbose listing.

  it('default (true) collapses pure-renumber files into lineRangeOnlyCount', async () => {
    // Add a large block of blank lines at the top — every existing symbol shifts
    // its line range without changing signatures or modifiers.
    const shifted = [
      '',
      '',
      '',
      '',
      '', // 5 blank lines push everything down
      'export function alpha(): number { return 1; }',
      'export function beta(): number { return 2; }',
      'export function gamma(): number { return 3; }',
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), shifted + '\n');

    // Default (no flag) — suppression is ON by default.
    const result = await compareToRef(cg);
    expect(result.error).toBeUndefined();

    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file).toBeDefined();
    // All modifications were pure line-range shifts — they should be collapsed.
    expect(file!.modified).toHaveLength(0);
    expect(file!.lineRangeOnlyCount).toBeGreaterThan(0);
    // No added/removed real symbols.
    expect(file!.added).toHaveLength(0);
    expect(file!.removed).toHaveLength(0);
  });

  it('default (true) suppresses pure-renumber symbols PER-SYMBOL when a file ALSO has real changes', async () => {
    // Shift the file (blank lines at top) AND change alpha's signature.
    // alpha: signature change + line range change (mixed → real)
    // beta, gamma: line range change only (pure → suppressed)
    const mixed = [
      '',
      '',
      '',
      '',
      '', // shift all symbols down
      'export function alpha(x: number): number { return x; }',
      'export function beta(): number { return 2; }',
      'export function gamma(): number { return 3; }',
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), mixed + '\n');

    const result = await compareToRef(cg);
    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file).toBeDefined();

    // Real modification (alpha) stays in the list; pure renumbers (beta, gamma)
    // are tallied into lineRangeOnlyCount.
    const modNames = new Set(file!.modified.map((s) => s.name));
    expect(modNames.has('alpha')).toBe(true);
    expect(modNames.has('beta')).toBe(false);
    expect(modNames.has('gamma')).toBe(false);
    expect(file!.lineRangeOnlyCount).toBeGreaterThanOrEqual(2);

    // alpha's modification reasons should include signature changed.
    const alphaMod = file!.modified.find((s) => s.name === 'alpha');
    expect(alphaMod).toBeDefined();
    expect(alphaMod!.modifiedReasons).toContain('signature changed');
  });

  it('suppressLineRangeOnly=false (opt-out) keeps every renumbered symbol individually', async () => {
    const shifted = [
      '',
      '',
      '',
      '',
      'export function alpha(): number { return 1; }',
      'export function beta(): number { return 2; }',
      'export function gamma(): number { return 3; }',
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), shifted + '\n');

    // Explicit opt-out → all renumbered symbols stay in `modified`.
    const result = await compareToRef(cg, { suppressLineRangeOnly: false });
    const file = result.files.find((f) => f.filePath === 'src/lib.ts');
    expect(file).toBeDefined();
    expect(file!.modified.length).toBeGreaterThan(0);
    expect(file!.lineRangeOnlyCount).toBeUndefined();
  });

  // ── Task #25: body-only edits get an explicit acknowledgement ──────────────
  //
  // A body-only edit (change a literal, no signature/line-range change) leaves
  // the structural diff with 0 added/removed/modified. The rendered report must
  // not read as "nothing changed" — it gets an explicit body-only line.

  it('body-only edits produce an explicit "body-only edits" line in the report', async () => {
    // Same line count, same signatures — only the returned literal changed.
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `export function alpha(): number { return 99; }\nexport function beta(): number { return 2; }\nexport function gamma(): number { return 3; }\n`,
    );
    const handler = new ToolHandler(cg);
    try {
      const result = await handler.execute('cartograph_compare_to_ref', {});
      const text = result.content[0]?.text ?? '';
      // The structural diff finds nothing — but the file IS acknowledged.
      expect(text).toContain('body-only edits');
      expect(text).toContain('src/lib.ts');
      // And it points the agent at the right line-level tool.
      expect(text).toMatch(/cartograph_review|git diff/);
    } finally {
      handler.closeAll();
    }
  });

  it('body-only line is absent when every changed file has a structural delta', async () => {
    // Add a brand-new symbol — a structural change, so no body-only file.
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `export function alpha(): number { return 1; }\nexport function beta(): number { return 2; }\nexport function gamma(): number { return 3; }\nexport function epsilon(): number { return 5; }\n`,
    );
    const handler = new ToolHandler(cg);
    try {
      const result = await handler.execute('cartograph_compare_to_ref', {});
      const text = result.content[0]?.text ?? '';
      expect(text).not.toContain('body-only edits');
    } finally {
      handler.closeAll();
    }
  });

  // ── Task #26: includeEdges renders names, filters self-edges/empty headers ──

  it('includeEdges renders symbol NAMES, not raw node-id hashes', async () => {
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      [
        'export function alpha(): number {',
        '  return beta() + gamma();',
        '}',
        'export function beta(): number { return 2; }',
        'export function gamma(): number { return 3; }',
        'export function delta(): number {',
        '  return beta();',
        '}',
      ].join('\n'),
    );
    const handler = new ToolHandler(cg);
    try {
      const result = await handler.execute('cartograph_compare_to_ref', { includeEdges: true });
      const text = result.content[0]?.text ?? '';
      // Edge rows name the symbols.
      expect(text).toMatch(/edges added/);
      expect(text).toMatch(/`(alpha|delta)`/);
      // Raw node-id hashes (e.g. `function:b6d5614a85b1...`) must not leak.
      expect(text).not.toMatch(/`(function|method):[0-9a-f]{8,}/);
    } finally {
      handler.closeAll();
    }
  });

  it('includeEdges renderer filters self-referential edges and noise kinds', () => {
    // Direct renderer test: self-edges (source === target, e.g. a `def_use`
    // to the symbol itself) carry no cross-symbol signal and must be
    // dropped; `contains` / `imports` noise kinds likewise.
    const out: string[] = [];
    appendEdgesDelta(out, {
      added: [
        // Self-edge — same symbol both ends → dropped.
        { source: 'function:aaa', target: 'function:aaa', sourceName: 'alpha', targetName: 'alpha', kind: 'def_use' },
        // Noise kind → dropped.
        { source: 'function:aaa', target: 'function:bbb', sourceName: 'alpha', targetName: 'beta', kind: 'contains' },
        // Genuine cross-symbol call → kept.
        { source: 'function:aaa', target: 'function:bbb', sourceName: 'alpha', targetName: 'beta', kind: 'calls' },
      ],
      removed: [],
    });
    const text = out.join('\n');
    // Only the real `calls` edge survives.
    expect(text).toMatch(/edges added \(1\)/);
    expect(text).toContain('`calls`');
    expect(text).toContain('`alpha`');
    expect(text).toContain('`beta`');
    expect(text).not.toContain('def_use');
    expect(text).not.toContain('contains');
  });

  it('includeEdges renderer emits nothing when every edge is a self-edge', () => {
    // A file whose only edge delta is self-edges must NOT produce a header.
    const out: string[] = [];
    appendEdgesDelta(out, {
      added: [
        { source: 'function:aaa', target: 'function:aaa', sourceName: 'alpha', targetName: 'alpha', kind: 'def_use' },
      ],
      removed: [],
    });
    expect(out).toHaveLength(0);
  });

  it('includeEdges renderer falls back to a short id when the name is unresolved', () => {
    const out: string[] = [];
    appendEdgesDelta(out, {
      added: [
        // No sourceName/targetName — the renderer truncates the raw id.
        {
          source: 'function:0123456789abcdef0123456789abcdef',
          target: 'function:bbb',
          targetName: 'beta',
          kind: 'calls',
        },
      ],
      removed: [],
    });
    const text = out.join('\n');
    expect(text).toContain('`calls`');
    // Truncated id with an ellipsis, never the full hash.
    expect(text).toContain('…');
    expect(text).not.toContain('0123456789abcdef0123456789abcdef');
  });
});
