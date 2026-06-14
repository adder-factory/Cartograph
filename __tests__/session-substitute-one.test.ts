/**
 * Tests for `substituteOne` in src/mcp/tools/session.ts.
 *
 * Recursively substitutes `${i}` positional macros into session command
 * args. Two string modes matter:
 *   - whole-value `${i}`  → the raw positional arg (TYPE-PRESERVING: a
 *     number stays a number, an object stays an object).
 *   - embedded `${i}`     → text interpolation via stringifyMacroReplacement
 *     (objects become JSON, etc.).
 * An out-of-range index leaves the placeholder untouched in both modes.
 * Non-strings recurse through arrays/objects and otherwise pass through.
 */

import { describe, it, expect } from 'vitest';
import { substituteOne } from '../src/mcp/tools/session.js';

describe('substituteOne', () => {
  it('preserves the raw type for a whole-value placeholder', () => {
    expect(substituteOne('${0}', [42])).toBe(42);
    expect(substituteOne('${0}', [true])).toBe(true);
    const obj = { a: 1 };
    expect(substituteOne('${0}', [obj])).toBe(obj); // same reference, not stringified
  });

  it('leaves a whole-value placeholder untouched when the index is out of range', () => {
    expect(substituteOne('${5}', [])).toBe('${5}');
  });

  it('interpolates embedded placeholders as text', () => {
    expect(substituteOne('id-${0}', [42])).toBe('id-42');
    expect(substituteOne('${0}/${1}', [{ a: 1 }, 'x'])).toBe('{"a":1}/x');
  });

  it('handles multi-digit placeholder indices in both modes', () => {
    // Guards the `\d+` quantifier in BOTH substitution regexes — a single-digit
    // `\d` would fail to match `${10}`. Whole-value still type-preserves (raw
    // object), embedded still stringifies.
    const whole = Array(11).fill('x');
    whole[10] = { n: 1 };
    expect(substituteOne('${10}', whole)).toBe(whole[10]);
    const embedded = Array(11).fill('z');
    embedded[10] = 'v';
    expect(substituteOne('a${10}b', embedded)).toBe('avb');
  });

  it('keeps embedded placeholders with out-of-range indices literal', () => {
    expect(substituteOne('pre-${9}-post', [])).toBe('pre-${9}-post');
  });

  it('recurses through arrays and objects', () => {
    expect(substituteOne(['${0}', 'lit'], [7])).toEqual([7, 'lit']);
    expect(substituteOne({ k: '${0}' }, ['v'])).toEqual({ k: 'v' });
    expect(substituteOne({ arr: ['${0}'] }, [1])).toEqual({ arr: [1] });
  });

  it('passes non-string primitives through unchanged', () => {
    expect(substituteOne(42, ['x'])).toBe(42);
    expect(substituteOne(true, ['x'])).toBe(true);
    expect(substituteOne(null, ['x'])).toBeNull();
  });
});
