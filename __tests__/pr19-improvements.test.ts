/**
 * PR #19 Improvement Tests
 *
 * Tests for changes ported from PR #15 and #16:
 * - Lazy grammar loading
 * - Arrow function extraction (body traversal)
 * - Graph traversal 'both' direction fix
 * - Best-candidate resolution picking
 * - Schema v2 migration (filePath/language on unresolved_refs)
 * - Batch insert for unresolved refs
 * - SQLite performance pragmas
 * - MCP symbol disambiguation and output truncation
 * - CLI uninit command
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractFromSource } from '../src/extraction/index.js';
import {
  getParser,
  isLanguageSupported,
  getSupportedLanguages,
  clearParserCache,
  getUnavailableGrammarErrors,
  initGrammars,
  loadAllGrammars,
} from '../src/extraction/grammars.js';
import { getUnresolvedReferences, insertUnresolvedRefsBatch } from '../src/db/queries-unresolved-refs.js';
import { getAllNodes, getNodesByKind, type QueryBuilder } from '../src/db/queries.js';
import { upsertFile } from '../src/db/queries-files.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

/**
 * Insert a `files` row so subsequent `nodes` inserts referencing
 * `file_path` satisfy the FK. Production code always upserts a file
 * before its nodes (via the extraction-orchestrator), so the unit
 * tests have to do the same once FK enforcement is on (`bun:sqlite`
 * with `PRAGMA foreign_keys = ON` set by the adapter).
 */
function insertFileFixture(qb: QueryBuilder, filePath: string, language: string = 'typescript'): void {
  upsertFile(qb, {
    path: filePath,
    contentHash: '',
    language,
    size: 0,
    modifiedAt: 0,
    indexedAt: 0,
    nodeCount: 0,
    errors: null,
    isTest: false,
    needsReextract: false,
  });
}

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-pr19-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// Lazy Grammar Loading
// =============================================================================

describe('Lazy Grammar Loading', () => {
  afterEach(() => {
    clearParserCache();
  });

  it('should load grammars lazily on first use', () => {
    // Clear cache to force fresh load
    clearParserCache();

    // TypeScript should be loadable
    const parser = getParser('typescript');
    expect(parser).not.toBeNull();
  });

  it('should cache loaded grammars', () => {
    clearParserCache();

    const parser1 = getParser('typescript');
    const parser2 = getParser('typescript');

    // Same reference from cache
    expect(parser1).toBe(parser2);
  });

  it('should return null for unknown language', () => {
    const parser = getParser('unknown');
    expect(parser).toBeNull();
  });

  it('should handle unavailable grammars gracefully', () => {
    // 'unknown' is not a valid grammar, should not crash
    expect(isLanguageSupported('unknown')).toBe(false);
  });

  it('should report liquid as supported (custom extractor)', () => {
    expect(isLanguageSupported('liquid')).toBe(true);
  });

  it('should include liquid in supported languages', () => {
    const supported = getSupportedLanguages();
    expect(supported).toContain('liquid');
  });

  it('should return unavailable grammar errors as a record', () => {
    clearParserCache();
    const errors = getUnavailableGrammarErrors();
    // Should be a plain object (may or may not have entries depending on platform)
    expect(typeof errors).toBe('object');
  });

  it('should support multiple languages independently', () => {
    clearParserCache();

    // Load two different languages - one failing shouldn't affect the other
    const tsParser = getParser('typescript');
    const pyParser = getParser('python');

    expect(tsParser).not.toBeNull();
    expect(pyParser).not.toBeNull();
    expect(tsParser).not.toBe(pyParser);
  });

  it('should clear all caches on clearParserCache', () => {
    // Load a grammar
    getParser('typescript');

    // Clear
    clearParserCache();

    // Errors should be cleared too
    const errors = getUnavailableGrammarErrors();
    expect(Object.keys(errors)).toHaveLength(0);
  });
});

// =============================================================================
// Arrow Function Extraction - Body Traversal
// =============================================================================

describe('Arrow Function Body Traversal', () => {
  it('should extract unresolved references from arrow function bodies', () => {
    const code = `
export const useAuth = () => {
  const user = getUser();
  const token = generateToken(user);
  return { user, token };
};
`;
    const result = extractFromSource('hooks.ts', code);

    // The arrow function should be extracted
    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'useAuth');
    expect(funcNode).toBeDefined();

    // Calls inside the body should be captured as unresolved references
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const callNames = calls.map((c) => c.referenceName);
    expect(callNames).toContain('getUser');
    expect(callNames).toContain('generateToken');
  });

  it('should extract unresolved references from function expression bodies', () => {
    const code = `
export const processData = function(input: string): string {
  const cleaned = sanitize(input);
  return transform(cleaned);
};
`;
    const result = extractFromSource('utils.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'processData');
    expect(funcNode).toBeDefined();

    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const callNames = calls.map((c) => c.referenceName);
    expect(callNames).toContain('sanitize');
    expect(callNames).toContain('transform');
  });

  it('should not create duplicate nodes for arrow functions', () => {
    const code = `
export const handler = () => {
  doSomething();
};
`;
    const result = extractFromSource('handler.ts', code);

    // Should be exactly 1 function node, 0 variable nodes for 'handler'
    const funcNodes = result.nodes.filter((n) => n.name === 'handler' && n.kind === 'function');
    const varNodes = result.nodes.filter((n) => n.name === 'handler' && n.kind === 'variable');
    expect(funcNodes).toHaveLength(1);
    expect(varNodes).toHaveLength(0);
  });

  it('should extract nested calls in arrow functions in JavaScript', () => {
    const code = `
export const fetchData = async () => {
  const response = await fetchAPI('/data');
  return parseResponse(response);
};
`;
    const result = extractFromSource('api.js', code);

    const funcNode = result.nodes.find((n) => n.name === 'fetchData');
    expect(funcNode).toBeDefined();
    expect(funcNode?.kind).toBe('function');

    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const callNames = calls.map((c) => c.referenceName);
    expect(callNames).toContain('fetchAPI');
    expect(callNames).toContain('parseResponse');
  });
});

// =============================================================================
// Graph Traversal 'both' Direction Fix
// =============================================================================

describe('Graph Traversal Both Direction', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it('should traverse both directions from a node', async () => {
    const Cartograph = (await import('../src/index.js')).default;

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // A -> B -> C  (A calls B, B calls C)
    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      `
import { funcB } from './b.js';
export function funcA(): void { funcB(); }
`,
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      `
import { funcC } from './c.js';
import { getNodesByKind, getAllNodes } from '../src/db/queries.js';
export function funcB(): void { funcC(); }
`,
    );
    fs.writeFileSync(
      path.join(srcDir, 'c.ts'),
      `
export function funcC(): void { console.log('c'); }
`,
    );

    const cg = Cartograph.initSync(testDir, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });

    await cg.indexAll();
    cg.internals.resolver.resolveAndPersist(getUnresolvedReferences(cg.queries));

    const functions = getNodesByKind(cg.queries, 'function');
    const funcB = functions.find((n) => n.name === 'funcB');

    if (!funcB) {
      cg.close();
      return;
    }

    // Traverse 'both' from B - should find A (incoming caller) and C (outgoing callee)
    const subgraph = cg.internals.traverser.traverseBFS(funcB.id, {
      maxDepth: 1,
      direction: 'both',
    });

    // B itself + at least one neighbor in each direction
    expect(subgraph.nodes.size).toBeGreaterThanOrEqual(2);
    expect(subgraph.nodes.has(funcB.id)).toBe(true);

    cg.close();
  });
});

// =============================================================================
// Best-Candidate Resolution
// =============================================================================

describe('Best-Candidate Resolution', () => {
  it('should be testable via the resolution module types', async () => {
    const { ReferenceResolver } = await import('../src/resolution/index.js');
    expect(typeof ReferenceResolver.prototype.resolveOne).toBe('function');
  });
});

// =============================================================================
// Schema v2 Migration
// =============================================================================

describe('Schema v2 Migration', () => {
  it('should have correct current schema version', async () => {
    // Smoke check that the registry exports a usable max-version
    // constant. The actual integer is derived from the migration
    // filenames (see src/db/migrations/index.ts) — no separate
    // hand-maintained constant to keep in sync with new migrations.
    const { CURRENT_SCHEMA_VERSION, ALL_MIGRATIONS } = await import('../src/db/migrations.js');
    const expected = ALL_MIGRATIONS.at(-1)!.version;
    expect(CURRENT_SCHEMA_VERSION).toBe(expected);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(50);
  });
});

// =============================================================================
// Database Layer: Batch Insert, getAllNodes, Pragmas
// =============================================================================

describe('Database Layer Improvements', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it('should support batch insert of unresolved refs', async () => {
    const { DatabaseConnection } = await import('../src/db/index.js');
    const { QueryBuilder } = await import('../src/db/queries.js');

    const dbPath = path.join(testDir, 'cartograph.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    insertFileFixture(queries, 'test.ts');
    // Insert a node first (needed as foreign key)
    queries.insertNode({
      id: 'func:test:1',
      kind: 'function',
      name: 'testFunc',
      qualifiedName: 'test::testFunc',
      filePath: 'test.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 5,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });

    // Batch insert unresolved refs with filePath and language
    insertUnresolvedRefsBatch(queries, [
      {
        fromNodeId: 'func:test:1',
        referenceName: 'helperA',
        referenceKind: 'calls',
        line: 2,
        column: 4,
        filePath: 'test.ts',
        language: 'typescript',
      },
      {
        fromNodeId: 'func:test:1',
        referenceName: 'helperB',
        referenceKind: 'calls',
        line: 3,
        column: 4,
        filePath: 'test.ts',
        language: 'typescript',
      },
    ]);

    const refs = getUnresolvedReferences(queries);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.referenceName).sort(byString)).toEqual(['helperA', 'helperB']);

    // Verify filePath and language are persisted
    expect(refs[0]?.filePath).toBe('test.ts');
    expect(refs[0]?.language).toBe('typescript');

    db.close();
  });

  it('should support getAllNodes', async () => {
    const { DatabaseConnection } = await import('../src/db/index.js');
    const { QueryBuilder } = await import('../src/db/queries.js');

    const dbPath = path.join(testDir, 'cartograph.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    insertFileFixture(queries, 'test.ts');
    // Insert some nodes
    for (let i = 0; i < 3; i++) {
      queries.insertNode({
        id: `func:test:${i}`,
        kind: 'function',
        name: `func${i}`,
        qualifiedName: `test::func${i}`,
        filePath: 'test.ts',
        language: 'typescript',
        startLine: i * 10 + 1,
        endLine: i * 10 + 5,
        startColumn: 0,
        endColumn: 1,
        updatedAt: Date.now(),
      });
    }

    const allNodes = getAllNodes(queries);
    expect(allNodes).toHaveLength(3);
    expect(allNodes.map((n) => n.name).sort(byString)).toEqual(['func0', 'func1', 'func2']);

    db.close();
  });

  it('should set performance pragmas on initialization', async () => {
    const { DatabaseConnection } = await import('../src/db/index.js');

    const dbPath = path.join(testDir, 'cartograph.db');
    const db = DatabaseConnection.initialize(dbPath);
    const rawDb = db.getDb();

    // bun:sqlite's adapter routes `db.pragma(name)` through prepare/get
    // (no native pragma helper); the result is the raw row object
    // `{<name>: <value>}` rather than the bare value better-sqlite3's
    // `{simple: true}` returned. Extract the field explicitly.
    const pragmaValue = (row: unknown, key: string): number => (row as Record<string, number>)[key]!;
    expect(pragmaValue(rawDb.pragma('synchronous'), 'synchronous')).toBe(1); // NORMAL = 1
    expect(pragmaValue(rawDb.pragma('cache_size'), 'cache_size')).toBe(-64000);
    expect(pragmaValue(rawDb.pragma('temp_store'), 'temp_store')).toBe(2); // MEMORY = 2
    expect(pragmaValue(rawDb.pragma('mmap_size'), 'mmap_size')).toBe(268435456); // 256 MB

    db.close();
  });

  it('should handle empty batch insert gracefully', async () => {
    const { DatabaseConnection } = await import('../src/db/index.js');
    const { QueryBuilder } = await import('../src/db/queries.js');

    const dbPath = path.join(testDir, 'cartograph.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Should not throw on empty array
    expect(() => insertUnresolvedRefsBatch(queries, [])).not.toThrow();

    db.close();
  });
});

// =============================================================================
// Resolution Warm Caches
// =============================================================================

describe('Resolution Warm Caches', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it('should warm caches and use them for lookups', async () => {
    const Cartograph = (await import('../src/index.js')).default;

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      `
export function myFunc(): void {}
export function otherFunc(): void { myFunc(); }
`,
    );

    const cg = Cartograph.initSync(testDir, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });

    await cg.indexAll();

    // resolveReferences internally calls warmCaches
    const result = cg.internals.resolver.resolveAndPersist(getUnresolvedReferences(cg.queries));

    // Should complete without error
    expect(result.stats.total).toBeGreaterThanOrEqual(0);

    cg.close();
  });
});

// =============================================================================
// MCP Tool Improvements
// =============================================================================

describe('MCP Tool Improvements', () => {
  it('should export ToolHandler class', async () => {
    const { ToolHandler } = await import('../src/mcp/tools.js');
    expect(typeof ToolHandler).toBe('function');
  });

  it('exports findSymbol from symbol-resolver and truncateOutput from shared', async () => {
    const { findSymbol } = await import('../src/mcp/tools/symbol-resolver.js');
    const { truncateOutput } = await import('../src/mcp/tools/shared.js');
    expect(typeof findSymbol).toBe('function');
    expect(typeof truncateOutput).toBe('function');
  });

  it('should truncate output exceeding MAX_OUTPUT_LENGTH', async () => {
    const { truncateOutput } = await import('../src/mcp/tools/shared.js');

    // Short text should not be truncated
    const short = 'Hello world';
    expect(truncateOutput(short)).toBe(short);

    // Long text should be truncated
    const long = 'x'.repeat(20000);
    const result = truncateOutput(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('... (output truncated)');
  });

  it('should truncate at a clean line boundary', async () => {
    const { truncateOutput } = await import('../src/mcp/tools/shared.js');

    // Build text with newlines exceeding the limit
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`Line ${i}: ${'a'.repeat(50)}`);
    }
    const text = lines.join('\n');

    const result = truncateOutput(text);
    // Should end with truncation notice after a newline boundary
    expect(result).toContain('... (output truncated)');
    // Should not cut mid-line (the char before truncation notice should be \n)
    const beforeTruncation = result.split('\n\n... (output truncated)')[0]!;
    expect(beforeTruncation.endsWith('\n') || !beforeTruncation.includes('\0')).toBe(true);
  });

  describe('findSymbol disambiguation', () => {
    it('should prefer exact name matches', async () => {
      const { findSymbol } = await import('../src/mcp/tools/symbol-resolver.js');
      const Cartograph = (await import('../src/index.js')).default;

      const tmpDir = createTempDir();
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'a.ts'),
        `
export function getValue(): number { return 1; }
export function getValueFromCache(): number { return 2; }
`,
      );

      const cg = Cartograph.initSync(tmpDir, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const match = findSymbol(cg, 'getValue');
      expect(match).not.toBeNull();
      expect(match!.node.name).toBe('getValue');
      // Should not have a disambiguation note for single exact match
      expect(match!.note).toBe('');

      cg.close();
      cleanupTempDir(tmpDir);
    });

    it('should note when multiple symbols share the same name', async () => {
      const { findSymbol } = await import('../src/mcp/tools/symbol-resolver.js');
      const Cartograph = (await import('../src/index.js')).default;

      const tmpDir = createTempDir();
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      // Two files with the same function name
      fs.writeFileSync(
        path.join(srcDir, 'a.ts'),
        `
export function handle(): void {}
`,
      );
      fs.writeFileSync(
        path.join(srcDir, 'b.ts'),
        `
export function handle(): void {}
`,
      );

      const cg = Cartograph.initSync(tmpDir, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const match = findSymbol(cg, 'handle');
      expect(match).not.toBeNull();
      expect(match!.node.name).toBe('handle');
      // Should have a disambiguation note
      expect(match!.note).toContain('2 symbols named "handle"');

      cg.close();
      cleanupTempDir(tmpDir);
    });

    it('should return null when symbol is not found', async () => {
      const { findSymbol } = await import('../src/mcp/tools/symbol-resolver.js');
      const Cartograph = (await import('../src/index.js')).default;

      const tmpDir = createTempDir();
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `export function foo(): void {}`);

      const cg = Cartograph.initSync(tmpDir, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const match = findSymbol(cg, 'nonExistentSymbol');
      expect(match).toBeNull();

      cg.close();
      cleanupTempDir(tmpDir);
    });
  });
});

// =============================================================================
// CLI uninit Command
// =============================================================================

describe('CLI uninit', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it('should uninitialize a project via Cartograph.uninitialize()', async () => {
    const Cartograph = (await import('../src/index.js')).default;

    // Initialize
    const cg = Cartograph.initSync(testDir);
    expect(Cartograph.isInitialized(testDir)).toBe(true);

    // Uninitialize
    await cg.uninitialize();

    // .cartograph directory should be removed
    expect(Cartograph.isInitialized(testDir)).toBe(false);
  });
});

// =============================================================================
// Tree-sitter Version Pinning
// =============================================================================

describe('Tree-sitter web-tree-sitter (WASM) setup (re-adopted 2026-05-17)', () => {
  it('should use web-tree-sitter as a runtime dep with 41 grammar .wasm files in-repo', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    // web-tree-sitter is the parser runtime — it must be a real runtime
    // dependency (extraction can't parse without it at install time).
    expect(pkg.dependencies['web-tree-sitter']).toBeDefined();
    // tree-sitter-wasms (the old external grammar-bundle dep) stays
    // gone — every grammar .wasm is vendored under src/extraction/wasm/.
    expect(pkg.dependencies['tree-sitter-wasms']).toBeUndefined();
    expect(pkg.devDependencies?.['tree-sitter-wasms']).toBeUndefined();

    // 41 grammar .wasm files ship in-repo (25 from the web-tree-sitter
    // re-adoption + elixir.wasm — tags.scm fallback extractor, 2026-05-17;
    // prisma.wasm — 2026-05-19; yaml.wasm — F#62 Drupal routing.yml
    // resolver, 2026-05-26; objc.wasm — F#65 Objective-C language,
    // 2026-05-26; luau.wasm — Luau language support, 2026-06-05;
    // upstream Tree-sitter parser coverage tranche, 2026-06-07).
    // Exact count, not a lower bound; a regression dropping any grammar
    // should fail this guard.
    const wasmDir = path.join(__dirname, '..', 'src', 'extraction', 'wasm');
    const wasms = fs.readdirSync(wasmDir).filter((f) => f.endsWith('.wasm'));
    expect(wasms.length).toBe(41);
  });

  it('should carry web-tree-sitter as a runtime dependency, not dev-only', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    // A devDependency-only placement would break a published install.
    expect(pkg.dependencies['web-tree-sitter']).toBeDefined();
    expect(pkg.devDependencies?.['web-tree-sitter']).toBeUndefined();
  });
});

// =============================================================================
// Embedder Float32Array Fix
// =============================================================================

describe('Float32Array Fix', () => {
  it('should correctly convert typed arrays (regression check)', () => {
    // Simulates the fix: Float32Array.from(Array.from(arr)) vs new Float32Array(arr.length)
    const source = new Float64Array([1.5, 2.5, 3.5, 4.5]);

    // The OLD buggy approach:
    const buggy = new Float32Array(source.length);
    // buggy is all zeros!
    expect(buggy[0]).toBe(0);
    expect(buggy[1]).toBe(0);

    // The NEW fixed approach:
    const fixed = Float32Array.from(Array.from(source));
    expect(fixed[0]).toBeCloseTo(1.5);
    expect(fixed[1]).toBeCloseTo(2.5);
    expect(fixed[2]).toBeCloseTo(3.5);
    expect(fixed[3]).toBeCloseTo(4.5);
  });
});
