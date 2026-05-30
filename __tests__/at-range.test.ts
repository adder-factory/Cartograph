/**
 * at-range tests
 *
 * Unit tests for `getNodesAtRange` (the R*Tree query helper) and the
 * `handleAtRange` MCP handler. Covers:
 *   - Basic overlap and edge cases (inclusive endpoints)
 *   - Non-overlapping queries (before / after)
 *   - File-path scoping (same lines, different file → no hit)
 *   - Smallest-enclosing-first ordering (inner scope before outer)
 *   - `kind = 'file'` filtering
 *   - Trigger sync: insert / update / delete flows
 *
 * Uses `DatabaseConnection.initialize` (node:sqlite path) — same as
 * the migration tests; no better-sqlite3 skip guard needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { getNodesAtRange } from '../src/db/queries-rtree.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-at-range-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helper — build a minimal node fixture
// ---------------------------------------------------------------------------

interface NodeFixture {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  updatedAt?: number;
}

function makeNode(
  overrides: Partial<NodeFixture> & Pick<NodeFixture, 'id' | 'name' | 'startLine' | 'endLine'>,
): NodeFixture {
  return {
    kind: 'function',
    qualifiedName: overrides.name,
    filePath: 'src/file.ts',
    language: 'typescript',
    startColumn: 0,
    endColumn: 1,
    updatedAt: Date.now(),
    ...overrides,
  };
}

// Seed a row in `files` for the given path so the FK on `nodes.file_path`
// (migration 056) doesn't reject test-only direct inserts. Safe to call
// repeatedly for the same path.
function seedFile(db: DatabaseConnection, fpath: string): void {
  db.getDb()
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fpath, 'h', 'typescript', 0, 0, 0);
}

// ---------------------------------------------------------------------------
// R*Tree query helper tests
// ---------------------------------------------------------------------------

describe('getNodesAtRange — R*Tree query', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    testDir = createTempDir();
    db = DatabaseConnection.initialize(path.join(testDir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());
    seedFile(db, 'src/file.ts');
    seedFile(db, 'src/a.ts');
    seedFile(db, 'src/b.ts');
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(testDir);
  });

  it('basic overlap: query (15, 18) returns a function spanning 10–20', () => {
    qb.insertNode(makeNode({ id: 'fn:1', name: 'myFunc', startLine: 10, endLine: 20 }));

    const hits = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 15, endLine: 18, limit: 20 });
    expect(hits.map((h) => h.id)).toContain('fn:1');
  });

  it('edge: query (10, 10) returns a function spanning 10–20 (start endpoint inclusive)', () => {
    qb.insertNode(makeNode({ id: 'fn:1', name: 'myFunc', startLine: 10, endLine: 20 }));

    const hits = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 10, endLine: 10, limit: 20 });
    expect(hits.map((h) => h.id)).toContain('fn:1');
  });

  it('edge: query (5, 9) does NOT return a function spanning 10–20 (entirely before)', () => {
    qb.insertNode(makeNode({ id: 'fn:1', name: 'myFunc', startLine: 10, endLine: 20 }));

    const hits = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 5, endLine: 9, limit: 20 });
    expect(hits.map((h) => h.id)).not.toContain('fn:1');
  });

  it('edge: query (21, 30) does NOT return a function spanning 10–20 (entirely after)', () => {
    qb.insertNode(makeNode({ id: 'fn:1', name: 'myFunc', startLine: 10, endLine: 20 }));

    const hits = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 21, endLine: 30, limit: 20 });
    expect(hits.map((h) => h.id)).not.toContain('fn:1');
  });

  it('file scoping: same line range in a different file does NOT return the node', () => {
    qb.insertNode(makeNode({ id: 'fn:1', name: 'myFunc', filePath: 'src/a.ts', startLine: 10, endLine: 20 }));

    // Query against a DIFFERENT file — should return nothing.
    const hits = getNodesAtRange(qb, { filePath: 'src/b.ts', startLine: 10, endLine: 20, limit: 20 });
    expect(hits).toHaveLength(0);
  });

  it('smallest-enclosing-first: inner function before wrapping class', () => {
    // Class spans 1–50; method spans 10–20.
    qb.insertNode(makeNode({ id: 'cls:1', name: 'MyClass', kind: 'class', startLine: 1, endLine: 50 }));
    qb.insertNode(makeNode({ id: 'fn:1', name: 'myMethod', kind: 'method', startLine: 10, endLine: 20 }));

    // Query a line inside the method (line 15).
    const hits = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 15, endLine: 15, limit: 20 });
    const ids = hits.map((h) => h.id);

    expect(ids).toContain('fn:1');
    expect(ids).toContain('cls:1');
    // Method (span 10 lines) must appear before class (span 49 lines).
    expect(ids.indexOf('fn:1')).toBeLessThan(ids.indexOf('cls:1'));
  });

  it('kind=file nodes are filtered out of results', () => {
    // File node spans 1–1000; a function inside it.
    qb.insertNode(makeNode({ id: 'file:1', name: 'src/file.ts', kind: 'file', startLine: 1, endLine: 1000 }));
    qb.insertNode(makeNode({ id: 'fn:1', name: 'myFunc', startLine: 10, endLine: 20 }));

    const hits = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 15, endLine: 15, limit: 20 });
    const ids = hits.map((h) => h.id);

    // File node must be excluded.
    expect(ids).not.toContain('file:1');
    expect(ids).toContain('fn:1');
  });
});

// ---------------------------------------------------------------------------
// Trigger sync tests
// ---------------------------------------------------------------------------

describe('getNodesAtRange — trigger sync', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    testDir = createTempDir();
    db = DatabaseConnection.initialize(path.join(testDir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());
    seedFile(db, 'src/file.ts');
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(testDir);
  });

  it('INSERT trigger: new node is immediately queryable', () => {
    qb.insertNode(makeNode({ id: 'fn:1', name: 'newFunc', startLine: 5, endLine: 15 }));

    const hits = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 10, endLine: 10, limit: 20 });
    expect(hits.map((h) => h.id)).toContain('fn:1');
  });

  it('UPDATE trigger: querying old range returns no hit after line update', () => {
    qb.insertNode(makeNode({ id: 'fn:1', name: 'movingFunc', startLine: 5, endLine: 15 }));

    // Move the function to lines 50–60 via direct SQL update (mirrors what a
    // re-index does — the AFTER UPDATE OF start_line, end_line trigger must fire).
    db.getDb().prepare(`UPDATE nodes SET start_line = 50, end_line = 60 WHERE id = 'fn:1'`).run();

    // Old range should now return nothing.
    const hitsOld = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 5, endLine: 15, limit: 20 });
    expect(hitsOld.map((h) => h.id)).not.toContain('fn:1');

    // New range should return the node.
    const hitsNew = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 55, endLine: 55, limit: 20 });
    expect(hitsNew.map((h) => h.id)).toContain('fn:1');
  });

  it('DELETE trigger: deleted node no longer appears in query', () => {
    qb.insertNode(makeNode({ id: 'fn:1', name: 'goneFunc', startLine: 10, endLine: 20 }));

    // Verify it's there before deletion.
    const before = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 15, endLine: 15, limit: 20 });
    expect(before.map((h) => h.id)).toContain('fn:1');

    // Delete the node.
    db.getDb().prepare(`DELETE FROM nodes WHERE id = 'fn:1'`).run();

    // Must be gone from the R*Tree too.
    const after = getNodesAtRange(qb, { filePath: 'src/file.ts', startLine: 15, endLine: 15, limit: 20 });
    expect(after.map((h) => h.id)).not.toContain('fn:1');
  });
});

// ---------------------------------------------------------------------------
// MCP handler tests
// ---------------------------------------------------------------------------

describe('handleAtRange — MCP handler', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it('returns error when file arg is missing', async () => {
    const { AT_RANGE_TOOL } = await import('../src/mcp/tools/at-range.js');
    const { Cartograph } = await import('../src/index.js');
    const cg = Cartograph.initSync(testDir);

    const ctx = {
      getCartograph: () => cg,
      options: {},
      defaultCg: cg,
      projectCache: new Map(),
      closeProjectsMatching: () => {},
      refIds: { mint: () => 'n_0', resolve: () => null },
      callIds: { mint: () => 'c_0', resolve: () => null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await AT_RANGE_TOOL.handle(ctx, { startLine: 1, endLine: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/file/);

    cg.close();
  });

  it('returns error when endLine < startLine', async () => {
    const { AT_RANGE_TOOL } = await import('../src/mcp/tools/at-range.js');
    const { Cartograph } = await import('../src/index.js');
    const cg = Cartograph.initSync(testDir);

    const ctx = {
      getCartograph: () => cg,
      options: {},
      defaultCg: cg,
      projectCache: new Map(),
      closeProjectsMatching: () => {},
      refIds: { mint: () => 'n_0', resolve: () => null },
      callIds: { mint: () => 'c_0', resolve: () => null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await AT_RANGE_TOOL.handle(ctx, { file: 'src/file.ts', startLine: 10, endLine: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/endLine/);

    cg.close();
  });

  it('returns a "file not indexed" ERROR when file is not in the index', async () => {
    const { AT_RANGE_TOOL } = await import('../src/mcp/tools/at-range.js');
    const { Cartograph } = await import('../src/index.js');
    const cg = Cartograph.initSync(testDir);

    const ctx = {
      getCartograph: () => cg,
      options: {},
      defaultCg: cg,
      projectCache: new Map(),
      closeProjectsMatching: () => {},
      refIds: { mint: () => 'n_0', resolve: () => null },
      callIds: { mint: () => 'c_0', resolve: () => null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await AT_RANGE_TOOL.handle(ctx, { file: 'src/no-such-file.ts', startLine: 1, endLine: 5 });
    // Task #16: a non-indexed path is almost always a typo — fail loud
    // (isError) rather than returning an exit-0 empty result.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/File not indexed/);
    // Single "Error:" prefix — errorResult adds it; the handler must not (task #12).
    expect(result.content[0]?.text).not.toMatch(/Error: Error:/);

    cg.close();
  });
});

// ---------------------------------------------------------------------------
// Bulk ranges form tests
// ---------------------------------------------------------------------------

describe('handleAtRange — bulk ranges form', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it('multiple ranges across multiple files in a single response', async () => {
    const { execFileSync } = await import('node:child_process');

    function git(cwd: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }

    // Set up two source files with functions.
    const fsModule = await import('node:fs');
    const pathModule = await import('node:path');
    fsModule.mkdirSync(pathModule.join(testDir, 'src'));

    fsModule.writeFileSync(
      pathModule.join(testDir, 'src', 'a.ts'),
      'export function funcA1() {\n  return 1;\n}\nexport function funcA2() {\n  return 2;\n}\n',
    );
    fsModule.writeFileSync(pathModule.join(testDir, 'src', 'b.ts'), 'export function funcB1() {\n  return 3;\n}\n');
    fsModule.writeFileSync(pathModule.join(testDir, '.gitignore'), '.cartograph/\n');

    git(testDir, 'init', '-q');
    git(testDir, 'config', 'user.email', 't@t');
    git(testDir, 'config', 'user.name', 't');
    git(testDir, 'config', 'commit.gpgsign', 'false');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'init');

    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');

    const cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    const handler = new ToolHandler(cg);

    // Query three ranges: one in a.ts (15 — hits funcA1), another in a.ts (35 — hits funcA2), one in b.ts (10 — hits funcB1).
    const result = await handler.execute('cartograph_at_range', {
      ranges: [
        { file: 'src/a.ts', startLine: 2, endLine: 2 }, // Within funcA1
        { file: 'src/a.ts', startLine: 4, endLine: 4 }, // Within funcA2
        { file: 'src/b.ts', startLine: 2, endLine: 2 }, // Within funcB1
      ],
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';

    // Check for bulk header.
    expect(text).toContain('## Symbols overlapping 3 ranges');

    // Check for per-range subsections.
    expect(text).toContain('### src/a.ts:2-2');
    expect(text).toContain('### src/a.ts:4-4');
    expect(text).toContain('### src/b.ts:2-2');

    // Check that function names appear (confirms we got the data).
    expect(text).toContain('funcA1');
    expect(text).toContain('funcA2');
    expect(text).toContain('funcB1');

    handler.closeAll();
    cg.close();
  });

  it('bulk and single-form set together → error', async () => {
    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');

    const cg = Cartograph.initSync(testDir);
    const handler = new ToolHandler(cg);

    const result = await handler.execute('cartograph_at_range', {
      file: 'src/a.ts',
      startLine: 1,
      endLine: 5,
      ranges: [{ file: 'src/b.ts', startLine: 10, endLine: 15 }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Cannot specify both.*single-range.*bulk/);

    handler.closeAll();
    cg.close();
  });

  it('empty ranges array → error', async () => {
    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');

    const cg = Cartograph.initSync(testDir);
    const handler = new ToolHandler(cg);

    const result = await handler.execute('cartograph_at_range', { ranges: [] });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/non-empty array/);

    handler.closeAll();
    cg.close();
  });

  it('per-range validation error names the index', async () => {
    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');

    const cg = Cartograph.initSync(testDir);
    const handler = new ToolHandler(cg);

    // ranges[2] has endLine < startLine.
    const result = await handler.execute('cartograph_at_range', {
      ranges: [
        { file: 'src/a.ts', startLine: 1, endLine: 5 },
        { file: 'src/b.ts', startLine: 10, endLine: 15 },
        { file: 'src/c.ts', startLine: 30, endLine: 20 }, // Invalid: endLine < startLine
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/ranges\[2\]\.endLine/);
    expect(result.content[0]?.text).toMatch(/must be >=/);

    handler.closeAll();
    cg.close();
  });

  it('path traversal in single-range form — ../../etc/passwd rejected', async () => {
    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');

    const cg = Cartograph.initSync(testDir);
    const handler = new ToolHandler(cg);

    const result = await handler.execute('cartograph_at_range', {
      file: '../../../../../../etc/passwd',
      startLine: 1,
      endLine: 10,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/outside the project root/);
    // Task #12: errorResult prepends "Error: " — the handler must not add a
    // second one.
    expect(result.content[0]?.text).not.toMatch(/Error: Error:/);

    handler.closeAll();
    cg.close();
  });

  it('bulk form with one out-of-root range — entire call fails', async () => {
    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');

    const cg = Cartograph.initSync(testDir);
    const handler = new ToolHandler(cg);

    // ranges[1] has a path traversal attempt
    const result = await handler.execute('cartograph_at_range', {
      ranges: [
        { file: 'src/a.ts', startLine: 1, endLine: 5 },
        { file: '../../../etc/passwd', startLine: 10, endLine: 15 }, // Invalid: outside root
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/outside the project root/);
    expect(result.content[0]?.text).toMatch(/ranges\[1\]/);
    // Task #12: no doubled "Error:" prefix on the bulk-range path either.
    expect(result.content[0]?.text).not.toMatch(/Error: Error:/);

    handler.closeAll();
    cg.close();
  });

  it('bulk form with some empty ranges renders empty-range subsections', async () => {
    const { execFileSync } = await import('node:child_process');

    function git(cwd: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }

    // Set up one source file with a function.
    const fsModule = await import('node:fs');
    const pathModule = await import('node:path');
    fsModule.mkdirSync(pathModule.join(testDir, 'src'));

    fsModule.writeFileSync(pathModule.join(testDir, 'src', 'a.ts'), 'export function funcA1() {\n  return 1;\n}\n');
    fsModule.writeFileSync(pathModule.join(testDir, '.gitignore'), '.cartograph/\n');

    git(testDir, 'init', '-q');
    git(testDir, 'config', 'user.email', 't@t');
    git(testDir, 'config', 'user.name', 't');
    git(testDir, 'config', 'commit.gpgsign', 'false');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'init');

    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');

    const cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    const handler = new ToolHandler(cg);

    // Query two ranges: one hits funcA1, the other (outside the function) returns nothing.
    const result = await handler.execute('cartograph_at_range', {
      ranges: [
        { file: 'src/a.ts', startLine: 2, endLine: 2 }, // Hits funcA1
        { file: 'src/a.ts', startLine: 50, endLine: 60 }, // No hit
      ],
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';

    // Check that both ranges are rendered.
    expect(text).toContain('### src/a.ts:2-2');
    expect(text).toContain('### src/a.ts:50-60');

    // First range has funcA1, second has empty-range marker.
    expect(text).toContain('funcA1');
    expect(text).toContain('_No symbols overlap this range._');

    handler.closeAll();
    cg.close();
  });
});

// ---------------------------------------------------------------------------
// Compact + fields projection tests (Stage 6 #6.1 + #6.3 generalization)
// ---------------------------------------------------------------------------

describe('handleAtRange — compact + fields', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  async function setupSingleFileProject(): Promise<{ cg: any; handler: any }> {
    const { execFileSync } = await import('node:child_process');
    function git(cwd: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
    const fsModule = await import('node:fs');
    const pathModule = await import('node:path');
    fsModule.mkdirSync(pathModule.join(testDir, 'src'));
    fsModule.writeFileSync(
      pathModule.join(testDir, 'src', 'a.ts'),
      'export function funcA1(): number {\n  return 1;\n}\n',
    );
    fsModule.writeFileSync(pathModule.join(testDir, '.gitignore'), '.cartograph/\n');
    git(testDir, 'init', '-q');
    git(testDir, 'config', 'user.email', 't@t');
    git(testDir, 'config', 'user.name', 't');
    git(testDir, 'config', 'commit.gpgsign', 'false');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'init');

    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');
    const cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    const handler = new ToolHandler(cg);
    return { cg, handler };
  }

  it('compact + fields emits pipe-delimited rows with only requested columns (single-range)', async () => {
    const { cg, handler } = await setupSingleFileProject();
    try {
      const result = await handler.execute('cartograph_at_range', {
        file: 'src/a.ts',
        startLine: 2,
        endLine: 2,
        compact: true,
        fields: ['name', 'kind'],
      });
      const text = result.content[0]?.text ?? '';
      // Header line is unchanged (range identifier still useful in compact mode).
      expect(text).toContain('## Symbols overlapping src/a.ts:2-2');
      // No markdown table separator rows.
      expect(text).not.toContain('| Kind | Name | Lines | Signature |');
      // Compact row has only name + kind, separated by `|`.
      expect(text).toMatch(/funcA1\|function/);
      // path / line / signature were excluded by fields — confirm absence.
      expect(text).not.toMatch(/funcA1\|function\|src\/a\.ts/);
      expect(text).not.toMatch(/funcA1\|function\|:/);
    } finally {
      handler.closeAll();
      cg.close();
    }
  });

  it('default (no compact) renders the markdown table unchanged', async () => {
    const { cg, handler } = await setupSingleFileProject();
    try {
      const defaultCall = await handler.execute('cartograph_at_range', {
        file: 'src/a.ts',
        startLine: 2,
        endLine: 2,
      });
      // `fields` without `compact:true` is silently ignored.
      const withFields = await handler.execute('cartograph_at_range', {
        file: 'src/a.ts',
        startLine: 2,
        endLine: 2,
        fields: ['name'],
      });
      expect(withFields.content[0]?.text ?? '').toBe(defaultCall.content[0]?.text ?? '');
      // Sanity check: markdown table header still present.
      expect(defaultCall.content[0]?.text ?? '').toContain('| Kind | Name | Lines | Signature |');
    } finally {
      handler.closeAll();
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Diff-form error diagnostics (FRICTION-3)
// ---------------------------------------------------------------------------

describe('handleAtRange — diff-form error messages', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  async function makeCtx(): Promise<any> {
    const { Cartograph } = await import('../src/index.js');
    const cg = Cartograph.initSync(testDir);
    const ctx = {
      getCartograph: () => cg,
      options: {},
      defaultCg: cg,
      projectCache: new Map(),
      closeProjectsMatching: () => {},
      refIds: { mint: () => 'n_0', resolve: () => null },
      callIds: { mint: () => 'c_0', resolve: () => null },
    } as any;
    return { cg, ctx };
  }

  it('precise message when `@@` hunk lines exist but no file header', async () => {
    const { AT_RANGE_TOOL } = await import('../src/mcp/tools/at-range.js');
    const { cg, ctx } = await makeCtx();
    // Valid hunk headers, but no `+++ b/...` or `diff --git` line precedes them.
    const headerless = '@@ -1,3 +1,4 @@\n context\n+added\n@@ -10,2 +11,3 @@\n more\n+also\n';
    const result = await AT_RANGE_TOOL.handle(ctx, { diff: headerless });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('found 2 `@@` hunk header(s) but no file header');
    expect(text).toMatch(/\+\+\+ b\/path/);
    // Must NOT use the misleading "no hunks found" wording.
    expect(text).not.toContain('no hunks found in diff');
    cg.close();
  });

  it('original message when the diff contains no `@@` lines at all', async () => {
    const { AT_RANGE_TOOL } = await import('../src/mcp/tools/at-range.js');
    const { cg, ctx } = await makeCtx();
    const noHunks = 'just some text\nwith no diff markers at all\n';
    const result = await AT_RANGE_TOOL.handle(ctx, { diff: noHunks });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('no hunks found in diff');
    expect(text).not.toContain('hunk header(s) but no file header');
    cg.close();
  });
});

// ---------------------------------------------------------------------------
// Diff-form fuzz fallback for tight hunks
// ---------------------------------------------------------------------------

describe('handleAtRange — diff-form fuzz fallback for tight hunks', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  async function setupProject(): Promise<{ cg: any; handler: any }> {
    const { execFileSync } = await import('node:child_process');
    function git(cwd: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
    const fsModule = await import('node:fs');
    const pathModule = await import('node:path');
    fsModule.mkdirSync(pathModule.join(testDir, 'src'));
    // A file where `targetFn` is defined well below line 1 — a tight hunk
    // a few lines above its def line must still resolve to it via fuzz.
    const lines: string[] = [];
    for (let i = 1; i <= 12; i++) lines.push(`// filler comment line ${i}`);
    lines.push('export function targetFn(): number {'); // line 13
    lines.push('  return 42;');
    lines.push('}');
    fsModule.writeFileSync(pathModule.join(testDir, 'src', 'a.ts'), lines.join('\n') + '\n');
    fsModule.writeFileSync(pathModule.join(testDir, '.gitignore'), '.cartograph/\n');
    git(testDir, 'init', '-q');
    git(testDir, 'config', 'user.email', 't@t');
    git(testDir, 'config', 'user.name', 't');
    git(testDir, 'config', 'commit.gpgsign', 'false');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'init');

    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');
    const cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    const handler = new ToolHandler(cg);
    return { cg, handler };
  }

  it('a tight hunk above the def line resolves via fuzz and is labelled "near hunk"', async () => {
    const { cg, handler } = await setupProject();
    try {
      // Hunk at lines 8-10 — entirely above targetFn's def line (13).
      // Exact overlap finds nothing; the fuzz fallback (±8 lines) reaches it.
      const diff =
        'diff --git a/src/a.ts b/src/a.ts\n' +
        'index 1111111..2222222 100644\n' +
        '--- a/src/a.ts\n' +
        '+++ b/src/a.ts\n' +
        '@@ -8,3 +8,3 @@\n' +
        ' // filler comment line 8\n' +
        '-// filler comment line 9\n' +
        '+// filler comment line 9 edited\n' +
        ' // filler comment line 10\n';
      const result = await handler.execute('cartograph_at_range', { diff });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      // The fuzz fallback surfaced the enclosing function.
      expect(text).toContain('targetFn');
      // ...and it is clearly labelled as a near-hunk fallback.
      expect(text).toContain('near hunk');
      // No misleading "no symbols overlap" message.
      expect(text).not.toContain('_No symbols overlap this range._');
    } finally {
      handler.closeAll();
      cg.close();
    }
  });

  it('a hunk that directly overlaps the def line is NOT labelled "near hunk"', async () => {
    const { cg, handler } = await setupProject();
    try {
      // Hunk at lines 13-15 — exactly over targetFn's def.
      const diff =
        'diff --git a/src/a.ts b/src/a.ts\n' +
        'index 1111111..2222222 100644\n' +
        '--- a/src/a.ts\n' +
        '+++ b/src/a.ts\n' +
        '@@ -13,3 +13,3 @@\n' +
        ' export function targetFn(): number {\n' +
        '-  return 42;\n' +
        '+  return 43;\n' +
        ' }\n';
      const result = await handler.execute('cartograph_at_range', { diff });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('targetFn');
      // Exact overlap — no fuzz label.
      expect(text).not.toContain('near hunk');
      // Single-hunk diff → singular noun in the header (audit 2026-05-18:
      // the header used to read "overlapping 1 diff hunks").
      expect(text).toContain('## Symbols overlapping 1 diff hunk');
      expect(text).not.toContain('1 diff hunks');
    } finally {
      handler.closeAll();
      cg.close();
    }
  });

  it('a multi-hunk diff pluralizes the header noun', async () => {
    const { cg, handler } = await setupProject();
    try {
      // Two hunks in the same file → plural "diff hunks".
      const diff =
        'diff --git a/src/a.ts b/src/a.ts\n' +
        'index 1111111..2222222 100644\n' +
        '--- a/src/a.ts\n' +
        '+++ b/src/a.ts\n' +
        '@@ -1,3 +1,3 @@\n' +
        ' // filler comment line 1\n' +
        '-// filler comment line 2\n' +
        '+// filler comment line 2 edited\n' +
        ' // filler comment line 3\n' +
        '@@ -13,3 +13,3 @@\n' +
        ' export function targetFn(): number {\n' +
        '-  return 42;\n' +
        '+  return 43;\n' +
        ' }\n';
      const result = await handler.execute('cartograph_at_range', { diff });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('## Symbols overlapping 2 diff hunks');
    } finally {
      handler.closeAll();
      cg.close();
    }
  });

  it('a hunk far from any symbol still reports no overlap (fuzz does not over-broaden)', async () => {
    const { cg, handler } = await setupProject();
    try {
      // Hunk at lines 1-3 — far above the def line (13); even ±8 fuzz
      // (1-11) does not reach targetFn.
      const diff =
        'diff --git a/src/a.ts b/src/a.ts\n' +
        'index 1111111..2222222 100644\n' +
        '--- a/src/a.ts\n' +
        '+++ b/src/a.ts\n' +
        '@@ -1,3 +1,3 @@\n' +
        ' // filler comment line 1\n' +
        '-// filler comment line 2\n' +
        '+// filler comment line 2 edited\n' +
        ' // filler comment line 3\n';
      const result = await handler.execute('cartograph_at_range', { diff });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('_No symbols overlap this range._');
      expect(text).not.toContain('near hunk');
    } finally {
      handler.closeAll();
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// diff-parser — countHunkHeaders + parseUnifiedDiff (FRICTION-3)
// ---------------------------------------------------------------------------

describe('diff-parser — countHunkHeaders / parseUnifiedDiff', () => {
  it('countHunkHeaders counts well-formed `@@` headers regardless of file header', async () => {
    const { countHunkHeaders } = await import('../src/compare/diff-parser.js');
    expect(countHunkHeaders('@@ -1,3 +1,4 @@\n@@ -10,2 +11,3 @@\n')).toBe(2);
    expect(countHunkHeaders('no markers here\n')).toBe(0);
    // Malformed `@@` lines are not counted.
    expect(countHunkHeaders('@@ garbage @@\n@@ -1 +1 @@\n')).toBe(1);
  });

  it('headerless diff with `@@` lines still parses to zero ranges (behavior unchanged)', async () => {
    const { parseUnifiedDiff } = await import('../src/compare/diff-parser.js');
    expect(parseUnifiedDiff('@@ -1,3 +1,4 @@\n context\n+added\n')).toEqual([]);
  });

  it('proper `git diff` output (with `diff --git` header) still parses hunks', async () => {
    const { parseUnifiedDiff } = await import('../src/compare/diff-parser.js');
    const diff =
      'diff --git a/src/a.ts b/src/a.ts\n' +
      'index 1111111..2222222 100644\n' +
      '--- a/src/a.ts\n' +
      '+++ b/src/a.ts\n' +
      '@@ -1,3 +1,4 @@\n' +
      ' line1\n' +
      '+inserted\n' +
      ' line2\n';
    expect(parseUnifiedDiff(diff)).toEqual([{ file: 'src/a.ts', startLine: 1, endLine: 4 }]);
  });
});
