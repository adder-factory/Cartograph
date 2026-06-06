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
