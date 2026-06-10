/**
 * Postgres-backend validation for the fixes that only differ from SQLite
 * on the Postgres path — exercised against a real pgvector container
 * (auto-started by `npm run test:postgres`; skipped when no
 * CARTOGRAPH_TEST_POSTGRES_URL is set).
 *
 *  - clearStructural cascade-wipe preservation: on SQLite `PRAGMA
 *    foreign_keys = OFF` lets node-keyed side tables survive a nodes
 *    wipe; on Postgres the `ON DELETE CASCADE` FKs would delete them, so
 *    the fix suppresses RI triggers via `SET LOCAL session_replication_
 *    role`. This test proves an agent note SURVIVES `clearStructural` on
 *    real Postgres (the data-loss bug it fixes).
 *  - LIKE → ILIKE parity: SQLite's default LIKE is case-insensitive;
 *    Postgres LIKE is case-sensitive, so the worker rewrites plain LIKE to
 *    ILIKE. This test proves a lowercase substring search matches a
 *    mixed-case symbol on Postgres.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { addNote, listNotes } from '../src/db/queries-notes.js';
import { searchNodes } from '../src/db/queries-search.js';
import { upsertFile } from '../src/db/queries-files.js';
import type { Cartograph as CartographInstance } from '../src/index.js';

function countNotes(cg: CartographInstance): number {
  const row = cg.queries.db.prepare('SELECT COUNT(*) AS n FROM agent_notes').get() as { n: number | bigint };
  return Number(row.n);
}

const POSTGRES_URL = process.env['CARTOGRAPH_TEST_POSTGRES_URL'];
const describePostgres = POSTGRES_URL ? describe : describe.skip;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

let currentDir: string | undefined;
let currentSchema: string | undefined;

afterEach(async () => {
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

function makeNode(id: string, name: string) {
  return {
    id,
    kind: 'function' as const,
    name,
    qualifiedName: name,
    filePath: 'src/app.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 5,
    startColumn: 0,
    endColumn: 1,
    docstring: null,
    signature: `function ${name}()`,
    visibility: 'public' as const,
    isExported: true,
    isAsync: false,
    isStatic: false,
    decorators: [],
    decoratorArgs: null,
    updatedAt: Date.now(),
    centrality: null,
    betweenness: null,
    bodyHash: `body-${id}`,
  };
}

function openPostgresProject() {
  currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-pg-clear-'));
  currentSchema = `cg_clear_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const cartographDir = path.join(currentDir, '.cartograph');
  fs.mkdirSync(cartographDir, { recursive: true });
  fs.writeFileSync(
    path.join(cartographDir, 'config.json'),
    JSON.stringify({ database: { provider: 'postgres', url: POSTGRES_URL!, schema: currentSchema } }),
  );
  const cg = Cartograph.initSync(currentDir);
  expect(cg.db.getBackend()).toBe('postgres');
  upsertFile(cg.queries, {
    path: 'src/app.ts',
    contentHash: 'hash-app',
    language: 'typescript',
    size: 200,
    modifiedAt: Date.now(),
    indexedAt: Date.now(),
    nodeCount: 1,
    errors: [],
    commitCount: 0,
    loc: 20,
    firstSeenTs: null,
    lastTouchedTs: null,
    isTest: false,
    needsReextract: false,
  });
  return cg;
}

describePostgres('Postgres clearStructural + dialect parity', () => {
  it('preserves a node-keyed agent note across clearStructural (no FK cascade wipe)', () => {
    const cg = openPostgresProject();
    try {
      cg.queries.insertNodes([makeNode('n:keep', 'keepMe')]);
      addNote(cg.queries, {
        nodeId: 'n:keep',
        author: 'agent',
        ts: Date.now(),
        text: 'survives --force',
        kind: 'note',
      });

      // Pre-condition: the note exists and the node is present. (Counted
      // directly rather than via listNotes — see the listNotes Postgres
      // regression test below.)
      expect(countNotes(cg)).toBe(1);

      cg.clearStructural();

      // The structural node is gone...
      expect(searchNodes(cg.queries, 'keepMe', { limit: 5 })).toHaveLength(0);
      // ...but the agent note SURVIVED the nodes wipe (FK cascade was
      // suppressed), with its node_id intact to re-link when the next
      // index recreates the node by stable id.
      expect(countNotes(cg)).toBe(1);
      // listNotes also works on Postgres now (regression: the `ts >= @since`
      // sentinel used to crash with "double precision >= text").
      const notes = listNotes(cg.queries, { nodeId: 'n:keep' });
      expect(notes).toHaveLength(1);
      expect(notes[0]!.text).toBe('survives --force');
    } finally {
      cg.close();
    }
  });

  it('matches a lowercase substring against a mixed-case symbol (LIKE → ILIKE)', () => {
    const cg = openPostgresProject();
    try {
      cg.queries.insertNodes([makeNode('n:mixed', 'MixedCaseWidget')]);
      // A lowercase substring query must match the mixed-case name the way
      // SQLite's default case-insensitive LIKE would.
      const hits = searchNodes(cg.queries, 'mixedcasewidget', { limit: 5 });
      expect(hits.some((r) => r.node.name === 'MixedCaseWidget')).toBe(true);
    } finally {
      cg.close();
    }
  });
});
