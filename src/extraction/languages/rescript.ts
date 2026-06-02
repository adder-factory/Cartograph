import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers.js';
import type { LanguageExtractor, ExtractorContext, ImportInfo } from '../tree-sitter-types.js';
import type { NodeKind } from '../../types.js';

// ============================================================================
// Helpers (no access to ExtractorContext needed)
// ============================================================================

function findChildTextWithSource(node: SyntaxNode, childType: string, source: string): string | undefined {
  for (const child of node.namedChildren) {
    if (child?.type === childType) {
      return getNodeText(child, source);
    }
  }
  return undefined;
}

function extractDecorators(node: SyntaxNode, source: string): string[] | undefined {
  const decorators: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling?.type === 'decorator') {
    decorators.unshift(getNodeText(sibling, source));
    sibling = sibling.previousNamedSibling;
  }
  for (const child of node.namedChildren) {
    if (child?.type === 'decorator') {
      decorators.push(getNodeText(child, source));
    }
  }
  return decorators.length > 0 ? decorators : undefined;
}

function letBindingSignature(node: SyntaxNode, source: string): string | undefined {
  const body = getChildByField(node, 'body');
  if (body?.type !== 'function') return undefined;
  const params = getChildByField(body, 'parameters');
  if (!params) return undefined;
  const returnType = getChildByField(body, 'return_type');
  let sig = getNodeText(params, source);
  if (returnType) sig += ' => ' + getNodeText(returnType, source);
  return sig;
}

function externalDeclarationSignature(node: SyntaxNode, source: string): string | undefined {
  const typeAnnotation = node.namedChildren.find((child) => child?.type === 'type_annotation');
  return typeAnnotation ? getNodeText(typeAnnotation, source) : undefined;
}

// ============================================================================
// Core visitor (uses ExtractorContext)
// ============================================================================

/**
 * Handle ReScript-specific AST nodes via the visitNode hook.
 * Returns true if the node was fully handled (skip default dispatch).
 *
 * ReScript uses wrapper nodes:
 * - let_declaration → let_binding → pattern (name) + body
 * - module_declaration → module_binding → name + definition/signature
 * - type_declaration → type_binding → name + body
 * - external_declaration → value_identifier + type_annotation + string
 */
/** Per-node-type handler used by {@link RESCRIPT_NODE_HANDLERS}.
 *  Each handler receives the AST node + the extractor context and
 *  emits whatever symbols/edges that shape produces. The dispatcher
 *  treats the presence of a handler as "I handled this; stop the
 *  default visitor descent." */
type ReScriptHandler = (node: SyntaxNode, ctx: ExtractorContext) => void;

/** ERROR nodes often contain valid structures — walk their children
 *  through the same dispatcher to recover them. */
function handleReScriptErrorNode(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of node.namedChildren) {
    if (child) visitReScriptNode(child, ctx);
  }
}

function handleReScriptLetDeclaration(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const binding of node.namedChildren) {
    if (binding?.type === 'let_binding') extractLetBinding(binding, ctx);
  }
}

function handleReScriptModuleDeclaration(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const binding of node.namedChildren) {
    if (binding?.type === 'module_binding') extractModule(binding, node, ctx);
  }
}

function handleReScriptTypeDeclaration(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const binding of node.namedChildren) {
    if (binding?.type === 'type_binding') extractType(binding, node, ctx);
  }
}

function handleReScriptExceptionDeclaration(node: SyntaxNode, ctx: ExtractorContext): void {
  const name = findChildTextWithSource(node, 'variant_identifier', ctx.source);
  if (!name) return;
  ctx.createNode({
    kind: 'type_alias',
    name,
    node,
    extra: compact({
      docstring: getPrecedingDocstring(node, ctx.source),
    }),
  });
}

/** `node.type → handler` dispatch table. Replaces a 9-arm
 *  if-cascade inside {@link visitReScriptNode} so its cyclomatic
 *  complexity stays well below the warning threshold. Adding a new
 *  ReScript construct = adding one entry; the dispatcher needs no
 *  edits. */
const RESCRIPT_NODE_HANDLERS: Record<string, ReScriptHandler> = {
  ERROR: handleReScriptErrorNode,
  let_declaration: handleReScriptLetDeclaration,
  let_binding: (node, ctx) => extractLetBinding(node, ctx),
  module_declaration: handleReScriptModuleDeclaration,
  type_declaration: handleReScriptTypeDeclaration,
  type_binding: (node, ctx) => extractType(node, node, ctx),
  external_declaration: (node, ctx) => extractExternal(node, ctx),
  exception_declaration: handleReScriptExceptionDeclaration,
  pipe_expression: (node, ctx) => extractPipeCall(node, ctx),
};

function visitReScriptNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const handler = RESCRIPT_NODE_HANDLERS[node.type];
  if (!handler) return false;
  handler(node, ctx);
  return true;
}

function extractLetBinding(binding: SyntaxNode, ctx: ExtractorContext): void {
  const patternNode = getChildByField(binding, 'pattern');
  if (!patternNode) return;
  const name = getNodeText(patternNode, ctx.source);
  if (!name || name === '_') return;

  const body = getChildByField(binding, 'body');
  const docstring = getPrecedingDocstring(binding.parent || binding, ctx.source);
  const decorators = extractDecorators(binding.parent || binding, ctx.source);

  if (body?.type === 'function') {
    extractLetFunctionBinding({ binding, name, body, docstring, decorators, ctx });
    return;
  }
  extractLetVariableBinding({ binding, name, body, docstring, decorators, ctx });
}

interface LetBindingArgs {
  binding: SyntaxNode;
  name: string;
  body: SyntaxNode | null | undefined;
  docstring: string | undefined;
  decorators: string[] | undefined;
  ctx: ExtractorContext;
}

/** `let foo = (x, y) => body` shape — emit a function node, attach
 *  parameter / return type edges, then visit the body inside the
 *  function's scope so call-graph attribution lands on the function. */
function extractLetFunctionBinding(args: LetBindingArgs): void {
  const { binding, name, body, docstring, decorators, ctx } = args;
  if (!body) return;
  const params = getChildByField(body, 'parameters');
  const returnType =
    getChildByField(body, 'return_type') ?? body.namedChildren.find((c) => c.type === 'type_annotation');
  let signature: string | undefined;
  if (params) {
    signature = getNodeText(params, ctx.source);
    if (returnType) signature += ' => ' + getNodeText(returnType, ctx.source);
  }
  const funcNode = ctx.createNode({
    kind: 'function',
    name,
    node: binding.parent || binding,
    extra: compact({
      docstring,
      signature,
      decorators,
    }),
  });
  if (!funcNode) return;
  if (params) ctx.extractTypeRefs(params, funcNode.id, 'type_of');
  if (returnType) ctx.extractTypeRefs(returnType, funcNode.id, 'returns');
  const funcBody = getChildByField(body, 'body');
  if (!funcBody) return;
  ctx.pushScope(funcNode.id);
  try {
    ctx.visitFunctionBody(funcBody, funcNode.id);
  } finally {
    ctx.popScope();
  }
}

/** `let x = expr` (and `let foo: ty = expr`) shape — emit a variable
 *  node, attach the optional type annotation, visit the body for any
 *  embedded call expressions. */
function extractLetVariableBinding(args: LetBindingArgs): void {
  const { binding, name, body, docstring, decorators, ctx } = args;
  const typeAnnotation = binding.namedChildren.find((c) => c.type === 'type_annotation');
  const initValue = body ? getNodeText(body, ctx.source).slice(0, 100) : undefined;
  let initSignature: string | undefined;
  if (initValue) {
    const ellipsis = initValue.length >= 100 ? '...' : '';
    initSignature = `= ${initValue}${ellipsis}`;
  }
  const varNode = ctx.createNode({
    kind: 'variable',
    name,
    node: binding.parent || binding,
    extra: compact({
      docstring,
      signature: initSignature,
      decorators,
    }),
  });
  if (varNode && typeAnnotation) ctx.extractTypeRefs(typeAnnotation, varNode.id, 'type_of');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child) ctx.visitNode(child);
  }
}

function extractModule(binding: SyntaxNode, declNode: SyntaxNode, ctx: ExtractorContext): void {
  const nameNode = getChildByField(binding, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, ctx.source);
  const docstring = getPrecedingDocstring(declNode, ctx.source);

  const kind: NodeKind = isModuleTypeDecl(declNode) ? 'interface' : 'namespace';
  const moduleNode = ctx.createNode({ kind, name, node: declNode, extra: compact({ docstring }) });
  if (!moduleNode) return;

  const body = getChildByField(binding, 'definition') ?? getChildByField(binding, 'signature');
  if (!body) return;

  ctx.pushScope(moduleNode.id);
  walkModuleBody(body, ctx, moduleNode.id);
  ctx.popScope();
}

/** `module type X` decls carry a non-named `type` child (token, not a node). */
function isModuleTypeDecl(declNode: SyntaxNode): boolean {
  for (const child of declNode.children) {
    if (child?.type === 'type' && !child.isNamed) return true;
  }
  return false;
}

/**
 * Visit a module body — three shapes the grammar produces:
 *   - `block` — straight `{ ... }`, walk every named child.
 *   - `functor` — `(P) => { … }`, the body sits under the `body` field.
 *   - `module_expression` — `module X = Y`, emit a `references` ref to Y.
 */
function walkModuleBody(body: SyntaxNode, ctx: ExtractorContext, moduleId: string): void {
  if (body.type === 'block') {
    visitNamedChildren(body, ctx);
    return;
  }
  if (body.type === 'functor') {
    const functorBody = getChildByField(body, 'body');
    if (functorBody?.type === 'block') visitNamedChildren(functorBody, ctx);
    return;
  }
  if (body.type === 'module_expression') {
    ctx.addUnresolvedReference({
      fromNodeId: moduleId,
      referenceName: getNodeText(body, ctx.source),
      referenceKind: 'references',
      line: body.startPosition.row + 1,
      column: body.startPosition.column,
    });
  }
}

/** Walk every named child of `parent` through the main `visitNode` dispatch. */
function visitNamedChildren(parent: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of parent.namedChildren) {
    if (child) ctx.visitNode(child);
  }
}

function extractType(binding: SyntaxNode, declNode: SyntaxNode, ctx: ExtractorContext): void {
  const nameNode = getChildByField(binding, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, ctx.source);
  const docstring = getPrecedingDocstring(declNode, ctx.source);

  const kind = classifyTypeBinding(binding);
  const typeNode = ctx.createNode({ kind, name, node: declNode, extra: compact({ docstring }) });
  if (!typeNode) return;

  if (kind === 'enum') {
    ctx.pushScope(typeNode.id);
    extractVariantMembers(binding, ctx);
    ctx.popScope();
  } else if (kind === 'struct') {
    ctx.pushScope(typeNode.id);
    extractRecordFields(binding, ctx);
    ctx.popScope();
  }
}

/**
 * Sniff the binding's children for the shape that determines the
 * graph node kind: variant → enum, record → struct, anything else
 * → type_alias.
 */
function classifyTypeBinding(binding: SyntaxNode): NodeKind {
  for (const child of binding.namedChildren) {
    if (child?.type === 'variant_type' || child?.type === 'variant_declaration') return 'enum';
    if (child?.type === 'record_type') return 'struct';
  }
  return 'type_alias';
}

/**
 * Walk a variant subtree and emit one `enum_member` node per
 * `variant_declaration`. Recurses into nested `variant_type`
 * containers because the grammar wraps groups of variants in those.
 */
function extractVariantMembers(container: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of container.namedChildren) {
    if (child?.type === 'variant_type') {
      extractVariantMembers(child, ctx);
      continue;
    }
    if (child?.type !== 'variant_declaration') continue;
    const variantId = findChildTextWithSource(child, 'variant_identifier', ctx.source);
    if (variantId) ctx.createNode({ kind: 'enum_member', name: variantId, node: child });
  }
}

/**
 * Walk the binding's record-type child(ren) and emit one `field`
 * node per `record_type_field`. The grammar nests fields one level
 * deep — `binding > record_type > record_type_field` — so this is
 * a flat two-level walk rather than a recursive descent.
 */
function extractRecordFields(binding: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of binding.namedChildren) {
    if (child?.type !== 'record_type') continue;
    for (const field of child.namedChildren) {
      if (field?.type !== 'record_type_field') continue;
      const fieldName = findChildTextWithSource(field, 'property_identifier', ctx.source);
      if (fieldName) ctx.createNode({ kind: 'field', name: fieldName, node: field });
    }
  }
}

function extractExternal(node: SyntaxNode, ctx: ExtractorContext): void {
  const name = findChildTextWithSource(node, 'value_identifier', ctx.source);
  if (!name) return;

  const docstring = getPrecedingDocstring(node, ctx.source);
  const decorators = extractDecorators(node, ctx.source);

  // Build signature from type annotation
  let signature: string | undefined;
  for (const child of node.namedChildren) {
    if (child?.type === 'type_annotation') {
      signature = getNodeText(child, ctx.source);
      break;
    }
  }

  ctx.createNode({ kind: 'function', name, node, extra: compact({ docstring, signature, decorators }) });
}

function extractPipeCall(node: SyntaxNode, ctx: ExtractorContext): void {
  const callerId = ctx.nodeStack.at(-1);
  if (callerId) emitPipeCallReference(node, ctx, callerId);
  visitPipeChildren(node, ctx);
}

/** Visit every named child so nested calls inside a pipe are still extracted. */
function visitPipeChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of node.namedChildren) {
    if (child) ctx.visitNode(child);
  }
}

/** Emit the unresolved `calls` reference for a pipe expression's right-hand callee. */
function emitPipeCallReference(node: SyntaxNode, ctx: ExtractorContext, callerId: string): void {
  const children = node.namedChildren;
  if (children.length < 2) return;
  const pipedTo = children[1];
  if (!pipedTo) return;
  const calleeName = readPipeCalleeName(pipedTo, ctx.source);
  if (!calleeName) return;
  ctx.addUnresolvedReference({
    fromNodeId: callerId,
    referenceName: calleeName,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** Pull the callee-name text from a pipe RHS, unwrapping `call_expression` to its `function` field. */
function readPipeCalleeName(pipedTo: SyntaxNode, source: string): string {
  if (pipedTo.type === 'call_expression') {
    const func = getChildByField(pipedTo, 'function');
    return func ? getNodeText(func, source) : getNodeText(pipedTo, source);
  }
  return getNodeText(pipedTo, source);
}

// ============================================================================
// LanguageExtractor export
// ============================================================================

const rescriptExtractor: LanguageExtractor = {
  // ReScript uses wrapper nodes — all substantive extraction happens in visitNode.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['open_statement', 'include_statement'],
  callTypes: ['call_expression', 'pipe_expression'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  visitNode(node, ctx) {
    return visitReScriptNode(node, ctx);
  },

  extractImport(node, source): ImportInfo | null {
    // ReScript: open ModuleName, include ModuleName
    const importText = getNodeText(node, source);
    const moduleExpr = node.namedChildren.find((c) => c.type === 'module_expression');
    if (moduleExpr) {
      return { moduleName: getNodeText(moduleExpr, source), signature: importText };
    }
    const moduleId = node.namedChildren.find(
      (c) => c.type === 'module_identifier' || c.type === 'module_identifier_path',
    );
    if (moduleId) {
      return { moduleName: getNodeText(moduleId, source), signature: importText };
    }
    return null;
  },

  getSignature(node, source) {
    if (node.type === 'let_binding') return letBindingSignature(node, source);
    if (node.type === 'external_declaration') return externalDeclarationSignature(node, source);
    return undefined;
  },

  isAsync(node) {
    if (node.type === 'let_binding') {
      const body = getChildByField(node, 'body');
      if (body?.type === 'function') {
        const funcBody = getChildByField(body, 'body');
        if (funcBody?.type === 'await_expression') return true;
      }
    }
    return false;
  },
};

import type { LanguageDef } from './types.js';
import { compact } from '../../utils.js';
export const RESCRIPT_DEF: LanguageDef = {
  name: 'rescript',
  displayName: 'ReScript',
  extensions: ['.res', '.resi'],
  includeGlobs: ['**/*.res', '**/*.resi'],
  grammar: { wasmFile: 'rescript.wasm', extractor: rescriptExtractor },
};
