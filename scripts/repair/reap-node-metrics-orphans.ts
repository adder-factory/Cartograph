/**
 * One-off repair: delete orphan rows from `node_metrics` whose
 * `node_id` no longer points at any row in `nodes`.
 *
 * Background. Migration 054 (`054-strict-tables.ts`) toggles
 * `PRAGMA foreign_keys = OFF` for the duration of its STRICT
 * rebuild. Before migration 057's silent-swallow fix landed, a
 * mid-rebuild failure could leave the DB in a state where some
 * `nodes` rows were dropped but the dependent `node_metrics`
 * rows weren't cascade-deleted. The 2026-05-11 schema audit's
 * `F2` finding measured 95 orphans on the affected live DB.
 *
 * NOT a migration. Orphans do not re-form on healthy code paths
 * after migration 057's mig-054 rethrow + post-migration
 * integrity gate (which together prevent the silent-drop class
 * of bug from recurring). This is a one-shot cleanup; rerunning
 * it after the orphans are gone is a safe no-op.
 *
 * Usage:
 *   bun scripts/repair/reap-node-metrics-orphans.ts [dbPath]
 *
 * `dbPath` defaults to `./.cartograph/cartograph.db` in the cwd.
 * Honors the MCP server's WAL mode + busy_timeout, so running
 * this against a live DB with the MCP attached is safe — the
 * write will queue behind any in-flight reader.
 */
import * as path from 'node:path';
import { createDatabase } from '../../src/db/sqlite-adapter.js';

const dbPath = path.resolve(process.argv[2] ?? path.join('.cartograph', 'cartograph.db'));
const { db } = createDatabase(dbPath);
db.pragma('busy_timeout = 120000');

const before = db
  .prepare(
    `SELECT COUNT(*) AS n FROM node_metrics nm
     LEFT JOIN nodes n ON n.id = nm.node_id
     WHERE n.id IS NULL`,
  )
  .get() as { n: number };

if (before.n === 0) {
  console.log(`[reap] node_metrics already clean (0 orphans at ${dbPath})`);
  db.close();
  process.exit(0);
}

const result = db.prepare(`DELETE FROM node_metrics WHERE node_id NOT IN (SELECT id FROM nodes)`).run();

const after = db
  .prepare(
    `SELECT COUNT(*) AS n FROM node_metrics nm
     LEFT JOIN nodes n ON n.id = nm.node_id
     WHERE n.id IS NULL`,
  )
  .get() as { n: number };

console.log(`[reap] orphans before: ${before.n}, deleted: ${result.changes}, after: ${after.n}`);
db.close();
if (after.n !== 0) {
  console.error(`[reap] WARNING: ${after.n} orphans remain — investigate FK cascade state`);
  process.exit(1);
}
