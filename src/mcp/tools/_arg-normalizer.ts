/**
 * Shared argument normalization for MCP and generated CLI tool calls.
 *
 * The source-specific layers still collect raw arguments:
 * - MCP receives a plain JSON object from `tools/call`.
 * - The generated CLI collects Commander flags / positionals first.
 *
 * Once those raw keys exist, both surfaces need the same core steps:
 * schema validation, default application, and unknown-argument warnings
 * where a JSON-schema surface exists. Keep this module Commander-free so
 * MCP dispatch can use it without importing CLI code.
 */
import type { z } from 'zod';
import type { ToolDefinition } from '../tool-types.js';
import type { ToolModule } from './types.js';
import { collectUnknownArgWarnings } from './_unknown-arg-warnings.js';
import { formatZodError, getZodSchema, type ToolZodSchema } from './_define-tool.js';

export type NormalizedToolArgs =
  | {
      readonly ok: true;
      readonly data: Record<string, unknown>;
      readonly warnings: string[];
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly zodError?: z.ZodError;
      readonly warnings: string[];
    };

export interface NormalizeArgsOptions {
  /** Raw args after the caller-specific collection phase. */
  readonly rawArgs: Record<string, unknown>;
  /** Zod schema used for validation and default application. */
  readonly schema?: ToolZodSchema;
  /** JSON schema used only for unknown-argument warnings. */
  readonly inputSchema?: ToolDefinition['inputSchema'];
  /** Disable warnings for surfaces that reject unknown args earlier. */
  readonly warnUnknownArgs?: boolean;
  /** Override error formatting for a non-MCP caller. */
  readonly formatError?: (error: z.ZodError, rawArgs: Record<string, unknown>) => string;
}

export function normalizeArgs(options: NormalizeArgsOptions): NormalizedToolArgs {
  const rawArgs = options.rawArgs ?? {};
  if (options.schema) {
    const parsed = options.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        error: (options.formatError ?? formatZodError)(parsed.error, rawArgs),
        zodError: parsed.error,
        warnings: [],
      };
    }
    const warnings = collectWarnings(options, rawArgs);
    return { ok: true, data: parsed.data, warnings };
  }

  const warnings = collectWarnings(options, rawArgs);
  return { ok: true, data: rawArgs, warnings };
}

export function normalizeToolArgs(mod: ToolModule, rawArgs: Record<string, unknown>): NormalizedToolArgs {
  const schema = getZodSchema(mod);
  return normalizeArgs({
    rawArgs,
    ...(schema ? { schema } : {}),
    inputSchema: mod.definition.inputSchema,
    warnUnknownArgs: true,
  });
}

function collectWarnings(options: NormalizeArgsOptions, rawArgs: Record<string, unknown>): string[] {
  if (options.warnUnknownArgs === false || !options.inputSchema) return [];
  return collectUnknownArgWarnings(rawArgs, options.inputSchema);
}
