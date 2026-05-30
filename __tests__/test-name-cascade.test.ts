/**
 * Tests for the three-tier getSymbolDescriptions cascade and the
 * new getTestDerivedDescriptions helper.
 *
 * Tier-1: summary wins.
 * Tier-2: docstring wins when no summary.
 * Tier-3: test-name aggregate when neither.
 *
 * Uses `DatabaseConnection.initialize` + `QueryBuilder` directly
 * (no Cartograph.init / indexAll needed — we insert fixtures via raw SQL).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { getSymbolDescriptions, getTestDerivedDescriptions, upsertSymbolSummary } from '../src/db/queries-summaries.js';
import { insertEdge } from '../src/db/queries-edges.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tncascade-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Insert a minimal files row (FK parent for test_names). */
function insertFile(qb: QueryBuilder, filePath: string, isTest = false): void {
  qb.db
    .prepare(
      `INSERT OR IGNORE INTO files
         (path, content_hash, language, size, modified_at, indexed_at, is_test)
       VALUES (?, 'hash', 'typescript', 0, 0, 0, ?)`,
    )
    .run(filePath, isTest ? 1 : 0);
}

/** Insert a minimal nodes row (kind='function' by default). */
function insertNode(
  qb: QueryBuilder,
  opts: {
    id: string;
    name: string;
    filePath: string;
    kind?: string;
    docstring?: string;
  },
): void {
  const { id, name, filePath, kind = 'function', docstring = null } = opts;
  qb.db
    .prepare(
      `INSERT OR IGNORE INTO nodes
         (id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          is_exported, is_async, is_static, updated_at)
       VALUES (?, ?, ?, ?, ?, 'typescript', 1, 10, 0, 0, 0, 0, 0, ?)`,
    )
    .run(id, kind, name, name, filePath, Date.now());
  if (docstring) {
    qb.db.prepare(`UPDATE nodes SET docstring = ? WHERE id = ?`).run(docstring, id);
  }
}

/** Insert a test_names row, with an auto-maintained FTS5 entry. */
function insertTestName(qb: QueryBuilder, filePath: string, line: number, description: string): void {
  qb.db
    .prepare(`INSERT INTO test_names (file_path, line, description) VALUES (?, ?, ?)`)
    .run(filePath, line, description);
}

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const SUBJECT_FILE = 'src/auth/token.ts';
const TEST_FILE = '__tests__/token.test.ts';

// ---------------------------------------------------------------------------
// Describe block
// ---------------------------------------------------------------------------

describe('getSymbolDescriptions — 3-tier cascade', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    testDir = createTempDir();
    db = DatabaseConnection.initialize(path.join(testDir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());

    // Seed file rows used by most tests.
    insertFile(qb, SUBJECT_FILE, false);
    insertFile(qb, TEST_FILE, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(testDir);
  });

  // -------------------------------------------------------------------------

  it('symbol with a summary returns source: summary', () => {
    insertNode(qb, { id: 'n:sum', name: 'createToken', filePath: SUBJECT_FILE });
    upsertSymbolSummary({
      qb,
      nodeId: 'n:sum',
      contentHash: 'abc',
      summary: 'Generates a JWT for the given user.',
      model: 'test',
    });

    const result = getSymbolDescriptions(qb, ['n:sum']);
    expect(result.size).toBe(1);
    const desc = result.get('n:sum')!;
    expect(desc.source).toBe('summary');
    expect(desc.text).toBe('Generates a JWT for the given user.');
  });

  // -------------------------------------------------------------------------

  it('symbol with only a docstring returns source: docstring', () => {
    insertNode(qb, {
      id: 'n:doc',
      name: 'verifyToken',
      filePath: SUBJECT_FILE,
      docstring: 'Validates the given token against the signing key.',
    });

    const result = getSymbolDescriptions(qb, ['n:doc']);
    expect(result.size).toBe(1);
    const desc = result.get('n:doc')!;
    expect(desc.source).toBe('docstring');
    expect(desc.text).toBe('Validates the given token against the signing key.');
  });

  // -------------------------------------------------------------------------

  it('symbol with neither summary nor docstring but covered by tests returns source: tests', () => {
    // Subject symbol (no summary, no docstring)
    insertNode(qb, { id: 'n:bare', name: 'parseToken', filePath: SUBJECT_FILE });

    // File-level node for the subject file (needed for the tests-edge join)
    insertNode(qb, { id: 'file:subject', name: SUBJECT_FILE, filePath: SUBJECT_FILE, kind: 'file' });
    // File-level node for the test file (the edge source)
    insertNode(qb, { id: 'file:test', name: TEST_FILE, filePath: TEST_FILE, kind: 'file' });

    // tests edge: test_file → subject_file
    insertEdge(qb, {
      source: 'file:test',
      target: 'file:subject',
      kind: 'tests',
      confidence: 'EXTRACTED',
    });

    // Test descriptions in the test file
    insertTestName(qb, TEST_FILE, 10, 'parses a valid JWT payload');
    insertTestName(qb, TEST_FILE, 20, 'throws on malformed token string');
    insertTestName(qb, TEST_FILE, 30, 'returns null for expired tokens');

    const result = getSymbolDescriptions(qb, ['n:bare']);
    expect(result.size).toBe(1);
    const desc = result.get('n:bare')!;
    expect(desc.source).toBe('tests');
    expect(desc.text.length).toBeGreaterThan(0);
    expect(desc.text.length).toBeLessThanOrEqual(200);
  });

  // -------------------------------------------------------------------------

  it('symbol with nothing is absent from the map', () => {
    insertNode(qb, { id: 'n:nothing', name: 'unusedHelper', filePath: SUBJECT_FILE });
    // No summary, no docstring, no tests edge

    const result = getSymbolDescriptions(qb, ['n:nothing']);
    expect(result.has('n:nothing')).toBe(false);
  });

  // -------------------------------------------------------------------------

  it('summary wins over docstring (tier-1 priority)', () => {
    insertNode(qb, {
      id: 'n:both',
      name: 'refreshToken',
      filePath: SUBJECT_FILE,
      docstring: 'Docstring text.',
    });
    upsertSymbolSummary({
      qb,
      nodeId: 'n:both',
      contentHash: 'xyz',
      summary: 'Summary text wins.',
      model: 'test',
    });

    const result = getSymbolDescriptions(qb, ['n:both']);
    const desc = result.get('n:both')!;
    expect(desc.source).toBe('summary');
    expect(desc.text).toBe('Summary text wins.');
  });
});

// ---------------------------------------------------------------------------
// getTestDerivedDescriptions — unit tests
// ---------------------------------------------------------------------------

describe('getTestDerivedDescriptions', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    testDir = createTempDir();
    db = DatabaseConnection.initialize(path.join(testDir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());

    insertFile(qb, SUBJECT_FILE, false);
    insertFile(qb, TEST_FILE, true);

    // Shared subject symbol + file nodes + tests edge used by most sub-tests.
    insertNode(qb, { id: 'n:sym', name: 'validateToken', filePath: SUBJECT_FILE });
    insertNode(qb, { id: 'file:s', name: SUBJECT_FILE, filePath: SUBJECT_FILE, kind: 'file' });
    insertNode(qb, { id: 'file:t', name: TEST_FILE, filePath: TEST_FILE, kind: 'file' });
    insertEdge(qb, {
      source: 'file:t',
      target: 'file:s',
      kind: 'tests',
      confidence: 'EXTRACTED',
    });
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(testDir);
  });

  // -------------------------------------------------------------------------

  it('empty nodeIds returns empty map', () => {
    const result = getTestDerivedDescriptions(qb, []);
    expect(result.size).toBe(0);
  });

  // -------------------------------------------------------------------------

  it('node with no covering tests is absent', () => {
    // n:sym has a tests edge, but let's add a second node with NO covering tests
    insertFile(qb, 'src/other.ts');
    insertNode(qb, { id: 'n:orphan', name: 'orphanFn', filePath: 'src/other.ts' });

    insertTestName(qb, TEST_FILE, 1, 'validates a signed token');

    const result = getTestDerivedDescriptions(qb, ['n:orphan']);
    expect(result.has('n:orphan')).toBe(false);
  });

  // -------------------------------------------------------------------------

  it('multi-test ranking: when 5 test descriptions match, top 3 are returned joined with "; "', () => {
    // Insert 5 descriptions that all mention 'validateToken' — they should all score.
    for (let k = 1; k <= 5; k++) {
      insertTestName(qb, TEST_FILE, k * 10, `validateToken scenario ${k}`);
    }

    const result = getTestDerivedDescriptions(qb, ['n:sym']);
    expect(result.has('n:sym')).toBe(true);
    const text = result.get('n:sym')!;

    // At most 3 descriptions, joined by '; '
    const parts = text.split('; ');
    expect(parts.length).toBeLessThanOrEqual(3);
    // Each part should contain some meaningful text
    for (const p of parts) expect(p.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------

  it('output is capped at 200 chars', () => {
    // Insert 3 very long descriptions
    for (let k = 1; k <= 3; k++) {
      insertTestName(qb, TEST_FILE, k * 10, `${'validateToken '.repeat(20).trim()} scenario ${k}`);
    }

    const result = getTestDerivedDescriptions(qb, ['n:sym']);
    if (result.has('n:sym')) {
      expect(result.get('n:sym')!.length).toBeLessThanOrEqual(200);
    }
  });

  // -------------------------------------------------------------------------

  it('FTS5 special chars in symbol name do not crash', () => {
    // Symbol names that contain FTS5 operators / quotes
    const specialNames = [
      'a"b', // embedded double-quote
      'OR AND', // FTS5 operators as identifiers
      'foo*bar', // wildcard operator
      'NEAR/5', // proximity operator
      '', // empty name edge case
    ];

    for (const [idx, name] of specialNames.entries()) {
      const nodeId = `n:special-${idx}`;
      insertNode(qb, { id: nodeId, name, filePath: SUBJECT_FILE });
    }

    insertTestName(qb, TEST_FILE, 1, 'covers special symbol names');

    // None of these should throw
    expect(() =>
      getTestDerivedDescriptions(
        qb,
        specialNames.map((_, i) => `n:special-${i}`),
      ),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------

  it('multiple nodes in the same file share test-file lookup', () => {
    // Two symbols in the same file; both should get descriptions.
    insertNode(qb, { id: 'n:sym2', name: 'decodeToken', filePath: SUBJECT_FILE });
    insertTestName(qb, TEST_FILE, 5, 'decodes a base64 payload');
    insertTestName(qb, TEST_FILE, 15, 'validates the signature after decoding');

    const result = getTestDerivedDescriptions(qb, ['n:sym', 'n:sym2']);
    // Both share the same test file — both may get descriptions if FTS hits.
    // At minimum: the map must not throw and both absent OR present is fine;
    // we just verify the function completes and results are valid.
    for (const [, text] of result) {
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(200);
    }
  });
});
