/**
 * Universal hand-extractor — call / instantiation / decorator extraction.
 *
 * Carved out of `tree-sitter.ts` (god-module split, 2026-05-17). Holds
 * the `tsXxx` free functions that emit `calls` / `instantiates` /
 * `decorates` / dynamic-`imports` references. Same free-function
 * convention as the rest of the extraction core: each takes the
 * `TreeSitterExtractor` as its first argument and mutates its
 * accumulators.
 *
 * ⚠ This file feeds `EXTRACTION_LOGIC_VERSION` — see the spec-file set
 * in `extraction-logic-version.ts`. A substantive edit here triggers a
 * one-shot full re-extraction on the next sync.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { DecoratorArgsEntry } from '../types.js';
import { getNodeText, getChildByField } from './tree-sitter-helpers.js';
import { type TreeSitterExtractor, extractLeafReceiverName, STRUCT_LITERAL_CTOR_KINDS } from './tree-sitter.js';

/**
 * Receiver names that don't aid call resolution and should be dropped
 * when qualifying a method call. The method-invocation grammar shape
 * (Java/Kotlin/PHP) carries explicit `static` and `parent` receivers
 * via syntactic keywords that the generic member-access form doesn't
 * surface, hence the two distinct sets.
 */
const METHOD_INVOCATION_SKIP_RECEIVERS: ReadonlySet<string> = new Set([
  'self',
  'this',
  'cls',
  'super',
  'parent',
  'static',
]);
const MEMBER_CALL_SKIP_RECEIVERS: ReadonlySet<string> = new Set(['self', 'this', 'cls', 'super']);

/**
 * Decorator-shaped node kinds across grammars.
 *   - `decorator`           — Python (`@foo`) and TS/JS (`@Component`).
 *   - `annotation`          — Java args-bearing annotation (`@RequestMapping(...)`).
 *   - `marker_annotation`   — Java args-less annotation (`@Override`, `@Deprecated`);
 *                             without it every such Java annotation would be silently skipped.
 *   - `attribute`           — C# (`[Route]`) and PHP 8 (`#[Pure]`). In both grammars
 *                             `attribute` sits INSIDE a wrapper (`attribute_list` for C#,
 *                             `attribute_list > attribute_group` for PHP) — see
 *                             `DECORATOR_WRAPPER_TYPES` and `tsExtractDecoratorsFor` for
 *                             the wrapper-descent path that ultimately reaches these nodes.
 */
export const DECORATOR_NODE_TYPES: ReadonlySet<string> = new Set([
  'decorator',
  'annotation',
  'marker_annotation',
  'attribute',
]);

/**
 * Wrapper-kind nodes that SIT BETWEEN the decorated declaration and the
 * decorator-shaped children:
 *   - `modifiers`        — Java: `class_declaration > modifiers > marker_annotation`.
 *   - `attribute_list`   — C# (`class_declaration > attribute_list > attribute`) AND
 *                          PHP (`class_declaration > attribute_list > attribute_group`).
 *   - `attribute_group`  — PHP: nested inside `attribute_list`, groups `#[A, B]`.
 *
 * `tsExtractDecoratorsFor` descends one level into any direct-child wrapper, then
 * applies `recordDecoratorIfPresent` to each of THAT wrapper's named-children.
 * Two-deep descent (wrapper → wrapper → decorator) covers PHP's
 * `attribute_list > attribute_group > attribute` shape.
 */
const DECORATOR_WRAPPER_TYPES: ReadonlySet<string> = new Set(['modifiers', 'attribute_list', 'attribute_group']);

/**
 * Identifier-shaped child kinds inside a decorator that name the
 * decorator function.
 *   - `identifier`            — TS/JS/Java/C#.
 *   - `member_expression`     — TS/JS (`@A.B`).
 *   - `scoped_identifier`     — Java (`@some.pkg.Anno`).
 *   - `navigation_expression` — Kotlin / Swift dotted decorators.
 *   - `name`                  — PHP (`attribute > name`); the PHP grammar uses
 *                               `name` rather than `identifier` for the bare attr name.
 *                               Adding it here matches PHP without regressing other
 *                               languages — `name` only appears under `attribute` in
 *                               PHP, and the iteration is scoped to a decorator's children.
 *   - `qualified_name`        — PHP inline-FQCN attribute (`#[\Drupal\…\Block(…)]`);
 *                               the bare-name case uses `name`. `recordDecoratorIfPresent`
 *                               strips the `\`-qualified prefix to the last segment.
 * The `call_expression` form (decorator invoked with args) is handled
 * separately by unwrapping its `function` field.
 */
const DECORATOR_TARGET_KINDS: ReadonlySet<string> = new Set([
  'identifier',
  'member_expression',
  'scoped_identifier',
  'navigation_expression',
  'name',
  'qualified_name',
]);

/**
 * Find the leading identifier inside a decorator/annotation node:
 * skip the `@` punct, unwrap a `call_expression` if the decorator
 * was invoked with args, otherwise pick the first identifier-shaped
 * child. Returns `null` when the decorator's name can't be resolved
 * from the syntax (rare; defensive).
 */
function findDecoratorTarget(n: SyntaxNode): SyntaxNode | null {
  for (const child of n.namedChildren) {
    if (!child) continue;
    const target = decoratorTargetFromChild(child);
    if (target) return target;
    if (DECORATOR_TARGET_KINDS.has(child.type)) return child;
  }
  return null;
}

function decoratorTargetFromChild(child: SyntaxNode): SyntaxNode | null {
  if (child.type === 'call_expression') {
    return getChildByField(child, 'function') ?? child.namedChild(0);
  }
  if (child.type === 'constructor_invocation') {
    return (
      child.namedChildren
        .find((c) => c?.type === 'user_type')
        ?.namedChildren.find((c) => c?.type === 'type_identifier') ?? null
    );
  }
  if (child.type === 'user_type') {
    return child.namedChildren.find((c) => c?.type === 'type_identifier') ?? null;
  }
  return null;
}

/**
 * B9 (2026-05-26) — Find the "call node" inside a decorator/annotation,
 * or null when the decorator was used in bare form (`@Override` style).
 * The returned node's argument-list child is what carries the URL path,
 * topic name, config key, etc. that framework resolvers need to read.
 *
 * Per-grammar shapes:
 *   - TS/JS: `decorator > call_expression > arguments`
 *   - Python: `decorator > call > argument_list`
 *   - Java: `annotation > [identifier, annotation_argument_list]` —
 *     the annotation node ITSELF plays the role of the call node;
 *     `extractDecoratorCallArgs` recognises `annotation_argument_list`
 *     as the args container (added F#64c, 2026-05-26 — without this
 *     Java `@Value("${k}")` never populates `decoratorArgs`).
 *   - Kotlin: `annotation > constructor_invocation > [user_type,
 *     value_arguments]` — the constructor_invocation IS the call
 *     node (NOT the annotation), and `value_arguments` is the args
 *     container (added F#64b v3.1, 2026-05-27).
 *   - C#: attribute > attribute_argument_list — same pattern as Java.
 */
function findDecoratorCallExpression(n: SyntaxNode): SyntaxNode | null {
  for (const child of n.namedChildren) {
    if (!child) continue;
    if (child.type === 'call_expression' || child.type === 'call') return child;
    // Kotlin: the args list is wrapped in a `constructor_invocation`
    // INSIDE the annotation. Return the constructor_invocation so
    // the args extractor can pick up `value_arguments` from its
    // named children.
    if (child.type === 'constructor_invocation') return child;
    // Java/C#: the args list is a direct child of the annotation
    // node itself, not wrapped in a `call_expression`. Return the
    // annotation node so the args extractor can pick up
    // `annotation_argument_list` from its named children.
    if (child.type === 'annotation_argument_list' || child.type === 'attribute_argument_list') return n;
    // PHP: `attribute > parameters:(arguments …)` — the named-arg list
    // is an `arguments` node held under the `parameters` field (no
    // `call_expression` wrapper, unlike TS where `arguments` only ever
    // appears UNDER a `call_expression` caught above). Return the
    // attribute node so the args extractor finds the `arguments` child
    // via its typed-child fallback (Drupal v4 `#[Block(id: '…')]`).
    if (child.type === 'arguments') return n;
  }
  return null;
}

/**
 * B9 — Walk a decorator's argument list (the `call_expression` /
 * `annotation` / `attribute` node `findDecoratorCallExpression` returns)
 * and bucket each arg into string-literal vs bare-identifier vs named.
 * Returns null when the call has no parseable args (defensive — undefined
 * results stay out of the persisted `decorator_args` JSON).
 *
 * What we capture:
 *   - String literals: `'/path'`, `"/path"`, ```/path``` (raw value,
 *     quote-stripped; template literals with NO interpolation only —
 *     a `${expr}` placeholder yields nothing for that arg).
 *   - Bare identifiers: `AuthGuard`, `RolesGuard`.
 *
 *   - NAMED args (string OR boolean value) land in `namedArgs[key]`,
 *     across three grammar shapes:
 *       - PHP-8 attributes (`#[Block(id: 'foo', admin_label: 'Bar')]`):
 *         each `argument` node carries an optional `name:` field; a
 *         positional `argument` (no `name:`) flows through the shared
 *         string/identifier buckets (Drupal v4).
 *       - Java/C# (`@ReactMethod(isBlockingSynchronousMethod = true)`,
 *         `@RequestMapping(value = "/x")`): each `element_value_pair`
 *         has `key:` + `value:` fields (F#83).
 *       - Kotlin (`@ReactProp(name = "x")`): a `value_argument` with a
 *         leading `simple_identifier` key + `=` + value (F#84).
 *     Boolean values are recorded as the text `'true'` / `'false'`.
 *
 * What we DON'T capture in v1 (kept narrow on purpose — future
 * extension):
 *   - Object literals (`{ path: '/x', method: 'GET' }`) — would need
 *     recursive walking; defer until a consumer needs it.
 *   - Array literals.
 *   - Spread arguments.
 *   - Number / null literals, and boolean POSITIONAL args (only NAMED
 *     boolean values reach `namedArgs`).
 *   - Non-string/boolean-valued named args (`admin_label: new Markup('…')`)
 *     — `readNamedArgValue` records only string + boolean literal values.
 *
 * Cost: linear walk of the call's argument list (typically 1-3
 * args for a framework decorator). Runs once per decorator at
 * extraction time; no per-resolver re-parsing.
 */
function extractDecoratorCallArgs(
  callNode: SyntaxNode,
  source: string,
): { argStrings: string[]; argIdents: string[]; namedArgs?: Record<string, string> } | null {
  // The argument list shape varies by grammar:
  //   - TS/JS: `call_expression > arguments > [arg, …]`
  //   - Python: `call > argument_list > [arg, …]`
  //   - Java: `annotation > annotation_argument_list > [arg, …]`
  //     (F#64c, 2026-05-26 — `findDecoratorCallExpression` returns the
  //     annotation node itself in this case, so we look for the args
  //     list among the annotation's named children.) A `key = value`
  //     arg parses as `element_value_pair` (F#83), handled in the loop.
  //   - Kotlin: `constructor_invocation > value_arguments >
  //     [value_argument > string_literal | identifier, …]`
  //     (F#64b v3.1, 2026-05-27 — `value_argument` wraps each arg,
  //     so we unwrap inside the per-arg loop below; a named
  //     `name = value` value_argument routes to namedArgs — F#84.)
  //   - C#: `attribute > attribute_argument_list > [arg, …]`.
  // Look for the conventional field first, fall back to a typed-child
  // search for grammars that don't expose it as a field.
  const argsNode =
    getChildByField(callNode, 'arguments') ??
    callNode.namedChildren.find(
      (c) =>
        c.type === 'arguments' ||
        c.type === 'argument_list' ||
        c.type === 'annotation_argument_list' ||
        c.type === 'attribute_argument_list' ||
        c.type === 'value_arguments',
    );
  if (!argsNode) return null;

  // Per-arg dispatch (PHP / Java element_value_pair / Kotlin value_argument /
  // literals) lives in `collectDecoratorArg` to keep this function small.
  const buckets: DecoratorArgBuckets = { argStrings: [], argIdents: [], namedArgs: {} };
  for (const argRaw of argsNode.namedChildren) {
    if (argRaw) collectDecoratorArg(argRaw, source, buckets);
  }

  const { argStrings, argIdents, namedArgs } = buckets;
  const hasNamed = Object.keys(namedArgs).length > 0;
  if (argStrings.length === 0 && argIdents.length === 0 && !hasNamed) return null;
  return hasNamed ? { argStrings, argIdents, namedArgs } : { argStrings, argIdents };
}

/** Read a string-literal node's value with its surrounding quotes
 *  stripped. Handles single/double/backtick delimiters AND the
 *  `string_fragment` (TS/JS) / `string_content` (Kotlin) child the
 *  grammars use when the literal contains escape sequences. */
export function readStringLiteralValue(node: SyntaxNode, source: string): string | null {
  // TS/JS grammar: a string node has a `string_fragment` child holding
  // the unquoted payload (handles `'a\nb'` correctly — `\n` is one
  // source char). Kotlin uses `string_content` for the same role.
  // Fall back to substring + quote-strip when neither child exists.
  const fragment = node.namedChildren.find((c) => c.type === 'string_fragment' || c.type === 'string_content');
  if (fragment) return getNodeText(fragment, source);

  const raw = source.substring(node.startIndex, node.endIndex);
  if (raw.length < 2) return null;
  const first = raw.charAt(0);
  const last = raw.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    return raw.substring(1, raw.length - 1);
  }
  return raw;
}

/** Read a named decorator/annotation arg's VALUE as a string: the
 *  unquoted payload for string literals, or `'true'`/`'false'` for
 *  boolean literals. Returns null for value kinds `namedArgs` doesn't
 *  capture (numbers, bare identifiers, expressions) — keeping the map
 *  to the string/boolean scope its consumers read. Boolean support was
 *  added for F#83/F#84 (`@ReactMethod(isBlockingSynchronousMethod = true)`
 *  / `@ReactProp(name = "x", defaultBoolean = true)`). */
function readNamedArgValue(node: SyntaxNode, source: string): string | null {
  if (node.type === 'string' || node.type === 'string_literal') return readStringLiteralValue(node, source);
  // Java boolean literals are node types `true` / `false`; Kotlin uses `boolean_literal`.
  if (node.type === 'true' || node.type === 'false' || node.type === 'boolean_literal') {
    return getNodeText(node, source);
  }
  return null;
}

/** Mutable accumulator for a decorator's args, shared across the per-arg
 *  walk. Bundled so the per-grammar collectors stay under the
 *  long-parameter-list threshold. */
interface DecoratorArgBuckets {
  argStrings: string[];
  argIdents: string[];
  namedArgs: Record<string, string>;
}

/** Dispatch ONE raw decorator/annotation arg node to the right collector,
 *  mutating `buckets`. Grammar shapes: PHP `argument`, Java/C#
 *  `element_value_pair` (F#83), Kotlin `value_argument` (named → F#84, else
 *  unwrapped to its inner literal/identifier), then plain literals. */
function collectDecoratorArg(argRaw: SyntaxNode, source: string, buckets: DecoratorArgBuckets): void {
  // PHP: `argument` node with an optional `name:` field (named → namedArgs,
  // positional → string/identifier buckets) — both handled by the collector.
  if (argRaw.type === 'argument') {
    collectPhpAttributeArg(argRaw, source, buckets);
    return;
  }
  // Java/C#: `@M(key = value)` parses as `element_value_pair`.
  if (argRaw.type === 'element_value_pair') {
    collectJavaNamedArg(argRaw, source, buckets.namedArgs);
    return;
  }
  // Kotlin: a NAMED `value_argument` routes its value to namedArgs (F#84);
  // a positional one unwraps to its inner literal/identifier for the
  // literal collector below.
  let arg = argRaw;
  if (argRaw.type === 'value_argument') {
    if (tryCollectKotlinNamedArg(argRaw, source, buckets.namedArgs)) return;
    arg = argRaw.namedChildren.find(Boolean) ?? argRaw;
  }
  collectLiteralArg(arg, source, buckets);
}

/** Java/C# `element_value_pair` → `namedArgs[key]` when the value is a
 *  captured (string/boolean) literal (F#83). A single-element Java annotation
 *  (`@RequestMapping("/x")`) is a DIRECT literal child, not a pair, so it
 *  flows to the literal collector instead — not here. */
function collectJavaNamedArg(argRaw: SyntaxNode, source: string, namedArgs: Record<string, string>): void {
  const keyNode = getChildByField(argRaw, 'key');
  const valueNode = getChildByField(argRaw, 'value');
  if (!keyNode || !valueNode) return;
  const value = readNamedArgValue(valueNode, source);
  if (value !== null) namedArgs[getNodeText(keyNode, source)] = value;
}

/** Kotlin named `value_argument` (`name = "x"`) → `namedArgs[name]` (F#84).
 *  A named arg is a value_argument with two named children — a leading
 *  `simple_identifier` key + the value, with an `=` between them in source.
 *  Returns true when it consumed a named arg; false for a positional one
 *  (the caller then unwraps to the inner value). Without this the unwrap
 *  grabbed the KEY identifier and dropped the value. */
function tryCollectKotlinNamedArg(argRaw: SyntaxNode, source: string, namedArgs: Record<string, string>): boolean {
  const [first, second] = argRaw.namedChildren.filter((c): c is SyntaxNode => !!c);
  if (
    !first ||
    !second ||
    (first.type !== 'simple_identifier' && first.type !== 'identifier') ||
    !source.slice(first.endIndex, second.startIndex).includes('=')
  ) {
    return false;
  }
  // A non-string/non-boolean named value (`@Timeout(value = 30)`) yields null
  // and is intentionally dropped per the v1 narrow scope — but the arg was
  // still a NAMED one, so return true (don't fall through to the positional
  // unwrap, which would mis-bucket the key identifier).
  const value = readNamedArgValue(second, source);
  if (value !== null) namedArgs[getNodeText(first, source)] = value;
  return true;
}

/** Collect a positional literal/identifier arg into the string/identifier
 *  buckets: string + non-interpolated template literals → `argStrings`; bare
 *  identifiers → `argIdents`. (Template literals with a `${…}` substitution
 *  have a dynamic part we can't capture at extraction time, so they're skipped.) */
function collectLiteralArg(arg: SyntaxNode, source: string, buckets: DecoratorArgBuckets): void {
  if (arg.type === 'string' || arg.type === 'string_literal') {
    const value = readStringLiteralValue(arg, source);
    if (value !== null) buckets.argStrings.push(value);
    return;
  }
  if (arg.type === 'template_string') {
    const hasInterpolation = arg.namedChildren.some((c) => c.type === 'template_substitution');
    if (!hasInterpolation) {
      const value = readStringLiteralValue(arg, source);
      if (value !== null) buckets.argStrings.push(value);
    }
    return;
  }
  if (arg.type === 'identifier' || arg.type === 'simple_identifier') {
    buckets.argIdents.push(getNodeText(arg, source));
  }
}

/** Record one PHP-attribute `argument` node (Drupal v4). A `name:` field
 *  marks a named arg — a string value lands in `namedArgs[name]`; a
 *  positional arg's value flows to the shared string/identifier buckets.
 *  Only string-literal values are captured (matches the v1 narrow scope). */
function collectPhpAttributeArg(argNode: SyntaxNode, source: string, out: DecoratorArgBuckets): void {
  const nameField = getChildByField(argNode, 'name');
  // Value = first named child that isn't the `name:` field (compare by
  // span — web-tree-sitter hands out fresh wrappers, so `===` is unreliable).
  const valueNode = argNode.namedChildren.find((c) => c && (!nameField || c.startIndex !== nameField?.startIndex));
  if (!valueNode) return;
  const strVal =
    valueNode.type === 'string' || valueNode.type === 'string_literal'
      ? readStringLiteralValue(valueNode, source)
      : null;
  if (nameField) {
    const argName = getNodeText(nameField, source);
    if (argName && strVal !== null) out.namedArgs[argName] = strVal;
  } else if (strVal !== null) {
    out.argStrings.push(strVal);
  } else if (valueNode.type === 'name' || valueNode.type === 'identifier') {
    out.argIdents.push(getNodeText(valueNode, source));
  }
}

/** Shared context threaded through all three decorator-recording helpers. */
interface DecoratorRecordArgs {
  /** The active extractor (provides `.source` and `.unresolvedReferences`). */
  ext: TreeSitterExtractor;
  /** Node-id of the symbol being decorated. */
  decoratedId: string;
  /** Accumulator — bare decorator names are appended here by each helper. */
  names: string[];
  /** B9 (2026-05-26) — Accumulator for per-decorator call-expression args
   *  (string literals + bare identifiers). DURING accumulation this array
   *  IS positionally aligned with `names`: every push into `names` is
   *  paired with a push into `argsByDecorator` (or a `null` entry for
   *  bare/non-call decorators). After accumulation `tsExtractDecoratorsFor`
   *  COMPACTS this by filtering out the nulls before storing to
   *  `Node.decoratorArgs` — so the persisted array is NAME-KEYED, not
   *  positionally aligned with the persisted `decorators` array.
   *  Internal helper structure; not exposed beyond this module. */
  argsByDecorator: Array<DecoratorArgsEntry | null>;
}

/**
 * If `n` is a decorator/annotation node, push a `decorates`
 * unresolved reference from `decoratedId` to the decorator's
 * function name AND append the bare decorator name to `names` so
 * the caller can populate the decorated node's `decorators`
 * column. Quietly returns when `n` is null, when the node isn't
 * decorator-shaped, or when the decorator's leading identifier
 * can't be resolved (defensive — bad source input should not
 * abort the surrounding extraction pass).
 */
function recordDecoratorIfPresent(args: DecoratorRecordArgs, n: SyntaxNode | null): void {
  const { ext, decoratedId, names, argsByDecorator } = args;
  if (!n || !DECORATOR_NODE_TYPES.has(n.type)) return;
  const target = findDecoratorTarget(n);
  if (!target) return;
  let name = getNodeText(target, ext.source);
  // Reduce a qualified decorator name to its last segment: `a.b.Foo` /
  // `a::Foo` (TS/Java) and PHP's `\Drupal\…\Block` FQCN attribute all
  // collapse to the bare attr name. `\` only occurs in PHP, so adding it
  // doesn't affect other languages.
  const lastDot = Math.max(name.lastIndexOf('.'), name.lastIndexOf('::'), name.lastIndexOf('\\'));
  if (lastDot >= 0) name = name.slice(lastDot + 1).replace(/^[:.\\]/, '');
  if (!name) return;
  ext.unresolvedReferences.push({
    fromNodeId: decoratedId,
    referenceName: name,
    referenceKind: 'decorates',
    line: n.startPosition.row + 1,
    column: n.startPosition.column,
  });
  names.push(name);

  // B9 — capture call-expression args if the decorator was invoked
  // with arguments (`@Get('/path')`, `@Value('${k}')`, etc.). Bare
  // decorators (`@Override`) record null at the same index so the
  // positional alignment with `names` stays intact.
  const callNode = findDecoratorCallExpression(n);
  if (callNode) {
    const parsed = extractDecoratorCallArgs(callNode, ext.source);
    argsByDecorator.push(parsed ? { name, ...parsed } : null);
  } else {
    argsByDecorator.push(null);
  }
}

/**
 * Descend into a wrapper kind (`modifiers` / `attribute_list` /
 * `attribute_group`) and record each decorator-shaped named-child.
 * Recurses ONE level on a nested wrapper to cover PHP's
 * `attribute_list > attribute_group > attribute` shape (and any
 * future grammar that wraps decorators inside two wrappers).
 *
 * Why a dedicated helper instead of inlining wrapper-descent in
 * the main loop: keeps `tsExtractDecoratorsFor` linear in `declNode`'s
 * direct children — recursion depth is bounded by the wrapper nesting
 * (max 2 in any current grammar), not by source size.
 */
function recordDecoratorsInWrapper(args: DecoratorRecordArgs, wrapper: SyntaxNode): void {
  for (const child of wrapper.namedChildren) {
    if (!child) continue;
    if (DECORATOR_WRAPPER_TYPES.has(child.type)) {
      recordDecoratorsInWrapper(args, child);
      continue;
    }
    recordDecoratorIfPresent(args, child);
  }
}

/**
 * Walk the named-children of `declNode.parent` BACKWARDS from the
 * declaration's index, recording each decorator-shaped sibling and
 * STOPPING at the first non-decorator. Without the stop, decorators
 * belonging to an EARLIER unrelated declaration would leak in:
 * e.g. in `@A class Foo {} @B class Bar {}`, `@A` would otherwise
 * be attributed to `Bar`.
 *
 * Defensive: silently returns when there's no parent, when the
 * declaration's index can't be located (tree-sitter wrapper-identity
 * surprise), or when the declaration is the leftmost named child
 * (nothing precedes it).
 */
function recordPrecedingSiblingDecorators(args: DecoratorRecordArgs, declNode: SyntaxNode): void {
  const parent = declNode.parent;
  if (!parent) return;
  // Materialise children once — `namedChild(j)` is O(j) in
  // web-tree-sitter, so a backward scan walking N siblings is O(n²).
  const siblings = parent.namedChildren;
  const declIdx = siblings.findIndex((s) => s?.startIndex === declNode.startIndex);
  if (declIdx <= 0) return;
  for (let j = declIdx - 1; j >= 0; j--) {
    const sibling = siblings[j];
    if (!sibling) continue;
    if (!DECORATOR_NODE_TYPES.has(sibling.type)) return; // non-decorator separator → stop
    recordDecoratorIfPresent(args, sibling);
  }
}

/**
 * Extract a function call and push an unresolved `calls` reference.
 * Also handles TS/JS dynamic imports.
 */
export function tsExtractCall(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (ext.nodeStack.length === 0) return;
  const callerId = ext.nodeStack.at(-1);
  if (!callerId) return;

  const calleeName = tsResolveCalleeName(ext, node);

  if (calleeName) {
    ext.unresolvedReferences.push({
      fromNodeId: callerId,
      referenceName: calleeName,
      referenceKind: 'calls',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  if (
    ext.language === 'typescript' ||
    ext.language === 'javascript' ||
    ext.language === 'tsx' ||
    ext.language === 'jsx'
  ) {
    tsTryEmitDynamicImport(ext, node, calleeName);
  }
}

/**
 * F#82a (2026-05-29) — Reconstruct an Objective-C message-send selector
 * from a `message_expression` so a call ref name-matches the
 * `method_definition` name built by `extractObjcMethodName` (`greet` for a
 * no-arg send, `a:b:` for a keyword send).
 *
 * The grammar field-tags only the FIRST keyword as `(method)`; for a
 * multi-keyword send (`[obj a:1 b:2]`) the further keywords (`b`) appear as
 * bare `identifier` children interleaved with the argument expressions,
 * with no field to distinguish a keyword from an identifier-valued
 * argument. The one signal source preserves is the trailing colon: a
 * keyword is immediately followed by `:`. So the selector is every
 * non-receiver `identifier` child whose next source char is `:`, each
 * suffixed with `:` (`a:b:`).
 *
 * A no-arg send (`[obj greet]`) has no `:` after `greet`, so the keyword
 * list is empty and we return the bare method-field text (`greet`) —
 * mirroring `extractObjcMethodName`'s no-parameter branch.
 *
 * Known benign limitation: a compact ternary `[obj foo:c ? x:y]` (no space
 * before the inner `:`) would mis-read `x` as a keyword → `foo:x:`. That
 * selector matches no real method, so the ref merely stays UNRESOLVED
 * (never MIS-resolves), and idiomatic ObjC spaces the ternary colon.
 */
function buildObjcMessageSelector(node: SyntaxNode, source: string): string {
  const methodField = getChildByField(node, 'method');
  if (!methodField) return '';
  const receiverField = getChildByField(node, 'receiver');
  const keywords: string[] = [];
  for (const child of node.namedChildren) {
    if (child?.type !== 'identifier') continue;
    if (child.startIndex === receiverField?.startIndex) continue;
    if (source.charAt(child.endIndex) === ':') keywords.push(getNodeText(child, source));
  }
  if (keywords.length > 0) return keywords.map((k) => `${k}:`).join('');
  return getNodeText(methodField, source);
}

/**
 * Resolve the qualified call target name from an AST call node.
 * Returns `''` when no caller name can be resolved.
 */
function tsResolveCalleeName(ext: TreeSitterExtractor, node: SyntaxNode): string {
  const nameField = getChildByField(node, 'name');
  const objectField = getChildByField(node, 'object') || getChildByField(node, 'scope');
  if (isQualifiedInvocation(node, nameField, objectField)) {
    // F#64a (B11) — Java/Kotlin `this.field.method()` produces an
    // `object` field of type `field_access` whose first child is the
    // `this` literal and second child is the field identifier. The
    // raw text `this.field` doesn't match the matcher's single-dot
    // `obj.method` regex (two dots), so the call goes unresolved.
    // Strip the `this.` prefix so the receiver becomes just `field`,
    // feeding the existing Strategy 1/2 / inferJavaFieldReceiverType
    // path in the resolver. Other languages (TS/JS/Python/etc.) keep
    // the full receiver text — `this.x.y()` there is handled by the
    // METHOD_INVOCATION_SKIP_RECEIVERS check on the bare `this`
    // literal which `extractLeafReceiverName` already returns.
    return resolveQualifiedInvocationName(ext, nameField!, objectField!);
  }

  // F#65 / F#67 / F#82a — Objective-C `message_expression` (`[obj a:1 b:2]`).
  // `buildObjcMessageSelector` reconstructs the FULL selector so the call
  // ref name-matches its `method_definition` (named by `extractObjcMethodName`:
  // `greet` for a no-arg send, `a:b:` for a keyword send). Before F#82a this
  // returned only the `(method)` field (`a`), so EVERY arg-carrying send went
  // unresolved — not just multi-keyword: `[obj foo:1]` yielded `foo` while the
  // definition is `foo:`. Receivers `self` / `super` are skipped — same
  // convention as JS `this`.
  if (node.type === 'message_expression') {
    return resolveObjcMessageName(ext, node);
  }

  if (ext.language === 'ruby' && node.type === 'call') {
    return resolveRubyCallName(ext, node);
  }

  const func = getChildByField(node, 'function') || node.namedChild(0);
  if (!func) return '';

  if (
    func.type === 'member_expression' ||
    func.type === 'member_access_expression' ||
    func.type === 'attribute' ||
    func.type === 'selector_expression' ||
    func.type === 'navigation_expression'
  ) {
    return tsResolveMemberCallName(ext, func);
  }
  return getNodeText(func, ext.source);
}

function isQualifiedInvocation(
  node: SyntaxNode,
  nameField: SyntaxNode | null,
  objectField: SyntaxNode | null,
): boolean {
  return (
    !!nameField &&
    !!objectField &&
    (node.type === 'method_invocation' ||
      node.type === 'member_call_expression' ||
      node.type === 'scoped_call_expression')
  );
}

function resolveQualifiedInvocationName(
  ext: TreeSitterExtractor,
  nameField: SyntaxNode,
  objectField: SyntaxNode,
): string {
  const methodName = getNodeText(nameField, ext.source);
  if (ext.language === 'php' && isPhpCallReceiver(objectField)) {
    const receiverCallName = tsResolveCalleeName(ext, objectField);
    if (receiverCallName) return `${receiverCallName}().${methodName}`;
  }
  let receiverName = getNodeText(objectField, ext.source).replace(/^\$/, '');
  if ((ext.language === 'java' || ext.language === 'kotlin') && objectField.type === 'field_access') {
    const inner = unwrapJavaThisFieldAccess(objectField, ext.source);
    if (inner !== null) receiverName = inner;
  }
  return tsQualifyCallReceiver(methodName, receiverName, METHOD_INVOCATION_SKIP_RECEIVERS);
}

function isPhpCallReceiver(node: SyntaxNode): boolean {
  return (
    node.type === 'function_call_expression' ||
    node.type === 'member_call_expression' ||
    node.type === 'scoped_call_expression'
  );
}

function resolveObjcMessageName(ext: TreeSitterExtractor, node: SyntaxNode): string {
  const methodName = buildObjcMessageSelector(node, ext.source);
  if (!methodName) return '';
  const receiverName = readObjcReceiverName(ext, node);
  return receiverName ? `${receiverName}.${methodName}` : methodName;
}

function readObjcReceiverName(ext: TreeSitterExtractor, node: SyntaxNode): string | null {
  const receiverField = getChildByField(node, 'receiver');
  if (!receiverField || receiverField.type === 'message_expression') return null;
  const receiverName = getNodeText(receiverField, ext.source);
  return receiverName && receiverName !== 'self' && receiverName !== 'super' ? receiverName : null;
}

function resolveRubyCallName(ext: TreeSitterExtractor, node: SyntaxNode): string {
  const method = getChildByField(node, 'method');
  if (!method) return '';
  const methodName = getNodeText(method, ext.source);
  if (!methodName) return '';

  const receiver = getChildByField(node, 'receiver');
  if (!receiver) return methodName;

  const receiverName = rubyReceiverName(ext, receiver, methodName);
  return tsQualifyCallReceiver(methodName, receiverName, MEMBER_CALL_SKIP_RECEIVERS);
}

function rubyReceiverName(ext: TreeSitterExtractor, receiver: SyntaxNode, methodName: string): string {
  if (receiver.type === 'call') {
    const nested = resolveRubyCallName(ext, receiver);
    if (methodName !== 'new' && nested.endsWith('.new')) return nested.slice(0, -'.new'.length);
    return nested;
  }
  return getNodeText(receiver, ext.source);
}

/**
 * Resolve the qualified name for a member-access call.
 *
 * Go cgo special case: `C.foo(...)` is a pseudo-receiver — the `C`
 * identifier comes from `import "C"` (the cgo bridge), not from a
 * value in the source. The C function lives in a sibling .c/.h file
 * with bare name `foo`. Strip the `C.` prefix for Go so the
 * unresolved-ref matches the indexed C function instead of looking
 * for a non-existent `C.foo` qualified name.
 */
function tsResolveMemberCallName(ext: TreeSitterExtractor, func: SyntaxNode): string {
  let property = getChildByField(func, 'property') || getChildByField(func, 'field');
  if (!property) {
    const child1 = func.namedChild(1);
    if (child1?.type === 'navigation_suffix') {
      property = child1.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier') ?? child1;
    } else {
      property = child1;
    }
  }
  if (!property) return '';

  const methodName = getNodeText(property, ext.source);
  const receiver = getChildByField(func, 'object') || getChildByField(func, 'operand') || func.namedChild(0);
  const receiverName = receiver ? extractLeafReceiverName(receiver, ext.source, MEMBER_CALL_SKIP_RECEIVERS) : null;
  if (ext.language === 'go' && receiverName === 'C') return methodName;
  if (!receiverName && receiver && isNestedCallReceiver(ext, receiver)) {
    const chainedReceiver = tsResolveCalleeName(ext, receiver);
    if (chainedReceiver) return `${chainedReceiver}().${methodName}`;
  }
  return tsQualifyCallReceiver(methodName, receiverName ?? '', MEMBER_CALL_SKIP_RECEIVERS);
}

function isNestedCallReceiver(ext: TreeSitterExtractor, node: SyntaxNode): boolean {
  return ext.extractor?.callTypes.includes(node.type) ?? node.type === 'call_expression';
}

/**
 * F#64a (B11, 2026-05-26) — Unwrap a Java/Kotlin `field_access`
 * node of shape `this.<X>` to just `<X>`. Returns the field name
 * when the access is `this.<X>` exactly; null when the shape
 * doesn't match (no `this` literal, deeper nesting, missing
 * identifier child).
 *
 * tree-sitter-java shape: `field_access > [this, identifier]`. We
 * scan the named children for a `this` and a sibling identifier.
 * Deeper nesting (`this.x.y`) deliberately returns null so the
 * caller falls back to the full text rather than picking an
 * arbitrary inner identifier.
 */
function unwrapJavaThisFieldAccess(fieldAccess: SyntaxNode, source: string): string | null {
  if (fieldAccess.namedChildCount !== 2) return null;
  const a = fieldAccess.namedChild(0);
  const b = fieldAccess.namedChild(1);
  if (!a || !b) return null;
  if (a.type !== 'this') return null;
  if (b.type !== 'identifier' && b.type !== 'field_identifier') return null;
  return getNodeText(b, source);
}

/**
 * Combine a method name with a receiver, dropping pronoun-like receivers.
 */
function tsQualifyCallReceiver(methodName: string, receiverName: string, skipReceivers: ReadonlySet<string>): string {
  if (!methodName) return '';
  if (!receiverName || skipReceivers.has(receiverName)) return methodName;
  return `${receiverName}.${methodName}`;
}

/**
 * Unwrap TS expression wrappers around a dynamic-import string argument.
 * Handles `'foo' as any` (as_expression), `<string>'foo'` (type_assertion),
 * `('foo')` (parenthesized_expression), `'foo' satisfies S` (satisfies_expression),
 * and nested combinations — descends recursively to the inner `string` or
 * `template_string` node. Returns null if no string literal is found.
 *
 * Without this, `await import('node-llama-cpp' as any)` (and other TS-cast
 * dynamic-import patterns) produce zero import nodes, which then causes
 * `cartograph_deps` to flag the package as unused.
 */
function tsUnwrapStringArg(node: SyntaxNode | null | undefined): SyntaxNode | null {
  if (!node) return null;
  if (node.type === 'string' || node.type === 'template_string') return node;
  if (
    node.type === 'as_expression' ||
    node.type === 'type_assertion' ||
    node.type === 'satisfies_expression' ||
    node.type === 'parenthesized_expression'
  ) {
    for (const inner of node.namedChildren) {
      const found = tsUnwrapStringArg(inner);
      if (found) return found;
    }
  }
  return null;
}

/**
 * TS/JS dynamic import detection: `import('./foo')` and `require('./foo')`.
 * `calleeName` is pre-computed by the caller (`tsExtractCall`) and passed in
 * to avoid re-resolving it. `callerId` is read from the top of the node stack.
 */
function tsTryEmitDynamicImport(ext: TreeSitterExtractor, node: SyntaxNode, calleeName: string): void {
  const isDynamicImportKeyword = node.namedChildren.some((c: SyntaxNode) => c.type === 'import');
  // Match `require(...)` plus `createRequire`-bound aliases. Canonical ESM
  // bridge: `const requireCjs = createRequire(import.meta.url)` then
  // `requireCjs('pkg')`. Without recognising the alias, the dynamic-import
  // node never emits → `cartograph deps` reports the loaded package as
  // unused (e.g. `sqlite-vec`, which loads via this pattern). Match callees
  // named `require` or `require<Suffix>` (e.g. `requireCjs`, `requireESM`).
  const isRequireCall = !isDynamicImportKeyword && (calleeName === 'require' || /^require[A-Z]/.test(calleeName));
  if (!isDynamicImportKeyword && !isRequireCall) return;

  const args = getChildByField(node, 'arguments');
  // Search direct args for a string/template_string first, then fall back to
  // unwrapping a single wrapped expression (e.g. `'foo' as any` → `'foo'`).
  let firstStringArg: SyntaxNode | null | undefined = args?.namedChildren.find(
    (c: SyntaxNode) => c.type === 'string' || c.type === 'template_string',
  );
  if (!firstStringArg && args) {
    for (const argChild of args.namedChildren) {
      const unwrapped = tsUnwrapStringArg(argChild);
      if (unwrapped) {
        firstStringArg = unwrapped;
        break;
      }
    }
  }
  if (!firstStringArg) return;

  const moduleName = getNodeText(firstStringArg, ext.source).replaceAll(/^['"`]|['"`]$/g, '');
  if (!moduleName) return;

  // callerId is the top of the scope stack — same value the caller computed,
  // re-read here so this function stays at ≤3 declared parameters.
  const callerId = ext.nodeStack.at(-1);
  if (!callerId) return;

  ext.createNode({
    kind: 'import',
    name: moduleName,
    node,
    extra: {
      signature: getNodeText(node, ext.source).trim(),
    },
  });
  ext.unresolvedReferences.push({
    fromNodeId: callerId,
    referenceName: moduleName,
    referenceKind: 'imports',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * `new Foo(...)` (JS/TS) / `object_creation_expression` (Java/C#) /
 * `struct_expression` (Rust `Foo { x: 1 }` literal construction) /
 * `composite_literal` (Go `Foo{X: 1}` and `&Foo{X: 1}` — F#44) —
 * emit an `instantiates` reference. Tuple-struct construction
 * (`Foo(1, 2)` in Rust) routes through `tsExtractCall` instead — see
 * the comment on {@link INSTANTIATION_KINDS} for why.
 *
 * Go's `composite_literal` is also used for slice / map / array
 * literals (`[]int{1,2,3}`, `map[string]int{...}`); the type-kind gate
 * below (via {@link STRUCT_LITERAL_CTOR_KINDS}) keeps those out of the
 * instantiates stream — only `type_identifier` / `qualified_type` /
 * `generic_type` (the actual struct-name shapes) qualify.
 */
export function tsExtractInstantiation(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (ext.nodeStack.length === 0) return;
  const fromId = ext.nodeStack.at(-1);
  if (!fromId) return;

  const ctor =
    getChildByField(node, 'constructor') ||
    getChildByField(node, 'type') ||
    getChildByField(node, 'name') ||
    node.namedChild(0);
  if (!ctor) return;

  // F#44 (2026-05-26): for Go's composite_literal, gate on the type
  // child's kind. Slice / map / array / channel literals share the
  // composite_literal node but are NOT instantiations of a project
  // struct. Other instantiation kinds (TS `new_expression`, Rust
  // `struct_expression`, etc.) always carry a name-bearing ctor and
  // pass the gate trivially because their ctor kind is `identifier` /
  // `member_expression` / `type_identifier` (the Rust case) — none of
  // which are in STRUCT_LITERAL_CTOR_KINDS, so the gate ONLY fires
  // when the host node is `composite_literal` (Go).
  if (node.type === 'composite_literal' && !STRUCT_LITERAL_CTOR_KINDS.has(ctor.type)) return;

  let className = getNodeText(ctor, ext.source);
  const ltIdx = className.indexOf('<');
  if (ltIdx > 0) className = className.slice(0, ltIdx);
  // Generic structs in Go use brackets: `Foo[T]{}`. Strip them too so
  // the resolver sees the bare struct name.
  const bracketIdx = className.indexOf('[');
  if (bracketIdx > 0) className = className.slice(0, bracketIdx);
  const lastDot = Math.max(className.lastIndexOf('.'), className.lastIndexOf('::'));
  if (lastDot >= 0) className = className.slice(lastDot + 1).replace(/^[:.]/, '');
  className = className.trim();

  if (className) {
    ext.unresolvedReferences.push({
      fromNodeId: fromId,
      referenceName: className,
      referenceKind: 'instantiates',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }
}

/**
 * Scan `declNode` and its preceding siblings for decorator nodes, emitting
 * a `decorates` reference from `decoratedId` to each decorator's name AND
 * populating the decorated node's `decorators` column with the same names.
 *
 * The dual write keeps the unresolved-ref edge (used by the resolver to
 * link `decorates` edges) in sync with the materialised string list (used
 * by the role-labeler heuristics that want decorator names in O(1)
 * without a graph hop). Without the column write the role classifier
 * starves on framework_glue and data_model — friction tracker #14.
 */
export function tsExtractDecoratorsFor(ext: TreeSitterExtractor, declNode: SyntaxNode, decoratedId: string): void {
  const names: string[] = [];
  const argsByDecorator: Array<DecoratorArgsEntry | null> = [];
  const dArgs: DecoratorRecordArgs = { ext, decoratedId, names, argsByDecorator };
  // 1. Decorators that are direct children of the declaration (TS/JS/Python).
  // 2. Decorators wrapped inside a `modifiers` / `attribute_list` / `attribute_group`
  //    direct-child (Java/C#/PHP). Descend up to two levels deep to cover PHP's
  //    `attribute_list > attribute_group > attribute` shape.
  for (const child of declNode.namedChildren) {
    if (!child) continue;
    if (DECORATOR_WRAPPER_TYPES.has(child.type)) {
      recordDecoratorsInWrapper(dArgs, child);
      continue;
    }
    recordDecoratorIfPresent(dArgs, child);
  }
  // 3. Decorators that are PRECEDING siblings of the declaration (TS/JS legacy class decorators).
  recordPrecedingSiblingDecorators(dArgs, declNode);

  if (names.length === 0) return;

  // Mutate the just-created decorated node so its `decorators` column is
  // populated on insert. Search backwards because createNode pushes to
  // ext.nodes immediately and the decorated node is almost always the
  // last entry — bounded scan keeps this O(1) in the common path.
  for (let k = ext.nodes.length - 1; k >= 0; k--) {
    const candidate = ext.nodes[k];
    if (candidate?.id === decoratedId) {
      applyDecoratorMetadata(candidate, names, argsByDecorator);
      return;
    }
  }
}

function applyDecoratorMetadata(
  candidate: { decorators?: string[]; decoratorArgs?: DecoratorArgsEntry[] },
  names: string[],
  argsByDecorator: Array<DecoratorArgsEntry | null>,
): void {
  const existing = candidate.decorators;
  candidate.decorators = existing && existing.length > 0 ? [...existing, ...names] : names;

  // B9 — persist the per-decorator args. Drop the field entirely
  // when every entry is null (no call-form decorators on this
  // symbol) so the column stays NULL in the DB and we don't pay
  // JSON-encode cost or storage on legacy `@Override`-only
  // patterns. Compact representation: keep all non-null entries
  // in source order; consumers index by `name` via `.find()`.
  const compactArgs = argsByDecorator.filter((a): a is DecoratorArgsEntry => a !== null);
  if (compactArgs.length === 0) return;
  const prior = candidate.decoratorArgs;
  candidate.decoratorArgs = prior && prior.length > 0 ? [...prior, ...compactArgs] : compactArgs;
}
