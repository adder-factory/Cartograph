import type { ZodError, ZodType } from 'zod';

/**
 * Cartograph Error Classes
 *
 * Custom error types for better error handling and debugging.
 *
 * @module errors
 *
 * @example
 * ```typescript
 * import { FileError, ParseError, setLogger, silentLogger } from 'cartograph';
 *
 * // Catch specific error types
 * try {
 *   await cg.indexAll();
 * } catch (error) {
 *   if (error instanceof FileError) {
 *     console.log(`File error at ${error.filePath}: ${error.message}`);
 *   } else if (error instanceof ParseError) {
 *     console.log(`Parse error at ${error.filePath}:${error.line}`);
 *   }
 * }
 *
 * // Disable logging for tests
 * setLogger(silentLogger);
 * ```
 */

/**
 * Base error class for all Cartograph errors.
 *
 * All Cartograph-specific errors extend this class, allowing you to catch
 * all Cartograph errors with a single catch block.
 *
 * @example
 * ```typescript
 * try {
 *   await cg.indexAll();
 * } catch (error) {
 *   if (error instanceof CartographError) {
 *     console.log(`Cartograph error [${error.code}]: ${error.message}`);
 *   }
 * }
 * ```
 */

/**
 * Coerce an unknown caught value into a string message.
 *
 * The pattern `err instanceof Error ? err.message : String(err)`
 * appeared 50+ times across the codebase. Centralised here so the
 * coercion is consistent (and changing it — e.g., to include the
 * cause chain — only takes one edit).
 */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Format Zod issues as stable one-line `path: message` fragments for
 * non-interactive boundaries such as worker IPC. MCP tools use their
 * richer argument-aware formatter; worker contracts need only the
 * schema path and Zod's issue message.
 */
export function formatZodIssues(error: ZodError): string {
  return error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join('; ');
}

/**
 * Parse a non-interactive Zod boundary and throw a stable single-line
 * validation error. Worker IPC contracts use this so all raw process
 * messages fail with the same issue formatting.
 */
export function parseZodBoundary<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label}: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '<root>';
  return path.map(String).join('.');
}

/**
 * Run `fn`, returning its result, or `undefined` if it throws. The
 * best-effort "swallow the error" helper used by the status / readiness
 * lenses, where a missing optional signal must degrade to an empty state
 * rather than fail the whole call. Centralised so the viewer's system
 * payload and the MCP status tool share one definition.
 */
export function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export class CartographError extends Error {
  /** Error code for categorization (e.g., 'FILE_ERROR', 'PARSE_ERROR') */
  readonly code: string;
  /** Additional context about the error */
  readonly context?: Record<string, unknown> | undefined;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'CartographError';
    this.code = code;
    this.context = context;

    // Maintain proper stack trace for V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error reading or accessing files
 */
export class FileError extends CartographError {
  readonly filePath: string;

  constructor(message: string, filePath: string, cause?: Error) {
    super(message, 'FILE_ERROR', { filePath, cause: cause?.message });
    this.name = 'FileError';
    this.filePath = filePath;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error parsing source code
 */
export class ParseError extends CartographError {
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;

  constructor(message: string, filePath: string, options?: { line?: number; column?: number; cause?: Error }) {
    super(message, 'PARSE_ERROR', {
      filePath,
      line: options?.line,
      column: options?.column,
      cause: options?.cause?.message,
    });
    this.name = 'ParseError';
    this.filePath = filePath;
    if (options?.line !== undefined) this.line = options.line;
    if (options?.column !== undefined) this.column = options.column;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Error with database operations
 */
export class DatabaseError extends CartographError {
  readonly operation: string;

  constructor(message: string, operation: string, cause?: Error) {
    super(message, 'DATABASE_ERROR', { operation, cause: cause?.message });
    this.name = 'DatabaseError';
    this.operation = operation;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error with search operations
 */
export class SearchError extends CartographError {
  readonly query: string;

  constructor(message: string, query: string, cause?: Error) {
    super(message, 'SEARCH_ERROR', { query, cause: cause?.message });
    this.name = 'SearchError';
    this.query = query;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error with vector/embedding operations
 */
export class VectorError extends CartographError {
  constructor(message: string, operation: string, cause?: Error) {
    super(message, 'VECTOR_ERROR', { operation, cause: cause?.message });
    this.name = 'VectorError';
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error with configuration
 */
export class ConfigError extends CartographError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigError';
  }
}

/**
 * Simple logger for Cartograph operations
 *
 * By default, logs to console.warn for warnings and console.error for errors.
 * Can be configured to use custom logging.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console-based logger
 */
export const defaultLogger: Logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (process.env['CARTOGRAPH_DEBUG']) {
      console.debug(`[Cartograph] ${message}`, context ?? '');
    }
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[Cartograph] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[Cartograph] ${message}`, context ?? '');
  },
};

/**
 * Silent logger (no output) - useful for tests
 */
export const silentLogger: Logger = {
  debug(): void {},
  warn(): void {},
  error(): void {},
};

/**
 * Current logger instance (can be replaced)
 */
let currentLogger: Logger = defaultLogger;

/**
 * Set the global logger
 */
export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

/**
 * Get the current logger
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * Log a debug message
 */
export function logDebug(message: string, context?: Record<string, unknown>): void {
  currentLogger.debug(message, context);
}

/**
 * Log a warning message
 */
export function logWarn(message: string, context?: Record<string, unknown>): void {
  currentLogger.warn(message, context);
}
