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
  await loadGrammarsForLanguages(['groovy', 'solidity']);
});

describe('Groovy extraction', () => {
  it('detects Groovy source and Gradle scripts', () => {
    expect(detectLanguage('src/main/groovy/App.groovy')).toBe('groovy');
    expect(detectLanguage('build.gradle')).toBe('groovy');
    expect(isLanguageSupported('groovy')).toBe(true);
    expect(getSupportedLanguages()).toContain('groovy');
  });

  it('extracts classes, fields, methods, imports, signatures, and local calls', () => {
    const source = `
package demo
import java.time.Instant

class Greeter {
  String name
  String greet(String other) { return helper(other) }
  private String helper(String other) { return other }
}

def topLevel(value) { return value.toString() }
`;

    const result = extractFromSource('Greeter.groovy', source, 'groovy');
    const byKindName = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));

    expect(byKindName.has('class:Greeter')).toBe(true);
    expect(byKindName.has('field:name')).toBe(true);
    expect(byKindName.get('method:greet')?.signature).toBe('String (String other)');
    expect(byKindName.get('method:helper')?.visibility).toBe('private');
    expect(byKindName.has('function:topLevel')).toBe(true);
    expect(byKindName.has('import:java.time.Instant')).toBe(true);

    const calls = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(calls).toContain('helper');
    expect(calls).toContain('value.toString');
  });
});

describe('Solidity extraction', () => {
  it('detects Solidity source', () => {
    expect(detectLanguage('contracts/Vault.sol')).toBe('solidity');
    expect(isLanguageSupported('solidity')).toBe(true);
    expect(getSupportedLanguages()).toContain('solidity');
  });

  it('extracts contracts, structs, state variables, methods, signatures, imports, and local calls', () => {
    const source = `
pragma solidity ^0.8.0;
import "./SafeMath.sol";

contract Vault {
  struct Entry { uint amount; }
  uint public total;

  function helper(uint amount) private returns (uint) {
    return amount * 2;
  }

  function deposit(uint amount) public returns (bool) {
    uint doubled = helper(amount);
    return doubled > 0;
  }
}
`;

    const result = extractFromSource('Vault.sol', source, 'solidity');
    const byKindName = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));

    expect(byKindName.has('class:Vault')).toBe(true);
    expect(byKindName.has('struct:Entry')).toBe(true);
    expect(byKindName.has('field:total')).toBe(true);
    expect(byKindName.get('method:helper')?.visibility).toBe('private');
    expect(byKindName.get('method:deposit')?.signature).toBe('(uint amount) returns (bool)');
    expect(byKindName.has('import:./SafeMath.sol')).toBe(true);

    const calls = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(calls).toContain('helper');
  });
});
