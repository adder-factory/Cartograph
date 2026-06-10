/**
 * Parse-cache (Section A #8) — content-hash-keyed read-through cache
 * for `extractFromSource`. Pre-fix: every `--force` reindex re-parsed
 * every file even when content was unchanged. Post-fix: a re-extract
 * with same content + path replays the cached ExtractionResult and
 * skips the parse pass.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import {
  getCachedParse,
  getParseCacheStats,
  putCachedParse,
  evictParseCacheIfOversized,
  clearParseCache,
} from '../src/db/queries-parse-cache.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('parse_cache helpers', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parse-cache-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cg-parse-cache', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips an ExtractionResult through put/get', () => {
    const sample = {
      nodes: [
        {
          id: 'function:abc',
          kind: 'function' as const,
          name: 'foo',
          qualifiedName: 'foo',
          filePath: 'src/a.ts',
          language: 'typescript' as const,
          startLine: 1,
          endLine: 3,
          startColumn: 0,
          endColumn: 0,
          updatedAt: 0,
        },
      ],
      edges: [],
      unresolvedReferences: [],
      errors: [],
      durationMs: 10,
    };
    putCachedParse({ qb: cg.queries, contentHash: 'h1', language: 'typescript', filePath: 'src/a.ts', result: sample });
    const back = getCachedParse({ qb: cg.queries, contentHash: 'h1', language: 'typescript', filePath: 'src/a.ts' });
    expect(back).toBeDefined();
    expect(back!.nodes).toHaveLength(1);
    expect(back!.nodes[0]!.name).toBe('foo');
  });

  it('returns null on miss (no row, wrong key, or corrupt payload)', () => {
    expect(
      getCachedParse({ qb: cg.queries, contentHash: 'no-such-hash', language: 'typescript', filePath: 'src/a.ts' }),
    ).toBeNull();
    putCachedParse({
      qb: cg.queries,
      contentHash: 'h2',
      language: 'typescript',
      filePath: 'src/a.ts',
      result: { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 },
    });
    // Wrong language → miss.
    expect(getCachedParse({ qb: cg.queries, contentHash: 'h2', language: 'python', filePath: 'src/a.ts' })).toBeNull();
    // Wrong path → miss.
    expect(
      getCachedParse({ qb: cg.queries, contentHash: 'h2', language: 'typescript', filePath: 'src/b.ts' }),
    ).toBeNull();
  });

  it('treats a corrupt JSON payload as a miss (does not throw)', () => {
    cg.queries.db
      .prepare(
        `INSERT INTO parse_cache (content_hash, language, file_path, payload, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('hbad', 'typescript', 'src/a.ts', '{not-json', Date.now());
    expect(
      getCachedParse({ qb: cg.queries, contentHash: 'hbad', language: 'typescript', filePath: 'src/a.ts' }),
    ).toBeNull();
  });

  // Fill `count` cache rows via the public putCachedParse (so the payload
  // round-trips through the version envelope), back-dating generated_at so
  // eviction has a deterministic chronological order to drop.
  function fillRows(count: number): void {
    const sample = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
    for (let i = 0; i < count; i++) {
      putCachedParse({
        qb: cg.queries,
        contentHash: `hash-${i}`,
        language: 'typescript',
        filePath: `src/${i}.ts`,
        result: sample,
      });
      cg.queries.db
        .prepare('UPDATE parse_cache SET generated_at = ? WHERE content_hash = ?')
        .run(1000 + i, `hash-${i}`);
    }
  }

  it('does NOT evict LIVE rows even above the raw row floor (anti-thrash)', () => {
    // 12 current-version rows with a raw floor of 8 → effective cap is
    // max(8, ceil(12 × 1.5)) = 18, so the live cache survives. The old
    // fixed-cap behaviour evicted 25% of the live cache every pass on a
    // repo with more files than the cap — a re-parse thrash.
    fillRows(12);
    expect(evictParseCacheIfOversized(cg.queries, 8)).toBe(0);
    expect(getParseCacheStats(cg.queries).rows).toBe(12);
  });

  it('evicts oldest 25% when over the BYTE cap', () => {
    fillRows(12);
    // A 1-byte cap forces eviction regardless of row count; drops
    // ceil(12 × 0.25) = 3 oldest rows.
    const dropped = evictParseCacheIfOversized(cg.queries, 8, 1);
    expect(dropped).toBe(3);
    const stats = getParseCacheStats(cg.queries);
    expect(stats.rows).toBe(9);
    expect(stats.currentVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(stats.currentVersionRows).toBe(9);
    expect(stats.staleVersionRows).toBe(0);
    // Oldest three (`hash-0` / `hash-1` / `hash-2`) should be gone.
    expect(
      getCachedParse({ qb: cg.queries, contentHash: 'hash-0', language: 'typescript', filePath: 'src/0.ts' }),
    ).toBeNull();
    expect(
      getCachedParse({ qb: cg.queries, contentHash: 'hash-2', language: 'typescript', filePath: 'src/2.ts' }),
    ).toBeNull();
    expect(
      getCachedParse({ qb: cg.queries, contentHash: 'hash-3', language: 'typescript', filePath: 'src/3.ts' }),
    ).not.toBeNull();
  });

  it('getParseCacheStats counts stale-version rows separately', () => {
    // Mixed-version cache: some entries written under PAYLOAD_VERSION,
    // some under a deliberately-bogus prior `_v`. The stats query is
    // what `cartograph_status` shows the agent — its accuracy is the
    // discoverability story for cache-version drift.
    const sample = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
    // Two current-version rows.
    putCachedParse({
      qb: cg.queries,
      contentHash: 'cur-1',
      language: 'typescript',
      filePath: 'src/cur1.ts',
      result: sample,
    });
    putCachedParse({
      qb: cg.queries,
      contentHash: 'cur-2',
      language: 'typescript',
      filePath: 'src/cur2.ts',
      result: sample,
    });
    // Three stale-version rows.
    for (const id of ['st-1', 'st-2', 'st-3']) {
      cg.queries.db
        .prepare(
          `INSERT INTO parse_cache (content_hash, language, file_path, payload, generated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, 'typescript', `src/${id}.ts`, JSON.stringify({ _v: 999, result: sample }), Date.now());
    }
    const stats = getParseCacheStats(cg.queries);
    expect(stats.rows).toBe(5);
    expect(stats.currentVersionRows).toBe(2);
    expect(stats.staleVersionRows).toBe(3);
  });

  it('treats a payload without the version envelope as a miss', () => {
    // Pre-versioned cache entry (or a write from a future version
    // that downgraded back to this code path). Should be re-parsed.
    const sample = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
    cg.queries.db
      .prepare(
        `INSERT INTO parse_cache (content_hash, language, file_path, payload, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('hold', 'typescript', 'src/old.ts', JSON.stringify(sample), Date.now());
    expect(
      getCachedParse({ qb: cg.queries, contentHash: 'hold', language: 'typescript', filePath: 'src/old.ts' }),
    ).toBeNull();
  });

  it('treats a payload with a stale _v as a miss', () => {
    cg.queries.db
      .prepare(
        `INSERT INTO parse_cache (content_hash, language, file_path, payload, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'hstale',
        'typescript',
        'src/stale.ts',
        JSON.stringify({
          _v: 999,
          result: { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 },
        }),
        Date.now(),
      );
    expect(
      getCachedParse({ qb: cg.queries, contentHash: 'hstale', language: 'typescript', filePath: 'src/stale.ts' }),
    ).toBeNull();
  });

  it('evictParseCacheIfOversized is a no-op under the cap', () => {
    const sample = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
    putCachedParse({ qb: cg.queries, contentHash: 'h', language: 'typescript', filePath: 'src/a.ts', result: sample });
    const dropped = evictParseCacheIfOversized(cg.queries, 100);
    expect(dropped).toBe(0);
    expect(getParseCacheStats(cg.queries).rows).toBe(1);
  });

  it('clearParseCache wipes every entry', () => {
    const sample = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
    putCachedParse({ qb: cg.queries, contentHash: 'h1', language: 'typescript', filePath: 'src/a.ts', result: sample });
    putCachedParse({ qb: cg.queries, contentHash: 'h2', language: 'typescript', filePath: 'src/b.ts', result: sample });
    const dropped = clearParseCache(cg.queries);
    expect(dropped).toBe(2);
    expect(getParseCacheStats(cg.queries).rows).toBe(0);
  });

  it('clearParseCache(qb, language) drops only that language', () => {
    const sample = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
    putCachedParse({ qb: cg.queries, contentHash: 'h1', language: 'typescript', filePath: 'src/a.ts', result: sample });
    putCachedParse({ qb: cg.queries, contentHash: 'h2', language: 'typescript', filePath: 'src/b.ts', result: sample });
    putCachedParse({ qb: cg.queries, contentHash: 'h3', language: 'python', filePath: 'src/x.py', result: sample });
    putCachedParse({ qb: cg.queries, contentHash: 'h4', language: 'go', filePath: 'src/y.go', result: sample });

    const droppedTs = clearParseCache(cg.queries, 'typescript');
    expect(droppedTs).toBe(2);
    expect(getParseCacheStats(cg.queries).rows).toBe(2);

    const droppedNoMatch = clearParseCache(cg.queries, 'rust');
    expect(droppedNoMatch).toBe(0);
    expect(getParseCacheStats(cg.queries).rows).toBe(2);

    const droppedAll = clearParseCache(cg.queries);
    expect(droppedAll).toBe(2);
    expect(getParseCacheStats(cg.queries).rows).toBe(0);
  });
});

describe('parse_cache integration with indexAll', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parse-cache-int-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function alpha(): number { return 1; }\nexport function beta(): number { return 2; }\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'b.ts'),
      `export class Box { constructor(public n: number) {} get(): number { return this.n; } }\n`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cg-parse-cache-int', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('populates the cache on a fresh indexAll', async () => {
    expect(getParseCacheStats(cg.queries).rows).toBe(0);
    await cg.indexAll({ summarize: false });
    const after = getParseCacheStats(cg.queries);
    // One row per indexed source file (a.ts + b.ts + package.json now
    // that JSON has parser-only support).
    expect(after.rows).toBeGreaterThanOrEqual(3);
  });

  it('hits the cache on a re-extract of unchanged files', async () => {
    await cg.indexAll({ summarize: false });
    // Force a re-index — every file's content is unchanged, so every
    // parse should be a cache hit.
    cg.clearStructural();
    await cg.indexAll({ summarize: false });
    // The cache held entries from pass 1; pass 2 hit unchanged TS
    // files plus package.json now that JSON is parser-only supported.
    // Production code derives this signal from `getParseCacheHits()`,
    // which we read below.
    const hits = cg.internals.orchestrator.getParseCacheHits();
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it('misses the cache after a content edit (re-parses + re-caches)', async () => {
    await cg.indexAll({ summarize: false });
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function alpha(): number { return 99; }\nexport function beta(): number { return 2; }\nexport function gamma(): number { return 3; }\n`,
    );
    cg.clearStructural();
    await cg.indexAll({ summarize: false });
    const hits = cg.internals.orchestrator.getParseCacheHits();
    // b.ts and package.json are unchanged → 2 hits. a.ts was edited
    // → miss; re-parsed and a NEW row is cached for the new hash.
    expect(hits).toBe(2);
    // Both versions of a.ts (old hash and new hash) are now cached
    // since clearStructural doesn't wipe parse_cache (intentional —
    // content-addressed entries are still valid).
    expect(getParseCacheStats(cg.queries).rows).toBeGreaterThanOrEqual(4);
  });
});
