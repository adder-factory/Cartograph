import { describe, expect, it } from 'vitest';
import { buildFindMcpArgs, isValidFindAxis, parseFieldsOption } from '../src/features/find/runtime.js';

describe('find feature runtime', () => {
  it('builds MCP payloads for content, env, and sql axes', () => {
    expect(
      buildFindMcpArgs('needle', {
        by: 'content',
        limit: '7',
        caseSensitive: true,
        pathFilter: 'src',
        language: 'typescript',
        since: 'c_1',
        allowStale: true,
      }),
    ).toEqual({
      ok: true,
      args: {
        by: 'content',
        query: 'needle',
        limit: 7,
        caseSensitive: true,
        pathFilter: 'src',
        language: 'typescript',
        since: 'c_1',
        allowStale: true,
      },
    });

    expect(buildFindMcpArgs(undefined, { by: 'env', limit: '3', key: 'API_KEY', includeTests: false })).toEqual({
      ok: true,
      args: { by: 'env', limit: 3, key: 'API_KEY', includeTests: false },
    });

    expect(
      buildFindMcpArgs(undefined, { by: 'sql', limit: '4', key: 'users', op: 'read', includeTests: true }),
    ).toEqual({
      ok: true,
      args: { by: 'sql', limit: 4, key: 'users', op: 'read', includeTests: true },
    });
  });

  it('builds exact, fuzzy, and semantic name payloads', () => {
    expect(
      buildFindMcpArgs('Widget', {
        by: 'name',
        mode: 'exact',
        limit: '9',
        kind: 'class',
        compact: true,
        fields: 'name,path,id',
        since: 'c_2',
        allowStale: true,
      }),
    ).toEqual({
      ok: true,
      args: {
        by: 'name',
        mode: 'exact',
        query: 'Widget',
        limit: 9,
        kind: 'class',
        compact: true,
        fields: ['name', 'path', 'id'],
        since: 'c_2',
        allowStale: true,
      },
    });

    expect(
      buildFindMcpArgs('render', {
        by: 'name',
        mode: 'fuzzy',
        limit: '5',
        kind: 'function',
        sameLanguage: true,
        languageFilter: 'typescript',
        pathFilter: 'src/ui',
      }),
    ).toEqual({
      ok: true,
      args: {
        by: 'name',
        mode: 'fuzzy',
        query: 'render',
        limit: 5,
        kind: 'function',
        sameLanguage: true,
        languageFilter: 'typescript',
        pathFilter: 'src/ui',
      },
    });

    expect(
      buildFindMcpArgs(undefined, {
        by: 'name',
        mode: 'semantic',
        symbol: 'Button',
        differentLanguage: true,
        limit: '6',
        allowStale: true,
      }),
    ).toEqual({
      ok: true,
      args: {
        by: 'name',
        mode: 'semantic',
        limit: 6,
        symbol: 'Button',
        differentLanguage: true,
        allowStale: true,
      },
    });
  });

  it('returns expected validation failures as values', () => {
    expect(buildFindMcpArgs(undefined, { by: 'content' })).toEqual({
      ok: false,
      error: '--by content: [query] is required (regex pattern).',
    });
    expect(buildFindMcpArgs('x', { by: 'bogus' })).toEqual({
      ok: false,
      error: "--by: must be 'name' | 'content' | 'env' | 'sql'; got 'bogus'.",
    });
    expect(buildFindMcpArgs(undefined, { by: 'name', mode: 'semantic' })).toEqual({
      ok: false,
      error: '--by name --mode semantic: pass either [query] (concept text) or --symbol <name>',
    });
    expect(buildFindMcpArgs('x', { by: 'name', mode: 'semantic', symbol: 'Thing' })).toEqual({
      ok: false,
      error: '--by name --mode semantic: [query] and --symbol are mutually exclusive — pick one',
    });
    expect(
      buildFindMcpArgs('x', { by: 'name', mode: 'semantic', sameLanguage: true, differentLanguage: true }),
    ).toEqual({
      ok: false,
      error: '--by name --mode semantic: --same-language and --different-language are mutually exclusive — pick one',
    });
    expect(buildFindMcpArgs('x', { by: 'name', mode: 'other' })).toEqual({
      ok: false,
      error: 'Unknown --mode: other. Valid: exact | fuzzy | semantic | intent.',
    });
    expect(buildFindMcpArgs('x', { by: 'name', limit: '0' })).toEqual({
      ok: false,
      error: 'Invalid value for --limit: must be >= 1',
    });
    expect(buildFindMcpArgs('x', { by: 'name', limit: '1.5' })).toEqual({
      ok: false,
      error: 'Invalid value for --limit: "1.5" is not an integer',
    });
    expect(buildFindMcpArgs('x', { by: 'name', limit: '1e2' })).toEqual({
      ok: false,
      error: 'Invalid value for --limit: "1e2" is not an integer',
    });
  });

  it('keeps small parsing helpers available for CLI internals', () => {
    expect(parseFieldsOption(' name, kind,,path ')).toEqual(['name', 'kind', 'path']);
    expect(parseFieldsOption(undefined)).toBeUndefined();
    expect(isValidFindAxis('name')).toBe(true);
    expect(isValidFindAxis('content')).toBe(true);
    expect(isValidFindAxis('bogus')).toBe(false);
  });
});
