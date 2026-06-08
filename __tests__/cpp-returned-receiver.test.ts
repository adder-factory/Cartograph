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
  await loadGrammarsForLanguages(['cpp']);
});

describe('C++ returned-receiver chains', () => {
  let tempDir: string | undefined;
  let cg: Cartograph | undefined;

  afterEach(() => {
    if (cg) cg.close();
    cg = undefined;
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('resolves Class::factory().method() through out-of-class method definitions', async () => {
    const mainSource = ['#include "client.hpp"', 'void run() {', '  Client::create().commit();', '}', ''].join('\n');
    const extracted = extractFromSource('main.cpp', mainSource, 'cpp');
    expect(
      extracted.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName),
    ).toEqual(expect.arrayContaining(['Client::create', 'Client::create().commit']));

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-cpp-factory-'));
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'cpp-factory-fixture' }));
    fs.writeFileSync(
      path.join(tempDir, 'client.hpp'),
      ['class Client {', 'public:', '  static Client create();', '  void commit();', '};', ''].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'client.cpp'),
      ['#include "client.hpp"', 'Client Client::create() { return Client{}; }', 'void Client::commit() {}', ''].join(
        '\n',
      ),
    );
    fs.writeFileSync(path.join(tempDir, 'main.cpp'), mainSource);

    cg = await Cartograph.init(tempDir, { index: true });
    const run = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'run');
    const commit = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'Client::commit');
    expect(run).toBeDefined();
    expect(commit).toBeDefined();

    const callTargets = getOutgoingEdges(cg.queries, run!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => e.target);
    expect(callTargets).toContain(commit!.id);
  });
});
