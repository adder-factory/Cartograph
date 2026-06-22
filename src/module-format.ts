/**
 * Module-format detection for `cartograph_status`.
 *
 * Reads `package.json#type` and `tsconfig.json#compilerOptions.module`
 * /`target` to answer "what does this project compile to?" — useful
 * upfront context for the agent, especially during migration work
 * (gap #3 in cartograph-tooling-gaps.md).
 *
 * Pure: no DB, no graph, no async beyond fs. Returns null when
 * neither file exists; partial info when only one does.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

type Format = 'ESM' | 'CJS' | 'mixed' | 'unknown';

interface ModuleFormatInfo {
  format: Format;
  /** Verbatim `compilerOptions.target` (e.g. "ES2022"). */
  tsTarget?: string;
  /** Verbatim `compilerOptions.module` (e.g. "NodeNext", "CommonJS"). */
  tsModule?: string;
  /** Verbatim `package.json#type` ("module" | "commonjs"). */
  pkgType?: string;
}

const packageManifestSchema = z.looseObject({
  type: z.string().optional(),
});

const tsCompilerOptionsSchema = z.looseObject({
  target: z.string().optional(),
  module: z.string().optional(),
});

const tsConfigSchema = z.looseObject({
  compilerOptions: tsCompilerOptionsSchema.optional(),
});

type PackageManifest = z.infer<typeof packageManifestSchema>;
type TsConfig = z.infer<typeof tsConfigSchema>;

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Handle a character inside a JSON string (between quotes).
 * Returns [bytesConsumed, charToOutput | null].
 */
function handleStringChar(json: string, i: number, stringQuote: string): [number, string, boolean] {
  const ch = json[i]!;
  const next = json[i + 1];

  // Handle escape sequence
  if (ch === '\\' && next !== undefined) {
    return [2, ch + next, true];
  }

  // Check for end of string
  if (ch === stringQuote) {
    return [1, ch, false];
  }

  return [1, ch, true];
}

/**
 * Skip over a comment (// or /\* \*\/) starting at position i.
 * Returns the position to continue from.
 */
function skipComment(json: string, i: number): number {
  const next = json[i + 1];
  if (next === '/') {
    // Single-line comment — skip to end of line.
    const eol = json.indexOf('\n', i + 2);
    return eol === -1 ? json.length : eol;
  }
  if (next === '*') {
    // Block comment — skip to terminator.
    const blockEnd = '*/';
    const end = json.indexOf(blockEnd, i + 2);
    return end === -1 ? json.length : end + 2;
  }
  return i;
}

/**
 * Strip JSONC comments while respecting string boundaries. Naive
 * regex strips like `/(^|[^:])\/\//` corrupt URL values
 * (`"baseUrl": "https://example"` becomes `"baseUrl": "https:`)
 * because the lookbehind only sees one char. This walks the input
 * once tracking whether we're inside a string.
 */
function stripJsonc(json: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringQuote = '';

  while (i < json.length) {
    const ch = json[i];
    const next = json[i + 1];

    if (inString) {
      const [consumed, output, stillInString] = handleStringChar(json, i, stringQuote);
      out += output;
      inString = stillInString;
      i += consumed;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && (next === '/' || next === '*')) {
      i = skipComment(json, i);
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function safeParse<T>(json: string | null, schema: z.ZodType<T>): T | null {
  if (json == null) return null;
  const direct = tryParseJson(json, schema);
  if (direct !== null) return direct;
  // tsconfig.json may have JSONC comments — strip and retry.
  return tryParseJson(stripJsonc(json), schema);
}

/** Parse JSON returning `null` instead of throwing on syntax error.
 *  Pulled out so {@link safeParse}'s retry chain is two sequential
 *  calls instead of try-inside-catch nesting. */
function tryParseJson<T>(json: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed: unknown = JSON.parse(json);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Heuristic: does this `compilerOptions.module` value emit ESM?
 * Conservative — unknown values fall through to undefined.
 */
function tsModuleFormat(mod: string | undefined): Format | undefined {
  if (!mod) return undefined;
  const v = mod.toLowerCase();
  if (v === 'commonjs' || v === 'node') return 'CJS';
  if (v === 'nodenext' || v === 'node16' || v === 'esnext' || v.startsWith('es20') || v === 'es6' || v === 'es2015') {
    return 'ESM';
  }
  return undefined;
}

/** Convert `package.json#type` to our Format tag. */
function pkgTypeToFormat(pkgType: string | undefined): Format | undefined {
  if (pkgType === 'module') return 'ESM';
  if (pkgType === 'commonjs') return 'CJS';
  return undefined;
}

/** Pick the final Format given the two candidate signals. Conflict
 *  between package.json and tsconfig is rare but possible — call it
 *  `mixed` so the agent sees the divergence instead of trusting one
 *  side blindly. */
function pickFormat(pkgFmt: Format | undefined, tscFmt: Format | undefined): Format {
  if (pkgFmt && tscFmt) return pkgFmt === tscFmt ? pkgFmt : 'mixed';
  return pkgFmt ?? tscFmt ?? 'unknown';
}

export function detectModuleFormat(rootDir: string): ModuleFormatInfo | null {
  const pkg: PackageManifest | null = safeParse(safeRead(path.join(rootDir, 'package.json')), packageManifestSchema);
  const tsc: TsConfig | null = safeParse(safeRead(path.join(rootDir, 'tsconfig.json')), tsConfigSchema);
  if (!pkg && !tsc) return null;

  const pkgType = pkg?.type;
  const tsTarget = tsc?.compilerOptions?.target;
  const tsModule = tsc?.compilerOptions?.module;

  const format = pickFormat(pkgTypeToFormat(pkgType), tsModuleFormat(tsModule));

  const out: ModuleFormatInfo = { format };
  if (tsTarget) out.tsTarget = tsTarget;
  if (tsModule) out.tsModule = tsModule;
  if (pkgType) out.pkgType = pkgType;
  return out;
}

/**
 * Render the detection output as a status line. Returns null when
 * there's nothing useful to report (no package.json / no tsconfig).
 */
export function formatModuleFormatLine(info: ModuleFormatInfo | null): string | null {
  if (!info) return null;
  const detail: string[] = [];
  if (info.tsModule) detail.push(info.tsModule);
  if (info.tsTarget) detail.push(info.tsTarget);
  const suffix = detail.length > 0 ? ` (${detail.join(', ')})` : '';
  return `**Module format:** ${info.format}${suffix}`;
}
