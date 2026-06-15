/**
 * Coverage-focused tests for the graph traversal engine
 * (`src/graph/traversal.ts` — the `GraphTraverser` class and its
 * module-scope BFS/DFS/impact/path helpers).
 *
 * Strategy: index one deterministic multi-file TypeScript fixture into a
 * real temp-dir `Cartograph` (so `calls` / `extends` / `implements` /
 * `contains` edges are produced by the real extractor + resolver), then
 * exercise every public traverser method against KNOWN topology and assert
 * exact node-name sets, directions, depth cutoffs, cycle termination,
 * ordered shortest paths, and empty/edge inputs.
 *
 * Fixture topology (only the edges the traverser walks are listed):
 *   chain.ts   a() -> b() -> c() -> d()         (linear calls chain)
 *   cycle.ts   ping() <-> pong()                (calls cycle)
 *   types.ts   interface Animal
 *              interface Mammal extends Animal
 *              class Dog implements Mammal { bark(); fetch() -> wagTail(); wagTail() }
 *   lonely.ts  isolated()                       (no in/out call edges)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import type { GraphTraverser } from '../src/graph/traversal.js';
import type { Node, NodeKind } from '../src/types.js';

let tempDir: string;
let cg: Cartograph;
let traverser: GraphTraverser;

/** Look up a single node by name + kind; fails the test loudly if absent so
 *  we never silently `return` past a missing fixture symbol. */
function nodeId(name: string, kind: NodeKind): string {
  const matches = getNodesByKind(cg.queries, kind).filter((n) => n.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly 1 ${kind} named "${name}", found ${matches.length}`);
  }
  return matches[0]!.id;
}

/** Names of the nodes in a subgraph's node map. */
function names(map: Map<string, Node>): string[] {
  return [...map.values()].map((n) => n.name).sort();
}

/** Names produced by a callers/callees walk result. */
function walkNames(result: Array<{ node: Node; edge: { kind: string } }>): string[] {
  return result.map((r) => r.node.name).sort();
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-graph-traversal-'));
  const srcDir = path.join(tempDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(
    path.join(srcDir, 'chain.ts'),
    [
      'export function a(): number { return b(); }',
      'export function b(): number { return c(); }',
      'export function c(): number { return d(); }',
      'export function d(): number { return 1; }',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(srcDir, 'cycle.ts'),
    [
      'export function ping(n: number): number { return n > 0 ? pong(n - 1) : 0; }',
      'export function pong(n: number): number { return n > 0 ? ping(n - 1) : 0; }',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(srcDir, 'types.ts'),
    [
      'export interface Animal { name: string; }',
      'export interface Mammal extends Animal { legs: number; }',
      'export class Dog implements Mammal {',
      '  name = "rex";',
      '  legs = 4;',
      '  bark(): string { return "woof"; }',
      '  fetch(): void { this.wagTail(); }',
      '  wagTail(): void {}',
      '}',
    ].join('\n'),
  );

  fs.writeFileSync(path.join(srcDir, 'lonely.ts'), 'export function isolated(): number { return 99; }\n');

  cg = await Cartograph.init(tempDir, { index: true });
  traverser = cg.internals.traverser;
});

afterAll(() => {
  if (cg) cg.close();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('GraphTraverser.getCallees / getCallers — direction', () => {
  it('callees walk follows OUTGOING calls (what a node calls)', () => {
    // depth 1: a calls only b.
    const oneHop = traverser.getCallees(nodeId('a', 'function'), 1);
    expect(walkNames(oneHop)).toEqual(['b']);
    expect(oneHop.every((r) => r.edge.kind === 'calls')).toBe(true);
  });

  it('callers walk follows INCOMING calls (who calls a node)', () => {
    // c is called only by b at depth 1.
    const oneHop = traverser.getCallers(nodeId('c', 'function'), 1);
    expect(walkNames(oneHop)).toEqual(['b']);
    expect(oneHop.every((r) => r.edge.kind === 'calls')).toBe(true);
  });

  it('callees and callers are mirror images across the same edge', () => {
    const bId = nodeId('b', 'function');
    const cId = nodeId('c', 'function');
    // b calls c (callees) <=> c is called by b (callers).
    expect(traverser.getCallees(bId, 1).map((r) => r.node.id)).toContain(cId);
    expect(traverser.getCallers(cId, 1).map((r) => r.node.id)).toContain(bId);
  });

  it('a leaf node has no callees; a root has no callers', () => {
    // d() calls nothing; a() is called by nothing.
    expect(traverser.getCallees(nodeId('d', 'function'), 3)).toEqual([]);
    expect(traverser.getCallers(nodeId('a', 'function'), 3)).toEqual([]);
  });
});

describe('GraphTraverser.getCallees / getCallers — multi-hop depth limits', () => {
  it('depth grows the callee frontier hop by hop along a -> b -> c -> d', () => {
    const aId = nodeId('a', 'function');
    expect(walkNames(traverser.getCallees(aId, 1))).toEqual(['b']);
    expect(walkNames(traverser.getCallees(aId, 2))).toEqual(['b', 'c']);
    expect(walkNames(traverser.getCallees(aId, 3))).toEqual(['b', 'c', 'd']);
    // depth 10 saturates at the same reachable set (no further nodes exist).
    expect(walkNames(traverser.getCallees(aId, 10))).toEqual(['b', 'c', 'd']);
  });

  it('depth grows the caller frontier hop by hop along d <- c <- b <- a', () => {
    const dId = nodeId('d', 'function');
    expect(walkNames(traverser.getCallers(dId, 1))).toEqual(['c']);
    expect(walkNames(traverser.getCallers(dId, 2))).toEqual(['b', 'c']);
    expect(walkNames(traverser.getCallers(dId, 3))).toEqual(['a', 'b', 'c']);
  });

  it('maxDepth 0 yields nothing (currentDepth >= maxDepth before first expand)', () => {
    expect(traverser.getCallees(nodeId('a', 'function'), 0)).toEqual([]);
    expect(traverser.getCallers(nodeId('d', 'function'), 0)).toEqual([]);
  });

  it('an explicit edgeKind reaches structural edges instead of the call set', () => {
    // Dog `contains` its methods — not a calls/references/imports edge, so it
    // is only reachable when edgeKind is overridden (issue #7 path).
    const dogId = nodeId('Dog', 'class');
    const contained = traverser.getCallees(dogId, 1, ['contains']);
    expect(contained.every((r) => r.edge.kind === 'contains')).toBe(true);
    expect(walkNames(contained)).toEqual(expect.arrayContaining(['bark', 'fetch', 'wagTail']));
    // Default callees walk must NOT surface contains children.
    expect(traverser.getCallees(dogId).some((r) => r.edge.kind === 'contains')).toBe(false);
  });
});

describe('GraphTraverser — cycle handling', () => {
  it('callees on a calls-cycle terminates and visits each peer once', () => {
    const pingId = nodeId('ping', 'function');
    // ping -> pong -> ping; the `visited` guard must stop the recursion.
    const callees = traverser.getCallees(pingId, 10);
    expect(walkNames(callees)).toContain('pong');
    // pong is recorded exactly once despite the cycle.
    expect(callees.filter((r) => r.node.name === 'pong').length).toBe(1);
    // ping itself is the start (visited first) so it is never re-added.
    expect(callees.some((r) => r.node.id === pingId)).toBe(false);
  });

  it('BFS over a cycle terminates and includes both cycle members', () => {
    const pingId = nodeId('ping', 'function');
    const sub = traverser.traverseBFS(pingId, { maxDepth: 10, direction: 'both' });
    expect(sub.nodes.has(pingId)).toBe(true);
    expect(sub.nodes.has(nodeId('pong', 'function'))).toBe(true);
  });
});

describe('GraphTraverser.traverseBFS / traverseDFS', () => {
  it('BFS includes the start node by default and roots it', () => {
    const aId = nodeId('a', 'function');
    const sub = traverser.traverseBFS(aId, { maxDepth: 5, direction: 'outgoing' });
    expect(sub.nodes.has(aId)).toBe(true);
    expect(sub.roots).toEqual([aId]);
    expect(names(sub.nodes)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('includeStart:false drops the start node from the result set', () => {
    const aId = nodeId('a', 'function');
    const sub = traverser.traverseBFS(aId, { maxDepth: 5, direction: 'outgoing', includeStart: false });
    expect(sub.nodes.has(aId)).toBe(false);
    expect(names(sub.nodes)).toEqual(['b', 'c', 'd']);
  });

  it('BFS respects maxDepth (depth 1 reaches only immediate neighbours)', () => {
    const aId = nodeId('a', 'function');
    const shallow = traverser.traverseBFS(aId, { maxDepth: 1, direction: 'outgoing' });
    expect(names(shallow.nodes)).toEqual(['a', 'b']);
  });

  it('BFS respects the node-count limit', () => {
    const aId = nodeId('a', 'function');
    const capped = traverser.traverseBFS(aId, { maxDepth: 10, direction: 'outgoing', limit: 2 });
    expect(capped.nodes.size).toBeLessThanOrEqual(2);
  });

  it('BFS nodeKinds filter excludes off-kind neighbours', () => {
    // From the Dog class, restrict BFS to methods only over `contains` edges.
    const dogId = nodeId('Dog', 'class');
    const sub = traverser.traverseBFS(dogId, {
      maxDepth: 2,
      direction: 'outgoing',
      edgeKinds: ['contains'],
      nodeKinds: ['method'],
      includeStart: false,
    });
    expect(sub.nodes.size).toBeGreaterThan(0);
    expect([...sub.nodes.values()].every((n) => n.kind === 'method')).toBe(true);
  });

  it('DFS reaches the same outgoing closure as BFS along the chain', () => {
    const aId = nodeId('a', 'function');
    const dfs = traverser.traverseDFS(aId, { maxDepth: 5, direction: 'outgoing' });
    expect(names(dfs.nodes)).toEqual(['a', 'b', 'c', 'd']);
    expect(dfs.roots).toEqual([aId]);
  });

  it('DFS respects maxDepth', () => {
    const aId = nodeId('a', 'function');
    const dfs = traverser.traverseDFS(aId, { maxDepth: 1, direction: 'outgoing' });
    // depth 0 expands a -> b, then b is at depth 1 == maxDepth so it stops.
    expect(names(dfs.nodes)).toEqual(['a', 'b']);
  });

  it('BFS/DFS on a missing start id returns an empty rooted subgraph', () => {
    const bfs = traverser.traverseBFS('does-not-exist');
    expect(bfs.nodes.size).toBe(0);
    expect(bfs.edges).toEqual([]);
    expect(bfs.roots).toEqual([]);

    const dfs = traverser.traverseDFS('does-not-exist');
    expect(dfs.nodes.size).toBe(0);
    expect(dfs.roots).toEqual([]);
  });

  it('direction:both reaches callers AND callees from a mid-chain node', () => {
    const cId = nodeId('c', 'function');
    const sub = traverser.traverseBFS(cId, { maxDepth: 10, direction: 'both', edgeKinds: ['calls'] });
    // both directions over `calls` only: up to a and down to d (file
    // `contains` edges are excluded by the edgeKinds filter).
    expect(names(sub.nodes)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('GraphTraverser.getCallGraph', () => {
  it('merges callers and callees around a focal node', () => {
    const cId = nodeId('c', 'function');
    const cg2 = traverser.getCallGraph(cId, 2);
    expect(cg2.nodes.has(cId)).toBe(true);
    expect(cg2.roots).toEqual([cId]);
    // callers up to depth 2: a, b ; callees down: d ; plus focal c.
    expect(names(cg2.nodes)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns an empty subgraph for a missing focal node', () => {
    const empty = traverser.getCallGraph('nope');
    expect(empty.nodes.size).toBe(0);
    expect(empty.edges).toEqual([]);
    expect(empty.roots).toEqual([]);
  });
});

describe('GraphTraverser.getTypeHierarchy', () => {
  it('walks ancestors (extends/implements) and descendants from a class', () => {
    const dogId = nodeId('Dog', 'class');
    const h = traverser.getTypeHierarchy(dogId);
    expect(h.nodes.has(dogId)).toBe(true);
    expect(h.roots).toEqual([dogId]);
    // Dog implements Mammal; Mammal extends Animal -> both ancestors present.
    expect(names(h.nodes)).toEqual(expect.arrayContaining(['Animal', 'Dog', 'Mammal']));
  });

  it('Mammal hierarchy includes its ancestor Animal', () => {
    // Mammal extends Animal; starting at Mammal the ancestors walk runs first
    // and reaches Animal before the descendants walk is short-circuited.
    const mammalId = nodeId('Mammal', 'interface');
    const h = traverser.getTypeHierarchy(mammalId);
    expect(names(h.nodes)).toEqual(expect.arrayContaining(['Animal', 'Mammal']));
  });

  it('getTypeHierarchy includes descendants as well as ancestors', () => {
    // Animal has an incoming `extends` edge from Mammal (a descendant), and
    // Dog `implements` Mammal, so the hierarchy contains Animal + Mammal + Dog.
    // Regression guard: a single shared `visited` set used to let the ancestors
    // pass mark Animal visited, so the descendants pass bailed at its first
    // `visited.has(nodeId)` guard and returned only ['Animal']. The two passes
    // now use separate `visited` sets.
    const animalId = nodeId('Animal', 'interface');
    const h = traverser.getTypeHierarchy(animalId);
    expect(names(h.nodes)).toEqual(expect.arrayContaining(['Animal', 'Mammal', 'Dog']));
  });

  it('returns an empty subgraph for a missing node', () => {
    const h = traverser.getTypeHierarchy('missing');
    expect(h.nodes.size).toBe(0);
    expect(h.edges.length).toBe(0);
    expect(h.roots).toEqual([]);
  });
});

describe('GraphTraverser.findUsages', () => {
  it('returns the incoming-edge sources of a symbol', () => {
    // c is used (called) by b.
    const usages = traverser.findUsages(nodeId('c', 'function'));
    expect(usages.map((u) => u.node.name)).toContain('b');
    expect(usages.every((u) => typeof u.edge.kind === 'string')).toBe(true);
  });

  it('reports only the structural file-contains usage when nothing calls the node', () => {
    // isolated() is CALLED by nothing, but every symbol has an incoming
    // `contains` edge from its file node — findUsages walks ALL incoming edges.
    const usages = traverser.findUsages(nodeId('isolated', 'function'));
    expect(usages.map((u) => u.edge.kind)).toEqual(['contains']);
    expect(usages[0]!.node.name).toBe('lonely.ts');
  });
});

describe('GraphTraverser.getImpactRadius', () => {
  it('collects upstream dependents of a leaf along the chain', () => {
    // d is depended on (called) by c <- b <- a.
    const impact = traverser.getImpactRadius(nodeId('d', 'function'), 5);
    expect(impact.roots).toEqual([nodeId('d', 'function')]);
    expect(names(impact.nodes)).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
  });

  it('descends container children so callers of contained methods appear', () => {
    // wagTail is called by Dog.fetch. Impact of the Dog class should include
    // its contained methods (container-children expansion).
    const dogId = nodeId('Dog', 'class');
    const impact = traverser.getImpactRadius(dogId, 3);
    expect(impact.nodes.has(dogId)).toBe(true);
    expect(names(impact.nodes)).toEqual(expect.arrayContaining(['bark', 'fetch', 'wagTail']));
  });

  it('a method impact does NOT fan out to sibling methods via the parent contains edge', () => {
    // bark and wagTail are siblings under Dog. Impact of bark must not pull in
    // wagTail through Dog's outgoing contains edges (reachedViaIncomingContains
    // guard).
    const barkId = nodeId('bark', 'method');
    const wagTailId = nodeId('wagTail', 'method');
    const impact = traverser.getImpactRadius(barkId, 5);
    expect(impact.nodes.has(barkId)).toBe(true);
    expect(impact.nodes.has(wagTailId)).toBe(false);
  });

  it('respects maxDepth (depth 1 reaches only direct dependents)', () => {
    const dId = nodeId('d', 'function');
    const shallow = traverser.getImpactRadius(dId, 1);
    // depth 1 direct dependents of d: c (caller) and chain.ts (the file that
    // `contains` d), plus the focal d. b/a (2+ hops) must not appear.
    expect(names(shallow.nodes)).toEqual(['c', 'chain.ts', 'd']);
    expect(shallow.nodes.has(nodeId('b', 'function'))).toBe(false);
  });

  it('an edgeKind filter restricts the dependent walk', () => {
    // Restrict to `calls` only — still finds the call-chain dependents.
    const dId = nodeId('d', 'function');
    const impact = traverser.getImpactRadius(dId, 5, ['calls']);
    expect(names(impact.nodes)).toEqual(expect.arrayContaining(['c', 'd']));
  });

  it('returns an empty subgraph for a missing node', () => {
    const impact = traverser.getImpactRadius('missing');
    expect(impact.nodes.size).toBe(0);
    expect(impact.edges).toEqual([]);
    expect(impact.roots).toEqual([]);
  });
});

describe('GraphTraverser.findPath', () => {
  it('finds the ordered shortest path across a multi-hop calls chain', () => {
    const aId = nodeId('a', 'function');
    const dId = nodeId('d', 'function');
    const p = traverser.findPath(aId, dId);
    expect(p).not.toBeNull();
    // a -> b -> c -> d, in order. First entry's edge is null (start).
    expect(p!.map((step) => step.node.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(p![0]!.edge).toBeNull();
    expect(p!.slice(1).every((step) => step.edge!.kind === 'calls')).toBe(true);
  });

  it('a one-node path to self is the trivial single-element path', () => {
    const aId = nodeId('a', 'function');
    const p = traverser.findPath(aId, aId);
    expect(p).not.toBeNull();
    expect(p!.map((s) => s.node.name)).toEqual(['a']);
    expect(p![0]!.edge).toBeNull();
  });

  it('returns null between real-but-unconnected symbols (no path)', () => {
    // a reaches d downstream but never the disconnected isolated().
    const p = traverser.findPath(nodeId('a', 'function'), nodeId('isolated', 'function'));
    expect(p).toBeNull();
  });

  it('returns null when there is no outgoing path against edge direction', () => {
    // d has no outgoing calls, so it cannot reach a (which is upstream).
    const p = traverser.findPath(nodeId('d', 'function'), nodeId('a', 'function'));
    expect(p).toBeNull();
  });

  it('an edgeKind filter can turn a found path into no-path', () => {
    // a -> d exists over calls; restricting to imports (none exist) yields null.
    const p = traverser.findPath(nodeId('a', 'function'), nodeId('d', 'function'), ['imports']);
    expect(p).toBeNull();
  });

  it('returns null when either endpoint is missing', () => {
    expect(traverser.findPath('missing', nodeId('a', 'function'))).toBeNull();
    expect(traverser.findPath(nodeId('a', 'function'), 'missing')).toBeNull();
    expect(traverser.findPath('missing-1', 'missing-2')).toBeNull();
  });
});

describe('GraphTraverser.getAncestors / getChildren', () => {
  it('getChildren returns immediate contains children of a class', () => {
    const dogId = nodeId('Dog', 'class');
    const children = traverser.getChildren(dogId);
    const childNames = children.map((c) => c.name).sort();
    expect(childNames).toEqual(expect.arrayContaining(['bark', 'fetch', 'wagTail']));
  });

  it('getChildren returns [] for a leaf with no contains children', () => {
    expect(traverser.getChildren(nodeId('isolated', 'function'))).toEqual([]);
  });

  it('getAncestors walks containment upward from a method to its class/file', () => {
    const barkId = nodeId('bark', 'method');
    const ancestors = traverser.getAncestors(barkId);
    const ancestorNames = ancestors.map((a) => a.name);
    // bark is contained by Dog (and Dog by the file).
    expect(ancestorNames).toContain('Dog');
  });

  it('getAncestors returns [] for a top-level node with no container', () => {
    // A file node has no incoming contains edge.
    const fileNode = getNodesByKind(cg.queries, 'file').find((n) => n.filePath.endsWith('lonely.ts'));
    expect(fileNode).toBeDefined();
    expect(traverser.getAncestors(fileNode!.id)).toEqual([]);
  });
});
