/**
 * Tests for `subtreeContainsType` in src/extraction/tree-sitter-helpers.ts.
 *
 * Exercises every branch of the recursive descent:
 *   - root node type matches               → true  (base case)
 *   - descendant type matches              → true  (recursive case)
 *   - no node in the subtree matches       → false (exhaustion)
 *   - empty leaf (no named children)       → false (loop body never entered)
 *
 * Uses the native tree-sitter TypeScript grammar — the same one
 * production code uses — to produce real SyntaxNode trees.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { subtreeContainsType } from '../src/extraction/tree-sitter-helpers.js';
import { initGrammars, loadAllGrammars, getParser } from '../src/extraction/grammars.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function parseTs(source: string) {
  const parser = getParser('typescript');
  if (!parser) throw new Error('TypeScript grammar not loaded');
  return parser.parse(source);
}

describe('subtreeContainsType', () => {
  it('returns true when the root node itself matches the target type', () => {
    const tree = parseTs('1 + 2;');
    // The root is always "program" in tree-sitter TypeScript.
    expect(subtreeContainsType(tree.rootNode, 'program')).toBe(true);
  });

  it('returns true when a direct child matches the target type', () => {
    const tree = parseTs('const x = 1;');
    // "lexical_declaration" is a direct named child of "program".
    expect(subtreeContainsType(tree.rootNode, 'lexical_declaration')).toBe(true);
  });

  it('returns true when a deeply-nested descendant matches', () => {
    const tree = parseTs('function foo() { return 42; }');
    // "number" literal is several levels deep: program → function_declaration
    // → statement_block → return_statement → number.
    expect(subtreeContainsType(tree.rootNode, 'number')).toBe(true);
  });

  it('returns false when the target type does not appear anywhere in the subtree', () => {
    const tree = parseTs('const x = 1;');
    // "class_declaration" is not present in this tiny snippet.
    expect(subtreeContainsType(tree.rootNode, 'class_declaration')).toBe(false);
  });

  it('returns false for a leaf node when the leaf type does not match', () => {
    const tree = parseTs('x;');
    // Find the identifier leaf (0 named children).
    const stmt = tree.rootNode.namedChild(0); // expression_statement
    expect(stmt).not.toBeNull();
    const ident = stmt!.namedChild(0); // identifier leaf
    expect(ident).not.toBeNull();
    expect(ident!.namedChildCount).toBe(0); // truly a leaf

    // Searching for anything other than "identifier" on a leaf returns false.
    expect(subtreeContainsType(ident!, 'number')).toBe(false);
  });

  it('returns true when target type matches the leaf node itself', () => {
    const tree = parseTs('x;');
    const stmt = tree.rootNode.namedChild(0);
    const ident = stmt!.namedChild(0); // type === "identifier"
    expect(ident).not.toBeNull();
    expect(subtreeContainsType(ident!, 'identifier')).toBe(true);
  });

  it('correctly traverses an interface declaration subtree', () => {
    const tree = parseTs('interface Foo { bar: string; }');
    // "property_signature" lives inside the interface body.
    expect(subtreeContainsType(tree.rootNode, 'property_signature')).toBe(true);
    // "number" is absent from this declaration.
    expect(subtreeContainsType(tree.rootNode, 'number')).toBe(false);
  });
});
