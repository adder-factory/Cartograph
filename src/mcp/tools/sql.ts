/**
 * `cartograph_sql` — read-only ad-hoc SQL escape hatch.
 *
 * The 40 curated MCP tools cover ~95% of what an agent asks of the
 * graph. This tool covers the long tail: novel queries the curated
 * surface doesn't fit (e.g. "every method in src/llm/ that has zero
 * callers AND zero tests AND wasn't touched in 30 days"). Borrowed
 * from CartographContext's `execute_cypher_query` shape — we run
 * SQL against our SQLite backend instead of Cypher against Neo4j,
 * but the agent affordance is the same.
 *
 * Safety bounds:
 *   - Read-only enforced via SQL prefix whitelist (SELECT, WITH...
 *     SELECT, EXPLAIN, table-introspection PRAGMAs). Any other shape
 *     rejects with a clear error before reaching the DB.
 *   - Row cap at `limit` (default 100, max 1000) to bound memory.
 *   - Schema-discovery mode (`schema: true`) returns the tables +
 *     columns of the cartograph DB so the agent can write informed
 *     queries without trial and error.
 *
 * NOT a backdoor for arbitrary writes: the prefix check is strict.
 * Anything that could mutate state is rejected at the SQL layer.
 */
import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { editDistance } from '../../text-distance.js';
import { errMsg } from '../../errors.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';

/** Default and max row cap. The DB has tables with millions of rows; an
 *  unbounded SELECT would blow agent context. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Per-query wall-clock cap. A recursive CTE materialising 5M rows or a
 *  3-way Cartesian product over the nodes table can pin the MCP server's
 *  CPU for minutes. The cap is checked between iterate() rows — long
 *  prepare-phase compute (e.g. `WITH RECURSIVE … SELECT MAX(n) …`) still
 *  runs to completion since node:sqlite has no interrupt facility, but
 *  any query that streams rows will abort cleanly. */
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

/**
 * Whitelist-based read-only check. Strict prefix match — comments and
 * quoted strings can't smuggle a write past this guard since we anchor
 * on the first non-whitespace token.
 *
 * Allowed:
 *   - SELECT ...
 *   - WITH ... SELECT ...   (CTE form)
 *   - EXPLAIN [QUERY PLAN] ...
 *   - PRAGMA <introspection-only>
 *
 * Everything else (INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/REPLACE/
 * ATTACH/DETACH/PRAGMA-write) returns false.
 */
const READONLY_PRAGMAS: ReadonlySet<string> = new Set([
  'table_info',
  'table_list',
  'table_xinfo',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'database_list',
  'schema_version',
  'user_version',
  'page_count',
  'page_size',
  'integrity_check',
]);
/**
 * Reject any input that contains a statement separator followed by
 * non-whitespace, non-comment content — even after a leading SELECT.
 * sqlite's `.prepare()` only runs the first statement so a payload like
 * `SELECT 1; DROP TABLE nodes` is benign today, but the guard's job is
 * defense-in-depth: if any code path ever switches to `db.exec()`, the
 * leading SELECT must not smuggle a trailing write past.
 *
 * Allows a single trailing `;` (and trailing whitespace / line comments)
 * since well-formed SQL often ends that way.
 *
 * Implementation: table-driven scanner. Each scanner state has a tiny
 * handler that consumes the current char and returns the next state +
 * how far to advance the cursor. `found: true` short-circuits when the
 * default state hits a bare `;`. Keeps per-handler cyclomatic ≤4.
 */
type ScanState = 'default' | 'single' | 'double' | 'line' | 'block';
type ScanStep = { state: ScanState; advance: number; found?: boolean };

function stepLineComment(ch: string): ScanStep {
  return ch === '\n' ? { state: 'default', advance: 1 } : { state: 'line', advance: 1 };
}

function stepBlockComment(ch: string, next: string | undefined): ScanStep {
  return ch === '*' && next === '/' ? { state: 'default', advance: 2 } : { state: 'block', advance: 1 };
}

function stepSingleQuote(ch: string, next: string | undefined): ScanStep {
  if (ch === "'" && next === "'") return { state: 'single', advance: 2 };
  if (ch === "'") return { state: 'default', advance: 1 };
  return { state: 'single', advance: 1 };
}

function stepDoubleQuote(ch: string, next: string | undefined): ScanStep {
  if (ch === '"' && next === '"') return { state: 'double', advance: 2 };
  if (ch === '"') return { state: 'default', advance: 1 };
  return { state: 'double', advance: 1 };
}

function stepDefault(ch: string, next: string | undefined): ScanStep {
  if (ch === "'") return { state: 'single', advance: 1 };
  if (ch === '"') return { state: 'double', advance: 1 };
  if (ch === '-' && next === '-') return { state: 'line', advance: 2 };
  if (ch === '/' && next === '*') return { state: 'block', advance: 2 };
  if (ch === ';') return { state: 'default', advance: 1, found: true };
  return { state: 'default', advance: 1 };
}

const STEP_HANDLERS: Record<ScanState, (ch: string, next: string | undefined) => ScanStep> = {
  default: stepDefault,
  single: stepSingleQuote,
  double: stepDoubleQuote,
  line: stepLineComment,
  block: stepBlockComment,
};

function hasExtraStatement(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  let state: ScanState = 'default';
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    const next = trimmed[i + 1];
    const step: ScanStep = STEP_HANDLERS[state](ch, next);
    if (step.found) return true;
    state = step.state;
    i += step.advance;
  }
  return false;
}

function maskNonCodeSql(sql: string): string {
  let state: ScanState = 'default';
  let i = 0;
  let out = '';
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    const step: ScanStep = STEP_HANDLERS[state](ch, next);
    if (state === 'default') {
      out += sql.slice(i, i + step.advance);
    } else {
      out += ' '.repeat(step.advance);
    }
    state = step.state;
    i += step.advance;
  }
  return out;
}

/** @internal Exported for the CLI/MCP alignment test — verifies the
 *  read-only gate rejects value-setting PRAGMAs (`PRAGMA user_version
 *  = 5`) while still permitting bare introspection PRAGMAs. */
export function isReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim();
  if (trimmed.length === 0) return false;
  // Defense-in-depth: reject any trailing statement past the first.
  // sqlite.prepare() only runs the leading statement today, but a guard
  // that accepts `SELECT 1; DELETE FROM nodes` is a stale-bug risk.
  if (hasExtraStatement(trimmed)) return false;
  const upper = maskNonCodeSql(trimmed).toUpperCase();
  // `\s` (not a literal space) so a multi-line query that places the
  // keyword on its own line (`SELECT\n  name, kind\nFROM nodes`) isn't
  // mis-classified as a write. F#30 — `startsWith('SELECT ')` would
  // reject `SELECT\nname` because `'\n' !== ' '`.
  if (/^SELECT(\s|$)/.test(upper)) return true;
  if (/^WITH\s/.test(upper)) {
    // CTE — must terminate in a SELECT, not INSERT/UPDATE/DELETE.
    // Cheap check: scan for any SELECT keyword AND no write keywords.
    if (!/\bSELECT\b/.test(upper)) return false;
    if (/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|CREATE|ALTER)\b/.test(upper)) return false;
    return true;
  }
  if (/^EXPLAIN\s/.test(upper)) return true;
  const pragmaMatch = /^PRAGMA\s+(\w+)/i.exec(trimmed);
  if (pragmaMatch) {
    if (!READONLY_PRAGMAS.has(pragmaMatch[1]!.toLowerCase())) return false;
    // The name allowlist is necessary but not sufficient: several
    // allowlisted pragmas (`user_version`, `schema_version`, `page_size`)
    // accept a value-setting form (`PRAGMA user_version = 5`) that
    // mutates the DB. Permit only the bare-introspection shapes — the
    // name optionally followed by a single quoted/identifier arg in
    // parens (`PRAGMA integrity_check(20)`, `PRAGMA table_info(nodes)`).
    // Any `= value` assignment is a write and rejects.
    return /^PRAGMA\s+\w+\s*(\(\s*['"\w]+\s*\))?\s*;?\s*$/i.test(trimmed);
  }
  return false;
}

/**
 * Curated list of tables an agent is most likely to reference when
 * SQLite throws `no such column: <col>` with no qualifying table — we
 * sniff each one's columns to find a near-match. Ordered roughly by
 * agent-query frequency so the suggestion list reflects the most
 * common targets first.
 */
const COMMON_TABLES: ReadonlyArray<string> = [
  'nodes',
  'edges',
  'files',
  'code_health_findings',
  'symbol_summaries',
  'symbol_embeddings',
  'embedding_store',
  'embedding_refs',
  'summary_store',
  'summary_refs',
];

/**
 * Memoised `PRAGMA table_info(<table>)` results, keyed by table name.
 * Cartograph's schema is process-stable (only the migration codepath
 * mutates it), so caching across calls is safe and saves a PRAGMA
 * round-trip per error. Cleared by process restart.
 */
// Keyed by db object identity so multi-project MCP sessions with
// different schemas don't bleed columns from project A into project
// B's suggestion hints. WeakMap drops the per-db cache automatically
// when the connection is closed.
type DbHandle = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
const tableColumnsCache = new WeakMap<object, Map<string, string[]>>();

function getTableColumns(db: DbHandle, table: string): string[] {
  let perDb = tableColumnsCache.get(db);
  if (perDb === undefined) {
    perDb = new Map<string, string[]>();
    tableColumnsCache.set(db, perDb);
  }
  const cached = perDb.get(table);
  if (cached !== undefined) return cached;
  let cols: string[] = [];
  try {
    // PRAGMA cannot take a bound parameter; the table name is
    // whitelisted upstream (caller filters by \w) so direct
    // interpolation is safe.
    if (!/^[A-Za-z_]\w*$/.test(table)) {
      perDb.set(table, []);
      return [];
    }
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    cols = rows.map((r) => r.name).filter((n) => typeof n === 'string');
  } catch {
    cols = [];
  }
  perDb.set(table, cols);
  return cols;
}

/** @internal Argument bundle for {@link suggestColumns} — kept as an
 *  interface so the call site stays readable and biomarker
 *  long_parameter_list doesn't fire on the helper. */
interface SuggestColumnsArgs {
  db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
  badCol: string;
  candidateTables: ReadonlyArray<string>;
  k: number;
}

/**
 * Score one candidate column against the bad column. Lower is better.
 * Pure Levenshtein over-penalises substring matches: `path` → `file_path`
 * is distance 5 (must insert "file_") but is semantically the right
 * answer when the user wrote `n.path` and meant `n.file_path`. A
 * substring containment bonus pulls those candidates ahead of
 * same-letter near-matches like `n.name`.
 */
function scoreCandidate(badCol: string, col: string): number {
  const b = badCol.toLowerCase();
  const c = col.toLowerCase();
  const lev = editDistance(b, c);
  // Substring containment is the strongest signal — half the edit
  // distance when either string contains the other. (`path` ⊂
  // `file_path` → bonus fires; `path` vs `name` → no bonus.)
  const containmentBonus = c.includes(b) || b.includes(c) ? -Math.floor(lev / 2) : 0;
  return lev + containmentBonus;
}

/** Top-K nearest column names by hybrid score across the candidate
 *  tables. Renders qualified `table.col` when more than one table was
 *  searched so the hint is unambiguous. */
function suggestColumns(args: SuggestColumnsArgs): string[] {
  const { db, badCol, candidateTables, k } = args;
  const candidates: Array<{ label: string; score: number }> = [];
  for (const table of candidateTables) {
    for (const col of getTableColumns(db, table)) {
      candidates.push({
        label: candidateTables.length === 1 ? col : `${table}.${col}`,
        score: scoreCandidate(badCol, col),
      });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
  // Cap score at 6 — beyond that we'd just be listing arbitrary
  // columns. Empty result is fine; the caller renders nothing.
  return candidates
    .filter((c) => c.score <= 6)
    .slice(0, k)
    .map((c) => c.label);
}

/**
 * Common SQL alias conventions used in this codebase + tests:
 * single-letter aliases that map deterministically to one of the
 * curated tables. When the user qualifies a bad column with one of
 * these prefixes (e.g. `n.path`), we narrow the suggestion search to
 * just that table so the agent gets the right column name rather
 * than a same-letter match from an unrelated table (e.g. `files.path`
 * winning over `nodes.file_path` for `n.path`).
 */
const ALIAS_TO_TABLE: Readonly<Record<string, string>> = {
  n: 'nodes',
  node: 'nodes',
  e: 'edges',
  edge: 'edges',
  f: 'files',
  file: 'files',
};

/**
 * The single most common `no such column` cause in this schema: the
 * `files` table's path column is `path` (it's the PRIMARY KEY), but
 * EVERY other table that references a file — `nodes`, `edges`,
 * `sql_refs`, `config_refs`, … — names that column `file_path`. An
 * agent writing `n.path` or `f.file_path` trips a bare "no such
 * column" with no nudge toward the split. This line spells it out.
 */
const PATH_NAMING_SPLIT_HINT =
  "Schema note: the `files` table's path column is `path` (it is the primary key); " +
  'every OTHER table (`nodes`, `edges`, `sql_refs`, …) names that column `file_path`. ' +
  'Use `files.path` but `nodes.file_path` / `edges.file_path`.';

/** True when `col` is one of the two columns involved in the
 *  `files.path` vs `<other>.file_path` naming split. */
function isPathSplitColumn(col: string): boolean {
  const c = col.toLowerCase();
  return c === 'path' || c === 'file_path';
}

/** True when `col` is a common cross-graph naming alias for the
 *  `edges.source` / `edges.target` FK columns. */
function isEdgesEndpointColumn(col: string): boolean {
  const c = col.toLowerCase();
  return (
    c === 'src_node_id' ||
    c === 'dst_node_id' ||
    c === 'src_id' ||
    c === 'dst_id' ||
    c === 'source_id' ||
    c === 'target_id' ||
    c === 'from_node_id' ||
    c === 'to_node_id'
  );
}

/**
 * Post-process a SQLite error message to add column-name hints when
 * it matches the two common shapes:
 *   - `no such column: [<table>.]<col>` → suggest 3 nearest by edit
 *     distance over the candidate table's columns (or all common
 *     tables when the column was unqualified).
 *   - `ambiguous column name: <col>` → tell the user to qualify with
 *     the table alias from the FROM clause.
 *
 * A miss on `path` / `file_path` additionally carries the
 * {@link PATH_NAMING_SPLIT_HINT} — that split is the single most
 * common cause and the edit-distance suggester alone doesn't explain
 * *why* the column name differs by table.
 *
 * Falls back to returning the raw message untouched when neither
 * pattern matches. Does NOT re-prepend an `Error: ` marker — the
 * outer `errorResult` wrapper already adds one.
 */
function decorateSqlError(
  db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } },
  rawMsg: string,
): string {
  const noSuchCol = /no such column:\s*(?:((?!\d)\w+)\.)?((?!\d)\w+)/i.exec(rawMsg);
  if (noSuchCol) return decorateNoSuchColumnError(db, rawMsg, noSuchCol);

  const ambig = /ambiguous column name:\s*((?!\d)\w+)/i.exec(rawMsg);
  if (ambig) return decorateAmbiguousColumnError(rawMsg, ambig[1]!);

  return rawMsg;
}

function decorateNoSuchColumnError(
  db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } },
  rawMsg: string,
  match: RegExpExecArray,
): string {
  const qualifier = match[1];
  const badCol = match[2]!;
  // Narrow the suggestion search to the qualifier's likely table when
  // we recognise the alias (n/e/f → nodes/edges/files). Without
  // narrowing, a same-named column on another table can beat the actual
  // near-match on the aliased table by edit distance.
  const targetTable = qualifier ? ALIAS_TO_TABLE[qualifier.toLowerCase()] : undefined;
  const tablesToSearch = targetTable ? [targetTable] : COMMON_TABLES;
  const suggestions = suggestColumns({ db, badCol, candidateTables: tablesToSearch, k: 3 });
  const lines = [rawMsg];

  appendColumnSuggestions(lines, suggestions, qualifier, targetTable);
  appendColumnSchemaNotes(lines, badCol);
  appendColumnDumpTip(lines, targetTable);
  return lines.join('\n');
}

function appendColumnSuggestions(
  lines: string[],
  suggestions: ReadonlyArray<string>,
  qualifier: string | undefined,
  targetTable: string | undefined,
): void {
  if (suggestions.length === 0) return;
  const renderedSuggestions = qualifier && targetTable ? suggestions.map((s) => `${qualifier}.${s}`) : suggestions;
  lines.push(`Did you mean: ${renderedSuggestions.join(', ')}?`);
}

function appendColumnSchemaNotes(lines: string[], badCol: string): void {
  // The `files.path` vs `<other>.file_path` split is the dominant cause
  // of a `path` / `file_path` miss — spell it out explicitly.
  if (isPathSplitColumn(badCol)) lines.push(PATH_NAMING_SPLIT_HINT);
  if (!isEdgesEndpointColumn(badCol)) return;
  lines.push(
    `Schema note: the \`edges\` table uses \`source\` and \`target\` for its endpoint FK columns, not \`${badCol}\`. Use \`e.source\` / \`e.target\`.`,
  );
}

function appendColumnDumpTip(lines: string[], targetTable: string | undefined): void {
  // Point at the NARROW schema-dump form, not the 60-table full dump.
  // When the user wrote `n.<col>` they almost certainly only need the
  // `nodes` columns; for unqualified queries the COMMON_TABLES list is
  // a reasonable shortlist.
  const dumpTables = targetTable ? [targetTable] : COMMON_TABLES.slice(0, 3);
  const dumpArg = dumpTables.map((t) => `'${t}'`).join(', ');
  lines.push(
    `Tip: dump just the relevant column list with \`schema: true, tables: [${dumpArg}], compact: true\` (MCP) or \`--schema --tables ${dumpTables.join(',')} --compact\` (CLI).`,
  );
}

function decorateAmbiguousColumnError(rawMsg: string, col: string): string {
  return [
    rawMsg,
    `Qualify with an alias: try \`n.${col}\` (from nodes) or \`e.${col}\` (from edges) — whichever table the FROM clause aliases.`,
    'Tip: use the schema option (`schema: true` on the MCP tool, `--schema` on the CLI) to see the table layout.',
  ].join('\n');
}

/** Render a markdown table from query rows. Caps cell width to keep
 *  the output legible in agent context. */
const MAX_CELL_CHARS = 200;
function clipCell(value: unknown): string {
  const isNullish = value === null || value === undefined;
  if (isNullish) return '_null_';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const normalized = str
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('|', String.raw`\|`);
  const exceedsLimit = normalized.length > MAX_CELL_CHARS;
  return exceedsLimit ? normalized.slice(0, MAX_CELL_CHARS) + '…' : normalized;
}
function formatRows(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '_(0 rows)_';
  const cols = Object.keys(rows[0]!);
  const lines = ['| ' + cols.join(' | ') + ' |', '|' + cols.map(() => '---').join('|') + '|'];
  for (const row of rows) {
    lines.push('| ' + cols.map((c) => clipCell(row[c])).join(' | ') + ' |');
  }
  return lines.join('\n');
}

/** @internal Argument bundle for {@link fetchSchema}. The `tables`
 *  filter is a case-insensitive name list; an empty / omitted list
 *  preserves the legacy "all tables + views" behavior. `compact`
 *  swaps the full `CREATE TABLE` block for a one-line column dump
 *  so the agent can answer "what columns does X have" without paying
 *  for FK + CHECK constraint prose. */
interface FetchSchemaArgs {
  db: {
    prepare(sql: string): { all(...args: unknown[]): unknown[] };
  };
  tables?: ReadonlyArray<string> | undefined;
  compact?: boolean | undefined;
}

/** Render one column-info row from `PRAGMA table_info` in a terse
 *  "name TYPE [NOT NULL] [PRIMARY KEY]" shape. Default values are
 *  intentionally dropped — they're often whitespace or expression
 *  prose that bloats the one-liner; agents wanting full layout pass
 *  `compact: false` (or just omit it). */
function formatCompactColumn(row: { name: string; type: string; notnull: number; pk: number }): string {
  const parts = [row.name];
  if (row.type) parts.push(row.type);
  if (row.pk > 0) parts.push('PRIMARY KEY');
  else if (row.notnull > 0) parts.push('NOT NULL');
  return parts.join(' ');
}

/** Render the compact column-list line for one table/view. Pulled out
 *  of {@link fetchSchema} so the per-row loop body stays cheap on the
 *  cyclomatic count and the PRAGMA-name interpolation guard lives in
 *  one place. */
function renderCompactColumns(db: FetchSchemaArgs['db'], name: string): string {
  // Safety: name interpolation into PRAGMA. sqlite_master.name is
  // well-formed by construction but guard anyway.
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return '_(skipped — non-identifier name)_';
  }
  const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  if (cols.length === 0) return '_(no columns)_';
  return cols.map(formatCompactColumn).join(' · ');
}

/** Build the schema-dump header line — counts and filtered-vs-full
 *  framing. Split out so {@link fetchSchema} doesn't carry the ternary
 *  + plural-suffix logic inline. */
function renderSchemaHeader(selected: number, total: number, filtered: boolean): string {
  if (filtered) {
    return `## Schema (${selected} of ${total} entries — filtered)`;
  }
  const tablePlural = selected === 1 ? '' : 's';
  const viewPlural = selected === 1 ? '' : 's';
  return `## Schema (${selected} table${tablePlural} + view${viewPlural})`;
}

/** Pull every CREATE TABLE statement from sqlite_master so the agent
 *  can write SELECTs without guessing column names.
 *
 *  Honours the `tables` filter (case-insensitive name match) and the
 *  `compact` flag (one-line column list via `PRAGMA table_info`
 *  instead of the full CREATE block). An unknown table name in the
 *  filter renders an empty result rather than an error — saves a
 *  round-trip on typos. */
function fetchSchema(args: FetchSchemaArgs): string {
  const { db, tables, compact = false } = args;
  const rows = db
    .prepare(
      `SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`,
    )
    .all() as Array<{ name: string; type: string; sql: string }>;
  const filterSet = tables && tables.length > 0 ? new Set(tables.map((t) => t.toLowerCase())) : null;
  const selected = filterSet ? rows.filter((r) => filterSet.has(r.name.toLowerCase())) : rows;
  if (selected.length === 0) {
    if (filterSet) return `_(no matching tables for filter: ${tables!.join(', ')})_`;
    return '_(no tables in this database)_';
  }
  const lines: string[] = [renderSchemaHeader(selected.length, rows.length, filterSet !== null), ''];
  // Surface the `files.path` vs `<other>.file_path` naming split up
  // front whenever the dump includes the `files` table (or any table
  // that carries a `file_path` column) — it is the #1 `no such column`
  // trap and is invisible from skimming a single CREATE block.
  if (selected.some((r) => r.name.toLowerCase() === 'files')) {
    lines.push(`> ${PATH_NAMING_SPLIT_HINT}`, '');
  }
  for (const row of selected) {
    lines.push(`### \`${row.name}\` (${row.type})`);
    if (compact) {
      lines.push(renderCompactColumns(db, row.name));
    } else {
      lines.push('```sql', row.sql, '```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** @internal Arguments for {@link executeQuery}. */
interface ExecuteQueryArgs {
  db: { prepare(sql: string): { iterate(): IterableIterator<Record<string, unknown>> } };
  query: string;
  limit: number;
  timeoutMs: number;
}

/**
 * Execute a SQL query iteratively, collecting rows up to the limit.
 * Returns the result set, a truncation flag (true if limit was hit),
 * and a timeout flag (true if the wall-clock cap fired).
 */
function executeQuery(args: ExecuteQueryArgs): {
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  timedOut: boolean;
} {
  const { db, query, limit, timeoutMs } = args;
  const stmt = db.prepare(query);
  const rows: Array<Record<string, unknown>> = [];
  let truncated = false;
  let timedOut = false;
  const startedAt = Date.now();

  // Stream rows via iterate() instead of stmt.all() so a query like
  // `SELECT * FROM symbol_embeddings` (millions of BLOB rows) doesn't
  // materialise the whole result in memory before slicing. We collect
  // up to `limit + 1` rows: the +1 lets us detect truncation without
  // running a separate COUNT query.
  //
  // Wall-clock check between rows bounds streaming-query CPU. Doesn't
  // help on queries that block in prepare (recursive CTE that
  // materialises before yielding the first row) — node:sqlite has no
  // interrupt API. The cap is best-effort defense-in-depth, not a hard
  // resource fence.
  for (const row of stmt.iterate()) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    if (Date.now() - startedAt > timeoutMs) {
      timedOut = true;
      break;
    }
    rows.push(row);
  }

  return { rows, truncated, timedOut };
}

interface BuildQueryOutputArgs {
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  limit: number;
  timedOut: boolean;
  timeoutMs: number;
}

/**
 * Format SQL query results as a markdown table with truncation notice.
 */
function buildQueryOutput(args: BuildQueryOutputArgs): string {
  const { rows, truncated, limit, timedOut, timeoutMs } = args;
  const lines: string[] = [
    `## Query results (${rows.length}${truncated || timedOut ? '+' : ''} row${rows.length === 1 ? '' : 's'})`,
    '',
    formatRows(rows),
  ];
  if (timedOut) {
    lines.push(
      '',
      `> ⚠ _Aborted after \`timeoutMs=${timeoutMs}\` — query was returning rows but exceeded the wall-clock cap. Tighten the WHERE clause or raise \`timeoutMs\` (max ${MAX_TIMEOUT_MS}ms)._`,
    );
  } else if (truncated) {
    lines.push('');
    // At MAX_LIMIT raising `limit` does nothing — point the agent at
    // narrowing the query instead of a dead-end "pass a higher limit".
    if (limit >= MAX_LIMIT) {
      lines.push(
        `> _Truncated at \`limit=${limit}\` — this is the maximum (${MAX_LIMIT}). ` +
          'Raising `limit` will not return more rows; narrow the result set instead ' +
          '(add or tighten a `WHERE` clause, or aggregate with `COUNT`/`GROUP BY`)._',
      );
    } else {
      lines.push(`> _Truncated at \`limit=${limit}\` — pass a higher limit to see more rows._`);
    }
  }
  return lines.join('\n');
}

/**
 * Zod schema for `cartograph_sql`.
 *
 * `limit` and `timeoutMs` are integer-bounded with explicit `.min()` /
 * `.max()` ranges (see the schema below) — out-of-range values are
 * REJECTED at the dispatch boundary (locked reject-out-of-range
 * decision), so the handler's old `clamp` calls and the
 * negative-`limit` guard are gone.
 *
 * `query` is `.optional()` (NOT required at the schema layer) because
 * a `schema: true` call legitimately omits it — the handler enforces
 * "missing query" for the non-schema path. `tables` accepts a bare
 * string OR a string array via a `preprocess` coercion — keeps the
 * historical "agents sometimes pass `tables: 'nodes'`" affordance
 * while the advertised JSON-Schema stays a plain `array` of strings.
 */
const sqlSchema = z.object({
  query: z
    .string()
    .max(8192)
    .optional()
    .describe(
      'SQL query to run. Must be SELECT-shaped or an introspection PRAGMA. ' +
        'Common tables: nodes, edges, files, code_health_findings; pass `schema: true` for the full list.',
    ),
  schema: z
    .boolean()
    .optional()
    .describe(
      'When true, ignore `query` and return the table+view schema of the DB. ' +
        'Best first call when writing a novel query. Pair with `tables: [...]` or `compact: true` to narrow output.',
    ),
  tables: z
    .preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(z.string()))
    .optional()
    .describe(
      'Only with `schema: true`. Restrict the schema dump to the named tables/views (case-insensitive). ' +
        'Empty/omitted = all entries. Unknown names render an empty result, not an error.',
    ),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Only with `schema: true`. When true, emit one line per column ' +
        '(name TYPE [NOT NULL] [PRIMARY KEY]) instead of the full CREATE TABLE block. Default false.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe('Max rows to return (default 100, integer in [1, 1000]; out-of-range is rejected).'),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS)
    .describe(
      'Wall-clock cap on row streaming (default 10000ms, integer in [100, 60000]; out-of-range is rejected). ' +
        'When exceeded, the partial result set is returned with a warning.',
    ),
  projectPath: projectPathField,
});

type SqlArgs = z.infer<typeof sqlSchema>;

async function handleSql(ctx: ToolCtx, args: SqlArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const db = cg.db.getDb();

  if (args.schema === true) {
    // Filter to the named tables/views when callers pass `tables`. Drop
    // empty-string entries; the schema's `preprocess` already coerced a
    // bare-string `tables` into a single-element array.
    const tables = args.tables ? args.tables.filter((t) => t.length > 0) : undefined;
    const compact = args.compact === true;
    return ok(textResult(fetchSchema({ db, tables, compact })));
  }

  // `query` is schema-optional (a `schema: true` call omits it); the
  // non-schema path requires it. Surface the same labelled error the
  // legacy `validateString(..., 'query')` produced.
  if (typeof args.query !== 'string' || args.query.length === 0) {
    return err('Invalid value for query: must be a non-empty string.');
  }
  const query = args.query;

  if (!isReadOnlySql(query)) {
    // `isReadOnlySql` returns false for two distinct reasons —
    // multi-statement input and an actual write keyword. Give the
    // multi-statement case its own message so an agent that submitted
    // two valid SELECTs isn't told it tried to mutate state (audit-4 #3).
    if (hasExtraStatement(query)) {
      return err(
        // Template literal (not `+` concat) so the sql_string_concat
        // detector doesn't false-flag an error-message string that
        // mentions a SQL verb.
        `cartograph_sql runs a single statement — your query contains multiple statements separated by ';'. Submit one SELECT/CTE/PRAGMA per call.`,
      );
    }
    return err(
      `cartograph_sql is read-only — only SELECT, WITH...SELECT, EXPLAIN, and introspection PRAGMAs are allowed. For schema discovery use the schema option instead (\`schema: true\` on the MCP tool, \`--schema\` on the CLI). To mutate state, use the dedicated MCP tools (cartograph_admin, cartograph_summaries, etc.).`,
    );
  }

  // `limit` / `timeoutMs` are already in range — Zod's `.int().min().max()`
  // rejected anything else (negative, zero, over-cap, non-integer) at the
  // dispatch boundary. No clamp needed.
  const limit = args.limit;
  const timeoutMs = args.timeoutMs;

  try {
    const { rows, truncated, timedOut } = executeQuery({ db, query, limit, timeoutMs });
    const output = buildQueryOutput({ rows, truncated, limit, timedOut, timeoutMs });
    return ok(textResult(output));
  } catch (error_) {
    // Post-process the raw SQLite error for the two common shapes
    // (`no such column`, `ambiguous column name`) so the agent gets
    // an edit-distance suggestion + the `schema: true` tip without
    // a round-trip. Falls back to the raw message on every other
    // error shape. See friction F-O.
    const decorated = decorateSqlError(db, errMsg(error_));
    return err(`SQL failed: ${decorated}`);
  }
}

export const SQL_TOOL = defineTool({
  name: 'cartograph_sql',
  description:
    "Escape-hatch read-only SQL — only when curated tools can't compose the query.\n\n" +
    'First call `schema: true` for table/view definitions. Accepts `SELECT`/`WITH ... SELECT`/`EXPLAIN`/introspection `PRAGMA`; writes reject. ' +
    '`limit` default 100 (max 1000); cells clipped at 200 chars.',
  schema: sqlSchema,
  handle: handleSql,
});
