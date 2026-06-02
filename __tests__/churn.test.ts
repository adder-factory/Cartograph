import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mineChurn,
  readFileLoc,
  MAX_FILES_PER_COMMIT,
  LAST_MINED_CHURN_HEAD_KEY,
  CHURN_ALGO_VERSION,
  LAST_MINED_CHURN_ALGO_VERSION_KEY,
} from '../src/churn/index.js';
import { getCurrentHeadSha as getGitHead } from '../src/git-utils.js';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder, qbTransaction } from '../src/db/queries.js';
import { applyChurnDeltas } from '../src/db/queries-history.js';
import { upsertFile, getFileByPath, removeFileFromIndex, removeFileFromIndexInTx } from '../src/db/queries-files.js';
import { getMetadata, setMetadata } from '../src/db/queries-metadata.js';
import { HOOK as ChurnHook } from '../src/index-hooks/churn.js';

let HAS_GIT = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  HAS_GIT = false;
}

let tempDir: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: tempDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE,
      GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commitAt(date: string, paths: string[], content?: string) {
  for (const p of paths) {
    const abs = path.join(tempDir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content ?? `data for ${p} at ${date}\n`);
  }
  git('add', ...paths);
  // Pin both author and committer dates so timestamps are deterministic.
  process.env.GIT_AUTHOR_DATE = date;
  process.env.GIT_COMMITTER_DATE = date;
  git('commit', '-m', `commit at ${date}`);
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
}

function setupChurnHookDb(): { db: DatabaseConnection; q: QueryBuilder } {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-churn-hook-'));
  const db = DatabaseConnection.initialize(path.join(dbDir, 'test.db'));
  const q = new QueryBuilder(db.getDb());
  // Match files in tempDir's git history.
  db.getDb()
    .prepare(
      `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES (?, '', 'typescript', 0, 0, 0)`,
    )
    .run('a.ts');
  return { db, q };
}

function setupReextractDb(): { db: DatabaseConnection; q: QueryBuilder } {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-churn-reextract-'));
  const db = DatabaseConnection.initialize(path.join(dbDir, 'test.db'));
  const q = new QueryBuilder(db.getDb());
  return { db, q };
}

function seedReextractFile(q: QueryBuilder, p: string): void {
  upsertFile(q, {
    path: p,
    contentHash: 'hash-v1',
    language: 'typescript',
    size: 10,
    modifiedAt: 1,
    indexedAt: 1,
    nodeCount: 0,
  });
}

function getCommitCount(db: DatabaseConnection, filePath: string): number {
  const row = db.getDb().prepare('SELECT commit_count FROM files WHERE path=?').get(filePath) as
    | { commit_count: number }
    | undefined;
  if (!row) throw new Error(`missing file row: ${filePath}`);
  return row.commit_count;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-churn-'));
  if (HAS_GIT) {
    git('init', '-q', '-b', 'main');
    git('config', 'commit.gpgsign', 'false');
  }
});

afterEach(() => {
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_GIT)('mineChurn', () => {
  it('returns empty + null head when not in a git repo', async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nogit-'));
    try {
      const r = await mineChurn(nonGit, new Set(['foo.ts']), null);
      expect(r.currentHead).toBeNull();
      expect(r.deltas.size).toBe(0);
      expect(r.needsFullRescan).toBe(false);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('counts commits per indexed file, ignores files not in index', async () => {
    commitAt('2025-01-01T00:00:00', ['a.ts', 'b.ts']);
    commitAt('2025-01-02T00:00:00', ['a.ts']);
    commitAt('2025-01-03T00:00:00', ['a.ts', 'b.ts', 'c.ts']);

    const r = await mineChurn(tempDir, new Set(['a.ts', 'b.ts']), null);
    expect(r.deltas.get('a.ts')?.commitCountDelta).toBe(3);
    expect(r.deltas.get('b.ts')?.commitCountDelta).toBe(2);
    expect(r.deltas.has('c.ts')).toBe(false);
  });

  it('records first-seen / last-touched as min/max of commit timestamps', async () => {
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    commitAt('2025-06-01T00:00:00Z', ['a.ts']);
    commitAt('2025-12-01T00:00:00Z', ['a.ts']);

    const r = await mineChurn(tempDir, new Set(['a.ts']), null);
    const d = r.deltas.get('a.ts')!;
    // 2025-01-01 UTC = 1735689600
    expect(d.firstSeenTs).toBe(1735689600);
    // 2025-12-01 UTC = 1764547200
    expect(d.lastTouchedTs).toBe(1764547200);
  });

  it('skips commits touching more than MAX_FILES_PER_COMMIT files', async () => {
    const bigBatch: string[] = [];
    for (let i = 0; i < MAX_FILES_PER_COMMIT + 1; i++) bigBatch.push(`f${i}.ts`);
    commitAt('2025-01-01T00:00:00Z', bigBatch);
    // Then a normal commit on one of the same files.
    commitAt('2025-02-01T00:00:00Z', ['f0.ts']);

    const r = await mineChurn(tempDir, new Set(bigBatch), null);
    // First commit was skipped; only the second one should count.
    expect(r.deltas.get('f0.ts')?.commitCountDelta).toBe(1);
    // Files only seen in the skipped commit produce no delta at all.
    expect(r.deltas.has('f50.ts')).toBe(false);
  });

  it('counts commits whose raw file count exceeds the cap when the indexed-file count does not', async () => {
    // Mimics the real-world coupling case: a single commit ships a
    // small source change (`a.ts`, `b.ts`) plus a 60-file lockfile or
    // dist bump (`vendor/v0..v59.ts`). Indexed set only has the two
    // source files, so the gate must be applied to the post-filter
    // count — not the raw 62-path list git emits.
    const indexed = new Set(['a.ts', 'b.ts']);
    const noisy: string[] = ['a.ts', 'b.ts'];
    for (let i = 0; i < MAX_FILES_PER_COMMIT + 10; i++) noisy.push(`vendor/v${i}.ts`);
    commitAt('2025-01-01T00:00:00Z', noisy);

    const r = await mineChurn(tempDir, indexed, null);
    expect(r.deltas.get('a.ts')?.commitCountDelta).toBe(1);
    expect(r.deltas.get('b.ts')?.commitCountDelta).toBe(1);
    // Vendor paths weren't in the indexed set, so no delta for them.
    expect(r.deltas.has('vendor/v0.ts')).toBe(false);
  });

  it('incremental mining returns only commits since the given sha', async () => {
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    const sha1 = getGitHead(tempDir)!;
    commitAt('2025-01-02T00:00:00Z', ['a.ts']);
    commitAt('2025-01-03T00:00:00Z', ['a.ts']);

    const incr = await mineChurn(tempDir, new Set(['a.ts']), sha1);
    // Only the two commits *after* sha1 should be counted.
    expect(incr.deltas.get('a.ts')?.commitCountDelta).toBe(2);
    expect(incr.needsFullRescan).toBe(false);
  });

  it('returns needsFullRescan=true when sinceSha is unreachable', async () => {
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    const fakeSha = '0'.repeat(40);
    const r = await mineChurn(tempDir, new Set(['a.ts']), fakeSha);
    expect(r.needsFullRescan).toBe(true);
    expect(r.deltas.size).toBe(0);
    expect(r.currentHead).not.toBeNull();
  });

  it('returns empty deltas when sinceSha equals current head (no-op)', async () => {
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    const head = getGitHead(tempDir)!;
    const r = await mineChurn(tempDir, new Set(['a.ts']), head);
    expect(r.currentHead).toBe(head);
    expect(r.deltas.size).toBe(0);
    expect(r.needsFullRescan).toBe(false);
  });

  it('handles paths with spaces and unicode safely (NUL-delimited)', async () => {
    commitAt('2025-01-01T00:00:00Z', ['name with space.ts']);
    commitAt('2025-01-02T00:00:00Z', ['ünïcødë.ts']);

    const r = await mineChurn(tempDir, new Set(['name with space.ts', 'ünïcødë.ts']), null);
    expect(r.deltas.get('name with space.ts')?.commitCountDelta).toBe(1);
    expect(r.deltas.get('ünïcødë.ts')?.commitCountDelta).toBe(1);
  });

  it('LAST_MINED_CHURN_HEAD_KEY is stable (used as project_metadata key)', () => {
    expect(LAST_MINED_CHURN_HEAD_KEY).toBe('last_mined_churn_head');
  });

  it('CHURN_ALGO_VERSION is a source-derived algo-hash, not a hand-bumped literal', () => {
    // Migrated to computeAlgoHash 2026-05-15 — must be a 16-hex sha, not '2'.
    expect(CHURN_ALGO_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('readFileLoc', () => {
  it('returns 0 for an empty file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-loc-'));
    try {
      const f = path.join(dir, 'empty.txt');
      fs.writeFileSync(f, '');
      expect(readFileLoc(dir, 'empty.txt')).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts newline-terminated lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-loc-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.txt'), 'a\nb\nc\n');
      expect(readFileLoc(dir, 'x.txt')).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a final no-newline chunk as one extra line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-loc-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.txt'), 'a\nb\nc');
      expect(readFileLoc(dir, 'x.txt')).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 0 for a missing file (does not throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-loc-'));
    try {
      expect(readFileLoc(dir, 'no-such-file.txt')).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAS_GIT)('churn hook self-heal on algo-version mismatch', () => {
  it('forces a full rescan when the stored algo version is stale', async () => {
    // Seed a 2-commit history; current algo would record commit_count=2.
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    commitAt('2025-02-01T00:00:00Z', ['a.ts']);

    const { db, q } = setupChurnHookDb();
    try {
      // Simulate pre-fix state with an older stamped version.
      applyChurnDeltas(q, [{ path: 'a.ts', commitCountDelta: 99, lastTouchedTs: 0, firstSeenTs: 0 }]);
      setMetadata(q, LAST_MINED_CHURN_HEAD_KEY, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      setMetadata(q, LAST_MINED_CHURN_ALGO_VERSION_KEY, '0'); // mismatch

      const ctx: any = {
        projectRoot: tempDir,
        config: {},
        queries: q,
        db,
      };
      await ChurnHook.afterSync!(ctx, {
        filesChecked: 0,
        filesAdded: 0,
        filesModified: 0,
        filesRemoved: 0,
        nodesUpdated: 0,
        durationMs: 0,
      });

      expect(getCommitCount(db, 'a.ts')).toBe(2);
      expect(getMetadata(q, LAST_MINED_CHURN_ALGO_VERSION_KEY)).toBe(CHURN_ALGO_VERSION);
    } finally {
      db.close();
    }
  });

  it('forces a full rescan when the algo version key is absent (pre-fix install path)', async () => {
    // Mirrors the most common upgrade scenario: a user pulls the
    // bugfix release without ever running `cartograph index`. Pre-fix
    // never stamped LAST_MINED_CHURN_ALGO_VERSION_KEY at all.
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    commitAt('2025-02-01T00:00:00Z', ['a.ts']);

    const { db, q } = setupChurnHookDb();
    try {
      applyChurnDeltas(q, [{ path: 'a.ts', commitCountDelta: 99, lastTouchedTs: 0, firstSeenTs: 0 }]);
      setMetadata(q, LAST_MINED_CHURN_HEAD_KEY, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      // Note: NO LAST_MINED_CHURN_ALGO_VERSION_KEY. getMetadata
      // returns null/undefined; mismatch logic must still fire.

      const ctx: any = {
        projectRoot: tempDir,
        config: {},
        queries: q,
        db,
      };
      await ChurnHook.afterSync!(ctx, {
        filesChecked: 0,
        filesAdded: 0,
        filesModified: 0,
        filesRemoved: 0,
        nodesUpdated: 0,
        durationMs: 0,
      });

      expect(getCommitCount(db, 'a.ts')).toBe(2);
      expect(getMetadata(q, LAST_MINED_CHURN_ALGO_VERSION_KEY)).toBe(CHURN_ALGO_VERSION);
    } finally {
      db.close();
    }
  });

  it('stays incremental when the stored algo version matches', async () => {
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    const headBeforeNewCommit = git('rev-parse', 'HEAD');
    commitAt('2025-02-01T00:00:00Z', ['a.ts']);

    const { db, q } = setupChurnHookDb();
    try {
      // Seed: stamped at the current algo version, with the
      // last-mined head pointing to commit 1. Pretend incremental
      // mining from the prior state has already counted that commit.
      applyChurnDeltas(q, [{ path: 'a.ts', commitCountDelta: 1, lastTouchedTs: 0, firstSeenTs: 0 }]);
      setMetadata(q, LAST_MINED_CHURN_HEAD_KEY, headBeforeNewCommit);
      setMetadata(q, LAST_MINED_CHURN_ALGO_VERSION_KEY, CHURN_ALGO_VERSION);

      const ctx: any = {
        projectRoot: tempDir,
        config: {},
        queries: q,
        db,
      };
      await ChurnHook.afterSync!(ctx, {
        filesChecked: 0,
        filesAdded: 1,
        filesModified: 0,
        filesRemoved: 0,
        nodesUpdated: 0,
        durationMs: 0,
      });

      // Incremental should add the 1 new commit on top of the seeded 1
      // — total 2, NOT a full rescan that would also see the seeded
      // 1 plus the 2 actual commits.
      expect(getCommitCount(db, 'a.ts')).toBe(2);
    } finally {
      db.close();
    }
  });
});

/**
 * Regression: re-extracting a file during `sync` must NOT wipe its
 * mined churn columns.
 *
 * The sync re-extract path (`extraction-phases.ts`) evicts a changed
 * file's prior extraction then re-`upsertFile`s the same path. Pre-fix
 * the evict (`removeFileFromIndexInTx`) deleted the whole `files` row,
 * so the follow-up upsert took its INSERT branch — where the
 * churn-managed columns (`commit_count` / `first_seen_ts` /
 * `last_touched_ts`) fall back to their schema defaults. Every sync
 * that touched a file therefore reset that file's churn to 0; over a
 * long-lived index every file decayed to 0 and `hotspots` went
 * permanently empty. The fix: the re-extract evict deletes only the
 * file's nodes, leaving the row for the upsert's ON CONFLICT UPDATE
 * branch (which deliberately preserves churn). A genuine removal
 * (`removeFileFromIndex`) still drops the row.
 */
describe('re-extract evict preserves mined churn columns', () => {
  it('keeps commit_count / first_seen_ts / last_touched_ts across removeFileFromIndexInTx + upsertFile', () => {
    const { db, q } = setupReextractDb();
    try {
      seedReextractFile(q, 'a.ts');
      // Mining persisted real churn for the file.
      applyChurnDeltas(q, [{ path: 'a.ts', commitCountDelta: 7, lastTouchedTs: 1764547200, firstSeenTs: 1735689600 }]);

      // Simulate the sync re-extract path: evict the prior extraction,
      // then re-upsert the same path with a fresh (post-edit) record.
      qbTransaction(q, () => {
        removeFileFromIndexInTx(q, 'a.ts');
        upsertFile(q, {
          path: 'a.ts',
          contentHash: 'hash-v2',
          language: 'typescript',
          size: 20,
          modifiedAt: 2,
          indexedAt: 2,
          nodeCount: 3,
        });
      });

      const after = getFileByPath(q, 'a.ts');
      expect(after).not.toBeNull();
      // Non-churn columns reflect the re-extraction.
      expect(after!.contentHash).toBe('hash-v2');
      expect(after!.nodeCount).toBe(3);
      // Churn columns survive untouched.
      expect(after!.commitCount).toBe(7);
      expect(after!.firstSeenTs).toBe(1735689600);
      expect(after!.lastTouchedTs).toBe(1764547200);
    } finally {
      db.close();
    }
  });

  it('removeFileFromIndex still fully drops the files row (genuine removal)', () => {
    const { db, q } = setupReextractDb();
    try {
      seedReextractFile(q, 'gone.ts');
      applyChurnDeltas(q, [
        { path: 'gone.ts', commitCountDelta: 3, lastTouchedTs: 1764547200, firstSeenTs: 1735689600 },
      ]);

      removeFileFromIndex(q, 'gone.ts');

      expect(getFileByPath(q, 'gone.ts')).toBeNull();
    } finally {
      db.close();
    }
  });
});
