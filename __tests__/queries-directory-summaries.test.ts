/**
 * Tests for `getDirToolExportConstantCount` — the structural `*_TOOL`
 * count that drives the directory-summary `mcp_tools` pattern detector
 * (FRICTION-M, 2026-05-15).
 *
 * The function path-filters with `LIKE dir/% ESCAPE '\'` plus a
 * `NOT LIKE dir/%/%` clause for "immediate children only". These tests
 * pin the two failure modes that path-prefix LIKE filters are prone to
 * (memo recurring area #3): a sibling directory that shares the prefix
 * (`src/mcp/tools-foo/`), and a nested sub-directory that should not be
 * counted (`src/mcp/tools/sub/`).
 *
 * Also includes an integration test for the FRICTION-M regression:
 * when a directory already has an LLM-generated summary (gguf model),
 * `summarizeAllDirectories` must overwrite it with `structural-dir:v1`
 * when the structural bypass fires — i.e. the bypass wins regardless of
 * an existing LLM row, and the LLM is never called for that directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import {
  getDirToolExportConstantCount,
  getDirectorySummary,
  upsertDirectorySummary,
} from '../src/db/queries-directory-summaries.js';
import { summarizeAllDirectories, STRUCTURAL_DIR_MODEL } from '../src/llm/dir-summarizer.js';
import type { LlmClient } from '../src/llm/client.js';

function seedFile(db: DatabaseConnection, fpath: string): void {
  db.getDb()
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fpath, 'h', 'typescript', 0, 0, 0);
}

describe('getDirToolExportConstantCount', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  function addConst(id: string, name: string, filePath: string, kind = 'constant'): void {
    seedFile(db, filePath);
    qb.insertNode({
      id,
      kind,
      name,
      qualifiedName: name,
      filePath,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-dir-tool-count-'));
    db = DatabaseConnection.initialize(path.join(testDir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('counts *_TOOL constants in files immediately inside the directory', () => {
    addConst('c:1', 'ADMIN_TOOL', 'src/mcp/tools/admin.ts');
    addConst('c:2', 'FIND_TOOL', 'src/mcp/tools/find.ts');
    addConst('c:3', 'GRAPH_TOOL', 'src/mcp/tools/graph.ts');
    expect(getDirToolExportConstantCount(qb, 'src/mcp/tools')).toBe(3);
  });

  it('excludes *_TOOL constants in NESTED sub-directories', () => {
    addConst('c:1', 'ADMIN_TOOL', 'src/mcp/tools/admin.ts');
    addConst('c:2', 'NESTED_TOOL', 'src/mcp/tools/sub/nested.ts');
    // Only the immediate-child constant is counted.
    expect(getDirToolExportConstantCount(qb, 'src/mcp/tools')).toBe(1);
  });

  it('excludes a SIBLING directory that shares the path prefix', () => {
    addConst('c:1', 'ADMIN_TOOL', 'src/mcp/tools/admin.ts');
    addConst('c:2', 'FOO_TOOL', 'src/mcp/tools-foo/bar.ts');
    // `src/mcp/tools-foo/` must not be swept in by a `LIKE tools%` match.
    expect(getDirToolExportConstantCount(qb, 'src/mcp/tools')).toBe(1);
  });

  it('ignores non-constant kinds and non-*_TOOL names', () => {
    addConst('c:1', 'ADMIN_TOOL', 'src/mcp/tools/admin.ts');
    addConst('c:2', 'handleAdmin', 'src/mcp/tools/admin.ts', 'function');
    addConst('c:3', 'FIND_TOOL', 'src/mcp/tools/find.ts', 'function'); // *_TOOL but wrong kind
    addConst('c:4', 'MAX_LIMIT', 'src/mcp/tools/find.ts'); // constant but not *_TOOL
    expect(getDirToolExportConstantCount(qb, 'src/mcp/tools')).toBe(1);
  });

  it('returns 0 for a directory with no *_TOOL constants', () => {
    addConst('c:1', 'MAX_LIMIT', 'src/util/limits.ts');
    expect(getDirToolExportConstantCount(qb, 'src/util')).toBe(0);
  });

  it('tolerates a trailing slash on the directory argument', () => {
    addConst('c:1', 'ADMIN_TOOL', 'src/mcp/tools/admin.ts');
    addConst('c:2', 'FIND_TOOL', 'src/mcp/tools/find.ts');
    expect(getDirToolExportConstantCount(qb, 'src/mcp/tools/')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Integration: structural bypass overwrites a pre-existing LLM summary
// ---------------------------------------------------------------------------
//
// FRICTION-M regression (2026-05-15): when a directory ALREADY has a row in
// `directory_summaries` written by the LLM (model = gguf path), a subsequent
// `summarizeAllDirectories` call must overwrite it with the structural
// summary (model = `structural-dir:v1`) when the `*_TOOL`-count trigger
// fires — and must NOT call the LLM for that directory.
//
// This is the full-stack scenario that `dir-summarizer-structural.test.ts`
// cannot exercise because it only tests the pure helper functions.

describe('summarizeAllDirectories — structural bypass overwrites pre-existing LLM summary', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;
  let llmCallCount: number;
  let stubClient: LlmClient;

  function seedFileRow(fpath: string): void {
    db.getDb()
      .prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(fpath, 'h', 'typescript', 0, 0, 0);
  }

  function addNode(id: string, name: string, kind: string, filePath: string): void {
    seedFileRow(filePath);
    qb.insertNode({
      id,
      kind,
      name,
      qualifiedName: name,
      filePath,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });
  }

  function addSymbolSummary(nodeId: string, summary: string): void {
    db.getDb()
      .prepare(
        `INSERT OR REPLACE INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(nodeId, 'ch-' + nodeId, summary, 'fake-model', Date.now());
  }

  beforeEach(() => {
    llmCallCount = 0;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-dir-bypass-'));
    db = DatabaseConnection.initialize(path.join(testDir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());

    // Stub LlmClient: records every chat call so the test can assert the
    // structural bypass DID fire (count=0) vs fell through to the LLM (>0).
    stubClient = {
      chat: async () => {
        llmCallCount++;
        return { text: 'LLM summary text.' };
      },
    } as unknown as LlmClient;
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('overwrites an existing gguf-model row with structural-dir:v1 — LLM not called', async () => {
    // Seed: 3 *_TOOL constants (all unsummarised — the FRICTION-M case)
    // + 4 helper functions that DO have summaries (so the dir passes the
    // MIN_SYMBOLS_PER_DIR=3 filter and ends up in a DirGroup).
    addNode('c:admin', 'ADMIN_TOOL', 'constant', 'src/mcp/tools/admin.ts');
    addNode('c:find', 'FIND_TOOL', 'constant', 'src/mcp/tools/find.ts');
    addNode('c:graph', 'GRAPH_TOOL', 'constant', 'src/mcp/tools/graph.ts');

    addNode('f:1', 'handleAdmin', 'function', 'src/mcp/tools/admin.ts');
    addNode('f:2', 'formatRow', 'function', 'src/mcp/tools/_callers.ts');
    addNode('f:3', 'parseArgs', 'function', 'src/mcp/tools/_callers.ts');
    addNode('f:4', 'mintUid', 'function', 'src/mcp/tools/_call-id-cache.ts');

    // Give the functions summaries so getSummarisedSymbolsByDir picks them up.
    addSymbolSummary('f:1', 'Handles admin MCP commands.');
    addSymbolSummary('f:2', 'Formats a result row for display.');
    addSymbolSummary('f:3', 'Parses incoming tool arguments.');
    addSymbolSummary('f:4', 'Mints a stable UID for a call-graph edge.');

    // Pre-seed a stale LLM summary — simulates the regression state where
    // the gguf model ran before the structural bypass was in place.
    const GgufModel = '/path/to/qwen2.5-coder-3b.gguf';
    upsertDirectorySummary({
      qb,
      dirPath: 'src/mcp/tools',
      contentHash: 'stale-hash',
      summary: 'This module manages call graph data and caches UIDs.',
      model: GgufModel,
    });

    // Verify pre-condition: existing row is the gguf model.
    expect(getDirectorySummary(qb, 'src/mcp/tools')?.model).toBe(GgufModel);

    // Run the summarization pass.
    const result = await summarizeAllDirectories({
      queries: qb,
      client: stubClient,
      modelLabel: GgufModel,
    });

    // The structural bypass must have fired for this directory.
    expect(result.generated).toBeGreaterThan(0);

    // The stored model must now be structural-dir:v1.
    const stored = getDirectorySummary(qb, 'src/mcp/tools');
    expect(stored).not.toBeNull();
    expect(stored!.model).toBe(STRUCTURAL_DIR_MODEL);

    // The LLM must NOT have been called for the MCP-tools directory.
    // (It may have been called for OTHER dirs if any exist, but in this
    // fixture only one dir qualifies and it has the structural pattern.)
    expect(llmCallCount).toBe(0);

    // The summary must mention "MCP tool handler" (the deterministic paragraph).
    expect(stored!.summary).toContain('MCP tool handler');
  });

  it('returns cached on a second pass — does not call LLM or rewrite the row', async () => {
    // Seed the same fixture as above.
    addNode('c:admin', 'ADMIN_TOOL', 'constant', 'src/mcp/tools/admin.ts');
    addNode('c:find', 'FIND_TOOL', 'constant', 'src/mcp/tools/find.ts');
    addNode('c:graph', 'GRAPH_TOOL', 'constant', 'src/mcp/tools/graph.ts');
    addNode('f:1', 'handleAdmin', 'function', 'src/mcp/tools/admin.ts');
    addNode('f:2', 'formatRow', 'function', 'src/mcp/tools/_callers.ts');
    addNode('f:3', 'parseArgs', 'function', 'src/mcp/tools/_callers.ts');
    addNode('f:4', 'mintUid', 'function', 'src/mcp/tools/_call-id-cache.ts');
    addSymbolSummary('f:1', 'Handles admin MCP commands.');
    addSymbolSummary('f:2', 'Formats a result row for display.');
    addSymbolSummary('f:3', 'Parses incoming tool arguments.');
    addSymbolSummary('f:4', 'Mints a stable UID for a call-graph edge.');

    const GgufModel = '/path/to/qwen2.5-coder-3b.gguf';

    // First pass: writes structural summary.
    await summarizeAllDirectories({ queries: qb, client: stubClient, modelLabel: GgufModel });
    const afterFirst = getDirectorySummary(qb, 'src/mcp/tools');
    expect(afterFirst?.model).toBe(STRUCTURAL_DIR_MODEL);
    const hashAfterFirst = afterFirst!.contentHash;
    llmCallCount = 0; // reset counter for the second pass

    // Second pass: nothing changed — must be a cache hit.
    const result2 = await summarizeAllDirectories({ queries: qb, client: stubClient, modelLabel: GgufModel });
    expect(result2.cacheHits).toBeGreaterThan(0);
    expect(result2.generated).toBe(0);
    expect(llmCallCount).toBe(0);

    // The hash and model must be unchanged.
    const afterSecond = getDirectorySummary(qb, 'src/mcp/tools');
    expect(afterSecond!.model).toBe(STRUCTURAL_DIR_MODEL);
    expect(afterSecond!.contentHash).toBe(hashAfterFirst);
  });
});
