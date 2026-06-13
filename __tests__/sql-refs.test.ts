/**
 * SQL call-site tests: parser unit tests + end-to-end through Cartograph.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSqlRefsByTable, getSqlTables, getSqlTablesForNode } from '../src/db/queries-refs.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractSqlRefs, SQL_REFS_ALGO_VERSION, LAST_MINED_SQL_REFS_ALGO_VERSION_KEY } from '../src/sql-refs/index.js';
import { getMetadata, setMetadata } from '../src/db/queries-metadata.js';
import Cartograph from '../src/index.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

let testDir: string;
let cg: Cartograph | null = null;

function write(rel: string, content: string) {
  const abs = path.join(testDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sql-'));
});

afterEach(() => {
  if (cg) {
    cg.close();
    cg = null;
  }
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Pure parser tests
// ============================================================================

describe('extractSqlRefs', () => {
  it('captures FROM <table> as a read', () => {
    write('a.ts', `db.prepare('SELECT id FROM users WHERE id = ?');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toHaveLength(1);
    expect(refs[0]!).toMatchObject({ tableName: 'users', op: 'read' });
  });

  it('captures INSERT INTO as a write', () => {
    write('a.ts', `db.prepare('INSERT INTO logs (msg) VALUES (?)');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toHaveLength(1);
    expect(refs[0]!).toMatchObject({ tableName: 'logs', op: 'write' });
  });

  it('captures UPDATE ... SET as a write', () => {
    write('a.ts', `db.run('UPDATE users SET name = ? WHERE id = ?', ['x', 1]);\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toHaveLength(1);
    expect(refs[0]!).toMatchObject({ tableName: 'users', op: 'write' });
  });

  it('captures DELETE FROM as a write (and not as a read)', () => {
    write('a.ts', `db.run('DELETE FROM sessions WHERE expired_at < ?');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    // Both regexes (DELETE FROM as write, FROM as read) hit, so we expect
    // two refs for the same table but different ops.
    expect(refs.map((r) => r.op).sort(byString)).toEqual(['read', 'write']);
    expect(new Set(refs.map((r) => r.tableName))).toEqual(new Set(['sessions']));
  });

  it('captures CREATE TABLE / ALTER / DROP as ddl', () => {
    write(
      'a.ts',
      [
        `db.exec('CREATE TABLE IF NOT EXISTS audit (id INTEGER)');`,
        `db.exec('ALTER TABLE audit ADD COLUMN ts INTEGER');`,
        `db.exec('DROP TABLE IF EXISTS audit_old');`,
      ].join('\n'),
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    const ddls = refs.filter((r) => r.op === 'ddl');
    expect(new Set(ddls.map((r) => r.tableName))).toEqual(new Set(['audit', 'audit_old']));
  });

  it('captures JOIN as a read', () => {
    write('a.ts', `db.prepare('SELECT u.name, p.title FROM users u JOIN posts p ON p.user_id = u.id');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    const tables = new Set(refs.map((r) => r.tableName));
    expect(tables).toEqual(new Set(['users', 'posts']));
  });

  it('handles backtick (MySQL) and double-quoted (Postgres) identifiers', () => {
    write(
      'a.ts',
      ["db.prepare('SELECT id FROM `mysql_table`');", `db.prepare('SELECT id FROM "pg_table"');`].join('\n'),
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(new Set(refs.map((r) => r.tableName))).toEqual(new Set(['mysql_table', 'pg_table']));
  });

  it('handles schema-qualified identifiers (drops the schema, keeps the table)', () => {
    write('a.ts', `db.prepare('SELECT * FROM public.users');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs[0]!.tableName).toBe('users');
  });

  it('does NOT match a JS variable named like a SQL keyword', () => {
    // Without the FROM/INTO/etc. prefix, a bare identifier `users` is
    // not caught — that's the whole point vs. plain grep.
    write('a.ts', `const users = await loadUsers();\nfor (const user of users) {}\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toEqual([]);
  });

  it('skips unsupported languages (e.g. swift) without error', () => {
    write('a.swift', `let q = "SELECT id FROM users"\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.swift', language: 'swift' }], () => null);
    expect(refs).toEqual([]);
  });

  it('captures the correct 1-indexed line number', () => {
    write('a.ts', [`// blah`, `// blah`, `db.prepare('SELECT * FROM line_three');`, `// blah`].join('\n'));
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs[0]).toEqual(expect.objectContaining({ tableName: 'line_three', line: 3 }));
  });

  it('threads the resolveEnclosing closure correctly', () => {
    write('a.ts', `db.prepare('SELECT * FROM t');\n`);
    const calls: Array<[string, number]> = [];
    extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], (filePath, line) => {
      calls.push([filePath, line]);
      return 'fake-id';
    });
    expect(calls).toEqual([['a.ts', 1]]);
  });

  it('drops reserved-word "table names" (WHERE/ON/AS/SELECT)', () => {
    // Common over-match: `JOIN ... ON x = y` would otherwise pick up
    // `ON` as the table name. The reserved set blocks that.
    write('a.ts', `db.prepare('SELECT * FROM users JOIN posts ON posts.uid = users.id');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    const names = new Set(refs.map((r) => r.tableName));
    expect(names).toEqual(new Set(['users', 'posts']));
  });

  it('handles multiple SQL operations on a single line', () => {
    write('a.ts', `db.exec('CREATE TABLE foo (id INTEGER); INSERT INTO foo VALUES (1)');\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    const ops = new Set(refs.map((r) => `${r.tableName}|${r.op}`));
    expect(ops).toEqual(new Set(['foo|ddl', 'foo|write']));
  });

  it('survives a missing file (skips, no throw)', () => {
    const refs = extractSqlRefs(testDir, [{ path: 'missing.ts', language: 'typescript' }], () => null);
    expect(refs).toEqual([]);
  });

  it('rejects prose comments containing a quoted SQL example', () => {
    // Reviewer-flagged regression: a comment like
    //   // example: db.prepare('SELECT name FROM the docs')
    // used to falsely match `the` as a table because the quote inside
    // the comment passed isInsideString(). The comment-stripper now
    // removes everything after `//` before the regex sees the line.
    write(
      'a.ts',
      [
        `// example: db.prepare('SELECT name FROM the docs')`,
        `// "SELECT id FROM the comment"`,
        `function ok() {`,
        `  // sample SELECT FROM users in a comment — should be ignored`,
        `  return 1;`,
        `}`,
      ].join('\n'),
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toEqual([]);
  });

  it('rejects same-line block comments containing a quoted SQL example', () => {
    write('a.ts', `/* "SELECT * FROM ghost" */ const x = 1;\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toEqual([]);
  });

  it('still keeps a real SQL call when there is a trailing comment', () => {
    write('a.ts', `db.prepare('SELECT * FROM users'); // good doc\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs.length).toBe(1);
    expect(refs[0]!.tableName).toBe('users');
  });

  it('strips Python `#` comments', () => {
    write('a.py', `# example: db.execute('SELECT * FROM the_docs')\nrows = db.execute('SELECT * FROM real_table')\n`);
    const refs = extractSqlRefs(testDir, [{ path: 'a.py', language: 'python' }], () => null);
    expect(refs.map((r) => r.tableName)).toEqual(['real_table']);
  });

  it('rejects phantom tables from English prose in quoted JSX attributes (issue #8)', () => {
    // Real-world TSX from a funnel/analytics UI. Both lines live inside a
    // double-quoted JSX attribute (so isInsideString passes) and contain
    // "drop" (so the old lineLooksLikeSql passed), and the `FROM <ident>`
    // regex captured the next English word ("first" / "booked") as a table.
    write(
      'Report.tsx',
      [
        `<Stage help="How prospects move from first inquiry to move-in. The biggest drop-offs show where the funnel loses people." />`,
        `<Stage help="How scheduled visits flow from booked to completed. The drop between Booked and Arrived is no-shows." />`,
      ].join('\n'),
    );
    const refs = extractSqlRefs(testDir, [{ path: 'Report.tsx', language: 'tsx' }], () => null);
    expect(refs).toEqual([]);
  });

  it('keeps real FROM/JOIN refs with aliases and trailing clauses (issue #8 guard)', () => {
    // The continuation check must not reject legitimate SQL: bare tables,
    // aliased tables, and tables trailed by any SQL clause keyword.
    write(
      'q.ts',
      [
        `db.prepare('SELECT * FROM orders o JOIN customers c ON o.cid = c.id WHERE o.total > 0');`,
        `db.prepare('SELECT * FROM invoices');`,
        `db.prepare('SELECT * FROM line_items GROUP BY sku');`,
        `db.run('DELETE FROM stale_jobs WHERE done = 1');`,
      ].join('\n'),
    );
    const refs = extractSqlRefs(testDir, [{ path: 'q.ts', language: 'typescript' }], () => null);
    const names = new Set(refs.map((r) => r.tableName));
    expect(names).toEqual(new Set(['orders', 'customers', 'invoices', 'line_items', 'stale_jobs']));
  });

  it('rejects template-literal interpolation placeholders as table names', () => {
    // Regression: DB migrations build dynamic SQL with JS template literals, e.g.
    //   db.exec(`INSERT INTO ${tempName} (${colList}) SELECT ${colList} FROM "${table.name}"`);
    // The double-quote IDENT branch was matching `${table.name}` verbatim.
    // Real SQL identifiers (even quoted ones) never contain `${`.
    write(
      'a.ts',
      [
        // Double-quoted interpolation — the original bug pattern from migration-054
        'db.exec(`SELECT * FROM "${tbl}"`);',
        // Double-quoted multi-segment interpolation
        'db.exec(`DROP TABLE "${table.name}"`);',
        // A real table in the same file — must still be recorded
        "db.prepare('SELECT * FROM users WHERE id = ?');",
      ].join('\n'),
    );
    const refs = extractSqlRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    const names = refs.map((r) => r.tableName);
    // Placeholder names must be absent
    expect(names).not.toContain('${tbl}');
    expect(names).not.toContain('${table.name}');
    // The real table must still be present
    expect(names).toContain('users');
  });
});

// ============================================================================
// End-to-end through Cartograph
// ============================================================================

describe('Cartograph SQL refs', () => {
  it('persists call sites and resolves enclosing function', async () => {
    write(
      'src/db.ts',
      [
        `export function getUser(id: number) {`,
        `  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);`,
        `}`,
        ``,
        `export function logEvent(msg: string) {`,
        `  db.prepare('INSERT INTO events (msg) VALUES (?)').run(msg);`,
        `}`,
      ].join('\n'),
    );
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const tables = getSqlTables(cg.queries);
    expect(new Set(tables.map((t) => t.tableName))).toEqual(new Set(['users', 'events']));

    const userSites = getSqlRefsByTable(cg.queries, 'users');
    expect(userSites[0]!.sourceName).toBe('getUser');

    const eventSites = getSqlRefsByTable(cg.queries, 'events');
    expect(eventSites[0]!.sourceName).toBe('logEvent');
    expect(eventSites[0]!.op).toBe('write');
  });

  it('reverse view: getSqlTablesForNode returns tables touched by a function', async () => {
    write(
      'src/a.ts',
      [
        `export function multiTouch() {`,
        `  db.prepare('SELECT * FROM users').all();`,
        `  db.prepare('INSERT INTO orders VALUES (?)').run(1);`,
        `}`,
      ].join('\n'),
    );
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const node = cg.queries.getNodesByFile('src/a.ts').find((n) => n.name === 'multiTouch')!;
    const touched = getSqlTablesForNode(cg.queries, node.id);
    const summary = touched.map((r) => `${r.tableName}|${r.op}`).sort(byString);
    expect(summary).toEqual(['orders|write', 'users|read']);
  });

  it('case-insensitive table lookup', async () => {
    write('src/a.ts', `db.prepare('SELECT * FROM Users');\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(getSqlRefsByTable(cg.queries, 'users').length).toBe(1);
    expect(getSqlRefsByTable(cg.queries, 'USERS').length).toBe(1);
  });

  it('respects enableSqlRefs=false', async () => {
    write('src/a.ts', `db.prepare('SELECT * FROM users');\n`);
    cg = Cartograph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [], enableSqlRefs: false },
    });
    await cg.indexAll();
    expect(getSqlTables(cg.queries)).toEqual([]);
  });

  it('incremental sync replaces refs for changed files only', async () => {
    write('src/a.ts', `db.prepare('SELECT * FROM old_table');\n`);
    write('src/b.ts', `db.prepare('SELECT * FROM stable_table');\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(new Set(getSqlTables(cg.queries).map((t) => t.tableName))).toEqual(new Set(['old_table', 'stable_table']));

    write('src/a.ts', `db.prepare('SELECT * FROM new_table');\n`);
    await cg.sync();

    const tables = new Set(getSqlTables(cg.queries).map((t) => t.tableName));
    expect(tables).toContain('new_table');
    expect(tables).toContain('stable_table');
    expect(tables).not.toContain('old_table');
  });

  it('drops refs when a file is edited to remove its last SQL ref', async () => {
    // Same regression as PR C — applySqlRefs([]) shouldn't leave
    // stale rows. Pre-deleting the changed paths in runSqlRefsPass
    // is the fix.
    write('src/a.ts', `db.prepare('SELECT * FROM going_away');\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(getSqlTables(cg.queries).some((t) => t.tableName === 'going_away')).toBe(true);

    write('src/a.ts', `// no sql here anymore\nexport const x = 1;\n`);
    await cg.sync();

    expect(getSqlTables(cg.queries).some((t) => t.tableName === 'going_away')).toBe(false);
  });

  it('drops refs for files removed between syncs', async () => {
    write('src/a.ts', `db.prepare('SELECT * FROM gone_table');\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(getSqlTables(cg.queries).some((t) => t.tableName === 'gone_table')).toBe(true);

    fs.unlinkSync(path.join(testDir, 'src/a.ts'));
    await cg.sync();
    expect(getSqlTables(cg.queries).some((t) => t.tableName === 'gone_table')).toBe(false);
  });

  // (Removed: a defensive test for the v4-migration-collision bug class.
  // With file-based migrations (NNN-name.ts), two PRs claiming the same
  // version produces a filesystem-level conflict, so the silent skip the
  // defensive guard protected against can no longer happen.)

  it('algo-version self-heal: stale metadata triggers full re-mine on sync', async () => {
    // Seed: two files. After indexAll both should have sql_refs.
    write('src/a.ts', `db.prepare('SELECT * FROM alpha_table');\n`);
    write('src/b.ts', `db.prepare('SELECT * FROM beta_table');\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const tablesAfterIndex = new Set(getSqlTables(cg.queries).map((t) => t.tableName));
    expect(tablesAfterIndex).toContain('alpha_table');
    expect(tablesAfterIndex).toContain('beta_table');

    // Corrupt the stored algo version to simulate a pre-fix install
    // that never stamped the key (or an older algorithm version).
    setMetadata(cg.queries, LAST_MINED_SQL_REFS_ALGO_VERSION_KEY, '0_bogus');

    // Modify only src/a.ts — an incremental sync would normally only
    // re-mine that one file. But because the algo version is stale, the
    // hook must fall back to a FULL re-mine of all files.
    write('src/a.ts', `db.prepare('SELECT * FROM alpha_v2');\n`);
    await cg.sync();

    const tablesAfterSync = new Set(getSqlTables(cg.queries).map((t) => t.tableName));
    // The changed file's old ref is gone, new ref present.
    expect(tablesAfterSync).not.toContain('alpha_table');
    expect(tablesAfterSync).toContain('alpha_v2');
    // The unchanged file's ref must also be present (full re-mine, not incremental).
    expect(tablesAfterSync).toContain('beta_table');

    // The algo version must be stamped correctly after the heal.
    expect(getMetadata(cg.queries, LAST_MINED_SQL_REFS_ALGO_VERSION_KEY)).toBe(SQL_REFS_ALGO_VERSION);
  });

  it('algo-version self-heal fires on a NO-OP sync (zero changed files)', async () => {
    // Regression: the mismatch check used to sit inside the `scope:"files"`
    // branch of `refresh`, which is only reached when changedFilePaths.length > 0
    // || filesRemoved > 0. A no-op sync (nothing changed on disk) skipped
    // `refresh` entirely, so a stale algo version was never healed until the
    // user manually edited a file or ran `cartograph index`.
    //
    // Fix: hoist the mismatch check to the TOP of `afterSync`, before the
    // changed-files guard, and call `refresh({scope:'all'})` immediately.
    write('src/a.ts', `db.prepare('SELECT * FROM noop_alpha');\n`);
    write('src/b.ts', `db.prepare('SELECT * FROM noop_beta');\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const tablesAfterIndex = new Set(getSqlTables(cg.queries).map((t) => t.tableName));
    expect(tablesAfterIndex).toContain('noop_alpha');
    expect(tablesAfterIndex).toContain('noop_beta');

    // Stamp a bogus algo version to simulate a stale install after a mining-logic fix.
    setMetadata(cg.queries, LAST_MINED_SQL_REFS_ALGO_VERSION_KEY, '0_bogus_noop');

    // Sync with NO file-system changes — changedFilePaths will be empty,
    // filesRemoved will be 0. The self-heal must still fire.
    await cg.sync();

    // Both tables must still be present (full re-mine, not skipped).
    const tablesAfterNoop = new Set(getSqlTables(cg.queries).map((t) => t.tableName));
    expect(tablesAfterNoop).toContain('noop_alpha');
    expect(tablesAfterNoop).toContain('noop_beta');

    // The algo version must be re-stamped to the current value.
    expect(getMetadata(cg.queries, LAST_MINED_SQL_REFS_ALGO_VERSION_KEY)).toBe(SQL_REFS_ALGO_VERSION);
  });
});
