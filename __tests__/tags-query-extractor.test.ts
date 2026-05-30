/**
 * TagsQueryExtractor — the query-driven generic extractor and its
 * first onboarded language, Elixir.
 *
 * `TagsQueryExtractor` (`src/extraction/tags-query-extractor.ts`) runs a
 * grammar's stock `queries/tags.scm` (vendored under
 * `src/extraction/tags/`) to produce baseline symbol coverage —
 * definitions + `calls` references — for a language with no hand-written
 * extractor. These tests pin:
 *   - the onboarding proof: a real Elixir file yields a usable symbol
 *     graph (modules, functions, nesting, call refs),
 *   - the two suppression rules that keep tags output honest
 *     (`@ignore` keyword calls, definition-site pseudo-calls),
 *   - registry wiring for the new `elixir` language,
 *   - the clean-error behaviour when no `.scm` is vendored.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadGrammarsForLanguages, detectLanguage } from '../src/extraction/grammars.js';
import { getLanguageDefByName, getLanguageDefByExtension } from '../src/extraction/languages/registry.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';
import { TagsQueryExtractor } from '../src/extraction/tags-query-extractor.js';
import type { Node, Edge } from '../src/types.js';

beforeAll(async () => {
  await loadGrammarsForLanguages(['elixir', 'python']);
});

/** Index nodes by `kind::name` for terse assertions. */
function byKindName(nodes: Node[]): Map<string, Node[]> {
  const m = new Map<string, Node[]>();
  for (const n of nodes) {
    const key = `${n.kind}::${n.name}`;
    let bucket = m.get(key);
    if (!bucket) {
      bucket = [];
      m.set(key, bucket);
    }
    bucket.push(n);
  }
  return m;
}

/** A `contains` edge exists from `parentId` to `childId`. */
function hasContains(edges: Edge[], parentId: string, childId: string): boolean {
  return edges.some((e) => e.kind === 'contains' && e.source === parentId && e.target === childId);
}

describe('TagsQueryExtractor — Elixir onboarding', () => {
  const source = `defmodule Calculator do
  @moduledoc "A tiny calculator."

  def add(a, b) do
    sum(a, b)
  end

  defp sum(a, b), do: a + b

  defmacro trace(expr), do: expr

  def countdown(0), do: :done
  def countdown(n), do: countdown(n - 1)

  defmodule Inner do
    def noop, do: :ok
  end
end
`;

  it('extracts module / function / macro definitions with mapped kinds', () => {
    const r = extractFromSource('lib/calculator.ex', source);
    expect(r.errors).toHaveLength(0);
    const idx = byKindName(r.nodes);

    expect(idx.get('module::Calculator')).toHaveLength(1);
    expect(idx.get('module::Inner')).toHaveLength(1);
    expect(idx.get('function::add')).toHaveLength(1);
    expect(idx.get('function::sum')).toHaveLength(1);
    expect(idx.get('function::noop')).toHaveLength(1);
    // `defmacro` maps onto `function` (nearest NodeKind).
    expect(idx.get('function::trace')).toHaveLength(1);
    // Two `def countdown` clauses → two distinct nodes (per-line id).
    expect(idx.get('function::countdown')).toHaveLength(2);

    // Every emitted node is tagged with the language + a file node.
    expect(r.nodes.every((n) => n.language === 'elixir')).toBe(true);
    expect(r.nodes.filter((n) => n.kind === 'file')).toHaveLength(1);
  });

  it('nests definitions with contains edges by range containment', () => {
    const r = extractFromSource('lib/calculator.ex', source);
    const fileNode = r.nodes.find((n) => n.kind === 'file')!;
    const calculator = r.nodes.find((n) => n.kind === 'module' && n.name === 'Calculator')!;
    const inner = r.nodes.find((n) => n.kind === 'module' && n.name === 'Inner')!;
    const add = r.nodes.find((n) => n.kind === 'function' && n.name === 'add')!;
    const noop = r.nodes.find((n) => n.kind === 'function' && n.name === 'noop')!;

    expect(hasContains(r.edges, fileNode.id, calculator.id)).toBe(true);
    expect(hasContains(r.edges, calculator.id, add.id)).toBe(true);
    expect(hasContains(r.edges, calculator.id, inner.id)).toBe(true);
    // Innermost enclosing def wins — noop's parent is Inner, not Calculator.
    expect(hasContains(r.edges, inner.id, noop.id)).toBe(true);
    expect(hasContains(r.edges, calculator.id, noop.id)).toBe(false);
  });

  it('builds dotted qualifiedNames through enclosing definitions', () => {
    const r = extractFromSource('lib/calculator.ex', source);
    const add = r.nodes.find((n) => n.kind === 'function' && n.name === 'add')!;
    const noop = r.nodes.find((n) => n.kind === 'function' && n.name === 'noop')!;
    expect(add.qualifiedName).toBe('Calculator.add');
    expect(noop.qualifiedName).toBe('Calculator.Inner.noop');
  });

  it('emits calls references for real call sites only', () => {
    const r = extractFromSource('lib/calculator.ex', source);
    const calls = r.unresolvedReferences.filter((u) => u.referenceKind === 'calls');
    const names = calls.map((u) => u.referenceName);

    // `add` calls `sum` — a genuine call inside the body.
    const add = r.nodes.find((n) => n.kind === 'function' && n.name === 'add')!;
    expect(calls.some((u) => u.referenceName === 'sum' && u.fromNodeId === add.id)).toBe(true);

    // Real recursion survives — `countdown(n)` calls `countdown`.
    expect(names).toContain('countdown');
  });

  it('suppresses @ignore keyword pseudo-calls', () => {
    const r = extractFromSource('lib/calculator.ex', source);
    const names = r.unresolvedReferences.map((u) => u.referenceName);
    // Without the @ignore rule every `def`/`defmodule`/`@moduledoc`
    // re-matches the generic call-reference pattern.
    for (const kw of ['def', 'defp', 'defmacro', 'defmodule', 'moduledoc']) {
      expect(names, `keyword "${kw}" leaked as a call reference`).not.toContain(kw);
    }
  });

  it('does not emit a self-call for a function-clause head', () => {
    // `def add(a, b)` — the clause head `add(a, b)` re-matches the
    // call-reference pattern; rule 2 drops it. `add` has no recursive
    // self-call, so there must be zero `calls -> add` refs.
    const r = extractFromSource('lib/calculator.ex', source);
    const toAdd = r.unresolvedReferences.filter((u) => u.referenceName === 'add');
    expect(toAdd).toHaveLength(0);
  });

  it('attributes a top-level call to the file node', () => {
    const script = `IO.puts("hello")\n`;
    const r = extractFromSource('script.exs', script);
    expect(r.errors).toHaveLength(0);
    const fileNode = r.nodes.find((n) => n.kind === 'file')!;
    const puts = r.unresolvedReferences.find((u) => u.referenceName === 'puts');
    expect(puts).toBeDefined();
    expect(puts!.fromNodeId).toBe(fileNode.id);
  });

  it('handles a comment-only file without errors', () => {
    const r = extractFromSource('lib/empty.ex', '# just a comment\n');
    expect(r.errors).toHaveLength(0);
    // Only the file node — no definitions.
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]!.kind).toBe('file');
  });
});

describe('Elixir registry wiring', () => {
  it('detectLanguage maps .ex and .exs to elixir', () => {
    expect(detectLanguage('lib/foo.ex')).toBe('elixir');
    expect(detectLanguage('script.exs')).toBe('elixir');
  });

  it('the elixir def is tags-backed — grammar wasm + customExtractor', () => {
    const def = getLanguageDefByName('elixir');
    expect(def).toBeDefined();
    expect(def!.grammar?.wasmFile).toBe('elixir.wasm');
    expect(typeof def!.customExtractor).toBe('function');
  });

  it('getLanguageDefByExtension resolves .ex / .exs', () => {
    expect(getLanguageDefByExtension('.ex')?.name).toBe('elixir');
    expect(getLanguageDefByExtension('.EXS')?.name).toBe('elixir');
  });
});

describe('TagsQueryExtractor — generic guards', () => {
  it('returns a clean error result for a language with no vendored .scm', () => {
    // Python has a loaded grammar but no `src/extraction/tags/python.scm`
    // — the extractor should fail soft, not throw.
    const r = new TagsQueryExtractor('m.py', 'def f():\n    pass\n', 'python').extract();
    expect(r.nodes).toHaveLength(0);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => /tags\.scm/i.test(e.message))).toBe(true);
  });
});
