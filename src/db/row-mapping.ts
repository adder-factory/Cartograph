/**
 * Declarative snake_case-row → camelCase-domain mapping, shared by the
 * hand-written per-table row mappers so each table's field list stays
 * a table instead of N structurally-identical literal builders.
 *
 * Rows are zod-validated before they reach a mapper (typed-query),
 * so the loose cast here does not weaken runtime guarantees.
 */
export function mapRowFields<Row extends object, Out>(
  row: Row,
  fields: ReadonlyArray<readonly [keyof Row & string, keyof Out & string]>,
): Out {
  const out: Record<string, unknown> = {};
  for (const [from, to] of fields) out[to] = (row as Record<string, unknown>)[from];
  return out as Out;
}
