/**
 * Tests for `parseContentLength` in src/installer/install-models.ts.
 *
 * It parses the HTTP `content-length` response header — which Node may hand
 * back as a string, a string[] (repeated header), or undefined — into a
 * trustworthy byte count. Every branch is a guard against a malformed or
 * hostile header silently corrupting the download size check, so each test
 * pins a distinct rejection/acceptance path rather than the happy case alone.
 */

import { describe, it, expect } from 'vitest';
import { parseContentLength } from '../src/installer/install-models.js';

describe('parseContentLength', () => {
  it('parses a plain numeric string', () => {
    expect(parseContentLength('1024')).toBe(1024);
    expect(parseContentLength('0')).toBe(0);
  });

  it('uses the first element when the header arrives as an array', () => {
    // Node surfaces repeated headers as string[]; only the first counts.
    expect(parseContentLength(['2048', '4096'])).toBe(2048);
  });

  it('returns null for an empty array (no first element)', () => {
    // value[0] is undefined → recursion hits the undefined guard.
    expect(parseContentLength([])).toBeNull();
  });

  it('returns null when the header is absent', () => {
    expect(parseContentLength(undefined)).toBeNull();
  });

  it('rejects anything that is not a run of digits', () => {
    expect(parseContentLength('12.5')).toBeNull(); // decimal point
    expect(parseContentLength('-5')).toBeNull(); // sign
    expect(parseContentLength('0x10')).toBeNull(); // hex prefix
    expect(parseContentLength(' 12')).toBeNull(); // leading whitespace
    expect(parseContentLength('12 ')).toBeNull(); // trailing whitespace
    expect(parseContentLength('12kb')).toBeNull(); // unit suffix
    expect(parseContentLength('')).toBeNull(); // empty string
  });

  it('rejects a digit string beyond the safe-integer range', () => {
    // The isSafeInteger guard stops a giant content-length from rounding to a
    // wrong, lower value once coerced to a float.
    expect(parseContentLength('99999999999999999999')).toBeNull();
  });
});
