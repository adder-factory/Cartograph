import { describe, expect, it } from 'vitest';
import {
  ASK_QUESTION_MAX_LENGTH,
  parseRetrieveK,
  renderAskAnnotations,
  resolveAskProjectPath,
  validateAskQuestion,
} from '../src/features/ask/runtime.js';

describe('ask feature runtime', () => {
  it('validates questions as return values', () => {
    expect(validateAskQuestion('How does indexing work?')).toEqual({ ok: true });
    expect(validateAskQuestion('   ')).toEqual({ ok: false, error: 'ask: the question must not be empty.' });
    expect(validateAskQuestion('x'.repeat(ASK_QUESTION_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: `ask: the question must be at most ${ASK_QUESTION_MAX_LENGTH} characters (got ${
        ASK_QUESTION_MAX_LENGTH + 1
      }).`,
    });
  });

  it('parses retrieve limits within the ask tool bounds', () => {
    expect(parseRetrieveK(undefined)).toEqual({ ok: true, value: 12 });
    expect(parseRetrieveK('4')).toEqual({ ok: true, value: 4 });
    expect(parseRetrieveK('30')).toEqual({ ok: true, value: 30 });
    expect(parseRetrieveK('0')).toEqual({ ok: false, error: 'Invalid value for --retrieve-k: must be >= 4' });
    expect(parseRetrieveK('31')).toEqual({ ok: false, error: 'Invalid value for --retrieve-k: must be <= 30' });
    expect(parseRetrieveK('many')).toEqual({
      ok: false,
      error: 'Invalid value for --retrieve-k: "many" is not an integer',
    });
  });

  it('resolves project path option precedence', () => {
    expect(resolveAskProjectPath('/positional', {})).toBe('/positional');
    expect(resolveAskProjectPath('/positional', { projectPath: '/option' })).toBe('/option');
    expect(resolveAskProjectPath(undefined, {})).toBeUndefined();
  });

  it('renders source annotations as data-first lines', () => {
    const lines = renderAskAnnotations({
      citationSections: ['Verified citations'],
      citations: [
        {
          node: {
            name: 'ask',
            kind: 'function',
            filePath: 'src/ask.ts',
            startLine: 42,
          },
        },
      ],
      retrieveMs: 10,
      chatMs: 20,
      modelDisplayName: 'local-model',
      counter: '1 verified',
      dim: (line) => `[dim]${line}`,
    });

    expect(lines).toEqual([
      '[dim]Verified citations',
      '\n[dim]Retrieval sources:',
      '[dim]  • ask (function) src/ask.ts:42',
      '[dim]\n  retrieve 10ms · chat 20ms · model local-model · 1 verified',
    ]);
  });
});
