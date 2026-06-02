export function isSqliteTableOptionSuffix(suffix: string): boolean {
  const trimmed = trimSqliteSuffixPadding(suffix).toUpperCase();
  return (
    trimmed === '' ||
    trimmed === 'STRICT' ||
    trimmed === 'WITHOUT ROWID' ||
    trimmed === 'STRICT, WITHOUT ROWID' ||
    trimmed === 'WITHOUT ROWID, STRICT'
  );
}

export function trimSqliteSuffixPadding(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isSqliteSuffixPadding(value.charAt(start))) start++;
  while (end > start && isSqliteSuffixPadding(value.charAt(end - 1))) end--;
  return value.slice(start, end);
}

function isSqliteSuffixPadding(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ';';
}
