import { describe, expect, it } from 'vitest';
import { getCargoWorkspaceCrateMap } from '../src/resolution/frameworks/cargo-workspace.js';
import { rustResolver } from '../src/resolution/frameworks/rust.js';
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

function context(files: string[], reads: Record<string, string>, nodes: Node[]) {
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
  } as any;
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
});
