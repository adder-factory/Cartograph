import { describe, expect, it } from 'vitest';
import { parseCartographProcessList } from '../src/installer/doctor.js';

describe('doctor Cartograph process parsing', () => {
  it('skips malformed ps rows and keeps admin invocations without an explicit project path', () => {
    const rows = parseCartographProcessList(
      [
        'no-whitespace',
        'not-a-pid cartograph serve --mcp',
        '101 /usr/local/bin/cartograph admin index',
        '102 /usr/local/bin/cartograph serve --mcp',
        '103 node unrelated.js',
      ].join('\n'),
      '/repo/project',
    );

    expect(rows.map((row) => row.pid)).toEqual([101, 102]);
    expect(rows[0]!.command).toContain('cartograph admin');
  });
});
