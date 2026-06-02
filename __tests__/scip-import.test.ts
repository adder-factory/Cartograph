/**
 * SCIP import — protobuf reader, symbol-string parsing, index decode,
 * and the SCIP `Index` → cartograph graph mapping.
 *
 * The strongest case is the round-trip: a cartograph graph → SCIP bytes
 * (via the export path) → decoded → rebuilt as a graph. Edge kinds are
 * intentionally lossy on that round-trip — SCIP `Occurrence`s carry no
 * call-vs-reference distinction, so `calls` re-imports as `references`.
 */

import { describe, it, expect } from 'vitest';
import { ProtoWriter } from '../src/scip/proto-writer.js';
import {
  decodeMessage,
  decodePackedVarints,
  getString,
  getStrings,
  getVarint,
  getMessages,
  getPackedVarints,
} from '../src/scip/proto-reader.js';
import {
  buildSymbolString,
  parseScipSymbol,
  descriptorsToQualifiedName,
  DescriptorSuffix,
} from '../src/scip/scip-symbol.js';
import { encodeScipIndex, ScipSymbolKind, SYMBOL_ROLE_DEFINITION, type ScipIndex } from '../src/scip/scip-encode.js';
import { decodeScipIndex } from '../src/scip/scip-decode.js';
import { exportScipIndex, type ScipExportInput } from '../src/scip/export.js';
import { buildGraphFromScip } from '../src/scip/import.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

// ── ProtoWriter ⇄ proto-reader round-trip ─────────────────────────

describe('proto-reader', () => {
  it('round-trips varints, including values above 2^31', () => {
    const w = new ProtoWriter();
    w.uint32(1, 0);
    w.uint32(2, 300);
    w.uint32(3, 2 ** 33);
    const msg = decodeMessage(w.finish());
    expect(getVarint(msg, 1)).toBe(0);
    expect(getVarint(msg, 2)).toBe(300);
    expect(getVarint(msg, 3)).toBe(2 ** 33);
  });

  it('round-trips UTF-8 strings and bools', () => {
    const w = new ProtoWriter();
    w.string(1, 'héllo — wörld');
    w.bool(2, true);
    const msg = decodeMessage(w.finish());
    expect(getString(msg, 1)).toBe('héllo — wörld');
    expect(getVarint(msg, 2)).toBe(1);
  });

  it('round-trips packed repeated int32', () => {
    const w = new ProtoWriter();
    w.packedUint32(1, [0, 1, 127, 128, 16384]);
    expect(getPackedVarints(decodeMessage(w.finish()), 1)).toEqual([0, 1, 127, 128, 16384]);
  });

  it('collects repeated string and message fields', () => {
    const w = new ProtoWriter();
    w.string(1, 'a');
    w.string(1, 'b');
    w.message(2, (m) => m.uint32(1, 7));
    w.message(2, (m) => m.uint32(1, 8));
    const msg = decodeMessage(w.finish());
    expect(getStrings(msg, 1)).toEqual(['a', 'b']);
    expect(getMessages(msg, 2).map((m) => getVarint(m, 1))).toEqual([7, 8]);
  });

  it('skips unknown 64-bit and 32-bit fixed fields', () => {
    // Hand-crafted: field 1 wire-type 1 (I64, 8 bytes), then field 2
    // varint = 9. A forward-compatible decoder must skip field 1.
    const bytes = new Uint8Array([
      (1 << 3) | 1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // field 1, I64
      Math.trunc(2 * 2 ** 3),
      9, // field 2, varint 9
    ]);
    expect(getVarint(decodeMessage(bytes), 2)).toBe(9);
  });

  it('throws on a truncated varint', () => {
    expect(() => decodePackedVarints(new Uint8Array([0x80]))).toThrow(RangeError);
  });
});

// ── symbol-string parsing ─────────────────────────────────────────

describe('parseScipSymbol', () => {
  it('parses a full symbol into package triple + descriptors', () => {
    const parsed = parseScipSymbol('cartograph cartograph demo 1.0.0 `src/a.ts`/Foo#bar().');
    expect(parsed).not.toBeNull();
    expect(parsed!.scheme).toBe('cartograph');
    expect(parsed!.packageName).toBe('demo');
    expect(parsed!.packageVersion).toBe('1.0.0');
    expect(parsed!.descriptors).toEqual([
      { name: 'src/a.ts', suffix: DescriptorSuffix.Namespace },
      { name: 'Foo', suffix: DescriptorSuffix.Type },
      { name: 'bar', suffix: DescriptorSuffix.Method },
    ]);
  });

  it('parses a method disambiguator', () => {
    const parsed = parseScipSymbol('cartograph cartograph d 1 foo(abc).');
    expect(parsed!.descriptors[0]).toEqual({
      name: 'foo',
      suffix: DescriptorSuffix.Method,
      disambiguator: 'abc',
    });
  });

  it('unescapes backtick-wrapped names', () => {
    const parsed = parseScipSymbol('cartograph cartograph d 1 `cmd:context`.');
    expect(parsed!.descriptors[0]!.name).toBe('cmd:context');
  });

  it('decodes a doubled-space-escaped package field', () => {
    const parsed = parseScipSymbol('cartograph cartograph my  project 1.0.0 X#');
    expect(parsed!.packageName).toBe('my project');
  });

  it('returns null for a document-local symbol', () => {
    expect(parseScipSymbol('local 42')).toBeNull();
  });

  it('returns null for a malformed symbol', () => {
    expect(parseScipSymbol('not a symbol')).toBeNull();
  });

  it('round-trips buildSymbolString → parseScipSymbol', () => {
    const descriptors = [
      { name: 'src/x.ts', suffix: DescriptorSuffix.Namespace },
      { name: 'My Class', suffix: DescriptorSuffix.Type },
      { name: 'run', suffix: DescriptorSuffix.Method },
    ];
    const sym = buildSymbolString('cartograph', { manager: 'cartograph', name: 'pkg', version: '2.0.0' }, descriptors);
    const parsed = parseScipSymbol(sym);
    expect(parsed!.descriptors).toEqual(descriptors);
  });

  it('round-trips macro and bracket-led descriptor suffixes', () => {
    const descriptors = [
      { name: 'src/macro.ts', suffix: DescriptorSuffix.Namespace },
      { name: 'defineThing', suffix: DescriptorSuffix.Macro },
      { name: 'T', suffix: DescriptorSuffix.TypeParameter },
      { name: 'arg', suffix: DescriptorSuffix.Parameter },
    ];
    const sym = buildSymbolString('cartograph', { manager: 'cartograph', name: 'pkg', version: '2.0.0' }, descriptors);
    const parsed = parseScipSymbol(sym);
    expect(sym).toContain('defineThing![T](arg)');
    expect(parsed!.descriptors).toEqual(descriptors);
  });

  it('doubles inner backticks in escaped descriptor names', () => {
    const descriptors = [{ name: 'weird`name', suffix: DescriptorSuffix.Term }];
    const sym = buildSymbolString('cartograph', { manager: 'cartograph', name: 'pkg', version: '2.0.0' }, descriptors);
    expect(sym).toContain('`weird``name`.');
    expect(parseScipSymbol(sym)!.descriptors).toEqual(descriptors);
  });

  it('rejects malformed descriptor tails', () => {
    expect(parseScipSymbol('cartograph cartograph d 1 (param')).toBeNull();
    expect(parseScipSymbol('cartograph cartograph d 1 [T)')).toBeNull();
    expect(parseScipSymbol('cartograph cartograph d 1 foo(x)')).toBeNull();
    expect(parseScipSymbol('cartograph cartograph d 1 `unterminated.')).toBeNull();
    expect(parseScipSymbol('cartograph cartograph d 1 ?')).toBeNull();
  });

  it('descriptorsToQualifiedName drops leading namespaces', () => {
    expect(
      descriptorsToQualifiedName([
        { name: 'src/a.ts', suffix: DescriptorSuffix.Namespace },
        { name: 'Foo', suffix: DescriptorSuffix.Type },
        { name: 'bar', suffix: DescriptorSuffix.Method },
      ]),
    ).toBe('Foo::bar');
  });

  it('descriptorsToQualifiedName falls back to the leaf for an all-namespace symbol', () => {
    expect(descriptorsToQualifiedName([{ name: 'src/a.ts', suffix: DescriptorSuffix.Namespace }])).toBe('src/a.ts');
  });
});

// ── index decode ──────────────────────────────────────────────────

describe('decodeScipIndex', () => {
  it('round-trips encodeScipIndex → decodeScipIndex', () => {
    const index: ScipIndex = {
      toolName: 'cartograph',
      toolVersion: '9.9.9',
      projectRoot: 'file:///tmp/demo',
      documents: [
        {
          relativePath: 'src/a.ts',
          language: 'typescript',
          symbols: [
            {
              symbol: 'cartograph cartograph demo 1.0.0 `src/a.ts`/Foo#',
              displayName: 'Foo',
              kind: ScipSymbolKind.Class,
              documentation: ['The Foo class.'],
              relationships: [{ symbol: 'cartograph cartograph demo 1.0.0 `src/b.ts`/Base#', isImplementation: true }],
              enclosingSymbol: 'cartograph cartograph demo 1.0.0 `src/a.ts`/',
            },
          ],
          occurrences: [
            {
              range: [2, 6, 9],
              symbol: 'cartograph cartograph demo 1.0.0 `src/a.ts`/Foo#',
              symbolRoles: SYMBOL_ROLE_DEFINITION,
              enclosingRange: [2, 6, 19, 1],
            },
          ],
        },
      ],
    };
    const decoded = decodeScipIndex(encodeScipIndex(index));
    expect(decoded.toolName).toBe('cartograph');
    expect(decoded.toolVersion).toBe('9.9.9');
    expect(decoded.projectRoot).toBe('file:///tmp/demo');
    expect(decoded.documents).toHaveLength(1);
    const doc = decoded.documents[0]!;
    expect(doc.relativePath).toBe('src/a.ts');
    expect(doc.language).toBe('typescript');
    expect(doc.symbols[0]!.displayName).toBe('Foo');
    expect(doc.symbols[0]!.kind).toBe(ScipSymbolKind.Class);
    expect(doc.symbols[0]!.documentation).toEqual(['The Foo class.']);
    expect(doc.symbols[0]!.relationships[0]!.isImplementation).toBe(true);
    expect(doc.occurrences[0]!.range).toEqual([2, 6, 9]);
    expect(doc.occurrences[0]!.symbolRoles).toBe(SYMBOL_ROLE_DEFINITION);
    expect(doc.occurrences[0]!.enclosingRange).toEqual([2, 6, 19, 1]);
  });
});

// ── buildGraphFromScip ────────────────────────────────────────────

const FOO = 'cartograph cartograph demo 1.0.0 `src/a.ts`/Foo#';
const BAR = 'cartograph cartograph demo 1.0.0 `src/a.ts`/Foo#bar().';
const FILE_A = 'cartograph cartograph demo 1.0.0 `src/a.ts`/';
const BAZ = 'cartograph cartograph demo 1.0.0 `src/b.ts`/baz().';

function twoDocIndex(): ScipIndex {
  return {
    toolName: 'cartograph',
    toolVersion: '9.9.9',
    projectRoot: 'file:///tmp/demo',
    documents: [
      {
        relativePath: 'src/a.ts',
        language: 'typescript',
        symbols: [
          {
            symbol: FILE_A,
            displayName: 'a.ts',
            kind: ScipSymbolKind.File,
            documentation: [],
            relationships: [],
            enclosingSymbol: '',
          },
          {
            symbol: FOO,
            displayName: 'Foo',
            kind: ScipSymbolKind.Class,
            documentation: ['Foo does things.'],
            relationships: [],
            enclosingSymbol: FILE_A,
          },
          {
            symbol: BAR,
            displayName: 'bar',
            kind: ScipSymbolKind.Method,
            documentation: [],
            relationships: [],
            enclosingSymbol: FOO,
          },
        ],
        occurrences: [
          { range: [2, 6, 9], symbol: FOO, symbolRoles: SYMBOL_ROLE_DEFINITION, enclosingRange: [2, 0, 20, 1] },
          { range: [4, 2, 5], symbol: BAR, symbolRoles: SYMBOL_ROLE_DEFINITION, enclosingRange: [4, 2, 8, 3] },
          // a reference to baz inside bar's body (lines 4-8)
          { range: [5, 8, 11], symbol: BAZ, symbolRoles: 0 },
        ],
      },
      {
        relativePath: 'src/b.ts',
        language: 'typescript',
        symbols: [
          {
            symbol: BAZ,
            displayName: 'baz',
            kind: ScipSymbolKind.Function,
            documentation: [],
            relationships: [],
            enclosingSymbol: '',
          },
        ],
        occurrences: [
          { range: [0, 16, 19], symbol: BAZ, symbolRoles: SYMBOL_ROLE_DEFINITION, enclosingRange: [0, 0, 6, 1] },
        ],
      },
    ],
  };
}

describe('buildGraphFromScip', () => {
  it('produces one file group per document plus a synthesised file node', () => {
    const graph = buildGraphFromScip(twoDocIndex());
    expect([...graph.filesByPath.keys()].sort(byString)).toEqual(['src/a.ts', 'src/b.ts']);
    // src/a.ts: Foo + bar + the synthesised file node = 3.
    const aNodes = graph.filesByPath.get('src/a.ts')!.nodes;
    expect(aNodes).toHaveLength(3);
    expect(aNodes.filter((n) => n.kind === 'file')).toHaveLength(1);
  });

  it('folds a file-kind SCIP symbol into the synthesised file node (no duplicate)', () => {
    const graph = buildGraphFromScip(twoDocIndex());
    // src/a.ts has an explicit File symbol AND gets a synthesised node —
    // exactly one file node must result.
    const fileNodes = graph.filesByPath.get('src/a.ts')!.nodes.filter((n) => n.kind === 'file');
    expect(fileNodes).toHaveLength(1);
  });

  it('maps SCIP kinds and positions onto cartograph nodes', () => {
    const graph = buildGraphFromScip(twoDocIndex());
    const foo = graph.filesByPath.get('src/a.ts')!.nodes.find((n) => n.name === 'Foo')!;
    expect(foo.kind).toBe('class');
    expect(foo.qualifiedName).toBe('Foo');
    // enclosingRange [2,0,20,1] → 1-based lines 3..21.
    expect(foo.startLine).toBe(3);
    expect(foo.endLine).toBe(21);
    expect(foo.docstring).toBe('Foo does things.');
    const bar = graph.filesByPath.get('src/a.ts')!.nodes.find((n) => n.name === 'bar')!;
    expect(bar.kind).toBe('method');
    expect(bar.qualifiedName).toBe('Foo::bar');
  });

  it('derives contains edges from enclosing_symbol', () => {
    const graph = buildGraphFromScip(twoDocIndex());
    const idOf = (name: string): string =>
      [...graph.filesByPath.values()].flatMap((f) => f.nodes).find((n) => n.name === name)!.id;
    const contains = graph.edges.filter((e) => e.kind === 'contains');
    // file→Foo, Foo→bar, file(b)→baz.
    expect(contains).toContainEqual(
      expect.objectContaining({ source: idOf('a.ts'), target: idOf('Foo'), kind: 'contains' }),
    );
    expect(contains).toContainEqual(
      expect.objectContaining({ source: idOf('Foo'), target: idOf('bar'), kind: 'contains' }),
    );
  });

  it('attributes a reference occurrence to its enclosing definition', () => {
    const graph = buildGraphFromScip(twoDocIndex());
    const idOf = (name: string): string =>
      [...graph.filesByPath.values()].flatMap((f) => f.nodes).find((n) => n.name === name)!.id;
    // The ref to baz sits on line 5, inside bar's body (lines 4-8) → bar→baz.
    const ref = graph.edges.find((e) => e.kind === 'references' && e.target === idOf('baz'))!;
    expect(ref).toBeDefined();
    expect(ref.source).toBe(idOf('bar'));
    expect(ref.line).toBe(6); // SCIP line 5 → cartograph 1-based 6
    expect(ref.confidence).toBe('EXTRACTED');
  });

  it('skips documents with an unsafe (traversal) path', () => {
    const index = twoDocIndex();
    index.documents.push({
      relativePath: '../../etc/evil.ts',
      language: 'typescript',
      symbols: [],
      occurrences: [],
    });
    const graph = buildGraphFromScip(index);
    expect(graph.stats.skippedDocuments).toBe(1);
    expect(graph.filesByPath.has('../../etc/evil.ts')).toBe(false);
  });

  it('counts edges whose target symbol has no definition as unresolved', () => {
    const index = twoDocIndex();
    index.documents[0]!.occurrences.push({
      range: [6, 4, 7],
      symbol: 'cartograph cartograph demo 1.0.0 `external`/missing.',
      symbolRoles: 0,
    });
    const graph = buildGraphFromScip(index);
    expect(graph.stats.unresolvedEdges).toBe(1);
  });

  it('maps an is_implementation relationship to an extends edge', () => {
    const index = twoDocIndex();
    const BASE = 'cartograph cartograph demo 1.0.0 `src/b.ts`/Base#';
    index.documents[1]!.symbols.push({
      symbol: BASE,
      displayName: 'Base',
      kind: ScipSymbolKind.Class,
      documentation: [],
      relationships: [],
      enclosingSymbol: '',
    });
    index.documents[1]!.occurrences.push({
      range: [8, 6, 10],
      symbol: BASE,
      symbolRoles: SYMBOL_ROLE_DEFINITION,
      enclosingRange: [8, 0, 9, 1],
    });
    index.documents[0]!.symbols[1]!.relationships = [{ symbol: BASE, isImplementation: true }];
    const graph = buildGraphFromScip(index);
    const idOf = (name: string): string =>
      [...graph.filesByPath.values()].flatMap((f) => f.nodes).find((n) => n.name === name)!.id;
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: idOf('Foo'), target: idOf('Base'), kind: 'extends' }),
    );
  });
});

// ── export → import round-trip ────────────────────────────────────

function sampleExportInput(): ScipExportInput {
  return {
    projectName: 'demo',
    projectVersion: '1.0.0',
    toolVersion: '9.9.9',
    projectRootUri: 'file:///tmp/demo',
    files: [
      { path: 'src/a.ts', language: 'typescript' },
      { path: 'src/b.ts', language: 'typescript' },
    ],
    nodes: [
      {
        id: 'file:a',
        kind: 'file',
        name: 'a.ts',
        qualifiedName: 'src/a.ts',
        filePath: 'src/a.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 40,
        startColumn: 0,
        endColumn: 0,
      },
      {
        id: 'class:Foo',
        kind: 'class',
        name: 'Foo',
        qualifiedName: 'Foo',
        filePath: 'src/a.ts',
        language: 'typescript',
        startLine: 3,
        endLine: 20,
        startColumn: 6,
        endColumn: 1,
        docstring: 'The Foo class.',
      },
      {
        id: 'method:bar',
        kind: 'method',
        name: 'bar',
        qualifiedName: 'Foo::bar',
        filePath: 'src/a.ts',
        language: 'typescript',
        startLine: 5,
        endLine: 12,
        startColumn: 2,
        endColumn: 3,
      },
      {
        id: 'class:Base',
        kind: 'class',
        name: 'Base',
        qualifiedName: 'Base',
        filePath: 'src/b.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 10,
        startColumn: 6,
        endColumn: 1,
      },
      {
        id: 'fn:baz',
        kind: 'function',
        name: 'baz',
        qualifiedName: 'baz',
        filePath: 'src/b.ts',
        language: 'typescript',
        startLine: 12,
        endLine: 18,
        startColumn: 0,
        endColumn: 1,
      },
    ],
    edges: [
      { source: 'file:a', target: 'class:Foo', kind: 'contains' },
      { source: 'class:Foo', target: 'method:bar', kind: 'contains' },
      { source: 'class:Foo', target: 'class:Base', kind: 'extends', line: 3, column: 18 },
      { source: 'fn:baz', target: 'method:bar', kind: 'calls', line: 14, column: 4 },
    ],
  };
}

describe('export → import round-trip', () => {
  it('reconstructs the graph from cartograph-exported SCIP bytes', () => {
    const { bytes } = exportScipIndex(sampleExportInput());
    const graph = buildGraphFromScip(decodeScipIndex(bytes));

    // Both files survive; each keeps exactly one file node.
    expect([...graph.filesByPath.keys()].sort(byString)).toEqual(['src/a.ts', 'src/b.ts']);
    const allNodes = [...graph.filesByPath.values()].flatMap((f) => f.nodes);
    expect(allNodes.filter((n) => n.kind === 'file')).toHaveLength(2);

    // The four real symbols come back with their kinds.
    const byName = new Map(allNodes.map((n) => [n.name, n]));
    expect(byName.get('Foo')!.kind).toBe('class');
    expect(byName.get('bar')!.kind).toBe('method');
    expect(byName.get('baz')!.kind).toBe('function');
    expect(byName.get('Base')!.kind).toBe('class');
    expect(byName.get('Foo')!.docstring).toBe('The Foo class.');
  });

  it('preserves the extends relationship across the round-trip', () => {
    const { bytes } = exportScipIndex(sampleExportInput());
    const graph = buildGraphFromScip(decodeScipIndex(bytes));
    const id = (name: string): string =>
      [...graph.filesByPath.values()].flatMap((f) => f.nodes).find((n) => n.name === name)!.id;
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: id('Foo'), target: id('Base'), kind: 'extends' }),
    );
  });

  it('re-imports a calls edge as references (SCIP carries no edge kind)', () => {
    const { bytes } = exportScipIndex(sampleExportInput());
    const graph = buildGraphFromScip(decodeScipIndex(bytes));
    const id = (name: string): string =>
      [...graph.filesByPath.values()].flatMap((f) => f.nodes).find((n) => n.name === name)!.id;
    // Original edge was `calls` baz → bar; SCIP has no call/ref
    // distinction, so it round-trips as `references`.
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: id('baz'), target: id('bar'), kind: 'references' }),
    );
    expect(graph.edges.some((e) => e.kind === 'calls')).toBe(false);
  });
});
