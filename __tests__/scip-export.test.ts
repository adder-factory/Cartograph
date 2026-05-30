/**
 * SCIP export — protobuf writer, symbol-string construction, and the
 * end-to-end graph → `Index` mapping.
 *
 * The encoder is verified against an independent, test-only protobuf
 * DECODER (below): if the hand-rolled `ProtoWriter` and the decoder
 * agree, and the decoder follows the documented wire format, the
 * encoded bytes are correct. This avoids pulling a protobuf runtime
 * dependency just to test one.
 */

import { describe, it, expect } from 'vitest';
import { ProtoWriter } from '../src/scip/proto-writer.js';
import { buildSymbolString, escapeDescriptorName, DescriptorSuffix } from '../src/scip/scip-symbol.js';
import { exportScipIndex, type ScipExportInput } from '../src/scip/export.js';

// ── minimal protobuf decoder (test-only) ──────────────────────────

type WireValue = number | Uint8Array;
type Fields = Map<number, WireValue[]>;

/** Read one base-128 varint; returns `[value, nextOffset]`. */
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 1;
  let p = pos;
  for (;;) {
    const b = buf[p++]!;
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
  }
  return [result, p];
}

/** Decode a protobuf message into a field-number → values map. */
function decodeMessage(buf: Uint8Array): Fields {
  const fields: Fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let tag: number;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    let value: WireValue;
    if (wire === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wire === 2) {
      let len: number;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else {
      throw new Error(`decodeMessage: unsupported wire type ${wire}`);
    }
    const arr = fields.get(field);
    if (arr) arr.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

/** Unpack a packed-varint field body into a number array. */
function decodePackedVarints(buf: Uint8Array): number[] {
  const out: number[] = [];
  let pos = 0;
  while (pos < buf.length) {
    let v: number;
    [v, pos] = readVarint(buf, pos);
    out.push(v);
  }
  return out;
}

const asString = (v: WireValue): string => Buffer.from(v as Uint8Array).toString('utf8');
const asMessage = (v: WireValue): Fields => decodeMessage(v as Uint8Array);
const first = (f: Fields, n: number): WireValue | undefined => f.get(n)?.[0];

// ── ProtoWriter ───────────────────────────────────────────────────

describe('ProtoWriter', () => {
  it('encodes varint fields, including values above 2^31', () => {
    const w = new ProtoWriter();
    w.uint32(1, 0);
    w.uint32(2, 300);
    w.uint32(3, 2 ** 33);
    const f = decodeMessage(w.finish());
    expect(first(f, 1)).toBe(0);
    expect(first(f, 2)).toBe(300);
    expect(first(f, 3)).toBe(2 ** 33);
  });

  it('round-trips UTF-8 strings', () => {
    const w = new ProtoWriter();
    w.string(1, 'héllo — wörld');
    expect(asString(first(decodeMessage(w.finish()), 1)!)).toBe('héllo — wörld');
  });

  it('encodes bool fields', () => {
    const w = new ProtoWriter();
    w.bool(1, true);
    expect(first(decodeMessage(w.finish()), 1)).toBe(1);
  });

  it('encodes packed repeated int32', () => {
    const w = new ProtoWriter();
    w.packedUint32(1, [1, 127, 128, 16384, 0]);
    const body = first(decodeMessage(w.finish()), 1)! as Uint8Array;
    expect(decodePackedVarints(body)).toEqual([1, 127, 128, 16384, 0]);
  });

  it('omits empty packed fields', () => {
    const w = new ProtoWriter();
    w.packedUint32(1, []);
    expect(w.finish().length).toBe(0);
  });

  it('encodes nested messages', () => {
    const w = new ProtoWriter();
    w.message(1, (m) => {
      m.uint32(1, 7);
      m.string(2, 'inner');
    });
    const inner = asMessage(first(decodeMessage(w.finish()), 1)!);
    expect(first(inner, 1)).toBe(7);
    expect(asString(first(inner, 2)!)).toBe('inner');
  });

  it('rejects negative varints', () => {
    expect(() => new ProtoWriter().uint32(1, -1)).toThrow(RangeError);
  });
});

// ── symbol strings ────────────────────────────────────────────────

describe('SCIP symbol strings', () => {
  it('leaves bare identifiers unescaped', () => {
    expect(escapeDescriptorName('getParser')).toBe('getParser');
    expect(escapeDescriptorName('a_b-c$1')).toBe('a_b-c$1');
  });

  it('backtick-escapes names with reserved characters', () => {
    expect(escapeDescriptorName('src/foo.ts')).toBe('`src/foo.ts`');
    expect(escapeDescriptorName('cmd:context')).toBe('`cmd:context`');
  });

  it('doubles inner backticks', () => {
    expect(escapeDescriptorName('a`b')).toBe('`a``b`');
  });

  it('builds a full symbol string from descriptors', () => {
    const sym = buildSymbolString('cartograph', { manager: 'cartograph', name: 'demo', version: '1.0.0' }, [
      { name: 'src/a.ts', suffix: DescriptorSuffix.Namespace },
      { name: 'Foo', suffix: DescriptorSuffix.Type },
      { name: 'bar', suffix: DescriptorSuffix.Method },
    ]);
    expect(sym).toBe('cartograph cartograph demo 1.0.0 `src/a.ts`/Foo#bar().');
  });

  it('escapes spaces in package parts with a double space', () => {
    const sym = buildSymbolString('cartograph', { manager: 'cartograph', name: 'my project', version: '1.0.0' }, [
      { name: 'X', suffix: DescriptorSuffix.Type },
    ]);
    expect(sym).toBe('cartograph cartograph my  project 1.0.0 X#');
  });
});

// ── end-to-end export ─────────────────────────────────────────────

/** A small but representative graph: a class with a method, a base
 *  class it extends, a free function that calls the method, plus an
 *  `import` node (which must be excluded from the export). */
function sampleInput(overrides: Partial<ScipExportInput> = {}): ScipExportInput {
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
        endLine: 8,
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
      {
        id: 'import:x',
        kind: 'import',
        name: 'lodash',
        qualifiedName: 'lodash',
        filePath: 'src/b.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
      },
    ],
    edges: [
      { source: 'file:a', target: 'class:Foo', kind: 'contains' },
      { source: 'class:Foo', target: 'method:bar', kind: 'contains' },
      { source: 'class:Foo', target: 'class:Base', kind: 'extends', line: 3, column: 18 },
      { source: 'fn:baz', target: 'method:bar', kind: 'calls', line: 14, column: 4 },
    ],
    ...overrides,
  };
}

const SYM_FOO = 'cartograph cartograph demo 1.0.0 `src/a.ts`/Foo#';
const SYM_BAR = 'cartograph cartograph demo 1.0.0 `src/a.ts`/Foo#bar().';
const SYM_BASE = 'cartograph cartograph demo 1.0.0 `src/b.ts`/Base#';
const SYM_FILE_A = 'cartograph cartograph demo 1.0.0 `src/a.ts`/';

/** Decode an encoded index into a convenient nested structure. */
function decodeIndex(bytes: Uint8Array): {
  toolName: string;
  toolVersion: string;
  projectRoot: string;
  documents: Array<{
    relativePath: string;
    language: string;
    symbols: Array<{
      symbol: string;
      displayName: string;
      kind: number;
      documentation: string[];
      enclosingSymbol: string;
      relationships: Array<{ symbol: string; isImplementation: boolean }>;
    }>;
    occurrences: Array<{ range: number[]; symbol: string; roles: number; enclosingRange: number[] }>;
  }>;
} {
  const idx = decodeMessage(bytes);
  const meta = asMessage(first(idx, 1)!);
  const tool = asMessage(first(meta, 2)!);
  const documents = (idx.get(2) ?? []).map((d) => {
    const doc = asMessage(d);
    return {
      relativePath: doc.get(1) ? asString(first(doc, 1)!) : '',
      language: doc.get(4) ? asString(first(doc, 4)!) : '',
      symbols: (doc.get(3) ?? []).map((s) => {
        const sym = asMessage(s);
        return {
          symbol: asString(first(sym, 1)!),
          documentation: (sym.get(3) ?? []).map(asString),
          relationships: (sym.get(4) ?? []).map((r) => {
            const rel = asMessage(r);
            return { symbol: asString(first(rel, 1)!), isImplementation: first(rel, 3) === 1 };
          }),
          kind: (first(sym, 5) as number) ?? 0,
          displayName: sym.get(6) ? asString(first(sym, 6)!) : '',
          enclosingSymbol: sym.get(8) ? asString(first(sym, 8)!) : '',
        };
      }),
      occurrences: (doc.get(2) ?? []).map((o) => {
        const occ = asMessage(o);
        return {
          range: decodePackedVarints(first(occ, 1)! as Uint8Array),
          symbol: asString(first(occ, 2)!),
          roles: (first(occ, 3) as number) ?? 0,
          enclosingRange: occ.get(7) ? decodePackedVarints(first(occ, 7)! as Uint8Array) : [],
        };
      }),
    };
  });
  return {
    toolName: meta.get(2) && tool.get(1) ? asString(first(tool, 1)!) : '',
    toolVersion: tool.get(2) ? asString(first(tool, 2)!) : '',
    projectRoot: meta.get(3) ? asString(first(meta, 3)!) : '',
    documents,
  };
}

describe('exportScipIndex', () => {
  it('produces a decodable index with one document per non-empty file', () => {
    const { bytes } = exportScipIndex(sampleInput());
    const idx = decodeIndex(bytes);
    expect(idx.toolName).toBe('cartograph');
    expect(idx.toolVersion).toBe('9.9.9');
    expect(idx.projectRoot).toBe('file:///tmp/demo');
    expect(idx.documents.map((d) => d.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('emits SymbolInformation with natural SCIP symbol strings', () => {
    const idx = decodeIndex(exportScipIndex(sampleInput()).bytes);
    const docA = idx.documents.find((d) => d.relativePath === 'src/a.ts')!;
    const symbols = docA.symbols.map((s) => s.symbol);
    expect(symbols).toContain(SYM_FILE_A);
    expect(symbols).toContain(SYM_FOO);
    expect(symbols).toContain(SYM_BAR);
  });

  it('excludes import / export nodes from the export', () => {
    const idx = decodeIndex(exportScipIndex(sampleInput()).bytes);
    const allSymbols = idx.documents.flatMap((d) => d.symbols.map((s) => s.symbol));
    expect(allSymbols.some((s) => s.includes('lodash'))).toBe(false);
  });

  it('marks definition occurrences with the Definition role and an enclosing range', () => {
    const idx = decodeIndex(exportScipIndex(sampleInput()).bytes);
    const docA = idx.documents.find((d) => d.relativePath === 'src/a.ts')!;
    const fooDef = docA.occurrences.find((o) => o.symbol === SYM_FOO && o.roles === 1)!;
    expect(fooDef).toBeDefined();
    // class Foo: startLine 3 → line 2 (0-based), startColumn 6.
    expect(fooDef.range).toEqual([2, 6, 6 + 'Foo'.length]);
    expect(fooDef.enclosingRange).toEqual([2, 6, 19, 1]);
  });

  it('turns a calls edge into a reference occurrence in the caller file', () => {
    const idx = decodeIndex(exportScipIndex(sampleInput()).bytes);
    const docB = idx.documents.find((d) => d.relativePath === 'src/b.ts')!;
    // calls fn:baz → method:bar at line 14, col 4 → 0-based [13, 4, 7].
    const ref = docB.occurrences.find((o) => o.symbol === SYM_BAR && o.roles === 0)!;
    expect(ref).toBeDefined();
    expect(ref.range).toEqual([13, 4, 4 + 'bar'.length]);
  });

  it('records extends as both a relationship and a reference occurrence', () => {
    const idx = decodeIndex(exportScipIndex(sampleInput()).bytes);
    const docA = idx.documents.find((d) => d.relativePath === 'src/a.ts')!;
    const foo = docA.symbols.find((s) => s.symbol === SYM_FOO)!;
    expect(foo.relationships).toEqual([{ symbol: SYM_BASE, isImplementation: true }]);
    const extendsRef = docA.occurrences.find((o) => o.symbol === SYM_BASE && o.roles === 0)!;
    expect(extendsRef.range).toEqual([2, 18, 18 + 'Base'.length]);
  });

  it('sets enclosing_symbol from contains edges', () => {
    const idx = decodeIndex(exportScipIndex(sampleInput()).bytes);
    const docA = idx.documents.find((d) => d.relativePath === 'src/a.ts')!;
    const foo = docA.symbols.find((s) => s.symbol === SYM_FOO)!;
    const bar = docA.symbols.find((s) => s.symbol === SYM_BAR)!;
    expect(foo.enclosingSymbol).toBe(SYM_FILE_A);
    expect(bar.enclosingSymbol).toBe(SYM_FOO);
  });

  it('carries docstrings into SymbolInformation.documentation', () => {
    const idx = decodeIndex(exportScipIndex(sampleInput()).bytes);
    const foo = idx.documents.flatMap((d) => d.symbols).find((s) => s.symbol === SYM_FOO)!;
    expect(foo.documentation).toEqual(['The Foo class.']);
  });

  it('disambiguates colliding natural symbols deterministically', () => {
    const input = sampleInput({
      nodes: [
        ...sampleInput().nodes,
        {
          id: 'method:dup1',
          kind: 'method',
          name: 'dup',
          qualifiedName: 'Foo::dup',
          filePath: 'src/a.ts',
          language: 'typescript',
          startLine: 10,
          endLine: 11,
          startColumn: 2,
          endColumn: 3,
        },
        {
          id: 'method:dup2',
          kind: 'method',
          name: 'dup',
          qualifiedName: 'Foo::dup',
          filePath: 'src/a.ts',
          language: 'typescript',
          startLine: 14,
          endLine: 15,
          startColumn: 2,
          endColumn: 3,
        },
      ],
    });
    const result = exportScipIndex(input);
    expect(result.stats.disambiguated).toBe(1);
    const idx = decodeIndex(result.bytes);
    const dupSymbols = idx.documents
      .flatMap((d) => d.symbols)
      .map((s) => s.symbol)
      .filter((s) => s.includes('Foo#dup().'));
    expect(new Set(dupSymbols).size).toBe(2);
    // The earlier-starting node keeps the natural symbol.
    expect(dupSymbols).toContain('cartograph cartograph demo 1.0.0 `src/a.ts`/Foo#dup().');
  });

  it('uses readFileLines to pin a definition onto the name token', () => {
    const lines: Record<string, string[]> = {
      'src/a.ts': ['', '', '  export class Foo extends Base {'],
    };
    const idx = decodeIndex(exportScipIndex(sampleInput({ readFileLines: (p) => lines[p] ?? null })).bytes);
    const docA = idx.documents.find((d) => d.relativePath === 'src/a.ts')!;
    const fooDef = docA.occurrences.find((o) => o.symbol === SYM_FOO && o.roles === 1)!;
    // "Foo" starts at column 15 on the indexed start line.
    expect(fooDef.range).toEqual([2, 15, 18]);
  });

  it('is deterministic — identical input encodes to identical bytes', () => {
    const a = exportScipIndex(sampleInput()).bytes;
    const b = exportScipIndex(sampleInput()).bytes;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
