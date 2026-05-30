import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageDef } from './types.js';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types.js';

/**
 * Fish extraction.
 *
 * Fish has a smaller AST surface than bash but a different shape:
 *
 *   1. `function name … end` — `function_definition` has a `name` field but
 *      NO body field. The function body is the sequence of named children
 *      (mostly `command` nodes) between the name and the trailing unnamed
 *      `end` keyword. Optional `--description '…'` flags are interleaved
 *      with the name in the children list.
 *   2. Variables are NOT a dedicated node type — `set X value`,
 *      `set -g VAR …`, `set -x EXPORTED …`, `set -l local_only …` are all
 *      ordinary `command` nodes with name `set`. Scope flags determine
 *      whether the assignment is exported / local / universal.
 *   3. Sourcing is `source path` or `. path`, same as bash.
 *
 * Strategy:
 *   - `functionTypes: []` — handled in `visitNode` since the core's
 *     `extractFunction` walks `bodyField`, which fish lacks.
 *   - `callTypes: ['command']` — for everything except `source`/`.`/`set`,
 *     core's `extractCall` reads `namedChild(0)` (the `word` carrying the
 *     command name) and emits a calls-edge.
 *   - `visitNode` intercepts:
 *       * `function_definition` → create the function node, push scope, walk
 *         the body children, pop scope. Returns `true` (fully handled).
 *       * `command` whose name is `source`/`.` → import node carrying the
 *         path. Returns `true` so the calls-edge to "source" is suppressed.
 *       * `command` whose name is `set` → variable / constant node, with
 *         `isExported=true` for `-x` / `-U`. `set -l` (function-local) is
 *         skipped, mirroring bash's `local`. Returns `true`.
 *
 * Tree-sitter grammar: ram02z/tree-sitter-fish v3.7.0, MIT — loaded as
 * fish.wasm by web-tree-sitter from src/extraction/wasm/.
 */

const FISH_LOCAL_FLAGS: ReadonlySet<string> = new Set(['-l', '--local']);
const FISH_EXPORT_FLAGS: ReadonlySet<string> = new Set(['-x', '--export', '-U', '--universal']);
// `set` flags that DON'T create or rebind a variable — e.g. erasure, query,
// show. Without this guard, `set -e MY_VAR` would emit a false-positive
// variable node for a variable being deleted.
const FISH_SET_NON_DECL_FLAGS: ReadonlySet<string> = new Set(['-e', '--erase', '-q', '--query', '-S', '--show']);

const fishExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['command'],
  variableTypes: [],

  // Fish function_definition has no body field; bodyField is unused but the
  // contract requires a string. Pick a name guaranteed to never match a
  // child field on any fish node.
  nameField: 'name',
  bodyField: '__no_body_field__',
  paramsField: '__no_params_field__',

  visitNode: (node, ctx) => {
    if (node.type === 'function_definition') {
      handleFishFunction(node, ctx);
      return true;
    }
    if (node.type === 'command') {
      const name = node.childForFieldName('name')?.text?.trim() ?? '';
      if (name === 'source' || name === '.') {
        emitFishSourceImport(node, ctx);
        return true;
      }
      if (name === 'set') {
        handleFishSet(node, ctx);
        return true;
      }
    }
    return false;
  },
};

function handleFishFunction(node: SyntaxNode, ctx: ExtractorContext): void {
  // tree-sitter-fish puts the function name as the first named child (a `word`
  // node). The `name` field also points at it, but the tree-sitter runtime
  // doesn't guarantee referential identity across `namedChild(i)` /
  // `childForFieldName` calls, so we identify the name by ordinal: index 0 = name, 1.. = options
  // (until the first non-word/string child) followed by the body statements.
  if (node.namedChildCount === 0) return;
  const nameNode = node.namedChild(0);
  if (!nameNode || nameNode.type !== 'word') return;
  const name = getNodeText(nameNode, ctx.source).trim();
  if (!name) return;

  const optionsText = collectFishFunctionOptions(node, ctx.source);
  const sigWithOpts = `${name} ${optionsText}`;
  const signature = optionsText ? sigWithOpts : name;

  const fnNode = ctx.createNode({ kind: 'function', name, node, extra: { signature } });
  if (!fnNode) return;

  ctx.pushScope(fnNode.id);
  try {
    // We use `ctx.visitNode` rather than `ctx.visitFunctionBody` (the path
    // R/Ruby take) because fish has no distinct body node — option flags
    // and body statements are siblings under `function_definition`, so we
    // dispatch each remaining child through the full hook chain. Nested
    // `function` definitions are valid in fish; the recursive `visitNode`
    // re-entry handles them with correct scope push/pop.
    for (let i = 1; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      // Function options (e.g. `-d`, `--description '...'`) appear as
      // bare `word` / quoted-string children before the body — skip them.
      if (child.type === 'word' || child.type === 'single_quote_string' || child.type === 'double_quote_string') {
        continue;
      }
      ctx.visitNode(child);
    }
  } finally {
    ctx.popScope();
  }
}

function collectFishFunctionOptions(funcNode: SyntaxNode, source: string): string {
  const parts: string[] = [];
  for (let i = 1; i < funcNode.namedChildCount; i++) {
    const child = funcNode.namedChild(i);
    if (!child) continue;
    if (child.type !== 'word' && child.type !== 'single_quote_string' && child.type !== 'double_quote_string') break;
    parts.push(getNodeText(child, source));
  }
  return parts.join(' ');
}

function emitFishSourceImport(node: SyntaxNode, ctx: ExtractorContext): void {
  const arg = nthFishCommandArg(node, 0);
  if (!arg) return;
  const path = readFishLiteralPath(arg, ctx.source);
  if (!path) return;
  ctx.createNode({ kind: 'import', name: path, node, extra: { signature: getNodeText(node, ctx.source) } });
}

/**
 * Return the literal text of a fish `source` argument IF it has no
 * variable / command expansion, else null. Drops dynamic paths like
 * `source $config_dir/lib.fish` and `source (status filename)/common.fish`
 * where the target can't be resolved.
 */
function readFishLiteralPath(arg: SyntaxNode, source: string): string | null {
  if (arg.type === 'word') {
    const text = getNodeText(arg, source);
    return text.includes('$') || text.includes('(') ? null : text;
  }
  if (arg.type === 'single_quote_string') {
    return unquoteFishLiteral(getNodeText(arg, source));
  }
  if (arg.type === 'double_quote_string') {
    for (const child of arg.namedChildren) {
      if (!child) continue;
      // Any non-content child = expansion / interpolation. Bail.
      if (child.type !== 'string_content') return null;
    }
    return unquoteFishLiteral(getNodeText(arg, source));
  }
  return null;
}

interface FishSetParse {
  varName: string | null;
  varPositionNode: SyntaxNode | null;
  valueText: string | null;
  isExported: boolean;
  /** True when a flag like `--local` says "don't emit a node at all". */
  aborted: boolean;
}

function handleFishSet(node: SyntaxNode, ctx: ExtractorContext): void {
  const parse = parseFishSetArgs(node, ctx);
  if (parse.aborted) return;
  if (!parse.varName || !parse.varPositionNode) return;

  const signature = parse.valueText ? `= ${parse.valueText}` : undefined;
  ctx.createNode({
    kind: 'variable',
    name: parse.varName,
    node: parse.varPositionNode,
    extra: signature ? { isExported: parse.isExported, signature } : { isExported: parse.isExported },
  });
}

/** Walk the `set` invocation's args and build the parse state. Pulled
 *  out of {@link handleFishSet} so the for-loop body's per-arg
 *  branching doesn't sit 3-deep under the outer scaffold (the
 *  `if (text.startsWith('-')) { … flag tests … }` chain pushes the
 *  flag-classification line to depth 4). Helper variant runs at
 *  depth ≤2 because the outer "is this set worth emitting" decision
 *  lives in the caller now. */
function parseFishSetArgs(node: SyntaxNode, ctx: ExtractorContext): FishSetParse {
  const state: FishSetParse = {
    varName: null,
    varPositionNode: null,
    valueText: null,
    isExported: false,
    aborted: false,
  };
  for (let i = 1; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const text = getNodeText(child, ctx.source);
    consumeFishSetArg(state, child, text);
    if (state.aborted) return state;
  }
  return state;
}

/** Apply one positional arg to the in-flight parse state. Mutates
 *  `state` in place. Splitting this off keeps {@link parseFishSetArgs}
 *  to a flat for-loop and lets the per-arg branching stay readable
 *  without deep `if/else` chains. */
function consumeFishSetArg(state: FishSetParse, child: SyntaxNode, text: string): void {
  if (state.varName === null) {
    if (text.startsWith('-')) {
      applyFishSetFlag(state, text);
      return;
    }
    state.varName = text.trim();
    state.varPositionNode = child;
    return;
  }
  if (state.valueText !== null) return;
  let value = unquoteFishLiteral(text).slice(0, 100);
  if (text.length >= 100) value += '...';
  state.valueText = value;
}

/** Classify a `set ...` flag token and update `state`. */
function applyFishSetFlag(state: FishSetParse, text: string): void {
  if (FISH_LOCAL_FLAGS.has(text) || FISH_SET_NON_DECL_FLAGS.has(text)) {
    state.aborted = true;
    return;
  }
  if (FISH_EXPORT_FLAGS.has(text)) state.isExported = true;
}

function nthFishCommandArg(commandNode: SyntaxNode, n: number): SyntaxNode | null {
  let seen = 0;
  for (let i = 1; i < commandNode.namedChildCount; i++) {
    const child = commandNode.namedChild(i);
    if (!child) continue;
    if (seen === n) return child;
    seen++;
  }
  return null;
}

function unquoteFishLiteral(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return text.slice(1, -1);
  }
  return text;
}

export const FISH_DEF: LanguageDef = {
  name: 'fish',
  displayName: 'Fish',
  extensions: ['.fish'],
  includeGlobs: ['**/*.fish'],
  grammar: { wasmFile: 'fish.wasm', extractor: fishExtractor },
};
