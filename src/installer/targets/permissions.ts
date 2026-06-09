import * as fs from 'node:fs';
import type { WriteResult } from './types.js';
import { jsonDeepEqual, readJsonFile, writeJsonFile } from './file-writes.js';

/**
 * Permissions list for Claude `settings.json`. Other targets that
 * have a permissions concept can compose this list directly. The
 * permission strings follow Claude's `mcp__<server>__<tool>` format.
 */
export function getCartographPermissions(): string[] {
  return [
    'mcp__cartograph__cartograph_find',
    'mcp__cartograph__cartograph_context',
    'mcp__cartograph__cartograph_graph',
    'mcp__cartograph__cartograph_node',
    'mcp__cartograph__cartograph_files',
    'mcp__cartograph__cartograph_at_range',
    'mcp__cartograph__cartograph_status',
  ];
}

export function writePermissionsAllowList(filePath: string): WriteResult['files'][number] {
  const settings = readJsonFile(filePath);
  const created = !fs.existsSync(filePath);

  if (!settings['permissions']) settings['permissions'] = {};
  if (!Array.isArray(settings['permissions'].allow)) settings['permissions'].allow = [];

  const before = [...settings['permissions'].allow];
  for (const permission of getCartographPermissions()) {
    if (!settings['permissions'].allow.includes(permission)) {
      settings['permissions'].allow.push(permission);
    }
  }

  if (jsonDeepEqual(before, settings['permissions'].allow) && !created) {
    return { path: filePath, action: 'unchanged' };
  }

  writeJsonFile(filePath, settings);
  return { path: filePath, action: created ? 'created' : 'updated' };
}
