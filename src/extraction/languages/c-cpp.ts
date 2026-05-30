import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types.js';

/**
 * `#define MACRO value` is the dominant constant-declaration shape in
 * C. Tree-sitter-c surfaces it as `(preproc_def name: (identifier)
 * value: (preproc_arg)?)`, separate from the `declaration` /
 * `function_definition` paths the default dispatch covers. Flag macros
 * (`#define HAVE_FOO` with no value) extract as constants with no
 * signature; valued macros (`#define MAX 256`) capture the first 100
 * chars of the value as the signature, matching `formatInitSignature`
 * elsewhere. Function-like macros (`#define MAX(a,b) ...`,
 * `preproc_function_def`) are NOT handled here — those behave more
 * like callable functions than constants and need a separate path.
 */
const PREPROC_VALUE_SIGNATURE_MAX = 100;
function extractCPreprocDefConstant(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'preproc_def') return false;
  const nameNode = node.childForFieldName('name');
  if (!nameNode || nameNode.type !== 'identifier') return false;
  const name = getNodeText(nameNode, ctx.source);
  if (!name) return false;
  const valueNode = node.childForFieldName('value');
  let signature: string | undefined;
  if (valueNode) {
    const raw = getNodeText(valueNode, ctx.source).trim();
    if (raw) {
      const slice = raw.slice(0, PREPROC_VALUE_SIGNATURE_MAX);
      const overflow = raw.length > PREPROC_VALUE_SIGNATURE_MAX ? '...' : '';
      signature = `= ${slice}${overflow}`;
    }
  }
  ctx.createNode({
    kind: 'constant',
    name,
    node,
    ...(signature ? { extra: { signature } } : {}),
  });
  return true;
}

const cExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'], // typedef
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  // F#40 (2026-05-26): tree-sitter-c surfaces the return type on the
  // `type` field (`(function_definition type: (primitive_type "int") ...)`),
  // NOT the default `return_type`. Naming it here lets the shared
  // `extractTypeAnnotations` pass emit a `returns` edge to typedef'd
  // return types like `client *foo()` → returns(foo, client). Primitive
  // types (`int`, `void`, …) flow through but the type-ref walker
  // correctly drops them (BUILTIN_TYPES guard) so we don't pollute the
  // graph with edges to non-symbols.
  returnField: 'type',
  visitNode: (node, ctx) => extractCPreprocDefConstant(node, ctx),
  resolveTypeAliasKind: (node, _source) => {
    // C typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    // The inner enum_specifier/struct_specifier is anonymous, but we want the typedef name
    // to become the enum/struct node name.
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C includes: #include <stdio.h>, #include "myheader.h"
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

/**
 * Scan a node's named children (recursing into ERROR nodes) for the first
 * `identifier` whose text is not a C++ keyword (`class`/`struct`/`public`/
 * `private`/`protected`). Used to locate a class name that has been swallowed
 * into a misparsed subtree.
 */
function findClassNameInSubtree(node: SyntaxNode): string | null {
  const KEYWORDS = new Set(['class', 'struct', 'public', 'private', 'protected', 'virtual']);
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'identifier' && !KEYWORDS.has(child.text)) return child.text;
    if (child.type === 'ERROR') {
      const found = findClassNameInSubtree(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * When tree-sitter encounters `MACRO_NAME\nclass Foo { ... }` (a class whose
 * `template<...>` prefix is replaced by an ALL_CAPS macro invocation without
 * parentheses), it misparses the whole declaration as a `function_definition`
 * whose "return type" is the macro identifier and whose "body" is the class
 * body. Detect this pattern and return the intended class/struct name and kind;
 * return `null` when the node is NOT a macro-obscured class declaration.
 *
 * Recognition criteria (all must hold):
 *  1. Node type is `function_definition` with `hasError === true`.
 *  2. First named child is a `type_identifier` matching `ALL_CAPS_MACRO` style.
 *  3. A direct child or a one-level-deep qualified_identifier child carries a
 *     `class`/`struct` keyword (as identifier, namespace_identifier, or ERROR
 *     text), immediately followed by the class name.
 */
/** A macro-obscured class/struct recovered from a misparsed node. */
interface MacroClassInfo {
  name: string;
  kind: 'class' | 'struct';
}

/** Tree-sitter sometimes emits the `class`/`struct` keyword as an
 *  identifier/namespace_identifier inside an ERROR recovery node. */
const CLASS_KEYWORDS = new Set(['class', 'struct']);
const macroClassKind = (s: string): 'class' | 'struct' => (s === 'struct' ? 'struct' : 'class');

/**
 * Pattern A — the child is an ERROR recovery node. Three shapes: the
 * ERROR text is exactly the keyword (A1), its first child is an
 * `identifier` keyword (A2), or its first child is a
 * `qualified_identifier` whose head is the keyword (A3, a trailing
 * `// comment` fused class+name into a qualified_identifier).
 */
function macroClassFromErrorChild(node: SyntaxNode, child: SyntaxNode, i: number): MacroClassInfo | null {
  if (child.type !== 'ERROR') return null;
  if (CLASS_KEYWORDS.has(child.text.trim())) {
    const next = node.namedChild(i + 1);
    if (next?.type === 'identifier') return { name: next.text, kind: macroClassKind(child.text.trim()) };
  }
  const firstErrChild = child.namedChildren?.[0];
  if (firstErrChild?.type === 'identifier' && CLASS_KEYWORDS.has(firstErrChild.text)) {
    const found = findClassNameInSubtree(child);
    if (found) return { name: found, kind: macroClassKind(firstErrChild.text) };
  }
  if (firstErrChild?.type === 'qualified_identifier') {
    const qiFirst = firstErrChild.namedChild(0);
    if (qiFirst?.type === 'namespace_identifier' && CLASS_KEYWORDS.has(qiFirst.text)) {
      const found = findClassNameInSubtree(firstErrChild);
      if (found) return { name: found, kind: macroClassKind(qiFirst.text) };
    }
  }
  return null;
}

/**
 * Pattern B2 helper — inside a nested-macro `qualified_identifier`, an
 * ERROR child either starts with the `class`/`struct` keyword or wraps a
 * `qualified_identifier` whose head is the keyword.
 */
function macroClassFromNestedError(qc: SyntaxNode): MacroClassInfo | null {
  if (qc.type !== 'ERROR') return null;
  const kwMatch = qc.text.trim().match(/^(class|struct)\s/);
  if (kwMatch) {
    const found = findClassNameInSubtree(qc);
    if (found) return { name: found, kind: macroClassKind(kwMatch[1]!) };
  }
  const firstQcChild = qc.namedChildren?.[0];
  if (firstQcChild?.type === 'qualified_identifier') {
    const qqns = firstQcChild.namedChild(0);
    if (qqns?.type === 'namespace_identifier' && CLASS_KEYWORDS.has(qqns.text)) {
      const found = findClassNameInSubtree(firstQcChild);
      if (found) return { name: found, kind: macroClassKind(qqns.text) };
    }
  }
  return null;
}

/**
 * Pattern B — the child is a `qualified_identifier` whose head is either
 * the `class`/`struct` keyword (B) or an ALL_CAPS macro that wraps a
 * nested ERROR carrying the class (B2 — two ALL_CAPS macros on adjacent
 * lines, e.g. a namespace-begin macro followed by a template-declaration
 * macro, fused into one function_definition).
 */
function macroClassFromQualifiedChild(child: SyntaxNode): MacroClassInfo | null {
  if (child.type !== 'qualified_identifier') return null;
  const ns = child.namedChild(0);
  if (!ns || ns.type !== 'namespace_identifier') return null;
  if (CLASS_KEYWORDS.has(ns.text)) {
    const found = findClassNameInSubtree(child);
    if (found) return { name: found, kind: macroClassKind(ns.text) };
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(ns.text)) {
    for (let j = 1; j < child.namedChildCount; j++) {
      const qc = child.namedChild(j);
      const hit = qc && macroClassFromNestedError(qc);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Pattern C — a bare `identifier` whose text is `class`/`struct` (some
 * tree-sitter versions emit it this way), followed by the class name.
 */
function macroClassFromBareKeyword(node: SyntaxNode, child: SyntaxNode, i: number): MacroClassInfo | null {
  if (child.type !== 'identifier' || !CLASS_KEYWORDS.has(child.text)) return null;
  const kind = macroClassKind(child.text);
  const next = node.namedChild(i + 1);
  if (next?.type === 'identifier') return { name: next.text, kind };
  if (next?.type === 'ERROR') {
    const found = findClassNameInSubtree(next);
    if (found) return { name: found, kind };
  }
  return null;
}

/**
 * Recover a macro-obscured `class`/`struct` from a `function_definition`
 * tree-sitter misparsed (the macro became the "return type"). Returns
 * `null` for any node that isn't an errored, ALL_CAPS-macro-led
 * function_definition. The recovery shapes are delegated to the
 * per-pattern helpers above.
 */
function extractMacroObscuredClassInfo(node: SyntaxNode): MacroClassInfo | null {
  if (node.type !== 'function_definition' || !node.hasError) return null;
  const firstChild = node.namedChild(0);
  if (!firstChild || firstChild.type !== 'type_identifier') return null;
  if (!/^[A-Z][A-Z0-9_]*$/.test(firstChild.text)) return null;

  // B15: skipped — index `i` is passed to sibling helpers (macroClassFromErrorChild / macroClassFromBareKeyword
  // both call node.namedChild(i + 1)).
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const hit =
      macroClassFromErrorChild(node, child, i) ??
      macroClassFromQualifiedChild(child) ??
      macroClassFromBareKeyword(node, child, i);
    if (hit) return hit;
  }
  return null;
}

/**
 * Re-extract a misparsed `function_definition` (macro-obscured class) as a
 * proper `class` or `struct` node, then visit the compound_statement body so
 * member functions are extracted as methods in the correct scope.
 */
function visitMacroObscuredClass(node: SyntaxNode, info: MacroClassInfo, ctx: ExtractorContext): void {
  const classNode = ctx.createNode({ kind: info.kind, name: info.name, node });
  if (!classNode) return;

  // Find the compound_statement body (the class body tree-sitter captured).
  let body: SyntaxNode | null = null;
  for (const child of node.namedChildren) {
    if (child?.type === 'compound_statement') {
      body = child;
      break;
    }
  }
  if (!body) return;

  // Push the class onto the scope stack so member function_definitions are
  // extracted as methods (tsIsInsideClassLikeNode returns true).
  ctx.pushScope(classNode.id);
  for (const child of body.namedChildren) {
    if (child) ctx.visitNode(child);
  }
  ctx.popScope();
}

const cppExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition', 'alias_declaration'], // typedef and using
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  // F#40: same field-name shape as C (tree-sitter-cpp inherits
  // `function_definition` from the C grammar).
  returnField: 'type',
  getVisibility: (node) => {
    // Check for access specifier in parent
    const parent = node.parent;
    if (parent) {
      for (const child of parent.children) {
        if (child?.type === 'access_specifier') {
          const text = child.text;
          if (text.includes('public')) return 'public';
          if (text.includes('private')) return 'private';
          if (text.includes('protected')) return 'protected';
        }
      }
    }
    return undefined;
  },
  resolveTypeAliasKind: (node, _source) => {
    // C++ typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  isMisparsedFunction: (name) => {
    // C++ macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause tree-sitter to misparse
    // namespace blocks as function_definitions (e.g. name = "namespace detail").
    // Also filter C++ keywords that tree-sitter occasionally misinterprets as
    // function/method names (e.g. switch statements inside macro-confused scopes).
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    return cppKeywords.includes(name);
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C++ includes: #include <iostream>, #include "myheader.h"
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
  visitNode: (node, ctx) => {
    // `#define` constants share the C path; tree-sitter-cpp inherits
    // preprocessor nodes from C so the same hook applies.
    if (extractCPreprocDefConstant(node, ctx)) return true;
    // Re-route macro-obscured class/struct declarations.
    // Tree-sitter misparses `MACRO_NAME\nclass Foo { ... }` as a
    // function_definition (the macro becomes the "return type").
    // Detect this and extract as a proper class node instead.
    const info = extractMacroObscuredClassInfo(node);
    if (info === null) return false;
    visitMacroObscuredClass(node, info, ctx);
    return true; // consumed — skip default dispatch
  },
};

import type { LanguageDef } from './types.js';
export const C_DEF: LanguageDef = {
  name: 'c',
  displayName: 'C',
  // .h is also listed for C; tree-sitter.ts contains a `.h might be C++`
  // heuristic that overrides this on a content-sniff basis.
  extensions: ['.c', '.h'],
  includeGlobs: ['**/*.c', '**/*.h'],
  grammar: { wasmFile: 'c.wasm', extractor: cExtractor },
};
export const CPP_DEF: LanguageDef = {
  name: 'cpp',
  displayName: 'C++',
  extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
  includeGlobs: ['**/*.cpp', '**/*.cc', '**/*.cxx', '**/*.hpp', '**/*.hxx'],
  grammar: { wasmFile: 'cpp.wasm', extractor: cppExtractor },
};
