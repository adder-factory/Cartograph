/**
 * MyBatis Java↔XML linkage hook (B11/F#64b, 2026-05-26).
 *
 * Third consumer of the graph-walk pattern (after `nestjs-routes` /
 * `spring-value-binding`). Bridges Java/Kotlin Mapper-interface
 * methods to the MyBatis XML statements that implement them.
 *
 * Source side: the `xml` extractor (`languages/xml.ts`) emits
 * one `kind:'method'` node per `<select|insert|update|delete|sql
 * id="X">` inside a `<mapper namespace="com.example.UserMapper">`
 * file. The XML node's `qualifiedName` is `UserMapper::<id>` —
 * matching the JVM (Java/Kotlin) extractor's `<Interface>::<method>`
 * convention.
 *
 * What this hook does: for every XML mapper-statement method node,
 * find the JVM (Java/Kotlin) method node with the same `qualifiedName`
 * and emit a `references` edge from the JVM method to the XML
 * statement. After this, `cartograph_graph direction:callees
 * start=UserMapper.findById` surfaces the actual SQL statement
 * as a child of the JVM method.
 *
 * **XML-internal `<include refid>` references are NOT handled here.**
 * The xml extractor emits them as `UnresolvedReference`s with
 * `referenceName` already shaped as `<Class>::<id>`; the standard
 * resolver's qualifiedName-match path resolves them automatically
 * (with `resolvedBy: 'qualified-name'`, confidence 0.95). A
 * duplicate sub-pass in this hook would race the resolver and lose,
 * so it's intentionally absent.
 *
 * Match strategy v1:
 *
 *   - Equal `qualifiedName` (`UserMapper::findById` on both sides).
 *   - When multiple JVM methods share that name across packages
 *     (`com.example.UserMapper` AND `com.other.UserMapper`), all of
 *     them get the edge — MyBatis itself doesn't disambiguate by
 *     package in the cross-XML-to-JVM direction. A `same-file-first`
 *     tiebreaker isn't applicable (JVM source + XML always live in
 *     different files). This matches the existing JVM resolver's
 *     name-only behavior elsewhere.
 *
 * Self-heal via `MYBATIS_BINDING_ALGO_VERSION` +
 * `last_mined_mybatis_binding_algo_version` metadata key — same
 * pattern as `spring-value-binding` / `nestjs-routes`.
 *
 * Cross-language paths handled WITHOUT new hook code (the standard
 * resolver's qualifiedName-match path resolves these via the
 * pre-qualified `referenceName`s the xml extractor emits — same
 * hands-off strategy across v1.1 + v2 + v3):
 *   - `<include refid="X"/>` → `<sql id="X">` fragment (v1.1).
 *   - `resultMap="X"` / `parameterMap="X"` statement attributes →
 *     the matching `<resultMap>` / `<parameterMap>` type_alias (v2).
 *   - `#{paramName}` SQL placeholders → Java/Kotlin parameter nodes
 *     emitted by `tsEmitAnnotatedParameters` (v3 shipped Java,
 *     v3.1 added Kotlin via a state-machine that pairs Kotlin's
 *     sibling-split `parameter_modifiers` with the next `parameter`).
 *
 * Deferred (documented; uncomment when surfaced):
 *   - Spring `mybatis-config.xml` `<package name="..."/>` scans for
 *     Mapper auto-discovery.
 *   - Generic non-MyBatis XML support — needs `tree-sitter-xml.wasm`
 *     built (no pre-built `.wasm` on the npm grammar package).
 *   - Package-qualified disambiguation when the XML namespace's full
 *     package path could distinguish ambiguous JVM targets — needs
 *     the Java/Kotlin extractor to surface the package in qualifiedName
 *     first (it currently doesn't).
 */

import type { IndexHook, IndexHookContext } from './types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';
import { insertEdges } from '../db/queries-edges.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge } from '../types.js';
import { makeLineIndex } from '../utils.js';

/** Algo-version SHA. Mismatch on `afterSync` triggers re-mine. */
export const MYBATIS_BINDING_ALGO_VERSION = computeAlgoHash('src/index-hooks/mybatis-binding.ts', [
  './mybatis-binding',
]);
const LAST_MINED_KEY = 'last_mined_mybatis_binding_algo_version';

/** JVM languages whose Mapper-interface method nodes the bridge
 *  targets. (Scala has MyBatis bindings in the wild too but is rarer;
 *  add when a corpus surfaces it.) */
const JVM_LANGUAGES: ReadonlySet<string> = new Set(['java', 'kotlin']);

interface XmlStatement {
  xmlNodeId: string;
  qualifiedName: string;
  xmlFilePath: string;
  xmlStartLine: number;
}

interface JvmMethodRange {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

interface TemplateStatementCall {
  sourceMethodId: string;
  statementQualifiedName: string;
}

interface CollectTemplateStatementCallsArgs {
  filePath: string;
  content: string;
  methods: readonly JvmMethodRange[];
}

interface ExpressionScanState {
  depth: number;
  quote: '"' | "'" | null;
  escaped: boolean;
}

const TEMPLATE_CALL_RE =
  /\b(?:getSqlSessionTemplate\s*\(\)|sqlSessionTemplate)\s*\.\s*(?:selectOne|selectList|selectMap|insert|update|delete)\s*\(/g;
const CLASS_GET_NAME_RE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.class\.get(?:Name|CanonicalName)\s*\(\s*\)$/;

function collectXmlStatements(ctx: IndexHookContext): XmlStatement[] {
  const rows = ctx.queries.db
    .prepare(
      `SELECT id, qualified_name AS qualifiedName, file_path AS filePath, start_line AS startLine
       FROM nodes
       WHERE kind = 'method' AND language = 'xml'`,
    )
    .all() as Array<{ id: string; qualifiedName: string; filePath: string; startLine: number }>;
  return rows.map((r) => ({
    xmlNodeId: r.id,
    qualifiedName: r.qualifiedName,
    xmlFilePath: r.filePath,
    xmlStartLine: r.startLine,
  }));
}

function collectJavaMethodRanges(ctx: IndexHookContext): JvmMethodRange[] {
  const rows = ctx.queries.db
    .prepare(
      `SELECT id, file_path AS filePath, start_line AS startLine, end_line AS endLine
       FROM nodes
       WHERE kind = 'method' AND language = 'java'`,
    )
    .all() as Array<{ id: string; filePath: string; startLine: number; endLine: number }>;
  return rows.map((row) => ({
    id: row.id,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: Math.max(row.startLine, row.endLine),
  }));
}

function methodsByFile(methods: readonly JvmMethodRange[]): Map<string, JvmMethodRange[]> {
  const byFile = new Map<string, JvmMethodRange[]>();
  for (const method of methods) {
    const list = byFile.get(method.filePath) ?? [];
    list.push(method);
    byFile.set(method.filePath, list);
  }
  for (const list of byFile.values()) list.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return byFile;
}

function methodContainingLine(methods: readonly JvmMethodRange[], line: number): JvmMethodRange | null {
  let best: JvmMethodRange | null = null;
  for (const method of methods) {
    if (line < method.startLine || line > method.endLine) continue;
    if (!best || method.endLine - method.startLine < best.endLine - best.startLine) best = method;
  }
  return best;
}

function readText(projectRoot: string, filePath: string): string | null {
  try {
    return fs.readFileSync(path.join(projectRoot, filePath), 'utf-8');
  } catch {
    return null;
  }
}

function createExpressionScanState(): ExpressionScanState {
  return { depth: 0, quote: null, escaped: false };
}

function consumeQuotedChar(state: ExpressionScanState, ch: string): boolean {
  if (!state.quote) return false;
  if (state.escaped) state.escaped = false;
  else if (ch === '\\') state.escaped = true;
  else if (ch === state.quote) state.quote = null;
  return true;
}

function startQuote(state: ExpressionScanState, ch: string): boolean {
  if (ch !== '"' && ch !== "'") return false;
  state.quote = ch;
  return true;
}

function updateNesting(state: ExpressionScanState, ch: string): void {
  if (ch === '(' || ch === '[' || ch === '{') state.depth++;
  else if ((ch === ')' || ch === ']' || ch === '}') && state.depth > 0) state.depth--;
}

function readFirstArgument(source: string, start: number): string | null {
  const state = createExpressionScanState();
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (consumeQuotedChar(state, ch) || startQuote(state, ch)) continue;
    if (ch === ')' && state.depth === 0) return source.slice(start, i).trim();
    if (ch === ',' && state.depth === 0) return source.slice(start, i).trim();
    updateNesting(state, ch);
  }
  return null;
}

function splitConcatExpression(expression: string): string[] {
  const parts: string[] = [];
  const state = createExpressionScanState();
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]!;
    if (consumeQuotedChar(state, ch) || startQuote(state, ch)) continue;
    if (ch === '+' && state.depth === 0) {
      parts.push(expression.slice(start, i).trim());
      start = i + 1;
      continue;
    }
    updateNesting(state, ch);
  }
  parts.push(expression.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function stripOuterParens(value: string): string {
  let current = value.trim();
  while (current.startsWith('(') && current.endsWith(')')) current = current.slice(1, -1).trim();
  return current;
}

function unquoteJavaString(token: string): string | null {
  const quote = token[0];
  if ((quote !== '"' && quote !== "'") || token.at(-1) !== quote) return null;
  return token.slice(1, -1).replaceAll(`\\${quote}`, quote).replaceAll('\\\\', '\\');
}

function simpleClassName(name: string): string {
  const parts = name.split('.');
  return parts.at(-1) ?? name;
}

function evaluateStringTerm(token: string, constants: ReadonlyMap<string, string>): string | null {
  const clean = stripOuterParens(token);
  const literal = unquoteJavaString(clean);
  if (literal !== null) return literal;
  const constant = constants.get(clean);
  if (constant !== undefined) return constant;
  const classMatch = CLASS_GET_NAME_RE.exec(clean);
  return classMatch ? simpleClassName(classMatch[1]!) : null;
}

function evaluateStringExpression(expression: string, constants: ReadonlyMap<string, string>): string | null {
  let out = '';
  for (const part of splitConcatExpression(expression)) {
    const value = evaluateStringTerm(part, constants);
    if (value === null) return null;
    out += value;
  }
  return out;
}

function isIdentifierStart(ch: string | undefined): boolean {
  if (!ch) return false;
  return ch === '_' || ch === '$' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
}

function isIdentifierPart(ch: string | undefined): boolean {
  return isIdentifierStart(ch) || (ch !== undefined && ch >= '0' && ch <= '9');
}

function readIdentifier(value: string, start: number): { name: string; end: number } | null {
  if (!isIdentifierStart(value[start])) return null;
  let end = start + 1;
  while (isIdentifierPart(value[end])) end++;
  return { name: value.slice(start, end), end };
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index]!)) index++;
  return index;
}

function findStatementTerminator(value: string, start: number): number {
  const state = createExpressionScanState();
  for (let i = start; i < value.length; i++) {
    const ch = value[i]!;
    if (consumeQuotedChar(state, ch) || startQuote(state, ch)) continue;
    if (ch === ';' && state.depth === 0) return i;
    updateNesting(state, ch);
  }
  return -1;
}

function findStringTypeEnd(leftSide: string): number {
  let index = 0;
  while (index < leftSide.length) {
    index = skipWhitespace(leftSide, index);
    const token = readIdentifier(leftSide, index);
    if (!token) return -1;
    if (token.name === 'String') return token.end;
    index = token.end;
  }
  return -1;
}

function parseStringConstantDeclaration(line: string): { name: string; expression: string } | null {
  const equals = line.indexOf('=');
  if (equals < 0) return null;
  const stringTypeEnd = findStringTypeEnd(line.slice(0, equals));
  if (stringTypeEnd < 0) return null;
  const nameStart = skipWhitespace(line, stringTypeEnd);
  const name = readIdentifier(line, nameStart);
  if (!name) return null;
  const terminator = findStatementTerminator(line, equals + 1);
  if (terminator < 0) return null;
  return { name: name.name, expression: line.slice(equals + 1, terminator).trim() };
}

function collectStringConstants(content: string): Map<string, string> {
  const declarations: Array<{ name: string; expression: string }> = [];
  for (const line of content.split('\n')) {
    const declaration = parseStringConstantDeclaration(line.trim());
    if (declaration) declarations.push(declaration);
  }

  const constants = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (constants.has(declaration.name)) continue;
      const value = evaluateStringExpression(declaration.expression, constants);
      if (value === null) continue;
      constants.set(declaration.name, value);
      changed = true;
    }
  }
  return constants;
}

function toXmlStatementQualifiedName(statementId: string): string | null {
  if (statementId.includes('::')) return statementId;
  const parts = statementId.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const statement = parts.at(-1);
  const className = parts.at(-2);
  return className && statement ? `${className}::${statement}` : null;
}

function collectTemplateStatementCalls(args: CollectTemplateStatementCallsArgs): TemplateStatementCall[] {
  const { filePath, content, methods } = args;
  const constants = collectStringConstants(content);
  const lineOf = makeLineIndex(content);
  const calls: TemplateStatementCall[] = [];
  TEMPLATE_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_CALL_RE.exec(content)) !== null) {
    const firstArg = readFirstArgument(content, TEMPLATE_CALL_RE.lastIndex);
    if (!firstArg) continue;
    const statementId = evaluateStringExpression(firstArg, constants);
    if (!statementId) continue;
    const statementQualifiedName = toXmlStatementQualifiedName(statementId);
    if (!statementQualifiedName) continue;
    const sourceMethod = methodContainingLine(methods, lineOf(match.index));
    if (!sourceMethod) {
      logDebug(`mybatis-binding skipped template call outside method in ${filePath}`);
      continue;
    }
    calls.push({ sourceMethodId: sourceMethod.id, statementQualifiedName });
  }
  return calls;
}

/** Look up Java/Kotlin method nodes by qualifiedName. Returns a Map
 *  keyed by qualifiedName so the caller can batch the lookup with one
 *  IN-list rather than one query per statement. */
function lookupJvmMethods(ctx: IndexHookContext, qns: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (qns.length === 0) return map;
  const qnsJson = JSON.stringify([...new Set(qns)]);
  const langsJson = JSON.stringify([...JVM_LANGUAGES]);
  const rows = ctx.queries.db
    .prepare(
      `SELECT id, qualified_name AS qualifiedName
       FROM nodes
       WHERE kind = 'method'
         AND language IN (SELECT value FROM json_each(@langsJson))
         AND qualified_name IN (SELECT value FROM json_each(@qnsJson))`,
    )
    .all({ qnsJson, langsJson }) as Array<{ id: string; qualifiedName: string }>;
  for (const row of rows) {
    const list = map.get(row.qualifiedName) ?? [];
    list.push(row.id);
    map.set(row.qualifiedName, list);
  }
  return map;
}

function buildMapperInterfaceEdges(statements: readonly XmlStatement[], lookup: ReadonlyMap<string, string[]>): Edge[] {
  const edges: Edge[] = [];
  for (const stmt of statements) {
    const targets = lookup.get(stmt.qualifiedName);
    if (!targets) continue;
    for (const javaMethodId of targets) {
      edges.push({
        source: javaMethodId,
        target: stmt.xmlNodeId,
        kind: 'references',
        metadata: { synthesizedBy: 'mybatis-binding' },
      });
    }
  }
  return edges;
}

function buildTemplateStatementEdges(
  ctx: IndexHookContext,
  statementsByQualifiedName: ReadonlyMap<string, XmlStatement>,
): Edge[] {
  const edges: Edge[] = [];
  const javaMethodsByFile = methodsByFile(collectJavaMethodRanges(ctx));
  for (const [filePath, methods] of javaMethodsByFile) {
    const content = readText(ctx.projectRoot, filePath);
    if (!content) continue;
    for (const call of collectTemplateStatementCalls({ filePath, content, methods })) {
      const statement = statementsByQualifiedName.get(call.statementQualifiedName);
      if (!statement) continue;
      edges.push({
        source: call.sourceMethodId,
        target: statement.xmlNodeId,
        kind: 'references',
        metadata: { synthesizedBy: 'mybatis-template-binding' },
      });
    }
  }
  return edges;
}

function refresh(ctx: IndexHookContext): void {
  try {
    const statements = collectXmlStatements(ctx);
    if (statements.length === 0) {
      stamp(ctx);
      return;
    }
    const statementsByQualifiedName = new Map(statements.map((statement) => [statement.qualifiedName, statement]));
    const lookup = lookupJvmMethods(
      ctx,
      statements.map((s) => s.qualifiedName),
    );
    const newEdges = [
      ...buildMapperInterfaceEdges(statements, lookup),
      ...buildTemplateStatementEdges(ctx, statementsByQualifiedName),
    ];
    if (newEdges.length > 0) insertEdges(ctx.queries, newEdges);
  } catch (err) {
    logDebug(`mybatis-binding refresh failed: ${errMsg(err)}`);
  }
  stamp(ctx);
}

function stamp(ctx: IndexHookContext): void {
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, MYBATIS_BINDING_ALGO_VERSION);
  } catch (err) {
    logDebug(`mybatis-binding stamp failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'mybatis-binding',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx, result: SyncResult) {
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== MYBATIS_BINDING_ALGO_VERSION) {
      refresh(ctx);
      return;
    }
    // Sync trigger: any JVM or XML file changed → re-run. The lookup
    // is cross-file (JVM source in .java / .kt / .kts, statement in
    // .xml) so a project-wide pass is the simple v1; per-file scoping
    // is a perf follow-up.
    const changed = result.changedFilePaths ?? [];
    const anyJvmOrXmlChange =
      changed.some((p) => p.endsWith('.java') || p.endsWith('.kt') || p.endsWith('.kts') || p.endsWith('.xml')) ||
      result.filesRemoved > 0;
    if (anyJvmOrXmlChange) refresh(ctx);
  },
};
