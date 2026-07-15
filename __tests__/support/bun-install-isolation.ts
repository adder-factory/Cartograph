import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/**
 * Isolate `$BUN_INSTALL` for the surrounding suite.
 *
 * The doctor's global-link check (src/installer/doctor/global-link.ts)
 * inspects the real Bun global install under `$BUN_INSTALL`. Any test
 * that runs the full `runDoctor()` would otherwise read the HOST
 * machine's `~/.bun` and pick up a broken or healthy `bun link` — a real
 * flake vector on a repo whose own release workflow links from
 * disposable worktrees (issue #68). Pointing `$BUN_INSTALL` at an empty
 * dir makes the check find nothing to inspect (returns null), so
 * project-focused doctor tests stay hermetic regardless of the host.
 *
 * Call once at module or `describe` scope; it registers its own
 * `beforeEach`/`afterEach` and restores the original value afterward.
 */
export function isolateBunInstall(): void {
  const original = process.env['BUN_INSTALL'];
  let dir: string | undefined;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-test-bun-install-'));
    process.env['BUN_INSTALL'] = dir;
  });
  afterEach(async () => {
    if (original === undefined) delete process.env['BUN_INSTALL'];
    else process.env['BUN_INSTALL'] = original;
    if (dir && fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });
}
