/**
 * Tests for `cartograph_find({by: 'name', mode: 'intent'})` — FTS5 over
 * symbol_summaries.summary (migration 037).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

/**
 * Sanitize user query for FTS5 to prevent reserved-character crashes.
 * This mirrors the sanitization in _search-intent.ts.
 */
function sanitizeQueryForFts5(query: string): [string, boolean] {
  const original = query;
  const sanitized = query
    .replaceAll(/[-^*():"]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return [sanitized, original !== sanitized];
}

describe("cartograph_find({by: 'name', mode: 'intent'})", () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-intent-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'auth.ts'),
      [
        'export function verifyJwt(token: string): boolean { return true; }',
        'export function parseCookieHeader(header: string): Record<string, string> { return {}; }',
        'export function renderUserProfile(userId: string): string { return ""; }',
      ].join('\n'),
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  function seedSummaries(db: ReturnType<typeof cg.db.getDb>): void {
    const nodes = db
      .prepare(`SELECT id, name FROM nodes WHERE name IN ('verifyJwt', 'parseCookieHeader', 'renderUserProfile')`)
      .all() as Array<{ id: string; name: string }>;

    const descriptions: Record<string, string> = {
      verifyJwt: 'Verifies a JWT signature and returns true when the token is valid',
      parseCookieHeader: 'Parses the HTTP Cookie header string into a key-value record',
      renderUserProfile: 'Renders the user profile page for the given userId',
    };

    const insert = db.prepare(`
      INSERT OR REPLACE INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
      VALUES (?, ?, ?, 'test-model', 1000)
    `);
    for (const row of nodes) {
      const summary = descriptions[row.name];
      if (summary) insert.run(row.id, `hash-${row.name}`, summary);
    }
  }

  it('returns the JWT node first for "JWT signature" query', async () => {
    seedSummaries(cg.db.getDb());

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'JWT signature',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/verifyJwt/);
    const jwtPos = text.indexOf('verifyJwt');
    const cookiePos = text.indexOf('parseCookieHeader');
    const profilePos = text.indexOf('renderUserProfile');
    expect(jwtPos).toBeGreaterThanOrEqual(0);
    if (cookiePos >= 0) expect(jwtPos).toBeLessThan(cookiePos);
    if (profilePos >= 0) expect(jwtPos).toBeLessThan(profilePos);
  });

  it('returns refusal error when neither summaries nor docstrings are indexed', async () => {
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'JWT verification',
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/no summaries, docstrings, or test names indexed/);
    expect(text).toMatch(/cartograph quickstart/);
    expect(text).toMatch(/cartograph admin index/);
    expect(text).toMatch(/cartograph admin summarize --all/);
    expect(r.isError).toBe(true);
  });

  it('applies kind filter and excludes non-matching rows', async () => {
    seedSummaries(cg.db.getDb());

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'JWT signature',
      kind: 'function',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/verifyJwt/);
    expect(text).not.toMatch(/\(class\)/);
  });

  it('accepts languageFilter in intent mode', async () => {
    seedSummaries(cg.db.getDb());

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'JWT signature',
      languageFilter: 'typescript',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';
    expect(r.isError).toBeFalsy();
    expect(text).toMatch(/verifyJwt/);
  });

  it('returns no-match message for a query with no hits', async () => {
    seedSummaries(cg.db.getDb());

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'xqzpfg12345nowaythishits',
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/no summaries, docstrings, or test names matched/);
  });

  it('test-description hint points at cartograph_graph, not the removed cartograph_callees', async () => {
    // `src/auth.ts` is the indexed file; its `files` row satisfies the
    // test_names FK. The AFTER-INSERT trigger mirrors the row into FTS.
    const db = cg.db.getDb();
    const filePath = db.prepare(`SELECT path FROM files WHERE path LIKE '%auth.ts' LIMIT 1`).get() as { path: string };
    db.prepare(`INSERT INTO test_names (file_path, line, description) VALUES (?, ?, ?)`).run(
      filePath.path,
      12,
      'verifies a JWT signature against the secret',
    );

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'JWT signature',
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/Test-description matches/);
    // The authored hint must name the current tool, not the one removed
    // on 2026-05-11 (cartograph_callees → merged into cartograph_graph).
    expect(text).toContain("cartograph_graph({direction: 'callees'})");
    expect(text).not.toMatch(/cartograph_callees/);
  });

  it('matches via docstring (no summaries needed)', async () => {
    const db = cg.db.getDb();
    db.prepare(`UPDATE nodes SET docstring = ? WHERE name = 'verifyJwt'`).run(
      'Authenticates a JSON Web Token by verifying its cryptographic signature.',
    );

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'cryptographic signature',
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/verifyJwt/);
    expect(text).toMatch(/via docstring/);
    expect(text).toMatch(/docstrings/);
  });

  it('returns error when query arg is missing', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', mode: 'intent' });
    expect(r.isError).toBe(true);
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/query.*required/i);
  });

  it('returns low-coverage hint when empty result + coverage < 50%', async () => {
    const db = cg.db.getDb();
    // Seed a docstring on one node to trigger the search (not the early
    // "nothing indexed" error), but have very low summary coverage (0%)
    db.prepare(`UPDATE nodes SET docstring = ? WHERE name = 'verifyJwt'`).run('A function that does JWT verification.');

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'xqzpfg12345nowaythishits',
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/no summaries, docstrings, or test names matched/);
    expect(text).toMatch(/intent-search ranks LLM summaries first/);
    expect(text).toMatch(/current coverage: 0%/);
    // Lever C — the hint points at the uncapped full pass.
    expect(text).toMatch(/cartograph admin summarize --all/);
  });

  it('returns concept-hint when empty result + coverage >= 50%', async () => {
    const db = cg.db.getDb();

    // Seed summaries on all 3 functions to get high coverage
    const nodes = db
      .prepare(`SELECT id, name FROM nodes WHERE name IN ('verifyJwt', 'parseCookieHeader', 'renderUserProfile')`)
      .all() as Array<{ id: string; name: string }>;

    const descriptions: Record<string, string> = {
      verifyJwt: 'Verifies a JWT signature and returns true when the token is valid',
      parseCookieHeader: 'Parses the HTTP Cookie header string into a key-value record',
      renderUserProfile: 'Renders the user profile page for the given userId',
    };

    const insert = db.prepare(`
      INSERT OR REPLACE INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
      VALUES (?, ?, ?, 'test-model', 1000)
    `);
    for (const row of nodes) {
      const summary = descriptions[row.name];
      if (summary) insert.run(row.id, `hash-${row.name}`, summary);
    }

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'xqzpfg12345nowaythishits',
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/no summaries, docstrings, or test names matched/);
    expect(text).toMatch(/0 hits at \d+% coverage/);
    expect(text).toMatch(/concept may not be summarised/);
    expect(text).toMatch(/cartograph_explore/);
  });

  it('sanitizes hyphenated query like "issue-tagged" → "issue tagged"', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('issue-tagged');
    expect(sanitized).toBe('issue tagged');
    expect(wasModified).toBe(true);
  });

  it('sanitizes parentheses in queries', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('foo (bar)');
    expect(sanitized).toBe('foo bar');
    expect(wasModified).toBe(true);
  });

  it('sanitizes colon-based field filters', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('name:value');
    expect(sanitized).toBe('name value');
    expect(wasModified).toBe(true);
  });

  it('sanitizes asterisk wildcards', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('x*y');
    expect(sanitized).toBe('x y');
    expect(wasModified).toBe(true);
  });

  it('sanitizes quoted phrases', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('quoted "phrase"');
    expect(sanitized).toBe('quoted phrase');
    expect(wasModified).toBe(true);
  });

  it('collapses leading and trailing whitespace', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('  foo bar  ');
    expect(sanitized).toBe('foo bar');
    expect(wasModified).toBe(true);
  });

  it('collapses multiple internal spaces', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('foo    bar');
    expect(sanitized).toBe('foo bar');
    expect(wasModified).toBe(true);
  });

  it('sanitizes caret operator', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('test^weight');
    expect(sanitized).toBe('test weight');
    expect(wasModified).toBe(true);
  });

  it('handles complex query with mixed operators', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('(issue-tagged OR "status:open")');
    expect(sanitized).toBe('issue tagged OR status open');
    expect(wasModified).toBe(true);
  });

  it('returns unmodified clean query', () => {
    const [sanitized, wasModified] = sanitizeQueryForFts5('clean query');
    expect(sanitized).toBe('clean query');
    expect(wasModified).toBe(false);
  });

  it('includes sanitization notice in results when query was modified', async () => {
    seedSummaries(cg.db.getDb());

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'JWT-signature',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/Note: FTS5-reserved characters.*were stripped from your query/);
    expect(text).toMatch(/Original: "JWT-signature"/);
    expect(text).toMatch(/Sanitized: "JWT signature"/);
  });

  it('does not include sanitization notice when query is clean', async () => {
    seedSummaries(cg.db.getDb());

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'JWT signature',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';
    expect(text).not.toMatch(/FTS5-reserved characters/);
  });

  // ── OR-match regression tests ──────────────────────────────────────────
  // The old implicit-AND FTS5 match failed for natural-language phrases
  // whose extra words (e.g. "before", "scanning") were absent from terse
  // summaries. The fix builds an OR expression so bm25 ranks partial
  // matches rather than requiring every term to be present.

  it('OR-match: superset phrase finds symbol when only some words appear in summary', async () => {
    const db = cg.db.getDb();
    // Seed a summary that intentionally lacks "before" and "scanning"
    const nodes = db.prepare(`SELECT id FROM nodes WHERE name = 'verifyJwt'`).all() as Array<{ id: string }>;
    expect(nodes.length).toBeGreaterThan(0);
    const insert = db.prepare(`
      INSERT OR REPLACE INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
      VALUES (?, ?, ?, 'test-model', 1000)
    `);
    insert.run(nodes[0].id, 'hash-strip-test', 'Strips JavaScript comments from the input string');

    // Query contains words absent from the summary ("before", "scanning")
    // With AND semantics this returns 0 hits; with OR it finds the symbol.
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'strip comments from javascript before scanning',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/verifyJwt/);
  });

  // ── AND-boost ranking tests ────────────────────────────────────────────
  // When ≥2 query tokens are present, the AND query identifies high-precision
  // hits (every token present). Those hits receive an INTENT_AND_BOOST rank
  // multiplier so they sort above partial-match hits regardless of BM25's
  // length-normalisation penalty on longer docstrings.

  it('AND-boost: full-token docstring ranks above partial-token docstring', async () => {
    const db = cg.db.getDb();

    // verifyJwt has a long docstring containing ALL query tokens:
    // "release", "safetensors", "evaluation", "reduce", "peak", "memory".
    db.prepare(`UPDATE nodes SET docstring = ? WHERE name = 'verifyJwt'`).run(
      'loadModel builds and evaluates a model using the common load pattern. ' +
        'Release safetensors BEFORE eval - lazy arrays have captured their data, ' +
        'and this reduces peak memory by ~6GB (matches mlx-lm behavior).',
    );

    // parseCookieHeader has a short docstring matching only 2 of 6 tokens
    // ("release", "safetensors") — a partial match that BM25 would ordinarily
    // rank higher due to its shorter document length.
    db.prepare(`UPDATE nodes SET docstring = ? WHERE name = 'parseCookieHeader'`).run(
      'Free releases the safetensors file.',
    );

    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'release safetensors before evaluation reduce peak memory',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';

    // Both symbols must appear in the result.
    expect(text).toMatch(/verifyJwt/);
    expect(text).toMatch(/parseCookieHeader/);

    // The full-token match (verifyJwt) must rank before the partial match.
    const fullMatchPos = text.indexOf('verifyJwt');
    const partialMatchPos = text.indexOf('parseCookieHeader');
    expect(fullMatchPos).toBeGreaterThanOrEqual(0);
    expect(partialMatchPos).toBeGreaterThanOrEqual(0);
    expect(fullMatchPos).toBeLessThan(partialMatchPos);
  });

  it('AND-boost: single-token query skips AND pass (no dual-query overhead)', async () => {
    const db = cg.db.getDb();
    db.prepare(`UPDATE nodes SET docstring = ? WHERE name = 'verifyJwt'`).run(
      'Verifies a JWT token for authentication.',
    );

    // Single-word query — AND and OR are identical; must still return results.
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'authentication',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/verifyJwt/);
  });

  it('AND-boost: zero AND hits falls back to pure OR ranking (no crash)', async () => {
    const db = cg.db.getDb();
    // Seed a docstring that contains some tokens from the query but not all.
    db.prepare(`UPDATE nodes SET docstring = ? WHERE name = 'verifyJwt'`).run('Validates a token signature.');

    // Multi-word query where no docstring has ALL tokens present (AND = 0 hits).
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'validates token signature encryption algorithm',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';
    // OR hits still surface; no crash from empty AND set.
    expect(text).toMatch(/verifyJwt/);
  });

  it('OR-match: completely unrelated query does not return results (OR is not noise)', async () => {
    const db = cg.db.getDb();
    // Seed all three summaries to get good coverage and exercise bm25 ranking + limit
    seedSummaries(db);

    // A query made of tokens that appear in none of the summaries should still return 0 hits
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'xqzpfg12345nowaythishits redundantgarbage',
      limit: 10,
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/no summaries, docstrings, or test names matched/);
  });
});
