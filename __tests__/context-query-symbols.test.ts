import { describe, expect, it } from 'vitest';
import { extractSymbolsFromQuery } from '../src/context/query-symbols.js';
import { suppressProjectNameQueryNoise } from '../src/search/query-utils.js';

describe('extractSymbolsFromQuery', () => {
  it('extracts common identifier shapes from natural-language queries', () => {
    const symbols = extractSymbolsFromQuery(
      'show PaymentService and signInWithGoogle for app.isPackaged with MAX_RETRIES in user_service',
    );

    expect(symbols).toEqual(
      expect.arrayContaining([
        'PaymentService',
        'signInWithGoogle',
        'app.isPackaged',
        'app',
        'isPackaged',
        'MAX_RETRIES',
        'user_service',
      ]),
    );
  });

  it('filters generic prose terms that flood symbol search', () => {
    const symbols = extractSymbolsFromQuery('how does the request handler return data from code');

    expect(symbols).not.toContain('how');
    expect(symbols).not.toContain('request');
    expect(symbols).not.toContain('return');
    expect(symbols).not.toContain('data');
    expect(symbols).not.toContain('code');
  });

  it('ignores malformed dotted paths', () => {
    const symbols = extractSymbolsFromQuery('check app..isPackaged and 3bad.name');

    expect(symbols).not.toContain('app..isPackaged');
    expect(symbols).not.toContain('3bad.name');
  });
});

describe('suppressProjectNameQueryNoise', () => {
  it('drops standalone project-name tokens only from broad multi-anchor queries', () => {
    expect(suppressProjectNameQueryNoise('cartograph watcher sync relevance', '/repo/cartograph')).toBe(
      'watcher sync relevance',
    );
    expect(suppressProjectNameQueryNoise('Cartograph class', '/repo/cartograph')).toBe('Cartograph class');
    expect(suppressProjectNameQueryNoise('cartograph_context schema', '/repo/cartograph')).toBe(
      'cartograph_context schema',
    );
  });
});
