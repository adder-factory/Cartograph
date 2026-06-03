/**
 * Tests for `errMsg` and `logWarn` in src/errors.ts.
 *
 * `errMsg` — coerce an unknown caught value to a string message.
 * `logWarn` — forward a warning to the active logger.
 *
 * Both are 0%-covered; these tests exercise every branch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CartographError,
  ConfigError,
  DatabaseError,
  defaultLogger,
  errMsg,
  FileError,
  getLogger,
  logDebug,
  logWarn,
  ParseError,
  SearchError,
  setLogger,
  silentLogger,
  VectorError,
} from '../src/errors.js';

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

describe('Cartograph error classes', () => {
  it('captures base error code and context', () => {
    const error = new CartographError('base failure', 'BASE', { key: 'value' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CartographError');
    expect(error.message).toBe('base failure');
    expect(error.code).toBe('BASE');
    expect(error.context).toEqual({ key: 'value' });
  });

  it('records file, parse, database, search, and vector causes', () => {
    const cause = new Error('root cause');
    const file = new FileError('file failed', 'src/a.ts', cause);
    const parse = new ParseError('parse failed', 'src/a.ts', { line: 3, column: 7, cause });
    const db = new DatabaseError('db failed', 'insert', cause);
    const search = new SearchError('search failed', 'alpha', cause);
    const vector = new VectorError('vector failed', 'embed', cause);

    expect(file).toMatchObject({
      name: 'FileError',
      code: 'FILE_ERROR',
      filePath: 'src/a.ts',
      cause,
      context: { filePath: 'src/a.ts', cause: 'root cause' },
    });
    expect(parse).toMatchObject({
      name: 'ParseError',
      code: 'PARSE_ERROR',
      filePath: 'src/a.ts',
      line: 3,
      column: 7,
      cause,
      context: { filePath: 'src/a.ts', line: 3, column: 7, cause: 'root cause' },
    });
    expect(db).toMatchObject({
      name: 'DatabaseError',
      code: 'DATABASE_ERROR',
      operation: 'insert',
      cause,
      context: { operation: 'insert', cause: 'root cause' },
    });
    expect(search).toMatchObject({
      name: 'SearchError',
      code: 'SEARCH_ERROR',
      query: 'alpha',
      cause,
      context: { query: 'alpha', cause: 'root cause' },
    });
    expect(vector).toMatchObject({
      name: 'VectorError',
      code: 'VECTOR_ERROR',
      cause,
      context: { operation: 'embed', cause: 'root cause' },
    });
  });

  it('leaves optional parse fields and causes unset when omitted', () => {
    const parse = new ParseError('parse failed', 'src/a.ts');
    const file = new FileError('file failed', 'src/a.ts');

    expect(parse.line).toBeUndefined();
    expect(parse.column).toBeUndefined();
    expect(parse.cause).toBeUndefined();
    expect(file.cause).toBeUndefined();
  });

  it('records config details directly as context', () => {
    const error = new ConfigError('bad config', { field: 'llm.endpoint' });

    expect(error.name).toBe('ConfigError');
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.context).toEqual({ field: 'llm.endpoint' });
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

  it('getLogger returns the active logger and logDebug delegates through it', () => {
    const debug = vi.fn();
    const logger = { ...silentLogger, debug };
    setLogger(logger);

    expect(getLogger()).toBe(logger);
    logDebug('debug message', { id: 1 });

    expect(debug).toHaveBeenCalledWith('debug message', { id: 1 });
  });

  it('default logger writes warn and error messages, and debug only when enabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const oldDebug = process.env['CARTOGRAPH_DEBUG'];

    defaultLogger.warn('warned');
    defaultLogger.error('errored', { code: 1 });
    defaultLogger.debug('hidden');
    process.env['CARTOGRAPH_DEBUG'] = '1';
    defaultLogger.debug('shown', { code: 2 });

    expect(warn).toHaveBeenCalledWith('[Cartograph] warned', '');
    expect(error).toHaveBeenCalledWith('[Cartograph] errored', { code: 1 });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('[Cartograph] shown', { code: 2 });

    try {
      // Assertions above need the mock histories intact.
    } finally {
      if (oldDebug === undefined) {
        delete process.env['CARTOGRAPH_DEBUG'];
      } else {
        process.env['CARTOGRAPH_DEBUG'] = oldDebug;
      }
      warn.mockRestore();
      error.mockRestore();
      debug.mockRestore();
    }
  });
});
