import { describe, it, expect } from 'vitest';
import type { SearchResult } from '../src/types.js';
import { buildConceptHintIfNeeded } from '../src/mcp/tools/_search.js';

const TIP_FRAGMENT = 'Top results match only the first query token';
const MULTI_TOKEN_PREFACE = 'Multi-token query detected';

function emptyResults(): ReadonlyArray<SearchResult> {
  return [];
}

function makeResult(name: string, signature?: string): SearchResult {
  return {
    node: {
      id: `n_${name}`,
      kind: 'function',
      name,
      qualifiedName: name,
      filePath: 'src/file.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 10,
      signature,
      centrality: 0.1,
    },
    score: 1,
  };
}

describe('buildConceptHintIfNeeded — qualifier-token filter', () => {
  it('suppresses on a single concept token', () => {
    const hints = buildConceptHintIfNeeded('getAllImports', emptyResults());
    expect(hints.preResult).toBe('');
    expect(hints.postResult).toBe('');
  });

  it('suppresses when only qualifiers accompany a single concept token', () => {
    let hints = buildConceptHintIfNeeded('getAllImports kind:function', emptyResults());
    expect(hints.preResult).toBe('');
    expect(hints.postResult).toBe('');

    hints = buildConceptHintIfNeeded('foo kind:function lang:typescript', emptyResults());
    expect(hints.preResult).toBe('');
    expect(hints.postResult).toBe('');
  });

  it('shows pre-result hint on multi-token query with lookup intent', () => {
    const hints = buildConceptHintIfNeeded('foo bar baz', emptyResults());
    expect(hints.preResult).toContain(MULTI_TOKEN_PREFACE);
    expect(hints.postResult).toBe('');
  });

  it('shows pre-result hint even with poor-match results (lookup intent detected)', () => {
    // Single result that does NOT match any query tokens beyond the first
    const results: SearchResult[] = [makeResult('fooUnrelated', 'string')];
    const hints = buildConceptHintIfNeeded('foo bar baz', results);
    // Multi-token query with poor results: pre-result hint (lookup intent detection)
    expect(hints.preResult).toContain(MULTI_TOKEN_PREFACE);
    expect(hints.postResult).toBe('');
  });

  it('still fires on a genuine multi-concept query with no top-N coverage', () => {
    const hints = buildConceptHintIfNeeded('parse cache invalidation', emptyResults());
    // Empty results: show pre-result, not post-result
    expect(hints.preResult).toContain(MULTI_TOKEN_PREFACE);
  });

  it('handles empty query', () => {
    const hints = buildConceptHintIfNeeded('', emptyResults());
    expect(hints.preResult).toBe('');
    expect(hints.postResult).toBe('');
  });

  it('shows pre-result hint even when multi-token results ARE well-matched (lookup intent)', () => {
    // Results that DO match query tokens (e.g., "cacheInvalidate")
    const results: SearchResult[] = [makeResult('cacheInvalidate', '() => void')];
    const hints = buildConceptHintIfNeeded('cache invalidate', results);
    // Even with good matches, multi-token queries show pre-result (lookup intent detection)
    // This helps users understand that only the first token matches, even if results look good
    expect(hints.preResult).toContain(MULTI_TOKEN_PREFACE);
    expect(hints.postResult).toBe('');
  });
});
