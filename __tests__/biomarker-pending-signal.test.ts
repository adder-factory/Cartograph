/**
 * G10.7 — regression coverage for `areBiomarkersPending`.
 *
 * The prior implementation used a heuristic ("table empty + analysable
 * nodes ⇒ pending") that couldn't distinguish a genuinely 0/0/0
 * project from a stalled post-hook. This test locks the new behaviour:
 * the function reads the `biomarker_cross_file_pass_at` metadata
 * timestamp and compares it against `index_timestamp` to decide.
 *
 * Failure modes guarded:
 *   - "pending" false-positive on a genuinely clean project (the bug)
 *   - "not pending" false-negative when the table is stale (index_timestamp
 *     newer than the last cross-file pass timestamp)
 *   - Missing metadata key → pending (never-completed-a-pass state)
 *   - Corrupt non-numeric metadata → pending (defensive)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { setMetadata } from '../src/db/queries-metadata.js';
import { areBiomarkersPending } from '../src/biomarkers/pending.js';

function makeCgLike(queries: QueryBuilder, db: DatabaseConnection): { queries: QueryBuilder; db: DatabaseConnection } {
  // areBiomarkersPending only consumes cg.queries; the cg.db field is
  // touched only by the prior heuristic which is now gone. Pass both
  // to keep the test future-proof against minor signature drift.
  return { queries, db };
}

describe('areBiomarkersPending — metadata-driven signal (G10.7)', () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pending-signal-'));
    dbPath = path.join(tempDir, 'cartograph.db');
    db = DatabaseConnection.initialize(dbPath);
    queries = new QueryBuilder(db.getDb(), db.hasVecExtension());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns pending when no cross-file timestamp has been written', () => {
    // Fresh DB: no biomarker_cross_file_pass_at key. The post-hook has
    // never completed, so pending is the safe verdict.
    setMetadata(queries, 'index_timestamp', String(Date.now()));
    expect(areBiomarkersPending(makeCgLike(queries, db) as never)).toBe(true);
  });

  it('returns not-pending on a genuinely clean project (the G10.6 false-positive case)', () => {
    // Cross-file pass completed AFTER the index was built; findings
    // table is empty — but that's because the project is clean, not
    // because the hook stalled.
    const indexAt = Date.now() - 1000;
    setMetadata(queries, 'index_timestamp', String(indexAt));
    setMetadata(queries, 'biomarker_cross_file_pass_at', String(indexAt + 500));
    expect(areBiomarkersPending(makeCgLike(queries, db) as never)).toBe(false);
  });

  it('returns pending when the cross-file timestamp predates the current index_timestamp', () => {
    // Index was rebuilt (admin index --force) but the new post-hook
    // hasn't completed yet; the cross-file pass timestamp is stale.
    const oldPass = Date.now() - 5000;
    const newIndex = Date.now();
    setMetadata(queries, 'biomarker_cross_file_pass_at', String(oldPass));
    setMetadata(queries, 'index_timestamp', String(newIndex));
    expect(areBiomarkersPending(makeCgLike(queries, db) as never)).toBe(true);
  });

  it('treats a corrupt non-numeric cross-file timestamp as pending', () => {
    setMetadata(queries, 'index_timestamp', String(Date.now()));
    setMetadata(queries, 'biomarker_cross_file_pass_at', 'not-a-number');
    expect(areBiomarkersPending(makeCgLike(queries, db) as never)).toBe(true);
  });

  it('fails open to not-pending when there is no index_timestamp', () => {
    // A pre-index DB shouldn't pretend the biomarker pass is "pending"
    // when there's no index to compare against. The earliest reasonable
    // signal is the index existing.
    setMetadata(queries, 'biomarker_cross_file_pass_at', String(Date.now()));
    expect(areBiomarkersPending(makeCgLike(queries, db) as never)).toBe(false);
  });
});
