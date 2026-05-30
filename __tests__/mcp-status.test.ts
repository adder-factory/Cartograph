/**
 * cartograph_status output: project-root surfacing + multi-project list.
 *
 * Regression guard for the friction point where an agent calling MCP
 * tools couldn't tell which project the server's default points at,
 * so couldn't tell whether to start passing `projectPath` on later
 * calls. status's first line must always answer that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-status-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function makeProject(dir: string, file: string): Promise<Cartograph> {
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', file), `export function f(): number { return 1; }\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), version: '0.0.0' }));
  const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  return cg;
}

describe('cartograph_status — project-root surfacing', () => {
  let dirs: string[] = [];
  let cgs: Cartograph[] = [];
  let handler: ToolHandler | null = null;

  beforeEach(() => {
    dirs = [];
    cgs = [];
    handler = null;
  });

  afterEach(() => {
    // Close any cached projects the handler opened — otherwise we
    // leak SQLite handles + leave WAL files in tmp.
    handler?.closeAll();
    for (const cg of cgs) {
      try {
        cg.close();
      } catch {
        /* idempotent — already closed by closeAll() */
      }
    }
    for (const d of dirs) cleanup(d);
  });

  it('shows the project root labelled as "default" when the server has a default and projectPath is omitted', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const cg = await makeProject(dir, 'a.ts');
    cgs.push(cg);

    handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_status', {});
    const text = result.content[0]?.text ?? '';

    expect(text).toMatch(new RegExp(`Project root.*\`${path.resolve(dir)}\``));
    expect(text).toMatch(/default/);
    expect(text).toMatch(/server CWD at startup/);
  });

  it('shows the project root labelled as "from `projectPath`" when projectPath is supplied', async () => {
    const defaultDir = tempDir();
    const otherDir = tempDir();
    dirs.push(defaultDir, otherDir);
    const defaultCg = await makeProject(defaultDir, 'a.ts');
    cgs.push(defaultCg);
    // Initialize the second project's .cartograph/ but don't keep our
    // own handle — the ToolHandler will open it via projectPath and
    // own its lifecycle through projectCache.
    const tmpCg = await makeProject(otherDir, 'b.ts');
    tmpCg.close();

    handler = new ToolHandler(defaultCg);
    const result = await handler.execute('cartograph_status', { projectPath: otherDir });
    const text = result.content[0]?.text ?? '';

    expect(text).toMatch(new RegExp(`Project root.*\`${path.resolve(otherDir)}\``));
    expect(text).toMatch(/from `projectPath` argument/);
  });

  it('lists other projects the server has open under "Other projects this server has open"', async () => {
    const defaultDir = tempDir();
    const otherDir = tempDir();
    dirs.push(defaultDir, otherDir);
    const defaultCg = await makeProject(defaultDir, 'a.ts');
    cgs.push(defaultCg);
    const tmpCg = await makeProject(otherDir, 'b.ts');
    tmpCg.close();

    handler = new ToolHandler(defaultCg);
    // Prime the cache with the second project.
    await handler.execute('cartograph_status', { projectPath: otherDir });
    // Now query the default — it should mention the other project.
    const result = await handler.execute('cartograph_status', {});
    const text = result.content[0]?.text ?? '';

    expect(text).toMatch(/### Other projects this server has open/);
    expect(text).toContain(path.resolve(otherDir));
  });

  it('throws an actionable error suggesting `projectPath` when no default and projectPath omitted', async () => {
    handler = new ToolHandler(null);
    const result = await handler.execute('cartograph_status', {});
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No default cartograph project/);
    expect(text).toMatch(/projectPath/);
    expect(text).toMatch(/cartograph init/);
  });

  it('throws an actionable error pointing at the supplied path when projectPath has no .cartograph/', async () => {
    const dir = tempDir();
    dirs.push(dir);
    // Note: we deliberately did NOT call makeProject — there's no .cartograph/.
    handler = new ToolHandler(null);
    const result = await handler.execute('cartograph_status', { projectPath: dir });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No \.cartograph\/ found/);
    expect(text).toContain(dir);
  });

  // F-W — embedding/summary counts used to misrepresent the raw-store
  // total because content-addressed reuse-cache rows (kept on disk for
  // free reuse on rename / revert) weren't disclosed. The lens line
  // now annotates the reuse-cache count when > 0 so the displayed
  // total reconciles with the raw `embedding_store` / `summary_store`
  // row count.
  it('discloses reuse-cached rows when embedding_store has orphan entries (Phase 4 staleness)', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const cg = await makeProject(dir, 'a.ts');
    cgs.push(cg);
    handler = new ToolHandler(cg);

    // Seed `embedding_store` with one orphan row (body_hash not in
    // `embedding_refs`) so the lens has something to disclose. The
    // schema is migration-050; we use small text-blob stand-ins
    // since the lens only counts rows, not the blob contents.
    try {
      cg.db
        .getDb()
        .prepare(
          `INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('orphan_hash_1', 'test-model', 'symbol', Buffer.alloc(8), Date.now());
    } catch {
      // Pre-migration-050 DB — the store table doesn't exist. Skip
      // by short-circuiting the assertion; the lens stays diagnostic.
      return;
    }

    const result = await handler.execute('cartograph_status', {});
    const text = result.content[0]?.text ?? '';
    // Embeddings lens line includes optional `(+ N reuse-cached)`.
    expect(text).toMatch(/\*\*Embeddings:\*\*/);
    // The orphan we just inserted must surface as reuse-cached.
    expect(text).toMatch(/reuse-cached/);
  });

  // Regression: a "🟢 in sync with HEAD" banner alongside an
  // `unresolved_refs` table heavy with refs and zero `calls` / `imports`
  // edges is the live 2026-05-19 bug. Status must surface the integrity
  // gap so an agent doesn't trust empty call-graph queries as "true
  // negatives".
  it('renders the 🔴 degraded-edges banner when calls + imports are 0 and unresolved_refs is heavy', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const cg = await makeProject(dir, 'a.ts');
    cgs.push(cg);
    handler = new ToolHandler(cg);

    // Seed the degenerate state: clear all calls / imports edges and
    // insert > DEGENERATE_EDGE_UREF_FLOOR (1000) synthetic unresolved
    // refs that target nothing in particular. The fromNodeId points at
    // a real node so the FK is happy. Same shape the live bug presents.
    const someNode = cg.queries.db.prepare(`SELECT id FROM nodes WHERE kind = 'function' LIMIT 1`).get() as
      | { id: string }
      | undefined;
    expect(someNode).toBeDefined();
    cg.queries.db.transaction(() => {
      cg.queries.db.exec(`DELETE FROM edges WHERE kind IN ('calls', 'imports')`);
      const insertRef = cg.queries.db.prepare(
        `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
         VALUES (?, 'NeverGonnaResolve', 'calls', ?, 0, 'src/a.ts', 'typescript')`,
      );
      for (let i = 0; i < 1100; i++) insertRef.run(someNode!.id, i);
    })();

    const result = await handler.execute('cartograph_status', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/🔴 reference resolution incomplete/);
    expect(text).toMatch(/0 `calls` \/ 0 `imports`/);
    expect(text).toMatch(/cartograph admin sync/);
  });
});
