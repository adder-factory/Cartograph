/**
 * Regression test for the expanded axis-foreign-arg rejection in
 * `cartograph_find` (Structural fix B, 2026-05-19).
 *
 * Pre-fix: only `caseSensitive` / `key` / `op` produced a clear error
 * when passed with the wrong `by:` / `mode:`. The rest of the axis-
 * specific args — `symbol`, `sameLanguage`, `differentLanguage`,
 * `languageFilter`, `kind`, `compact`, `fields`, `includeTests`,
 * `language`, `pathFilter` — silently dropped. Friction #20 (audit
 * group B).
 *
 * Each case below confirms the new check returns the relevant
 * error string so the rejection is part of the user-facing contract,
 * not an internal detail.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_find — axis-foreign arg rejection (structural fix B)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-find-rejection-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'sample.ts'),
      `export function findGodClasses(): number { return 1; }\n`,
    );
    cg = await Cartograph.init(tempDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    cg?.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── content axis ──────────────────────────────────────────────────

  it('rejects `kind` on by:content', async () => {
    const r = await handler.execute('cartograph_find', { by: 'content', query: 'foo', kind: 'function' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/`kind` is only valid with `by: 'name'`/);
  });

  it('rejects `language` on a non-content axis', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', query: 'findGod', language: 'typescript' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/`language` is only valid with `by: 'content'`/);
  });

  // ── env / sql ─────────────────────────────────────────────────────

  it('rejects `includeTests` on by:name', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', query: 'findGod', includeTests: false });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/`includeTests` is only valid with `by: 'env'` \/ `by: 'sql'`/);
  });

  it('rejects empty-string `key` on by:env', async () => {
    const r = await handler.execute('cartograph_find', { by: 'env', key: '' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/`key` must be a non-empty string/);
  });

  // ── semantic-only knobs on the wrong mode ─────────────────────────

  it('rejects `symbol` with mode:exact', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', mode: 'exact', query: 'findGod', symbol: 'foo' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/`symbol` requires `mode: 'semantic'`/);
  });

  it('rejects `sameLanguage` with mode:exact', async () => {
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'findGod',
      sameLanguage: true,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/language-filter args.*require `mode: 'semantic'`/);
  });

  // ── exact-only knobs on the wrong mode ────────────────────────────

  it('rejects `compact` with mode:semantic', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', mode: 'semantic', query: 'foo', compact: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/`compact` \/ `fields` require `mode: 'exact'`/);
  });

  it('rejects empty `fields` array', async () => {
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'findGod',
      compact: true,
      fields: [],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/`fields` must contain at least one entry/);
  });

  it('rejects `fields` that omits `name`', async () => {
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'findGod',
      compact: true,
      fields: ['signature', 'path'],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/`fields` must include 'name'/);
  });
});
