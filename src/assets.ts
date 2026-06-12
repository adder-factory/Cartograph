import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

/**
 * Locate an asset that ships inside the `web-tree-sitter` dependency
 * via MODULE RESOLUTION rather than path guessing. Install-from-git
 * global installs hoist dependencies to the package manager's global
 * root, where none of the static sibling-directory guesses below ever
 * look — the wasm then "doesn't exist" and the first index aborts
 * (field report #2, install trap 1). The resolver finds the hoisted
 * copy wherever it landed. Returns null when the dependency itself
 * is absent (standalone bundles — the share/ candidates cover those).
 */
export function resolveWebTreeSitterAsset(relative: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('web-tree-sitter');
    const candidate = path.join(path.dirname(entry), relative);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Resolve runtime assets that are copied next to source, dist, or a
 * standalone bundle's `share/cartograph` directory.
 */
export function resolveAssetPath(...relativeParts: string[]): string {
  const relative = path.join(...relativeParts);
  const explicitRoot = process.env['CARTOGRAPH_ASSET_ROOT'];
  const execDir = path.dirname(process.execPath);
  const argv0 = process.argv[0] ? path.dirname(process.argv[0]) : '';
  const candidates = [
    ...(explicitRoot ? [path.join(explicitRoot, relative)] : []),
    path.join(import.meta.dirname, relative),
    path.join(import.meta.dirname, '..', relative),
    path.join(import.meta.dirname, '..', '..', relative),
    path.join(import.meta.dirname, '..', '..', '..', relative),
    path.join(import.meta.dirname, '..', 'node_modules', 'web-tree-sitter', relative),
    path.join(execDir, '..', 'share', 'cartograph', relative),
    ...(argv0 ? [path.join(argv0, '..', 'share', 'cartograph', relative)] : []),
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  if (relative === 'web-tree-sitter.wasm') {
    const resolved = resolveWebTreeSitterAsset(relative);
    if (resolved) return resolved;
  }
  return candidates[0]!;
}
