/**
 * Search Quality Tests
 *
 * Regression tests for the FTS improvements that bring natural-language
 * and partial-identifier queries into the top of the result set:
 *   - Subword tokens (camel/snake split) so `parser` finds `getParser`.
 *   - Porter stemmer so `parsing` matches `parser`/`parses`.
 *   - Stopword stripping so `"how"` / `"the"` don't crowd out the
 *     real terms via docstring matches.
 *
 * All measurements were captured against cartograph's own src/ during
 * development. Targets that previously ranked #18, #19, or weren't in
 * the top 20 jump to the top 5.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { searchNodes } from '../src/db/queries-search.js';
import type { Node } from '../src/types.js';
import { splitIdentifierTokens, buildNameSubwords } from '../src/utils.js';
import { filterStopwords, STOP_WORDS } from '../src/search/query-utils.js';
import { runMigrations, getCurrentVersion } from '../src/db/migrations.js';
import { createDatabase } from '../src/db/sqlite-adapter.js';

describe('splitIdentifierTokens', () => {
  it('splits camelCase', () => {
    expect(splitIdentifierTokens('getParser')).toEqual(['get', 'parser']);
  });

  it('splits PascalCase', () => {
    expect(splitIdentifierTokens('DatabaseConnection')).toEqual(['database', 'connection']);
  });

  it('splits XMLHttpRequest-style runs of capitals', () => {
    expect(splitIdentifierTokens('XMLHttpRequest')).toEqual(['xml', 'http', 'request']);
  });

  it('splits snake_case', () => {
    expect(splitIdentifierTokens('database_connection')).toEqual(['database', 'connection']);
  });

  it('splits kebab-case and dots and slashes', () => {
    expect(splitIdentifierTokens('foo-bar.baz/qux')).toEqual(['foo', 'bar', 'baz', 'qux']);
  });

  it('splits backslash-separated PHP-style namespace segments', () => {
    expect(splitIdentifierTokens('App\\Service\\UserService')).toEqual(['app', 'service', 'user', 'service']);
  });

  it('keeps single-word identifiers as-is', () => {
    expect(splitIdentifierTokens('parse')).toEqual(['parse']);
  });

  it('handles trailing/leading underscores', () => {
    expect(splitIdentifierTokens('__init__')).toEqual(['init']);
  });

  it('preserves numbers as part of the surrounding token', () => {
    expect(splitIdentifierTokens('parseV2')).toEqual(['parse', 'v2']);
  });
});

describe('buildNameSubwords', () => {
  it('preserves the original identifier so direct queries still hit', () => {
    const out = buildNameSubwords('getParser');
    expect(out.split(' ')).toContain('getParser');
  });

  it('appends split tokens', () => {
    const out = buildNameSubwords('getParser').split(' ');
    expect(out).toContain('get');
    expect(out).toContain('parser');
  });

  it('dedupes single-word identifiers (no "parse parse")', () => {
    expect(buildNameSubwords('parse')).toBe('parse');
  });

  it('dedupes when split produces a single token equal to the original', () => {
    // 'foo' has no boundary, so splitIdentifierTokens returns ['foo'];
    // without dedup we would store 'foo foo'.
    const out = buildNameSubwords('foo').split(' ');
    expect(out).toEqual(['foo']);
  });

  it('handles empty string without crashing', () => {
    expect(buildNameSubwords('')).toBe('');
  });
});

describe('filterStopwords (shared with query-utils.ts)', () => {
  it('drops common English stopwords', () => {
    expect(filterStopwords(['how', 'does', 'parsing', 'work']))
      // 'work' is also in STOP_WORDS, so the result is just 'parsing'
      .toEqual(['parsing']);
  });

  it('returns the original list when every term is a stopword', () => {
    // Otherwise we would produce an empty FTS query.
    const allStopwords = ['the', 'a', 'an'];
    expect(filterStopwords(allStopwords)).toEqual(allStopwords);
  });

  it('does not strip common identifier-like words', () => {
    // `get` / `set` / `find` could be method names; never treated as stopwords.
    expect(filterStopwords(['get', 'set', 'find', 'name'])).toEqual(['get', 'set', 'find', 'name']);
    expect(STOP_WORDS.has('get')).toBe(false);
  });
});

describe('FTS5 search quality (integration)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  function makeNode(id: string, name: string, kind: Node['kind'], docstring?: string): Node {
    return {
      id,
      kind,
      name,
      qualifiedName: name,
      filePath: `src/${name}.ts`,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      docstring,
      updatedAt: Date.now(),
    };
  }

  /**
   * Seed `files` rows for every distinct `filePath` referenced by `nodes`
   * so the migration-056 FK (`nodes.file_path -> files(path)`) is satisfied
   * when we then call `insertNodes`. Idempotent.
   */
  function seedFilesForNodes(qb: QueryBuilder, nodes: Node[]): void {
    const stmt = qb.db.prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const seen = new Set<string>();
    for (const n of nodes) {
      if (seen.has(n.filePath)) continue;
      seen.add(n.filePath);
      stmt.run(n.filePath, 'h', 'typescript', 0, 0, 0);
    }
  }

  /**
   * Seed parent files rows then insert nodes — FK-safe wrapper around
   * `q.insertNodes` for use by the integration tests below.
   */
  function insertNodesFkSafe(nodes: Node[]): void {
    seedFilesForNodes(q, nodes);
    q.insertNodes(nodes);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-search-quality-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds getParser for a `parser` query (subword tokens)', () => {
    insertNodesFkSafe([makeNode('n1', 'getParser', 'function'), makeNode('n2', 'unrelated', 'function')]);
    const results = searchNodes(q, 'parser', { limit: 10 });
    expect(results.find((r) => r.node.name === 'getParser')).toBeDefined();
  });

  it('finds DatabaseConnection for a `connection` query (subword tokens)', () => {
    insertNodesFkSafe([makeNode('n1', 'DatabaseConnection', 'class'), makeNode('n2', 'unrelated', 'function')]);
    const results = searchNodes(q, 'connection', { limit: 10 });
    expect(results.find((r) => r.node.name === 'DatabaseConnection')).toBeDefined();
  });

  it('matches `parsing` against `getParser` via Porter stemmer', () => {
    insertNodesFkSafe([makeNode('n1', 'getParser', 'function'), makeNode('n2', 'unrelated', 'function')]);
    const results = searchNodes(q, 'parsing', { limit: 10 });
    expect(results.find((r) => r.node.name === 'getParser')).toBeDefined();
  });

  it('matches `resolves references` against resolveOne', () => {
    insertNodesFkSafe([makeNode('n1', 'resolveOne', 'method'), makeNode('n2', 'unrelated', 'function')]);
    const results = searchNodes(q, 'resolves references', { limit: 10 });
    expect(results.find((r) => r.node.name === 'resolveOne')).toBeDefined();
  });

  it('strips stopwords so `how does parser work` finds getParser', () => {
    // Without stopword stripping the docstring of `unrelated` (containing
    // "how" and "does") would BM25-flood the result list.
    insertNodesFkSafe([
      makeNode('n1', 'getParser', 'function'),
      makeNode('n2', 'unrelated', 'function', 'How does this work? It does many things — does, does, does.'),
    ]);
    const results = searchNodes(q, 'how does parser work', { limit: 10 });
    const ranks = new Map(results.map((r, i) => [r.node.name, i + 1]));
    const parserRank = ranks.get('getParser');
    const unrelatedRank = ranks.get('unrelated');
    expect(parserRank).toBeDefined();
    if (unrelatedRank !== undefined) {
      expect(parserRank).toBeLessThan(unrelatedRank);
    }
  });

  it('exact identifier search still works (no regression on direct queries)', () => {
    insertNodesFkSafe([
      makeNode('n1', 'ExtractionOrchestrator', 'class'),
      makeNode('n2', 'extraction', 'variable'),
      makeNode('n3', 'orchestrator', 'variable'),
    ]);
    const results = searchNodes(q, 'ExtractionOrchestrator', { limit: 10 });
    expect(results[0].node.name).toBe('ExtractionOrchestrator');
  });
});

// Migration tests build a v3-shape DB by hand to verify the v4-9
// forward migrations land. The hand-built fixture is intentionally
// minimal (just `schema_versions` + the columns the migrations under
// test touch), so we cap `runMigrations` at version 9 — later
// migrations depend on tables this fixture doesn't carry.
describe('Migration v4: backfill name_subwords + rebuild FTS', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-migr-v4-fts-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds FTS so subword search works on previously-indexed nodes', () => {
    // Build a v3-shape database from explicit SQL — the pre-PR schema —
    // then run forward migrations and verify search works end-to-end.
    // This is a faithful simulation of an upgrade from a real v3 install.
    const { db: dbHandle } = createDatabase(path.join(dir, 'test.db'));
    dbHandle.pragma('foreign_keys = ON');
    dbHandle.exec(`
      CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
      INSERT INTO schema_versions (version, applied_at, description) VALUES (3, 0, 'v3');
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL, end_column INTEGER NOT NULL,
        docstring TEXT, signature TEXT, visibility TEXT,
        is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0,
        is_static INTEGER DEFAULT 0, is_abstract INTEGER DEFAULT 0,
        decorators TEXT, type_parameters TEXT, updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        id, name, qualified_name, docstring, signature,
        content='nodes', content_rowid='rowid'
      );
      CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
        VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
      END;
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
        start_line, end_line, start_column, end_column, updated_at)
      VALUES ('n1', 'function', 'getParser', 'getParser', 'a.ts', 'typescript', 1, 1, 0, 0, 0);
    `);

    expect(getCurrentVersion(dbHandle)).toBe(3);

    // Apply forward migrations 4..9 (the band including the FTS-
    // subwords pass). Cap to keep the chain off later migrations whose
    // dependencies the minimal v3 fixture doesn't carry.
    runMigrations(dbHandle, 3, 9);
    expect(getCurrentVersion(dbHandle)).toBe(9);

    // The new column was backfilled with the split subwords.
    const row = dbHandle.prepare('SELECT name_subwords FROM nodes WHERE id = ?').get('n1') as {
      name_subwords: string;
    };
    expect(row.name_subwords).toContain('parser');

    // FTS-side: the post-migration `nodes_fts` virtual table indexes
    // `name_subwords`, so a MATCH against the subword token resolves to
    // the parent row. We query FTS directly here (not via production
    // `searchNodes`) because that pipeline expects current-schema
    // columns added by post-v9 migrations the minimal v3 fixture
    // doesn't carry; the FTS rebuild itself is what this test asserts.
    const ftsHit = dbHandle.prepare("SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'name_subwords:parser'").get() as
      | { id: string }
      | undefined;
    expect(ftsHit?.id).toBe('n1');

    dbHandle.close();
  });

  it('migration is idempotent if name_subwords column already exists', () => {
    // Simulate a partial-failure scenario: the ALTER TABLE landed
    // (DDL is auto-committed in SQLite even inside a transaction) but
    // the rest didn't, so the column is present but the FTS hasn't been
    // recreated and the schema_versions row hasn't been bumped.
    const { db: dbHandle } = createDatabase(path.join(dir, 'test.db'));
    dbHandle.exec(`
      CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
      INSERT INTO schema_versions (version, applied_at, description) VALUES (3, 0, 'v3');
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL, end_column INTEGER NOT NULL,
        docstring TEXT, signature TEXT, visibility TEXT,
        is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0,
        is_static INTEGER DEFAULT 0, is_abstract INTEGER DEFAULT 0,
        decorators TEXT, type_parameters TEXT, updated_at INTEGER NOT NULL,
        name_subwords TEXT  -- partial pre-existing state
      );
    `);
    expect(() => runMigrations(dbHandle, 3, 9)).not.toThrow();
    expect(getCurrentVersion(dbHandle)).toBe(9);
    dbHandle.close();
  });
});
