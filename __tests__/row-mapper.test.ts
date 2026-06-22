/**
 * Unit tests for the type-safe row → object mapper added in
 * `src/db/row-mapper.ts`. Pins the contract of each transform
 * variant + the global undefined-stripping behaviour.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { bindingsFromObject, insertSqlParts, mapRow, updateSqlSets, type Schema } from '../src/db/row-mapper.js';

interface FakeRow {
  id: string;
  name: string;
  is_flag: number;
  raw_text: string | null;
  json_blob: string | null;
  count: number | null;
}

interface FakeOut {
  id: string;
  name: string;
  isFlag: boolean;
  rawText?: string;
  blob?: { x: number };
  count: number;
}

describe('mapRow()', () => {
  it('handles 1:1 column → field mapping', () => {
    const schema: Schema<{ id: string; name: string }, FakeRow> = {
      id: 'id',
      name: 'name',
    };
    const out = mapRow({ id: 'a', name: 'b' } as FakeRow, schema);
    expect(out).toEqual({ id: 'a', name: 'b' });
  });

  it('coerces 0/1 → boolean for bool01', () => {
    const schema: Schema<{ isFlag: boolean }, { is_flag: number }> = {
      isFlag: { col: 'is_flag', bool01: true },
    };
    expect(mapRow({ is_flag: 1 }, schema)).toEqual({ isFlag: true });
    expect(mapRow({ is_flag: 0 }, schema)).toEqual({ isFlag: false });
    // Anything else → false (covers `is_flag: 2` and `is_flag: null`).
    expect(mapRow({ is_flag: 2 }, schema)).toEqual({ isFlag: false });
    // SQLite INTEGER columns can be NULL; the JS layer treats NULL as
    // false (since `null === 1` is `false`) — pin that explicitly so
    // we don't rely on SQLite's NULL-to-0 coercion.
    const nullSchema: Schema<{ isFlag: boolean }, { is_flag: number | null }> = {
      isFlag: { col: 'is_flag', bool01: true },
    };
    expect(mapRow({ is_flag: null }, nullSchema)).toEqual({ isFlag: false });
  });

  it('strips null → undefined for nullable, then drops the key', () => {
    const schema: Schema<{ rawText?: string }, { raw_text: string | null }> = {
      rawText: { col: 'raw_text', nullable: true },
    };
    // NULL collapses to undefined → key omitted.
    const omitted = mapRow({ raw_text: null }, schema);
    expect(omitted).toEqual({});
    expect('rawText' in omitted).toBe(false);
    // Real value passes through.
    expect(mapRow({ raw_text: 'hi' }, schema)).toEqual({ rawText: 'hi' });
  });

  it('parses JSON columns with fallback', () => {
    type T = { blob?: { x: number } };
    const schema: Schema<T, { json_blob: string | null }> = {
      blob: { col: 'json_blob', json: true },
    };
    expect(mapRow({ json_blob: '{"x":42}' }, schema)).toEqual({ blob: { x: 42 } });
    // null → fallback (undefined when not specified) → key dropped.
    expect(mapRow({ json_blob: null }, schema)).toEqual({});
    // Malformed JSON returns the fallback.
    expect(mapRow({ json_blob: '{not-json' }, schema)).toEqual({});
  });

  it('uses an explicit fallback for json when provided', () => {
    type T = { tags: string[] };
    const schema: Schema<T, { json_blob: string | null }> = {
      tags: { col: 'json_blob', json: true, fallback: [] },
    };
    expect(mapRow({ json_blob: null }, schema)).toEqual({ tags: [] });
    expect(mapRow({ json_blob: '["a","b"]' }, schema)).toEqual({ tags: ['a', 'b'] });
  });

  it('validates parsed JSON fields with the supplied schema before returning them', () => {
    type T = { tags: string[] };
    const schema: Schema<T, { json_blob: string | null }> = {
      tags: { col: 'json_blob', json: true, schema: z.array(z.string()), fallback: [] },
    };

    expect(mapRow({ json_blob: '["a","b"]' }, schema)).toEqual({ tags: ['a', 'b'] });
    expect(mapRow({ json_blob: '[1,2]' }, schema)).toEqual({ tags: [] });
    expect(mapRow({ json_blob: '{"0":"a"}' }, schema)).toEqual({ tags: [] });
  });

  it('applies an arbitrary cast() function', () => {
    const schema: Schema<{ count: number }, { count: number | null }> = {
      count: { col: 'count', cast: (v) => v ?? -1 },
    };
    expect(mapRow({ count: 5 }, schema)).toEqual({ count: 5 });
    expect(mapRow({ count: null }, schema)).toEqual({ count: -1 });
  });

  it('strips undefined values from the final output (compact semantic)', () => {
    const schema: Schema<{ a: string; b?: string }, { a: string; b: string | null }> = {
      a: 'a',
      b: { col: 'b', nullable: true },
    };
    const out = mapRow({ a: 'x', b: null }, schema);
    expect(out).toEqual({ a: 'x' });
    expect('b' in out).toBe(false);
  });

  it('returns a fresh object — does not mutate the row', () => {
    const row = { id: '1', name: 'n' };
    const out = mapRow(row, { id: 'id', name: 'name' });
    expect(out).not.toBe(row);
    expect(row).toEqual({ id: '1', name: 'n' }); // unchanged
  });
});

describe('bindingsFromObject() — write-side mirror', () => {
  it('round-trips bool01 through mapRow', () => {
    const schema: Schema<{ flag: boolean }, { flag: number }> = {
      flag: { col: 'flag', bool01: true },
    };
    // JS true → bind 1 → row 1 → mapRow → JS true.
    const bound = bindingsFromObject({ flag: true }, schema);
    expect(bound).toEqual({ flag: 1 });
    expect(mapRow({ flag: bound['flag'] as number }, schema)).toEqual({ flag: true });
    // Same for false.
    const boundFalse = bindingsFromObject({ flag: false }, schema);
    expect(boundFalse).toEqual({ flag: 0 });
    expect(mapRow({ flag: boundFalse['flag'] as number }, schema)).toEqual({ flag: false });
  });

  it('serialises json fields and round-trips', () => {
    type T = { tags: string[] };
    const schema: Schema<T, { tags: string | null }> = {
      tags: { col: 'tags', json: true, fallback: [] },
    };
    const bound = bindingsFromObject({ tags: ['a', 'b'] }, schema);
    expect(bound).toEqual({ tags: '["a","b"]' });
    expect(mapRow({ tags: bound['tags'] as string }, schema)).toEqual({ tags: ['a', 'b'] });
  });

  it('coerces undefined → null for nullable + 1:1 + cast arms', () => {
    type T = { a?: string; b: string; c: number };
    const schema: Schema<T, { a: string | null; b: string; c: number | null }> = {
      a: { col: 'a', nullable: true },
      b: 'b',
      c: { col: 'c', cast: (v) => (v as number | null) ?? 0 },
    };
    // `a` undefined → null bind. `c` undefined → null bind (cast is read-side).
    const bound = bindingsFromObject({ b: 'hi' } as T, schema);
    expect(bound['a']).toBe(null);
    expect(bound['b']).toBe('hi'); // present value passes through
    expect(bound['c']).toBe(null);
  });
});

describe('insertSqlParts()', () => {
  it('produces snake_case columns + camelCase bind placeholders', () => {
    const schema: Schema<{ id: string; createdAt: number }, { id: string; created_at: number }> = {
      id: 'id',
      createdAt: 'created_at',
    };
    const parts = insertSqlParts(schema);
    expect(parts.columns).toBe('id, created_at');
    expect(parts.bindings).toBe('@id, @createdAt');
  });

  it('honours omitCols', () => {
    const schema: Schema<{ a: string; b: string; c: string }, { a: string; b: string; c: string }> = {
      a: 'a',
      b: 'b',
      c: 'c',
    };
    const parts = insertSqlParts(schema, { omitCols: ['b'] });
    expect(parts.columns).toBe('a, c');
    expect(parts.bindings).toBe('@a, @c');
  });
});

describe('updateSqlSets()', () => {
  it('produces a `col = @key` SET list', () => {
    const schema: Schema<{ id: string; createdAt: number }, { id: string; created_at: number }> = {
      id: 'id',
      createdAt: 'created_at',
    };
    expect(updateSqlSets(schema, { omitCols: ['id'] })).toBe('created_at = @createdAt');
  });
});
