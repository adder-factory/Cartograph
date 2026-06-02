/**
 * Tests for Lua colon-method promotion.
 *
 * `function M:foo()` is Lua's method-definition sugar (`foo` gets an
 * implicit `self`). The extractor promotes it to a `method` node; the
 * other three `function_declaration` forms stay `function`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import type { Node } from '../src/types.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const byKind = (nodes: Node[], kind: string): Node[] => nodes.filter((n) => n.kind === kind);
const byString = (a: string, b: string): number => a.localeCompare(b);

describe('Lua extraction — colon-method promotion', () => {
  it('promotes function M:foo() colon syntax to a method node', () => {
    const code = `
local M = {}

function M.create(name)
  return name
end

function M:speak()
  return self.name
end

local function helper()
  return 1
end

function plain()
  return 2
end
`;
    const result = extractFromSource('thing.lua', code);

    // Colon syntax → method.
    expect(byKind(result.nodes, 'method').map((n) => n.name)).toEqual(['M:speak']);
    // The signature is preserved on the method node.
    expect(byKind(result.nodes, 'method')[0]?.signature).toBe('function M:speak()');

    // The other three forms (dotted, local, plain) stay `function`.
    expect(
      byKind(result.nodes, 'function')
        .map((n) => n.name)
        .sort(byString),
    ).toEqual(['helper', 'M.create', 'plain']);
  });

  it('walks the colon-method body so calls inside it are attributed to the method', () => {
    const code = `
local M = {}

function M:render()
  return tostring(self.value)
end
`;
    const result = extractFromSource('render.lua', code);
    const method = byKind(result.nodes, 'method').find((n) => n.name === 'M:render');
    expect(method).toBeDefined();

    // The body's `tostring(...)` call is attributed to the method node —
    // proves visitFunctionBody ran under the method's scope.
    const callRefs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'calls' && r.fromNodeId === method!.id,
    );
    expect(callRefs.length).toBeGreaterThanOrEqual(1);
  });
});
