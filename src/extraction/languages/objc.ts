/**
 * Objective-C language extractor (F#65, B8).
 *
 * Adapted from upstream commit 61153f96 (PR #165) with the audit
 * corrections applied at port time:
 *
 *  - Schlemiel `for (i; i<namedChildCount; i++) node.namedChild(i)`
 *    loops replaced with `node.namedChildren.find()` per this fork's
 *    `accidental_quadratic` biomarker rule (B17).
 *  - `./languages/objc` added to EXTRACTION_LOGIC_VERSION's spec set
 *    (F#41) — done in extraction-logic-version.ts.
 *
 * Multi-keyword ObjC selector reconstruction (`doThing:with:` for
 * `- (void)doThing:(id)x with:(id)y { ... }`) is wired through the
 * new `resolveName` hook on `LanguageExtractor`. The same hook is
 * what closes the F#67 "message_expression call name" bug class.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import { rewriteReactNativeMacros } from '../objc-macro-rewrite.js';

function findCompoundStatement(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((c: SyntaxNode) => c.type === 'compound_statement') ?? null;
}

/** Build the ObjC selector: `greet`, `doThing:`, or `doThing:with:`. */
function extractObjcMethodName(node: SyntaxNode, source: string): string | undefined {
  if (node.type !== 'method_definition' && node.type !== 'method_declaration') {
    return undefined;
  }
  const identifiers = node.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier');
  if (identifiers.length === 0) return undefined;

  const hasParameters = node.namedChildren.some((c: SyntaxNode) => c.type === 'method_parameter');
  const firstIdentifier = identifiers[0];
  if (!firstIdentifier) return undefined;
  if (!hasParameters) {
    return getNodeText(firstIdentifier, source);
  }
  // Multi-keyword selector: `a:b:c:` from `- (T)a:(X)x b:(Y)y c:(Z)z`.
  return identifiers.map((id) => `${getNodeText(id, source)}:`).join('');
}

function extractObjcPropertyName(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'property_declaration') return null;

  const structDecl = node.namedChildren.find((c: SyntaxNode) => c.type === 'struct_declaration');
  if (!structDecl) return null;

  const structDeclarator = structDecl.namedChildren.find((c: SyntaxNode) => c.type === 'struct_declarator');
  if (!structDeclarator) return null;

  let current: SyntaxNode | null = structDeclarator;
  while (current) {
    const inner: SyntaxNode | undefined =
      getChildByField(current, 'declarator') ??
      current.namedChildren.find((c: SyntaxNode) => c.type === 'identifier' || c.type === 'pointer_declarator');
    if (!inner) break;
    if (inner.type === 'identifier') {
      return getNodeText(inner, source);
    }
    current = inner;
  }
  return null;
}

const objcExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  // Only @interface emits a class node; @implementation reuses it via visitNode.
  classTypes: ['class_interface'],
  methodTypes: ['method_definition'],
  interfaceTypes: ['protocol_declaration'],
  interfaceKind: 'protocol',
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'],
  importTypes: ['preproc_include'],
  callTypes: ['call_expression', 'message_expression'],
  variableTypes: ['declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveName: extractObjcMethodName,
  extractPropertyName: extractObjcPropertyName,
  resolveBody: (node, bodyField) => {
    const fromField = getChildByField(node, bodyField);
    if (fromField) return fromField;
    return findCompoundStatement(node);
  },
  resolveTypeAliasKind: (node, _source) => {
    const enumSpec = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'enum_specifier' && getChildByField(c, 'body'),
    );
    if (enumSpec) return 'enum';
    const structSpec = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'struct_specifier' && getChildByField(c, 'body'),
    );
    if (structSpec) return 'struct';
    return undefined;
  },
  isStatic: (node) => /^\s*\+/.test(node.text),
  visitNode: (node, ctx: ExtractorContext) => {
    if (node.type !== 'class_implementation') return false;

    const classNameNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (!classNameNode) return true;

    const className = getNodeText(classNameNode, ctx.source);
    const classNode =
      ctx.nodes.find((n) => n.name === className && n.filePath === ctx.filePath && n.kind === 'class') ??
      ctx.createNode({ kind: 'class', name: className, node, extra: {} });
    if (!classNode) return true;

    ctx.pushScope(classNode.id);
    for (const child of node.namedChildren) {
      if (child.type !== 'implementation_definition') continue;
      for (const implChild of child.namedChildren) {
        ctx.visitNode(implChild);
      }
    }
    ctx.popScope();
    return true;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};

import type { LanguageDef } from './types.js';
export const OBJC_DEF: LanguageDef = {
  name: 'objc',
  displayName: 'Objective-C',
  // `.h` is owned by C_DEF (extension map first match wins). When a
  // `.h` file's source contains ObjC declarations (@interface /
  // @implementation / @protocol / @synthesize), `detectLanguage`'s
  // content-heuristic branch reroutes it to 'objc' via `looksLikeObjc`
  // before the C/C++ split. Listing `.h` here would make the
  // extension-map lookup return objc unconditionally, defeating the
  // heuristic and causing every pure-C header to be misclassified.
  extensions: ['.m', '.mm'],
  includeGlobs: ['**/*.m', '**/*.mm'],
  grammar: { wasmFile: 'objc.wasm', extractor: objcExtractor },
  // F#82b — rewrite RN bridge macros (RCT_EXPORT_METHOD …) to parseable ObjC
  // method syntax before the parse (length-preserving). Without this the
  // preprocessor-less grammar emits a macro_type_specifier + ERROR cascade,
  // dropping the macro methods, mis-parenting adjacent methods, and synthesizing
  // spurious body `function` nodes.
  preParseSourceTransform: rewriteReactNativeMacros,
};
