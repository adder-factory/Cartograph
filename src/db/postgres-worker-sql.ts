export const SQL_IDENTIFIER_PATTERN = String.raw`(?:[A-Za-z]|_)[\w.]*`;

const SQL_KEY_EXPRESSION_PATTERN = String.raw`(?:${SQL_IDENTIFIER_PATTERN}|\$\d+)`;

export function rewritePostgresAfterPlaceholders(sqlText: string, jsonEachPositions: ReadonlySet<number>): string {
  let text = sqlText;
  const numericParams = placeholdersInNumericComparison(sqlText);
  text = text.replaceAll(/(\$\d+)\s+IS\s+NULL/gi, (_match, placeholder: string) => {
    return `${placeholder}${nullCheckCast(placeholder, jsonEachPositions, numericParams)} IS NULL`;
  });
  text = text.replaceAll(/(\$\d+)\s+IS\s+NOT\s+NULL/gi, (_match, placeholder: string) => {
    return `${placeholder}${nullCheckCast(placeholder, jsonEachPositions, numericParams)} IS NOT NULL`;
  });
  text = text.replaceAll(
    /SELECT\s+value\s+FROM\s+json_each\((\$\d+)\)/gi,
    (_match, placeholder: string) => `SELECT jsonb_array_elements_text(${placeholder}::jsonb)`,
  );
  text = text.replaceAll(
    new RegExp(
      String.raw`SELECT\s+CAST\(value\s+AS\s+INTEGER\)\s+FROM\s+json_each\((\$\d+)\)\s+WHERE\s+key\s*=\s*(${SQL_KEY_EXPRESSION_PATTERN})`,
      'gi',
    ),
    (_match, placeholder: string, keyExpression: string) =>
      `SELECT value::integer FROM jsonb_each_text(${placeholder}::jsonb) AS j(key, value) WHERE key = ${keyExpression}`,
  );
  return text;
}

/**
 * Positions of `$N` placeholders used in an ORDERING comparison
 * (`col >= $N`, `$N < col`, …). The optional-filter sentinel
 * `(@p IS NULL OR ts >= @p)` produces the same placeholder in both an
 * `IS NULL` test and a `>=` comparison; the cast on the `IS NULL`
 * occurrence sets the WHOLE param's type, so it must match the
 * comparison column (numeric) or the comparison breaks
 * ("operator does not exist: double precision >= text").
 */
function placeholdersInNumericComparison(sqlText: string): Set<number> {
  const numeric = new Set<number>();
  for (const m of sqlText.matchAll(/(?:[<>]=?\s*\$(\d+))|(?:\$(\d+)\s*[<>]=?)/g)) {
    const captured = m[1] ?? m[2];
    if (captured !== undefined) numeric.add(Number(captured));
  }
  return numeric;
}

function nullCheckCast(
  placeholder: string,
  jsonEachPositions: ReadonlySet<number>,
  numericParams: ReadonlySet<number>,
): string {
  const position = Number(placeholder.slice(1));
  // The cast on a `$N IS NULL` occurrence sets the param's type globally,
  // so it must match how $N is used in any sibling comparison: json_each
  // params are jsonb; `col </> $N` ordering params are numeric; everything
  // else (equality / IS-NULL-only) defaults to text.
  if (jsonEachPositions.has(position)) return '::jsonb';
  if (numericParams.has(position)) return '::double precision';
  return '::text';
}

/**
 * Byte spans `[start, endExclusive)` of single-quoted string literals in
 * `sqlText`, quotes included. Postgres escapes an embedded quote by
 * doubling it (`''`), which stays inside the same literal. Used to keep
 * the SQLite→Postgres rewrites (placeholder substitution, LIKE→ILIKE)
 * from mutating text that merely LOOKS like a token inside a literal.
 */
export function stringLiteralSpans(sqlText: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const n = sqlText.length;
  let i = 0;
  while (i < n) {
    if (sqlText[i] !== "'") {
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < n) {
      if (sqlText[i] === "'") {
        if (sqlText[i + 1] === "'") {
          i += 2;
          continue;
        }
        i++;
        break;
      }
      i++;
    }
    spans.push([start, i]);
  }
  return spans;
}

/** True when `offset` falls inside one of the `[start, end)` literal spans. */
export function offsetInsideLiteral(offset: number, spans: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [start, end] of spans) {
    if (offset < start) return false;
    if (offset < end) return true;
  }
  return false;
}

/**
 * Rewrite plain `LIKE` to `ILIKE` (outside string literals) so a Postgres
 * substring / path filter is case-insensitive, matching SQLite's default
 * ASCII-case-insensitive `LIKE`. Without this, the same search or
 * `pathFilter` query returns different rows per backend. `\bLIKE\b`
 * cannot match inside an already-rewritten `ILIKE` (the preceding `I` is
 * a word char), so this is safe to run after the COLLATE-NOCASE rewrite
 * and is idempotent.
 */
export function rewritePlainLikeToILike(sqlText: string): string {
  const spans = stringLiteralSpans(sqlText);
  return sqlText.replaceAll(/\bLIKE\b/gi, (match: string, offset: number) =>
    offsetInsideLiteral(offset, spans) ? match : 'ILIKE',
  );
}
