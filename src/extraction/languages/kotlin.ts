import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import { compact } from '../../utils.js';

/** True when `node` is a `user_type` whose first `type_identifier`
 *  child is the literal `interface`. Reused by the direct-child and
 *  ERROR-grandchild scans in {@link isFunInterfaceNode}. */
function isInterfaceUserType(node: SyntaxNode): boolean {
  if (node.type !== 'user_type') return false;
  const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
  return !!(typeId && typeId.text === 'interface');
}

/** Pattern 2b: a `fun interface` misparse where the `user_type("interface")`
 *  is wrapped one level deeper inside an `ERROR` child. Pulled out so the
 *  outer scanner doesn't carry a 4-deep `for/if/for/if` walker. */
function errorChildHasInterfaceType(errorNode: SyntaxNode): boolean {
  for (const gc of errorNode.children) {
    if (gc && isInterfaceUserType(gc)) return true;
  }
  return false;
}

/** Check if a node matches the `fun interface` misparse pattern */
function isFunInterfaceNode(node: SyntaxNode): boolean {
  let hasFun = false;
  let hasInterfaceType = false;
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === 'fun' && !child.isNamed) hasFun = true;
    if (isInterfaceUserType(child)) hasInterfaceType = true;
    // Pattern 2b: user_type("interface") is inside an ERROR child
    if (child.type === 'ERROR' && errorChildHasInterfaceType(child)) hasInterfaceType = true;
  }
  return hasFun && hasInterfaceType;
}

const kotlinExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // Methods are functions inside classes
  interfaceTypes: [], // Handled via classifyClassNode
  structTypes: [], // Kotlin uses data classes
  enumTypes: [], // Handled via classifyClassNode
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_header'],
  callTypes: ['call_expression'],
  variableTypes: [], // property_declaration handled in visitNode (needs variable_declaration child for name)
  fieldTypes: [], // property_declaration handled in visitNode
  extraClassNodeTypes: ['object_declaration'],
  nameField: 'simple_identifier',
  bodyField: 'function_body',
  visitNode: (node, ctx) => {
    // Handle Kotlin property_declaration (val/var).
    // Kotlin's tree-sitter grammar wraps the name in a `variable_declaration` child
    // (not a direct `name` field), so the core extractFieldFallbackByName path
    // cannot find the name. We handle it here instead.
    if (node.type === 'property_declaration') {
      const varDecl = node.namedChildren.find((c: SyntaxNode) => c.type === 'variable_declaration');
      if (!varDecl) return false; // destructuring or other unusual shape — skip
      const nameNode = varDecl.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier');
      if (!nameNode) return false;
      const name = getNodeText(nameNode, ctx.source);

      const isInClass =
        ctx.nodeStack.length > 0 &&
        (() => {
          const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
          const parentNode = ctx.nodes.find((n) => n.id === parentId);
          return (
            parentNode != null &&
            (parentNode.kind === 'class' ||
              parentNode.kind === 'trait' ||
              parentNode.kind === 'interface' ||
              parentNode.kind === 'struct' ||
              parentNode.kind === 'enum' ||
              parentNode.kind === 'module')
          );
        })();

      const bindingKind = node.namedChildren.find((c: SyntaxNode) => c.type === 'binding_pattern_kind');
      const isVal = bindingKind?.text === 'val';

      if (isInClass) {
        const typeNode = varDecl.namedChildren.find(
          (c: SyntaxNode) =>
            c.type === 'user_type' ||
            c.type === 'nullable_type' ||
            c.type === 'function_type' ||
            c.type === 'parenthesized_type',
        );
        const typeText = typeNode ? getNodeText(typeNode, ctx.source) : undefined;
        const sig = typeText ? `${isVal ? 'val' : 'var'} ${name}: ${typeText}` : `${isVal ? 'val' : 'var'} ${name}`;
        // Extract modifiers for visibility
        const modifiers = node.namedChildren.find((c: SyntaxNode) => c.type === 'modifiers');
        const visText = modifiers?.text ?? '';
        const visibility = visText.includes('private')
          ? ('private' as const)
          : visText.includes('protected')
            ? ('protected' as const)
            : visText.includes('internal')
              ? ('internal' as const)
              : ('public' as const);
        ctx.createNode({ kind: 'field', name, node, extra: compact({ signature: sig, visibility }) });
      } else {
        // Top-level or local: keep as constant (val) or variable (var)
        ctx.createNode({ kind: isVal ? 'constant' : 'variable', name, node });
      }
      return true;
    }

    // Handle Kotlin `fun interface` declarations.
    // Tree-sitter-kotlin doesn't support `fun interface` syntax (Kotlin 1.4+).
    // It produces two different misparse patterns:
    //   Pattern 1 (simple): ERROR node + sibling lambda_literal for body
    //   Pattern 2 (complex): function_declaration misparse with ERROR child
    // Skip lambda_literal bodies that were already consumed by a fun interface ERROR node
    if (node.type === 'lambda_literal') {
      const prev = node.previousSibling;
      if (prev && prev.type === 'ERROR' && isFunInterfaceNode(prev)) return true;
      return false;
    }

    if (node.type !== 'ERROR' && node.type !== 'function_declaration') return false;

    // Skip ERROR nodes that are class bodies (start with `{`). These contain parent
    // methods + trailing `fun interface` tokens. The methods are extracted via
    // resolveBody; handling the ERROR here would consume the whole body.
    if (node.type === 'ERROR') {
      const firstChild = node.child(0);
      if (firstChild && firstChild.type === '{') return false;
    }

    if (!isFunInterfaceNode(node)) return false;

    // Extract the interface name.
    // For function_declaration misparses (patterns 2a/2b), the real name is inside
    // an ERROR child — direct simple_identifier children are the misparsed method name.
    let nameText: string | null = null;
    if (node.type === 'function_declaration') {
      for (const child of node.children) {
        if (child && child.type === 'ERROR') {
          for (const gc of child.children) {
            if (gc && gc.type === 'simple_identifier') {
              nameText = gc.text;
              break;
            }
          }
          if (nameText) break;
        }
      }
    }
    // Fallback: direct simple_identifier child (Pattern 1: ERROR node at top level)
    if (!nameText) {
      for (const child of node.children) {
        if (child && child.type === 'simple_identifier') {
          nameText = child.text;
          break;
        }
      }
    }
    if (!nameText) return false;

    // Create the interface node
    const ifaceNode = ctx.createNode({ kind: 'interface', name: nameText, node });
    if (!ifaceNode) return false;

    ctx.pushScope(ifaceNode.id);

    if (node.type === 'ERROR') {
      // Pattern 1: body is in the next sibling lambda_literal
      const nextSibling = node.nextSibling;
      if (nextSibling && nextSibling.type === 'lambda_literal') {
        for (const child of nextSibling.namedChildren) {
          if (child && child.type === 'statements') {
            for (const stmt of child.namedChildren) {
              if (stmt) ctx.visitNode(stmt);
            }
          }
        }
      }
    }
    // Pattern 2 (function_declaration): nested classes are siblings at source_file level,
    // already visited by the normal traversal. The single abstract method is misparsed
    // and cannot be reliably recovered, but the interface node itself is the key value.

    ctx.popScope();
    return true;
  },
  paramsField: 'function_value_parameters',
  returnField: 'type',
  resolveBody: (node, _bodyField) => {
    // Kotlin's tree-sitter grammar doesn't use field names, so getChildByField fails.
    // Find body by type: function_body for functions/methods, class_body for classes,
    // enum_class_body for enums.
    //
    // Special case: when a class/interface contains a nested `fun interface`, tree-sitter
    // misparsed the parent's body as an ERROR node (starting with `{`) and creates
    // a class_body sibling for the nested interface's body. Prefer the ERROR body
    // so the parent's methods are extracted.
    for (const child of node.namedChildren) {
      if (child && child.type === 'ERROR') {
        const firstChild = child.child(0);
        if (firstChild && firstChild.type === '{') {
          return child;
        }
      }
      if (
        child &&
        (child.type === 'function_body' || child.type === 'class_body' || child.type === 'enum_class_body')
      ) {
        return child;
      }
    }
    return null;
  },
  classifyClassNode: (node) => {
    // Kotlin reuses class_declaration for classes, interfaces, and enums.
    // Detect by checking for keyword children:
    //   interface Foo { }       → has 'interface' keyword child
    //   enum class Level { }    → has 'enum' keyword child
    //   class / data class / abstract class → default 'class'
    for (const child of node.children) {
      if (!child) continue;
      if (child.type === 'interface') return 'interface';
      if (child.type === 'enum') return 'enum';
    }
    return 'class';
  },
  getReceiverType: (node, source) => {
    // Kotlin extension functions: fun Type.method() { }
    // AST: function_declaration > user_type, ".", simple_identifier
    // The user_type before the dot is the receiver type.
    let foundUserType: SyntaxNode | null = null;
    for (const child of node.children) {
      if (!child) continue;
      if (child.type === 'user_type') {
        foundUserType = child;
      } else if (child.type === '.' && foundUserType) {
        // The user_type before the dot is the receiver type
        const typeId = foundUserType.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        return typeId ? getNodeText(typeId, source) : getNodeText(foundUserType, source);
      } else if (child.type === 'simple_identifier' || child.type === 'function_value_parameters') {
        // Past the function name — no receiver
        break;
      }
    }
    return undefined;
  },
  getSignature: (node, source) => {
    // Kotlin function signature: fun name(params): ReturnType
    const params = getChildByField(node, 'function_value_parameters');
    const returnType = getChildByField(node, 'type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source);
    }
    return sig;
  },
  getVisibility: (node) => {
    // Check for visibility modifiers in Kotlin
    for (const child of node.children) {
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('protected')) return 'protected';
        if (text.includes('internal')) return 'internal';
      }
    }
    return 'public'; // Kotlin defaults to public
  },
  isStatic: (_node) => {
    // Kotlin doesn't have static, uses companion objects
    return false;
  },
  isAsync: (node) => {
    // Kotlin uses suspend keyword for coroutines
    for (const child of node.children) {
      if (child?.type === 'modifiers' && child.text.includes('suspend')) {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText };
    }
    return null;
  },
};

import type { LanguageDef } from './types.js';
export const KOTLIN_DEF: LanguageDef = {
  name: 'kotlin',
  displayName: 'Kotlin',
  extensions: ['.kt', '.kts'],
  includeGlobs: ['**/*.kt', '**/*.kts'],
  grammar: { wasmFile: 'kotlin.wasm', extractor: kotlinExtractor },
};
