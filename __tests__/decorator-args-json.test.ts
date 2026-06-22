import { describe, expect, it } from 'vitest';
import { parseDecoratorArgsJson } from '../src/index-hooks/_decorator-args.js';

describe('parseDecoratorArgsJson', () => {
  it('parses well-formed decorator args including named args', () => {
    expect(
      parseDecoratorArgsJson(
        JSON.stringify([
          {
            name: 'Block',
            argStrings: ['users'],
            argIdents: ['UserController'],
            namedArgs: { id: 'user_block' },
          },
        ]),
      ),
    ).toEqual([
      {
        name: 'Block',
        argStrings: ['users'],
        argIdents: ['UserController'],
        namedArgs: { id: 'user_block' },
      },
    ]);
  });

  it('rejects entries with non-string positional args instead of silently filtering them', () => {
    expect(
      parseDecoratorArgsJson(
        JSON.stringify([
          {
            name: 'Get',
            argStrings: ['users', 404],
            argIdents: [],
          },
        ]),
      ),
    ).toEqual([]);
  });

  it('rejects entries with non-string named args instead of silently filtering them', () => {
    expect(
      parseDecoratorArgsJson(
        JSON.stringify([
          {
            name: 'Block',
            argStrings: [],
            argIdents: [],
            namedArgs: { id: 'user_block', disabled: false },
          },
        ]),
      ),
    ).toEqual([]);
  });
});
