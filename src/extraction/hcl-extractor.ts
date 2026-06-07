import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { ExtractionResult, UnresolvedReference } from './types.js';
import type { Edge, Node, NodeKind } from '../types.js';
import { getNodeText, type NodeIdFactory } from './tree-sitter-helpers.js';
import { getParser } from './grammars.js';
import { errMsg } from '../errors.js';
import { StandaloneExtractor } from './standalone-extractor.js';

/**
 * HclExtractor — extracts a Terraform/HCL file into the graph.
 *
 * HCL is a declarative configuration language: there are no functions,
 * classes, or methods. The unit of structure is the **block**:
 *
 *     <kind> [<label>...] { <body> }
 *
 * Each top-level block is mapped to a graph node, with its qualified name
 * matching the Terraform reference form so cross-block references resolve
 * naturally:
 *
 *   block form                        | NodeKind   | qualified name
 *   ----------------------------------|------------|----------------------
 *   variable "x" {}                   | variable   | var.x
 *   locals { x = ...; y = ... }       | constant   | local.x, local.y
 *   resource "TYPE" "NAME" {}         | resource   | TYPE.NAME
 *   data "TYPE" "NAME" {}             | resource   | data.TYPE.NAME
 *   module "NAME" {}                  | module     | module.NAME
 *   output "NAME" {}                  | export     | output.NAME
 *   provider "NAME" {}                | namespace  | provider.NAME
 *   terraform {}                      | module     | terraform
 *
 * References inside attribute values (e.g. `bucket = aws_s3_bucket.logs.id`)
 * become unresolved references that the resolver matches by qualified name.
 */

// ---------------------------------------------------------------------------
// Module-level state type — passed to free-function helpers so they can
// mutate the extractor's accumulators without living on the class.
// ---------------------------------------------------------------------------

interface HclState {
  filePath: string;
  source: string;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  idFactory: NodeIdFactory;
}

/** Argument bundle for `emitNamedBlock` — single-label HCL blocks. */
interface NamedBlockParams {
  /** The block AST node — used for start/end position. */
  block: SyntaxNode;
  /** The block body AST node, or null when the block has no body. */
  body: SyntaxNode | null;
  /** Parent file node id — emitted as the `contains` edge source. */
  fileNodeId: string;
  /** Block labels — first label becomes the node `name`. */
  labels: string[];
  /** Graph node kind for this block (variable / module / namespace / etc.). */
  nodeKind: NodeKind;
  /** Qualified-name prefix (e.g. `var.`, `module.`, `provider.`). */
  qnPrefix: string;
  /** HCL block keyword — used in the signature and to detect `module` for source-import emission. */
  blockKind: string;
}

/**
 * Context threaded through HCL expression-walking helpers.
 * Bundles the four values every visitor needs so helpers stay under
 * the long_parameter_list threshold.
 */
interface HclExprCtx {
  st: HclState;
  node: SyntaxNode;
  bindings: ReadonlySet<string>;
  fromNodeId: string;
}

/** Argument bundle for `emitTypedBlock` — two-label HCL blocks
 *  (`resource "TYPE" "NAME"` and `data "TYPE" "NAME"`). Mirrors
 *  {@link NamedBlockParams} but without `nodeKind` (always `resource`). */
interface EmitTypedBlockArgs {
  block: SyntaxNode;
  body: SyntaxNode | null;
  fileNodeId: string;
  labels: string[];
  qnPrefix: string;
  blockKind: string;
}

/**
 * Dispatch table for {@link HclExtractor.dispatchTopLevelBlock}: maps the
 * HCL block keyword to its NodeKind / qualified-name-prefix / blockKind
 * tuple. Single source of truth for the named-block shape conventions
 * (var, module, output, provider).
 */
const NAMED_BLOCK_DISPATCH: Record<string, { nodeKind: NodeKind; qnPrefix: string; blockKind: string }> = {
  module: { nodeKind: 'module', qnPrefix: 'module.', blockKind: 'module' },
  variable: { nodeKind: 'variable', qnPrefix: 'var.', blockKind: 'variable' },
  output: { nodeKind: 'export', qnPrefix: 'output.', blockKind: 'output' },
  provider: { nodeKind: 'namespace', qnPrefix: 'provider.', blockKind: 'provider' },
};

/**
 * Heads that look like references but are Terraform built-ins / pseudo-vars,
 * not addressable graph nodes. Skipped during reference scanning.
 *
 * `terraform` is in this set because `terraform.workspace` is a built-in
 * pseudo-var. As a side effect, the `terraform {}` block node we emit
 * (qualifiedName=`terraform`) cannot be the target of a resolved reference
 * — that's intentional, since Terraform itself doesn't allow blocks to
 * reference the terraform settings block.
 */
const HCL_RESERVED_HEADS: ReadonlySet<string> = new Set([
  'count',
  'each',
  'self',
  'path',
  'terraform',
  'null',
  'true',
  'false',
]);

// ---------------------------------------------------------------------------
// Free-function emit/scan helpers
// ---------------------------------------------------------------------------

function hclUnquoteStringLit(st: HclState, node: SyntaxNode): string {
  const text = getNodeText(node, st.source);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * `resource "TYPE" "NAME" {}` and `data "TYPE" "NAME" {}` — both take two labels.
 */
function hclEmitTypedBlock(st: HclState, args: EmitTypedBlockArgs): void {
  const { block, body, fileNodeId, labels, qnPrefix, blockKind } = args;
  if (labels.length < 2) return;
  const [type, name] = labels;
  const localName = `${type}.${name}`;
  const qualifiedName = `${qnPrefix}${localName}`;
  const nodeKind: NodeKind = 'resource';
  const nodeId = st.idFactory.next(nodeKind, qualifiedName);

  const node: Node = {
    id: nodeId,
    kind: nodeKind,
    name: localName,
    qualifiedName,
    filePath: st.filePath,
    language: 'hcl',
    startLine: block.startPosition.row + 1,
    endLine: block.endPosition.row + 1,
    startColumn: block.startPosition.column,
    endColumn: block.endPosition.column,
    signature: `${blockKind} "${type}" "${name}"`,
    updatedAt: Date.now(),
  };
  st.nodes.push(node);
  st.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

  if (body) hclScanBodyForReferences(st, body, nodeId);
}

/**
 * Single-label blocks: variable, output, provider, module, plus
 * unknown kinds. `module` blocks additionally emit an `imports`
 * reference for `source = "..."`.
 */
function hclEmitNamedBlock(st: HclState, p: NamedBlockParams): void {
  const { block, body, fileNodeId, labels, nodeKind, qnPrefix, blockKind } = p;
  if (labels.length < 1) return;
  const name = labels[0]!;
  const qualifiedName = `${qnPrefix}${name}`;
  const nodeId = st.idFactory.next(nodeKind, qualifiedName);

  const node: Node = {
    id: nodeId,
    kind: nodeKind,
    name,
    qualifiedName,
    filePath: st.filePath,
    language: 'hcl',
    startLine: block.startPosition.row + 1,
    endLine: block.endPosition.row + 1,
    startColumn: block.startPosition.column,
    endColumn: block.endPosition.column,
    signature: `${blockKind} "${name}"`,
    updatedAt: Date.now(),
  };
  st.nodes.push(node);
  st.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

  if (body) {
    if (blockKind === 'module') hclEmitModuleSourceImport(st, body, nodeId);
    hclScanBodyForReferences(st, body, nodeId);
  }
}

/**
 * `locals { a = ...; b = ... }` — each top-level attribute becomes a
 * separate `constant` node with qualified name `local.<attr>`.
 */
function hclEmitLocalsBlock(st: HclState, body: SyntaxNode | null, fileNodeId: string): void {
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child?.type !== 'attribute') continue;
    const nameNode = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
    if (!nameNode) continue;
    const name = getNodeText(nameNode, st.source);
    const qualifiedName = `local.${name}`;
    const nodeId = st.idFactory.next('constant', qualifiedName);

    const node: Node = {
      id: nodeId,
      kind: 'constant',
      name,
      qualifiedName,
      filePath: st.filePath,
      language: 'hcl',
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      startColumn: child.startPosition.column,
      endColumn: child.endPosition.column,
      updatedAt: Date.now(),
    };
    st.nodes.push(node);
    st.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

    const exprNode = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'expression');
    if (exprNode) hclScanExpressionForReferences({ st, root: exprNode, fromNodeId: nodeId });
  }
}

/**
 * `terraform { ... }` — anchor block with no labels. We emit a single
 * module-kind node so the file shows up in search; nested
 * required_providers / backend blocks are not enumerated for v1.
 */
function hclEmitTerraformBlock(st: HclState, block: SyntaxNode, fileNodeId: string): void {
  const qualifiedName = 'terraform';
  const nodeId = st.idFactory.next('module', qualifiedName);
  const node: Node = {
    id: nodeId,
    kind: 'module',
    name: 'terraform',
    qualifiedName,
    filePath: st.filePath,
    language: 'hcl',
    startLine: block.startPosition.row + 1,
    endLine: block.endPosition.row + 1,
    startColumn: block.startPosition.column,
    endColumn: block.endPosition.column,
    signature: 'terraform',
    updatedAt: Date.now(),
  };
  st.nodes.push(node);
  st.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
}

/**
 * For a `module "X" { source = "..." }` block, emit an `imports` edge to
 * the source string. Cross-file resolution isn't yet HCL-aware, so we
 * emit it as an unresolved reference using the literal source value.
 */
function hclEmitModuleSourceImport(st: HclState, body: SyntaxNode, fromNodeId: string): void {
  for (const attr of body.namedChildren) {
    if (attr?.type !== 'attribute') continue;
    const nameNode = attr.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
    if (!nameNode || getNodeText(nameNode, st.source) !== 'source') continue;

    const exprNode = attr.namedChildren.find((c: SyntaxNode | null) => c?.type === 'expression');
    if (!exprNode) return;
    const literal = hclExtractStaticString(st, exprNode);
    if (literal === null) return;

    st.unresolvedReferences.push({
      fromNodeId,
      referenceName: literal,
      referenceKind: 'imports',
      line: attr.startPosition.row + 1,
      column: attr.startPosition.column,
    });
    return;
  }
}

/**
 * Scan one body child — attribute means scan its expression for refs;
 * block means recurse into the nested body.
 */
function hclScanBodyChild(st: HclState, child: SyntaxNode, fromNodeId: string): void {
  if (child.type === 'attribute') {
    const exprNode = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'expression');
    if (exprNode) hclScanExpressionForReferences({ st, root: exprNode, fromNodeId });
  } else if (child.type === 'block') {
    const nestedBody = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'body');
    if (nestedBody) hclScanBodyForReferences(st, nestedBody, fromNodeId);
  }
}

function hclScanBodyForReferences(st: HclState, body: SyntaxNode, fromNodeId: string): void {
  for (const child of body.namedChildren) {
    if (child) hclScanBodyChild(st, child, fromNodeId);
  }
}

/**
 * Walk an `expression` subtree and emit unresolved references for each
 * Terraform-style address head we find.
 *
 * Loop-bound iteration variables (e.g. `s` in `[for s in xs : s.id]`,
 * `k` and `v` in `{for k, v in m : k => v}`) are tracked in `bindings`
 * so they don't generate spurious references.
 */
interface HclScanExprArgs {
  st: HclState;
  root: SyntaxNode;
  fromNodeId: string;
  loopBindings?: ReadonlySet<string>;
}

function hclScanExpressionForReferences(args: HclScanExprArgs): void {
  const { st, root, fromNodeId, loopBindings = new Set() } = args;
  hclVisitExprNode({ st, node: root, bindings: loopBindings, fromNodeId });
}

/** Recursive walk dispatching on node.type. */
function hclVisitExprNode(ctx: HclExprCtx): void {
  const { node } = ctx;
  if (node.type === 'expression') {
    hclVisitExpressionRef(ctx);
    return;
  }
  if (node.type === 'for_tuple_expr' || node.type === 'for_object_expr') {
    hclVisitForExpr(ctx);
    return;
  }
  hclRecurseExprChildren(ctx);
}

/** Emit an unresolved-reference edge for the head of an `expression` node,
 *  then recurse into its named children. */
function hclVisitExpressionRef(ctx: HclExprCtx): void {
  const { st, node, bindings, fromNodeId } = ctx;
  const ref = hclTryExtractReference(st, node, bindings);
  if (ref) {
    st.unresolvedReferences.push({
      fromNodeId,
      referenceName: ref.name,
      referenceKind: 'references',
      line: ref.line,
      column: ref.column,
    });
  }
  hclRecurseExprChildren(ctx);
}

/** for_expr: identifiers introduced in `for_intro` are bound for the
 *  rest of the for body, but NOT for the iterable expression inside the for_intro itself. */
function hclVisitForExpr(ctx: HclExprCtx): void {
  const { node } = ctx;
  let activeBindings = ctx.bindings;
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'for_intro') {
      activeBindings = hclVisitForIntro({ ...ctx, node: child, bindings: activeBindings });
    } else {
      hclVisitExprNode({ ...ctx, node: child, bindings: activeBindings });
    }
  }
}

function hclRecurseExprChildren(ctx: HclExprCtx): void {
  const { node } = ctx;
  for (const child of node.namedChildren) {
    if (child) hclVisitExprNode({ ...ctx, node: child });
  }
}

/**
 * Process a `for_intro` node and return the binding set in scope for the
 * enclosing for-expression's body and condition.
 */
function hclVisitForIntro(ctx: HclExprCtx): ReadonlySet<string> {
  const { st, node: forIntro, bindings: outerBindings, fromNodeId } = ctx;
  const newBindings = new Set(outerBindings);
  for (const child of forIntro.namedChildren) {
    if (child?.type === 'identifier') {
      newBindings.add(getNodeText(child, st.source));
    } else if (child?.type === 'expression') {
      hclScanExpressionForReferences({ st, root: child, fromNodeId, loopBindings: outerBindings });
    }
  }
  return newBindings;
}

/**
 * Walk the `get_attr` chain after the `variable_expr` head until we
 * have enough segments to address the resource/module/var/etc.
 */
function hclWalkGetAttrChain(st: HclState, expression: SyntaxNode): string[] {
  const chain: string[] = [];
  for (let i = 1; i < expression.namedChildCount; i++) {
    const child = expression.namedChild(i);
    if (child?.type !== 'get_attr') break;
    const attrIdent = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
    if (!attrIdent) break;
    chain.push(getNodeText(attrIdent, st.source));
  }
  return chain;
}

/**
 * Build the canonical HCL address from the head identifier + the
 * walked attr chain. Returns null when the chain is too short for the kind.
 */
function hclFormatHclAddress(head: string, chain: ReadonlyArray<string>): string | null {
  if (head === 'var' || head === 'local' || head === 'module') {
    return chain.length >= 1 ? `${head}.${chain[0]}` : null;
  }
  if (head === 'data') {
    return chain.length >= 2 ? `data.${chain[0]}.${chain[1]}` : null;
  }
  return chain.length >= 1 ? `${head}.${chain[0]}` : null;
}

function hclTryExtractReference(
  st: HclState,
  expression: SyntaxNode,
  bindings: ReadonlySet<string>,
): { name: string; line: number; column: number } | null {
  if (expression.namedChildCount === 0) return null;
  const first = expression.namedChild(0);
  if (first?.type !== 'variable_expr') return null;
  const headIdent = first.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
  if (!headIdent) return null;
  const head = getNodeText(headIdent, st.source);
  if (HCL_RESERVED_HEADS.has(head) || bindings.has(head)) return null;

  const name = hclFormatHclAddress(head, hclWalkGetAttrChain(st, expression));
  if (!name) return null;
  return { name, line: first.startPosition.row + 1, column: first.startPosition.column };
}

/**
 * Pull a literal string out of an expression of the form `"..."`.
 * Returns null for interpolated, non-string, or otherwise dynamic values.
 */
function hclExtractStaticString(st: HclState, expression: SyntaxNode): string | null {
  const child = expression.namedChild(0);
  if (!child) return null;

  let container: SyntaxNode | null = null;
  if (child.type === 'literal_value') {
    const stringLit = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'string_lit');
    container = stringLit ?? null;
  } else if (child.type === 'template_expr') {
    const quoted = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'quoted_template');
    container = quoted ?? null;
  }
  if (!container) return null;

  let literal = '';
  for (const part of container.namedChildren) {
    if (!part) continue;
    if (part.type === 'template_literal') {
      literal += getNodeText(part, st.source);
    } else if (part.type === 'template_interpolation' || part.type === 'template_directive') {
      return null;
    }
  }
  return literal;
}

// ---------------------------------------------------------------------------
// Class — thin orchestrator
// ---------------------------------------------------------------------------

export class HclExtractor extends StandaloneExtractor {
  extract(): ExtractionResult {
    const startTime = Date.now();

    const parser = getParser('hcl');
    if (!parser) {
      this.errors.push({
        message: 'HCL grammar not loaded',
        severity: 'error',
        code: 'grammar_unavailable',
      });
      return this.result(startTime);
    }

    let tree: Tree | null;
    try {
      tree = parser.parse(this.source);
    } catch (e) {
      this.errors.push({
        message: `HCL parse error: ${errMsg(e)}`,
        severity: 'error',
        code: 'parse_error',
      });
      return this.result(startTime);
    }
    if (!tree) {
      this.errors.push({ message: 'HCL parse returned no tree', severity: 'error', code: 'parse_error' });
      return this.result(startTime);
    }

    try {
      const fileNodeId = this.createFileNode('hcl').id;

      const root = tree.rootNode;
      const topBody = root.namedChildren.find((c: SyntaxNode | null) => c?.type === 'body');
      if (!topBody) {
        return this.result(startTime);
      }

      for (const child of topBody.namedChildren) {
        if (child?.type !== 'block') continue;
        this.tryVisitTopLevelBlock(child, fileNodeId);
      }

      return this.result(startTime);
    } finally {
      // Free WASM heap memory — web-tree-sitter trees hold native heap
      // memory invisible to V8's GC.
      tree.delete();
    }
  }

  /** Per-block try/catch wrapper. Delegated to {@link StandaloneExtractor.tryVisit}. */
  private tryVisitTopLevelBlock(block: SyntaxNode, fileNodeId: string): void {
    this.tryVisit(block, () => this.visitTopLevelBlock(block, fileNodeId), 'HCL block extraction error: ');
  }

  /**
   * Handle a single top-level block, dispatching by block kind.
   * Block AST shape:
   *   block
   *     identifier         (the kind: "resource", "variable", ...)
   *     string_lit*        (zero, one, or two labels)
   *     body               (optional — empty `{}` blocks have no body child)
   */
  private visitTopLevelBlock(block: SyntaxNode, fileNodeId: string): void {
    const head = block.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
    if (!head) return;
    const kind = getNodeText(head, this.source);

    const labels: string[] = [];
    for (const child of block.namedChildren) {
      if (child?.type === 'string_lit') labels.push(hclUnquoteStringLit(this.state(), child));
    }
    const body = block.namedChildren.find((c: SyntaxNode | null) => c?.type === 'body') ?? null;

    this.dispatchTopLevelBlock(kind, { block, body, fileNodeId, labels });
  }

  /**
   * Dispatch a HCL block to its emitter based on `kind`.
   */
  private dispatchTopLevelBlock(
    kind: string,
    ctx: { block: SyntaxNode; body: SyntaxNode | null; fileNodeId: string; labels: string[] },
  ): void {
    const st = this.state();
    const { block, body, fileNodeId, labels } = ctx;
    if (kind === 'resource' || kind === 'data') {
      hclEmitTypedBlock(st, {
        block,
        body,
        fileNodeId,
        labels,
        qnPrefix: kind === 'data' ? 'data.' : '',
        blockKind: kind,
      });
      return;
    }
    const named = NAMED_BLOCK_DISPATCH[kind];
    if (named) {
      hclEmitNamedBlock(st, { block, body, fileNodeId, labels, ...named });
      return;
    }
    if (kind === 'locals') {
      hclEmitLocalsBlock(st, body, fileNodeId);
      return;
    }
    if (kind === 'terraform') {
      hclEmitTerraformBlock(st, block, fileNodeId);
      return;
    }
    hclEmitNamedBlock(st, {
      block,
      body,
      fileNodeId,
      labels,
      nodeKind: 'namespace',
      qnPrefix: `${kind}.`,
      blockKind: kind,
    });
  }

  /**
   * Expose mutable state to module-scope free functions. The
   * extractor class structurally satisfies {@link HclState} —
   * a `this`-as-state cast avoids per-field `this.x` reads that
   * the `field_access` extractor used to read as cross-class
   * accesses (false-positive `feature_envy` on inherited fields).
   */
  private state(): HclState {
    return this as unknown as HclState;
  }
}
