import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolve runtime assets that are copied next to source, dist, or a
 * standalone bundle's `share/cartograph` directory.
 */
export function resolveAssetPath(...relativeParts: string[]): string {
  const relative = path.join(...relativeParts);
  const candidates: string[] = [];

  const explicitRoot = process.env['CARTOGRAPH_ASSET_ROOT'];
  if (explicitRoot) candidates.push(path.join(explicitRoot, relative));

  candidates.push(path.join(import.meta.dirname, relative));
  candidates.push(path.join(import.meta.dirname, '..', relative));
  candidates.push(path.join(import.meta.dirname, '..', 'node_modules', 'web-tree-sitter', relative));

  const execDir = path.dirname(process.execPath);
  candidates.push(path.join(execDir, '..', 'share', 'cartograph', relative));

  const argv0 = process.argv[0] ? path.dirname(process.argv[0]) : '';
  if (argv0) candidates.push(path.join(argv0, '..', 'share', 'cartograph', relative));

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}
