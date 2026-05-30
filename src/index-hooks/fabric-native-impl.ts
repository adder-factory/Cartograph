/**
 * Fabric native-impl bridge hook (B12 sub-channel 4, 2026-05-29).
 *
 * The cross-language edge of the Fabric/Paper view-component channel: links
 * each synthesized `fabric-component:` node (a JS view component, from
 * `frameworks/fabric.ts`) to its native implementation CLASS by React Native's
 * name+suffix convention — component `Foo` → native class `Foo` / `FooView` /
 * `FooViewManager` / `FooComponentView` / `FooManager`. So `trace`/`callers`
 * walk from a JSX `<Foo>` usage (resolved to the component node by name) all
 * the way through to the ObjC/Kotlin/Java/C++ renderer.
 *
 * This is a node→node link established post-extraction by convention (not a
 * ref to resolve), so it lives as an index-hook — the fork's home for
 * cross-language synthesizers (cf. `go-implements`, `drupal-service-tags`) —
 * rather than in the resolver. Upstream put the equivalent
 * (`fabricNativeImplEdges`) in a `callback-synthesizer.ts` that doesn't exist
 * here. Self-heals via `FABRIC_NATIVE_IMPL_ALGO_VERSION` like every fork hook.
 */
import type { IndexHook, IndexHookContext } from './types.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge, Node } from '../types.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { insertEdges } from '../db/queries-edges.js';
import { getNodesByKind } from '../db/queries.js';
import { logDebug, errMsg } from '../errors.js';

/** Algo-version SHA from this file's source — a matching-logic change forces a
 *  one-shot full re-mine on the next sync (mirrors GO_IMPLEMENTS_ALGO_VERSION). */
export const FABRIC_NATIVE_IMPL_ALGO_VERSION = computeAlgoHash(import.meta.url, ['./fabric-native-impl']);
const LAST_MINED_KEY = 'last_mined_fabric_native_impl_algo_version';
const SYNTHESIZED_BY = 'fabric-native-impl';

/** RN view-component → native-class name conventions. Order is cosmetic (each
 *  match yields one edge; iOS + Android each have one native class). */
const FABRIC_NATIVE_SUFFIXES = ['', 'View', 'ViewManager', 'ComponentView', 'Manager'];
const NATIVE_LANGUAGES = new Set(['objc', 'kotlin', 'java', 'cpp']);

/** Pre-index native (objc/kotlin/java/cpp) class nodes by name for O(1) lookup. */
function indexNativeClassesByName(ctx: IndexHookContext): Map<string, Node[]> {
  const map = new Map<string, Node[]>();
  for (const n of getNodesByKind(ctx.queries, 'class')) {
    if (!NATIVE_LANGUAGES.has(n.language)) continue;
    const arr = map.get(n.name);
    if (arr) arr.push(n);
    else map.set(n.name, [n]);
  }
  return map;
}

/** Native class nodes whose name is `componentName` + a known suffix, paired
 *  with the suffix that matched (for edge provenance). */
function nativeCandidates(
  componentName: string,
  nativeByName: Map<string, Node[]>,
): Array<{ native: Node; suffix: string }> {
  const out: Array<{ native: Node; suffix: string }> = [];
  for (const suffix of FABRIC_NATIVE_SUFFIXES) {
    for (const native of nativeByName.get(componentName + suffix) ?? []) out.push({ native, suffix });
  }
  return out;
}

/** Component → native-class bridge edges, deduped by (component, native). */
function buildBridgeEdges(components: Node[], nativeByName: Map<string, Node[]>): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const component of components) {
    for (const { native, suffix } of nativeCandidates(component.name, nativeByName)) {
      const key = `${component.id}>${native.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: component.id,
        target: native.id,
        kind: 'references',
        metadata: { synthesizedBy: SYNTHESIZED_BY, viaSuffix: suffix || '(exact)', componentName: component.name },
      });
    }
  }
  return edges;
}

function refresh(ctx: IndexHookContext): void {
  try {
    // Clean slate: drop prior synthesized bridge edges so an algo/logic change
    // (or a renamed component the new run no longer matches) can't leave stale
    // edges. FK CASCADE already clears edges whose endpoint node was removed.
    ctx.queries.db
      .prepare(`DELETE FROM edges WHERE kind = 'references' AND json_extract(metadata, '$.synthesizedBy') = ?`)
      .run(SYNTHESIZED_BY);

    const components = getNodesByKind(ctx.queries, 'component').filter((n) => n.id.startsWith('fabric-component:'));
    if (components.length > 0) {
      const edges = buildBridgeEdges(components, indexNativeClassesByName(ctx));
      if (edges.length > 0) insertEdges(ctx.queries, edges);
    }
  } catch (err) {
    logDebug(`fabric-native-impl refresh failed: ${errMsg(err)}`);
  }
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, FABRIC_NATIVE_IMPL_ALGO_VERSION);
  } catch (err) {
    logDebug(`fabric-native-impl stamp failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'fabric-native-impl',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx, result: SyncResult) {
    // Self-heal: a stored-algo mismatch forces a re-mine before the changed-file
    // guard, so a no-op sync also heals after a logic change.
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== FABRIC_NATIVE_IMPL_ALGO_VERSION) {
      refresh(ctx);
      return;
    }
    // Cross-file relationship (component in a .ts spec, native class in a
    // .m/.mm/.java/.kt/C++ file) → any touched spec or native file re-runs the
    // project-wide pass. Covers C++ FabricComponentView classes (.cpp/.h) since
    // `cpp` is a matched native language.
    const changed = result.changedFilePaths ?? [];
    const relevant =
      changed.some((p) => /\.(tsx?|mm?|java|kt|cpp|cc|cxx|hpp|hh|h)$/.test(p)) || result.filesRemoved > 0;
    if (relevant) refresh(ctx);
  },
};
