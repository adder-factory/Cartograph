import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getPrecedingDocstring } from '../tree-sitter-helpers.js';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types.js';

/**
 * R extraction.
 *
 * R has no `def` / `function name() {}` keyword — every function is an
 * anonymous `function_definition` whose name lives on the LHS of an
 * enclosing assignment, e.g.:
 *
 *     add <- function(a, b) a + b      # left-arrow assignment
 *     subtract = function(a, b) a - b  # equals assignment
 *     divide <<- function(a, b) a / b  # super-assignment
 *
 * The OO-flavoured framework dispatch (`functionTypes: ['function_definition']`)
 * doesn't fit because it would emit anonymous function nodes for every
 * lambda passed to `lapply` / `Map` / `purrr::map` / etc. Instead we
 * intercept top-level and nested assignments via the `visitNode` hook,
 * pull the name from the LHS, and create the function node ourselves.
 *
 * Handled forms:
 *   - `name <- function(...) body`           (and `=`, `<<-`)
 *   - `library(pkg)` / `require(pkg)`        → import nodes
 *   - `source("path/to/file.R")`             → import nodes (resolved by path)
 *   - bare and namespaced calls: `f(...)`, `pkg::f(...)`  via core extractCall
 *   - top-level non-function assignments     → constant nodes
 *
 * Right-arrow assignment (`function(...) body -> name`) is intentionally
 * ignored: the tree-sitter-r grammar parses the `->` as part of the
 * function body's last expression rather than as an outer assignment, and
 * the form is rare enough in practice that the v1 extractor doesn't try
 * to disambiguate it.
 *
 * `library()`/`require()`/`source()` calls are detected only at top level;
 * the framework's `visitFunctionBody` walker doesn't dispatch through
 * `visitNode`, so these calls inside a function body produce a `calls`
 * edge but no separate `import` node. Rare in practice — most R code
 * keeps imports at the top of the file.
 */

const ASSIGN_OPS: ReadonlySet<string> = new Set(['<-', '=', '<<-']);

const rExtractor: LanguageExtractor = {
  // Functions are detected via the assignment pattern in `visitNode`, not
  // by node type — function_definition has no name field.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  // Imports are calls (`library(pkg)` / `source(...)`) — handled in visitNode.
  importTypes: [],
  // Standard call edges work for R: `extractCall` falls back to namedChild(0)
  // which is either an `identifier`, `namespace_operator` (pkg::name), or
  // `extract_operator` (obj$method). In all three cases getNodeText gives a
  // sensible callee name.
  callTypes: ['call'],
  variableTypes: [],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  visitNode: (node, ctx) => {
    if (node.type === 'binary_operator') {
      return handleBinaryOperator(node, ctx);
    }
    if (node.type === 'call') {
      return handleCall(node, ctx);
    }
    return false;
  },
};

function handleBinaryOperator(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const operator = node.childForFieldName('operator');
  const lhs = node.childForFieldName('lhs');
  const rhs = node.childForFieldName('rhs');
  if (!operator || !lhs || !rhs) return false;
  if (!ASSIGN_OPS.has(operator.type)) return false;
  if (lhs.type !== 'identifier') return false;

  const name = getNodeText(lhs, ctx.source);
  if (!name) return false;

  if (rhs.type === 'function_definition') {
    emitFunction({ outerNode: node, funcDef: rhs, name, ctx });
    return true; // we've fully handled this subtree
  }

  if (isAtTopLevel(ctx)) {
    // Top-level non-function assignment → constant.
    // Don't return true so the core still walks the rhs for nested
    // calls / function definitions / imports.
    ctx.createNode({
      kind: 'constant',
      name,
      node,
      extra: compact({
        docstring: getPrecedingDocstring(node, ctx.source),
      }),
    });
  } else {
    // Inside a function body: local assignment → variable.
    // Don't return true — let the core still walk the rhs so that
    // nested calls inside the initializer produce edges.
    ctx.createNode({ kind: 'variable', name, node, extra: {} });
  }
  return false;
}

interface EmitFunctionArgs {
  outerNode: SyntaxNode;
  funcDef: SyntaxNode;
  name: string;
  ctx: ExtractorContext;
}

function emitFunction(args: EmitFunctionArgs): void {
  const { outerNode, funcDef, name, ctx } = args;
  const params = funcDef.namedChildren.find((c: SyntaxNode | null) => c?.type === 'parameters');
  const signature = params ? getNodeText(params, ctx.source) : undefined;

  const funcNode = ctx.createNode({
    kind: 'function',
    name,
    node: outerNode,
    extra: compact({
      docstring: getPrecedingDocstring(outerNode, ctx.source),
      signature,
    }),
  });
  if (!funcNode) return;

  // Body is the last named child of function_definition (after `parameters`).
  // It may be a `braced_expression` or any single expression for one-liners
  // like `function(x) x + 1`.
  const body = funcDef.namedChild(funcDef.namedChildCount - 1);
  if (!body || body.type === 'parameters') return;

  ctx.pushScope(funcNode.id);
  try {
    // Walk the body via ctx.visitNode so that:
    //   (a) Call edges are still extracted (tsDispatchByNodeKind handles callTypes).
    //   (b) The `visitNode` hook is invoked for every child — in particular
    //       `handleBinaryOperator` is reached for `x <- val` assignments,
    //       allowing local variable nodes to be emitted (FIX 2).
    // Note: ctx.visitFunctionBody would also extract calls but routes
    // around the extractor's visitNode hook, so inner assignments would
    // be silently dropped instead of becoming `variable` nodes.
    ctx.visitNode(body);
  } finally {
    ctx.popScope();
  }
}

function handleCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const callee = node.namedChild(0);
  if (callee?.type !== 'identifier') return false;
  const calleeName = getNodeText(callee, ctx.source);

  if (calleeName === 'library' || calleeName === 'require') {
    emitLibraryImport(node, ctx);
    // Don't return true — let the core also record the `library`/`require`
    // call as an edge so callers/callees queries surface it.
    return false;
  }
  if (calleeName === 'source') {
    emitSourceImport(node, ctx);
    return false;
  }
  return false;
}

/**
 * `library(dplyr)` and `library("dplyr")` both name a package. R's NSE means
 * the bare-identifier form is the idiomatic one, but we accept both.
 */
function emitLibraryImport(node: SyntaxNode, ctx: ExtractorContext): void {
  const args = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'arguments');
  if (!args) return;
  const firstArg = args.namedChildren.find((c: SyntaxNode | null) => c?.type === 'argument');
  if (!firstArg) return;

  const inner = firstArg.namedChild(0);
  if (!inner) return;

  let pkg: string | null = null;
  if (inner.type === 'identifier') {
    pkg = getNodeText(inner, ctx.source);
  } else if (inner.type === 'string') {
    pkg = unquoteStringNode(inner, ctx.source);
  }
  if (!pkg) return;

  ctx.createNode({
    kind: 'import',
    name: pkg,
    node,
    extra: {
      signature: getNodeText(node, ctx.source),
    },
  });
}

/**
 * `source("path/to/file.R")` brings another R file into scope. The argument
 * must be a string literal — a dynamic path is recorded as an unresolved
 * call only.
 */
function emitSourceImport(node: SyntaxNode, ctx: ExtractorContext): void {
  const args = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'arguments');
  if (!args) return;
  const firstArg = args.namedChildren.find((c: SyntaxNode | null) => c?.type === 'argument');
  if (!firstArg) return;
  const inner = firstArg.namedChild(0);
  if (inner?.type !== 'string') return;

  const path = unquoteStringNode(inner, ctx.source);
  if (!path) return;

  ctx.createNode({
    kind: 'import',
    name: path,
    node,
    extra: {
      signature: getNodeText(node, ctx.source),
    },
  });
}

/**
 * Extract the literal content of an R `string` syntax node, handling both
 * the regular `"..."` / `'...'` form and R 4.0+ raw strings: `r"(...)"`,
 * `R"[...]"`, `r"{...}"`, plus dash-delimited variants like `r"-(...)-"`.
 *
 * Tree-sitter-r exposes a `string_content` named child for regular strings
 * but not for raw strings, so we detect each case accordingly.
 */
function unquoteStringNode(node: SyntaxNode, source: string): string {
  const content = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'string_content');
  if (content) return getNodeText(content, source);

  const text = getNodeText(node, source);
  // Raw-string form: optional `r`/`R`, opening quote, dashes*, opening
  // delimiter ((|[|{), body, matching closing delimiter, same dashes,
  // closing quote.
  const m = /^[rR]"(-*)([([{])([\s\S]*)([)\]}])\1"$/.exec(text);
  if (m) {
    const [, , open, body, close] = m;
    const ok = (open === '(' && close === ')') || (open === '[' && close === ']') || (open === '{' && close === '}');
    if (ok) return body!;
  }
  // Fallback: strip surrounding `"..."` or `'...'`.
  if (text.length >= 2) {
    const first = text[0];
    const last = text.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function isAtTopLevel(ctx: ExtractorContext): boolean {
  // The file node is always at the bottom of the stack while extracting;
  // top-level program statements run with only the file node on the stack.
  return ctx.nodeStack.length <= 1;
}

import type { LanguageDef } from './types.js';
import { compact } from '../../utils.js';
export const R_DEF: LanguageDef = {
  name: 'r',
  displayName: 'R',
  extensions: ['.r'],
  includeGlobs: ['**/*.r', '**/*.R'],
  grammar: { wasmFile: 'r.wasm', extractor: rExtractor },
};
