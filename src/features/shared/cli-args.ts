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

export function parsePositiveIntValue(raw: string, optionName: string): PositiveIntParseResult {
  const n = Number(raw);
  if (!Number.isInteger(n) || !Number.isFinite(n)) {
    return { ok: false, error: `Invalid value for ${optionName}: "${raw}" is not an integer` };
  }
  if (n < 1) return { ok: false, error: `Invalid value for ${optionName}: must be >= 1` };
  return { ok: true, value: n };
}
