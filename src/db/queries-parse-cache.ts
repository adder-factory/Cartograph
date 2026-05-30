/**
 * Parse-cache helpers — content-hash-keyed read-through cache for
 * `extractFromSource`. The dominant non-LLM cost on `--force` reindex
 * is tree-sitter parsing; this cache lets a re-extract of unchanged
 * content skip the parse and replay the stored ExtractionResult.
 *
 * Key shape: `(content_hash, language, file_path)`. file_path is in
 * the key because Node.id depends on it — see migration 026 for the
 * reasoning. v1 only hits on same-content-same-path; renames fall
 * through to a fresh parse.
 *
 * Storage: payload is JSON-serialised `{ _v: PAYLOAD_VERSION, result }`.
 * The version field guards against ExtractionResult schema drift —
 * a future change to Node / Edge / UnresolvedReference shape that
 * adds a required field would otherwise replay cached entries with
 * the missing field. Bump PAYLOAD_VERSION when the result schema
 * changes; older entries become misses and re-parse cleanly.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import type { ExtractionResult } from '../types.js';
import { logDebug } from '../errors.js';
import { computeAlgoHash } from '../algo-hash.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

/**
 * Payload version derived from a sha256 of `src/types.ts` — the file
 * that owns the `ExtractionResult` / `Node` / `Edge` /
 * `UnresolvedReference` shapes that get JSON-serialised into the
 * cache. Edit types.ts substantively → hash changes → cached entries
 * with the old `_v` are treated as misses and re-parsed; new puts
 * write the new shape.
 *
 * Pre-2026-05-11 this was a hand-bumped integer (1 → 2) guarded by a
 * drift-detector test. The new derived shape removes the manual bump
 * — every types.ts edit that survives comment-strip + whitespace-
 * normalise invalidates the parse cache automatically.
 *
 * Trade-off vs. the old integer: a pure-refactor edit to `types.ts`
 * (adding a non-required field, renaming a private type alias) now
 * invalidates the parse cache where the contributor could previously
 * have decided "no schema change, no bump." A one-shot full reparse
 * of unchanged files is cheap; the alternative — replaying cached
 * entries that no longer match the live `ExtractionResult` shape — is
 * a hard-to-diagnose corruption class.
 */
const PAYLOAD_VERSION = computeAlgoHash(import.meta.url, ['../types']);

interface CachedPayload {
  _v: string;
  result: ExtractionResult;
}

/**
 * Structural-sanity schema for a cached `ExtractionResult`. Every
 * object is `.loose()` and only the long-stable load-bearing fields
 * are required, so the schema validates "is this a structurally sane
 * extraction payload" WITHOUT re-declaring the full Node/Edge shape —
 * a future types.ts field addition therefore can't silently turn
 * cache hits into misses. It is strictly stronger than the prior bare
 * `Array.isArray(nodes) && Array.isArray(edges)` check: it confirms
 * every nodes / edges / refs element is an object carrying its core
 * id-kind-name keys, catching a corrupted element the array check
 * waved straight through into the extractor.
 *
 * Schema-VERSION drift is already handled upstream by `PAYLOAD_VERSION`
 * (a hash of types.ts); this guards the residual case — on-disk
 * corruption of an individual element within a current-version row.
 * Measured cost: ~25 µs per average file, ~19 ms across a full
 * 742-file reindex — negligible against the tree-sitter parse a cache
 * hit skips.
 */
const cachedNodeSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    qualifiedName: z.string(),
    filePath: z.string(),
    language: z.string(),
    startLine: z.number(),
    endLine: z.number(),
  })
  .loose();
const cachedEdgeSchema = z.object({ source: z.string(), target: z.string(), kind: z.string() }).loose();
const cachedRefSchema = z
  .object({
    fromNodeId: z.string(),
    referenceName: z.string(),
    referenceKind: z.string(),
  })
  .loose();
const ExtractionResultSchema = z
  .object({
    nodes: z.array(cachedNodeSchema),
    edges: z.array(cachedEdgeSchema),
    unresolvedReferences: z.array(cachedRefSchema),
  })
  .loose();

/** Default LRU cap. Tuned for medium codebases (~5k files): under
 *  this we don't bother evicting; at this we drop the oldest 25% in
 *  one shot to amortise the SELECT...DELETE round-trip. */
const DEFAULT_MAX_ROWS = 20_000;

// ─── Typed query schemas + definitions ────────────────────────────────────

const NoParams = z.object({});

/**
 * Row shape returned by `getCachedParseQuery` — the `payload` column
 * holds the JSON string we deserialise outside SQLite.
 */
const PayloadRowSchema = z.object({ payload: z.string().nullable() });
const CountRowSchema = z.object({ n: z.number() });
const CacheStatsRowSchema = z.object({
  rows: z.number(),
  sizeBytes: z.number(),
  currentVersionRows: z.number(),
});

const getCachedParseQuery = defineQuery({
  sql:
    'SELECT payload FROM parse_cache WHERE content_hash = @contentHash ' +
    'AND language = @language AND file_path = @filePath',
  params: z.object({
    contentHash: z.string(),
    language: z.string(),
    filePath: z.string(),
  }),
  row: PayloadRowSchema,
});

/**
 * Most-recent struct_hash for `(file_path, language)` across any
 * content_hash. The format-only fast path looks this up AFTER a
 * content-hash cache miss — the new content's struct_hash matched
 * against this prior hash decides whether the file is structurally
 * unchanged (whitespace-only) or a real semantic edit.
 *
 * `ORDER BY generated_at DESC LIMIT 1` is fine even with eviction:
 * if the prior row was evicted, the lookup misses, the file falls
 * through to the full re-extract path, and the next put writes a
 * fresh struct_hash.
 */
const StructHashRowSchema = z.object({ struct_hash: z.string() });
const getLatestStructHashQuery = defineQuery({
  sql:
    'SELECT struct_hash FROM parse_cache ' +
    'WHERE file_path = @filePath AND language = @language ' +
    'ORDER BY generated_at DESC LIMIT 1',
  params: z.object({
    filePath: z.string(),
    language: z.string(),
  }),
  row: StructHashRowSchema,
});

const putCachedParseQuery = defineQuery({
  sql: `INSERT INTO parse_cache (content_hash, language, file_path, payload, generated_at, struct_hash)
       VALUES (@contentHash, @language, @filePath, @payload, @generatedAt, @structHash)
       ON CONFLICT(content_hash, language, file_path) DO UPDATE SET
         payload = excluded.payload,
         generated_at = excluded.generated_at,
         struct_hash = excluded.struct_hash`,
  params: z.object({
    contentHash: z.string(),
    language: z.string(),
    filePath: z.string(),
    payload: z.string(),
    generatedAt: z.number(),
    structHash: z.string(),
  }),
  row: z.never(),
});

const parseCacheCountQuery = defineQuery({
  sql: 'SELECT COUNT(*) AS n FROM parse_cache',
  params: NoParams,
  row: CountRowSchema,
});

const evictParseCacheQuery = defineQuery({
  sql: `DELETE FROM parse_cache
        WHERE rowid IN (
          SELECT rowid FROM parse_cache ORDER BY generated_at ASC LIMIT @dropCount
        )`,
  params: z.object({ dropCount: z.number() }),
  row: z.never(),
});

const clearParseCacheByLangQuery = defineQuery({
  sql: 'DELETE FROM parse_cache WHERE language = @language',
  params: z.object({ language: z.string() }),
  row: z.never(),
});

const clearParseCacheAllQuery = defineQuery({
  sql: 'DELETE FROM parse_cache',
  params: NoParams,
  row: z.never(),
});

const getParseCacheStatsQuery = defineQuery({
  sql: `SELECT
         COUNT(*) AS rows,
         COALESCE(SUM(LENGTH(payload)), 0) AS sizeBytes,
         COALESCE(SUM(CASE WHEN json_extract(payload, '$._v') = @currentVersion THEN 1 ELSE 0 END), 0) AS currentVersionRows
       FROM parse_cache`,
  params: z.object({ currentVersion: z.string() }),
  row: CacheStatsRowSchema,
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    getCachedParse?: TypedQuery<
      { contentHash: string; language: string; filePath: string },
      { payload: string | null }
    >;
    getLatestStructHash?: TypedQuery<{ filePath: string; language: string }, { struct_hash: string }>;
    putCachedParse?: TypedQuery<
      {
        contentHash: string;
        language: string;
        filePath: string;
        payload: string;
        generatedAt: number;
        structHash: string;
      },
      never
    >;
    parseCacheCount?: TypedQuery<Record<string, never>, { n: number }>;
    evictParseCache?: TypedQuery<{ dropCount: number }, never>;
    clearParseCacheByLang?: TypedQuery<{ language: string }, never>;
    clearParseCacheAll?: TypedQuery<Record<string, never>, never>;
    getParseCacheStats?: TypedQuery<
      { currentVersion: string },
      { rows: number; sizeBytes: number; currentVersionRows: number }
    >;
  }
}

// ─── Public functions ─────────────────────────────────────────────────────

/**
 * Read a cached ExtractionResult. Returns null on miss, on JSON
 * parse failure (treated as a corrupt entry), or when the
 * deserialised payload doesn't have the expected shape (defends
 * against rare schema-drift after a crash).
 */
interface GetCachedParseArgs {
  qb: QueryBuilder;
  contentHash: string;
  language: string;
  filePath: string;
}

export function getCachedParse(args: GetCachedParseArgs): ExtractionResult | null {
  const { qb, contentHash, language, filePath } = args;
  qb.queries.getCachedParse ??= getCachedParseQuery(qb.db);
  const row = qb.queries.getCachedParse.get({ contentHash, language, filePath });
  if (!row?.payload) return null;
  try {
    const parsed = JSON.parse(row.payload) as CachedPayload | ExtractionResult;
    // Schema drift guard: a payload missing the version envelope is
    // a pre-versioned entry from before this guard shipped; treat it
    // as a miss so it gets re-parsed and re-cached in the new shape.
    // A version mismatch (older _v from a previous schema) is also a
    // miss — replaying it could surface fields that no longer exist.
    if (!('_v' in parsed) || parsed._v !== PAYLOAD_VERSION) return null;
    const result = parsed.result;
    // Structural-sanity validation — a payload whose nodes / edges /
    // refs aren't arrays of well-shaped objects (rare on-disk
    // corruption of a current-version row) is treated as a miss and
    // re-parsed cleanly. Validation-only: the original `result` is
    // returned untouched.
    if (!ExtractionResultSchema.safeParse(result).success) return null;
    return result;
  } catch (err) {
    logDebug('parse_cache: payload JSON parse failed (treating as miss)', {
      contentHash,
      err: String(err),
    });
    return null;
  }
}

/**
 * Write an ExtractionResult into the cache. Idempotent — on conflict
 * (same content_hash + language + file_path) the existing row is
 * replaced and `generated_at` refreshed so LRU eviction sees this
 * entry as recent.
 */
interface PutCachedParseArgs {
  qb: QueryBuilder;
  contentHash: string;
  language: string;
  filePath: string;
  result: ExtractionResult;
  /**
   * Per-file structural fingerprint over the produced nodes —
   * `computeStructHash(result.nodes)`. The format-only fast path
   * reads this on the next re-extract via {@link getLatestStructHashForFile}.
   *
   * Optional with a default of `''` for callers that don't compute
   * the hash (test fixtures; legacy code paths that haven't been
   * threaded). The default-empty value is the "always-mismatch first
   * time" sentinel — {@link getLatestStructHashForFile} treats empty
   * strings as a miss so the first hash-bearing put after a fresh
   * install populates the column and subsequent re-extracts can
   * fast-path. Production sync (`eoRunParseOrCached`) always passes
   * a real hash.
   */
  structHash?: string;
}

export function putCachedParse(args: PutCachedParseArgs): void {
  const { qb, contentHash, language, filePath, result, structHash = '' } = args;
  let payload: string;
  try {
    const wrapped: CachedPayload = { _v: PAYLOAD_VERSION, result };
    payload = JSON.stringify(wrapped);
  } catch (err) {
    // ExtractionResult should be JSON-safe (no Date/Function/circular
    // refs in the schema), but a malformed framework-extractor payload
    // could theoretically introduce one. Skip the write rather than
    // throwing — caller already has the live result in hand.
    logDebug('parse_cache: payload JSON stringify failed (skip cache write)', {
      contentHash,
      err: String(err),
    });
    return;
  }
  qb.queries.putCachedParse ??= putCachedParseQuery(qb.db);
  qb.queries.putCachedParse.run({
    contentHash,
    language,
    filePath,
    payload,
    generatedAt: Date.now(),
    structHash,
  });
}

/**
 * The most recently cached struct_hash for `(filePath, language)`,
 * or `null` if no row matches (cache miss / pre-G7 row evicted /
 * fresh file). The format-only fast path compares this to the new
 * struct_hash computed from the just-parsed nodes.
 */
export function getLatestStructHashForFile(qb: QueryBuilder, filePath: string, language: string): string | null {
  qb.queries.getLatestStructHash ??= getLatestStructHashQuery(qb.db);
  const row = qb.queries.getLatestStructHash.get({ filePath, language });
  if (!row) return null;
  // A row with `struct_hash = ''` is a pre-G7 cached entry (default
  // value from migration 066's ALTER TABLE) — treat it as a miss so
  // the first post-upgrade extract takes the full path and writes the
  // real hash, after which subsequent re-extracts can fast-path.
  if (row.struct_hash === '') return null;
  return row.struct_hash;
}

/**
 * Drop the oldest 25% of entries when the table exceeds `maxRows`.
 * Called by the indexer at the END of a full pass — single eviction
 * pass per indexAll keeps the per-row write fast (no eviction probe
 * on every put). 25% batch size amortises the sort+delete cost over
 * many subsequent inserts.
 */
export function evictParseCacheIfOversized(qb: QueryBuilder, maxRows: number = DEFAULT_MAX_ROWS): number {
  qb.queries.parseCacheCount ??= parseCacheCountQuery(qb.db);
  const countRow = qb.queries.parseCacheCount.get({});
  if (!countRow || countRow.n <= maxRows) return 0;
  const dropCount = Math.ceil(countRow.n * 0.25);
  qb.queries.evictParseCache ??= evictParseCacheQuery(qb.db);
  const info = qb.queries.evictParseCache.run({ dropCount });
  return info.changes;
}

/**
 * Drop cached entries. Without `language`, drops every row. With
 * `language`, drops only rows for that language — useful when one
 * extractor changed and you want to force re-parse just that
 * language without invalidating the cache for the other ~20 grammars.
 *
 * Returns the number of rows deleted so the caller can surface
 * scope to the user ("cleared 437 typescript entries").
 */
export function clearParseCache(qb: QueryBuilder, language?: string): number {
  if (language) {
    qb.queries.clearParseCacheByLang ??= clearParseCacheByLangQuery(qb.db);
    const info = qb.queries.clearParseCacheByLang.run({ language });
    return info.changes;
  }
  qb.queries.clearParseCacheAll ??= clearParseCacheAllQuery(qb.db);
  const info = qb.queries.clearParseCacheAll.run({});
  return info.changes;
}

/**
 * Stats for diagnostics. `currentVersionRows` are the entries that
 * will replay on a cache hit; `staleVersionRows` are the ones
 * recorded under a prior `_v` envelope and treated as misses (they
 * sit in the table until LRU eviction recycles them).
 *
 * Surfaced via `cartograph_status` so the agent and operator can spot
 * a "cache is hiding stale extractor output" situation at a glance —
 * a stale-row count > 0 is fine (the version guard does the right
 * thing), but if it stays high after several reindexes the answer is
 * usually `clearParseCache` (or `cartograph admin index --force` plus
 * a deliberate cache wipe — see `clearStructural` for why `--force`
 * intentionally preserves the cache).
 */
export function getParseCacheStats(qb: QueryBuilder): {
  rows: number;
  sizeBytes: number;
  currentVersion: string;
  currentVersionRows: number;
  staleVersionRows: number;
} {
  qb.queries.getParseCacheStats ??= getParseCacheStatsQuery(qb.db);
  const row = qb.queries.getParseCacheStats.get({ currentVersion: PAYLOAD_VERSION });
  if (!row) {
    return {
      rows: 0,
      sizeBytes: 0,
      currentVersion: PAYLOAD_VERSION,
      currentVersionRows: 0,
      staleVersionRows: 0,
    };
  }
  return {
    rows: row.rows,
    sizeBytes: row.sizeBytes,
    currentVersion: PAYLOAD_VERSION,
    currentVersionRows: row.currentVersionRows,
    staleVersionRows: row.rows - row.currentVersionRows,
  };
}
