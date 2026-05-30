/**
 * Re-export edges hook — emits `references` edges for
 * `export { X } from './y.js'` syntax so the `unused_export`
 * biomarker doesn't flag symbols genuinely re-exported from
 * public-API barrels.
 *
 * Tree-sitter's structural extraction doesn't currently emit a graph
 * edge for re-exports — they appear as syntax but never resolve into
 * a `calls` / `references` edge. The resolver's regex parser
 * (`extractReExports`) already detects the pattern for downstream
 * import-chain following; we reuse it here, resolve each named
 * re-export to its target symbol, and emit a `references` edge from
 * the re-exporting file's node to the target. The chosen edge kind
 * is what the `findUnusedExports` rule treats as use-evidence.
 *
 * Wildcards (`export * from './y.js'`) are skipped — they'd require
 * iterating every exported symbol of the target file, which inflates
 * edge count for marginal benefit. Named re-exports cover the common
 * "barrel re-exports getConfigPath" case.
 */

import * as path from 'node:path';
import type { IndexHook, IndexHookContext } from './types.js';
import { readFileSafe } from '../utils.js';
import type { SyncResult } from '../extraction/index.js';
import type { Language } from '../types.js';
import { extractReExports } from '../resolution/import-resolver.js';
import {
  type FileTarget,
  lookupSymbolByNameInFile,
  resolveTargetFile,
  refreshEdgesHook,
  PER_FILE_YIELD_INTERVAL,
  yieldToEventLoop,
} from './edge-resolution-helpers.js';

const SUPPORTED_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

async function refresh(
  ctx: IndexHookContext,
  options: { scope: 'all' } | { scope: 'files'; files: string[] },
): Promise<void> {
  await refreshEdgesHook({ ctx, options, hookName: 're-export-edges', buildEdges: buildReExportEdges });
}

interface ReExportEdge {
  source: string;
  target: string;
  kind: 'references';
}

async function buildReExportEdges(ctx: IndexHookContext, files: FileTarget[]): Promise<ReExportEdge[]> {
  const edges: ReExportEdge[] = [];
  let processed = 0;
  for (const file of files) {
    if (!SUPPORTED_LANGS.has(file.language)) continue;
    const content = readFileSafe(path.join(ctx.projectRoot, file.path));
    if (!content) continue;

    const reExports = extractReExports(content, file.language as Language);
    if (reExports.length === 0) continue;

    const fileNodeId = `file:${file.path}`;
    const fileDir = path.dirname(file.path);
    for (const rx of reExports) {
      if (rx.kind !== 'named') continue;
      const targetFile = resolveTargetFile(fileDir, rx.source, ctx.projectRoot);
      if (!targetFile || targetFile === file.path) continue;
      const targetSymbolId = lookupSymbolByNameInFile(ctx, rx.originalName, targetFile);
      if (!targetSymbolId) continue;
      edges.push({ source: fileNodeId, target: targetSymbolId, kind: 'references' });
    }
    // B24 (2026-05-24) — cooperative yield. See edge-resolution-helpers.ts.
    if (++processed % PER_FILE_YIELD_INTERVAL === 0) await yieldToEventLoop();
  }
  return edges;
}

export const HOOK: IndexHook = {
  name: 're-export-edges',
  async afterIndexAll(ctx) {
    await refresh(ctx, { scope: 'all' });
  },
  async afterSync(ctx, result: SyncResult) {
    if ((result.changedFilePaths && result.changedFilePaths.length > 0) || result.filesRemoved > 0) {
      await refresh(ctx, { scope: 'files', files: result.changedFilePaths ?? [] });
    }
  },
};
