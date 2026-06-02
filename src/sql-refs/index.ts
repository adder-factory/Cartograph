/**
 * SQL call-site extraction
 *
 * Scans indexed source files for SQL string-literal patterns (FROM,
 * JOIN, INTO, UPDATE, DELETE FROM, CREATE TABLE) and records each
 * (table, op) pair as a row in `sql_refs`. Each row links to its
 * enclosing function via line-range lookup against the existing
 * nodes table, so an agent asking "what code touches the users
 * table?" gets a list of real functions, not a grep wall.
 *
 * Why a separate table, not graph nodes/edges: tables aren't
 * declared in code that the existing extractors parse — they live
 * in `.sql` migration files. Once #95 (SQL language extractor)
 * merges, `table_name` can be joined against indexed SQL DDL nodes
 * for cross-language navigation. This PR ships the call-site
 * detection now so the agent-useful queries already work; full
 * graph integration follows when the prerequisite lands.
 *
 * Spike validation (cartograph indexing itself): 87 SQL call sites
 * across the 8 tables defined in `src/db/schema.sql`, each
 * attributed to its enclosing QueryBuilder method. Beats grep
 * because grep matches `const nodes = ...` (a JS variable named
 * `nodes`) too — this regex requires the SQL keyword prefix
 * (FROM/INTO/UPDATE/JOIN), eliminating that class of false positive.
 *
 * V1 scope: table-level only. Column extraction (`SELECT email FROM
 * users` → `users.email`) is best-effort and deferred until #95
 * provides reliable column-name DDL nodes to join against.
 */

import { computeAlgoHash } from '../algo-hash.js';
import { makeRefMiner } from '../shared-miner.js';

/**
 * SQL-refs mining algorithm version. The hook stamps this onto
 * project_metadata; a stored value other than the current one triggers
 * a one-shot full re-mine on the next `afterSync` so persisted
 * `sql_refs` rows self-heal after a mining-logic change — no
 * `cartograph index` needed.
 *
 * Derived from a sha256 of this file's source via `computeAlgoHash`
 * (comment-strip + whitespace-normalise, so JSDoc / reformat-only edits
 * don't invalidate). Editing the mining logic below changes the hash
 * automatically.
 */
export const SQL_REFS_ALGO_VERSION = computeAlgoHash(import.meta.url, ['./index']);

/** Project-metadata key holding the algo version of the last mining run. */
export const LAST_MINED_SQL_REFS_ALGO_VERSION_KEY = 'last_mined_sql_refs_algo_version';

type SqlOp = 'read' | 'write' | 'ddl';

interface SqlRef {
  tableName: string;
  op: SqlOp;
  /** Indexed-symbol id for the enclosing function/method. NULL = top-level. */
  sourceNodeId: string | null;
  filePath: string;
  line: number;
}

/**
 * Languages we scan. Anything not in this set is skipped — most
 * non-source files have no SQL to find. SQL files themselves are
 * skipped here because #95 will own DDL extraction.
 */
const SUPPORTED_LANGUAGES = new Set<string>([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'csharp',
  'php',
  'ruby',
]);

/**
 * SQL identifier regex. Allows simple unquoted identifiers and
 * double-quoted (Postgres) or backtick-quoted (MySQL) identifiers,
 * with optional schema-qualifier prefix (`public.users`,
 * `"public"."users"`). For v1 we record only the *table* part —
 * schema goes into a future column when we have join targets.
 */
const IDENT = '(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][\\w]*))';

interface PatternDef {
  /** Capture group containing the table name (1, 2, or 3 in IDENT). */
  re: RegExp;
  op: SqlOp;
}

/**
 * SQL keyword + identifier patterns. `i` flag makes them case-
 * insensitive; `g` is required for `exec` loops to advance through
 * multiple matches per line.
 *
 * Each regex captures the table name in groups 1/2/3 (backtick /
 * double-quote / unquoted) — at most one is set per match.
 */
const PATTERNS: PatternDef[] = [
  // SELECT ... FROM <table>
  // FROM appears in SELECT and DELETE statements; we tag it 'read' here
  // and let DELETE's own regex below tag it 'write'. Last write wins
  // because Map dedup is keyed by (table, op), so the DELETE one
  // produces a separate write row alongside this read row.
  { re: new RegExp(String.raw`\bFROM\s+(?:[A-Za-z_]\w*\s*\.\s*)?${IDENT}`, 'gi'), op: 'read' },
  { re: new RegExp(String.raw`\bJOIN\s+(?:[A-Za-z_]\w*\s*\.\s*)?${IDENT}`, 'gi'), op: 'read' },
  // INSERT INTO <table>
  { re: new RegExp(String.raw`\bINSERT\s+INTO\s+(?:[A-Za-z_]\w*\s*\.\s*)?${IDENT}`, 'gi'), op: 'write' },
  // UPDATE <table> ... SET
  { re: new RegExp(String.raw`\bUPDATE\s+(?:[A-Za-z_]\w*\s*\.\s*)?${IDENT}\s+SET\b`, 'gi'), op: 'write' },
  // DELETE FROM <table>
  { re: new RegExp(String.raw`\bDELETE\s+FROM\s+(?:[A-Za-z_]\w*\s*\.\s*)?${IDENT}`, 'gi'), op: 'write' },
  // CREATE TABLE [IF NOT EXISTS] <table>
  {
    re: new RegExp(
      String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z_]\w*\s*\.\s*)?${IDENT}`,
      'gi',
    ),
    op: 'ddl',
  },
  // ALTER TABLE / DROP TABLE
  { re: new RegExp(String.raw`\bALTER\s+TABLE\s+(?:[A-Za-z_]\w*\s*\.\s*)?${IDENT}`, 'gi'), op: 'ddl' },
  {
    re: new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:[A-Za-z_]\w*\s*\.\s*)?${IDENT}`, 'gi'),
    op: 'ddl',
  },
];

/**
 * Identifier names we drop because they're SQL keywords or noise
 * that the regex over-matches on:
 *   - `WHERE` / `ON` / `GROUP` after `JOIN` (chained JOIN clauses)
 *   - `AS`/`USING` aliasing
 *   - `SELECT` / `INTO` (CTE-shaped or `SELECT ... INTO`)
 */
const RESERVED_TABLE_NAMES = new Set<string>([
  // SQL keywords (real reserved words)
  'where',
  'on',
  'group',
  'order',
  'limit',
  'using',
  'as',
  'select',
  'into',
  'values',
  'set',
  'and',
  'or',
  'not',
  'null',
  'true',
  'false',
  // Common English words that survive the SQL-verb pre-filter when
  // a sentence happens to contain a verb-like token. Stress test
  // caught `from the list` in a code comment slipping through because
  // "drop" appeared in "drop docs/config". These can never be real
  // table names in production code, so reject early.
  'a',
  'an',
  'the',
  'of',
  'to',
  'in',
  'is',
  'it',
  'for',
  'this',
  'that',
  'these',
  'those',
  'with',
  'by',
  'at',
]);

/**
 * Resolver supplied by caller: (filePath, line) → enclosing nodeId.
 * Returns null when the read is at the file's top level.
 */
type EnclosingNodeResolver = (filePath: string, line: number) => string | null;

interface FileTarget {
  path: string;
  language: string;
}

/**
 * Pre-filter: line (with comments stripped) must contain a quote
 * (so it's plausibly a string literal) AND a SQL verb. Anchoring on
 * a verb is critical — without it, prose like
 *   const note = "get the value from the array";
 * pollutes results because `from the` matches our `FROM <table>`
 * regex. Requiring `SELECT|INSERT|UPDATE|...` on the same line
 * filters those out.
 */
function lineLooksLikeSql(line: string): boolean {
  if (!/['"`]/.test(line)) return false;
  return /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(line);
}

/**
 * Sanity check: the captured `FROM <table>` (or similar) should be
 * inside a string literal, not in a comment. Approximated by
 * requiring a quote (`'`, `"`, `` ` ``) somewhere before the match
 * position on the same line. Doesn't handle multi-line template
 * literals where the open-quote is on a previous line — that's a v1
 * acceptable miss.
 */
function isInsideString(line: string, matchIndex: number): boolean {
  const prefix = line.slice(0, matchIndex);
  return /['"`]/.test(prefix);
}

/**
 * Pull the table name out of a regex match. Exactly one of the
 * three identifier capture groups is set per IDENT alternation.
 */
function extractTableName(m: RegExpExecArray): string | null {
  const name = m[1] ?? m[2] ?? m[3];
  if (!name) return null;
  if (RESERVED_TABLE_NAMES.has(name.toLowerCase())) return null;
  // Reject JS template-literal interpolation placeholders captured as
  // double-quoted "identifiers". A migration's dynamic SQL like:
  //   db.exec(`INSERT INTO ${tempName} … FROM "${table.name}"`)
  // lets the double-quote IDENT branch match `${table.name}` verbatim.
  // Real SQL identifiers (even quoted ones) never contain `${`.
  if (name.includes('${')) return null;
  return name;
}

/**
 * Scan a list of (path, language) targets and return all SQL refs
 * found. Pure I/O + regex; the caller owns DB writes via
 * `applySqlRefs`. The shared scan loop lives in `makeRefMiner`.
 */
export const extractSqlRefs = makeRefMiner<SqlRef>({
  extractorName: 'extractSqlRefs',
  isLanguageSupported: (lang) => SUPPORTED_LANGUAGES.has(lang),
  lineMatches: lineLooksLikeSql,
  collectRefsForLine: collectRefsForSqlLine,
});

/**
 * Per-line ref collection: walk every regex pattern, dedup (table, op)
 * pairs within the line so overlapping FROM/JOIN matches against the
 * same table don't double-record. Pulled out of {@link extractSqlRefs}
 * so the inner per-line/per-pattern/while/if-string-check chain
 * doesn't sit 5-deep under the outer file/line loops.
 */
interface CollectSqlLineArgs {
  refs: SqlRef[];
  line: string;
  lineNo: number;
  target: FileTarget;
  resolveEnclosing: EnclosingNodeResolver;
}

function collectRefsForSqlLine(args: CollectSqlLineArgs): void {
  const { refs, line, lineNo, target, resolveEnclosing } = args;
  const seen = new Set<string>();
  for (const pat of PATTERNS) {
    pat.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.re.exec(line)) !== null) {
      if (!isInsideString(line, m.index)) continue;
      const name = extractTableName(m);
      if (!name) continue;
      const key = `${name.toLowerCase()}|${pat.op}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        tableName: name,
        op: pat.op,
        sourceNodeId: resolveEnclosing(target.path, lineNo),
        filePath: target.path,
        line: lineNo,
      });
    }
  }
}
