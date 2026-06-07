/**
 * Tree-sitter Shared Helpers
 *
 * Utility functions used by the core TreeSitterExtractor and per-language extractors.
 * Extracted to a leaf module to avoid circular imports between tree-sitter.ts and languages/.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import * as crypto from 'node:crypto';
import type { NodeKind } from '../types.js';

/**
 * Generate a stable node ID.
 *
 * The id formula is intentionally line-independent so a format-only
 * change (whitespace / comment movement) leaves every symbol's id
 * unchanged. That stability lets `eoPersistFileExtraction` skip its
 * `removeFileFromIndexInTx` cascade-delete on a format-only re-extract,
 * preserving edges / role_assignments / code_health_findings in place.
 *
 * `ordinal` is the per-(filePath, kind, name) occurrence counter,
 * starting at 0. It disambiguates same-name same-kind nodes (TS
 * overloads, hoisted JS functions, Python conditional defs, etc.)
 * without dragging in line numbers. Almost every extractor mints ids
 * by walking the AST in source order, and that order survives
 * whitespace reformat — so `ordinal` is structurally stable.
 *
 * Pre-2026-05-21 the formula used `line` instead of `ordinal`. Caused a
 * full node + edge churn on every formatter run (607-file biome pass →
 * ~5 min sync, 2026-05-21 incident). Migration 066 wipes pre-existing
 * nodes; the first sync after upgrade re-extracts under the new formula.
 */
interface GenerateNodeIdArgs {
  filePath: string;
  kind: NodeKind;
  name: string;
  ordinal: number;
}

export function generateNodeId(args: GenerateNodeIdArgs): string {
  const { filePath, kind, name, ordinal } = args;
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${ordinal}`)
    .digest('hex')
    .substring(0, 32);
  return `${kind}:${hash}`;
}

/**
 * Per-file ordinal-allocating factory for `generateNodeId`.
 *
 * Use this from every extractor instead of calling `generateNodeId`
 * directly: the factory tracks the per-(kind, name) occurrence count
 * so two consecutive `function foo` declarations get distinct ids
 * (`foo:hash:0`, `foo:hash:1`) without leaking the source line.
 *
 * One factory per file extraction. Discard at end of the file's
 * extract — counters are NOT shared across files.
 */
export interface NodeIdFactory {
  next(kind: NodeKind, name: string): string;
}

export function createIdFactory(filePath: string): NodeIdFactory {
  const counters = new Map<string, number>();
  return {
    next(kind, name) {
      const key = `${kind}:${name}`;
      const ordinal = counters.get(key) ?? 0;
      counters.set(key, ordinal + 1);
      return generateNodeId({ filePath, kind, name, ordinal });
    },
  };
}

/**
 * Extract text from a syntax node
 */
export function getNodeText(node: SyntaxNode, source: string): string {
  return source.substring(node.startIndex, node.endIndex);
}

/**
 * Find a child node by field name
 */
export function getChildByField(node: SyntaxNode, fieldName: string): SyntaxNode | null {
  return node.childForFieldName(fieldName);
}

/**
 * A "decorative rule" comment line — a run of ruling punctuation used
 * purely as a visual section divider (`-------`, `=======`, `*******`,
 * box-drawing `───────`, etc.). These are layout, not documentation:
 * a `// ─── Handler ───` banner above a function is a file-section
 * marker, not that function's docstring. When such lines leaked into a
 * symbol's docstring they poisoned downstream consumers — the role
 * classifier saw `------\nHandler\n------` and guessed `data_model`
 * (friction sweep 2026-05-16). The `{3,}` floor keeps a lone `-` or
 * `*` in real prose from being dropped. ASCII `.` is deliberately NOT
 * a ruling char — a bare `...` ellipsis line in real prose would
 * otherwise be eaten; `·` (middle dot) covers genuine dot-leader rules.
 */
const DECORATIVE_RULE_RE = /^[-=*_~#/+<>·•─━┄┅╌╍═]{3,}$/;

function isDecorativeRuleLine(line: string): boolean {
  return DECORATIVE_RULE_RE.test(line.replaceAll(/\s+/g, ''));
}

/**
 * Get the docstring/comment preceding a node.
 *
 * For TS/JS the `function_declaration` / `class_declaration` /
 * `interface_declaration` / `lexical_declaration` we receive is
 * usually the sole named child of an `export_statement` wrapper,
 * so its own `previousNamedSibling` is null. The JSDoc lives one
 * level up — as a sibling of the export wrapper. Walk up through
 * any export-statement parent that has no preceding sibling of its
 * own before scanning for comments, otherwise every `export function`
 * with a JSDoc above it loses its docstring.
 *
 * Decorative section-banner rule lines are stripped from the result
 * (see {@link isDecorativeRuleLine}); when nothing but banners
 * precedes the node the docstring is `undefined`, not a row of dashes.
 */
export function getPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
  let target = node;
  while (target.parent?.type === 'export_statement' && target.previousNamedSibling === null) {
    target = target.parent;
  }
  let sibling = target.previousNamedSibling;
  const comments: string[] = [];

  while (sibling) {
    if (
      sibling.type === 'comment' ||
      sibling.type === 'line_comment' ||
      sibling.type === 'block_comment' ||
      sibling.type === 'documentation_comment'
    ) {
      comments.unshift(getNodeText(sibling, source));
      sibling = sibling.previousNamedSibling;
    } else {
      break;
    }
  }

  if (comments.length === 0) return undefined;

  // Clean up comment markers, then drop decorative section-banner rule
  // lines so a `// ─── Handler ───` divider doesn't masquerade as a
  // docstring. If nothing meaningful survives, there is no docstring.
  const cleaned = comments
    .map((c) =>
      c
        .replaceAll(/^\/\*\*?|\*\/$/g, '')
        .replaceAll(/^\/\/\s?/gm, '')
        .replaceAll(/^\s*\*\s?/gm, '')
        .trim(),
    )
    .join('\n')
    .split('\n')
    .filter((line) => !isDecorativeRuleLine(line))
    .join('\n')
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Recursively check whether the subtree rooted at `node` contains a
 * descendant whose `type` matches `targetType`. Used by Go / C / C++
 * struct extraction to distinguish embedded types (no field name)
 * from named field declarations (where a `field_identifier` lives
 * somewhere underneath, possibly nested through `pointer_declarator`,
 * `array_declarator`, init declarators).
 */
export function subtreeContainsType(node: SyntaxNode, targetType: string): boolean {
  if (node.type === targetType) return true;
  for (const child of node.namedChildren) {
    if (child && subtreeContainsType(child, targetType)) return true;
  }
  return false;
}

/**
 * Find the first named child whose `type` is in the given list.
 * Used to locate inner type nodes (e.g. `enum_specifier` inside a
 * `typedef`, `struct_type` inside a `type_spec`).
 */
export function findChildByTypes(node: SyntaxNode, types: ReadonlyArray<string>): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child && types.includes(child.type)) return child;
  }
  return null;
}

/**
 * Languages whose grammars carry first-class type annotations the
 * extractor walks (function param types, return types, field types,
 * variable annotations). Listed here so the type-annotation pass
 * can short-circuit on languages that simply don't have them.
 */
export const TYPE_ANNOTATION_LANGUAGES: ReadonlySet<string> = new Set([
  'apex',
  'typescript',
  'tsx',
  'dart',
  'kotlin',
  'swift',
  'rust',
  'go',
  'java',
  'csharp',
  'python',
  'scala',
  'php',
  'c',
  'cpp',
  'pascal',
]);
