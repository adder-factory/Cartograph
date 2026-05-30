import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import type { Edge } from '../src/types.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function defUseEdges(result: ReturnType<typeof extractFromSource>): Edge[] {
  return result.edges.filter((e) => e.kind === 'def_use');
}

describe('def_use edges — TypeScript extractor', () => {
  it('emits one edge for a used local variable', () => {
    const code = `function f() { let x = 1; console.log(x); }`;
    const result = extractFromSource('f.ts', code);
    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'f');
    expect(funcNode).toBeDefined();

    const edges = defUseEdges(result);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe(funcNode!.id);
    expect(edges[0]!.target).toBe(funcNode!.id);
    expect((edges[0]!.metadata as { name: string }).name).toBe('x');
  });

  it('emits no edge for an unused local variable', () => {
    const code = `function f() { let x = 1; }`;
    const result = extractFromSource('f.ts', code);
    expect(defUseEdges(result)).toHaveLength(0);
  });

  it('two sibling top-level functions each get their own def_use set', () => {
    // Both functions are named graph nodes. `a` uses its local; `b` does not.
    const code = `
      function a() { let y = 1; return y; }
      function b() { let y = 1; }
    `;
    const result = extractFromSource('f.ts', code);
    const aNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'a');
    const bNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'b');
    expect(aNode).toBeDefined();
    expect(bNode).toBeDefined();

    const edges = defUseEdges(result);
    const aEdges = edges.filter((e) => e.source === aNode!.id);
    const bEdges = edges.filter((e) => e.source === bNode!.id);

    expect(aEdges).toHaveLength(1);
    expect((aEdges[0]!.metadata as { name: string }).name).toBe('y');
    expect(bEdges).toHaveLength(0);
  });

  it('emits no def_use edge for a parameter', () => {
    const code = `function f(p: number) { return p; }`;
    const result = extractFromSource('f.ts', code);
    expect(defUseEdges(result)).toHaveLength(0);
  });

  it('emits no def_use edge for a field access', () => {
    const code = `class C { f() { return this.x; } }`;
    const result = extractFromSource('f.ts', code);
    expect(defUseEdges(result)).toHaveLength(0);
  });
});
