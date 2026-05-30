#!/usr/bin/env node
/**
 * Cartograph preuninstall cleanup script
 *
 * Runs automatically when `npm uninstall -g @adder-factory/cartograph`
 * is called. Loops over every known agent target's `uninstall(loc)`
 * for the global location only — local-location entries live inside
 * project working trees and aren't ours to nuke at npm-uninstall
 * time.
 *
 * This script must never throw — a failed cleanup must not block
 * uninstall.
 */

// `void` is the explicit "I know this returns a Promise; intentionally
// fire-and-forget" idiom. The IIFE body has its own try/catch so an
// inner failure can't leak — but the rejection-IF-the-try-catch-itself-
// throws (e.g. import() rejecting before the try runs) would otherwise
// be a silent floating Promise.
void (async () => {
  try {
    // Dynamic import so any module-level error in the registry can't
    // bubble out and abort the npm uninstall. Wrapped in an async IIFE
    // because top-level await needs ES2022 module resolution which the
    // CLI scripts don't always have at the top level.
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
})();
