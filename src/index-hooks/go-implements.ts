/**
 * Go implements-edge hook — emits `implements` edges from each Go
 * struct to every Go interface whose method set the struct fully
 * satisfies. Go's interface satisfaction is structural (no
 * `implements` keyword), so this relationship is invisible to the
 * extraction-time inheritance pass; this hook is the project-wide
 * post-pass that recovers it.
 *
 * Inputs (already in the DB after extraction):
 *   - Each Go interface has `contains` edges to its declared method
 *     nodes (commit ef6b66f added the method-elem extraction).
 *   - Each Go struct has `contains` edges to its methods via the
 *     existing receiver-type linkage (linkReceiverOwnership in
 *     ts-extract-declarations.ts).
 *
 * Algorithm: for each interface, take its method-NAME set; for each
 * struct, take its method-NAME set; emit `implements` when struct's
 * set ⊇ interface's set AND the interface has at least one method
 * (empty interfaces are matched by every struct — useless noise).
 *
 * Trade-offs:
 *   - Name-only match (no signature comparison). Go's strict spec
 *     requires matching signatures too, but the name-only match
 *     catches the dominant case (interfaces named for their behavior
 *     rarely have name collisions across packages) and a follow-up
 *     can add signature-based pruning if FP rate justifies it.
 *   - B26 (2026-05-24) — cost is now O(I × k × avg_set_size) via the
 *     methodName→structSet inverted index in `deriveImplementsEdges`.
 *     Was O(I × S × k) (pairwise probe of every struct against every
 *     interface). On ollama (120 × 1320 ≈ 158K pairs × 4 methods)
 *     the pairwise path was already sub-millisecond, so the win is
 *     small for typical corpora — but it scales: a 5K-interface ×
 *     50K-struct corpus drops from ~12s of Set.has ops to ~25ms of
 *     small-set intersection. Latent fix for huge Go corpora before
 *     it bites.
 *   - The hook only INSERTs (idempotent via UNIQUE on edges). Stale
 *     edges from a renamed struct are cleared by FK CASCADE when
 *     the old struct node is removed.
 */

import type { IndexHook, IndexHookContext } from './types.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';
import { insertEdges } from '../db/queries-edges.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge } from '../types.js';

/** Algo-version SHA derived from this file's source. A change to the
 *  matching logic invalidates the stored last-mined version, triggering
 *  a one-shot full re-mine on the next afterSync so existing projects
 *  auto-pick up logic improvements without a manual `cartograph admin index`.
 *  Mirrors VALUE_REF_EDGES_ALGO_VERSION. */
export const GO_IMPLEMENTS_ALGO_VERSION = computeAlgoHash('src/index-hooks/go-implements.ts', ['./go-implements']);
const LAST_MINED_KEY = 'last_mined_go_implements_algo_version';

interface GoContainerMethods {
  /** Container id (interface or struct). */
  id: string;
  /** Container name — used for diagnostic logging only. */
  name: string;
  /** Method names declared on the container. */
  methods: Set<string>;
}

/**
 * Run the Go-implements pass: discover (struct, interface) pairs where
 * the struct's method set is a superset of the interface's, emit the
 * corresponding `implements` edges. Idempotent — `insertEdges` UNIQUE
 * dedup handles re-runs.
 */
function refresh(ctx: IndexHookContext): void {
  try {
    const interfaces = collectContainerMethods(ctx, 'interface');
    if (interfaces.length === 0) return; // no Go interfaces → nothing to derive
    const structs = collectContainerMethods(ctx, 'struct');
    if (structs.length === 0) return;
    const edges = deriveImplementsEdges(structs, interfaces);
    if (edges.length > 0) {
      insertEdges(ctx.queries, edges);
    }
  } catch (err) {
    logDebug(`go-implements refresh failed: ${errMsg(err)}`);
  }
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, GO_IMPLEMENTS_ALGO_VERSION);
  } catch (err) {
    logDebug(`go-implements stamp failed: ${errMsg(err)}`);
  }
}

/**
 * Collect (container id, name, method-name set) for every Go container
 * of the given kind. One SQL groups all `contains` edges by source so
 * we don't issue a per-container query.
 */
function collectContainerMethods(ctx: IndexHookContext, kind: 'interface' | 'struct'): GoContainerMethods[] {
  const rows = ctx.queries.db
    .prepare(
      `SELECT c.id AS containerId, c.name AS containerName, m.name AS methodName
       FROM nodes c
       JOIN edges e ON e.source = c.id AND e.kind = 'contains'
       JOIN nodes m ON m.id = e.target AND m.kind = 'method'
       WHERE c.kind = ? AND c.language = 'go'`,
    )
    .all(kind) as Array<{ containerId: string; containerName: string; methodName: string }>;

  const byContainer = new Map<string, GoContainerMethods>();
  for (const row of rows) {
    let entry = byContainer.get(row.containerId);
    if (!entry) {
      entry = { id: row.containerId, name: row.containerName, methods: new Set() };
      byContainer.set(row.containerId, entry);
    }
    entry.methods.add(row.methodName);
  }
  return [...byContainer.values()];
}

/**
 * Derive `implements` edges from struct-side and interface-side method
 * sets. Empty interfaces (0 methods) are skipped — every struct trivially
 * satisfies them; emitting those edges would balloon to S × emptyCount
 * with zero signal value.
 *
 * B26 (2026-05-24) — uses an inverted index `methodName → Set<structId>`
 * to skip pairs that can't match. For each interface, the candidate
 * struct set starts as the structSet of the interface's most-discriminating
 * method (the one with the smallest structSet), then we intersect with
 * each remaining method's structSet. Result is exactly the structs that
 * have ALL of the interface's methods. Skips entire structs whose method
 * set doesn't overlap the interface at all instead of probing each one.
 */
function deriveImplementsEdges(structs: GoContainerMethods[], interfaces: GoContainerMethods[]): Edge[] {
  const edges: Edge[] = [];
  if (interfaces.length === 0 || structs.length === 0) return edges;

  // Build the inverted index ONCE. For typical Go corpora avg-methods-
  // per-struct is ~5, so this is O(S × 5) = a few thousand inserts.
  const methodToStructs = new Map<string, Set<string>>();
  for (const struct of structs) {
    for (const method of struct.methods) {
      let bucket = methodToStructs.get(method);
      if (!bucket) {
        bucket = new Set();
        methodToStructs.set(method, bucket);
      }
      bucket.add(struct.id);
    }
  }

  for (const iface of interfaces) {
    if (iface.methods.size === 0) continue;
    const candidates = findStructsSatisfyingInterface(iface, methodToStructs);
    for (const structId of candidates) {
      edges.push({ source: structId, target: iface.id, kind: 'implements' });
    }
  }
  return edges;
}

/**
 * Return the struct IDs that have ALL of the interface's methods. Walks
 * the interface methods ordered by their structSet size ascending — the
 * smallest set is the most-discriminating starting point, so the
 * candidate set shrinks fastest. Bails early when the candidate set
 * empties (no point intersecting further with nothing).
 */
function findStructsSatisfyingInterface(
  iface: GoContainerMethods,
  methodToStructs: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const methodSets: ReadonlySet<string>[] = [];
  for (const method of iface.methods) {
    const bucket = methodToStructs.get(method);
    // A method the interface declares but NO struct in the corpus
    // implements → no struct satisfies this interface; bail early.
    if (!bucket || bucket.size === 0) return new Set();
    methodSets.push(bucket);
  }
  // Sort ascending by size so we start from the most-discriminating
  // (smallest) set. Tiny cost (k log k for ~5 methods) vs the
  // potentially huge intersection-of-large-sets it avoids.
  methodSets.sort((a, b) => a.size - b.size);
  // `methodSets[0]` is guaranteed non-undefined here: the bail above
  // only returns when a bucket is missing OR empty, and every push
  // path requires both to hold. The `!` matches the `methodSets[i]!`
  // below and keeps the invariant visible to readers.
  let candidates = new Set<string>(methodSets[0]!);
  for (let i = 1; i < methodSets.length; i++) {
    const next = methodSets[i]!;
    const intersected = new Set<string>();
    for (const id of candidates) {
      if (next.has(id)) intersected.add(id);
    }
    candidates = intersected;
    if (candidates.size === 0) break;
  }
  return candidates;
}

export const HOOK: IndexHook = {
  name: 'go-implements',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx, result: SyncResult) {
    // Self-heal: when the stored algo version differs, force a re-mine
    // so an existing project picks up logic improvements on the next
    // sync without a manual `cartograph admin index`. Check precedes the
    // changed-files guard so a no-op sync also heals.
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== GO_IMPLEMENTS_ALGO_VERSION) {
      refresh(ctx);
      return;
    }
    // Sync trigger: any Go file changed → re-run the project-wide pass.
    // The relationship is cross-file (a struct in one file may newly
    // satisfy an interface in another), so per-file scoping doesn't
    // help here — but Go-file-edit-free syncs are skipped to keep
    // typical incremental work bounded.
    const changed = result.changedFilePaths ?? [];
    const anyGoChange = changed.some((p) => p.endsWith('.go')) || result.filesRemoved > 0;
    if (anyGoChange) refresh(ctx);
  },
};
