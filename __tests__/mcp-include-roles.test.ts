/**
 * cartograph_callers / cartograph_callees / cartograph_walk —
 * `includeRoles: true` flag.
 *
 * Inlines `nodes.role` per row so agents don't round-trip to
 * `cartograph_role` for each caller/callee/visited node. Covers:
 *   - The flag returns rows with `role:<value>` text in compact AND
 *     markdown modes when the indexed symbol has a role set.
 *   - The flag is a silent no-op (no `role:` text) when the node's
 *     `nodes.role` is NULL.
 *   - The flag is opt-in: omitted == default == no role column.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

// ---------------------------------------------------------------------------
// Fixture: A calls B (so B has a caller); both indexed, role manually
// stamped on `B` via direct SQL so we don't depend on the classifier
// pass having run in the test environment.
// ---------------------------------------------------------------------------

async function makeFixture(): Promise<{ dir: string; cg: Cartograph; handler: ToolHandler; betaId: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-roles-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src', 'a.ts'),
    [`import { beta } from './b.js';`, `export function alpha(): void { beta(); }`].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), [`export function beta(): void {}`].join('\n'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'role-fixture', version: '0.0.0' }));

  const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });

  // Find beta's node id and stamp a known role on it.
  const betaRow = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = 'beta' LIMIT 1`).get() as
    | { id: string }
    | undefined;
  if (!betaRow) throw new Error('test fixture: beta not indexed');
  cg.queries.db
    .prepare(`UPDATE nodes SET role = 'business_logic', role_model = 'test:v1' WHERE id = ?`)
    .run(betaRow.id);

  const handler = new ToolHandler(cg);
  return { dir, cg, handler, betaId: betaRow.id };
}

// ---------------------------------------------------------------------------

describe('cartograph_callers — includeRoles', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    ({ dir, cg, handler } = await makeFixture());
  });

  afterEach(() => {
    handler.closeAll();
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('includes role per caller row when includeRoles=true (markdown mode)', async () => {
    // alpha calls beta. We stamped beta's role above. Querying callers of
    // beta returns alpha — but alpha hasn't been stamped, so we ask for
    // callees of alpha instead to put beta in the row set.
    const result = await handler.execute('cartograph_graph', {
      direction: 'callees',
      start: 'alpha',
      includeRoles: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('beta');
    expect(text).toMatch(/role:business_logic/);
  });

  it('includes role per row in compact mode', async () => {
    const result = await handler.execute('cartograph_graph', {
      direction: 'callees',
      start: 'alpha',
      includeRoles: true,
      compact: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('beta');
    expect(text).toMatch(/role:business_logic/);
  });

  it('omits role column when includeRoles is absent', async () => {
    const result = await handler.execute('cartograph_graph', { direction: 'callees', start: 'alpha' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('beta');
    expect(text).not.toMatch(/role:/);
  });

  it('omits role column when the node has no role set', async () => {
    // alpha has no role stamp — querying callers of beta returns alpha
    // with no role column even when includeRoles=true.
    const result = await handler.execute('cartograph_graph', {
      direction: 'callers',
      start: 'beta',
      includeRoles: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('alpha');
    expect(text).not.toMatch(/role:/);
  });
});

describe('cartograph_walk — includeRoles', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    ({ dir, cg, handler } = await makeFixture());
  });

  afterEach(() => {
    handler.closeAll();
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inlines role on visited nodes when includeRoles=true', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      hops: 1,
      includeRoles: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('beta');
    expect(text).toMatch(/role:business_logic/);
  });

  it('omits role column without the flag', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      hops: 1,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('beta');
    expect(text).not.toMatch(/role:/);
  });
});

// ---------------------------------------------------------------------------
// cartograph_role — no-arg distribution mode (F2 regression)
// ---------------------------------------------------------------------------

describe('cartograph_role — no-arg distribution mode', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    ({ dir, cg, handler } = await makeFixture());
  });

  afterEach(() => {
    handler.closeAll();
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns ok (not an error) when called with no arguments', async () => {
    const result = await handler.execute('cartograph_role', {});
    // Must not throw and must have content
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('output contains "Role distribution" heading', async () => {
    const result = await handler.execute('cartograph_role', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Role distribution/);
  });

  it('output contains a known role label when roles have been stamped', async () => {
    // The fixture stamps beta with role='business_logic'; the distribution
    // should surface it.
    const result = await handler.execute('cartograph_role', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('business_logic');
  });

  it('output contains a % column', async () => {
    const result = await handler.execute('cartograph_role', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/\d+\.\d+%/);
  });

  it('renders an unclassified row when nodes exist but no roles are present', async () => {
    // Clear all roles from the fixture DB. Nodes still exist, so the
    // project-wide table must account for them in an `unclassified`
    // bucket rather than claiming the classifier "has not run".
    cg.queries.db.prepare('UPDATE nodes SET role = NULL, role_model = NULL').run();
    const result = await handler.execute('cartograph_role', {});
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/Role distribution/);
    expect(text).toContain('unclassified');
    // 100% of the project is unclassified — the table still totals 100%.
    expect(text).toMatch(/100%/);
  });

  it('returns a "not classified" message only when the project has no nodes', async () => {
    // Truly empty project (no nodes at all) → the empty-state message.
    cg.queries.db.prepare('DELETE FROM nodes').run();
    const result = await handler.execute('cartograph_role', {});
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/No roles classified|not classified yet|classifier has not run/i);
  });

  it('rejects an explicit `via` on the list-by-role path instead of silently ignoring it', async () => {
    // `via` only steers on-demand classification on the get-role-of
    // path — listing just reads cached rows. An explicit non-auto
    // `via` here is a no-op; it must error loudly (Task #40).
    const result = await handler.execute('cartograph_role', {
      role: 'business_logic',
      via: 'llm',
    });
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBe(true);
    expect(text).toMatch(/via.*not supported.*list-by-role/i);
  });

  it('still lists by role when `via` is omitted', async () => {
    const result = await handler.execute('cartograph_role', { role: 'business_logic' });
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toContain('beta');
  });
});
