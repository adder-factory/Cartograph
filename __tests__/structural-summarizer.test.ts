/**
 * Structural Summariser Tests
 *
 * Covers the deterministic pattern-matching pipeline introduced in
 * `src/llm/structural-summarizer.ts`. Each test uses a fresh SQLite DB
 * (via `DatabaseConnection.initialize`) so there is no shared state.
 *
 * Patterns under test:
 *   1. Route synth — "HTTP METHOD /path", with handler summary appended.
 *   2. One-call forwarder — "Delegates to X".
 *   3. One-instantiation factory — "Factory for X".
 *   4. Re-export — "Re-exports X from path/y.ts".
 *   5. Existing non-structural summary is preserved (preserved counter).
 *   6. Body change invalidates the structural cache (hash mismatch path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { insertEdge } from '../src/db/queries-edges.js';
import { upsertSymbolSummary, getSymbolSummary } from '../src/db/queries-summaries.js';
import { runStructuralSummariser } from '../src/llm/structural-summarizer.js';
import type { Node } from '../src/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-struct-sum-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a minimal Node fixture, defaulting to a 1-line function. */
function makeNode(overrides: Partial<Node> & Pick<Node, 'id' | 'name'>): Node {
  return {
    kind: 'function',
    qualifiedName: overrides.name,
    filePath: 'src/a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 2, // 1-line body (endLine - startLine = 1)
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runStructuralSummariser', () => {
  let dir: string;
  let dbConn: DatabaseConnection;
  let qb: QueryBuilder;
  /** Absolute path to a source file whose lines we'll write for body-read tests. */
  let srcFile: string;

  beforeEach(() => {
    dir = createTempDir();
    // The structural summariser reads body lines from disk; create a
    // minimal source file so `validatePathWithinRootReal` succeeds.
    fs.mkdirSync(path.join(dir, 'src'));
    srcFile = path.join(dir, 'src', 'a.ts');
    // Write 5 lines so even a 3-line slice lands within the file.
    fs.writeFileSync(
      srcFile,
      [
        'export function alpha() {', // line 1
        '  return beta();', // line 2
        '}', // line 3
        '', // line 4
        '', // line 5
      ].join('\n'),
    );

    dbConn = DatabaseConnection.initialize(path.join(dir, 'cartograph.db'));
    qb = new QueryBuilder(dbConn.getDb());

    // Register the source file in the `files` table so FK constraints
    // (if any) don't block node inserts.
    dbConn
      .getDb()
      .prepare(
        `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES (?, '', 'typescript', 0, 0, 0)`,
      )
      .run('src/a.ts');
  });

  afterEach(() => {
    dbConn.close();
    cleanupTempDir(dir);
  });

  // -------------------------------------------------------------------------
  // 1. Route pattern
  // -------------------------------------------------------------------------

  it('route without a handler produces "HTTP METHOD /path"', async () => {
    qb.insertNode(
      makeNode({
        id: 'route:1',
        name: 'POST /api/users',
        kind: 'route',
        startLine: 1,
        endLine: 1,
      }),
    );

    const result = await runStructuralSummariser({ projectRoot: dir, queries: qb });

    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.generated).toBeGreaterThanOrEqual(1);

    const saved = getSymbolSummary(qb, 'route:1');
    expect(saved).not.toBeNull();
    expect(saved!.summary).toMatch(/^HTTP POST \/api\/users/);
    expect(saved!.model).toBe('structural:v1');
  });

  it('route with a handler appends handler summary when one exists', async () => {
    // Handler function with a pre-existing LLM summary
    qb.insertNode(
      makeNode({
        id: 'fn:handler',
        name: 'createUser',
        kind: 'function',
        startLine: 10,
        endLine: 20, // large body — not a structural candidate itself
      }),
    );
    upsertSymbolSummary({
      qb,
      nodeId: 'fn:handler',
      contentHash: 'abc',
      summary: 'Creates a new user record in the database',
      model: 'test:v1',
    });

    qb.insertNode(
      makeNode({
        id: 'route:2',
        name: 'POST /api/users',
        kind: 'route',
        startLine: 1,
        endLine: 1,
      }),
    );
    insertEdge(qb, { source: 'route:2', target: 'fn:handler', kind: 'calls' });

    const result = await runStructuralSummariser({ projectRoot: dir, queries: qb });
    expect(result.generated).toBeGreaterThanOrEqual(1);

    const saved = getSymbolSummary(qb, 'route:2');
    expect(saved).not.toBeNull();
    expect(saved!.summary).toMatch(/HTTP POST \/api\/users/);
    expect(saved!.summary).toContain('Creates a new user record');
  });

  // -------------------------------------------------------------------------
  // 2. One-call forwarder pattern
  // -------------------------------------------------------------------------

  it('one-call forwarder produces "Delegates to X"', async () => {
    qb.insertNode(makeNode({ id: 'fn:target', name: 'betaImpl', startLine: 10, endLine: 20 }));
    qb.insertNode(
      makeNode({
        id: 'fn:forwarder',
        name: 'alpha',
        startLine: 1,
        endLine: 2, // 1-line body
      }),
    );
    insertEdge(qb, { source: 'fn:forwarder', target: 'fn:target', kind: 'calls' });

    const result = await runStructuralSummariser({ projectRoot: dir, queries: qb });
    expect(result.generated).toBeGreaterThanOrEqual(1);

    const saved = getSymbolSummary(qb, 'fn:forwarder');
    expect(saved).not.toBeNull();
    expect(saved!.summary).toMatch(/^Delegates to betaImpl/);
  });

  it('forwarder with target summary appends the summary', async () => {
    qb.insertNode(makeNode({ id: 'fn:target', name: 'betaImpl', startLine: 10, endLine: 20 }));
    upsertSymbolSummary({
      qb,
      nodeId: 'fn:target',
      contentHash: 'h1',
      summary: 'Validates user input fields',
      model: 'llm:v1',
    });
    qb.insertNode(
      makeNode({
        id: 'fn:forwarder',
        name: 'alpha',
        startLine: 1,
        endLine: 2,
      }),
    );
    insertEdge(qb, { source: 'fn:forwarder', target: 'fn:target', kind: 'calls' });

    await runStructuralSummariser({ projectRoot: dir, queries: qb });

    const saved = getSymbolSummary(qb, 'fn:forwarder');
    expect(saved!.summary).toMatch(/Delegates to betaImpl \(Validates user input fields\)/);
  });

  it('function with multiple calls edges does NOT match forwarder pattern', async () => {
    qb.insertNode(makeNode({ id: 'fn:t1', name: 'target1', startLine: 10, endLine: 20 }));
    qb.insertNode(makeNode({ id: 'fn:t2', name: 'target2', startLine: 30, endLine: 40 }));
    qb.insertNode(
      makeNode({
        id: 'fn:multi',
        name: 'multiCaller',
        startLine: 1,
        endLine: 2,
      }),
    );
    insertEdge(qb, { source: 'fn:multi', target: 'fn:t1', kind: 'calls' });
    insertEdge(qb, { source: 'fn:multi', target: 'fn:t2', kind: 'calls' });

    await runStructuralSummariser({ projectRoot: dir, queries: qb });

    // Should NOT have gotten the forwarder summary — multi-calls doesn't match
    const saved = getSymbolSummary(qb, 'fn:multi');
    if (saved) {
      expect(saved.summary).not.toMatch(/^Delegates to/);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Factory pattern
  // -------------------------------------------------------------------------

  it('one-instantiation factory produces "Factory for X"', async () => {
    qb.insertNode(makeNode({ id: 'cls:Foo', name: 'FooService', kind: 'class', startLine: 10, endLine: 50 }));
    qb.insertNode(
      makeNode({
        id: 'fn:createFoo',
        name: 'createFoo',
        startLine: 1,
        endLine: 2,
      }),
    );
    insertEdge(qb, { source: 'fn:createFoo', target: 'cls:Foo', kind: 'instantiates' });

    const result = await runStructuralSummariser({ projectRoot: dir, queries: qb });
    expect(result.generated).toBeGreaterThanOrEqual(1);

    const saved = getSymbolSummary(qb, 'fn:createFoo');
    expect(saved).not.toBeNull();
    expect(saved!.summary).toBe('Factory for FooService');
  });

  // -------------------------------------------------------------------------
  // 4. Re-export pattern
  // -------------------------------------------------------------------------

  it('re-export across files produces "Re-exports X from ..."', async () => {
    // Target in a different file
    dbConn
      .getDb()
      .prepare(
        `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES (?, '', 'typescript', 0, 0, 0)`,
      )
      .run('src/b.ts');

    qb.insertNode({
      id: 'fn:origImpl',
      kind: 'function',
      name: 'origImpl',
      qualifiedName: 'origImpl',
      filePath: 'src/b.ts',
      language: 'typescript',
      startLine: 5,
      endLine: 20,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    qb.insertNode(
      makeNode({
        id: 'fn:reExporter',
        name: 'origImpl',
        kind: 'function',
        startLine: 1,
        endLine: 2,
      }),
    );
    insertEdge(qb, { source: 'fn:reExporter', target: 'fn:origImpl', kind: 'references' });

    await runStructuralSummariser({ projectRoot: dir, queries: qb });

    const saved = getSymbolSummary(qb, 'fn:reExporter');
    expect(saved).not.toBeNull();
    expect(saved!.summary).toMatch(/Re-exports origImpl from/);
  });

  // -------------------------------------------------------------------------
  // 5. Preserved: existing non-structural summary is kept
  // -------------------------------------------------------------------------

  it('existing non-structural summary is preserved, counter increments', async () => {
    qb.insertNode(
      makeNode({
        id: 'fn:withLLM',
        name: 'withLLM',
        startLine: 1,
        endLine: 2,
      }),
    );
    // Write an LLM-generated summary
    upsertSymbolSummary({
      qb,
      nodeId: 'fn:withLLM',
      contentHash: 'llm-hash',
      summary: 'A very specific LLM summary that must not be clobbered',
      model: 'qwen:7b',
    });

    const result = await runStructuralSummariser({ projectRoot: dir, queries: qb });

    expect(result.preserved).toBeGreaterThanOrEqual(1);
    // The LLM summary must not be overwritten
    const saved = getSymbolSummary(qb, 'fn:withLLM');
    expect(saved!.summary).toBe('A very specific LLM summary that must not be clobbered');
    expect(saved!.model).toBe('qwen:7b');
  });

  // -------------------------------------------------------------------------
  // 6. Content-hash invalidation
  // -------------------------------------------------------------------------

  it('body change invalidates a stale structural summary', async () => {
    qb.insertNode(makeNode({ id: 'fn:target', name: 'implFn', startLine: 10, endLine: 20 }));
    qb.insertNode(
      makeNode({
        id: 'fn:stable',
        name: 'stableForwarder',
        startLine: 1,
        endLine: 2,
      }),
    );
    insertEdge(qb, { source: 'fn:stable', target: 'fn:target', kind: 'calls' });

    // First pass — generates the summary and caches the hash
    await runStructuralSummariser({ projectRoot: dir, queries: qb });
    const first = getSymbolSummary(qb, 'fn:stable');
    expect(first).not.toBeNull();
    const firstHash = first!.contentHash;

    // Change the source file so the content hash changes
    fs.writeFileSync(
      srcFile,
      [
        'export function stableForwarder() {', // line 1
        '  return implFn() + 1;', // line 2 (body changed)
        '}', // line 3
      ].join('\n'),
    );

    // Second pass — the structural summary should be regenerated
    await runStructuralSummariser({ projectRoot: dir, queries: qb });
    const second = getSymbolSummary(qb, 'fn:stable');
    expect(second).not.toBeNull();
    // Hash must differ because the body changed
    expect(second!.contentHash).not.toBe(firstHash);
  });

  // -------------------------------------------------------------------------
  // 7. Type alias pattern
  // -------------------------------------------------------------------------

  it('type alias with no edges produces "Type alias for ..." from signature', async () => {
    qb.insertNode(
      makeNode({
        id: 'ta:UserId',
        name: 'UserId',
        kind: 'type_alias',
        signature: 'type UserId = string',
        startLine: 1,
        endLine: 1,
      }),
    );

    await runStructuralSummariser({ projectRoot: dir, queries: qb });

    const saved = getSymbolSummary(qb, 'ta:UserId');
    expect(saved).not.toBeNull();
    expect(saved!.summary).toMatch(/^Type alias for string/);
  });

  // -------------------------------------------------------------------------
  // 8. Abstract / declaration-only pattern
  // -------------------------------------------------------------------------

  it('declaration-only signature (ends with ;) produces "Abstract function: name"', async () => {
    qb.insertNode(
      makeNode({
        id: 'fn:decl',
        name: 'fetchUser',
        kind: 'function',
        signature: 'function fetchUser(id: string): User;',
        startLine: 1,
        endLine: 1,
      }),
    );

    await runStructuralSummariser({ projectRoot: dir, queries: qb });

    const saved = getSymbolSummary(qb, 'fn:decl');
    expect(saved).not.toBeNull();
    expect(saved!.summary).toMatch(/^Abstract function: fetchUser/);
  });

  // -------------------------------------------------------------------------
  // 9. Progress callback fires
  // -------------------------------------------------------------------------

  it('onProgress callback is called for every candidate', async () => {
    qb.insertNode(makeNode({ id: 'fn:p1', name: 'p1', startLine: 1, endLine: 1 }));
    qb.insertNode(makeNode({ id: 'fn:p2', name: 'p2', startLine: 2, endLine: 2 }));

    const calls: [number, number][] = [];
    await runStructuralSummariser({
      projectRoot: dir,
      queries: qb,
      options: {
        onProgress: (done, total) => calls.push([done, total]),
      },
    });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Progress should be monotonically increasing
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]![0]).toBeGreaterThanOrEqual(calls[i - 1]![0]);
    }
  });

  // -------------------------------------------------------------------------
  // 10. AbortSignal stops processing early
  // -------------------------------------------------------------------------

  it('AbortSignal cancels remaining work without throwing', async () => {
    for (let i = 0; i < 10; i++) {
      qb.insertNode(makeNode({ id: `fn:abort${i}`, name: `fn${i}`, startLine: i + 1, endLine: i + 1 }));
    }

    const controller = new AbortController();
    // Abort immediately before the call so the loop exits on the first check
    controller.abort();

    const result = await runStructuralSummariser({
      projectRoot: dir,
      queries: qb,
      options: { signal: controller.signal },
    });

    // Should not have processed (or only processed 0 items)
    expect(result.generated + result.skipped + result.preserved).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11. Result counters are consistent
  // -------------------------------------------------------------------------

  it('candidates = generated + skipped + preserved (stale-race aside)', async () => {
    // Mix: one route (will generate), one function with LLM summary (preserved),
    // one function with many calls edges (no pattern → skipped).
    qb.insertNode(
      makeNode({
        id: 'route:c1',
        name: 'GET /health',
        kind: 'route',
        startLine: 1,
        endLine: 1,
      }),
    );
    qb.insertNode(
      makeNode({
        id: 'fn:llm1',
        name: 'withSummary',
        startLine: 2,
        endLine: 3,
      }),
    );
    upsertSymbolSummary({
      qb,
      nodeId: 'fn:llm1',
      contentHash: 'x',
      summary: 'Does something important',
      model: 'llm:chat',
    });

    const result = await runStructuralSummariser({ projectRoot: dir, queries: qb });
    // All accounted for (allow for stale-race no-ops which fall into
    // the derived gap without touching any explicit counter)
    expect(result.generated + result.skipped + result.preserved).toBeLessThanOrEqual(result.candidates);
  });
});
