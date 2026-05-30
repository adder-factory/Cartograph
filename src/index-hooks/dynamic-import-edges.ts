/**
 * Dynamic-import edges hook — emits `references` edges for
 * `await import('./y.js')` followed by destructured or member-access
 * usage of the imported symbols.
 *
 * Tree-sitter parses `import('...')` as a regular call expression,
 * not a static import. The resolver therefore can't connect the
 * destructured names to the source symbols, and the consumed
 * functions look unused even though they're explicitly invoked.
 * This hook fills the gap by scanning each TS/JS file for the
 * common patterns:
 *
 *   const { contentHashFor } = await import('../src/llm/summarizer.js');
 *
 *   const mod = await import('./y.js'); mod.foo();
 *
 *   const { foo: alias } = await import('./y.js'); alias();
 *
 * For each match it resolves the target file, finds the named symbol,
 * and emits a `references` edge from the importing file's node to
 * the target symbol. The unused_export rule already counts
 * `references` as use-evidence.
 *
 * Wildcards / namespace-only patterns (`const m = await import('./y.js')`
 * with no member access in scope) are tracked at the file-level only
 * — the hook can't statically know which member would be accessed
 * later. False positives are accepted in exchange for a simple,
 * tree-sitter-free scanner.
 */

import * as path from 'node:path';
import type { IndexHook, IndexHookContext } from './types.js';
import { readFileSafe } from '../utils.js';
import type { SyncResult } from '../extraction/index.js';
import { stripJsComments } from '../resolution/import-resolver.js';
import {
  type FileTarget,
  lookupSymbolByNameInFile,
  resolveTargetFile,
  refreshEdgesHook,
  PER_FILE_YIELD_INTERVAL,
  yieldToEventLoop,
} from './edge-resolution-helpers.js';

const SUPPORTED_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

/**
 * `const { foo, bar: alias } = await import('./y.js')` or
 * `const { foo } = await import('./y.js')`. The first capture group
 * is the brace contents, the second is the source path.
 */
const DESTRUCTURE_DYNAMIC_IMPORT_RE =
  /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * TypeScript inline-import-type or value-property access:
 * `import('./y.js').Foo` (in a type position) or `import('./y.js').foo`
 * (rarely, in a value position). The first capture is the source
 * path, the second is the property name.
 */
const INLINE_IMPORT_PROP_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*(\w+)/g;

interface ImportEdge {
  source: string;
  target: string;
  kind: 'references';
}

async function refresh(
  ctx: IndexHookContext,
  options: { scope: 'all' } | { scope: 'files'; files: string[] },
): Promise<void> {
  await refreshEdgesHook({ ctx, options, hookName: 'dynamic-import-edges', buildEdges: buildDynamicImportEdges });
}

interface ScanCtx {
  hookCtx: IndexHookContext;
  file: FileTarget;
  cleaned: string;
  edges: ImportEdge[];
}

async function buildDynamicImportEdges(ctx: IndexHookContext, files: FileTarget[]): Promise<ImportEdge[]> {
  const edges: ImportEdge[] = [];
  let processed = 0;
  for (const file of files) {
    if (!SUPPORTED_LANGS.has(file.language)) continue;
    const content = readFileSafe(path.join(ctx.projectRoot, file.path));
    if (!content) continue;
    const cleaned = stripJsComments(content);
    if (!cleaned.includes('import(')) continue;
    const scan: ScanCtx = { hookCtx: ctx, file, cleaned, edges };
    collectDestructureEdges(scan);
    collectInlineImportPropEdges(scan);
    // B24 (2026-05-24) — cooperative yield. See edge-resolution-helpers.ts.
    if (++processed % PER_FILE_YIELD_INTERVAL === 0) await yieldToEventLoop();
  }
  return edges;
}

function collectInlineImportPropEdges(scan: ScanCtx): void {
  const fileNodeId = `file:${scan.file.path}`;
  const fileDir = path.dirname(scan.file.path);
  let m: RegExpExecArray | null;
  INLINE_IMPORT_PROP_RE.lastIndex = 0;
  while ((m = INLINE_IMPORT_PROP_RE.exec(scan.cleaned)) !== null) {
    const source = m[1]!;
    const name = m[2]!;
    const targetFile = resolveTargetFile(fileDir, source, scan.hookCtx.projectRoot);
    if (!targetFile || targetFile === scan.file.path) continue;
    const targetSymbolId = lookupSymbolByNameInFile(scan.hookCtx, name, targetFile);
    if (!targetSymbolId) continue;
    scan.edges.push({ source: fileNodeId, target: targetSymbolId, kind: 'references' });
  }
}

function collectDestructureEdges(scan: ScanCtx): void {
  const fileNodeId = `file:${scan.file.path}`;
  const fileDir = path.dirname(scan.file.path);
  let m: RegExpExecArray | null;
  // Reset lastIndex so the global regex doesn't carry state across calls.
  DESTRUCTURE_DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((m = DESTRUCTURE_DYNAMIC_IMPORT_RE.exec(scan.cleaned)) !== null) {
    const inner = m[1]!;
    const source = m[2]!;
    const targetFile = resolveTargetFile(fileDir, source, scan.hookCtx.projectRoot);
    if (!targetFile || targetFile === scan.file.path) continue;
    for (const name of parseDestructureNames(inner)) {
      const targetSymbolId = lookupSymbolByNameInFile(scan.hookCtx, name, targetFile);
      if (!targetSymbolId) continue;
      scan.edges.push({ source: fileNodeId, target: targetSymbolId, kind: 'references' });
    }
  }
}

function parseDestructureNames(inner: string): string[] {
  const out: string[] = [];
  for (const raw of inner.split(',')) {
    // `foo as alias` / `foo: alias` / bare `foo` — the ORIGINAL name
    // (before `as` / `:`) is what lives in the target file.
    const item = raw.trim().replace(/^type\s+/, '');
    if (!item) continue;
    const colonMatch = item.match(/^(\w+)\s*:/);
    if (colonMatch) {
      out.push(colonMatch[1]!);
      continue;
    }
    const asMatch = item.match(/^(\w+)\s+as\s+\w+$/);
    if (asMatch) {
      out.push(asMatch[1]!);
      continue;
    }
    if (/^\w+$/.test(item)) out.push(item);
  }
  return out;
}

export const HOOK: IndexHook = {
  name: 'dynamic-import-edges',
  async afterIndexAll(ctx) {
    await refresh(ctx, { scope: 'all' });
  },
  async afterSync(ctx, result: SyncResult) {
    if ((result.changedFilePaths && result.changedFilePaths.length > 0) || result.filesRemoved > 0) {
      await refresh(ctx, { scope: 'files', files: result.changedFilePaths ?? [] });
    }
  },
};
