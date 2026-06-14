/**
 * Tests for `findNodeInTree` in src/biomarkers/engine.ts.
 *
 * Given a pre-parsed tree and a 1-indexed (line, column), it returns the
 * enclosing function/method container at that point — `descendantForPosition`
 * returns the smallest node (often a keyword), so the function walks up to
 * the nearest named FUNCTION_CONTAINER ancestor. When no such ancestor
 * exists it falls back to the named node that starts exactly at the point.
 *
 * Uses real web-tree-sitter parses (same grammar as production).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Tree } from 'web-tree-sitter';
import { findNodeInTree } from '../src/biomarkers/engine.js';
import { initGrammars, loadAllGrammars, getParser } from '../src/extraction/grammars.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function parseTs(source: string): Tree {
  const parser = getParser('typescript');
  if (!parser) throw new Error('TypeScript grammar not loaded');
  const tree = parser.parse(source);
  if (!tree) throw new Error('parse returned null');
  return tree as unknown as Tree;
}

describe('findNodeInTree', () => {
  it('walks up from a keyword to the enclosing function declaration', () => {
    const tree = parseTs('function foo() { return 1; }');
    // line 1 col 0 points at the `function` keyword; expect the container.
    const node = findNodeInTree(tree, 1, 0);
    expect(node?.type).toBe('function_declaration');
  });

  it('resolves a class method to its method container', () => {
    const tree = parseTs('class C {\n  bar() { return 2; }\n}');
    // `bar` starts at line 2, column 2.
    const node = findNodeInTree(tree, 2, 2);
    expect(node?.type).toBe('method_definition');
  });

  it('falls back to the named node starting at the point when no function encloses it', () => {
    const tree = parseTs('const x = 1;');
    // `x` is at line 1, column 6 — no function ancestor.
    const node = findNodeInTree(tree, 1, 6);
    expect(node?.type).toBe('identifier');
  });
});
