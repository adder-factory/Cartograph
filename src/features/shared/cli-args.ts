export function parseOptionalPositiveInt(
  raw: string | undefined,
  optionName: string,
  error: (message: string) => void,
): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    error(`${optionName} must be a positive integer`);
    process.exitCode = 1;
    return null;
  }
  return n;
}

export type PositiveIntParseResult = { ok: true; value: number } | { ok: false; error: string };

export interface IntegerValueBounds {
  min?: number;
  max?: number;
}

export function parseIntegerValue(
  raw: string,
  optionName: string,
  bounds: IntegerValueBounds = {},
): PositiveIntParseResult {
  const n = Number(raw);
  if (!Number.isInteger(n) || !Number.isFinite(n)) {
    return { ok: false, error: `Invalid value for ${optionName}: "${raw}" is not an integer` };
  }
  if (bounds.min !== undefined && n < bounds.min) {
    return { ok: false, error: `Invalid value for ${optionName}: must be >= ${bounds.min}` };
  }
  if (bounds.max !== undefined && n > bounds.max) {
    return { ok: false, error: `Invalid value for ${optionName}: must be <= ${bounds.max}` };
  }
  return { ok: true, value: n };
}

export function parsePositiveIntValue(raw: string, optionName: string): PositiveIntParseResult {
  return parseIntegerValue(raw, optionName, { min: 1 });
}
