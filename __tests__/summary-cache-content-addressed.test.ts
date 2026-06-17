/**
 * Content-addressed summary reuse must survive ref eviction.
 *
 * Regression for the multi-agent churn waste: a concurrent re-extract deletes
 * a file's nodes, cascade-deleting their `summary_refs`. The cached summary
 * text stays in the content-addressed `summary_store`, so re-materialisation
 * should re-pin it WITHOUT calling the LLM. The bug was that
 * `getSummaryByContentHash` looked the summary up through the
 * `symbol_summaries` view (an INNER JOIN onto `summary_refs`), which hides the
 * cached row the moment its last ref is evicted — forcing needless regen.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { upsertSymbolSummary, getSummaryByContentHash, getSymbolSummary } from '../src/db/queries-summaries.js';
import type { Node } from '../src/types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeNode(id: string): Node {
  return {
    id,
    name: id,
    qualifiedName: id,
    kind: 'function',
    filePath: 'src/a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

describe('getSummaryByContentHash — content-addressed reuse', () => {
  it('serves the cached summary from summary_store after every summary_ref is cascade-evicted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sumcache-'));
    dirs.push(dir);
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'cartograph.db'));
    try {
      const qb = new QueryBuilder(dbConn.getDb());
      const db = dbConn.getDb();
      db.prepare(
        `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES (?, '', 'typescript', 0, 0, 0)`,
      ).run('src/a.ts');
      qb.insertNode(makeNode('fn:1'));

      const hash = 'body-hash-xyz';
      const model = 'qwen@sp2';
      upsertSymbolSummary({ qb, nodeId: 'fn:1', contentHash: hash, summary: 'does a thing', model });

      // Live lookups both see it while the ref exists.
      expect(getSymbolSummary(qb, 'fn:1')?.summary).toBe('does a thing');
      expect(getSummaryByContentHash(qb, hash, model)?.summary).toBe('does a thing');

      // Simulate a concurrent re-extract: delete the node, cascading away its
      // summary_refs row. The store keeps the cached text.
      db.prepare('DELETE FROM nodes WHERE id = ?').run('fn:1');
      expect(getSymbolSummary(qb, 'fn:1')).toBeNull();
      expect((db.prepare('SELECT COUNT(*) AS n FROM summary_refs').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM summary_store').get() as { n: number }).n).toBe(1);

      // The fix: content-addressed lookup still serves the cached summary, so
      // re-materialisation re-pins it with no LLM call.
      expect(getSummaryByContentHash(qb, hash, model)?.summary).toBe('does a thing');

      // The old view-based path (refs ⋈ store) now returns nothing — this is
      // exactly the miss that used to force regeneration.
      expect(
        db.prepare('SELECT summary FROM symbol_summaries WHERE content_hash = ? AND model = ?').get(hash, model),
      ).toBeNull();
    } finally {
      dbConn.close();
    }
  });

  it('stays model-scoped: a summary cached under a different model is a miss', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sumcache-model-'));
    dirs.push(dir);
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'cartograph.db'));
    try {
      const qb = new QueryBuilder(dbConn.getDb());
      const db = dbConn.getDb();
      db.prepare(
        `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES (?, '', 'typescript', 0, 0, 0)`,
      ).run('src/a.ts');
      qb.insertNode(makeNode('fn:1'));
      upsertSymbolSummary({ qb, nodeId: 'fn:1', contentHash: 'h', summary: 's', model: 'modelA@sp2' });

      expect(getSummaryByContentHash(qb, 'h', 'modelA@sp2')?.summary).toBe('s');
      expect(getSummaryByContentHash(qb, 'h', 'modelB@sp2')).toBeNull();
    } finally {
      dbConn.close();
    }
  });
});
