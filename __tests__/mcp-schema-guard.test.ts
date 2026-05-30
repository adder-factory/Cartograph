/**
 * Schema-compatibility guard (B4). When the on-disk schema is newer
 * than the loaded code knows about (e.g. another process upgraded
 * the DB while this server kept running), every code path that would
 * write through the schema-driven INSERT must fail closed instead of
 * silently dropping rows.
 *
 * Direct unit tests on the guard helper + an integration test on
 * `runStartupSync` (the most insidious silent-drop path) + an
 * integration test that the tool dispatch returns a clean error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { checkSchemaCompat, formatSchemaMismatch } from '../src/mcp/schema-guard.js';
import { runStartupSync } from '../src/mcp/startup-sync.js';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations.js';

function bumpSchemaVersionOnDisk(cg: Cartograph, newVersion: number): void {
  cg.db
    .getDb()
    .prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)')
    .run(newVersion, Date.now(), 'simulated newer-than-loaded-code version (B4 test)');
}

describe('checkSchemaCompat', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-schemaguard-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/x.ts'), 'export function x() {}\n');
    cg = await Cartograph.init(tempDir, { index: true });
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports ok=true on a freshly-initialised DB (versions match)', () => {
    const c = checkSchemaCompat(cg);
    expect(c.ok).toBe(true);
    expect(c.expected).toBe(CURRENT_SCHEMA_VERSION);
    expect(c.actual).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('reports ok=true when on-disk version is OLDER than loaded code', () => {
    // Older = code knows how to handle, runMigrations covers the gap.
    cg.db.getDb().exec('DELETE FROM schema_versions');
    cg.db
      .getDb()
      .prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)')
      .run(1, Date.now(), 'older');
    const c = checkSchemaCompat(cg);
    expect(c.ok).toBe(true);
  });

  it('reports ok=false when on-disk version is NEWER than loaded code', () => {
    bumpSchemaVersionOnDisk(cg, CURRENT_SCHEMA_VERSION + 5);
    const c = checkSchemaCompat(cg);
    expect(c.ok).toBe(false);
    expect(c.actual).toBe(CURRENT_SCHEMA_VERSION + 5);
    expect(c.expected).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('formatSchemaMismatch surfaces both versions and the restart hint', () => {
    const msg = formatSchemaMismatch({ ok: false, expected: 31, actual: 32 });
    expect(msg).toContain('v31');
    expect(msg).toContain('v32');
    expect(msg).toContain('Restart');
    expect(msg).toContain('B4');
  });
});

describe('runStartupSync respects the guard', () => {
  let tempDir: string;
  let cg: Cartograph;
  let logged: string[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-startup-guard-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/x.ts'), 'export function x() {}\n');
    cg = await Cartograph.init(tempDir, { index: true });
    logged = [];
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips sync when the on-disk schema is newer than loaded code', async () => {
    bumpSchemaVersionOnDisk(cg, CURRENT_SCHEMA_VERSION + 1);
    // Add a new file the watcher would otherwise sweep up.
    fs.writeFileSync(path.join(tempDir, 'src/added.ts'), 'export function added() {}\n');
    const before = cg.stats.getStats().fileCount;

    await runStartupSync(cg, { log: (m) => logged.push(m) });

    expect(cg.stats.getStats().fileCount).toBe(before); // no sync ran
    expect(logged.join('')).toMatch(/MCP server is running stale code/);
    expect(logged.join('')).toMatch(/Startup sync skipped/);
  });
});

describe('ToolHandler.execute respects the guard', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-execute-guard-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/x.ts'), 'export function x() {}\n');
    cg = await Cartograph.init(tempDir, { index: true });
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a clear errorResult instead of dispatching when schema is newer', async () => {
    bumpSchemaVersionOnDisk(cg, CURRENT_SCHEMA_VERSION + 1);
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'x' });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('stale code');
    expect(text).toContain('Restart');
    handler.closeAll();
  });

  it('passes through normally when schema versions match', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'x' });
    expect(result.isError).toBeFalsy();
    handler.closeAll();
  });

  it('cartograph_status bypasses the guard so operators can diagnose the mismatch', async () => {
    bumpSchemaVersionOnDisk(cg, CURRENT_SCHEMA_VERSION + 1);
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_status', {});
    expect(result.isError).toBeFalsy();
    // Status renders normally (project root, file count, etc.) — the
    // bypass lets the operator see the version delta the guard would
    // otherwise hide behind the block error.
    expect(result.content[0]?.text ?? '').toContain('Project root');
    handler.closeAll();
  });

  it('cartograph_playbook bypasses too (pure docs, never touches the DB)', async () => {
    bumpSchemaVersionOnDisk(cg, CURRENT_SCHEMA_VERSION + 1);
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_playbook', {});
    expect(result.isError).toBeFalsy();
    handler.closeAll();
  });

  it('admin family does NOT bypass — sync would still write through stale schema-mapper', async () => {
    bumpSchemaVersionOnDisk(cg, CURRENT_SCHEMA_VERSION + 1);
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_admin', { action: 'sync' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? '').toContain('stale code');
    handler.closeAll();
  });
});
