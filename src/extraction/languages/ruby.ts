import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';

/** Truncation cap on the `= <value>` signature column. Mirrors
 *  `INIT_SIGNATURE_MAX` in `tree-sitter-decls.ts` so top-level Ruby
 *  variable signatures and class-scoped Ruby constant signatures
 *  (which take this hook's shortcut path) use the same width. */
const INIT_SIGNATURE_MAX = 100;

/** Format the RHS of a Ruby `assignment` as a `= <value>` signature
 *  matching the layout `formatInitSignature` produces in
 *  `tree-sitter-decls.ts`. Returns `undefined` for an empty / missing
 *  RHS so callers can omit the `extra.signature` field. */
function rubyConstantSignature(right: SyntaxNode | null, source: string): string | undefined {
  if (!right) return undefined;
  const raw = getNodeText(right, source).slice(0, INIT_SIGNATURE_MAX);
  if (!raw) return undefined;
  const overflow = raw.length >= INIT_SIGNATURE_MAX ? '...' : '';
  return `= ${raw}${overflow}`;
}

/**
 * F#35 (2026-05-26) — Ruby class macros that declare accessor fields.
 *
 * `attr_reader :name` → synthesises a `name` getter, semantically a
 * read-only field. `attr_writer` → setter (write-only field).
 * `attr_accessor` → both. Rails' `class_attribute :default_options`
 * declares a class-level accessor with similar semantics.
 *
 * AST: `(call method: (identifier "attr_reader") arguments:
 * (argument_list (simple_symbol ":name") (simple_symbol ":email")))`.
 * Each `simple_symbol` arg becomes a `field` node on the enclosing
 * class. Other argument shapes (hash kwargs to `class_attribute` —
 * `class_attribute :foo, default: true, instance_writer: false`) are
 * NOT field declarations; we filter to `simple_symbol` / `symbol`
 * leaves only.
 *
 * Visibility: takes the kind from the same `getVisibility` walk used
 * for methods — `private :name; attr_reader :name` produces a
 * private accessor.
 */
const RUBY_ACCESSOR_MACROS: ReadonlySet<string> = new Set([
  'attr_reader',
  'attr_writer',
  'attr_accessor',
  'class_attribute',
]);
const RUBY_BARE_CALL_BLOCK_PARENTS: ReadonlySet<string> = new Set([
  'body_statement',
  'then',
  'else',
  'do',
  'begin',
  'rescue',
  'ensure',
  'when',
]);
const RUBY_BARE_CALL_SKIP_NAMES: ReadonlySet<string> = new Set([
  'true',
  'false',
  'nil',
  'self',
  'super',
  '__FILE__',
  '__LINE__',
  '__dir__',
]);

interface RubyAccessorEmitArgs {
  node: SyntaxNode;
  source: string;
}
function rubyAccessorFieldNames(args: RubyAccessorEmitArgs): readonly string[] {
  const { node, source } = args;
  if (node.type !== 'call') return [];
  const methodNode = node.childForFieldName('method') ?? node.namedChildren.find((c) => c.type === 'identifier');
  if (!methodNode) return [];
  const methodName = getNodeText(methodNode, source);
  if (!RUBY_ACCESSOR_MACROS.has(methodName)) return [];

  const argList = node.childForFieldName('arguments') ?? node.namedChildren.find((c) => c.type === 'argument_list');
  if (!argList) return [];

  const names: string[] = [];
  for (const arg of argList.namedChildren) {
    if (!arg) continue;
    if (arg.type !== 'simple_symbol' && arg.type !== 'symbol') continue;
    // `simple_symbol` text is `":name"` — strip the leading colon.
    const raw = getNodeText(arg, source);
    const name = raw.startsWith(':') ? raw.slice(1) : raw;
    if (name) names.push(name);
  }
  return names;
}

function visitRubyModule(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'module') return false;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return false;
  const moduleNode = ctx.createNode({ kind: 'module', name: nameNode.text, node });
  if (!moduleNode) return false;

  ctx.pushScope(moduleNode.id);
  const body = node.childForFieldName('body');
  if (body) {
    for (const child of body.namedChildren) {
      if (child) ctx.visitNode(child);
    }
  }
  ctx.popScope();
  return true;
}

function visitRubyAccessorCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'call' || node.parent?.type !== 'body_statement') return false;
  const fieldNames = rubyAccessorFieldNames({ node, source: ctx.source });
  if (fieldNames.length === 0) return false;
  for (const name of fieldNames) {
    ctx.createNode({ kind: 'field', name, node });
  }
  return true;
}

function visitRubyScopedConstant(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'assignment' || ctx.nodeStack.length === 0) return false;
  const left = node.childForFieldName('left') ?? node.namedChild(0);
  if (left?.type !== 'constant') return false;

  const name = getNodeText(left, ctx.source);
  if (!name) return true;
  const right = node.childForFieldName('right') ?? node.namedChild(1);
  const signature = rubyConstantSignature(right, ctx.source);
  ctx.createNode({
    kind: 'constant',
    name,
    node,
    ...(signature ? { extra: { signature } } : {}),
  });
  return true;
}

function rubyRequireModuleName(node: SyntaxNode, source: string): string | null {
  const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  if (!identifier) return null;
  const methodName = getNodeText(identifier, source);
  if (methodName !== 'require' && methodName !== 'require_relative') return null;

  const argList = node.namedChildren.find((c: SyntaxNode) => c.type === 'argument_list');
  const stringNode = argList?.namedChildren.find((c: SyntaxNode) => c.type === 'string');
  const stringContent = stringNode?.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
  return stringContent ? getNodeText(stringContent, source) : null;
}

function isRubyUppercaseName(name: string): boolean {
  const firstCodePoint = name.codePointAt(0) ?? 0;
  return firstCodePoint >= 65 && firstCodePoint <= 90;
}

function rubyVisibilityFromCall(node: SyntaxNode): 'public' | 'private' | 'protected' | null {
  if (node.type !== 'call') return null;
  const methodName = getChildByField(node, 'method');
  if (!methodName) return null;
  if (methodName.text === 'private') return 'private';
  if (methodName.text === 'protected') return 'protected';
  if (methodName.text === 'public') return 'public';
  return null;
}

const rubyExtractor: LanguageExtractor = {
  functionTypes: ['method'],
  classTypes: ['class'],
  methodTypes: ['method', 'singleton_method'],
  interfaceTypes: [], // Ruby uses modules (handled via visitNode hook)
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['call'], // require/require_relative
  callTypes: ['call', 'method_call'],
  variableTypes: ['assignment'], // Ruby uses assignment like Python
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  isConst: (node) => {
    // Ruby's language-level rule: an identifier starting with uppercase
    // (e.g. `MODULES = [...]`) IS a constant. Tree-sitter-ruby surfaces
    // these as `(assignment left: (constant) right: ...)`, distinct
    // from `(assignment left: (identifier) right: ...)` for locals.
    const left = node.childForFieldName('left') ?? node.namedChild(0);
    return left?.type === 'constant';
  },
  visitNode: (node, ctx) => {
    if (visitRubyModule(node, ctx)) return true;

    // F#35: Ruby class macros — attr_reader / attr_writer /
    // attr_accessor / class_attribute. Emit one `field` node per
    // symbol arg on the enclosing class. Gated by the parent being
    // a `body_statement` (Ruby's tree-sitter wraps class/module
    // bodies in this node), which excludes top-level usage —
    // `attr_reader :stray` outside any class is a no-op at runtime.
    // The general `nodeStack.length > 0` guard isn't tight enough
    // because the extractor pushes the file node onto the stack
    // before visiting, so the stack is always non-empty.
    if (visitRubyAccessorCall(node, ctx)) return true;

    // F#34: class/module-scoped Ruby constants. The default dispatch
    // skips `assignment` nodes inside class-like scopes (so JS/TS
    // class-field syntax doesn't double-emit), but Ruby surfaces
    // class-scoped CONSTANTs as `assignment` nodes — re-route them
    // directly so the constant reaches `createNode`. Top-level
    // constants still flow through the default `variableTypes` path
    // (nodeStack empty → this branch falls through, default dispatch
    // handles).
    return visitRubyScopedConstant(node, ctx);
  },
  extractBareCall: (node, _source) => {
    // Ruby bare method calls (no parens, no receiver) parse as plain identifiers.
    // e.g., `reset` in a method body is `identifier "reset"` not a `call` node.
    if (node.type !== 'identifier') return undefined;

    const parent = node.parent;
    if (!parent) return undefined;

    // Only statement-level identifiers — direct children of block/body nodes
    if (!RUBY_BARE_CALL_BLOCK_PARENTS.has(parent.type)) return undefined;

    const name = node.text;

    // Skip Ruby keywords/literals
    if (RUBY_BARE_CALL_SKIP_NAMES.has(name)) return undefined;

    // Skip constants (uppercase start) — these are class/module refs, not calls
    if (isRubyUppercaseName(name)) return undefined;

    return name;
  },
  getVisibility: (node) => {
    // Ruby visibility is based on preceding visibility modifiers
    let sibling = node.previousNamedSibling;
    while (sibling) {
      const visibility = rubyVisibilityFromCall(sibling);
      if (visibility) return visibility;
      sibling = sibling.previousNamedSibling;
    }
    return 'public';
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // Check if this is a require/require_relative call
    const moduleName = rubyRequireModuleName(node, source);
    if (moduleName === null) return null;
    return { moduleName, signature: importText };
  },
};

import type { LanguageDef } from './types.js';
export const RUBY_DEF: LanguageDef = {
  name: 'ruby',
  displayName: 'Ruby',
  extensions: ['.rb', '.rake'],
  includeGlobs: ['**/*.rb', '**/*.rake'],
  grammar: { wasmFile: 'ruby.wasm', extractor: rubyExtractor },
};
