import { describe, expect, it } from 'vitest';
import { extractSymbolsFromQuery } from '../src/context/query-symbols.js';

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
