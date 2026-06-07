import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import { loadGrammarsForLanguages } from '../src/extraction/grammars.js';

beforeAll(async () => {
  await loadGrammarsForLanguages(['kotlin']);
});

describe('Kotlin property extraction', () => {
  it('emits class-body and primary-constructor properties as typed fields', () => {
    const result = extractFromSource(
      'Repo.kt',
      [
        'package com.example',
        'class Repo(private val userbo: UserBO, var service: Service, plain: String) {',
        '  private val maybe: UserBO? = null',
        '  fun run() { userbo.toLogin2(); service.go(); maybe?.toLogin2() }',
        '}',
        '',
      ].join('\n'),
    );

    const fields = result.nodes.filter((n) => n.kind === 'field').map((n) => [n.name, n.signature, n.visibility]);
    expect(fields).toEqual(
      expect.arrayContaining([
        ['userbo', 'val userbo: UserBO', 'private'],
        ['service', 'var service: Service', 'public'],
        ['maybe', 'val maybe: UserBO?', 'private'],
      ]),
    );
    expect(fields.some(([name]) => name === 'plain')).toBe(false);
    expect(
      result.unresolvedReferences.filter((r) => r.referenceKind === 'type_of').map((r) => r.referenceName),
    ).toEqual(expect.arrayContaining(['UserBO', 'Service']));
  });
});
