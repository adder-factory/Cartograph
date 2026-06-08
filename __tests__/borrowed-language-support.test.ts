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
  await loadGrammarsForLanguages(['abap', 'astro', 'lean', 'typescript', 'vbnet']);
});

describe('borrowed language support additions', () => {
  it('detects ABAP, Astro, Lean, and VB.NET files', () => {
    expect(detectLanguage('src/zcl_greeter.clas.abap')).toBe('abap');
    expect(detectLanguage('src/pages/index.astro')).toBe('astro');
    expect(detectLanguage('Math/Demo.lean')).toBe('lean');
    expect(detectLanguage('Greeter.vb')).toBe('vbnet');

    for (const language of ['abap', 'astro', 'lean', 'vbnet'] as const) {
      expect(isLanguageSupported(language)).toBe(true);
      expect(getSupportedLanguages()).toContain(language);
    }
  });

  it('extracts ABAP class implementations and methods from abapGit-style files', () => {
    const source = `
CLASS zcl_greeter DEFINITION PUBLIC.
  PUBLIC SECTION.
    METHODS greet IMPORTING iv_name TYPE string.
ENDCLASS.
CLASS zcl_greeter IMPLEMENTATION.
  METHOD greet.
    WRITE iv_name.
  ENDMETHOD.
ENDCLASS.
`;

    const result = extractFromSource('zcl_greeter.clas.abap', source, 'abap');
    expect(result.errors).toEqual([]);

    const byKindName = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));
    expect(byKindName.has('class:zcl_greeter')).toBe(true);
    expect(byKindName.has('method:greet')).toBe(true);

    const classNode = byKindName.get('class:zcl_greeter')!;
    const methodNode = byKindName.get('method:greet')!;
    expect(result.edges).toContainEqual({ source: classNode.id, target: methodNode.id, kind: 'contains' });
  });

  it('extracts Astro component identity, frontmatter symbols, imports, and template refs', () => {
    const source = `---
import Layout from './Layout.astro';
const title = 'Home';
function greet(name: string) { return name; }
---
<Layout title={title}>
  <h1>{greet(title)}</h1>
</Layout>
`;

    const result = extractFromSource('src/pages/index.astro', source, 'astro');
    expect(result.errors).toEqual([]);

    expect(result.nodes.map((node) => `${node.kind}:${node.name}`)).toEqual(
      expect.arrayContaining(['component:index', 'import:./Layout.astro', 'constant:title', 'function:greet']),
    );
    expect(result.unresolvedReferences.map((ref) => `${ref.referenceKind}:${ref.referenceName}`)).toEqual(
      expect.arrayContaining(['imports:./Layout.astro', 'references:Layout', 'calls:greet']),
    );
  });

  it('extracts Lean imports, structures, inductives, theorems, and abbreviations', () => {
    const source = `
import Mathlib.Data.Nat.Basic

structure User where
  name : String

inductive Role where
  | admin
  | user

def greet (u : User) : String := u.name
theorem id_eq (n : Nat) : n = n := rfl
abbrev UserName := String
`;

    const result = extractFromSource('Demo.lean', source, 'lean');
    expect(result.errors).toEqual([]);

    expect(result.nodes.map((node) => `${node.kind}:${node.name}`)).toEqual(
      expect.arrayContaining([
        'import:Mathlib.Data.Nat.Basic',
        'struct:User',
        'field:name',
        'enum:Role',
        'enum_member:admin',
        'enum_member:user',
        'function:greet',
        'function:id_eq',
        'type_alias:UserName',
      ]),
    );
    expect(result.unresolvedReferences.map((ref) => `${ref.referenceKind}:${ref.referenceName}`)).toContain(
      'imports:Mathlib.Data.Nat.Basic',
    );
  });

  it('extracts VB.NET imports, classes, properties, methods, and signatures', () => {
    const source = `Imports System

Public Class Greeter
  Public Property Name As String
  Public Sub SayHello()
    Console.WriteLine(Name)
  End Sub
  Public Shared Function Echo(value As String) As String
    Return value
  End Function
End Class
`;

    const result = extractFromSource('Greeter.vb', source, 'vbnet');
    expect(result.errors).toEqual([]);

    const byKindName = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));
    expect(byKindName.has('import:System')).toBe(true);
    expect(byKindName.has('class:Greeter')).toBe(true);
    expect(byKindName.has('property:Name')).toBe(true);
    expect(byKindName.get('method:SayHello')?.signature).toBe('()');
    expect(byKindName.get('method:Echo')?.signature).toBe('(value As String) As String');
    expect(result.unresolvedReferences.map((ref) => `${ref.referenceKind}:${ref.referenceName}`)).toContain(
      'imports:System',
    );
  });
});
