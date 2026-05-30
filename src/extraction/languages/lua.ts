import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageDef } from './types.js';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types.js';

/**
 * Lua extraction.
 *
 * Lua is procedural with first-class tables. The
 * `@tree-sitter-grammars/tree-sitter-lua` grammar uses ONE node type,
 * `function_declaration`, for every definition form — `function foo()`,
 * `local function foo()`, `function M.foo()` (table function), and
 * `function M:foo()` (colon method). The `name` field holds an
 * `identifier`, a `dot_index_expression` (`M.foo`), or a
 * `method_index_expression` (`M:foo`); the core extractor's
 * name-by-field path renders the dotted/colon text directly.
 *
 * History: the extractor config below was rewritten 2026-05-17 after
 * the `scripts/extraction-coverage.ts` diagnostic flagged Lua at zero
 * symbols. The config had drifted — it named `function_definition_statement`
 * / `local_function_definition_statement` / `call` / `local_variable_declaration`,
 * none of which the current grammar emits (the web-tree-sitter
 * migration rebuilt `lua.wasm` from a grammar with a different node
 * vocabulary). The correct types are `function_declaration` /
 * `function_call` / `variable_declaration`.
 *
 * Strategy:
 *   - `functionTypes: ['function_declaration']` — covers three of the
 *     four definition forms (`function f`, `local function f`,
 *     `function M.f`) as `function`. The fourth, `function M:f()`
 *     (colon syntax), is intercepted in `visitNode` and promoted to a
 *     `method` node — the colon is Lua's unambiguous method sugar, so
 *     this is precise, not a naming-convention guess. There is still
 *     no `class` container (the grammar has none); a `method` is
 *     `contains`-linked to the file like the other top-level forms.
 *   - `callTypes: ['function_call']` — the callee is the `name` field,
 *     args are the `arguments` field.
 *   - `variable_declaration` (`local x = …`) — extracted via the
 *     `visitNode` hook: walk `assignment_statement > variable_list`
 *     and emit each LHS `identifier` as a `variable` or `function`
 *     depending on whether the RHS is a `function_definition`. The
 *     hook returns `false` so the core still recurses into the RHS
 *     for non-function assignments — call and `require` references
 *     nested in the initializer are not lost.
 *   - `assignment_statement` (global, no `local`) — handled in
 *     `visitNode` when the RHS is a `function_definition`; produces a
 *     `function` node. This also covers the forward-declare pattern
 *     (`local encode` then later `encode = function(...)`). Returns
 *     `true` for function assignments so the core doesn't double-visit.
 *   - `require("foo")` / `require "foo"` — emitted as an `import` node
 *     whose name is the module string. Detected as a `function_call`
 *     whose `name`-field text equals `require`.
 *
 * Out of scope (v1):
 * - A `class` / table-as-type container node — `method`s and dotted
 *   `function`s are `contains`-linked to the file, not to `M`.
 * - Anonymous functions assigned to fields (`M.run = function() … end`
 *   when M.run is a dotted/indexed LHS — only simple identifier LHS is
 *   promoted to a `function` node).
 * - `dofile` / `loadfile`, `package.path` indirection.
 */

const luaExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['function_call'],
  variableTypes: [],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node, source) => {
    const name = node.childForFieldName('name')?.text ?? '';
    if (!name) return undefined;
    // The grammar's `parameters` node text already includes its
    // surrounding parens (`(value)`), so don't re-wrap.
    const paramsNode = node.childForFieldName('parameters');
    const params = paramsNode ? getNodeText(paramsNode, source) : '()';
    return `function ${name}${params}`;
  },

  visitNode: (node, ctx) => {
    // `function M:foo()` — the colon syntax is Lua's unambiguous
    // method-definition sugar (`foo` gets an implicit `self`). The
    // `name` field is a `method_index_expression`; promote it to a
    // `method` node. The other three `function_declaration` forms
    // (`function f`, `function M.f`, anonymous) fall through to the
    // core's `functionTypes` dispatch as plain `function`s.
    if (node.type === 'function_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.type === 'method_index_expression') {
        emitLuaColonMethod(node, ctx);
        return true; // handled — skip the core's `function` dispatch
      }
      return false;
    }
    if (node.type === 'variable_declaration') {
      const handledFunctions = emitLuaLocalDecl(node, ctx);
      // Return false — let the core recurse into the initializer so
      // calls / `require` nested in the RHS still produce edges.
      // For `function_definition` RHS, the body was already walked by
      // emitLuaLocalDecl via visitFunctionBody, and returning false
      // here won't re-emit a duplicate — the core won't dispatch on
      // `function_definition` because there's no matching functionType.
      void handledFunctions;
      return false;
    }
    // Global (non-`local`) assignment: `name = function(...)`.
    // Also covers the forward-declare pattern: `local encode` then
    // later `encode = function(...)`.
    if (node.type === 'assignment_statement') {
      if (tryEmitLuaGlobalFunctionAssign(node, ctx)) {
        // We fully handled this assignment as a function — stop recursion.
        return true;
      }
      // Otherwise let the core recurse (handles RHS calls, requires, etc.)
      return false;
    }
    if (node.type === 'function_call') {
      const fnText = node.childForFieldName('name')?.text?.trim() ?? '';
      if (fnText === 'require') {
        emitLuaRequire(node, ctx);
        // Don't `return true` — the core still emits the call edge to
        // the stdlib `require` alongside the import node emitted here.
      }
    }
    return false;
  },
};

/** Render a `signature` field for a lua `local` declaration, with a
 *  trailing ellipsis when the value text was clipped at 100 chars. */
function formatLuaSignature(initText: string): string | undefined {
  if (!initText) return undefined;
  const ellipsis = initText.length >= 100 ? '...' : '';
  return `= ${initText}${ellipsis}`;
}

/**
 * Emit a Lua `local x = …` declaration as one node per LHS identifier
 * (Lua supports `local a, b, c = …`). When the i-th RHS value is a
 * `function_definition` the node is emitted as `function` (with the body
 * walked for call edges); otherwise it is emitted as `variable`.
 *
 * The grammar shape is:
 *   `variable_declaration > assignment_statement > {variable_list, expression_list}`
 * `variable_list` holds the LHS `identifier`s; `expression_list` holds
 * the RHS values, paired by index.
 *
 * Returns the set of names emitted as functions (informational only).
 */
function emitLuaLocalDecl(node: SyntaxNode, ctx: ExtractorContext): Set<string> {
  const emittedFunctions = new Set<string>();
  const assign = findChildOfType(node, 'assignment_statement') ?? node;
  const nameList = findChildOfType(assign, 'variable_list');
  if (!nameList) return emittedFunctions;
  const valueList = findChildOfType(assign, 'expression_list');
  // Materialise both child arrays up front — `namedChild(i)` is O(i)
  // in web-tree-sitter, so the prior `for (i; i<count; i++)` shape with
  // `nameList.namedChild(i)` + `valueList?.namedChild(i)` was O(n²) on
  // the parent's children (Schlemiel the Painter). One array read each
  // is O(n) and matches the index-paired semantics below.
  const idents = nameList.namedChildren;
  const values = valueList?.namedChildren ?? [];
  for (let i = 0; i < idents.length; i++) {
    const ident = idents[i];
    if (!ident) continue;
    const name = getNodeText(ident, ctx.source).trim();
    if (!name) continue;
    // Pair the i-th name with the i-th value; fall back to the sole
    // value for the `local a, b = makepair()` shape.
    const valueNode = values[i] ?? values[0] ?? null;
    if (valueNode?.type === 'function_definition') {
      emitLuaFunctionFromAssign({ assignNode: node, funcDef: valueNode, name, ctx });
      emittedFunctions.add(name);
    } else {
      const initText = valueNode ? getNodeText(valueNode, ctx.source).slice(0, 100) : '';
      const signature = formatLuaSignature(initText);
      ctx.createNode({ kind: 'variable', name, node: ident, extra: signature ? { signature } : {} });
    }
  }
  return emittedFunctions;
}

/**
 * For a bare (non-`local`) `assignment_statement` whose sole LHS is a
 * simple identifier and whose RHS is a `function_definition`, emit a
 * `function` node. This covers:
 *   - Module-pattern: `M.encode = function(...)`  (skipped — dotted LHS)
 *   - Forward-declare: `local encode` then `encode = function(...)`
 *   - Top-level: `encode = function(...)`
 *
 * Returns `true` when the assignment was handled as a function
 * (caller should stop core recursion for this node).
 */
function tryEmitLuaGlobalFunctionAssign(node: SyntaxNode, ctx: ExtractorContext): boolean {
  // If this assignment_statement is the inner node of a `variable_declaration`
  // (the `local x = ...` form), it is already handled by emitLuaLocalDecl
  // when the visitNode hook processes the parent. Returning false here lets
  // the core recurse into the value list for non-function initialisers
  // (calls, require refs, etc.) without double-emitting function nodes.
  if (node.parent?.type === 'variable_declaration') return false;

  const nameList = findChildOfType(node, 'variable_list');
  const valueList = findChildOfType(node, 'expression_list');
  if (!nameList || !valueList) return false;
  // Only handle the single-identifier LHS case (e.g. `encode = function`).
  // Dotted LHS (`M.foo = function`) has a `dot_index_expression` child —
  // skip those; they'll be covered when we have field/table tracking.
  if (nameList.namedChildCount !== 1) return false;
  const ident = nameList.namedChild(0);
  if (ident?.type !== 'identifier') return false;
  // Only handle function_definition RHS (single value).
  if (valueList.namedChildCount !== 1) return false;
  const funcDef = valueList.namedChild(0);
  if (funcDef?.type !== 'function_definition') return false;

  const name = getNodeText(ident, ctx.source).trim();
  if (!name) return false;
  emitLuaFunctionFromAssign({ assignNode: node, funcDef, name, ctx });
  return true;
}

interface LuaFunctionAssignArgs {
  assignNode: SyntaxNode;
  funcDef: SyntaxNode;
  name: string;
  ctx: ExtractorContext;
}

/**
 * Create a `function` node for a `local name = function(...)` or
 * `name = function(...)` assignment, walk its body for call edges,
 * and set up the scope correctly.
 *
 * `assignNode` is used for the node's position (the outer `local` or
 * assignment statement). `funcDef` is the `function_definition` value node.
 */
function emitLuaFunctionFromAssign(args: LuaFunctionAssignArgs): void {
  const { assignNode, funcDef, name, ctx } = args;
  // Parameters are the first named child of function_definition;
  // body (block) is the last named child.
  const params = findChildOfType(funcDef, 'parameters');
  const paramsText = params ? getNodeText(params, ctx.source) : '()';
  const signature = `function ${name}${paramsText}`;

  const funcNode = ctx.createNode({
    kind: 'function',
    name,
    node: assignNode,
    extra: { signature },
  });
  if (!funcNode) return;

  // Walk the body so calls and nested declarations inside the function
  // produce edges attributed to this function node.
  const body = funcDef.namedChild(funcDef.namedChildCount - 1);
  // Sanity check: the last named child should be the `block`, not the
  // `parameters` node (that would happen if there's no body — unlikely
  // but guard defensively).
  if (!body || body.type === 'parameters') return;

  ctx.pushScope(funcNode.id);
  try {
    ctx.visitFunctionBody(body, funcNode.id);
  } finally {
    ctx.popScope();
  }
}

/**
 * Emit a `function M:foo()` colon-method declaration as a `method`
 * node, then walk its body so calls inside it produce edges. The colon
 * syntax is unambiguous (Lua desugars `function M:foo()` to
 * `function M.foo(self)`), so this is a precise promotion, not a
 * naming-convention guess. The node name keeps the full `M:foo` text —
 * consistent with how the dotted form is named `M.foo`.
 */
function emitLuaColonMethod(node: SyntaxNode, ctx: ExtractorContext): void {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? getNodeText(nameNode, ctx.source).trim() : '';
  if (!name) return;
  const params = node.childForFieldName('parameters');
  const paramsText = params ? getNodeText(params, ctx.source) : '()';

  const methodNode = ctx.createNode({
    kind: 'method',
    name,
    node,
    extra: { signature: `function ${name}${paramsText}` },
  });
  if (!methodNode) return;

  const body = node.childForFieldName('body');
  if (!body) return;
  ctx.pushScope(methodNode.id);
  try {
    ctx.visitFunctionBody(body, methodNode.id);
  } finally {
    ctx.popScope();
  }
}

/**
 * Emit `require("module")` or `require "module"` as an `import` node.
 * Both forms put the argument under an `arguments` node; anything more
 * dynamic than a string literal (variable lookups, concatenation) is
 * skipped — the import name must be statically known for the resolver.
 */
function emitLuaRequire(callNode: SyntaxNode, ctx: ExtractorContext): void {
  const args = callNode.childForFieldName('arguments');
  if (!args) return;
  const first = args.namedChild(0);
  if (!first) return;
  const moduleName = readLuaStringLiteral(first, ctx.source);
  if (!moduleName) return;
  ctx.createNode({
    kind: 'import',
    name: moduleName,
    node: callNode,
    extra: {
      signature: getNodeText(callNode, ctx.source),
    },
  });
}

/**
 * Return the literal text of a Lua string node, or null when the
 * shape isn't a simple literal. Lua strings are `"…"`, `'…'`, or
 * `[[…]]` (long-bracket); concatenated / interpolated forms surface
 * as other node types and return null here.
 */
function readLuaStringLiteral(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'string') return null;
  const text = getNodeText(node, source);
  // Strip surrounding quotes / long-bracket delimiters cheaply.
  if (text.length >= 2) {
    const first = text[0];
    const last = text.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
    if (text.startsWith('[[') && text.endsWith(']]')) {
      return text.slice(2, -2);
    }
  }
  return null;
}

function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const c of node.namedChildren) {
    if (c?.type === type) return c;
  }
  return null;
}

export const LUA_DEF: LanguageDef = {
  name: 'lua',
  displayName: 'Lua',
  extensions: ['.lua'],
  includeGlobs: ['**/*.lua'],
  // Loaded as lua.wasm by web-tree-sitter from src/extraction/wasm/. Source upstream:
  // tree-sitter-grammars/tree-sitter-lua (MIT).
  grammar: { wasmFile: 'lua.wasm', extractor: luaExtractor },
};
