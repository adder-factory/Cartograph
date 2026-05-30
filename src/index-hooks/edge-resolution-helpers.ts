/**
 * Shared helpers used by both `dynamic-import-edges.ts` and
 * `re-export-edges.ts`. Extracted from the two files to eliminate
 * exact clones (`collectTargets`, `lookupSymbolByNameInFile`,
 * `resolveTargetFile`, `existsAsFile`, `FileTarget`, `MODULE_EXTENSIONS`,
 * `refreshEdgesHook`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IndexHookContext } from './types.js';
import { getAllFiles, getFileByPath } from '../db/queries-files.js';
import { getNodesByNameAndFile } from '../db/queries-search.js';
import { insertEdges } from '../db/queries-edges.js';
import { logDebug, errMsg } from '../errors.js';

export interface FileTarget {
  path: string;
  language: string;
}

/** Module suffixes to try when resolving `import './foo'` to a real
 *  source file. Order matters — `.ts` wins over `.js` because we
 *  index the source-tree, not the build output. */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function collectTargets(
  ctx: IndexHookContext,
  options: { scope: 'all' } | { scope: 'files'; files: string[] },
): FileTarget[] {
  if (options.scope === 'all') {
    return getAllFiles(ctx.queries).map((f) => ({ path: f.path, language: f.language }));
  }
  return options.files
    .map((p) => getFileByPath(ctx.queries, p))
    .filter((f): f is NonNullable<typeof f> => f != null)
    .map((f) => ({ path: f.path, language: f.language }));
}

/**
 * Look up the first node with the given `name` declared in `filePath`.
 * Returns its id, or `null` when no such node exists.
 *
 * B25 (2026-05-24) — was previously implemented as
 * `getNodesByName(ctx.queries, name).filter((n) => n.filePath === filePath)[0]?.id`,
 * which did a whole-project name lookup (returning hundreds of rows
 * for common identifiers like `log` / `parse` / `run`) and filtered
 * in JS. On a 329K-node graph that pattern was 1-10 ms per call;
 * per-file scanners in Group B (`value-ref-edges`, `dynamic-import-edges`,
 * `re-export-edges`, ...) make millions of these calls per indexAll,
 * stalling the postHook for 10+ minutes on microsoft/TypeScript.
 *
 * The new `getNodesByNameAndFile` typed query pushes the (name,
 * file_path) filter into SQL — at most a handful of rows returned
 * per call. Expected ~3000× speedup on this lookup path.
 */
export function lookupSymbolByNameInFile(ctx: IndexHookContext, name: string, filePath: string): string | null {
  const candidates = getNodesByNameAndFile(ctx.queries, name, filePath);
  return candidates[0]?.id ?? null;
}

/**
 * Resolve a relative TS/JS module specifier to a project-relative
 * file path. Returns null when no matching source file exists.
 *
 * Tries each `MODULE_EXTENSIONS` value plus the `/index.<ext>`
 * variant for directory imports. Skips package imports
 * (specifiers that don't start with `.`) — we don't follow into
 * `node_modules`.
 */
export function resolveTargetFile(fromDir: string, importPath: string, projectRoot: string): string | null {
  if (!importPath.startsWith('.')) return null;
  const cleaned = importPath.replace(/\.(?:m|c)?js$/, '').replace(/\.(?:m|c)?ts$/, '');
  const baseRel = path.normalize(path.join(fromDir, cleaned));
  for (const ext of MODULE_EXTENSIONS) {
    const direct = baseRel + ext;
    if (existsAsFile(path.join(projectRoot, direct))) return direct;
    const indexed = path.join(baseRel, 'index' + ext);
    if (existsAsFile(path.join(projectRoot, indexed))) return indexed;
  }
  return null;
}

function existsAsFile(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

interface EdgeRecord {
  source: string;
  target: string;
  kind: 'references';
}

export interface RefreshEdgesHookArgs {
  ctx: IndexHookContext;
  options: { scope: 'all' } | { scope: 'files'; files: string[] };
  hookName: string;
  /** May be sync (legacy) or async (post-B24 yield-aware). The shared
   *  runner awaits the result regardless. */
  buildEdges: (ctx: IndexHookContext, targets: FileTarget[]) => EdgeRecord[] | Promise<EdgeRecord[]>;
}

/**
 * Shared `refresh` implementation for edge-emitting hooks
 * (`re-export-edges`, `dynamic-import-edges`, `value-ref-edges`).
 * Collects the target file list, calls `buildEdges` to produce the
 * edges, then inserts them. Errors are swallowed and logged so a
 * single-file parse failure never aborts the whole hook.
 *
 * B24 (2026-05-24) — async `buildEdges` supported so per-file
 * scanners can `setImmediate`-yield mid-loop, letting peer hooks in
 * Group B's `Promise.all` actually interleave. Without this, one
 * CPU-bound sync hook starves the rest and Group B runs strictly
 * serial.
 */
export async function refreshEdgesHook(args: RefreshEdgesHookArgs): Promise<void> {
  const { ctx, options, hookName, buildEdges } = args;
  try {
    const targets = collectTargets(ctx, options);
    const edges = await buildEdges(ctx, targets);
    if (edges.length > 0) insertEdges(ctx.queries, edges);
  } catch (err) {
    logDebug(`${hookName} hook failed: ${errMsg(err)}`);
  }
}

/** Yield to the event loop every N files inside a per-file scan loop
 *  so peer hooks dispatched via `Promise.all` get a chance to
 *  interleave. 500 is empirically the sweet spot — small enough that
 *  a multi-thousand-file scan yields ~80 times (one per group of 500),
 *  large enough that the yield cost (~10-50µs) doesn't dominate the
 *  per-file work. */
export const PER_FILE_YIELD_INTERVAL = 500;

/** Cooperative yield helper used by per-file scanners. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
