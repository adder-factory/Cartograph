/**
 * Shared per-phase file text for the group-B regex miners.
 *
 * Four hooks (re-export-edges, dynamic-dispatch, dynamic-import-edges,
 * value-ref-edges) each read — and three of them comment-strip — the
 * same TS/JS corpus once per hook phase. With group B running
 * sequentially those reads repeat back-to-back, so one shared cache
 * turns 4 reads + 3 strips per file into 1 + 1.
 *
 * Lifetime: the registry clears the cache after every hook phase
 * (`runHookPhase` finally), so entries never outlive one
 * indexAll/sync pass — no mtime invalidation is needed, and the
 * transient memory (content + stripped text for the changed-file set,
 * or the corpus on a full index) is released immediately after the
 * hooks finish.
 */
import * as path from 'node:path';
import { stripJsComments } from '../resolution/import-resolver.js';
import { readFileSafe } from '../utils.js';

export interface MinerFileText {
  readonly content: string | null;
  readonly cleaned: string | null;
}

const cache = new Map<string, MinerFileText>();

/** Read (and comment-strip) one project file, memoized for the phase. */
export function minerFileText(projectRoot: string, relPath: string): MinerFileText {
  const abs = path.join(projectRoot, relPath);
  const hit = cache.get(abs);
  if (hit) return hit;
  const content = readFileSafe(abs);
  const entry: MinerFileText = {
    content,
    cleaned: content === null ? null : stripJsComments(content),
  };
  cache.set(abs, entry);
  return entry;
}

/** Drop all entries. Called by the hook registry after each phase. */
export function clearMinerFileTextCache(): void {
  cache.clear();
}
