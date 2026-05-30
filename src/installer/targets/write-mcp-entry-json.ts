/**
 * Shared implementation for writing the cartograph MCP-server entry
 * into JSON-shaped agent configs (Claude Code, Cursor).
 *
 * Both agents use a `{mcpServers: {cartograph: {...}}}` wrapper and
 * the same "file-existence → 'created' vs 'updated'" action idiom.
 * The only per-target variation is the path of the config file, which
 * callers supply via `resolvePath`.
 *
 * Codex CLI is intentionally NOT covered here — it uses TOML, a
 * different action idiom (empty-content => 'created'), and takes no
 * location argument. See `codex.ts` for that implementation.
 */

import * as fs from 'node:fs';
import type { Location, WriteResult } from './types.js';
import { getMcpServerConfig, jsonDeepEqual, readJsonFile, writeJsonFile } from './shared.js';

export interface WriteMcpEntryJsonArgs {
  /** Resolve the absolute path to the agent's JSON config file. */
  resolvePath: (loc: Location) => string;
}

/**
 * Write (or no-op) the `mcpServers.cartograph` entry in a
 * JSON-format MCP config file.
 *
 * - Returns `'unchanged'` when the on-disk entry is already
 *   byte-equal to what we'd write — preserves file identity.
 * - Returns `'created'` when the file did not exist before this
 *   write (a pre-existing file whose `cartograph` key was absent
 *   is `'updated'`, not `'created'` — we're patching a file that
 *   was already there).
 * - Returns `'updated'` in all other changed cases.
 */
export function writeMcpEntryJson(loc: Location, args: WriteMcpEntryJsonArgs): WriteResult['files'][number] {
  const file = args.resolvePath(loc);
  const existing = readJsonFile(file);
  const before = existing['mcpServers']?.cartograph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    // Already exactly what we'd write — preserve byte-identical file.
    return { path: file, action: 'unchanged' };
  }

  // 'created' means the file itself did not exist before this write.
  // A pre-existing file containing other MCP servers (no `cartograph`
  // key) is 'updated', not 'created' — we're adding an entry to a
  // file that was already there.
  const action: 'created' | 'updated' = before ? 'updated' : fs.existsSync(file) ? 'updated' : 'created';

  if (!existing['mcpServers']) existing['mcpServers'] = {};
  existing['mcpServers'].cartograph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}
