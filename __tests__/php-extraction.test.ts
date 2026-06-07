import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars.js';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['php']);
});

describe('PHP extraction', () => {
  it('extracts include and require literal targets as imports', () => {
    const source = `<?php
include 'lib/bootstrap.php';
include_once("partials/header.php");
require "vendor/autoload.php";
require_once('config/app.php');
`;

    const result = extractFromSource('index.php', source, 'php');

    expect(result.errors).toEqual([]);
    const expected = ['config/app.php', 'lib/bootstrap.php', 'partials/header.php', 'vendor/autoload.php'];
    expect(
      result.nodes
        .filter((node) => node.kind === 'import')
        .map((node) => node.name)
        .sort(),
    ).toEqual(expected);
    expect(
      result.unresolvedReferences
        .filter((ref) => ref.referenceKind === 'imports')
        .map((ref) => ref.referenceName)
        .sort(),
    ).toEqual(expected);
  });

  it('skips dynamic PHP include and require targets', () => {
    const source = `<?php
include $template;
include_once("views/$name.php");
require_once __DIR__ . '/config.php';
require '';
`;

    const result = extractFromSource('dynamic.php', source, 'php');

    expect(result.errors).toEqual([]);
    expect(result.nodes.filter((node) => node.kind === 'import')).toEqual([]);
    expect(result.unresolvedReferences.filter((ref) => ref.referenceKind === 'imports')).toEqual([]);
  });
});
