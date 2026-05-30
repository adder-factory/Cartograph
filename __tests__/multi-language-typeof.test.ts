/**
 * Per-language regression tests — every supported language with
 * type annotations should now emit at least one `type_of` edge for
 * the param/field/return shape its fixture exercises. These were
 * the Tier 2 gaps closed in feat/freshness-v2.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFromSource } from '../src/extraction/tree-sitter.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const TESTBEDS = path.join(__dirname, '..', 'docs', 'test-beds');

interface ExpectedShape {
  language: string;
  fixture: string;
  minTypeOf: number;
  minReturns?: number;
  expectsBox?: boolean;
}

const EXPECTED: ExpectedShape[] = [
  { language: 'typescript', fixture: 'typescript/fixture.ts', minTypeOf: 4, minReturns: 1, expectsBox: true },
  { language: 'tsx', fixture: 'tsx/fixture.tsx', minTypeOf: 1, minReturns: 1 },
  { language: 'java', fixture: 'java/fixture.java', minTypeOf: 4, minReturns: 1, expectsBox: true },
  { language: 'rust', fixture: 'rust/fixture.rs', minTypeOf: 4, minReturns: 1, expectsBox: true },
  { language: 'go', fixture: 'go/fixture.go', minTypeOf: 1, minReturns: 1, expectsBox: true },
  { language: 'python', fixture: 'python/fixture.py', minTypeOf: 1, minReturns: 1, expectsBox: true },
  { language: 'csharp', fixture: 'csharp/fixture.cs', minTypeOf: 1, expectsBox: true },
  { language: 'kotlin', fixture: 'kotlin/fixture.kt', minTypeOf: 2, minReturns: 1, expectsBox: true },
  { language: 'dart', fixture: 'dart/fixture.dart', minTypeOf: 1, minReturns: 1, expectsBox: true },
  { language: 'scala', fixture: 'scala/fixture.scala', minTypeOf: 2, minReturns: 1, expectsBox: true },
  { language: 'swift', fixture: 'swift/fixture.swift', minTypeOf: 2, minReturns: 1, expectsBox: true },
  { language: 'php', fixture: 'php/fixture.php', minTypeOf: 1, minReturns: 1, expectsBox: true },
  { language: 'c', fixture: 'c/fixture.c', minTypeOf: 1 },
  { language: 'cpp', fixture: 'cpp/fixture.cpp', minTypeOf: 2, expectsBox: true },
  { language: 'rescript', fixture: 'rescript/fixture.res', minTypeOf: 2, minReturns: 1 },
  { language: 'pascal', fixture: 'pascal/fixture.pas', minTypeOf: 1, minReturns: 1 },
  { language: 'svelte', fixture: 'svelte/fixture.svelte', minTypeOf: 1, minReturns: 1, expectsBox: true },
  // F#47 (2026-05-26): Vue SFC. Script block extracted via TS grammar
  // through VueExtractor; type_of / returns shapes inherit from
  // TS-family coverage.
  { language: 'vue', fixture: 'vue/fixture.vue', minTypeOf: 2, minReturns: 1 },
];

function refsOfKind(refs: any[], kind: string): any[] {
  return refs.filter((r: any) => r.referenceKind === kind);
}

describe('Multi-language type_of / returns extraction', () => {
  for (const e of EXPECTED) {
    it(`${e.language}: emits ≥${e.minTypeOf} type_of edges`, async () => {
      const file = path.join(TESTBEDS, e.fixture);
      const code = fs.readFileSync(file, 'utf-8');
      const result = extractFromSource(file, code);
      const refs = result.unresolvedReferences ?? [];
      const typeOf = refsOfKind(refs, 'type_of');
      expect(typeOf.length).toBeGreaterThanOrEqual(e.minTypeOf);
      if (e.minReturns !== undefined) {
        expect(refsOfKind(refs, 'returns').length).toBeGreaterThanOrEqual(e.minReturns);
      }
      if (e.expectsBox) {
        // Every fixture references `Box` from at least one annotation.
        expect(typeOf.some((r: any) => r.referenceName === 'Box')).toBe(true);
      }
    });
  }
});
