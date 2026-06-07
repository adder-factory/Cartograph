import * as fsp from 'node:fs/promises';
import type { Node } from '../types.js';
import { logDebug } from '../errors.js';
import { validatePathWithinRootReal } from '../utils.js';

/**
 * Extract code from a node's source file.
 * Symlink-aware: validates the path is still within the project root.
 */
export async function extractNodeSourceCode(projectRoot: string, node: Node): Promise<string | null> {
  const filePath = validatePathWithinRootReal(projectRoot, node.filePath);
  if (!filePath) return null;
  const exists = await fsp.access(filePath).then(
    () => true,
    () => false,
  );
  if (!exists) return null;
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const startIdx = Math.max(0, node.startLine - 1);
    const endIdx = Math.min(lines.length, node.endLine);
    return lines.slice(startIdx, endIdx).join('\n');
  } catch (error) {
    logDebug('Failed to extract code from node', { nodeId: node.id, filePath: node.filePath, error: String(error) });
    return null;
  }
}
