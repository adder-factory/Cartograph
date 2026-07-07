import { workerData } from 'node:worker_threads';
import {
  parsePostgresWorkerInit,
  parsePostgresWorkerJson,
  parseWorkerRequest,
  type WorkerRequest,
} from './postgres-codec.js';
import {
  SQL_IDENTIFIER_PATTERN,
  dedupePostgresRecordsetRows,
  offsetInsideLiteral,
  rewritePlainLikeToILike,
  rewritePostgresAfterPlaceholders,
  sanitizePostgresJsonValue,
  stringLiteralSpans,
} from './postgres-worker-sql.js';

const WORKER_READY = 10;
const WORKER_REQUEST = 1;
const WORKER_RESPONSE = 2;
const SAFE_IDENTIFIER_PATTERN = String.raw`(?:[A-Za-z]|_)\w*`;
const SAFE_IDENTIFIER_RE = /^(?:[A-Za-z]|_)\w*$/;
const SQL_PARAMETER_PATTERN = String.raw`[@:$]?(?:[A-Za-z]|_)\w*|\?`;

type QueryRequest = Extract<WorkerRequest, { op: 'query' }>;

const NODE_BATCH_INSERT_SQL = `
  INSERT INTO nodes (
    id, kind, name, qualified_name, file_path, language,
    start_line, end_line, start_column, end_column,
    docstring, signature, visibility,
    is_exported, is_default_export, is_async, is_static,
    decorators, decorator_args, updated_at,
    centrality, betweenness, body_hash, name_subwords
  )
  SELECT
    id, kind, name, qualified_name, file_path, language,
    start_line, end_line, start_column, end_column,
    docstring, signature, visibility,
    is_exported, is_default_export, is_async, is_static,
    decorators, decorator_args, updated_at,
    centrality, betweenness, body_hash, name_subwords
  FROM jsonb_to_recordset($1::jsonb) AS r(
    id text,
    kind text,
    name text,
    qualified_name text,
    file_path text,
    language text,
    start_line integer,
    end_line integer,
    start_column integer,
    end_column integer,
    docstring text,
    signature text,
    visibility text,
    is_exported integer,
    is_default_export integer,
    is_async integer,
    is_static integer,
    decorators text,
    decorator_args text,
    updated_at double precision,
    centrality real,
    betweenness real,
    body_hash text,
    name_subwords text
  )
  ON CONFLICT(id) DO UPDATE SET
    kind = EXCLUDED.kind,
    name = EXCLUDED.name,
    qualified_name = EXCLUDED.qualified_name,
    file_path = EXCLUDED.file_path,
    language = EXCLUDED.language,
    start_line = EXCLUDED.start_line,
    end_line = EXCLUDED.end_line,
    start_column = EXCLUDED.start_column,
    end_column = EXCLUDED.end_column,
    docstring = EXCLUDED.docstring,
    signature = EXCLUDED.signature,
    visibility = EXCLUDED.visibility,
    is_exported = EXCLUDED.is_exported,
    is_default_export = EXCLUDED.is_default_export,
    is_async = EXCLUDED.is_async,
    is_static = EXCLUDED.is_static,
    decorators = EXCLUDED.decorators,
    decorator_args = EXCLUDED.decorator_args,
    updated_at = EXCLUDED.updated_at,
    centrality = EXCLUDED.centrality,
    betweenness = EXCLUDED.betweenness,
    body_hash = EXCLUDED.body_hash,
    name_subwords = EXCLUDED.name_subwords
`;

const EDGE_BATCH_INSERT_SQL = `
  INSERT INTO edges (source, target, kind, metadata, line, col, confidence)
  SELECT source, target, kind, metadata, line, col, confidence
  FROM jsonb_to_recordset($1::jsonb) AS r(
    source text,
    target text,
    kind text,
    metadata text,
    line integer,
    col integer,
    confidence text
  )
  ON CONFLICT DO NOTHING
`;

const init = parsePostgresWorkerInit(workerData, 'init');
const control = new Int32Array(init.control);
const sql = new Bun.SQL(init.sqlOptions);
const schemaName = assertSafeIdentifier(init.schema || 'public');

const CANONICAL_ROW_KEYS: Record<string, string> = {
  bodyhash: 'bodyHash',
  commitcount: 'commitCount',
  commitsha: 'commitSha',
  commitshas: 'commitShas',
  configkey: 'configKey',
  containerid: 'containerId',
  containerkind: 'containerKind',
  containername: 'containerName',
  cooccurrences: 'coOccurrences',
  coveragepct: 'coveragePct',
  currentversionrows: 'currentVersionRows',
  decoratorargs: 'decoratorArgs',
  distinctfiles: 'distinctFiles',
  endcol: 'endCol',
  endline: 'endLine',
  externaldependents: 'externalDependents',
  fieldclassid: 'fieldClassId',
  fieldid: 'fieldId',
  filecentrality: 'fileCentrality',
  filepath: 'filePath',
  foreignaccesses: 'foreignAccesses',
  fromnodeid: 'fromNodeId',
  hitcount: 'hitCount',
  importerfilepath: 'importerFilePath',
  isdefaultexport: 'isDefaultExport',
  issuenumber: 'issueNumber',
  lastindexedat: 'lastIndexedAt',
  lasthitat: 'lastHitAt',
  lasttouchedts: 'lastTouchedTs',
  matchcount: 'matchCount',
  membercount: 'memberCount',
  methoddecoratorargs: 'methodDecoratorArgs',
  methoddecorators: 'methodDecorators',
  methodfilepath: 'methodFilePath',
  methodid: 'methodId',
  methodname: 'methodName',
  methodstartline: 'methodStartLine',
  modulename: 'moduleName',
  newestenqueuedat: 'newestEnqueuedAt',
  nodeid: 'nodeId',
  oldestenqueuedat: 'oldestEnqueuedAt',
  ownaccesses: 'ownAccesses',
  parentname: 'parentName',
  parentnodeid: 'parentNodeId',
  promotednodeid: 'promotedNodeId',
  qualifiedname: 'qualifiedName',
  referencekind: 'referenceKind',
  referencename: 'referenceName',
  riskscore: 'riskScore',
  seenat: 'seenAt',
  sizebytes: 'sizeBytes',
  sourcekind: 'sourceKind',
  sourcename: 'sourceName',
  sourcenodeid: 'sourceNodeId',
  srcclassid: 'srcClassId',
  srcfile: 'srcFile',
  srcid: 'srcId',
  srcname: 'srcName',
  startcol: 'startCol',
  startline: 'startLine',
  tablename: 'tableName',
};

await bootstrap();
Atomics.store(control, 0, WORKER_READY);
Atomics.notify(control, 0);

for (;;) {
  while (Atomics.load(control, 0) !== WORKER_REQUEST) {
    Atomics.wait(control, 0, Atomics.load(control, 0));
  }
  const request = parseWorkerRequest(
    decodeValue(parsePostgresWorkerJson(await Bun.file(init.requestPath).text(), 'request')),
    'request',
  );
  const response = await handleRequest(request);
  await Bun.write(init.responsePath, JSON.stringify(encodeValue(response)));
  Atomics.store(control, 0, WORKER_RESPONSE);
  Atomics.notify(control, 0);
  if (request.op === 'close') break;
}

async function bootstrap(): Promise<void> {
  const schema = quoteIdent(schemaName);
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`).simple();
  await sql.unsafe(`SET search_path TO ${schema}, public`).simple();
}

async function handleRequest(request: WorkerRequest): Promise<Record<string, unknown>> {
  try {
    return await handleRequestBody(request);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleRequestBody(request: WorkerRequest): Promise<Record<string, unknown>> {
  if (request.op === 'close') {
    await sql.close();
    return { ok: true };
  }
  if (request.op === 'pragma') {
    return { ok: true, value: await pragmaValue(request.pragma ?? '') };
  }
  if (request.op === 'exec') return await handleExecRequest(request.sql ?? '');
  if (request.op === 'batch') return await handleBatchRun(request.sql ?? '', request.paramSets ?? []);
  if (isPragmaStatement(request.sql ?? '')) return await handlePragmaQuery(request);
  return await handleTranslatedQuery(request);
}

async function handleExecRequest(inputSql: string): Promise<Record<string, unknown>> {
  const statement = rewriteSql(inputSql);
  if (isNoopStatement(statement)) return { ok: true };
  await sql.unsafe(statement).simple();
  return { ok: true };
}

async function handlePragmaQuery(request: QueryRequest): Promise<Record<string, unknown>> {
  const dataRows = await pragmaRows(request.sql ?? '');
  if (request.mode === 'run') return { ok: true, rows: dataRows, changes: 0, lastInsertRowid: 0 };
  if (request.mode === 'get') return { ok: true, rows: dataRows.slice(0, 1) };
  return { ok: true, rows: dataRows };
}

async function handleTranslatedQuery(request: QueryRequest): Promise<Record<string, unknown>> {
  const translated = translateQuery(request.sql ?? '', request.params ?? []);
  const rows = await sql.unsafe(translated.sql, translated.params);
  const dataRows = Array.from(rows as unknown[]).map(normalizeRow);
  if (request.mode === 'run') {
    return {
      ok: true,
      rows: dataRows,
      changes: numericMeta(rows, 'count') ?? dataRows.length,
      lastInsertRowid: inferLastInsertRowid(dataRows),
    };
  }
  if (request.mode === 'get') return { ok: true, rows: dataRows.slice(0, 1) };
  return { ok: true, rows: dataRows };
}

async function handleBatchRun(inputSql: string, paramSets: unknown[][]): Promise<Record<string, unknown>> {
  const native = await handleNativeBatchRun(inputSql, paramSets);
  if (native !== null) return native;

  let changes = 0;
  let lastInsertRowid = 0;
  let index = 0;
  while (index < paramSets.length) {
    const params = paramSets[index] ?? [];
    const translated = translateQuery(inputSql, params);
    const rows = await sql.unsafe(translated.sql, translated.params);
    const dataRows = Array.from(rows as unknown[]).map(normalizeRow);
    changes += numericMeta(rows, 'count') ?? dataRows.length;
    lastInsertRowid = inferLastInsertRowid(dataRows) || lastInsertRowid;
    index++;
  }
  return { ok: true, changes, lastInsertRowid };
}

async function handleNativeBatchRun(inputSql: string, paramSets: unknown[][]): Promise<Record<string, unknown> | null> {
  if (paramSets.length === 0) return { ok: true, changes: 0, lastInsertRowid: 0 };
  const namedRows = namedBatchRows(paramSets);
  if (namedRows === null) return null;

  if (isNodeInsertBatch(inputSql)) {
    const rows = dedupePostgresRecordsetRows(
      namedRows.map((row) => ({
        id: row['id'],
        kind: row['kind'],
        name: row['name'],
        qualified_name: row['qualifiedName'],
        file_path: row['filePath'],
        language: row['language'],
        start_line: row['startLine'],
        end_line: row['endLine'],
        start_column: row['startColumn'],
        end_column: row['endColumn'],
        docstring: row['docstring'],
        signature: row['signature'],
        visibility: row['visibility'],
        is_exported: row['isExported'],
        is_default_export: row['isDefaultExport'],
        is_async: row['isAsync'],
        is_static: row['isStatic'],
        decorators: row['decorators'],
        decorator_args: row['decoratorArgs'],
        updated_at: row['updatedAt'],
        centrality: row['centrality'],
        betweenness: row['betweenness'],
        body_hash: row['bodyHash'],
        name_subwords: row['nameSubwords'],
      })),
      'id',
    );
    const result = await sql.unsafe(NODE_BATCH_INSERT_SQL, [sanitizePostgresJsonValue(rows)]);
    return { ok: true, changes: numericMeta(result, 'count') ?? rows.length, lastInsertRowid: 0 };
  }

  if (isEdgeInsertBatch(inputSql)) {
    const rows = namedRows.map((row) => ({
      source: row['source'],
      target: row['target'],
      kind: row['kind'],
      metadata: row['metadata'],
      line: row['line'],
      col: row['column'],
      confidence: row['confidence'],
    }));
    const result = await sql.unsafe(EDGE_BATCH_INSERT_SQL, [sanitizePostgresJsonValue(rows)]);
    return { ok: true, changes: numericMeta(result, 'count') ?? rows.length, lastInsertRowid: 0 };
  }

  return null;
}

function namedBatchRows(paramSets: unknown[][]): Record<string, unknown>[] | null {
  const rows: Record<string, unknown>[] = [];
  for (const params of paramSets) {
    if (params.length !== 1 || !isPlainObject(params[0])) return null;
    rows.push(params[0]);
  }
  return rows;
}

function isNodeInsertBatch(inputSql: string): boolean {
  return /^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+nodes\b/i.test(inputSql) && /\bname_subwords\b/i.test(inputSql);
}

function isEdgeInsertBatch(inputSql: string): boolean {
  return /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+edges\b/i.test(inputSql);
}

interface TranslatedQuery {
  sql: string;
  params: unknown[];
}

function translateQuery(inputSql: string, rawParams: unknown[]): TranslatedQuery {
  const bound = bindParams(rawParams);
  let text = rewriteSql(inputSql);
  const params: unknown[] = [];
  const namedPositions = new Map<string, number>();
  let positional = 0;

  // Substitute placeholders only OUTSIDE single-quoted string literals so
  // a literal like `'%?%'` or `'tag:@name'` is never mistaken for a bind
  // marker (which would shift every positional param). Spans are computed
  // on the pre-substitution text; `replaceAll` reports offsets into it.
  const literalSpans = stringLiteralSpans(text);
  text = text.replaceAll(
    new RegExp(String.raw`([@:$])(${SAFE_IDENTIFIER_PATTERN})|\?`, 'g'),
    (match, prefix: string | undefined, name: string | undefined, offset: number) => {
      if (offsetInsideLiteral(offset, literalSpans)) return match;
      if (match === '?') {
        params.push(bound.positional[positional++]);
        return `$${params.length}`;
      }
      if (!name || !prefix) return match;
      if (prefix === ':' && text[offset - 1] === ':') return match;
      if (prefix === '$' && /^\d+$/.test(name)) return match;
      const existing = namedPositions.get(name);
      if (existing !== undefined) return `$${existing}`;
      params.push(bound.named[name]);
      const position = params.length;
      namedPositions.set(name, position);
      return `$${position}`;
    },
  );

  const jsonEachPositions = normalizeJsonEachParams(text, params);
  text = rewritePostgresAfterPlaceholders(text, jsonEachPositions);
  return { sql: text, params };
}

function rewriteSql(inputSql: string): string {
  let text = inputSql.trim();
  text = text.replace(
    /\bINSERT\s+OR\s+REPLACE\s+INTO\s+nodes\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
    (_m, cols, vals) => {
      const columns = String(cols)
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .map(assertSafeSqlIdentifier);
      const columnList = columns.join(', ');
      const valueList = assertSafeSqlValueList(String(vals));
      const updates = columns
        .filter((c) => c !== 'id')
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(', ');
      return `INSERT INTO nodes (${columnList}) VALUES (${valueList}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
    },
  );

  const insertIgnore = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(text);
  text = text.replaceAll(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
  if (insertIgnore && !/\bON\s+CONFLICT\b/i.test(text)) {
    text = withoutTrailingSemicolon(text) + ' ON CONFLICT DO NOTHING';
  }
  if (/^\s*INSERT\s+INTO\s+agent_notes\b/i.test(text) && !/\bRETURNING\b/i.test(text)) {
    text = withoutTrailingSemicolon(text) + ' RETURNING id';
  }

  text = text.replaceAll(/\bDELETE\s+FROM\s+symbol_embeddings\b/gi, 'DELETE FROM embedding_refs');
  text = text.replaceAll(/\bDELETE\s+FROM\s+symbol_summaries\b/gi, 'DELETE FROM summary_refs');
  text = text.replaceAll(
    new RegExp(String.raw`json_extract\(([^,]+),\s*'\$\.(${SAFE_IDENTIFIER_PATTERN})'\s*\)`, 'gi'),
    "($1::jsonb ->> '$2')",
  );
  text = text.replaceAll(/strftime\('%s',\s*'now'\)\s*\*\s*1000/gi, '(extract(epoch from now()) * 1000)');
  text = text.replaceAll(/\bHAVING\s+coOccurrences\s*>=/gi, 'HAVING COUNT(*) >=');
  text = rewriteNoCaseCollations(text);
  text = rewritePlainLikeToILike(text);
  text = rewriteGroupConcat(text);
  return text;
}

function rewriteGroupConcat(sqlText: string): string {
  let output = '';
  let cursor = 0;
  for (;;) {
    const match = findGroupConcatCall(sqlText, cursor);
    if (!match) break;
    output += sqlText.slice(cursor, match.start);
    output += renderGroupConcatCall(sqlText.slice(match.open + 1, match.close));
    cursor = match.close + 1;
  }
  return output + sqlText.slice(cursor);
}

function findGroupConcatCall(sqlText: string, offset: number): { start: number; open: number; close: number } | null {
  const lower = sqlText.toLowerCase();
  let start = lower.indexOf('group_concat', offset);
  while (start >= 0) {
    const afterName = start + 'group_concat'.length;
    const open = skipWhitespace(sqlText, afterName);
    if (isWordBoundary(sqlText, start - 1) && isWordBoundary(sqlText, afterName) && sqlText[open] === '(') {
      const close = findClosingParen(sqlText, open);
      if (close >= 0) return { start, open, close };
    }
    start = lower.indexOf('group_concat', afterName);
  }
  return null;
}

function renderGroupConcatCall(body: string): string {
  const args = splitTopLevelComma(body);
  const renderedExpr = (args[0] ?? '').trim();
  if (!renderedExpr) return `GROUP_CONCAT(${body})`;
  const renderedSeparator = args[1] === undefined ? "','" : args[1].trim();
  return `string_agg(${renderedExpr}::text, ${renderedSeparator})`;
}

function splitTopLevelComma(body: string): string[] {
  const comma = findTopLevelComma(body);
  if (comma < 0) return [body];
  return [body.slice(0, comma), body.slice(comma + 1)];
}

function findTopLevelComma(body: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) return i;
  }
  return -1;
}

function findClosingParen(sqlText: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < sqlText.length; i++) {
    const char = sqlText[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === '(') depth++;
    if (char === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipWhitespace(value: string, offset: number): number {
  let cursor = offset;
  while (/\s/.test(value[cursor] ?? '')) cursor++;
  return cursor;
}

function isWordBoundary(value: string, offset: number): boolean {
  const char = value[offset];
  return char === undefined || !/\w/.test(char);
}

function rewriteNoCaseCollations(sqlText: string): string {
  let text = sqlText;
  const rewriteComparison = (_match: string, lhs: string, operator: string, rhs: string): string => {
    return operator.toUpperCase() === 'LIKE' ? `${lhs} ILIKE ${rhs}` : `lower(${lhs}) = lower(${rhs})`;
  };
  text = text.replaceAll(
    new RegExp(
      String.raw`\b(${SQL_IDENTIFIER_PATTERN})\s*(=|LIKE)\s*(${SQL_PARAMETER_PATTERN})\s+COLLATE\s+NOCASE\b`,
      'gi',
    ),
    rewriteComparison,
  );
  text = text.replaceAll(
    new RegExp(
      String.raw`\b(${SQL_IDENTIFIER_PATTERN})\s+COLLATE\s+NOCASE\s*(=|LIKE)\s*(${SQL_PARAMETER_PATTERN})`,
      'gi',
    ),
    rewriteComparison,
  );
  return text;
}

function normalizeJsonEachParams(sqlText: string, params: unknown[]): Set<number> {
  const seen = new Set<number>();
  for (const match of sqlText.matchAll(/json_each\((\$\d+)\)/gi)) {
    const placeholder = match[1];
    if (!placeholder) continue;
    const position = Number(placeholder.slice(1));
    if (!Number.isInteger(position) || position < 1 || seen.has(position)) continue;
    seen.add(position);
    params[position - 1] = coerceJsonParam(params[position - 1]);
  }
  return seen;
}

function coerceJsonParam(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function bindParams(rawParams: unknown[]): { positional: unknown[]; named: Record<string, unknown> } {
  if (rawParams.length === 1 && isPlainObject(rawParams[0])) {
    return { positional: [], named: rawParams[0] };
  }
  return { positional: rawParams, named: {} };
}

function normalizeRow(row: unknown): unknown {
  if (!isPlainObject(row)) return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = normalizeRowKey(key);
    if (typeof value === 'string' && shouldConvertNumericString(normalizedKey, value)) {
      out[normalizedKey] = Number(value);
    } else {
      out[normalizedKey] = value;
    }
  }
  return out;
}

function normalizeRowKey(key: string): string {
  return CANONICAL_ROW_KEYS[key] ?? key;
}

function shouldConvertNumericString(key: string, value: string): boolean {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return false;
  return (
    /^(c|n|count|row_count|rows|total|pending|attempts|reads|max_rowid|max|min|avg|sum|r|score|version|applied_at)$/i.test(
      key,
    ) ||
    /(^|_)(count|occurrences|dependents|nodes|files|edges|rows)$/i.test(key) ||
    /(Count|Occurrences|Dependents|Nodes|Files|Edges|Rows)$/u.test(key)
  );
}

function inferLastInsertRowid(rows: unknown[]): number {
  const first = rows[0];
  if (!isPlainObject(first)) return 0;
  const id = first['id'];
  return typeof id === 'number' ? id : 0;
}

function numericMeta(rows: unknown, key: string): number | undefined {
  if (!isPlainObject(rows)) return undefined;
  const value = rows[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

function isPragmaStatement(sqlText: string): boolean {
  return /^PRAGMA\b/i.test(sqlText.trim());
}

async function pragmaValue(pragma: string): Promise<unknown> {
  const rows = await pragmaRows(`PRAGMA ${pragma}`);
  const first = rows[0];
  if (rows.length !== 1 || !isPlainObject(first)) return rows;
  const entries = Object.entries(first);
  return entries.length === 1 ? entries[0]?.[1] : first;
}

async function pragmaRows(sqlText: string): Promise<Array<Record<string, unknown>>> {
  const body = sqlText
    .trim()
    .replace(/^PRAGMA\s+/i, '')
    .replace(/;\s*$/, '');
  const tableName = parseTableInfoPragma(body);
  if (tableName !== null) return tableInfoRows(tableName);
  if (/^table_list\b/i.test(body)) return tableListRows();
  if (/^(index_list|index_info|index_xinfo|foreign_key_list)\s*\(/i.test(body)) return [];
  if (/^database_list\b/i.test(body)) return [{ seq: 0, name: 'main', file: init.url }];
  const name = body.split(/[=\s(]/, 1)[0] ?? '';
  return name ? [{ [name]: 0 }] : [];
}

function parseTableInfoPragma(body: string): string | null {
  const pattern = new RegExp(
    String.raw`^table_(?:x)?info\s*\(\s*(?:"([^"]+)"|'([^']+)'|(${SAFE_IDENTIFIER_PATTERN}))\s*\)$`,
    'i',
  );
  const match = pattern.exec(body);
  if (!match) return null;
  const tableName = match[1] ?? match[2] ?? match[3] ?? '';
  return SAFE_IDENTIFIER_RE.test(tableName) ? tableName : null;
}

async function tableInfoRows(tableName: string): Promise<Array<Record<string, unknown>>> {
  const rows = await sql.unsafe(
    `SELECT
       (c.ordinal_position - 1)::integer AS cid,
       c.column_name AS name,
       upper(c.data_type) AS type,
       CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
       c.column_default AS dflt_value,
       COALESCE(kcu.ordinal_position, 0)::integer AS pk
     FROM information_schema.columns c
     LEFT JOIN information_schema.table_constraints tc
       ON tc.table_schema = c.table_schema
      AND tc.table_name = c.table_name
      AND tc.constraint_type = 'PRIMARY KEY'
     LEFT JOIN information_schema.key_column_usage kcu
       ON kcu.table_schema = tc.table_schema
      AND kcu.table_name = tc.table_name
      AND kcu.constraint_name = tc.constraint_name
      AND kcu.column_name = c.column_name
     WHERE c.table_schema = $1
       AND c.table_name = $2
     ORDER BY c.ordinal_position`,
    [schemaName, tableName],
  );
  return Array.from(rows as unknown[])
    .map(normalizeRow)
    .filter(isPlainObject);
}

async function tableListRows(): Promise<Array<Record<string, unknown>>> {
  const rows = await sql.unsafe(
    `SELECT
       table_schema AS schema,
       table_name AS name,
       CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS type,
       0 AS ncol,
       0 AS wr,
       0 AS strict
     FROM information_schema.tables
     WHERE table_schema = $1
     ORDER BY type, name`,
    [schemaName],
  );
  return Array.from(rows as unknown[])
    .map(normalizeRow)
    .filter(isPlainObject);
}

function isNoopStatement(sqlText: string): boolean {
  return /^PRAGMA\b/i.test(sqlText) || /^VACUUM\b/i.test(sqlText);
}

function withoutTrailingSemicolon(sqlText: string): string {
  return sqlText.replace(/;\s*$/, '');
}

function assertSafeIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER_RE.test(value)) throw new Error(`Invalid PostgreSQL schema name: ${value}`);
  return value;
}

function assertSafeSqlIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER_RE.test(value)) throw new Error(`Invalid SQLite-to-PostgreSQL column name: ${value}`);
  return value;
}

function assertSafeSqlValueList(value: string): string {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const pattern = new RegExp(String.raw`^(?:[@:$]${SAFE_IDENTIFIER_PATTERN}|\?|\$\d+)$`);
    if (!pattern.test(part)) {
      throw new Error(`Invalid SQLite-to-PostgreSQL value placeholder: ${part}`);
    }
  }
  return parts.join(', ');
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __cartographBinary: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') return { __cartographBigInt: value.toString() };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = encodeValue(inner);
    return out;
  }
  return value;
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (isPlainObject(value)) {
    if (typeof value['__cartographBinary'] === 'string') return Buffer.from(value['__cartographBinary'], 'base64');
    if (typeof value['__cartographBigInt'] === 'string') return BigInt(value['__cartographBigInt']);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = decodeValue(inner);
    return out;
  }
  return value;
}
