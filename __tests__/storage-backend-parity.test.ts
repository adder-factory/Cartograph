import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';
import { getOutgoingEdges, insertEdges } from '../src/db/queries-edges.js';
import { upsertFile } from '../src/db/queries-files.js';
import { getNodesAtRange } from '../src/db/queries-rtree.js';
import { searchNodes } from '../src/db/queries-search.js';

const POSTGRES_URL = process.env['CARTOGRAPH_TEST_POSTGRES_URL'];

interface BackendCase {
  name: 'sqlite' | 'postgres';
  reportedBackend: 'bun-sqlite' | 'postgres';
  enabled: boolean;
}

const backendCases: BackendCase[] = [
  { name: 'sqlite', reportedBackend: 'bun-sqlite', enabled: true },
  { name: 'postgres', reportedBackend: 'postgres', enabled: POSTGRES_URL !== undefined },
];

const PARITY_FILE_SIZE = 320;
const PARITY_NODE_COUNT = 2;
const PARITY_LOC = 30;
const PARITY_SOURCE_START = 10;
const PARITY_SOURCE_END = 18;
const PARITY_TARGET_START = 20;
const PARITY_TARGET_END = 26;
const PARITY_EDGE_LINE = 14;
const PARITY_EDGE_COLUMN = 2;
const PARITY_RANGE_START = 12;
const PARITY_RANGE_END = 13;
const PARITY_LIMIT = 10;

let currentDir: string | undefined;
let currentSchema: string | undefined;
let currentCg: Cartograph | undefined;

afterEach(async () => {
  currentCg?.close();
  currentCg = undefined;
  if (currentDir && fs.existsSync(currentDir)) fs.rmSync(currentDir, { recursive: true, force: true });
  currentDir = undefined;
  if (POSTGRES_URL && currentSchema) {
    const sql = new Bun.SQL(POSTGRES_URL);
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(currentSchema)} CASCADE`).simple();
    } finally {
      await sql.close();
      currentSchema = undefined;
    }
  }
});

for (const backend of backendCases) {
  const describeBackend = backend.enabled ? describe : describe.skip;
  describeBackend(`storage backend parity (${backend.name})`, () => {
    it('persists and queries the core graph contract', () => {
      currentCg = initBackend(backend.name);
      seedParityGraph(currentCg);

      expect(currentCg.db.getBackend()).toBe(backend.reportedBackend);
      expect(currentCg.queries.getNodeById('n:parity-source')?.name).toBe('ParitySource');
      expect(getOutgoingEdges(currentCg.queries, 'n:parity-source')[0]?.target).toBe('n:parity-target');
      expect(
        searchNodes(currentCg.queries, 'parity', { kinds: ['function'], languages: ['typescript'], limit: 10 }).map(
          (result) => result.node.id,
        ),
      ).toEqual(expect.arrayContaining(['n:parity-source', 'n:parity-target']));
      expect(
        getNodesAtRange(currentCg.queries, {
          filePath: 'src/parity.ts',
          startLine: PARITY_RANGE_START,
          endLine: PARITY_RANGE_END,
          limit: PARITY_LIMIT,
        }).map((node) => node.id),
      ).toContain('n:parity-source');

      const projectPath = currentCg.projectRoot;
      currentCg.close();
      currentCg = Cartograph.openSync(projectPath);
      expect(currentCg.db.getBackend()).toBe(backend.reportedBackend);
      expect(currentCg.queries.getNodeById('n:parity-target')?.qualifiedName).toBe('ParityTarget');
    });
  });
}

function initBackend(name: BackendCase['name']): Cartograph {
  currentDir = fs.mkdtempSync(path.join(os.tmpdir(), `cartograph-${name}-parity-`));
  if (name === 'sqlite') return Cartograph.initSync(currentDir);
  currentSchema = `cg_parity_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  return Cartograph.initSync(currentDir, {
    config: {
      database: {
        provider: 'postgres',
        url: POSTGRES_URL!,
        schema: currentSchema,
        queryTimeoutMs: 60_000,
      },
    },
  });
}

function seedParityGraph(cg: Cartograph): void {
  upsertFile(cg.queries, {
    path: 'src/parity.ts',
    contentHash: 'hash-parity',
    language: 'typescript',
    size: PARITY_FILE_SIZE,
    modifiedAt: Date.now(),
    indexedAt: Date.now(),
    nodeCount: PARITY_NODE_COUNT,
    errors: [],
    commitCount: 0,
    loc: PARITY_LOC,
    firstSeenTs: null,
    lastTouchedTs: null,
    isTest: false,
    needsReextract: false,
  });
  cg.queries.insertNodes([
    {
      id: 'n:parity-source',
      kind: 'function',
      name: 'ParitySource',
      qualifiedName: 'ParitySource',
      filePath: 'src/parity.ts',
      language: 'typescript',
      startLine: PARITY_SOURCE_START,
      endLine: PARITY_SOURCE_END,
      startColumn: 0,
      endColumn: 1,
      docstring: 'Parity source docstring',
      signature: 'function ParitySource()',
      visibility: 'public',
      isExported: true,
      isAsync: false,
      isStatic: false,
      decorators: [],
      decoratorArgs: null,
      updatedAt: Date.now(),
      centrality: null,
      betweenness: null,
      bodyHash: 'body-parity-source',
    },
    {
      id: 'n:parity-target',
      kind: 'function',
      name: 'ParityTarget',
      qualifiedName: 'ParityTarget',
      filePath: 'src/parity.ts',
      language: 'typescript',
      startLine: PARITY_TARGET_START,
      endLine: PARITY_TARGET_END,
      startColumn: 0,
      endColumn: 1,
      docstring: 'Parity target docstring',
      signature: 'function ParityTarget()',
      visibility: 'public',
      isExported: true,
      isAsync: false,
      isStatic: false,
      decorators: [],
      decoratorArgs: null,
      updatedAt: Date.now(),
      centrality: null,
      betweenness: null,
      bodyHash: 'body-parity-target',
    },
  ]);
  insertEdges(cg.queries, [
    {
      source: 'n:parity-source',
      target: 'n:parity-target',
      kind: 'calls',
      metadata: { parity: true },
      line: PARITY_EDGE_LINE,
      column: PARITY_EDGE_COLUMN,
      confidence: 'EXTRACTED',
    },
  ]);
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
