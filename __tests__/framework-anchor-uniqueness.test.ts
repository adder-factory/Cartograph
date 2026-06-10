/**
 * Framework-resolver anchors must be GLOBALLY unique across resolvers:
 * the extraction anchor automaton (`buildAnchorIndex` in
 * extraction-phases.ts) maps each anchor string to exactly one owner and
 * THROWS on a collision. That throw fires at index time, where it
 * manifests as a silent "0 files indexed" rather than a clear failure —
 * so this test pins the invariant at the registry level, failing fast
 * (and naming the colliding resolvers) the moment a new anchor clashes.
 */

import { describe, it, expect } from 'vitest';
import { getAllFrameworkResolvers } from '../src/resolution/frameworks/index.js';

describe('framework resolver anchors are globally unique', () => {
  it('no anchor string is declared by two different resolvers', () => {
    const owners = new Map<string, string>();
    const collisions: string[] = [];
    for (const resolver of getAllFrameworkResolvers()) {
      for (const anchor of resolver.anchors ?? []) {
        const prior = owners.get(anchor);
        if (prior !== undefined && prior !== resolver.name) {
          collisions.push(`${JSON.stringify(anchor)}: '${prior}' vs '${resolver.name}'`);
        } else {
          owners.set(anchor, resolver.name);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});
