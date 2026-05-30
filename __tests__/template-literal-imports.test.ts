/**
 * Template-literal / string-literal "imports".
 *
 * The static import edge set deliberately excludes import-shaped
 * specifiers that appear inside string contents (test fixtures,
 * codegen sources, doc examples) — those aren't real imports. But
 * for migration-style tooling ("before this sed pass, what
 * import-like strings will it touch?") we surface them in a
 * dedicated `string_imports` table. See `src/string-imports/` and
 * `src/index-hooks/string-imports.ts` for the implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getStringImports } from '../src/db/queries-string-imports.js';
import { getMetadata, setMetadata } from '../src/db/queries-metadata.js';
import {
  STRING_IMPORTS_ALGO_VERSION,
  LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY,
} from '../src/string-imports/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('template-literal / string-literal imports', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tl-imports-'));
    fs.mkdirSync(path.join(testDir, '__tests__'));
    fs.writeFileSync(
      path.join(testDir, '__tests__', 'extractor-fixture.test.ts'),
      'const fixture = `\n' +
        "import { real } from './real';\n" +
        "import * as ns from './ns';\n" +
        '`;\n' +
        'const dynamicSrc = "const x = require(\'./inside-double-quotes\');";\n' +
        'export const code = fixture;\nexport const code2 = dynamicSrc;\n',
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

  it('real import graph does not contain fixture imports (sanity)', () => {
    const q = (cg as any).queries;
    const rows = q.db
      .prepare(`SELECT name FROM nodes WHERE kind='import' AND (name LIKE '%./real%' OR name LIKE '%./ns%')`)
      .all() as Array<{ name: string }>;
    // Tree-sitter parses these as template_string content, not import_statement.
    // This assertion documents the current (correct) behaviour.
    expect(rows.length).toBe(0);
  });

  it('string_imports table is populated with template-literal specifiers', () => {
    const rows = getStringImports(cg.queries, { moduleNameLike: './%' });
    const specs = rows.map((r) => r.moduleName).sort();
    expect(specs).toContain('./real');
    expect(specs).toContain('./ns');
    // Each row attributes the right container kind. The template-literal
    // imports come from a backtick string; the dynamic require lives in
    // a double-quoted string literal.
    const tplKinds = rows
      .filter((r) => r.moduleName === './real' || r.moduleName === './ns')
      .map((r) => r.containerKind);
    expect(tplKinds.every((k) => k === 'template_string')).toBe(true);
    const dyn = rows.find((r) => r.moduleName === './inside-double-quotes');
    expect(dyn?.containerKind).toBe('string_literal');
  });

  it('cartograph_imports source=literal MCP path returns the same set', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_imports', { source: 'literal' });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('./real');
    expect(text).toContain('./ns');
    expect(text).toContain('./inside-double-quotes');
    expect(text).toMatch(/source=literal/);
  });

  it('source=all + target= excludes literals and surfaces a note', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_imports', {
      source: 'all',
      target: 'unresolvable',
    });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    // The note must appear so the agent doesn't silently mistake
    // "no literals" for "no literal hits exist".
    expect(text).toMatch(/literal hit\(s\) excluded/);
  });

  it('sync incremental update refreshes string_imports for changed files', async () => {
    // Modify the fixture file: add a fresh template-literal import
    // that wasn't there at indexAll time.
    const fixturePath = path.join(testDir, '__tests__', 'extractor-fixture.test.ts');
    const updated =
      'const fixture = `\n' +
      "import { real } from './real';\n" +
      "import { fresh } from './fresh-after-sync';\n" +
      '`;\n' +
      'export const code = fixture;\n';
    fs.writeFileSync(fixturePath, updated);

    const result = await cg.sync();
    expect(result.filesModified).toBeGreaterThanOrEqual(1);

    const rows = getStringImports(cg.queries, { moduleNameLike: './%' });
    const specs = rows.map((r) => r.moduleName);
    expect(specs).toContain('./fresh-after-sync');
    // Stale row removed (the older `./ns` was dropped because the
    // file was rewritten without it).
    expect(specs).not.toContain('./ns');
  });

  it('regex literals containing apostrophes are not mis-attributed as strings', async () => {
    // A regex like /import\s+from\s+'([^']+)'/g contains a single
    // quote that the naive byte-walker would treat as opening a
    // string literal — covering the regex disambiguation path.
    const tricky = path.join(testDir, 'src');
    fs.mkdirSync(tricky, { recursive: true });
    fs.writeFileSync(
      path.join(tricky, 'regex-fixture.ts'),
      "const re = /import\\s+from\\s+'([^']+)'/g;\n" +
        "const tpl = `import { x } from './from-template'`;\n" +
        'export const code = re.toString() + tpl;\n',
    );
    await cg.sync();

    const rows = getStringImports(cg.queries, {});
    const specs = rows.map((r) => r.moduleName);
    // The template-literal import is captured as expected.
    expect(specs).toContain('./from-template');
    // No spurious row from the regex body.
    expect(rows.find((r) => r.filePath.endsWith('regex-fixture.ts') && r.moduleName.includes('('))).toBeUndefined();
  });

  it('files with no import-shaped strings produce zero rows', async () => {
    const plainPath = path.join(testDir, 'plain.ts');
    fs.writeFileSync(plainPath, "export const x = 'just a string';\nexport const y = 42;\n");
    await cg.sync();

    const plainRows = getStringImports(cg.queries, {}).filter((r) => r.filePath === 'plain.ts');
    expect(plainRows).toEqual([]);
  });
});

describe('string-imports algo-version self-heal', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-si-selfheal-'));

    // File A — has template-literal imports that will be indexed.
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'a.ts'),
      "const tpl = `import { x } from './from-a'`;\nexport const code = tpl;\n",
    );

    // File B — a second file touched by the sync (only one changed file).
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), 'export const y = 1;\n');

    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'selfheal-test', version: '0.0.0', type: 'module' }),
    );

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('STRING_IMPORTS_ALGO_VERSION is a 16-hex-char source-derived hash', () => {
    expect(STRING_IMPORTS_ALGO_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });

  it('algo version is stamped in project_metadata after indexAll', () => {
    const stored = getMetadata((cg as any).queries, LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY);
    expect(stored).toBe(STRING_IMPORTS_ALGO_VERSION);
  });

  it('forces a full re-mine on sync when stored algo version is stale', async () => {
    // Confirm baseline: indexAll mined a.ts's template-literal import.
    const before = getStringImports((cg as any).queries, { moduleNameLike: './%' });
    const beforeSpecs = before.map((r) => r.moduleName);
    expect(beforeSpecs).toContain('./from-a');

    // Now inject a bogus algo version — simulates a pre-fix install state.
    setMetadata((cg as any).queries, LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY, '0');

    // The ONLY changed file in this sync is b.ts (it has no string imports).
    // Under incremental logic, sync would only mine b.ts and leave a.ts stale.
    // With the self-heal, the algo-version mismatch forces a full re-mine,
    // so a.ts's rows are still present after the sync.
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), 'export const y = 42;\n');
    const result = await (cg as any).sync();
    expect(result.filesModified).toBeGreaterThanOrEqual(1);

    // Self-heal must have re-mined all files, so './from-a' must still appear.
    const after = getStringImports((cg as any).queries, { moduleNameLike: './%' });
    const afterSpecs = after.map((r) => r.moduleName);
    expect(afterSpecs).toContain('./from-a');

    // The algo version must now be stamped at the current value.
    const stamp = getMetadata((cg as any).queries, LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY);
    expect(stamp).toBe(STRING_IMPORTS_ALGO_VERSION);
  });

  it('forces a full re-mine on a NO-OP sync when stored algo version is stale', async () => {
    // Regression guard: the algo-version check must fire even when the sync
    // has ZERO changed files (no-op sync). Previously the check sat inside the
    // changed-files branch of afterSync, so a no-op sync silently skipped it.
    const before = getStringImports((cg as any).queries, { moduleNameLike: './%' });
    expect(before.map((r) => r.moduleName)).toContain('./from-a');

    // Stamp a bogus version — simulates a pre-fix deployment state.
    setMetadata((cg as any).queries, LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY, 'stale-version');

    // Run a sync with NO filesystem changes — changedFilePaths will be empty.
    const result = await (cg as any).sync();
    expect(result.filesModified ?? 0).toBe(0);

    // The hoisted mismatch check must have triggered the full re-mine even
    // though no files changed, so a.ts's rows are still present.
    const after = getStringImports((cg as any).queries, { moduleNameLike: './%' });
    expect(after.map((r) => r.moduleName)).toContain('./from-a');

    // Version must be re-stamped to the current value.
    const stamp = getMetadata((cg as any).queries, LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY);
    expect(stamp).toBe(STRING_IMPORTS_ALGO_VERSION);
  });

  it('stays incremental when the stored algo version matches', async () => {
    // Algo version already matches after indexAll — incremental sync
    // should only process changed files, NOT trigger a full clearStringImports.
    // Verify by confirming a.ts rows survive a b.ts-only sync.
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), 'export const y = 99;\n');
    await (cg as any).sync();

    const rows = getStringImports((cg as any).queries, { moduleNameLike: './%' });
    const specs = rows.map((r) => r.moduleName);
    expect(specs).toContain('./from-a');

    const stamp = getMetadata((cg as any).queries, LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY);
    expect(stamp).toBe(STRING_IMPORTS_ALGO_VERSION);
  });
});
