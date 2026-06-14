/**
 * Tests for `readStringLiteralValue` in src/extraction/ts-extract-calls.ts.
 *
 * Two code paths:
 *   1. Grammar path — a string node exposes its unquoted payload as a
 *      `string_fragment` (TS/JS) child; that child's text is returned.
 *   2. Fallback path — when no fragment child exists (e.g. an empty string,
 *      or a non-string node passed in by a caller), the function strips
 *      matching surrounding quotes, returns null for sub-2-char slices, and
 *      otherwise returns the raw slice.
 *
 * Real `web-tree-sitter` nodes are used so the fragment-detection matches the
 * exact grammar production names production code relies on.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { readStringLiteralValue } from '../src/extraction/ts-extract-calls.js';
import { initGrammars, loadAllGrammars, getParser } from '../src/extraction/grammars.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function parseTs(source: string): SyntaxNode {
  const parser = getParser('typescript');
  if (!parser) throw new Error('TypeScript grammar not loaded');
  const tree = parser.parse(source);
  if (!tree) throw new Error('parse returned null');
  return tree.rootNode;
}

function findFirst(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const found = findFirst(child, type);
    if (found) return found;
  }
  return null;
}

function readFirstOfType(source: string, type: string): string | null {
  const node = findFirst(parseTs(source), type);
  if (!node) throw new Error(`no ${type} node found in: ${source}`);
  return readStringLiteralValue(node, source);
}

describe('readStringLiteralValue', () => {
  it('returns the unquoted payload of a double-quoted string', () => {
    expect(readFirstOfType('const x = "hello";', 'string')).toBe('hello');
  });

  it('returns the unquoted payload of a single-quoted string', () => {
    expect(readFirstOfType("const x = 'world';", 'string')).toBe('world');
  });

  it('returns the payload of a no-substitution template literal', () => {
    expect(readFirstOfType('const x = `tpl`;', 'template_string')).toBe('tpl');
  });

  it('quote-strips empty string/template literals via the fallback (all quote kinds)', () => {
    // An empty literal has no string_fragment child, so it takes the fallback
    // path and strips the surrounding quotes down to ''. Covering all three
    // quote kinds exercises each branch of the fallback quote check.
    expect(readFirstOfType('const x = "";', 'string')).toBe(''); // double
    expect(readFirstOfType("const x = '';", 'string')).toBe(''); // single
    expect(readFirstOfType('const x = ``;', 'template_string')).toBe(''); // backtick
  });

  it('returns the raw text for a non-string node with no quotes', () => {
    // Passing an identifier exercises the final `return raw` branch.
    expect(readFirstOfType('const foo = 1;', 'identifier')).toBe('foo');
  });

  it('returns null for a slice shorter than two characters', () => {
    // A single-char identifier has raw.length < 2 → null guard.
    expect(readFirstOfType('x;', 'identifier')).toBeNull();
  });
});
