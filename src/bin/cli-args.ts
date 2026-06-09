import { error } from './cli-output.js';
import { parseStrictDecimalInteger, parseStrictDecimalNumber } from '../strict-numeric.js';

/** Optional inclusive numeric bounds for `assignIntArg` / `assignFloatArg`. */
interface NumericArgBounds {
  min?: number;
  max?: number;
}

/**
 * Bundled arguments for `assignIntArg` / `assignFloatArg` — collapses
 * the prior 5 positional params into one object so call sites stay
 * readable and the long_parameter_list biomarker doesn't fire.
 *
 * - `args` — the MCP-arg bag the parsed value is written into on success.
 * - `key` — the property on `args` to set.
 * - `raw` — the raw CLI string; `undefined` / `''` is a no-op success.
 * - `optionName` — the user-facing flag name used in error messages.
 * - `opts` — optional inclusive `min` / `max` range validation.
 */
export interface AssignNumericArgArgs {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: NumericArgBounds;
}

/**
 * Shared body for `assignIntArg` / `assignFloatArg`. Gate-parse-assigns
 * a CLI numeric arg: when `raw` is unset it leaves `args` untouched and
 * returns `true`; when it fails to parse or falls outside the optional
 * `min` / `max` bounds it prints a clean error, sets
 * `process.exitCode = 1`, and returns `false`; otherwise it writes the
 * parsed value to `args[key]` and returns `true`.
 *
 * `schema` supplies the int-vs-float Zod coercion and `noun` is the
 * error wording ("integer" / "number") — the only bits that differ
 * between the two public entry points.
 */
function assignNumericArg(
  { args, key, raw, optionName, opts }: AssignNumericArgArgs,
  parse: (value: string) => number | null,
  noun: string,
): boolean {
  if (raw === undefined || raw === '') return true;
  const n = parse(raw);
  if (n === null) {
    error(`Invalid value for ${optionName}: "${raw}" is not ${noun === 'integer' ? 'an' : 'a'} ${noun}`);
    process.exitCode = 1;
    return false;
  }
  if (opts?.min !== undefined && n < opts.min) {
    error(`Invalid value for ${optionName}: must be >= ${opts.min}`);
    process.exitCode = 1;
    return false;
  }
  if (opts?.max !== undefined && n > opts.max) {
    error(`Invalid value for ${optionName}: must be <= ${opts.max}`);
    process.exitCode = 1;
    return false;
  }
  args[key] = n;
  return true;
}

/**
 * Gate-parse-assign helper for the common "parse a CLI integer and
 * forward it as an MCP arg" pattern. When `raw` is set
 * but is not a valid integer (non-numeric, trailing garbage like
 * `12abc`, or fractional) it prints a clean error, sets
 * `process.exitCode = 1`, and returns `false` — the caller MUST `return` from its action
 * handler. When `raw` is unset it leaves `args` untouched and returns
 * `true`. Centralising this stops `NaN` from leaking into the MCP layer.
 *
 * Pass `opts.min` / `opts.max` for inclusive range validation — an
 * out-of-range value is rejected with the same clean-error contract so
 * negative / zero limits can't silently clamp to 1 downstream.
 */
export function assignIntArg(a: AssignNumericArgArgs): boolean {
  // Reject trailing garbage, decimal fractions, exponent notation, and
  // non-finite input instead of truncating or coercing it.
  return assignNumericArg(a, parseStrictDecimalInteger, 'integer');
}

/**
 * `assignIntArg` sibling for decimal-number CLI options (centrality /
 * score thresholds etc.). Same contract: rejects input that is not a
 * finite number (non-numeric, or trailing garbage like `1.5x`)
 * with a clean error + `process.exitCode = 1` and a `false` return so
 * `NaN` can't leak into the MCP layer. Pass `opts.min` / `opts.max` for
 * inclusive range validation (e.g. `{min: 0, max: 1}` for 0-1 scores).
 */
export function assignFloatArg(a: AssignNumericArgArgs): boolean {
  // Reject trailing garbage, exponent notation, and non-finite input.
  return assignNumericArg(a, parseStrictDecimalNumber, 'number');
}
