import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBunGlobalLink } from '../src/installer/doctor/global-link.js';

const PKG = '@adder-factory/cartograph';

/**
 * Build a temp `$BUN_INSTALL` that mirrors a `bun link` layout:
 *   <root>/bin/cartograph                    -> (relative) the pkg link's bin entry
 *   <root>/install/global/node_modules/<pkg> -> (absolute) the source checkout
 * Returns the roots so a test can remove the checkout to simulate a
 * disposable release worktree being cleaned up.
 */
function makeBunLinkLayout(registerCleanup: (fn: () => void) => void): {
  bunInstall: string;
  checkout: string;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-global-link-'));
  // Register cleanup up front so the temp dir is removed even if a later
  // fs op below throws (e.g. symlink permission restrictions on Windows).
  registerCleanup(() => fs.rmSync(base, { recursive: true, force: true }));
  const bunInstall = path.join(base, '.bun');
  const checkout = path.join(base, 'worktree', 'cartograph');
  fs.mkdirSync(path.join(checkout, 'src', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'src', 'bin', 'cartograph.ts'), '#!/usr/bin/env bun\n');

  const scopeDir = path.join(bunInstall, 'install', 'global', 'node_modules', '@adder-factory');
  fs.mkdirSync(scopeDir, { recursive: true });
  const pkgLink = path.join(bunInstall, 'install', 'global', 'node_modules', PKG);
  fs.symlinkSync(checkout, pkgLink);

  const binDir = path.join(bunInstall, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(
    path.join('..', 'install', 'global', 'node_modules', PKG, 'src', 'bin', 'cartograph.ts'),
    path.join(binDir, 'cartograph'),
  );

  return { bunInstall, checkout };
}

describe('checkBunGlobalLink (issue #68)', () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  it('returns null when there is no Bun global install to inspect', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-no-global-'));
    cleanups.push(() => fs.rmSync(empty, { recursive: true, force: true }));
    expect(checkBunGlobalLink({ bunInstall: path.join(empty, '.bun') })).toBeNull();
  });

  it('reports ok for a healthy bun link', () => {
    const layout = makeBunLinkLayout((fn) => cleanups.push(fn));
    const result = checkBunGlobalLink({ bunInstall: layout.bunInstall });
    expect(result).not.toBeNull();
    expect(result?.id).toBe('bun-global-link');
    expect(result?.status).toBe('ok');
  });

  it('fails when the linked checkout (release worktree) was removed', () => {
    const layout = makeBunLinkLayout((fn) => cleanups.push(fn));
    // Simulate the temporary release worktree being deleted: the symlinks
    // survive but their target is gone.
    fs.rmSync(path.dirname(layout.checkout), { recursive: true, force: true });

    const result = checkBunGlobalLink({ bunInstall: layout.bunInstall });
    expect(result?.id).toBe('bun-global-link');
    expect(result?.status).toBe('fail');
    expect(result?.detail).toContain('broken symlink');
    // Names the removed directory so the fault is not misread as storage/MCP.
    expect(result?.detail).toContain(layout.checkout);
    expect(result?.remediation).toContain('bun link');
    expect(result?.remediation).toContain('temporary release worktree');
  });

  it('fails naming the shim target when only the bin shim dangles', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shim-only-'));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const bunInstall = path.join(base, '.bun');
    const binDir = path.join(bunInstall, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const removed = path.join(base, 'gone', 'cartograph', 'src', 'bin', 'cartograph.ts');
    fs.symlinkSync(removed, path.join(binDir, 'cartograph')); // absolute target that never existed

    const result = checkBunGlobalLink({ bunInstall });
    expect(result?.status).toBe('fail');
    expect(result?.detail).toContain(removed);
  });

  it('reports ok when the package link is healthy but the bin shim is absent (narrow scope)', () => {
    // A one-sided state is intentionally NOT flagged: Bun's global bin dir
    // is user-configurable, so a missing `<root>/bin/cartograph` alone is
    // not proof of a broken install.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pkg-only-'));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const bunInstall = path.join(base, '.bun');
    const pkgDir = path.join(bunInstall, 'install', 'global', 'node_modules', PKG);
    fs.mkdirSync(pkgDir, { recursive: true }); // real dir, no bin shim
    const result = checkBunGlobalLink({ bunInstall });
    expect(result?.status).toBe('ok');
  });

  it('reports ok for a re-pinned install where the package link is a real directory', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repin-'));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const bunInstall = path.join(base, '.bun');
    // `bun add -g <tag>` materializes the package as a real directory (not a
    // symlink to a checkout), so removing a worktree cannot dangle it.
    const pkgDir = path.join(bunInstall, 'install', 'global', 'node_modules', PKG, 'src', 'bin');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'cartograph.ts'), '#!/usr/bin/env bun\n');
    const binDir = path.join(bunInstall, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(
      path.join('..', 'install', 'global', 'node_modules', PKG, 'src', 'bin', 'cartograph.ts'),
      path.join(binDir, 'cartograph'),
    );

    const result = checkBunGlobalLink({ bunInstall });
    expect(result?.status).toBe('ok');
  });
});
