/**
 * Tests for `errMsg` and `logWarn` in src/errors.ts.
 *
 * `errMsg` — coerce an unknown caught value to a string message.
 * `logWarn` — forward a warning to the active logger.
 *
 * Both are 0%-covered; these tests exercise every branch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { errMsg, logWarn, setLogger, defaultLogger, silentLogger } from '../src/errors.js';

// ── errMsg ────────────────────────────────────────────────────────────────────

describe('errMsg', () => {
  it('returns err.message when given an Error instance', () => {
    const e = new Error('something went wrong');
    expect(errMsg(e)).toBe('something went wrong');
  });

  it('returns String(err) when given a plain string', () => {
    expect(errMsg('raw string error')).toBe('raw string error');
  });

  it('returns String(err) when given a number', () => {
    expect(errMsg(42)).toBe('42');
  });

  it('returns String(err) when given null', () => {
    expect(errMsg(null)).toBe('null');
  });

  it('returns String(err) when given undefined', () => {
    expect(errMsg(undefined)).toBe('undefined');
  });

  it('returns String(err) when given a plain object', () => {
    const obj = { code: 404 };
    expect(errMsg(obj)).toBe('[object Object]');
  });

  it('uses err.message (not String(err)) for Error subclasses', () => {
    class CustomError extends Error {
      constructor() {
        super('custom subclass message');
        this.name = 'CustomError';
      }
    }
    const e = new CustomError();
    // instanceof Error → branches to .message
    expect(errMsg(e)).toBe('custom subclass message');
    // Double-check it does NOT return the stringified form
    expect(errMsg(e)).not.toContain('CustomError:');
  });
});

// ── logWarn ───────────────────────────────────────────────────────────────────

describe('logWarn', () => {
  afterEach(() => {
    // Restore the default logger so other tests aren't affected.
    setLogger(defaultLogger);
  });

  it('invokes the active logger.warn with message and context', () => {
    const mockWarn = vi.fn();
    setLogger({ ...silentLogger, warn: mockWarn });

    logWarn('disk quota exceeded', { path: '/tmp/foo' });

    expect(mockWarn).toHaveBeenCalledOnce();
    expect(mockWarn).toHaveBeenCalledWith('disk quota exceeded', { path: '/tmp/foo' });
  });

  it('invokes logger.warn with just message when context is omitted', () => {
    const mockWarn = vi.fn();
    setLogger({ ...silentLogger, warn: mockWarn });

    logWarn('something went wrong');

    expect(mockWarn).toHaveBeenCalledOnce();
    expect(mockWarn).toHaveBeenCalledWith('something went wrong', undefined);
  });

  it('delegates to whichever logger is currently active (swappable)', () => {
    const first = vi.fn();
    const second = vi.fn();

    setLogger({ ...silentLogger, warn: first });
    logWarn('first-logger message');
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();

    setLogger({ ...silentLogger, warn: second });
    logWarn('second-logger message');
    expect(second).toHaveBeenCalledOnce();
    // first still called only once
    expect(first).toHaveBeenCalledTimes(1);
  });
});
