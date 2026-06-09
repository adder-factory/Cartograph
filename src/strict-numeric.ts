const SIGNED_DECIMAL_INTEGER_RE = /^[+-]?\d+$/u;
const UNSIGNED_DECIMAL_INTEGER_RE = /^\d+$/u;
const SIGNED_DECIMAL_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const NON_NEGATIVE_DECIMAL_NUMBER_RE = /^\+?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const OCTAL_INTEGER_RE = /^[0-7]+$/u;
const OCTAL_DIGITS = '01234567';

export function parseStrictDecimalInteger(raw: string): number | null {
  if (!SIGNED_DECIMAL_INTEGER_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseStrictUnsignedDecimalInteger(raw: string): number | null {
  if (!UNSIGNED_DECIMAL_INTEGER_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseStrictDecimalNumber(raw: string): number | null {
  if (!SIGNED_DECIMAL_NUMBER_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseStrictNonNegativeDecimalNumber(raw: string): number | null {
  if (!NON_NEGATIVE_DECIMAL_NUMBER_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseStrictOctalInteger(raw: string): number | null {
  if (!OCTAL_INTEGER_RE.test(raw)) return null;
  let n = 0;
  for (const ch of raw) {
    n = n * OCTAL_DIGITS.length + OCTAL_DIGITS.indexOf(ch);
    if (!Number.isSafeInteger(n)) return null;
  }
  return n;
}
