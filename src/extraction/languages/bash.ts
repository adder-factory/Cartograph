import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageDef } from './types.js';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types.js';

/**
 * Bash extraction.
 *
 * Bash is procedural: function declarations live at the top level and inside
 * functions, every statement is a `command` (or pipeline / control-flow
 * thereof), and variables are `name=value` (optionally wrapped in
 * `export` / `readonly` / `local` / `declare`). The grammar does NOT have
 * dedicated import nodes — sourcing is just a `command` whose name is
 * `source` or `.`. The same grammar parses Zsh well enough for the
 * constructs we extract; see `zsh.ts` for the parallel registration.
 *
 * Strategy:
 *   - `functionTypes: ['function_definition']`
 *     Both `function name() {}` and `name() {}` parse to the same node;
 *     core dispatch via `nameField: 'name'` / `bodyField: 'body'` Just Works.
 *   - `callTypes: ['command']`
 *     Core's `extractCall` reads `namedChild(0)` which is `command_name`,
 *     whose text is the callee — `greet`, `echo`, `mkdir`, `my_func`, etc.
 *     The resolver's name-matcher already drops cross-module weak matches
 *     against builtins, so we don't need an allowlist here.
 *   - Variables and sourcing handled in `visitNode`:
 *       * `local x=…` is skipped entirely (function-private temporary, noise).
 *       * `variable_assignment` → `variable` (or `constant` if wrapped in
 *         `readonly`); `isExported=true` if wrapped in `export`. The core's
 *         generic `extractVariable` doesn't know how to read bash's
 *         `variable_name` field, so we emit the node ourselves.
 *       * `command` with name `source` or `.` → `import` node carrying the
 *         path; the calls-edge that the core would otherwise emit is
 *         suppressed by returning `true` from the hook.
 *
 * Out of scope (v1): variable references (`$X`), aliases, heredoc bodies,
 * `trap` handlers, `eval`'d strings, and shebang-based language detection
 * for extensionless scripts. POSIX-sh dialect detection is also out of scope —
 * `.sh` files are treated as bash even when they use only POSIX features.
 */

const BASH_DECL_MODIFIERS: ReadonlySet<string> = new Set(['export', 'readonly', 'declare', 'typeset']);

export const bashExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['command'],
  variableTypes: [],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node) => {
    const name = node.childForFieldName('name')?.text ?? '';
    return name ? `${name}()` : undefined;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'declaration_command') {
      const modifier = node.child(0)?.type ?? '';
      if (modifier === 'local') return true;
      if (BASH_DECL_MODIFIERS.has(modifier)) return false;
      return false;
    }

    if (node.type === 'variable_assignment') {
      emitBashVariable(node, ctx);
      return true;
    }

    if (node.type === 'command') {
      const cmd = node.childForFieldName('name')?.text?.trim() ?? '';
      if (cmd === 'source' || cmd === '.') {
        emitBashSourceImport(node, ctx);
        return true;
      }
    }

    return false;
  },
};

/** Render a `signature` field for a bash variable declaration, with a
 *  trailing ellipsis when the value text was clipped at 100 chars. */
function formatBashSignature(initText: string): string | undefined {
  if (!initText) return undefined;
  const ellipsis = initText.length >= 100 ? '...' : '';
  return `= ${initText}${ellipsis}`;
}

/** Read the bash modifier keyword (`export`/`readonly`/...) prefixed
 *  on a `declaration_command`, or `null` for a bare assignment.
 *  Pulled out of `emitBashVariable` so its conditional doesn't push
 *  the parent over the operand budget. */
function readBashDeclarationModifier(node: SyntaxNode): string | null {
  if (node.parent?.type !== 'declaration_command') return null;
  return node.parent.child(0)?.type ?? null;
}

function emitBashVariable(node: SyntaxNode, ctx: ExtractorContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, ctx.source).trim();
  if (!name) return;

  const modifier = readBashDeclarationModifier(node);
  const isExported = modifier === 'export';
  const isConst = modifier === 'readonly';
  const kind = isConst ? 'constant' : 'variable';

  const valueNode = node.childForFieldName('value');
  const initText = valueNode ? getNodeText(valueNode, ctx.source).slice(0, 100) : '';
  const signature = formatBashSignature(initText);

  const positionNode = modifier ? bashDeclarationPosition(node) : node;
  const base = { isExported, isConst };
  const meta = signature ? { ...base, signature } : base;
  ctx.createNode({ kind, name, node: positionNode, extra: meta });
}

function bashDeclarationPosition(node: SyntaxNode): SyntaxNode {
  return node.parent ?? node;
}

function emitBashSourceImport(node: SyntaxNode, ctx: ExtractorContext): void {
  const path = readBashSourceArg(node, ctx.source);
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

function readBashSourceArg(commandNode: SyntaxNode, source: string): string | null {
  for (const child of commandNode.namedChildren) {
    if (!child || child.type === 'command_name') continue;
    if (child.type === 'word' || child.type === 'raw_string') {
      return unquoteBashLiteral(getNodeText(child, source));
    }
    if (child.type === 'string') {
      return readBashLiteralString(child, source);
    }
    return null;
  }
  return null;
}

/**
 * Return the literal text of a bash double-quoted string IF it has no
 * interpolation (no command_substitution, no expansions, no arithmetic),
 * else null. Used to drop dynamic source paths like
 * `source "$(dirname "$0")/lib.sh"` where we can't resolve the target.
 */
function readBashLiteralString(stringNode: SyntaxNode, source: string): string | null {
  const parts: string[] = [];
  for (const child of stringNode.namedChildren) {
    if (!child) continue;
    if (child.type === 'string_content') {
      parts.push(getNodeText(child, source));
      continue;
    }
    return null;
  }
  return parts.join('');
}

function unquoteBashLiteral(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return text.slice(1, -1);
  }
  return text;
}

export const BASH_DEF: LanguageDef = {
  name: 'bash',
  displayName: 'Bash',
  extensions: ['.sh', '.bash'],
  includeGlobs: ['**/*.sh', '**/*.bash'],
  // tree-sitter-bash (MIT) — loaded as bash.wasm by web-tree-sitter from src/extraction/wasm/.
  grammar: { wasmFile: 'bash.wasm', extractor: bashExtractor },
};
