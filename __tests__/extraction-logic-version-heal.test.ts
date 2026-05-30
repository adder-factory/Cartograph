/**
 * Friction #66 — extraction-logic-version self-heal.
 *
 * The bug: extractor logic upgrades silently leave previously-extracted
 * file states stale. Files whose `content_hash` hasn't changed survive
 * every sync with the OLD extractor's edges. Repro on this codebase
 * 2026-05-09: 26 of 26 `unused_export` info findings were stale-
 * extraction FPs, all of which evaporated after a forced full
 * re-extraction.
 *
 * The fix: a versioned self-heal pattern (see
 * `src/extraction/extraction-logic-version.ts`). When the binary's
 * `EXTRACTION_LOGIC_VERSION` is newer than the stored value:
 *   1. Set `needs_reextract = 1` on every `files` row so the next
 *      sync re-extracts each file even when content_hash still
 *      matches disk (Phase 1 / friction F4 — preserves content_hash
 *      so stale-artifact queries don't spuriously report 100%).
 *   2. Wipe the parse_cache so the re-extraction doesn't pull a
 *      stale `ExtractionResult` from the cache.
 *   3. Persist the new version so the heal runs at most once per
 *      bump.
 *
 * These tests exercise the helper directly — both the version
 * arithmetic and the SQL side effects — without needing a full
 * indexAll round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import {
  EXTRACTION_LOGIC_VERSION,
  applyExtractionLogicVersionHeal,
  getStoredExtractionLogicVersion,
  isExtractionLogicVersionStale,
  setStoredExtractionLogicVersion,
} from '../src/extraction/extraction-logic-version.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('extraction-logic-version self-heal (#66)', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extraction-version-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function alpha(){return 1;}\n`);
    fs.writeFileSync(
      path.join(testDir, 'src', 'b.ts'),
      `import { alpha } from './a.js';\nexport function beta(){return alpha();}\n`,
    );
    fs.writeFileSync(path.join(testDir, '.gitignore'), '.cartograph/\n');
    git(testDir, 'init', '-q');
    git(testDir, 'config', 'user.email', 't@t');
    git(testDir, 'config', 'user.name', 't');
    git(testDir, 'config', 'commit.gpgsign', 'false');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('persists the current version after the first indexAll', () => {
    const stored = getStoredExtractionLogicVersion(cg.queries);
    expect(stored).toBe(EXTRACTION_LOGIC_VERSION);
    expect(isExtractionLogicVersionStale(cg.queries)).toBe(false);
  });

  it('returns empty string when the version key is absent (fresh project / pre-self-heal)', () => {
    cg.queries.db.prepare("DELETE FROM project_metadata WHERE key = 'extraction_logic_version'").run();
    expect(getStoredExtractionLogicVersion(cg.queries)).toBe('');
    // Empty stored never matches a real source hash → always stale.
    expect(isExtractionLogicVersionStale(cg.queries)).toBe(true);
  });

  it('treats any non-matching stored value as stale (defends against corruption)', () => {
    cg.queries.db
      .prepare("UPDATE project_metadata SET value = 'not-a-real-hash' WHERE key = 'extraction_logic_version'")
      .run();
    expect(getStoredExtractionLogicVersion(cg.queries)).toBe('not-a-real-hash');
    expect(isExtractionLogicVersionStale(cg.queries)).toBe(true);
  });

  it('heal fires when the stored version differs from the binary', () => {
    setStoredExtractionLogicVersion(cg.queries, 'older-hash-value');
    expect(isExtractionLogicVersionStale(cg.queries)).toBe(true);

    const ran = applyExtractionLogicVersionHeal(cg.queries);
    expect(ran).toBe(true);

    // The new version is persisted.
    expect(getStoredExtractionLogicVersion(cg.queries)).toBe(EXTRACTION_LOGIC_VERSION);
    expect(isExtractionLogicVersionStale(cg.queries)).toBe(false);
  });

  it('heal sets needs_reextract=1 on every files row WITHOUT touching content_hash (Phase 1)', () => {
    // Sanity: post-indexAll hashes are non-empty and the flag is unset.
    const before = cg.queries.db.prepare('SELECT path, content_hash, needs_reextract FROM files').all() as Array<{
      path: string;
      content_hash: string;
      needs_reextract: number;
    }>;
    expect(before.length).toBeGreaterThanOrEqual(2);
    for (const f of before) {
      expect(f.content_hash).not.toBe('');
      expect(f.needs_reextract).toBe(0);
    }

    setStoredExtractionLogicVersion(cg.queries, 'older-hash-value');
    applyExtractionLogicVersionHeal(cg.queries);

    const after = cg.queries.db.prepare('SELECT path, content_hash, needs_reextract FROM files').all() as Array<{
      path: string;
      content_hash: string;
      needs_reextract: number;
    }>;
    expect(after.length).toBe(before.length);
    const beforeByPath = new Map(before.map((f) => [f.path, f.content_hash]));
    for (const f of after) {
      // content_hash is preserved (staleness-redesign Phase 1 stops the
      // 100% inflated stale-artifact display).
      expect(f.content_hash).toBe(beforeByPath.get(f.path));
      // needs_reextract = 1 carries the "force re-extract" signal.
      expect(f.needs_reextract).toBe(1);
    }
  });

  it('heal wipes parse_cache so re-extraction picks up fresh logic', () => {
    // Seed a parse_cache row to verify the wipe.
    cg.queries.db
      .prepare(
        'INSERT INTO parse_cache (content_hash, language, file_path, payload, generated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('test-hash-66', 'typescript', 'src/a-66.ts', '{"_v":2,"result":{}}', Date.now());
    const before = cg.queries.db.prepare('SELECT COUNT(*) AS c FROM parse_cache').get() as { c: number };
    expect(before.c).toBeGreaterThan(0);

    setStoredExtractionLogicVersion(cg.queries, 'older-hash-value');
    applyExtractionLogicVersionHeal(cg.queries);

    const after = cg.queries.db.prepare('SELECT COUNT(*) AS c FROM parse_cache').get() as { c: number };
    expect(after.c).toBe(0);
  });

  it('heal is idempotent — second call is a no-op', () => {
    setStoredExtractionLogicVersion(cg.queries, 'older-hash-value');
    expect(applyExtractionLogicVersionHeal(cg.queries)).toBe(true);

    // Clear the flag so we can detect whether the second call sets it again.
    cg.queries.db.prepare("UPDATE files SET needs_reextract = 0 WHERE path = 'src/a.ts'").run();

    expect(applyExtractionLogicVersionHeal(cg.queries)).toBe(false);

    const row = cg.queries.db.prepare("SELECT needs_reextract FROM files WHERE path = 'src/a.ts'").get() as {
      needs_reextract: number;
    };
    // Flag stayed 0 because the heal short-circuited on the version match.
    expect(row.needs_reextract).toBe(0);
  });

  it('heal does NOT fire when the stored version equals the current', () => {
    expect(isExtractionLogicVersionStale(cg.queries)).toBe(false);
    expect(applyExtractionLogicVersionHeal(cg.queries)).toBe(false);
  });

  it('sync re-extracts heal-flagged files on the git fast-path (FRICTION-AE)', async () => {
    // Regression: the sync git fast-path (`eoApplySyncedGitChanges`)
    // only iterates files git reports as changed. A heal-flagged file
    // whose disk content is unmoved is NOT in `git status`, so before
    // the fix it never reached `eoQueueIfChanged` — `admin sync`
    // reported "0 files" forever while `cartograph_status` kept
    // recommending a sync. Friction #22 (2026-05-11) fixed the same
    // gap in `getChangedFiles` (the status probe) but not in `sync`.
    const paths = (cg.queries.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((r) => r.path);
    expect(paths.length).toBeGreaterThanOrEqual(2);

    // Simulate the post-heal state: flag every file, leave disk alone.
    cg.queries.db.prepare('UPDATE files SET needs_reextract = 1').run();

    const result = await cg.sync();

    // The heal-flagged files were re-extracted even though git sees no
    // working-tree change.
    expect(result.filesModified ?? 0).toBeGreaterThanOrEqual(paths.length);
    const stillFlagged = cg.queries.db.prepare('SELECT COUNT(*) AS c FROM files WHERE needs_reextract = 1').get() as {
      c: number;
    };
    expect(stillFlagged.c).toBe(0);
  });

  it('heal is safe on an empty files table (fresh init pre-extraction)', () => {
    // Drop every files row to simulate a project where init ran but
    // indexAll has never happened — the version key may be absent and
    // the UPDATE / DELETE wipes hit empty tables.
    cg.queries.db.prepare('DELETE FROM files').run();
    cg.queries.db.prepare("DELETE FROM project_metadata WHERE key = 'extraction_logic_version'").run();

    expect(isExtractionLogicVersionStale(cg.queries)).toBe(true);
    expect(() => applyExtractionLogicVersionHeal(cg.queries)).not.toThrow();
    expect(getStoredExtractionLogicVersion(cg.queries)).toBe(EXTRACTION_LOGIC_VERSION);
  });
});
