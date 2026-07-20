/**
 * Drupal hook implementations (F#69, 2026-05-28).
 *
 * Replaces the regex-against-source path that lived in
 * `drupalResolver.extract()` (F#62) with a graph walk over indexed
 * PHP function nodes. Two strategies, same semantics as F#62:
 *
 *   A. Docblock `Implements hook_X()` — read off the function node's
 *      `docstring` field (populated by `getPrecedingDocstring` during
 *      extraction). The cleaned docstring drops the `/**` / leading
 *      `* ` markers, so the pattern is simpler than the original
 *      source-scanning regex.
 *
 *   B. Name pattern `{moduleName}_{hookSuffix}` — when strategy A
 *      misses (no docblock or no @Implements tag) and the function
 *      name starts with the file's module prefix.
 *
 * For each detected implementation, emit a `references` edge to the
 * hook's CONTRACT node (Drupal v4, 2026-05-29): the indexed real
 * `hook_X` declaration — Drupal core documents hooks as
 * `function hook_form_alter(...)` stubs in `*.api.php` — when one is
 * in the graph, else a synthesized VIRTUAL `resource` node named
 * `hook_X`. The virtual node is anchored to the lexicographically-first
 * implementation's file (a real file → FK-safe; deterministic so its id
 * is stable across runs). This makes the hook discoverable by name and
 * gives every implementation one shared target, so "what implements
 * hook_X?" is the contract node's incoming `references` edges (replacing
 * the prior arbitrary canonical-impl self-edge).
 *
 * ## Why a hook, not an extract() path
 *
 * The original F#62 implementation lived in `FrameworkResolver.extract`
 * and regex-scanned the file content. Two problems:
 *
 *   1. Docblock detection was a fragile multi-line regex that had to
 *      pair `/** ... *\/` blocks with the immediately-following
 *      `function NAME(` declaration in source. The PHP extractor
 *      already does this pairing during tree-sitter parsing and
 *      stores the result on `Node.docstring`. Re-deriving it from
 *      source duplicates work and risks divergence on edge cases
 *      (nested block comments, comments separated by blank lines).
 *
 *   2. The from-node id used `generateNodeId(...)` with `ordinal: 0`
 *      which depended on a "Drupal hook functions are uniquely named
 *      per file" invariant — a cross-pipeline assumption that an
 *      audit could only catch by reading two files at once.
 *
 * Walking indexed nodes eliminates both issues — the function node's
 * id is read directly from the graph (already correctly ordinal'd),
 * and its docstring was extracted by tree-sitter, not regex.
 *
 * ## Self-heal
 *
 * `DRUPAL_HOOKS_ALGO_VERSION` is the SHA of this file's source.
 * `afterSync` checks the stored algo-version; mismatch triggers a
 * one-shot full re-mine. Same pattern as `nestjs-routes` /
 * `go-implements` / `value-ref-edges`.
 */

import type { IndexHook, IndexHookContext } from './types.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';
import { insertEdges } from '../db/queries-edges.js';
import { generateNodeId } from '../extraction/tree-sitter-helpers.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge, Node } from '../types.js';
import { HOOK_FILE_EXTENSIONS } from '../resolution/frameworks/drupal.js';

export const DRUPAL_HOOKS_ALGO_VERSION = computeAlgoHash('src/index-hooks/drupal-hooks.ts', ['./drupal-hooks']);
const LAST_MINED_KEY = 'last_mined_drupal_hooks_algo_version';

/** Match `Implements hook_X()` in a docstring. The leading non-word
 *  boundary (`(?:^|\W)`) allows `@Implements` (Drupal annotation form)
 *  and `Implements` after a leading-`*` stripped from the docblock.
 *  Single match per docstring — duplicate `Implements` lines aren't a
 *  real Drupal pattern. */
const DOCBLOCK_IMPLEMENTS_RE = /(?:^|\W)@?Implements\s+(hook_\w+)\s*\(\)/;

/** Derive the Drupal module name from a hook file path.
 *  `web/modules/custom/my_module/my_module.module` → `my_module`. */
function moduleNameFromHookPath(filePath: string): string | null {
  const match = /\/([^/]+)\.[^./]+$/.exec(filePath);
  return match ? (match[1] ?? null) : null;
}

interface PhpFunctionRow {
  id: string;
  name: string;
  filePath: string;
  docstring: string | null;
}

/** Pull every PHP function node whose file is a Drupal hook file
 *  (`.module` / `.install` / `.theme` / `.inc`). One SQL pass; the
 *  LIKE patterns filter on file_path so we don't read function nodes
 *  from regular `.php` files. */
function collectPhpHookFunctions(ctx: IndexHookContext): PhpFunctionRow[] {
  const likeClauses = HOOK_FILE_EXTENSIONS.map(() => 'file_path LIKE ?').join(' OR ');
  const args = HOOK_FILE_EXTENSIONS.map((ext) => `%${ext}`);
  return ctx.queries.db
    .prepare(
      `SELECT id, name, file_path AS filePath, docstring
       FROM nodes
       WHERE kind = 'function'
         AND language = 'php'
         AND (${likeClauses})`,
    )
    .all(...args) as PhpFunctionRow[];
}

interface HookImpl {
  fromId: string;
  hookName: string;
  /** The function's own name. */
  fromName: string;
  /** The implementation's file — anchors the synthesized virtual hook
   *  node (a real file → its `nodes.file_path` FK is satisfied). */
  filePath: string;
}

/** Detect hook implementations across a batch of PHP function rows.
 *  Strategy A (docblock) wins over strategy B (name pattern) when
 *  both apply — the docblock is the more precise signal. */
function detectHookImpls(rows: readonly PhpFunctionRow[]): HookImpl[] {
  const impls: HookImpl[] = [];
  for (const row of rows) {
    const docMatch = row.docstring ? DOCBLOCK_IMPLEMENTS_RE.exec(row.docstring) : null;
    if (docMatch) {
      const hookName = docMatch[1];
      if (hookName) {
        impls.push({ fromId: row.id, hookName, fromName: row.name, filePath: row.filePath });
        continue;
      }
    }
    const moduleName = moduleNameFromHookPath(row.filePath);
    if (!moduleName) continue;
    const prefix = `${moduleName}_`;
    if (!row.name.startsWith(prefix)) continue;
    const hookSuffix = row.name.slice(prefix.length);
    if (!hookSuffix) continue;
    impls.push({ fromId: row.id, hookName: `hook_${hookSuffix}`, fromName: row.name, filePath: row.filePath });
  }
  return impls;
}

/** Marker in a virtual hook node's qualifiedName (`<file>::drupal-hook:<hook>`)
 *  so the clean-slate delete finds every prior node regardless of which
 *  implementation file it was anchored to (the anchor can shift). */
const HOOK_QNAME_MARKER = '::drupal-hook:';

/** Find indexed REAL hook declarations — Drupal core documents hooks as
 *  `function hook_form_alter(...)` stubs in `*.api.php`. When one exists
 *  for a detected hook, implementations point at it (the authoritative
 *  contract) rather than a synthesized placeholder. Map: hookName → id. */
function collectRealHookFunctions(ctx: IndexHookContext): Map<string, string> {
  const rows = ctx.queries.db
    .prepare(
      String.raw`SELECT id, name FROM nodes WHERE kind = 'function' AND language = 'php' AND name LIKE 'hook\_% ' ESCAPE '\'`,
    )
    .all() as Array<{ id: string; name: string }>;
  const map = new Map<string, string>();
  for (const r of rows) if (!map.has(r.name)) map.set(r.name, r.id);
  return map;
}

/** Per hook name, the file to anchor its virtual node to — the file of
 *  the lexicographically-first implementation (by node id), so the
 *  synthesized node id is deterministic across runs. */
function buildHookAnchors(impls: readonly HookImpl[]): Map<string, string> {
  const anchors = new Map<string, string>();
  const firstImplId = new Map<string, string>();
  for (const impl of impls) {
    const prev = firstImplId.get(impl.hookName);
    if (prev === undefined || impl.fromId < prev) {
      firstImplId.set(impl.hookName, impl.fromId);
      anchors.set(impl.hookName, impl.filePath);
    }
  }
  return anchors;
}

/** A synthetic `resource` node standing in for an unindexed hook contract
 *  (`hook_form_alter`). Makes the hook discoverable by name and gives every
 *  implementation a real target to reference. */
function buildVirtualHookNode(hookName: string, anchorFile: string, now: number): Node {
  const id = generateNodeId({
    filePath: anchorFile,
    kind: 'resource',
    name: `drupal-hook:${hookName}`,
    ordinal: 0,
  });
  return {
    id,
    kind: 'resource',
    name: hookName,
    qualifiedName: `${anchorFile}${HOOK_QNAME_MARKER}${hookName}`,
    filePath: anchorFile,
    language: 'php',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: now,
  };
}

/** Drop the edges + virtual hook nodes this hook previously emitted. The
 *  anchor for a hook's virtual node can shift when a new module adds an
 *  implementation whose id sorts earlier, so without a clean-slate delete
 *  old (now-stale) nodes/edges accumulate. The edge DELETE is bounded to
 *  this hook's `synthesizedBy` tag; the node DELETE to the hook-node
 *  qualifiedName marker. Deleting the nodes also cascade-clears their
 *  edges (FK), so the edge delete first is belt-and-suspenders. */
function clearPrevious(ctx: IndexHookContext): void {
  ctx.queries.db
    .prepare(`DELETE FROM edges WHERE kind = 'references' AND json_extract(metadata, '$.synthesizedBy') = ?`)
    .run('drupal-hooks');
  ctx.queries.db
    .prepare(`DELETE FROM nodes WHERE kind = 'resource' AND qualified_name LIKE ?`)
    .run(`%${HOOK_QNAME_MARKER}%`);
}

/** Resolve each detected hook name to its edge target: a real indexed
 *  `hook_X` declaration when one exists, else a freshly-synthesized
 *  virtual hook node (collected into `virtualNodes` for insertion). */
function resolveHookTargets(
  impls: readonly HookImpl[],
  realHooks: Map<string, string>,
  anchors: Map<string, string>,
): { targetByHook: Map<string, string>; virtualNodes: Node[] } {
  const now = Date.now();
  const targetByHook = new Map<string, string>();
  const virtualNodes: Node[] = [];
  for (const hookName of new Set(impls.map((i) => i.hookName))) {
    const real = realHooks.get(hookName);
    if (real) {
      targetByHook.set(hookName, real);
      continue;
    }
    const anchor = anchors.get(hookName);
    if (!anchor) continue;
    const node = buildVirtualHookNode(hookName, anchor, now);
    virtualNodes.push(node);
    targetByHook.set(hookName, node.id);
  }
  return { targetByHook, virtualNodes };
}

function refresh(ctx: IndexHookContext): void {
  try {
    clearPrevious(ctx);
    const rows = collectPhpHookFunctions(ctx);
    const impls = rows.length > 0 ? detectHookImpls(rows) : [];
    if (impls.length > 0) {
      const { targetByHook, virtualNodes } = resolveHookTargets(
        impls,
        collectRealHookFunctions(ctx),
        buildHookAnchors(impls),
      );
      if (virtualNodes.length > 0) ctx.queries.insertNodes(virtualNodes);
      const edges: Edge[] = [];
      for (const impl of impls) {
        const target = targetByHook.get(impl.hookName);
        if (!target) continue;
        edges.push({
          source: impl.fromId,
          target,
          kind: 'references',
          metadata: { synthesizedBy: 'drupal-hooks', hookName: impl.hookName },
        });
      }
      if (edges.length > 0) insertEdges(ctx.queries, edges);
    }
  } catch (err) {
    logDebug(`drupal-hooks refresh failed: ${errMsg(err)}`);
  }
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, DRUPAL_HOOKS_ALGO_VERSION);
  } catch (err) {
    logDebug(`drupal-hooks stamp failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'drupal-hooks',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx, result: SyncResult) {
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== DRUPAL_HOOKS_ALGO_VERSION) {
      refresh(ctx);
      return;
    }
    // Sync trigger: any PHP hook-file changed → re-run. Hook
    // implementations are file-local, but a virtual node's anchor (the
    // first impl by id) is project-wide, so a single new module file can
    // shift the anchor — and thus the synthesized node id — for an
    // existing hook. Re-mine on any hook-file change OR on file removal
    // (which can also shift the anchor).
    const changed = result.changedFilePaths ?? [];
    const anyHookFileChange =
      changed.some((p) => HOOK_FILE_EXTENSIONS.some((ext) => p.endsWith(ext))) || result.filesRemoved > 0;
    if (anyHookFileChange) refresh(ctx);
  },
};
