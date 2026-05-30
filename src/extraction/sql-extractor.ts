import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Node, Edge, ExtractionResult, UnresolvedReference, NodeKind } from '../types.js';
import { getNodeText, type NodeIdFactory } from './tree-sitter-helpers.js';
import { getParser } from './grammars.js';
import { errMsg } from '../errors.js';
import { StandaloneExtractor } from './standalone-extractor.js';

/**
 * SqlExtractor — extracts SQL DDL into the graph.
 *
 * SQL is declarative, with no functions/classes/methods in the OO sense, so
 * this is a self-contained extractor (same shape as `LiquidExtractor` /
 * `HclExtractor`) rather than a `LanguageExtractor` config plug-in.
 *
 * Top-level statements become graph nodes whose qualified names follow the
 * SQL identifier they declare (with schema prefix when given):
 *
 *   SQL statement                          | NodeKind    | qualified name
 *   ---------------------------------------|-------------|-----------------
 *   CREATE TABLE [schema.]name             | table       | [schema.]name
 *   CREATE VIEW [schema.]name              | table       | [schema.]name
 *   CREATE FUNCTION [schema.]name(...)     | function    | [schema.]name
 *   CREATE TRIGGER name ON table           | function    | name
 *   CREATE TYPE name AS ENUM (...)         | enum        | name
 *   CREATE TYPE name AS ...                | type_alias  | name
 *   CREATE SCHEMA name                     | namespace   | name
 *
 * References emitted:
 *   - Foreign keys (`REFERENCES other_table`)            → `references`
 *   - View source tables (FROM/JOIN, including derived)  → `references`
 *   - Function body table mentions                       → `references`
 *   - Trigger target table                               → `references`
 *   - Trigger executed function                          → `calls`
 *
 * The grammar (DerekStride/tree-sitter-sql) covers ANSI SQL plus common
 * PostgreSQL/MySQL/SQLite/T-SQL syntax for tables, views, functions,
 * triggers, types, and schemas. CREATE PROCEDURE syntax varies sharply
 * across dialects (PL/pgSQL dollar-quoting, T-SQL BEGIN/END, MySQL
 * delimiter blocks) and is not currently parsed by the grammar — those
 * statements produce ERROR nodes and no extracted symbol. Plain DML
 * (SELECT/INSERT/UPDATE/DELETE) outside a CREATE body is recognized but
 * not emitted as nodes — those aren't symbol declarations.
 */

// ---------------------------------------------------------------------------
// Module-level state type
// ---------------------------------------------------------------------------

interface SqlState {
  filePath: string;
  source: string;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  idFactory: NodeIdFactory;
}

/** Argument bundle for {@link sqlCreateNode}. */
interface SqlCreateNodeArgs {
  kind: NodeKind;
  name: string;
  node: SyntaxNode;
  fileNodeId: string;
  signature: string;
  extra?: Partial<Node> | undefined;
}

// ---------------------------------------------------------------------------
// Free-function helpers
// ---------------------------------------------------------------------------

function sqlCreateNode(st: SqlState, args: SqlCreateNodeArgs): string | null {
  const { kind, name, node, fileNodeId, signature, extra } = args;
  if (!name) return null;
  const id = st.idFactory.next(kind, name);
  st.nodes.push({
    id,
    kind,
    name,
    qualifiedName: name,
    filePath: st.filePath,
    language: 'sql',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature,
    updatedAt: Date.now(),
    ...extra,
  });
  st.edges.push({ source: fileNodeId, target: id, kind: 'contains' });
  return id;
}

/**
 * Render an `object_reference` as a dotted qualified name. The grammar
 * exposes 1 identifier child for an unqualified name, 2 for `schema.name`,
 * and occasionally 3 for `db.schema.name` in some dialects.
 *
 * The grammar includes surrounding double-quotes in identifier text for
 * quoted identifiers (e.g. `"public"` is the full token text including the
 * quotes). Strip them so `"public"."circles"` stores as `public.circles` and
 * is findable by `find circles` or `find public.circles`.
 */
function sqlStripQuotes(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  return raw;
}

function sqlQualifiedName(st: SqlState, ref: SyntaxNode): string | null {
  const idents = ref.namedChildren.filter((c: SyntaxNode | null) => c?.type === 'identifier');
  if (idents.length === 0) {
    const text = getNodeText(ref, st.source).trim();
    return text || null;
  }
  return idents.map((i: SyntaxNode) => sqlStripQuotes(getNodeText(i, st.source))).join('.');
}

/**
 * Read the head `object_reference` of a CREATE statement and return its
 * qualified name (e.g. `reporting.events`).
 */
function sqlReadObjectName(st: SqlState, node: SyntaxNode): string | null {
  const ref = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'object_reference');
  if (!ref) return null;
  return sqlQualifiedName(st, ref);
}

/**
 * Find the first `object_reference` named child that comes after a child
 * of type `markerType`. Returns null if no marker or no following ref.
 */
function sqlFindObjectRefAfter(parent: SyntaxNode, markerType: string): SyntaxNode | null {
  let seenMarker = false;
  for (const child of parent.namedChildren) {
    if (!child) continue;
    if (child.type === markerType) {
      seenMarker = true;
      continue;
    }
    if (seenMarker && child.type === 'object_reference') return child;
  }
  return null;
}

function sqlEmitTable(st: SqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = sqlReadObjectName(st, node);
  if (!name) return;
  const tableId = sqlCreateNode(st, { kind: 'table', name, node, fileNodeId, signature: `CREATE TABLE ${name}` });
  if (!tableId) return;

  const cols = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'column_definitions');
  if (cols) {
    sqlScanForeignKeys(st, cols, tableId);
  }
}

function sqlEmitView(st: SqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = sqlReadObjectName(st, node);
  if (!name) return;
  const viewId = sqlCreateNode(st, { kind: 'table', name, node, fileNodeId, signature: `CREATE VIEW ${name}` });
  if (!viewId) return;

  const query = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'create_query');
  if (query) sqlScanQueryReferences(st, query, viewId);
}

interface SqlEmitFunctionArgs {
  st: SqlState;
  node: SyntaxNode;
  fileNodeId: string;
  label: string;
}

function sqlEmitFunction(params: SqlEmitFunctionArgs): void {
  const { st, node, fileNodeId, label } = params;
  const name = sqlReadObjectName(st, node);
  if (!name) return;
  const args = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'function_arguments');
  const argsText = args ? getNodeText(args, st.source) : '()';
  const funcId = sqlCreateNode(st, {
    kind: 'function',
    name,
    node,
    fileNodeId,
    signature: `${label} ${name}${argsText}`,
  });
  if (!funcId) return;

  const body = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'function_body');
  if (body) sqlScanQueryReferences(st, body, funcId);
}

function sqlEmitTrigger(st: SqlState, node: SyntaxNode, fileNodeId: string): void {
  const nameNode = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'object_reference');
  if (!nameNode) return;
  const name = sqlQualifiedName(st, nameNode);
  if (!name) return;

  const triggerId = sqlCreateNode(st, {
    kind: 'function',
    name,
    node,
    fileNodeId,
    signature: `CREATE TRIGGER ${name}`,
  });
  if (!triggerId) return;

  const targetTable = sqlFindObjectRefAfter(node, 'keyword_on');
  if (targetTable) {
    const targetName = sqlQualifiedName(st, targetTable);
    if (targetName) {
      st.unresolvedReferences.push({
        fromNodeId: triggerId,
        referenceName: targetName,
        referenceKind: 'references',
        line: targetTable.startPosition.row + 1,
        column: targetTable.startPosition.column,
      });
    }
  }

  const executedFn = sqlFindObjectRefAfter(node, 'keyword_execute');
  if (executedFn) {
    const fnName = sqlQualifiedName(st, executedFn);
    if (fnName) {
      st.unresolvedReferences.push({
        fromNodeId: triggerId,
        referenceName: fnName,
        referenceKind: 'calls',
        line: executedFn.startPosition.row + 1,
        column: executedFn.startPosition.column,
      });
    }
  }
}

function sqlEmitType(st: SqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = sqlReadObjectName(st, node);
  if (!name) return;
  const isEnum = node.namedChildren.some((c: SyntaxNode | null) => c?.type === 'keyword_enum');
  const kind: NodeKind = isEnum ? 'enum' : 'type_alias';
  sqlCreateNode(st, { kind, name, node, fileNodeId, signature: `CREATE TYPE ${name}` });
}

function sqlEmitSchema(st: SqlState, node: SyntaxNode, fileNodeId: string): void {
  const ident = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
  if (!ident) return;
  const name = sqlStripQuotes(getNodeText(ident, st.source));
  sqlCreateNode(st, { kind: 'namespace', name, node, fileNodeId, signature: `CREATE SCHEMA ${name}` });
}

/**
 * Scan a column_definitions subtree for foreign-key references.
 */
function sqlScanForeignKeys(st: SqlState, root: SyntaxNode, fromNodeId: string): void {
  const visit = (node: SyntaxNode): void => {
    // B15: skipped — index used for sibling lookup (node.namedChild(i + 1)).
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'keyword_references') {
        sqlRecordForeignKeyTarget(st, node.namedChild(i + 1), fromNodeId);
      }
      visit(child);
    }
  };
  visit(root);
}

/** When a `keyword_references` child is followed by an `object_reference`,
 *  push a `references` unresolved-ref. */
function sqlRecordForeignKeyTarget(st: SqlState, target: SyntaxNode | null, fromNodeId: string): void {
  if (target?.type !== 'object_reference') return;
  const targetName = sqlQualifiedName(st, target);
  if (!targetName) return;
  st.unresolvedReferences.push({
    fromNodeId,
    referenceName: targetName,
    referenceKind: 'references',
    line: target.startPosition.row + 1,
    column: target.startPosition.column,
  });
}

/**
 * Scan an arbitrary subtree (view body, function body, etc.) for table
 * mentions.
 */
function sqlScanQueryReferences(st: SqlState, root: SyntaxNode, fromNodeId: string): void {
  const seen = new Set<string>();
  const visit = (node: SyntaxNode): void => {
    let recordedRelationHead = false;
    if (node.type === 'relation' || node.type === 'object_reference') {
      const target =
        node.type === 'relation'
          ? node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'object_reference')
          : node;
      if (target) {
        const targetName = sqlQualifiedName(st, target);
        if (targetName && !seen.has(targetName)) {
          seen.add(targetName);
          st.unresolvedReferences.push({
            fromNodeId,
            referenceName: targetName,
            referenceKind: 'references',
            line: target.startPosition.row + 1,
            column: target.startPosition.column,
          });
        }
        recordedRelationHead = node.type === 'relation';
      }
      if (recordedRelationHead) return;
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
}

// ---------------------------------------------------------------------------
// Class — thin orchestrator
// ---------------------------------------------------------------------------

export class SqlExtractor extends StandaloneExtractor {
  extract(): ExtractionResult {
    const startTime = Date.now();

    const parser = getParser('sql');
    if (!parser) {
      this.errors.push({ message: 'SQL grammar not loaded', severity: 'error', code: 'grammar_unavailable' });
      return this.result(startTime);
    }

    let tree: Tree | null;
    try {
      tree = parser.parse(this.source);
    } catch (e) {
      this.errors.push({
        message: `SQL parse error: ${errMsg(e)}`,
        severity: 'error',
        code: 'parse_error',
      });
      return this.result(startTime);
    }
    if (!tree) {
      this.errors.push({ message: 'SQL parse returned no tree', severity: 'error', code: 'parse_error' });
      return this.result(startTime);
    }

    try {
      const fileNodeId = this.createFileNode('sql').id;
      const root = tree.rootNode;
      for (const child of root.namedChildren) {
        if (!child) continue;
        if (child.type === 'statement') {
          this.tryVisitStatement(child, fileNodeId);
        } else if (child.type === 'ERROR') {
          // Informix (and some other dialects) use `RETURNING …; END FUNCTION;`
          // which the grammar can't parse as a valid `create_function` and
          // surfaces as an ERROR node. Attempt recovery for the common pattern:
          // ERROR containing keyword_create + keyword_function + object_reference.
          this.tryVisitErrorNode(child, fileNodeId);
        }
      }
      return this.result(startTime);
    } finally {
      // Free WASM heap memory — web-tree-sitter trees hold native heap
      // memory invisible to V8's GC.
      tree.delete();
    }
  }

  /** Per-statement try/catch wrapper. Delegated to {@link StandaloneExtractor.tryVisit}. */
  private tryVisitStatement(stmt: SyntaxNode, fileNodeId: string): void {
    this.tryVisit(stmt, () => this.visitStatement(stmt, fileNodeId), 'SQL statement extraction error: ');
  }

  /**
   * Recovery path for ERROR nodes that the grammar can't fully parse.
   *
   * Informix (and some other dialects) use `RETURNING …; END FUNCTION;`
   * syntax that the tree-sitter-sql grammar doesn't recognise, producing
   * a top-level ERROR node instead of a `statement → create_function`.
   * The ERROR node still contains the sub-nodes we need: `keyword_create`,
   * `keyword_function`, `object_reference`, and optionally
   * `function_arguments`. When those are present we emit a function node
   * via the same `sqlEmitFunction` helper used for well-formed statements.
   */
  private tryVisitErrorNode(errNode: SyntaxNode, fileNodeId: string): void {
    this.tryVisit(
      errNode,
      () => {
        const childTypes = new Set<string>();
        for (const c of errNode.namedChildren) {
          if (c) childTypes.add(c.type);
        }
        // Only recover when this looks like a CREATE FUNCTION with an object name.
        if (
          !childTypes.has('keyword_create') ||
          !childTypes.has('keyword_function') ||
          !childTypes.has('object_reference')
        ) {
          return;
        }
        const st = this.state();
        sqlEmitFunction({ st, node: errNode, fileNodeId, label: 'CREATE FUNCTION' });
      },
      'SQL ERROR-node recovery error: ',
    );
  }

  private visitStatement(stmt: SyntaxNode, fileNodeId: string): void {
    const st = this.state();
    const inner = stmt.namedChild(0);
    if (!inner) return;
    switch (inner.type) {
      case 'create_table':
        sqlEmitTable(st, inner, fileNodeId);
        return;
      case 'create_view':
        sqlEmitView(st, inner, fileNodeId);
        return;
      case 'create_function':
        sqlEmitFunction({ st, node: inner, fileNodeId, label: 'CREATE FUNCTION' });
        return;
      case 'create_trigger':
        sqlEmitTrigger(st, inner, fileNodeId);
        return;
      case 'create_type':
        sqlEmitType(st, inner, fileNodeId);
        return;
      case 'create_schema':
        sqlEmitSchema(st, inner, fileNodeId);
        return;
      default:
        return;
    }
  }

  /**
   * Expose mutable state to module-scope free functions. The
   * extractor class structurally satisfies {@link SqlState} —
   * a `this`-as-state cast avoids per-field `this.x` reads that
   * the `field_access` extractor used to read as cross-class
   * accesses (false-positive `feature_envy` on inherited fields).
   */
  private state(): SqlState {
    return this as unknown as SqlState;
  }
}
