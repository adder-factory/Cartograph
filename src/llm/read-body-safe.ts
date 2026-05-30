import * as fs from 'node:fs';
import type { Node } from '../types.js';
import { validatePathWithinRootReal } from '../utils.js';

/**
 * Read the source lines for `node` from disk, bounded to `maxBodyChars`
 * characters. Returns an empty string when the path escapes the project
 * root or the file cannot be read.
 *
 * Callers supply `maxBodyChars` because different consumers have different
 * budget constraints (e.g. agent-bridge uses 4000, ask uses 1800).
 */
export function readBodySafe(projectRoot: string, node: Node, maxBodyChars: number): string {
  const safe = validatePathWithinRootReal(projectRoot, node.filePath);
  if (!safe) return '';
  try {
    const lines = fs.readFileSync(safe, 'utf-8').split('\n');
    const slice = lines.slice(Math.max(0, node.startLine - 1), node.endLine).join('\n');
    if (slice.length > maxBodyChars) {
      return slice.slice(0, maxBodyChars) + '\n// ... (truncated)';
    }
    return slice;
  } catch {
    return '';
  }
}
