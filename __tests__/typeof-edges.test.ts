/**
 * type_of edge extraction across languages.
 *
 * Covers the gap surfaced in docs/CARTOGRAPH-REAL-WORK-EVAL.md: type
 * annotations weren't producing impact-discoverable edges (or were
 * bucketed under the generic `references` kind). After bundles
 * 36–39 these emit `type_of` (params/fields/vars) and `returns`
 * (return-type annotations) and the impact analysis correctly
 * counts them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getIncomingEdges } from '../src/db/queries-edges.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import Cartograph from '../src/index.js';
import { searchNodes } from '../src/db/queries-search.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

interface RefShape {
  kind: string;
  name: string;
  from?: string;
}

function summarise(r: { unresolvedReferences?: any[]; nodes: any[] }, names: string[]): RefShape[] {
  const refs = r.unresolvedReferences ?? [];
  return refs
    .filter((x: any) => names.includes(x.referenceName))
    .map((x: any) => ({
      kind: x.referenceKind,
      name: x.referenceName,
      from: r.nodes.find((n: any) => n.id === x.fromNodeId)?.name,
    }));
}

describe('type_of edges — TypeScript', () => {
  it('emits type_of for parameter and field annotations, returns for return types', async () => {
    const r = extractFromSource(
      'fixture.ts',
      `
interface Foo {}
interface Bar {}
class Box {
  field: Foo;
  arr: Bar[];
  cache: Map<string, Foo>;
}
function process(a: Foo, b: Bar): Foo { return a; }
    `,
    );
    const refs = summarise(r, ['Foo', 'Bar']);

    // Class field annotations → type_of from each field. Since the
    // TS class-member kind split (`tsExtractMethod` divert) data
    // fields land as kind=field; arrow-function class fields stay
    // kind=method.
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Foo', from: 'field' });
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Bar', from: 'arr' });
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Foo', from: 'cache' });

    // Function: params → type_of, return → returns. Same source +
    // kind + target dedupes (intentional), so we expect exactly:
    //   process --type_of--> Foo
    //   process --type_of--> Bar
    //   process --returns--> Foo
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Foo', from: 'process' });
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Bar', from: 'process' });
    expect(refs).toContainEqual({ kind: 'returns', name: 'Foo', from: 'process' });

    // No 'references' edges should remain for these names — the
    // type-annotation path is now type_of/returns.
    expect(refs.filter((x) => x.kind === 'references')).toEqual([]);
  });

  it('captures local variable annotations (deduped under enclosing function)', async () => {
    const r = extractFromSource(
      'fixture.ts',
      `
interface NewType {}
function f(): void {
  let local: NewType;
  return;
}
    `,
    );
    const refs = summarise(r, ['NewType']);
    // process has no NewType in its signature, so the only type_of
    // edge to NewType comes from the local variable declaration.
    expect(refs).toEqual([{ kind: 'type_of', name: 'NewType', from: 'f' }]);
  });
});

describe('type_of edges — Go', () => {
  it('emits type_of for struct fields and function params, returns for return types', async () => {
    const r = extractFromSource(
      'fixture.go',
      `
package main
type Foo struct{}
type Bar struct{}
type Box struct {
  field Foo
  arr   []Bar
  pmap  map[string]Foo
}
func process(a Foo, b Bar) Foo {
  var local Bar = b
  _ = local
  return Foo{}
}
    `,
    );
    const refs = summarise(r, ['Foo', 'Bar']);
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Foo', from: 'Box' });
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Bar', from: 'Box' });
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Foo', from: 'process' });
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Bar', from: 'process' });
    expect(refs).toContainEqual({ kind: 'returns', name: 'Foo', from: 'process' });
  });

  it('embedded structs do not double-emit (extends only, no type_of)', async () => {
    const r = extractFromSource(
      'fixture.go',
      `
package main
type Head struct{}
type Queryable struct{}
type DB struct {
  *Head
  Queryable
}
    `,
    );
    const refs = (r.unresolvedReferences ?? []).filter((x: any) => ['Head', 'Queryable'].includes(x.referenceName));
    // Embedded fields produce `extends` (or `references`) — they should
    // NOT also produce a `type_of` edge to the same target.
    const typeOfRefs = refs.filter((x: any) => x.referenceKind === 'type_of');
    expect(typeOfRefs).toEqual([]);
  });
});

describe('type_of edges — Python', () => {
  it('emits type_of for class field, parameter, and return annotations', async () => {
    const r = extractFromSource(
      'fixture.py',
      `
class Foo: pass
class Bar: pass
class Box:
    field: Foo
    cache: dict
def process(a: Foo, b: Bar) -> Foo:
    local: Foo = a
    return local
    `,
    );
    const refs = summarise(r, ['Foo', 'Bar']);
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Foo', from: 'Box' });
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Foo', from: 'process' });
    expect(refs).toContainEqual({ kind: 'type_of', name: 'Bar', from: 'process' });
    expect(refs).toContainEqual({ kind: 'returns', name: 'Foo', from: 'process' });
  });

  it('skips Python builtins (dict, list, Optional, etc.)', async () => {
    const r = extractFromSource(
      'fixture.py',
      `
def f(a: dict, b: list, c: Optional) -> None: pass
    `,
    );
    const refs = (r.unresolvedReferences ?? []).filter(
      (x: any) => x.referenceKind === 'type_of' || x.referenceKind === 'returns',
    );
    // dict / list / Optional / None are all builtins — no edges.
    expect(refs).toEqual([]);
  });
});

describe('type_of edges — end-to-end impact analysis', () => {
  let dir: string;
  let cg: Cartograph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-typeof-impact-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Mirror the FreshnessInfo case from the eval doc: a type used as
    // return type, parameter type, and class field type. Pre-fix,
    // impact analysis missed several of these.
    fs.writeFileSync(path.join(dir, 'src', 'types.ts'), 'export interface Audit {}\n');
    fs.writeFileSync(
      path.join(dir, 'src', 'service.ts'),
      `
import type { Audit } from './types.js';

export function getAudit(): Audit { return {} as Audit; }

export function logAudit(audit: Audit): void { void audit; }

export class Service {
  cached: Audit | null = null;
  history: Audit[] = [];
}
    `,
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 's@e.com');
    git(dir, 'config', 'user.name', 's');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');

    cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  }, 60000);

  it('Audit has incoming edges from every consumer (return, param, field)', () => {
    const audit = searchNodes(cg.queries, 'Audit', { limit: 5 }).find(
      (r) => r.node.kind === 'interface' && r.node.name === 'Audit',
    );
    expect(audit).toBeDefined();
    if (!audit) return;

    const incoming = getIncomingEdges(cg.queries, audit.node.id);
    const byKind = new Map<string, string[]>();
    for (const e of incoming) {
      const src = cg.queries.getNodeById(e.source);
      if (!src) continue;
      const list = byKind.get(e.kind) ?? [];
      list.push(`${src.kind}:${src.name}`);
      byKind.set(e.kind, list);
    }

    // Return-type edge from getAudit → Audit
    expect(byKind.get('returns')).toContain('function:getAudit');
    // Parameter-type edge from logAudit → Audit
    expect(byKind.get('type_of')).toContain('function:logAudit');
    // Class-field edges (cached + history) → Audit. After the TS
    // class-member kind split, data fields are kind=field (not the
    // kind=method that the prior buggy classification produced).
    expect(byKind.get('type_of')).toEqual(expect.arrayContaining(['field:cached', 'field:history']));
  });
});
