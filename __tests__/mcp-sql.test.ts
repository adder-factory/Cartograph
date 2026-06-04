/**
 * `cartograph_sql` — read-only ad-hoc SQL escape hatch. Verifies the
 * read-only enforcement (writes reject), schema mode (returns table
 * defs), happy-path SELECT (renders markdown table with row cap),
 * and PRAGMA introspection allowance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_sql', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sql-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function alpha(){return 1;}\nexport function beta(){return 2;}\n`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a SELECT and renders rows as markdown', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: "SELECT name FROM nodes WHERE kind = 'function' ORDER BY name",
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Query results/);
    expect(text).toMatch(/alpha/);
    expect(text).toMatch(/beta/);
    expect(text).toMatch(/\| name \|/); // markdown table header
  });

  it('escapes markdown table delimiters and normalizes newlines in cell values', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: "SELECT 'a|b' AS value, 'line1' || char(10) || 'line2' AS multi",
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('| a\\|b | line1\\nline2 |');
    expect(text).not.toContain('| a|b | line1\nline2 |');
  });

  it('honours `schema: true` mode (returns CREATE TABLE statements)', async () => {
    const result = await handler.execute('cartograph_sql', { schema: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Schema/);
    expect(text).toMatch(/CREATE TABLE.*nodes/);
    expect(text).toMatch(/CREATE TABLE.*edges/);
  });

  it('honours `schema: true` with `tables: [...]` filter (one-table dump)', async () => {
    // Filtering to `nodes` alone should produce the nodes CREATE block
    // and skip every other table — the whole point of the param is to
    // pay one-table token cost instead of 60-table.
    const result = await handler.execute('cartograph_sql', {
      schema: true,
      tables: ['nodes'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Schema/);
    expect(text).toMatch(/`nodes` \(table\)/);
    expect(text).toMatch(/CREATE TABLE.*nodes/);
    // Negative: unrelated tables should NOT appear in the filtered dump.
    expect(text).not.toMatch(/`edges` \(table\)/);
    expect(text).not.toMatch(/`files` \(table\)/);
    expect(text).toMatch(/filtered/);
  });

  it('honours `compact: true` (one-line column list, no CREATE prose)', async () => {
    const result = await handler.execute('cartograph_sql', {
      schema: true,
      tables: ['nodes'],
      compact: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/`nodes` \(table\)/);
    // Compact mode renders a column-separator line, NOT a CREATE block.
    expect(text).toMatch(/·/);
    expect(text).not.toMatch(/```sql/);
    // A known column on `nodes` should appear in the one-liner.
    expect(text).toMatch(/file_path/);
  });

  it('renders a friendly empty result for an unknown table filter', async () => {
    const result = await handler.execute('cartograph_sql', {
      schema: true,
      tables: ['does_not_exist'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/no matching tables/i);
    expect(text).toMatch(/does_not_exist/);
  });

  it('rejects INSERT', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: "INSERT INTO nodes (id, name, kind) VALUES ('x', 'y', 'z')",
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/read-only|only SELECT/i);
  });

  it('rejects UPDATE', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: "UPDATE nodes SET name = 'evil' WHERE id = 'x'",
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/read-only/i);
  });

  it('rejects DELETE', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: 'DELETE FROM nodes',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/read-only/i);
  });

  it('read-only rejection message names both the MCP and CLI schema options (surface-neutral)', async () => {
    // The message is emitted verbatim on both the MCP tool and the CLI
    // mirror, so it must not hardcode the MCP-only `schema: true` param —
    // it should also point CLI callers at `--schema`.
    const result = await handler.execute('cartograph_sql', { query: 'DELETE FROM nodes' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('schema: true');
    expect(text).toContain('--schema');
  });

  it('rejects DROP TABLE', async () => {
    const result = await handler.execute('cartograph_sql', { query: 'DROP TABLE nodes' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/read-only/i);
  });

  it('rejects WITH...DELETE (CTE smuggling a write)', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: 'WITH t AS (SELECT id FROM nodes) DELETE FROM nodes WHERE id IN (SELECT id FROM t)',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/read-only/i);
  });

  it('allows WITH...SELECT (legitimate CTE)', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: "WITH funcs AS (SELECT name FROM nodes WHERE kind = 'function') SELECT * FROM funcs ORDER BY name",
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Query results/);
    expect(text).toMatch(/alpha/);
  });

  it('allows EXPLAIN', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: 'EXPLAIN SELECT * FROM nodes',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Query results/);
  });

  it('allows introspection PRAGMAs', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: 'PRAGMA table_info(nodes)',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Query results/);
  });

  it('truncates results at the limit and reports it', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: 'SELECT name FROM nodes',
      limit: 2,
    });
    const text = result.content[0]?.text ?? '';
    // Iterator-based scan: we know N+ rows exist (the +1 sentinel hit
    // the limit cap) but don't know the exact total without scanning
    // the full result. Header reports "2+ rows" rather than "2 of N".
    expect(text).toMatch(/2\+ rows/);
    expect(text).toMatch(/Truncated at `limit=2`/);
  });

  it('returns a SQL error message when the query is malformed', async () => {
    const result = await handler.execute('cartograph_sql', {
      query: 'SELECT * FROM nonexistent_table',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/SQL failed/);
  });

  // F-O — `no such column` and `ambiguous column name` get decorated
  // with edit-distance suggestions + a `schema: true` tip so the agent
  // doesn't have to fire a second round-trip just to discover the
  // correct column name.
  it('decorates `no such column` errors with nearest-by-edit-distance suggestions', async () => {
    // `n.path` is a near-miss for `n.file_path` (one of the actual
    // columns on the `nodes` table). The hint should suggest it.
    const result = await handler.execute('cartograph_sql', {
      query: 'SELECT n.path FROM nodes n LIMIT 1',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/no such column/i);
    expect(text).toMatch(/Did you mean/i);
    // file_path is the closest candidate; should appear in suggestions.
    expect(text).toMatch(/file_path/);
    expect(text).toMatch(/schema: true/);
  });

  it('a `path` / `file_path` miss carries the files-vs-others naming-split note', async () => {
    // The dominant `no such column` trap: `files.path` (PK) vs
    // `<other>.file_path`. The error must spell the split out, not
    // just hand back an edit-distance guess.
    const result = await handler.execute('cartograph_sql', {
      query: 'SELECT n.path FROM nodes n LIMIT 1',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/no such column/i);
    expect(text).toMatch(/files.*path.*primary key/i);
    expect(text).toMatch(/file_path/);
  });

  it('schema: true with the files table surfaces the path naming-split note', async () => {
    const result = await handler.execute('cartograph_sql', {
      schema: true,
      tables: ['files'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Schema/);
    expect(text).toMatch(/files.*path.*primary key/i);
    expect(text).toMatch(/file_path/);
  });

  it('decorates `ambiguous column name` errors with a qualify-with-alias hint', async () => {
    // Ambiguity arises when two tables in the FROM clause both expose
    // the same column. `id` exists on both `nodes` and `edges`.
    const result = await handler.execute('cartograph_sql', {
      query: 'SELECT id FROM nodes, edges LIMIT 1',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/ambiguous|no such column/i);
    // The decorate path renders an aliasing tip for the ambiguous
    // case; the no-such-column path still renders the schema-tip
    // suffix. Either way the agent gets a follow-up action.
    expect(text).toMatch(/schema: true|qualify with an alias/i);
  });
});
