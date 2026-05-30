/**
 * Unit tests for the field-qualified query parser — the algorithm
 * behind `kind:`/`lang:`/`path:`/`name:` filtering. The bounded
 * edit-distance primitive it pairs with for the fuzzy typo fallback
 * is covered in `text-distance.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { parseQuery } from '../src/search/query-parser.js';

describe('parseQuery', () => {
  it('returns plain text for a query with no field prefixes', () => {
    const r = parseQuery('authenticate user');
    expect(r.text).toBe('authenticate user');
    expect(r.kinds).toEqual([]);
    expect(r.languages).toEqual([]);
    expect(r.pathFilters).toEqual([]);
    expect(r.nameFilters).toEqual([]);
  });

  it('extracts kind: filter and removes it from text', () => {
    const r = parseQuery('kind:function auth');
    expect(r.kinds).toEqual(['function']);
    expect(r.text).toBe('auth');
  });

  it('extracts lang: and language: as the same filter family', () => {
    const a = parseQuery('lang:typescript foo');
    const b = parseQuery('language:typescript foo');
    expect(a.languages).toEqual(['typescript']);
    expect(b.languages).toEqual(['typescript']);
  });

  it('handles multiple kind: filters as an OR set', () => {
    const r = parseQuery('kind:function kind:method auth');
    expect(r.kinds.sort()).toEqual(['function', 'method']);
  });

  it('extracts path: and name: as substring filters (kept verbatim)', () => {
    const r = parseQuery('path:src/api name:Handler');
    expect(r.pathFilters).toEqual(['src/api']);
    expect(r.nameFilters).toEqual(['Handler']);
  });

  it('preserves quoted spans as a single token (whitespace in path:)', () => {
    const r = parseQuery('path:"my dir/file" foo');
    expect(r.pathFilters).toEqual(['my dir/file']);
    expect(r.text).toBe('foo');
  });

  it('passes URL-like tokens through to text (does not match http: as a field)', () => {
    const r = parseQuery('http://example.com');
    expect(r.text).toBe('http://example.com');
    expect(r.kinds).toEqual([]);
  });

  it('passes empty-value tokens through as text (kind: → "kind:")', () => {
    const r = parseQuery('kind: foo');
    expect(r.kinds).toEqual([]);
    // The trailing-colon token comes back as plain text
    expect(r.text.includes('kind:')).toBe(true);
  });

  it('passes unknown field prefixes through as text (TODO: keeps the colon)', () => {
    const r = parseQuery('TODO: needs review');
    expect(r.text).toBe('TODO: needs review');
    expect(r.kinds).toEqual([]);
  });

  it('rejects unknown values for kind: (passes the whole token to text)', () => {
    const r = parseQuery('kind:invalid foo');
    // Invalid kind value falls back to text
    expect(r.kinds).toEqual([]);
    expect(r.text).toContain('kind:invalid');
  });

  it('handles all-filters-no-text query', () => {
    const r = parseQuery('kind:function lang:typescript');
    expect(r.kinds).toEqual(['function']);
    expect(r.languages).toEqual(['typescript']);
    expect(r.text).toBe('');
  });

  it('survives empty input', () => {
    const r = parseQuery('');
    expect(r.text).toBe('');
    expect(r.kinds).toEqual([]);
  });

  it('survives a very long input (no allocation explosion)', () => {
    const huge = 'foo '.repeat(5000); // 20k chars
    const r = parseQuery(huge);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('extracts sig: filter (and signature: alias)', () => {
    const a = parseQuery('sig:Promise<User>');
    const b = parseQuery('signature:Promise<User>');
    expect(a.signatureFilters).toEqual(['Promise<User>']);
    expect(b.signatureFilters).toEqual(['Promise<User>']);
    expect(a.text).toBe('');
  });

  it('extracts callers-of: and callees-of: graph qualifiers', () => {
    const r = parseQuery('callers-of:authenticate name:Handler');
    expect(r.callersOf).toEqual(['authenticate']);
    expect(r.nameFilters).toEqual(['Handler']);
    expect(r.text).toBe('');

    const r2 = parseQuery('callees-of:bootstrap');
    expect(r2.calleesOf).toEqual(['bootstrap']);
  });

  it('extracts the depends-on: graph qualifier', () => {
    const r = parseQuery('depends-on:UserService kind:class');
    expect(r.dependsOn).toEqual(['UserService']);
    expect(r.kinds).toEqual(['class']);
    expect(r.text).toBe('');

    // Defaults to an empty array when absent.
    expect(parseQuery('plain query').dependsOn).toEqual([]);
  });

  it('parses centrality: with numeric comparators', () => {
    const cases: Array<[string, { op: string; value: number }]> = [
      ['centrality:>0.01', { op: '>', value: 0.01 }],
      ['centrality:>=0.001', { op: '>=', value: 0.001 }],
      ['centrality:<0.5', { op: '<', value: 0.5 }],
      ['centrality:<=0.001', { op: '<=', value: 0.001 }],
      ['centrality:0.05', { op: '>=', value: 0.05 }], // bare number → >=
    ];
    for (const [input, expected] of cases) {
      const r = parseQuery(input);
      expect(r.centralityFilter).toEqual(expected);
      expect(r.text).toBe('');
    }
  });

  it('falls back to FTS text on malformed centrality:', () => {
    const r = parseQuery('centrality:not-a-number');
    expect(r.centralityFilter).toBeUndefined();
    expect(r.text).toBe('centrality:not-a-number');
  });

  it('takes the LAST centrality filter on conflict', () => {
    const r = parseQuery('centrality:>0.01 centrality:>0.5');
    expect(r.centralityFilter).toEqual({ op: '>', value: 0.5 });
  });

  it('parses sort:centrality and sort:relevance', () => {
    expect(parseQuery('sort:centrality').sortBy).toBe('centrality');
    expect(parseQuery('sort:relevance').sortBy).toBe('relevance');
    expect(parseQuery('sort:CENTRALITY').sortBy).toBe('centrality');
    expect(parseQuery('').sortBy).toBeUndefined();
  });

  it('falls back to FTS text on unknown sort: value', () => {
    const r = parseQuery('sort:nonsense');
    expect(r.sortBy).toBeUndefined();
    expect(r.text).toBe('sort:nonsense');
  });
});
