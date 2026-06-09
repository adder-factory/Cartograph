import { beforeAll, describe, expect, it } from 'vitest';
import { detectLanguage, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';

describe('F#, PowerShell, and VB6 extraction', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['fsharp', 'powershell']);
  });

  it('extracts F# modules, functions, records, and calls', () => {
    const source = `
namespace Demo

module Math =
  let add x y = x + y
  type Person = { Name: string; Age: int }

let result = Math.add 1 2
`;
    const result = extractFromSource('Sample.fs', source);
    const names = new Set(result.nodes.map((node) => `${node.kind}:${node.name}`));

    expect(detectLanguage('Sample.fs')).toBe('fsharp');
    expect(names.has('namespace:Demo')).toBe(true);
    expect(names.has('module:Math')).toBe(true);
    expect(names.has('function:add')).toBe(true);
    expect(names.has('struct:Person')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'Math.add')).toBe(true);
  });

  it('extracts PowerShell classes, functions, fields, imports, and command calls', () => {
    const source = `
using module ./Helpers.psm1

class Greeter {
  [string] $Name
  [string] Greet([string] $target) { return Format-Greeting $target }
}

function Format-Greeting {
  Get-Date | Out-Null
}

Format-Greeting -Name Ada
`;
    const result = extractFromSource('Sample.ps1', source);
    const names = new Set(result.nodes.map((node) => `${node.kind}:${node.name}`));

    expect(detectLanguage('Sample.psm1')).toBe('powershell');
    expect(names.has('import:./Helpers.psm1')).toBe(true);
    expect(names.has('class:Greeter')).toBe(true);
    expect(names.has('field:Name')).toBe(true);
    expect(names.has('method:Greet')).toBe(true);
    expect(names.has('function:Format-Greeting')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'Get-Date')).toBe(true);
  });

  it('extracts VB6 symbols and routes VB6 class modules away from Apex by content', () => {
    const source = `
VERSION 1.0 CLASS
Attribute VB_Name = "Customer"
Option Explicit

Private customerName As String

Public Sub Load()
    FormatName customerName
End Sub

Public Function FormatName(ByVal value As String) As String
    FormatName = value
End Function
`;
    const result = extractFromSource('Customer.cls', source);
    const names = new Set(result.nodes.map((node) => `${node.kind}:${node.name}`));

    expect(detectLanguage('Customer.cls', source)).toBe('vb6');
    expect(detectLanguage('Account.cls', 'public class Account {}')).toBe('apex');
    expect(names.has('class:Customer')).toBe(true);
    expect(names.has('field:customerName')).toBe(true);
    expect(names.has('method:Load')).toBe(true);
    expect(names.has('method:FormatName')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'FormatName')).toBe(true);
  });
});
