/**
 * Unit tests for the pure SQLite→Postgres SQL string transforms in
 * postgres-worker-sql.ts. These run without a live Postgres because the
 * functions are deterministic string rewrites — they pin the dialect
 * parity fixes (plain LIKE → ILIKE, quote-aware token handling) that
 * would otherwise only surface against a real Postgres backend.
 */

import { describe, it, expect } from 'vitest';
import {
  dedupePostgresRecordsetRows,
  offsetInsideLiteral,
  rewritePlainLikeToILike,
  rewritePostgresAfterPlaceholders,
  sanitizePostgresJsonValue,
  stringLiteralSpans,
} from '../src/db/postgres-worker-sql.js';

describe('rewritePlainLikeToILike', () => {
  it('rewrites plain LIKE to ILIKE (SQLite default is case-insensitive)', () => {
    expect(rewritePlainLikeToILike('WHERE name LIKE @p')).toBe('WHERE name ILIKE @p');
  });

  it('preserves an ESCAPE clause', () => {
    expect(rewritePlainLikeToILike("WHERE path LIKE @x ESCAPE '\\'")).toBe("WHERE path ILIKE @x ESCAPE '\\'");
  });

  it('is idempotent — does not touch an already-rewritten ILIKE', () => {
    expect(rewritePlainLikeToILike('WHERE name ILIKE @p')).toBe('WHERE name ILIKE @p');
  });

  it('does not rewrite LIKE inside a string literal', () => {
    expect(rewritePlainLikeToILike("WHERE tag = 'I LIKE cake'")).toBe("WHERE tag = 'I LIKE cake'");
  });

  it('rewrites multiple LIKEs in one statement', () => {
    expect(rewritePlainLikeToILike('a LIKE @x OR b LIKE @y')).toBe('a ILIKE @x OR b ILIKE @y');
  });
});

describe('dedupePostgresRecordsetRows', () => {
  it('keeps the last row for duplicate keys to match sequential SQLite upserts', () => {
    expect(
      dedupePostgresRecordsetRows(
        [
          { id: 'n:1', name: 'first' },
          { id: 'n:2', name: 'second' },
          { id: 'n:1', name: 'last' },
        ],
        'id',
      ),
    ).toEqual([
      { id: 'n:2', name: 'second' },
      { id: 'n:1', name: 'last' },
    ]);
  });
});

describe('stringLiteralSpans / offsetInsideLiteral', () => {
  it('detects a single-quoted literal span', () => {
    const sql = "a '%?%' b @n";
    const spans = stringLiteralSpans(sql);
    expect(spans.length).toBe(1);
    // offset 4 is inside the '%?%' literal; offset 0 ('a') is outside.
    expect(offsetInsideLiteral(4, spans)).toBe(true);
    expect(offsetInsideLiteral(0, spans)).toBe(false);
  });

  it("treats a doubled quote ('') as staying inside the literal", () => {
    const spans = stringLiteralSpans("'it''s'");
    expect(spans.length).toBe(1);
    expect(spans[0]).toEqual([0, 7]);
  });

  it('handles SQL with no literals', () => {
    expect(stringLiteralSpans('SELECT id FROM nodes WHERE name = @n')).toEqual([]);
  });
});

describe('rewritePostgresAfterPlaceholders — IS NULL cast typing', () => {
  it('casts an IS-NULL placeholder also used in a `>=` comparison to numeric (the sentinel bug)', () => {
    // `(@since IS NULL OR ts >= @since)` → same `$1`. The cast on the
    // IS NULL occurrence sets the whole param's type, so it must be
    // numeric to match `ts >= $1` (a ::text cast gave "double precision
    // >= text").
    const out = rewritePostgresAfterPlaceholders('WHERE ($1 IS NULL OR ts >= $1)', new Set());
    expect(out).toBe('WHERE ($1::double precision IS NULL OR ts >= $1)');
  });

  it('casts a text/equality IS-NULL placeholder to ::text', () => {
    const out = rewritePostgresAfterPlaceholders('WHERE ($1 IS NULL OR node_id = $1)', new Set());
    expect(out).toBe('WHERE ($1::text IS NULL OR node_id = $1)');
  });

  it('casts a placeholder used ONLY in an IS NULL test to ::text', () => {
    expect(rewritePostgresAfterPlaceholders('WHERE $1 IS NULL', new Set())).toBe('WHERE $1::text IS NULL');
  });

  it('casts json_each placeholders to ::jsonb', () => {
    const out = rewritePostgresAfterPlaceholders('WHERE $1 IS NULL AND json_each($1)', new Set([1]));
    expect(out).toContain('$1::jsonb IS NULL');
  });

  it('rewrites column-based json_each calls to Postgres jsonb table functions', () => {
    const out = rewritePostgresAfterPlaceholders(
      'SELECT value FROM nodes m, json_each(m.decorators) WHERE value = $1',
      new Set(),
    );

    expect(out).toContain('jsonb_array_elements_text(m.decorators::jsonb) AS json_each(value)');
    expect(out).not.toContain('json_each(m.decorators)');
  });
});

describe('sanitizePostgresJsonValue', () => {
  it('replaces unpaired surrogate code units while preserving valid pairs', () => {
    const smiling = 'ok \uD83D\uDE00';
    const sanitized = sanitizePostgresJsonValue({
      high: 'bad \uD800',
      low: '\uDC00 bad',
      nested: [smiling],
    });

    expect(sanitized).toEqual({
      high: 'bad \uFFFD',
      low: '\uFFFD bad',
      nested: [smiling],
    });
  });
});
