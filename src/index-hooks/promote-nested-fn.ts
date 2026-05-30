/**
 * F#12 slice 3 — promote-nested-fn hook.
 *
 * Promotes manifest rows whose `hit_count` has crossed
 * `nestedPromotionThreshold` into first-class graph nodes. Once
 * promoted:
 *   - `cartograph_find <name>` returns the promoted Node directly
 *     instead of the "Nested matches" manifest fallback.
 *   - `cartograph_node({deep:true})` routes through the regular
 *     `findSymbol`/`renderOneNode` pipeline (slice-2 fast-path in
 *     `tryRenderManifestDeepView`).
 *   - Cross-file callers' `unresolved_refs` resolve to the new node id
 *     on the next sync's resolver pass — the same machinery that
 *     resolves any newly-added export.
 *
 * Scope (slices 3 + 4): this hook
 *   1. creates the Node row + the `contains` edge from the parent;
 *   2. runs a same-sync partial re-resolve of caller `unresolved_refs`
 *      scoped to the promoted names (slice 3 — the load-bearing UX
 *      piece per the plan §async-promotion-task);
 *   3. migrates intra-file edges + unresolved_refs sourced from the
 *      parent whose `line` falls inside the promoted fn's range so
 *      that callees / refs / field-accesses out of the promoted fn
 *      now surface from the promoted node (slice 4 — without this
 *      `cartograph_graph direction:callees start=<promoted>` returns
 *      nothing even post-promotion).
 *
 * The promoted fn's body is NOT re-extracted — slice 4 migrates the
 * existing edges by line range. See `migratePromotedFnEdges` for the
 * documented dedup-stretching limitation.
 *
 * Idempotent: `markNestedFnPromoted` UPDATE is guarded on
 * `promoted_node_id IS NULL`, so two concurrent hook runs racing the
 * same manifest row don't double-insert. `insertNode` writes are
 * de-duped against the existing `nodes.id` UNIQUE — the deterministic
 * id formula below produces the same id for the same (file_path, kind,
 * name, ordinal) tuple across hook runs.
 *
 * Cost model: per-promotion work is O(1) — a SELECT + INSERT + UPDATE
 * per row. The SELECT to compute `ordinal` is bounded by the file's
 * function count, typically <100. Bound the per-pass batch at 200 so a
 * mega-spike of manifest hits across many files doesn't dominate
 * sync wall.
 */

import type { IndexHook, IndexHookContext } from './types.js';
import type { Node, Edge, UnresolvedReference } from '../types.js';
import { generateNodeId } from '../extraction/tree-sitter-helpers.js';
import { detectLanguage } from '../extraction/grammars.js';
import {
  countNodesByFileKindName,
  listNestedFnPromotables,
  listUnresolvedRefsByNames,
  markNestedFnPromoted,
  migratePromotedFnEdges,
} from '../db/queries-nested-functions.js';
import { insertEdges } from '../db/queries-edges.js';
import { createResolver } from '../resolution/index.js';
import { rowToUnresolvedRef } from '../db/queries.js';
import { logDebug } from '../errors.js';

/** Per-pass cap on how many promotions to materialise in one hook
 *  invocation. 200 is generous for typical projects; a mega-spike
 *  beyond that surfaces as a few stragglers on the NEXT sync. */
const MAX_PROMOTIONS_PER_PASS = 200;

/** Read the configured threshold from the hook context's config.
 *  `Infinity` disables promotion; `1` would promote on first deep call.
 *  Reads `ctx.config` because the hook runs in the forked hook-worker
 *  whose process.env was inherited at spawn time — runtime
 *  `eoApplyExtractionEnvFromConfig` updates don't propagate to the
 *  already-forked child. `ctx.config` is the worker's authoritative
 *  copy, threaded through the run-hooks message payload. */
function getPromotionThreshold(ctx: IndexHookContext): number {
  const cfg = ctx.config.nestedPromotionThreshold;
  if (cfg === undefined || cfg === null) return 5;
  if (cfg === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return Number.isFinite(cfg) && cfg >= 0 ? cfg : 5;
}

/**
 * Compute a collision-free node id for a freshly-promoted nested fn.
 * The existing `generateNodeId` formula hashes
 * `${filePath}:${kind}:${name}:${ordinal}` — uniqueness requires the
 * ordinal to be distinct from BOTH (a) any existing same-(kind, name)
 * row in `nodes` and (b) any other promotion in THE SAME batch.
 *
 * Two-part ordinal:
 *   - `existing` — DB count of (file_path, function, name); pre-batch.
 *   - `batchOffset[(file_path, name)]` — per-batch counter the caller
 *     keeps across iterations of the promotion loop. Without this, two
 *     same-named nested fns in the same file (e.g. a `validate` helper
 *     declared inside both `parseFoo` and `parseBar` in `checker.ts`)
 *     would both receive ordinal=`existing` and thus the same id;
 *     `insertNodes`'s upsert path would silently overwrite the first.
 *
 * Stability across re-extracts: when the file is re-extracted the
 * cascade-evict drops the prior promoted node; the next promotion hook
 * computes a fresh `existing` count + batch offset, lands a fresh id.
 * Acceptable — no caller holds a long-lived reference to the
 * promoted_node_id beyond the manifest row itself, which always points
 * at the current id.
 */
function pickPromotedNodeId(ctx: IndexHookContext, filePath: string, name: string, batchOffset: number): string {
  const existing = countNodesByFileKindName(ctx.queries, { filePath, kind: 'function', name });
  return generateNodeId({ filePath, kind: 'function', name, ordinal: existing + batchOffset });
}

function refresh(ctx: IndexHookContext): void {
  const threshold = getPromotionThreshold(ctx);
  if (threshold === Number.POSITIVE_INFINITY) return;

  const promotables = listNestedFnPromotables(ctx.queries, threshold, MAX_PROMOTIONS_PER_PASS);
  if (promotables.length === 0) return;

  const newNodes: Node[] = [];
  const newEdges: Edge[] = [];
  const promotionPlan: Array<{ manifestId: number; nodeId: string }> = [];
  // Per-batch ordinal offsets — bumped per (file_path, name) so two
  // same-named nested fns in the same batch get distinct ids. Without
  // this the same-name collision would silently merge them into one
  // promoted Node row.
  const batchOffsets = new Map<string, number>();

  for (const row of promotables) {
    const offsetKey = `${row.filePath}\0${row.name}`;
    const offset = batchOffsets.get(offsetKey) ?? 0;
    batchOffsets.set(offsetKey, offset + 1);
    const promotedId = pickPromotedNodeId(ctx, row.filePath, row.name, offset);
    const node: Node = {
      id: promotedId,
      kind: 'function',
      name: row.name,
      // No surrounding container is recorded by manifest mining (the
      // parent function is itself a real Node, but qualifiedName
      // chains by class/module path, not call-stack). For a promoted
      // nested fn the plain name is the right qualifier — matches how
      // top-level functions are qualified.
      qualifiedName: row.name,
      filePath: row.filePath,
      language: detectLanguage(row.filePath, ''),
      startLine: row.startLine,
      endLine: row.endLine,
      startColumn: row.startCol,
      endColumn: row.endCol,
      ...(row.signature === null ? {} : { signature: row.signature }),
      bodyHash: row.bodyHash,
      updatedAt: Date.now(),
    };
    newNodes.push(node);
    newEdges.push({ source: row.parentNodeId, target: promotedId, kind: 'contains' });
    promotionPlan.push({ manifestId: row.id, nodeId: promotedId });
  }

  // Persist nodes + contains edges + manifest stamps + slice-4 edge
  // migration in one transaction so a mid-batch crash can't strand
  // promoted nodes without their manifest marker (or migrated edges
  // without their new source node). The migration is per-promoted-row
  // because each row's line range scopes the UPDATE.
  ctx.db.getDb().transaction(() => {
    ctx.queries.insertNodes(newNodes);
    insertEdges(ctx.queries, newEdges);
    for (const p of promotionPlan) {
      markNestedFnPromoted(ctx.queries, { id: p.manifestId, promotedNodeId: p.nodeId });
    }
    // Slice 4 — re-anchor intra-fn edges + unresolved_refs from the
    // parent (closest pre-promotion real-node ancestor) to the
    // promoted node. Order inside the txn doesn't matter; migration
    // is keyed by file + line range, independent of `insertNodes` /
    // `insertEdges` results.
    for (let i = 0; i < promotables.length; i++) {
      const row = promotables[i]!;
      const promotedId = promotionPlan[i]!.nodeId;
      migratePromotedFnEdges(ctx.queries, {
        promotedId,
        filePath: row.filePath,
        startLine: row.startLine,
        endLine: row.endLine,
      });
    }
  })();

  // Partial re-resolve: any unresolved_refs whose reference_name matches
  // a freshly-promoted name now have a target to bind to. Without this
  // step cross-file callers wouldn't show up until the next sync — the
  // load-bearing UX piece per the F#12 plan §async-promotion-task. Cheap
  // because we filter SQL-side to the small set of names.
  const promotedNames = new Set(promotables.map((r) => r.name));
  resolveUnresolvedForNames(ctx, promotedNames);

  logDebug('[promote-nested-fn] promoted', { count: promotionPlan.length });
}

/** Run the resolver on every unresolved_ref whose `reference_name`
 *  matches any of the freshly-promoted names. Mirrors the
 *  `resolveAndPersist` invocation pattern from `cgSyncResolveReferences`
 *  in `src/index.ts` — scoped to a name set instead of a file set. */
function resolveUnresolvedForNames(ctx: IndexHookContext, names: Set<string>): void {
  if (names.size === 0) return;
  // Pulled refs are constrained by reference_name — keeps the working
  // set small even on projects with tens of thousands of total
  // unresolved refs (e.g. checker.ts post-mining).
  const rows = listUnresolvedRefsByNames(ctx.queries, Array.from(names));
  if (rows.length === 0) return;
  const refs: UnresolvedReference[] = rows.map(rowToUnresolvedRef);
  const resolver = createResolver(ctx.projectRoot, ctx.queries);
  resolver.resolveAndPersist(refs);
}

export const HOOK: IndexHook = {
  name: 'promote-nested-fn',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx) {
    // Sync trigger: any manifest row whose hit_count crossed the
    // threshold via a `cartograph_node({deep:true})` call since the
    // last sync. No file-set guard — promotion eligibility lives on
    // the manifest row's hit_count, not on file content, so an
    // unchanged file can still have a newly-promoted nested fn
    // (e.g. when the agent called `deep:true` between syncs).
    refresh(ctx);
  },
};
