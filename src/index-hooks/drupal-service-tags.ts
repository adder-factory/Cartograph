/**
 * Drupal service-tag linking (Drupal v4, 2026-05-29).
 *
 * Drupal/Symfony DI uses *tagged services*: a service declares
 * `tags: [{ name: my.plugin.tag }]` (a PROVIDER) and another service
 * injects all providers of a tag via `arguments: [!tagged_iterator
 * my.plugin.tag]` (a CONSUMER). Providers and consumers almost always
 * live in DIFFERENT modules' `*.services.yml` files, so the linkage
 * can't be resolved inside a single file's extraction pass.
 *
 * This project-wide hook closes that gap: it synthesizes ONE `resource`
 * node per service tag (the tag's hub) and emits a `references` edge from
 * every provider AND every consumer to that hub. "Which services provide
 * tag X" = the hub's incoming edges with `role = provides`; "what does
 * this iterator inject" = follow the consumer's edge to the hub, then the
 * hub's `provides` edges back to the providers.
 *
 * Source of truth is the YAML, re-parsed here via the shared
 * `extractServiceTagFacts` (`resolution/frameworks/drupal.ts`) — the same
 * parser the resolver uses, so the two can't drift. The hub node is
 * anchored to the lexicographically-first `*.services.yml` file that
 * references the tag (a real file → its `nodes.file_path` FK is
 * satisfied; deterministic so the synthesized id is stable across runs).
 *
 * ## Self-heal
 *
 * `DRUPAL_SERVICE_TAGS_ALGO_VERSION` is the SHA of this file. `afterSync`
 * compares it to the stored value; a mismatch triggers a one-shot full
 * re-mine. Same pattern as `drupal-hooks` / `drupal-plugins`.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { IndexHook, IndexHookContext } from './types.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';
import { generateNodeId } from '../extraction/tree-sitter-helpers.js';
import { insertEdges } from '../db/queries-edges.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge, Node, NodeKind } from '../types.js';
import { extractServiceTagFacts } from '../resolution/frameworks/drupal.js';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars.js';

export const DRUPAL_SERVICE_TAGS_ALGO_VERSION = computeAlgoHash('src/index-hooks/drupal-service-tags.ts', [
  './drupal-service-tags',
]);
const LAST_MINED_KEY = 'last_mined_drupal_service_tags_algo_version';

/** Marker embedded in a tag hub's qualifiedName — `<file>::service-tag:<name>`
 *  — so the clean-slate delete can find every prior hub regardless of which
 *  file it was anchored to (the anchor can shift between runs). */
const TAG_QNAME_MARKER = '::service-tag:';

/** List every indexed `*.services.yml` path. */
function collectServicesYmlPaths(ctx: IndexHookContext): string[] {
  const rows = ctx.queries.db.prepare(`SELECT path FROM files WHERE path LIKE '%.services.yml'`).all() as Array<{
    path: string;
  }>;
  return rows.map((r) => r.path);
}

/** Map `<file>|<serviceId>` → service `resource` node id. Excludes the
 *  hook's own tag-hub nodes (which share kind/language). Run AFTER the
 *  clean-slate delete so no stale hub rows linger anyway. */
function buildServiceNodeIndex(ctx: IndexHookContext): Map<string, string> {
  const rows = ctx.queries.db
    .prepare(
      `SELECT id, name, file_path AS filePath
       FROM nodes
       WHERE kind = 'resource' AND language = 'yaml' AND qualified_name NOT LIKE ?`,
    )
    .all(`%${TAG_QNAME_MARKER}%`) as Array<{ id: string; name: string; filePath: string }>;
  const map = new Map<string, string>();
  for (const r of rows) map.set(`${r.filePath}|${r.name}`, r.id);
  return map;
}

/** Read a `*.services.yml` from disk, tolerating a vanished/unreadable
 *  file (returns null — the hook just skips it). */
function readServiceYml(projectRoot: string, relPath: string): string | null {
  try {
    return readFileSync(isAbsolute(relPath) ? relPath : join(projectRoot, relPath), 'utf8');
  } catch (err) {
    logDebug(`drupal-service-tags: cannot read ${relPath}: ${errMsg(err)}`);
    return null;
  }
}

interface TagGroup {
  providers: Set<string>;
  consumers: Set<string>;
  /** Files that reference this tag — the anchor is the sorted-first. */
  files: Set<string>;
}

/** Group every (service node, tag, role) fact across all `*.services.yml`
 *  files by tag name. Facts whose service id doesn't resolve to a node
 *  (defensive — the resolver should have created one) are skipped. */
function collectTagGroups(ctx: IndexHookContext, serviceIndex: Map<string, string>): Map<string, TagGroup> {
  const groups = new Map<string, TagGroup>();
  for (const file of collectServicesYmlPaths(ctx)) {
    const content = readServiceYml(ctx.projectRoot, file);
    if (!content) continue;
    for (const fact of extractServiceTagFacts(content)) {
      const serviceNodeId = serviceIndex.get(`${file}|${fact.serviceId}`);
      if (!serviceNodeId) continue;
      let group = groups.get(fact.tagName);
      if (!group) {
        group = { providers: new Set(), consumers: new Set(), files: new Set() };
        groups.set(fact.tagName, group);
      }
      group.files.add(file);
      (fact.role === 'provides' ? group.providers : group.consumers).add(serviceNodeId);
    }
  }
  return groups;
}

/** Build the hub node + provider/consumer edges for one tag. */
function buildTagGraph(tagName: string, group: TagGroup, now: number): { node: Node; edges: Edge[] } {
  const anchor = [...group.files].sort((a, b) => Number(a > b) - Number(a < b))[0]!;
  const id = generateNodeId({
    filePath: anchor,
    kind: 'resource' as NodeKind,
    name: `service-tag:${tagName}`,
    ordinal: 0,
  });
  const node: Node = {
    id,
    kind: 'resource' as NodeKind,
    name: tagName,
    qualifiedName: `${anchor}${TAG_QNAME_MARKER}${tagName}`,
    filePath: anchor,
    language: 'yaml',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: now,
  };
  const edges: Edge[] = [];
  const link = (source: string, role: 'provides' | 'consumes'): void => {
    edges.push({
      source,
      target: id,
      kind: 'references',
      metadata: { synthesizedBy: 'drupal-service-tags', tag: tagName, role },
    });
  };
  for (const p of group.providers) link(p, 'provides');
  for (const c of group.consumers) link(c, 'consumes');
  return { node, edges };
}

/** Drop the hub nodes + edges this hook previously emitted. Deleting the
 *  hub nodes cascade-clears their edges (FK ON DELETE CASCADE); the edge
 *  delete is belt-and-suspenders + matches the `drupal-hooks` pattern. */
function clearPrevious(ctx: IndexHookContext): void {
  ctx.queries.db
    .prepare(`DELETE FROM edges WHERE kind = 'references' AND json_extract(metadata, '$.synthesizedBy') = ?`)
    .run('drupal-service-tags');
  ctx.queries.db
    .prepare(`DELETE FROM nodes WHERE kind = 'resource' AND qualified_name LIKE ?`)
    .run(`%${TAG_QNAME_MARKER}%`);
}

async function refresh(ctx: IndexHookContext): Promise<void> {
  try {
    clearPrevious(ctx);
    const serviceIndex = buildServiceNodeIndex(ctx);
    if (serviceIndex.size > 0) {
      // Index-hooks run on the host process, but grammar parsing ran in
      // worker threads — so the host may not have the yaml grammar loaded
      // when we re-parse *.services.yml. Ensure it (idempotent; a no-op
      // once cached). Without this the re-parse silently yields no facts.
      if (!getParser('yaml')) await loadGrammarsForLanguages(['yaml']);
      const groups = collectTagGroups(ctx, serviceIndex);
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      const now = Date.now();
      for (const [tagName, group] of groups) {
        const built = buildTagGraph(tagName, group, now);
        nodes.push(built.node);
        edges.push(...built.edges);
      }
      if (nodes.length > 0) ctx.queries.insertNodes(nodes);
      if (edges.length > 0) insertEdges(ctx.queries, edges);
    }
  } catch (err) {
    logDebug(`drupal-service-tags refresh failed: ${errMsg(err)}`);
  }
  // Stamp the algo version unconditionally — even if the pass above threw.
  // A transient failure (e.g. a grammar-load hiccup) recovers on the next
  // *.services.yml change, which re-triggers refresh; we don't want a failed
  // pass to wedge a re-mine loop. Matches drupal-hooks / drupal-plugins.
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, DRUPAL_SERVICE_TAGS_ALGO_VERSION);
  } catch (err) {
    logDebug(`drupal-service-tags stamp failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'drupal-service-tags',
  async afterIndexAll(ctx) {
    await refresh(ctx);
  },
  async afterSync(ctx, result: SyncResult) {
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== DRUPAL_SERVICE_TAGS_ALGO_VERSION) {
      await refresh(ctx);
      return;
    }
    // A tag's provider set spans modules, so any `*.services.yml` change
    // (or removal) can shift the project-wide tag graph — re-mine on any.
    const changed = result.changedFilePaths ?? [];
    if (changed.some((p) => p.endsWith('.services.yml')) || result.filesRemoved > 0) await refresh(ctx);
  },
};
