#!/usr/bin/env node
/**
 * Cartograph preuninstall cleanup script
 *
 * Loops over every known agent target's `uninstall(loc)` for the global
 * location only — local-location entries live inside project working
 * trees and aren't ours to nuke.
 *
 * NOTE: npm v7+ and bun do NOT run `(pre|post)uninstall` lifecycle
 * scripts, so the `preuninstall` package.json hook does not fire on a
 * modern `npm uninstall -g` / `bun remove`. Invoke this explicitly from
 * the source uninstall path (`install.sh --uninstall`) so global agent
 * MCP entries are actually removed.
 *
 * This script must never throw — a failed cleanup must not block
 * uninstall.
 */

try {
  // Dynamic import so any module-level error in the registry can't
  // bubble out and abort the npm uninstall.
  const { ALL_TARGETS } = await import('../installer/targets/registry.js');

  for (const target of ALL_TARGETS) {
    if (!target.supportsLocation('global')) continue;
    try {
      target.uninstall('global');
    } catch {
      // Each target is independently safe-to-skip; per-target failure
      // must not stop the loop.
    }
  }
} catch {
  // If the registry itself can't be loaded (e.g. partial install),
  // we silently skip cleanup. Uninstall still completes.
}
