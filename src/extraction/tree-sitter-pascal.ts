/**
 * Pascal-specific extraction helpers.
 *
 * Extracted from `TreeSitterExtractor` so the main class doesn't
 * carry 22 Pascal-only methods on top of its language-agnostic
 * orchestration. The helpers operate on the extractor instance
 * directly via its @internal fields — Pascal-specific state
 * (the methodIndex lookup map for defProc to declaration
 * resolution) lives on the extractor itself, not here, so this
 * module can stay stateless and the existing lazy-init semantics
 * are preserved.
 *
 * Two entry points the orchestrator cares about:
 *   - visitPascalNode(extractor, node) — language-specific
 *     dispatch from the top-level visitNode switch. Returns
 *     true when the node was handled, false to fall through
 *     to the generic dispatch.
 *   - visitPascalBlock(extractor, node) — recursive begin..end
 *     traversal looking for nested calls (also used internally
 *     by extractPascalDefProc when walking implementation bodies).
 *
 * All other helpers are package-internal — the dispatcher's switch
 * is the only place they're entered.
 */

import * as path from 'node:path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from './tree-sitter-helpers.js';
import { compact } from '../utils.js';
import type { Node } from '../types.js';
import type { TreeSitterExtractor } from './tree-sitter.js';

/**
 * Top-level Pascal dispatch. Mirrors the original switch on
 * `node.type` — returns `true` when the node was recognised, else
 * `false` so the caller can fall through to generic handling.
 */
/**
 * Lookup table from Pascal AST node kind to its extractor. Notes:
 *  - unit/program/library all build the module node
 *  - declType wraps declClass / declIntf / declEnum / type-alias —
 *    the name lives on declType, the inner node determines the kind
 *  - defProc is the implementation-section body — extract calls
 *    without creating a duplicate node (the declaration owns it)
 *  - declTypes/declSection/interface/implementation are containers;
 *    just walk every named child through the main dispatch
 */
const PASCAL_HANDLERS: Record<string, (e: TreeSitterExtractor, n: SyntaxNode) => void> = {
  unit: extractPascalUnit,
  program: extractPascalUnit,
  library: extractPascalUnit,
  declType: extractPascalDeclType,
  declUses: extractPascalUses,
  declConsts: extractPascalDeclConsts,
  declConst: extractPascalConst,
  declVars: extractPascalDeclVars,
  defProc: extractPascalDefProc,
  declProp: extractPascalDeclProp,
  declField: extractPascalDeclField,
  exprCall: extractPascalCall,
  block: visitPascalBlock,
  declTypes: visitPascalNamedChildren,
  declSection: visitPascalNamedChildren,
  interface: visitPascalNamedChildren,
  implementation: visitPascalNamedChildren,
};

export function visitPascalNode(extractor: TreeSitterExtractor, node: SyntaxNode): boolean {
  const handler = PASCAL_HANDLERS[node.type];
  if (!handler) return false;
  handler(extractor, node);
  return true;
}

/** Walk every named child through the main `visitNode` dispatch. */
function visitPascalNamedChildren(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  for (const child of node.namedChildren) {
    if (child) extractor.visitNode(child);
  }
}

function extractPascalUnit(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  const moduleNameNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'moduleName');
  const name = moduleNameNode ? getNodeText(moduleNameNode, extractor.source) : '';
  // Fallback to filename without extension when the module name is empty.
  const moduleName = name || path.basename(extractor.filePath).replace(/\.[^.]+$/, '');
  extractor.createNode({ kind: 'module', name: moduleName, node });
  visitPascalNamedChildren(extractor, node);
}

function extractPascalDeclConsts(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  for (const child of node.namedChildren) {
    if (child?.type === 'declConst') {
      extractPascalConst(extractor, child);
    }
  }
}

function extractPascalDeclVars(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  for (const child of node.namedChildren) {
    if (child?.type !== 'declVar') continue;
    const nameNode = getChildByField(child, 'name');
    if (!nameNode) continue;
    const name = getNodeText(nameNode, extractor.source);
    extractor.createNode({ kind: 'variable', name, node: child });
  }
}

function extractPascalDeclProp(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, extractor.source);
  const visibility = extractor.extractor!.getVisibility?.(node);
  extractor.createNode({ kind: 'property', name, node, extra: compact({ visibility }) });
}

function extractPascalDeclField(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, extractor.source);
  const visibility = extractor.extractor!.getVisibility?.(node);
  extractor.createNode({ kind: 'field', name, node, extra: compact({ visibility }) });
}

/**
 * Extract a Pascal declType node (class, interface, enum, or type alias)
 */
function extractPascalDeclType(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, extractor.source);

  const declClass = node.namedChildren.find((c: SyntaxNode) => c.type === 'declClass');
  if (declClass) {
    extractPascalClassDecl({ extractor, name, declClass, declTypeNode: node });
    return;
  }

  const declIntf = node.namedChildren.find((c: SyntaxNode) => c.type === 'declIntf');
  if (declIntf) {
    extractPascalInterfaceDecl({ extractor, name, declIntf, declTypeNode: node });
    return;
  }

  const typeChild = node.namedChildren.find((c: SyntaxNode) => c.type === 'type');
  if (typeChild) {
    extractPascalEnumOrAlias({ extractor, name, typeChild, declTypeNode: node });
    return;
  }

  // Fallback: forward declaration or simple alias.
  extractor.createNode({ kind: 'type_alias', name, node });
}

interface PascalClassDeclArgs {
  extractor: TreeSitterExtractor;
  name: string;
  declClass: SyntaxNode;
  declTypeNode: SyntaxNode;
}

/** Pascal `type Foo = class … end;` — emit class node, walk inheritance + body. */
function extractPascalClassDecl(args: PascalClassDeclArgs): void {
  const { extractor, name, declClass, declTypeNode } = args;
  const classNode = extractor.createNode({ kind: 'class', name, node: declTypeNode });
  if (!classNode) return;
  extractPascalInheritance(extractor, declClass, classNode.id);
  extractor.nodeStack.push(classNode.id);
  try {
    for (const child of declClass.namedChildren) {
      if (child) extractor.visitNode(child);
    }
  } finally {
    extractor.nodeStack.pop();
  }
}

interface PascalInterfaceDeclArgs {
  extractor: TreeSitterExtractor;
  name: string;
  declIntf: SyntaxNode;
  declTypeNode: SyntaxNode;
}

/** Pascal `type Foo = interface … end;` — emit interface node, walk members. */
function extractPascalInterfaceDecl(args: PascalInterfaceDeclArgs): void {
  const { extractor, name, declIntf, declTypeNode } = args;
  const ifaceNode = extractor.createNode({ kind: 'interface', name, node: declTypeNode });
  if (!ifaceNode) return;
  extractor.nodeStack.push(ifaceNode.id);
  try {
    for (const child of declIntf.namedChildren) {
      if (child) extractor.visitNode(child);
    }
  } finally {
    extractor.nodeStack.pop();
  }
}

/**
 * Pascal `type Foo = (A, B, C);` (enum) or `type Foo = string;`
 * (simple alias). The grammar wraps both inside a `type` node, so
 * we sub-dispatch on whether a `declEnum` child is present.
 */
interface PascalEnumOrAliasArgs {
  extractor: TreeSitterExtractor;
  name: string;
  typeChild: SyntaxNode;
  declTypeNode: SyntaxNode;
}

function extractPascalEnumOrAlias(args: PascalEnumOrAliasArgs): void {
  const { extractor, name, typeChild, declTypeNode } = args;
  const declEnum = typeChild.namedChildren.find((c: SyntaxNode) => c.type === 'declEnum');
  if (!declEnum) {
    // Simple type alias: `type TFoo = string` / `type TFoo = Integer`.
    extractor.createNode({ kind: 'type_alias', name, node: declTypeNode });
    return;
  }
  const enumNode = extractor.createNode({ kind: 'enum', name, node: declTypeNode });
  if (!enumNode) return;
  extractor.nodeStack.push(enumNode.id);
  try {
    for (const child of declEnum.namedChildren) {
      if (child?.type !== 'declEnumValue') continue;
      const memberName = getChildByField(child, 'name');
      if (memberName) {
        extractor.createNode({ kind: 'enum_member', name: getNodeText(memberName, extractor.source), node: child });
      }
    }
  } finally {
    extractor.nodeStack.pop();
  }
}

/** Extract Pascal uses clause into individual import nodes. */
function extractPascalUses(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  const importText = getNodeText(node, extractor.source).trim();
  for (const child of node.namedChildren) {
    if (child?.type !== 'moduleName') continue;
    const unitName = getNodeText(child, extractor.source);
    extractor.createNode({ kind: 'import', name: unitName, node: child, extra: { signature: importText } });
    pushPascalUsesImportRef(extractor, child, unitName);
  }
}

/** Push the resolver-side `imports` reference linking the enclosing
 *  scope to the named Pascal unit. Returns silently when no scope is
 *  on the stack — top-level uses-clauses without a containing
 *  program/unit have no source to attribute the import to. Pulled out
 *  of {@link extractPascalUses} so the for-loop body doesn't sit
 *  4-deep around the push. */
function pushPascalUsesImportRef(extractor: TreeSitterExtractor, child: SyntaxNode, unitName: string): void {
  if (extractor.nodeStack.length === 0) return;
  const parentId = extractor.nodeStack[extractor.nodeStack.length - 1];
  if (!parentId) return;
  extractor.unresolvedReferences.push({
    fromNodeId: parentId,
    referenceName: unitName,
    referenceKind: 'imports',
    line: child.startPosition.row + 1,
    column: child.startPosition.column,
  });
}

/** Extract a Pascal constant declaration. */
function extractPascalConst(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, extractor.source);
  const defaultValue = node.namedChildren.find((c: SyntaxNode) => c.type === 'defaultValue');
  const sig = defaultValue ? getNodeText(defaultValue, extractor.source) : undefined;
  extractor.createNode({ kind: 'constant', name, node, extra: compact({ signature: sig }) });
}

/** Extract Pascal inheritance (extends / implements) from declClass typeref children. */
function extractPascalInheritance(extractor: TreeSitterExtractor, declClass: SyntaxNode, classId: string): void {
  const typerefs = declClass.namedChildren.filter((c: SyntaxNode) => c.type === 'typeref');
  for (let i = 0; i < typerefs.length; i++) {
    const ref = typerefs[i]!;
    const name = getNodeText(ref, extractor.source);
    extractor.unresolvedReferences.push({
      fromNodeId: classId,
      referenceName: name,
      referenceKind: i === 0 ? 'extends' : 'implements',
      line: ref.startPosition.row + 1,
      column: ref.startPosition.column,
    });
  }
}

/**
 * Extract calls and resolve method context from a Pascal defProc
 * (implementation body). Does not create a new node — the
 * declaration was already captured from the interface section.
 */
function extractPascalDefProc(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  const declProc = node.namedChildren.find((c: SyntaxNode) => c.type === 'declProc');
  if (!declProc) return;

  const nameNode = getChildByField(declProc, 'name');
  if (!nameNode) return;
  const fullName = getNodeText(nameNode, extractor.source).trim();
  const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;

  const methodIndex = getOrBuildMethodIndex(extractor);
  const parentId =
    methodIndex.get(fullName.toLowerCase()) ||
    methodIndex.get(shortName.toLowerCase()) ||
    extractor.nodeStack[extractor.nodeStack.length - 1];
  if (!parentId) return;

  const block = node.namedChildren.find((c: SyntaxNode) => c.type === 'block');
  if (!block) return;
  extractor.nodeStack.push(parentId);
  try {
    visitPascalBlock(extractor, block);
  } finally {
    extractor.nodeStack.pop();
  }
}

/**
 * Lazy-built lower-cased name → node-id index used to resolve a
 * Pascal `defProc` body (sitting in the implementation section)
 * to the matching declaration captured earlier in the interface
 * section. Built O(n) on first use, then O(1) per lookup.
 */
function getOrBuildMethodIndex(extractor: TreeSitterExtractor): Map<string, string> {
  if (extractor.methodIndex) return extractor.methodIndex;
  extractor.methodIndex = new Map();
  for (const n of extractor.nodes) {
    if (n.kind !== 'method' && n.kind !== 'function') continue;
    indexShortName(extractor.methodIndex, n);
    if (n.kind === 'method') indexQualifiedSuffixes(extractor.methodIndex, n);
  }
  return extractor.methodIndex;
}

/** First-seen-wins bare-name mapping (`create` → first method's id). */
function indexShortName(methodIndex: Map<string, string>, n: Node): void {
  const nameKey = n.name.toLowerCase();
  if (!methodIndex.has(nameKey)) methodIndex.set(nameKey, n.id);
}

/** Suffix paths for `Foo::Bar::baz` → `bar.baz` and `foo.bar.baz`. */
function indexQualifiedSuffixes(methodIndex: Map<string, string>, n: Node): void {
  const qualifiedParts = n.qualifiedName.split('::');
  if (qualifiedParts.length < 2) return;
  for (let i = 0; i < qualifiedParts.length - 1; i++) {
    const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
    methodIndex.set(scopedName, n.id);
  }
}

/** Extract function calls from a Pascal expression. */
function extractPascalCall(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  if (extractor.nodeStack.length === 0) return;
  const callerId = extractor.nodeStack[extractor.nodeStack.length - 1];
  if (!callerId) return;

  const firstChild = node.namedChild(0);
  if (!firstChild) return;

  let calleeName = '';
  if (firstChild.type === 'exprDot') {
    // Qualified call: Obj.Method(...)
    const identifiers = firstChild.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier');
    if (identifiers.length > 0) {
      calleeName = identifiers.map((id: SyntaxNode) => getNodeText(id, extractor.source)).join('.');
    }
  } else if (firstChild.type === 'identifier') {
    calleeName = getNodeText(firstChild, extractor.source);
  }

  if (calleeName) {
    extractor.unresolvedReferences.push({
      fromNodeId: callerId,
      referenceName: calleeName,
      referenceKind: 'calls',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  const args = node.namedChildren.find((c: SyntaxNode) => c.type === 'exprArgs');
  if (args) visitPascalBlock(extractor, args);
}

/**
 * `exprDot` chains like `Obj.Method()` wrap an exprCall as one of
 * their named children. Walk the immediate children only — deeper
 * exprCalls inside argument expressions are picked up via the outer
 * recursion.
 */
function extractCallsFromExprDot(extractor: TreeSitterExtractor, dotNode: SyntaxNode): void {
  for (const grandchild of dotNode.namedChildren) {
    if (grandchild?.type === 'exprCall') extractPascalCall(extractor, grandchild);
  }
}

/** Recursively visit a Pascal block / statement tree for call expressions. */
function visitPascalBlock(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'exprCall') extractPascalCall(extractor, child);
    else if (child.type === 'exprDot') extractCallsFromExprDot(extractor, child);
    else visitPascalBlock(extractor, child);
  }
}
