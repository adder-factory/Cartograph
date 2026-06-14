/**
 * Tests for the strict numeric parsers in src/strict-numeric.ts.
 *
 * These exist because `Number(x)` is far too lenient for parsing
 * untrusted config / CLI / env strings — it accepts "0x10", "1e3", "  5 ",
 * "Infinity", "" (→ 0), etc. Each parser pairs a strict regex with a
 * range guard (safe-integer or finite). The tests pin the accept set, the
 * reject set (the leniency `Number` would wrongly allow), and the overflow
 * guard for every function — uniform coverage of the whole module.
 */

import { describe, it, expect } from 'vitest';
import {
  parseStrictDecimalInteger,
  parseStrictUnsignedDecimalInteger,
  parseStrictDecimalNumber,
  parseStrictNonNegativeDecimalNumber,
  parseStrictOctalInteger,
} from '../src/strict-numeric.js';

describe('parseStrictDecimalInteger', () => {
  it('accepts signed and unsigned decimal integers', () => {
    expect(parseStrictDecimalInteger('42')).toBe(42);
    expect(parseStrictDecimalInteger('+42')).toBe(42);
    expect(parseStrictDecimalInteger('-42')).toBe(-42);
    expect(parseStrictDecimalInteger('0')).toBe(0);
  });

  it('rejects the leniency Number() would allow', () => {
    for (const bad of ['4.5', '1e3', '0x10', '', ' 5', '5 ', 'abc', '+', '-', 'Infinity']) {
      expect(parseStrictDecimalInteger(bad)).toBeNull();
    }
  });

  it('rejects integers beyond the safe-integer range', () => {
    expect(parseStrictDecimalInteger('99999999999999999999')).toBeNull();
  });
});

describe('parseStrictUnsignedDecimalInteger', () => {
  it('accepts unsigned decimal integers', () => {
    expect(parseStrictUnsignedDecimalInteger('42')).toBe(42);
    expect(parseStrictUnsignedDecimalInteger('0')).toBe(0);
  });

  it('rejects signs, decimals, and junk', () => {
    for (const bad of ['+42', '-42', '4.5', '0x10', '', 'abc']) {
      expect(parseStrictUnsignedDecimalInteger(bad)).toBeNull();
    }
  });

  it('rejects values beyond the safe-integer range', () => {
    expect(parseStrictUnsignedDecimalInteger('99999999999999999999')).toBeNull();
  });
});

describe('parseStrictDecimalNumber', () => {
  it('accepts signed decimals including bare leading/trailing dot forms', () => {
    expect(parseStrictDecimalNumber('42')).toBe(42);
    expect(parseStrictDecimalNumber('+1.5')).toBe(1.5);
    expect(parseStrictDecimalNumber('-0.5')).toBe(-0.5);
    expect(parseStrictDecimalNumber('.5')).toBe(0.5);
    expect(parseStrictDecimalNumber('5.')).toBe(5);
  });

  it('rejects exponents, lone dots, and junk', () => {
    for (const bad of ['1e3', '.', '', '+', '1.2.3', 'abc', ' 1']) {
      expect(parseStrictDecimalNumber(bad)).toBeNull();
    }
  });

  it('rejects a magnitude that overflows to Infinity', () => {
    expect(parseStrictDecimalNumber(`${'9'.repeat(400)}`)).toBeNull();
  });
});

describe('parseStrictNonNegativeDecimalNumber', () => {
  it('accepts non-negative decimals (optional leading +)', () => {
    expect(parseStrictNonNegativeDecimalNumber('42')).toBe(42);
    expect(parseStrictNonNegativeDecimalNumber('+1.5')).toBe(1.5);
    expect(parseStrictNonNegativeDecimalNumber('.5')).toBe(0.5);
    expect(parseStrictNonNegativeDecimalNumber('0')).toBe(0);
  });

  it('rejects negatives, exponents, and junk', () => {
    for (const bad of ['-1', '-0.5', '1e3', '.', '', 'abc']) {
      expect(parseStrictNonNegativeDecimalNumber(bad)).toBeNull();
    }
  });

  it('rejects a magnitude that overflows to Infinity', () => {
    expect(parseStrictNonNegativeDecimalNumber(`${'9'.repeat(400)}`)).toBeNull();
  });
});

describe('parseStrictOctalInteger', () => {
  it('parses octal digit strings to their decimal value', () => {
    expect(parseStrictOctalInteger('0')).toBe(0);
    expect(parseStrictOctalInteger('7')).toBe(7);
    expect(parseStrictOctalInteger('10')).toBe(8);
    expect(parseStrictOctalInteger('17')).toBe(15);
    expect(parseStrictOctalInteger('777')).toBe(511);
  });

  it('rejects non-octal digits and junk', () => {
    for (const bad of ['8', '9', '0x10', '-1', '1.5', '', 'abc']) {
      expect(parseStrictOctalInteger(bad)).toBeNull();
    }
  });

  it('rejects an octal string that overflows the safe-integer range mid-accumulation', () => {
    expect(parseStrictOctalInteger('7'.repeat(20))).toBeNull();
  });
});
