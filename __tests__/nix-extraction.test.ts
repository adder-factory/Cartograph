import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import {
  detectLanguage,
  getSupportedLanguages,
  initGrammars,
  isLanguageSupported,
  loadGrammarsForLanguages,
} from '../src/extraction/grammars.js';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['nix']);
});

describe('Nix extraction', () => {
  it('detects Nix files', () => {
    expect(detectLanguage('default.nix')).toBe('nix');
    expect(isLanguageSupported('nix')).toBe(true);
    expect(getSupportedLanguages()).toContain('nix');
  });

  it('extracts bindings, function signatures, imports, and apply-call references', () => {
    const source = `
{ pkgs ? import <nixpkgs> {} }:
let
  helper = x: builtins.toString x;
  localValue = helper 1;
in rec {
  package = pkgs.stdenv.mkDerivation {
    name = helper 1;
  };
  inherit (pkgs) lib;
}
`;

    const result = extractFromSource('default.nix', source, 'nix');

    expect(result.errors).toEqual([]);

    const nodesByKind = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));
    expect(nodesByKind.get('function:helper')?.signature).toBe('x');
    expect(nodesByKind.has('constant:localValue')).toBe(true);
    expect(nodesByKind.has('constant:package')).toBe(true);
    expect(nodesByKind.has('constant:name')).toBe(true);
    expect(nodesByKind.has('constant:lib')).toBe(true);
    expect(nodesByKind.get('import:<nixpkgs>')?.signature).toBe('import <nixpkgs>');

    const refs = result.unresolvedReferences.map((ref) => `${ref.referenceKind}:${ref.referenceName}`);
    expect(refs).toEqual(
      expect.arrayContaining([
        'imports:<nixpkgs>',
        'calls:builtins.toString',
        'calls:helper',
        'calls:pkgs.stdenv.mkDerivation',
        'references:pkgs',
      ]),
    );
  });
});
