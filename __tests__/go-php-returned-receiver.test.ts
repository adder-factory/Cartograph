import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';
import { loadGrammarsForLanguages } from '../src/extraction/grammars.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';

beforeAll(async () => {
  await loadGrammarsForLanguages(['go', 'php']);
});

describe('Go package variable initializer calls', () => {
  it('walks anonymous function literals nested in top-level initializer values', () => {
    const result = extractFromSource(
      'cmd.go',
      [
        'package main',
        'type Command struct { RunE func() error }',
        'var rootCmd = Command{',
        '  RunE: func() error {',
        '    return Wire()',
        '  },',
        '}',
        'func Wire() error { return nil }',
        '',
      ].join('\n'),
      'go',
    );

    const rootCmd = result.nodes.find((n) => n.kind === 'variable' && n.name === 'rootCmd');
    expect(rootCmd).toBeDefined();
    expect(result.nodes.some((n) => n.name === '<anonymous>')).toBe(false);

    const calls = result.unresolvedReferences
      .filter((r) => r.fromNodeId === rootCmd!.id && r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(calls).toContain('Wire');
  });
});

describe('PHP returned-receiver static factory chains', () => {
  let tempDir: string | undefined;
  let cg: Cartograph | undefined;

  afterEach(() => {
    if (cg) cg.close();
    cg = undefined;
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('extracts a normalized chain and resolves the returned instance method', async () => {
    const source = [
      '<?php',
      'class ApiClient {',
      '  public static function for(string $credential): ?self { return new self(); }',
      '  public function createOrder(): void {}',
      '}',
      'function run(): void {',
      "  ApiClient::for('cred-123')->createOrder();",
      '}',
      '',
    ].join('\n');

    const extracted = extractFromSource('ApiClient.php', source, 'php');
    expect(extracted.nodes.find((n) => n.kind === 'method' && n.name === 'for')?.signature).toBe(
      '(string $credential): ?self',
    );
    expect(
      extracted.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName),
    ).toEqual(expect.arrayContaining(['ApiClient.for', 'ApiClient.for().createOrder']));

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-php-factory-'));
    fs.writeFileSync(path.join(tempDir, 'composer.json'), JSON.stringify({ name: 'fixture/php-factory' }));
    fs.writeFileSync(path.join(tempDir, 'ApiClient.php'), source);

    cg = await Cartograph.init(tempDir, { index: true });
    const run = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'run');
    const createOrder = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'createOrder');
    expect(run).toBeDefined();
    expect(createOrder).toBeDefined();

    const callTargets = getOutgoingEdges(cg.queries, run!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => e.target);
    expect(callTargets).toContain(createOrder!.id);
  });
});
