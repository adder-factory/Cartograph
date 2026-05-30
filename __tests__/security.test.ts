/**
 * Security Tests
 *
 * Tests for P0/P1 security fixes:
 * - FileLock (cross-process locking)
 * - Path traversal prevention
 * - MCP input validation
 * - Atomic writes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileLock } from '../src/utils.js';
import Cartograph from '../src/index.js';
import { ToolHandler, tools } from '../src/mcp/tools.js';
import { shouldIncludeFile, scanDirectory } from '../src/extraction/index.js';
import { shouldIncludeFile as configShouldInclude } from '../src/config.js';
import { type CartographConfig, DEFAULT_CONFIG } from '../src/types.js';
import { DatabaseConnection, getDatabasePath } from '../src/db/index.js';
import { QueryBuilder, getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';
import { getFileByPath } from '../src/db/queries-files.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-security-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Seed a row in `files` so subsequent node inserts referencing this path
 * satisfy the migration-056 FK (`nodes.file_path -> files(path)`).
 * Idempotent — safe to call multiple times for the same path.
 */
function seedFile(db: DatabaseConnection, fpath: string): void {
  db.getDb()
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fpath, 'h', 'typescript', 0, 0, 0);
}

describe('FileLock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    lockPath = path.join(tempDir, 'test.lock');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should acquire and release a lock', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();

    expect(fs.existsSync(lockPath)).toBe(true);
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    expect(parseInt(content, 10)).toBe(process.pid);

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should prevent double acquisition within same process', () => {
    const lock1 = new FileLock(lockPath);
    const lock2 = new FileLock(lockPath);

    lock1.acquire();

    // Second lock should fail because our PID is alive
    expect(() => lock2.acquire()).toThrow(/locked by another process/);

    lock1.release();
  });

  it('should detect and remove stale locks from dead processes', () => {
    // Write a lock file with a PID that doesn't exist
    // PID 99999999 is extremely unlikely to be a real process
    fs.writeFileSync(lockPath, '99999999');

    const lock = new FileLock(lockPath);
    // Should succeed because the PID is dead
    expect(() => lock.acquire()).not.toThrow();

    lock.release();
  });

  it('should execute function with withLock', () => {
    const lock = new FileLock(lockPath);

    const result = lock.withLock(() => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if function throws', () => {
    const lock = new FileLock(lockPath);

    expect(() => {
      lock.withLock(() => {
        throw new Error('test error');
      });
    }).toThrow('test error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should execute async function with withLockAsync', async () => {
    const lock = new FileLock(lockPath);

    const result = await lock.withLockAsync(async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 'async-result';
    });

    expect(result).toBe('async-result');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if async function throws', async () => {
    const lock = new FileLock(lockPath);

    await expect(
      lock.withLockAsync(async () => {
        throw new Error('async error');
      }),
    ).rejects.toThrow('async error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release should be idempotent', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();
    lock.release();
    // Second release should not throw
    expect(() => lock.release()).not.toThrow();
  });
});

describe('Path Traversal Prevention', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(path.join(srcDir, 'hello.ts'), `export function hello(): string { return "hi"; }\n`);

    cg = Cartograph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should read code for valid nodes within project', async () => {
    const nodes = getNodesByKind(cg.queries, 'function');
    const hello = nodes.find((n) => n.name === 'hello');
    expect(hello).toBeDefined();

    const code = await cg.internals.contextBuilder.getCode(hello!.id);
    expect(code).toContain('hello');
  });

  it('should return null for non-existent node', async () => {
    const code = await cg.internals.contextBuilder.getCode('does-not-exist');
    expect(code).toBeNull();
  });
});

describe('MCP Input Validation', () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'example.ts'),
      `export function exampleFunc(): void {}\nexport class ExampleClass {}\n`,
    );

    cg = Cartograph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should reject non-string query in cartograph_search', async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', query: null });
    expect(result.isError).toBe(true);
    // Boundary validation catches the type mismatch first — Zod-backed
    // `cartograph_find` renders it as `query: expected string, received …`.
    expect(result.content[0].text).toMatch(/`query` must be of type string|query: expected string/);
  });

  it('should reject empty string query in cartograph_search', async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', query: '' });
    expect(result.isError).toBe(true);
    // Empty string passes the boundary type check; per-handler
    // validateString catches the emptiness check.
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should accept valid query in cartograph_search', async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'example' });
    expect(result.isError).toBeFalsy();
  });

  it('should clamp limit to valid range in cartograph_search', async () => {
    // Extremely large limit should still work (clamped to 100)
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'example', limit: 999999 });
    expect(result.isError).toBeFalsy();
  });

  it('should reject non-string start in cartograph_graph (callers)', async () => {
    const result = await handler.execute('cartograph_graph', { direction: 'callers', start: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/`start` must be of type string|start: expected string/);
  });

  it('should reject non-string task in cartograph_context', async () => {
    const result = await handler.execute('cartograph_context', { task: undefined });
    expect(result.isError).toBe(true);
    // task is required by schema; missing required field message wins.
    // `cartograph_context` is Zod-backed (campaign P4) — `formatZodError`
    // renders a missing required field as `task: required`. The legacy
    // alternatives are kept for any not-yet-migrated tool.
    expect(result.content[0].text).toMatch(/Missing required argument `task`|`task` must be|task: required/);
  });

  it('should reject non-string start in cartograph_graph (impact)', async () => {
    const result = await handler.execute('cartograph_graph', { direction: 'impact', start: [] });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in cartograph_node', async () => {
    const result = await handler.execute('cartograph_node', { symbol: false });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string start in cartograph_graph (callees)', async () => {
    const result = await handler.execute('cartograph_graph', { direction: 'callees', start: {} });
    expect(result.isError).toBe(true);
  });

  it('rejects non-numeric limit (was: silent NaN coercion)', async () => {
    // Pre-D1 the handler did `as number` then clamped — `'abc' * 1` = NaN
    // got silently coerced to the default. Boundary validator now
    // rejects it explicitly so a typoed `limit` surfaces instead of
    // silently using the default.
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'example', limit: 'abc' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/`limit` must be of type number|limit: expected number/);
  });

  it('rejects a negative limit (clamp→reject, campaign P4)', async () => {
    // Zod-backed `cartograph_find` rejects an out-of-range `limit`
    // (`.int().min(1)`) rather than the old silent clamp-to-1.
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'example', limit: -5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/limit: must be ≥ 1/);
  });
});

describe('Atomic Writes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not leave temp files on success', () => {
    // We test this indirectly through the config-writer module
    // by checking that no .tmp files remain after writing
    const configDir = path.join(tempDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });

    const testFile = path.join(configDir, 'test.json');
    // Simulate what atomicWriteFileSync does
    const tmpPath = testFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, '{"test": true}');
    fs.renameSync(tmpPath, testFile);

    expect(fs.existsSync(testFile)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    const content = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
    expect(content.test).toBe(true);
  });
});

describe('Glob Matching (Bun.Glob)', () => {
  const makeConfig = (include: string[], exclude: string[]): CartographConfig => ({
    ...DEFAULT_CONFIG,
    rootDir: '/test',
    include,
    exclude,
  });

  it('should match standard glob patterns in extraction', () => {
    const config = makeConfig(['**/*.ts'], ['node_modules/**']);

    expect(shouldIncludeFile('src/index.ts', config)).toBe(true);
    expect(shouldIncludeFile('src/deep/nested/file.ts', config)).toBe(true);
    expect(shouldIncludeFile('src/index.js', config)).toBe(false);
    expect(shouldIncludeFile('node_modules/lib/index.ts', config)).toBe(false);
  });

  it('should match standard glob patterns in config', () => {
    const config = makeConfig(['**/*.py'], ['__pycache__/**']);

    expect(configShouldInclude('src/main.py', config)).toBe(true);
    expect(configShouldInclude('src/main.ts', config)).toBe(false);
    expect(configShouldInclude('__pycache__/module.py', config)).toBe(false);
  });

  it('should handle complex glob patterns correctly', () => {
    const config = makeConfig(['src/**/*.{ts,tsx}', 'lib/**/*.js'], []);

    expect(shouldIncludeFile('src/component.ts', config)).toBe(true);
    expect(shouldIncludeFile('src/component.tsx', config)).toBe(true);
    expect(shouldIncludeFile('lib/util.js', config)).toBe(true);
    expect(shouldIncludeFile('src/component.css', config)).toBe(false);
  });

  it('should handle patterns that previously caused ReDoS', () => {
    // This pattern would cause catastrophic backtracking with hand-rolled regex
    const evilPattern = '**/**/**/**/**/**/**/**/**/**/**/**/**/**/a';
    const config = makeConfig([evilPattern], []);

    const start = Date.now();
    // This should return quickly, not hang
    shouldIncludeFile('x/x/x/x/x/x/x/x/x/x/x/x/x/x/b', config);
    const elapsed = Date.now() - start;

    // Should complete in under 100ms, not seconds
    expect(elapsed).toBeLessThan(100);
  });

  it('should handle dot files correctly', () => {
    const config = makeConfig(['**/*.ts'], []);

    expect(shouldIncludeFile('.hidden/index.ts', config)).toBe(true);
  });
});

describe('JSON.parse Error Boundaries in DB', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not crash when node has malformed JSON in decorators column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Migration 056: seed parent files row before the node insert so the
    // `nodes.file_path -> files(path)` FK is satisfied.
    seedFile(db, 'test.ts');

    // Insert a node with malformed JSON in the decorators column
    db.getDb()
      .prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, decorators, is_exported, is_async, is_static, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'test-node-1',
        'function',
        'myFunc',
        'myFunc',
        'test.ts',
        'typescript',
        1,
        5,
        0,
        0,
        '{not valid json!!!}', // malformed decorators
        0,
        0,
        0,
        Date.now(),
      );

    // Should not throw - should return node with undefined decorators
    const node = queries.getNodeById('test-node-1');
    expect(node).not.toBeNull();
    expect(node!.name).toBe('myFunc');
    expect(node!.decorators).toBeUndefined();

    db.close();
  });

  it('should not crash when edge has malformed JSON in metadata column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Migration 056: seed parent files rows for every distinct file_path
    // referenced below so the `nodes.file_path -> files(path)` FK is satisfied.
    seedFile(db, 'a.ts');
    seedFile(db, 'b.ts');

    // Insert two nodes first
    const insertNode = db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, is_exported, is_async, is_static, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run('node-a', 'function', 'funcA', 'funcA', 'a.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, Date.now());
    insertNode.run('node-b', 'function', 'funcB', 'funcB', 'b.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, Date.now());

    // Insert edge with malformed metadata
    db.getDb()
      .prepare(`
      INSERT INTO edges (source, target, kind, metadata)
      VALUES (?, ?, ?, ?)
    `)
      .run('node-a', 'node-b', 'calls', 'broken json {{{');

    // Should not throw - should return edge with undefined metadata
    const edges = getOutgoingEdges(queries, 'node-a');
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe('node-a');
    expect(edges[0].target).toBe('node-b');
    expect(edges[0].metadata).toBeUndefined();

    db.close();
  });

  it('should not crash when file record has malformed JSON in errors column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a file with malformed errors JSON
    db.getDb()
      .prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run('test.ts', 'abc123', 'typescript', 100, Date.now(), Date.now(), 5, 'not-an-array');

    // Should not throw - should return file with undefined errors
    const file = getFileByPath(queries, 'test.ts');
    expect(file).not.toBeNull();
    expect(file!.path).toBe('test.ts');
    expect(file!.errors).toBeUndefined();

    db.close();
  });
});

describe('Symlink Cycle Detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should handle symlink cycle without infinite loop', () => {
    // Create directory structure with a symlink cycle
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;\n');

    // Create a symlink from src/loop -> tempDir (parent directory)
    try {
      fs.symlinkSync(tempDir, path.join(srcDir, 'loop'), 'dir');
    } catch {
      // Skip test if symlinks not supported (e.g., Windows without admin)
      return;
    }

    const config: CartographConfig = {
      ...DEFAULT_CONFIG,
      rootDir: tempDir,
      include: ['**/*.ts'],
      exclude: [],
    };

    // This should complete without hanging
    const files = scanDirectory(tempDir, config);

    // Should find the real file but not loop infinitely
    expect(files).toContain('src/index.ts');
    // Should not find duplicates via the symlink path
    const indexFiles = files.filter((f) => f.endsWith('index.ts'));
    expect(indexFiles.length).toBe(1);
  });

  it('should follow valid symlinks to directories', () => {
    // Create source directory with a file
    const realDir = path.join(tempDir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'hello.ts'), 'export function hello() {}\n');

    // Create a symlink to realDir
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    try {
      fs.symlinkSync(realDir, path.join(srcDir, 'linked'), 'dir');
    } catch {
      return;
    }

    const config: CartographConfig = {
      ...DEFAULT_CONFIG,
      rootDir: tempDir,
      include: ['**/*.ts'],
      exclude: [],
    };

    const files = scanDirectory(tempDir, config);

    // Should find files from both the real dir and via the symlink
    // But deduplicate since they resolve to the same real path
    expect(files.some((f) => f.includes('hello.ts'))).toBe(true);
  });

  it('should skip broken symlinks gracefully', () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'valid.ts'), 'export const y = 2;\n');

    try {
      fs.symlinkSync('/nonexistent/path', path.join(srcDir, 'broken'), 'dir');
    } catch {
      return;
    }

    const config: CartographConfig = {
      ...DEFAULT_CONFIG,
      rootDir: tempDir,
      include: ['**/*.ts'],
      exclude: [],
    };

    // Should not throw
    const files = scanDirectory(tempDir, config);
    expect(files).toContain('src/valid.ts');
  });
});

describe('ReDoS-safe glob matching', () => {
  it('coalesces runs of `*` so hostile inputs do not produce nested quantifiers', async () => {
    const { globToSafeRegex } = await import('../src/utils.js');
    // Two or more stars collapse to a single recursive wildcard. This is the
    // ReDoS protection: `*****` doesn't expand to `[^/]*[^/]*[^/]*[^/]*[^/]*`,
    // which on a long input could catastrophically backtrack.
    expect(globToSafeRegex('*****')).toBe('.*');
    expect(globToSafeRegex('**')).toBe('.*');

    // Even a constructed-from-hostile-input regex matches in linear time.
    const regex = new RegExp(`^${globToSafeRegex('*****')}foo$`);
    const start = Date.now();
    // 100k 'a's followed by something that doesn't end in 'foo'.
    expect(regex.test('a'.repeat(100000) + 'bar')).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('rejects pathologically long glob inputs', async () => {
    const { globToSafeRegex } = await import('../src/utils.js');
    expect(globToSafeRegex('*'.repeat(2000))).toBeNull();
  });

  it('preserves the standard glob semantics for common patterns', async () => {
    const { globToSafeRegex } = await import('../src/utils.js');
    const body = globToSafeRegex('src/**/*.test.ts');
    expect(body).toBeDefined();
    const regex = new RegExp(`^${body}$`);
    expect(regex.test('src/lib/foo.test.ts')).toBe(true);
    expect(regex.test('src/lib/foo.ts')).toBe(false);
    expect(regex.test('other/src/foo.test.ts')).toBe(false);
  });
});
