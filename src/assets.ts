import * as fs from 'node:fs';
import * as path from 'node:path';

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
    path.join(import.meta.dirname, '..', 'node_modules', 'web-tree-sitter', relative),
    path.join(execDir, '..', 'share', 'cartograph', relative),
    ...(argv0 ? [path.join(argv0, '..', 'share', 'cartograph', relative)] : []),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}
