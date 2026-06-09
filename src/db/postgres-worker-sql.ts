export const SQL_IDENTIFIER_PATTERN = String.raw`(?:[A-Za-z]|_)[\w.]*`;

const SQL_KEY_EXPRESSION_PATTERN = String.raw`(?:${SQL_IDENTIFIER_PATTERN}|\$\d+)`;

export function rewritePostgresAfterPlaceholders(sqlText: string, jsonEachPositions: ReadonlySet<number>): string {
  let text = sqlText;
  text = text.replaceAll(/(\$\d+)\s+IS\s+NULL/gi, (_match, placeholder: string) => {
    return `${placeholder}${nullCheckCast(placeholder, jsonEachPositions)} IS NULL`;
  });
  text = text.replaceAll(/(\$\d+)\s+IS\s+NOT\s+NULL/gi, (_match, placeholder: string) => {
    return `${placeholder}${nullCheckCast(placeholder, jsonEachPositions)} IS NOT NULL`;
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

function nullCheckCast(placeholder: string, jsonEachPositions: ReadonlySet<number>): string {
  const position = Number(placeholder.slice(1));
  return jsonEachPositions.has(position) ? '::jsonb' : '::text';
}
