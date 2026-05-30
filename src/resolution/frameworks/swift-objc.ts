/**
 * Swift ↔ Objective-C bridge resolver (B12 sub-channel 1, 2026-05-29).
 *
 * Closes the cross-language call gap in mixed iOS codebases. The pure
 * bridging name math lives in `../swift-objc-bridge.ts`; this file wires it
 * into the resolution pipeline. Adapted from upstream `4d1a2b3c` with this
 * fork's audit fix: `@objc` exposure is read from `Node.decorators`
 * (captured structurally by the Swift extractor) rather than re-reading a
 * source window per resolve.
 *
 * **Two directions:**
 *  1. Swift call → ObjC method — Swift `imageDownloader.download(url:)` reaches
 *     us as the bare callee `download` (tree-sitter-swift strips arg labels).
 *     We index every ObjC method node under its candidate Swift base names
 *     (reverse bridge map) and look `download` up there.
 *  2. ObjC call → Swift method — ObjC `[swiftThing fooWithBar:42]` reaches us
 *     as the full selector `fooWithBar:` (since F#82a). When a real ObjC
 *     method owns that selector the name-matcher resolves it (its node is
 *     `fooWithBar:` too) and this bridge bails; otherwise the target is a
 *     colon-free Swift `@objc` node, so we derive candidate base names
 *     (`['fooWithBar','foo']`) and match `@objc` Swift methods of those names.
 *
 * A selector-shape ref whose target is a Swift method matches no node (Swift
 * node names are colon-free), so it can't pass the resolver's known-node
 * pre-filter and `claimsReference` opts it in. Every edge is
 * `resolvedBy: 'framework'`, confidence 0.6.
 *
 * Both exposure forms are honored: a method's OWN `@objc`, AND class-level
 * `@objcMembers` (blanket-exposes every member, `@nonobjc` still opts out) —
 * see `isNodeObjcExposed` / `buildObjcMembersExposedSet`.
 */
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';
import type { Node } from '../../types.js';
import { swiftBaseNamesForObjcSelector } from '../swift-objc-bridge.js';

/**
 * Generic Cocoa/NSObject names that almost every ObjC class implements.
 * Bridging a Swift `init()` / `description` to an arbitrary project-local
 * ObjC method of the same name is noise; these also resolve via the regular
 * name-matcher anyway, so the bridge skips them.
 */
const GENERIC_NAMES = new Set([
  'init',
  'description',
  'debugDescription',
  'hash',
  'isEqual',
  'copy',
  'mutableCopy',
  'class',
  'self',
  'count',
  'length',
  'value',
  'name',
  'data',
  'string',
  'object',
  'load',
  'save',
  'dealloc',
  'release',
  'retain',
  'autorelease',
]);

/**
 * Memoized "Swift base name → ObjC method nodes" reverse-bridge map, keyed
 * by ResolutionContext identity (so the daemon's multiple projects don't
 * share a map). Built lazily on first resolve. Invalidated by `clearCache`
 * at every resolution-pass boundary (`ReferenceResolver.clearCaches`, which
 * runs on sync AND indexAll) — the context is long-lived and reused across
 * syncs, so without that invalidation a sync adding ObjC methods would leave
 * this map stale until the next full reindex.
 */
const objcByCandidateSwiftBase = new WeakMap<ResolutionContext, Map<string, Node[]>>();

/** Build the reverse-bridge map: for every ObjC method node, record it under
 *  each Swift base name that would auto-bridge to its selector. */
function buildObjcMap(context: ResolutionContext): Map<string, Node[]> {
  const cached = objcByCandidateSwiftBase.get(context);
  if (cached) return cached;

  const map = new Map<string, Node[]>();
  const objcMethods = context.getNodesByKind('method').filter((n) => n.language === 'objc');
  for (const node of objcMethods) {
    for (const candidate of swiftBaseNamesForObjcSelector(node.name)) {
      // Skip the trivial verbatim case (no colons) — the name-matcher
      // already handles it — and generic Cocoa names (noise).
      if (candidate === node.name && !node.name.includes(':')) continue;
      if (GENERIC_NAMES.has(candidate)) continue;
      const arr = map.get(candidate);
      if (arr) arr.push(node);
      else map.set(candidate, [node]);
    }
  }
  objcByCandidateSwiftBase.set(context, map);
  return map;
}

/** Strip a `receiver.member` / `obj.foo:bar:` prefix to the bare name. */
function stripReceiverPrefix(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
}

/**
 * Memoized set of Swift method/function node IDs exposed to ObjC via a
 * class-level `@objcMembers` (the attribute blanket-exposes every member of
 * the class; an individual member still opts out with `@nonobjc`). Keyed by
 * ResolutionContext like the reverse-bridge map, and invalidated in
 * `clearCache`. Containment is resolved by line-range within the class's file:
 * ResolutionContext exposes no edge/container query, and `getNodesInFile` +
 * `[startLine, endLine]` enclosure is robust for the direct members
 * `@objcMembers` actually exposes.
 */
const objcMembersExposedIds = new WeakMap<ResolutionContext, Set<string>>();

function buildObjcMembersExposedSet(context: ResolutionContext): Set<string> {
  const cached = objcMembersExposedIds.get(context);
  if (cached) return cached;
  const set = new Set<string>();
  const objcMembersClasses = context
    .getNodesByKind('class')
    .filter((c) => c.language === 'swift' && c.decorators?.includes('objcMembers'));
  for (const cls of objcMembersClasses) {
    for (const n of context.getNodesInFile(cls.filePath)) {
      if ((n.kind === 'method' || n.kind === 'function') && n.startLine >= cls.startLine && n.endLine <= cls.endLine) {
        set.add(n.id);
      }
    }
  }
  objcMembersExposedIds.set(context, set);
  return set;
}

/** A Swift declaration is bridged to ObjC when it carries `@objc` (and not
 *  `@nonobjc`), OR when its containing class carries `@objcMembers` — which
 *  blanket-exposes every member (an individual `@nonobjc` still opts out).
 *  Read structurally off node decorators + class containment — no source
 *  re-read. */
function isNodeObjcExposed(node: Node, context: ResolutionContext): boolean {
  const decorators = node.decorators;
  if (decorators?.includes('nonobjc')) return false;
  if (decorators?.includes('objc')) return true;
  return buildObjcMembersExposedSet(context).has(node.id);
}

/** Swift caller → ObjC method, via the reverse-bridge map. */
function resolveSwiftCallToObjc(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const target = buildObjcMap(context).get(stripReceiverPrefix(ref.referenceName))?.[0];
  if (!target) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.6, resolvedBy: 'framework' };
}

/** ObjC caller selector → `@objc` Swift method, via candidate base names.
 *  Since F#82a the ObjC extractor reconstructs the FULL selector on call refs
 *  (`[d fooWithBar:42]` → ref `d.fooWithBar:`), matching how the
 *  method-definition node is named — so a call whose target is a real ObjC
 *  method resolves through the plain name-matcher and this bridge BAILS on it.
 *  The bridge then fires only when the target is a colon-free Swift `@objc`
 *  node (`fooWithBar`/`foo`), which the name-matcher can't reach from the
 *  colon-bearing ref. `swiftBaseNamesForObjcSelector` strips the trailing
 *  colons internally and offers both the identity base and any
 *  preposition/setter reduction. */
function resolveObjcCallToSwift(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const raw = stripReceiverPrefix(ref.referenceName);
  // A real ObjC method owns this exact selector → it's an ObjC→ObjC call;
  // defer to the name-matcher. The name-matcher's exact match usually
  // out-ranks this 0.6 candidate anyway, but bailing also covers the
  // low-confidence (ambiguous / multi-match) ObjC case and states the intent
  // explicitly — a regression once call refs carry colons (F#82a).
  if (context.getNodesByName(raw).some((n) => n.language === 'objc')) return null;
  for (const candidate of swiftBaseNamesForObjcSelector(raw)) {
    const match = context
      .getNodesByName(candidate)
      .find(
        (n) =>
          n.language === 'swift' && (n.kind === 'method' || n.kind === 'function') && isNodeObjcExposed(n, context),
      );
    if (match) return { original: ref, targetNodeId: match.id, confidence: 0.6, resolvedBy: 'framework' };
  }
  return null;
}

export const swiftObjcBridgeResolver: FrameworkResolver = {
  name: 'swift-objc-bridge',
  // Bridging crosses the boundary, so it runs on both languages.
  languages: ['swift', 'objc'],

  /** Relevant only when the project has BOTH Swift and ObjC source —
   *  either-side-only projects need no bridge (the map is a no-op anyway). */
  detect(context) {
    let hasSwift = false;
    let hasObjc = false;
    for (const f of context.getAllFiles()) {
      if (f.endsWith('.swift')) hasSwift = true;
      else if (f.endsWith('.m') || f.endsWith('.mm')) hasObjc = true;
      if (hasSwift && hasObjc) return true;
    }
    return false;
  },

  /** Opt a selector-shaped ref past the known-node pre-filter. Since F#82a
   *  arg-carrying ObjC call refs carry colons (`fooWithBar:`); a Swift `@objc`
   *  target's node is colon-free (`fooWithBar`/`foo`), so the pre-filter finds
   *  no node for the ref and would drop it — we opt those in. Colonless no-arg
   *  sends (`play`) already match a Swift `play` node by name, so they need no
   *  opt-in (the `some(c !== raw)` test is false for them). Over-claiming a
   *  selector that a real ObjC method owns is harmless: `resolveObjcCallToSwift`
   *  bails on it and the ref falls through to the name-matcher. Consulted only
   *  for DETECTED frameworks, so the opt-in stays project-scoped. */
  claimsReference(name) {
    const raw = stripReceiverPrefix(name);
    return swiftBaseNamesForObjcSelector(raw).some((c) => c !== raw);
  },

  resolve(ref, context) {
    if (ref.language === 'swift') return resolveSwiftCallToObjc(ref, context);
    if (ref.language === 'objc') return resolveObjcCallToSwift(ref, context);
    return null;
  },

  /** Drop the per-context memoized maps so a sync that changed ObjC method
   *  nodes (or Swift `@objcMembers` classes) rebuilds them on the next resolve
   *  — the context is reused across syncs, so the WeakMap entries would
   *  otherwise persist stale. */
  clearCache(context) {
    objcByCandidateSwiftBase.delete(context);
    objcMembersExposedIds.delete(context);
  },
};
