/**
 * macOS custom-libsqlite3 resilience.
 *
 * Contract: a bad `CARTOGRAPH_BUN_SQLITE_PATH` (or a recorded Homebrew
 * path that exists but cannot be dlopened — e.g. arm64 dylib under a
 * Rosetta x64 process) must NEVER break database opens. The adapter
 * filters non-existent candidates and falls back to the dyld-cache
 * system library when the recorded one fails at the first open. Found
 * by the darwin-x64 release smoke; before the fix any mac without a
 * Homebrew sqlite failed every DB open.
 *
 * darwin-only: the custom-sqlite path is a no-op elsewhere. Runs in
 * its own file so the adapter's module-level once-latch is fresh
 * (`bun test --isolate`), and the env poison is set BEFORE the
 * adapter module loads.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const describeDarwin = process.platform === 'darwin' ? describe : describe.skip;

describeDarwin('bun custom sqlite poisoned-path resilience', () => {
  it('opens the database even when the configured custom sqlite cannot be loaded', async () => {
    // An EXISTING file that is definitely not a loadable dylib: the
    // existence filter passes it through, so the open-time fallback is
    // the layer under test (set-time rejection would equally satisfy
    // the contract — either way the open must succeed).
    process.env['CARTOGRAPH_BUN_SQLITE_PATH'] = path.resolve(import.meta.dirname, '..', 'package.json');
    const { createDatabase } = await import('../src/db/sqlite-adapter.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sqlite-fallback-'));
    try {
      const { db, backend } = createDatabase(path.join(dir, 'fallback.db'));
      expect(backend).toBe('bun-sqlite');
      const row = db.prepare('SELECT 1 AS x').get() as { x: number };
      expect(row.x).toBe(1);
      db.close();
    } finally {
      delete process.env['CARTOGRAPH_BUN_SQLITE_PATH'];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
