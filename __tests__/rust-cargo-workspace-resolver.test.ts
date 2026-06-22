import { describe, expect, it } from 'vitest';
import { getCargoWorkspaceCrateMap } from '../src/resolution/frameworks/cargo-workspace.js';
import { rustResolver } from '../src/resolution/frameworks/rust.js';
import type { ResolutionContext } from '../src/resolution/types.js';
import type { Node } from '../src/types.js';

function node(id: string, name: string, kind: Node['kind'], filePath: string): Node {
  return {
    id,
    name,
    kind,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'rust',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 1,
  };
}

function context(files: string[], reads: Record<string, string>, nodes: Node[]): ResolutionContext {
  return {
    readFile: (filePath: string) => reads[filePath] ?? null,
    getAllFiles: () => files,
    fileExists: (filePath: string) => files.includes(filePath),
    getNodesInFile: (filePath: string) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    getProjectRoot: () => '/repo',
  };
}

describe('Rust Cargo workspace resolver', () => {
  it('maps workspace package names to crate import aliases', () => {
    const ctx = context(
      ['Cargo.toml', 'crates/cartograph-core/Cargo.toml', 'crates/cartograph-core/src/lib.rs'],
      {
        'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
        'crates/cartograph-core/Cargo.toml': '[package]\nname = "cartograph-core"\n',
      },
      [node('module:core', 'cartograph_core', 'module', 'crates/cartograph-core/src/lib.rs')],
    );

    const crateMap = getCargoWorkspaceCrateMap(ctx);
    expect(crateMap.get('cartograph-core')).toBe('crates/cartograph-core');
    expect(crateMap.get('cartograph_core')).toBe('crates/cartograph-core');

    const resolved = rustResolver.resolve(
      {
        fromNodeId: 'function:src/main.rs:main:1',
        referenceName: 'cartograph_core',
        referenceKind: 'references',
        line: 1,
        column: 1,
        filePath: 'src/main.rs',
        language: 'rust',
      },
      ctx,
    );

    expect(resolved?.targetNodeId).toBe('module:core');
    expect(resolved?.confidence).toBe(0.85);
  });

  it('parses workspace members and package names without broad regex matching', () => {
    const ctx = context(
      ['Cargo.toml', 'crates/exact/Cargo.toml', 'crates/escaped/Cargo.toml'],
      {
        'Cargo.toml': '[workspace]\n# comment\nmembers = [\n  "crates/exact",\n  "crates/escaped",\n]\n',
        'crates/exact/Cargo.toml': '[package]\nversion = "0.1.0"\nname_extra = "ignored"\nname = "exact-crate"\n',
        'crates/escaped/Cargo.toml': '[package]\nname = "escaped-\\"crate"\n',
      },
      [],
    );

    const crateMap = getCargoWorkspaceCrateMap(ctx);
    expect(crateMap.get('exact-crate')).toBe('crates/exact');
    expect(crateMap.get('exact_crate')).toBe('crates/exact');
    expect(crateMap.get('escaped-\\"crate')).toBe('crates/escaped');
  });

  it('returns an empty crate map when workspace members are not an array', () => {
    const ctx = context(['Cargo.toml'], { 'Cargo.toml': '[workspace]\nresolver = "2"\n' }, []);

    expect(getCargoWorkspaceCrateMap(ctx).size).toBe(0);
  });

  it('skips members with missing or unterminated package names', () => {
    const ctx = context(
      ['Cargo.toml', 'crates/missing/Cargo.toml', 'crates/broken/Cargo.toml'],
      {
        'Cargo.toml': '[workspace]\nmembers = ["crates/missing", "crates/broken"]\n',
        'crates/missing/Cargo.toml': '[package]\nversion = "0.1.0"\n',
        'crates/broken/Cargo.toml': '[package]\nname = "unterminated\n',
      },
      [],
    );

    expect(getCargoWorkspaceCrateMap(ctx).size).toBe(0);
  });
});
