/**
 * Swift ↔ Objective-C bridging rules (B12 sub-channel 1, 2026-05-29).
 *
 * Apple's auto-bridging exposes Swift declarations to the ObjC runtime
 * under a deterministic selector. The reverse map — given an ObjC
 * selector, the candidate Swift base names a caller would use — is the
 * only direction the resolver needs (both resolve() directions key off
 * it: the Swift→ObjC map is built by running this over every ObjC method
 * node, and the ObjC→Swift lookup calls it on the inbound selector).
 *
 * Pure name math — no graph/DB access. Used by `frameworks/swift-objc.ts`.
 * Adapted from upstream commit `4d1a2b3c` (PR), reduced to the reverse
 * direction actually consumed (the forward `objcSelectorForSwift*` helpers
 * were dropped — the resolver never computes selectors, it indexes the
 * real ObjC method nodes by their candidate Swift base names).
 *
 * ─── Reverse cheat sheet ────────────────────────────────────────────
 *   ObjC selector          candidate Swift base names
 *   ───────────────────    ──────────────────────────────────────────
 *   play                   ['play']
 *   play:                  ['play']
 *   playWithSong:          ['play', 'playWithSong']   (Swift `play(song:)` OR a literal `playWithSong(_:)`)
 *   play:by:               ['play']
 *   initWithName:age:      ['init', 'initWithName']    (init is its own base name)
 *   objectForKey:          ['object', 'objectForKey']  (Cocoa preposition prefix)
 *   setName:               ['name', 'setName']         (setter OR a regular func)
 *   tableView:didSelect…:  ['tableView']
 */

/** Lowercase the first character — `setName:` setter ↔ Swift property `name`. */
function lowerFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * From an ObjC selector, return the candidate Swift base names the
 * resolver should try when looking for the bridged Swift declaration.
 * Returns multiple candidates because the bare base name is ambiguous
 * (`playWithSong:` could be `play(song:)` or a literal `playWithSong(_:)`).
 */
export function swiftBaseNamesForObjcSelector(selector: string): string[] {
  if (!selector) return [];

  // Strip trailing colons and split into keywords.
  const keywords = selector.replaceAll(/:+$/g, '').split(':');
  const firstKeyword = keywords[0];
  if (!firstKeyword) return [];

  const candidates = new Set<string>();

  // Always a candidate: the raw first keyword (`play:`→`play`,
  // `playWithSong:`→`playWithSong`, `tableView:…:`→`tableView`).
  candidates.add(firstKeyword);

  // `initWith<X>:` and `initWith<X>:<more>:` always reduce to `init`.
  if (firstKeyword.startsWith('initWith')) {
    candidates.add('init');
  }

  // Preposition-prefix patterns: `<base>(With|For|By|In|On|At|From|To|Of|As)<Cap>:`
  // covers Swift's @objc EXPORT rule (always "With") AND Cocoa IMPORTED
  // selectors that use other prepositions natively (`objectForKey:`,
  // `stringWithFormat:`, `imageNamed:inBundle:`). Recover the Swift base
  // name a caller would use (`object`, `string`, `image`).
  const prepositionMatch = /^([a-z][a-zA-Z0-9]*?)(?:With|For|By|In|On|At|From|To|Of|As)[A-Z]/.exec(firstKeyword);
  if (prepositionMatch?.[1]) {
    candidates.add(prepositionMatch[1]);
  }

  // `setX:` could be a property setter — the Swift property is `x`.
  // Only the obvious shape: `set` + capital + single keyword ending in `:`.
  if (keywords.length === 1 && /^set[A-Z]/.test(firstKeyword) && selector.endsWith(':')) {
    const propName = lowerFirst(firstKeyword.slice(3));
    if (propName) candidates.add(propName);
  }

  return Array.from(candidates);
}
