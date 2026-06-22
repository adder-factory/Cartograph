/**
 * G9 invariance tests for the grouped hook runner.
 *
 * After Phase 1 + Phase 2A the registry runs hooks in three serial
 * groups (A → B → C), with per-group concurrency controlled by the
 * registry. The runtime outcomes must stay equivalent to the prior
 * serial loop for two reasons:
 *
 *   1. Cross-group ordering is load-bearing — `unused_export` reads
 *      `references` edges emitted by Group B's edge-emitters;
 *      `low_coverage` reads node_coverage rows restored by COVERAGE_REAPPLY.
 *      Group C must observe Group B's writes. The serial walk used to
 *      enforce this implicitly; the grouped runner enforces it by
 *      awaiting one group before starting the next.
 *
 *   2. The hook outcome array shape stays one entry per registered
 *      hook with a string `name`, a phase tag, and a numeric duration —
 *      this is what the index-hooks contract tests already assert.
 *      Tests here re-verify with the grouped runner so a future
 *      refactor that drops outcomes or reorders them surfaces here.
 */
import { describe, it, expect } from 'vitest';
import { getRegisteredHooks, runAfterIndexAll, runAfterSync } from '../src/index-hooks/registry.js';
import type { SyncResult } from '../src/extraction/index.js';
import { withFakeIndexHookContext } from './helpers/fake-index-hook-context.js';

const fakeSyncResult: SyncResult = {
  filesChecked: 0,
  filesAdded: 0,
  filesModified: 0,
  filesRemoved: 0,
  nodesUpdated: 0,
  durationMs: 0,
};

describe('G9 hook-group invariance', () => {
  // The expected groups mirror HOOK_GROUPS in registry.ts. Test
  // is intentionally redundant with the source — a refactor that
  // reshapes the groups should surface here (and prompt a re-read
  // of the load-bearing ordering rationale in the runtime file).
  const EXPECTED_GROUP_A = new Set(['role-restore', 'churn', 'cochange', 'issue-history']);
  const EXPECTED_GROUP_B = new Set([
    'build-context-refs',
    'config-refs',
    'dynamic-import-edges',
    'dynamic-dispatch',
    're-export-edges',
    'sql-refs',
    'string-imports',
    'value-ref-edges',
    'go-implements',
    'nestjs-routes',
    'spring-value-binding',
    'mybatis-binding',
    'drupal-hooks',
    'drupal-plugins',
    'drupal-service-tags',
    'fabric-native-impl',
    'rn-event-channel',
    'tests-edges',
    'test-names',
    'coverage-reapply',
    'derived-relink',
    'promote-nested-fn',
  ]);
  const EXPECTED_GROUP_C = new Set(['biomarkers', 'centrality', 'betweenness']);

  it('REGISTERED_HOOKS flat union covers all three groups, in A→B→C order', () => {
    const names = getRegisteredHooks().map((h) => h.name);
    const sizeA = EXPECTED_GROUP_A.size;
    const sizeB = EXPECTED_GROUP_B.size;
    const sizeC = EXPECTED_GROUP_C.size;
    expect(names.length).toBe(sizeA + sizeB + sizeC);

    const got = {
      a: new Set(names.slice(0, sizeA)),
      b: new Set(names.slice(sizeA, sizeA + sizeB)),
      c: new Set(names.slice(sizeA + sizeB)),
    };
    expect(got.a).toEqual(EXPECTED_GROUP_A);
    expect(got.b).toEqual(EXPECTED_GROUP_B);
    expect(got.c).toEqual(EXPECTED_GROUP_C);
  });

  it('edge-emitters precede biomarkers (the load-bearing cross-group rule)', () => {
    const names = getRegisteredHooks().map((h) => h.name);
    const biomarkersIdx = names.indexOf('biomarkers');
    const coverageReapplyIdx = names.indexOf('coverage-reapply');
    const reExportEdgesIdx = names.indexOf('re-export-edges');
    const valueRefEdgesIdx = names.indexOf('value-ref-edges');
    expect(biomarkersIdx).toBeGreaterThan(coverageReapplyIdx);
    expect(biomarkersIdx).toBeGreaterThan(reExportEdgesIdx);
    expect(biomarkersIdx).toBeGreaterThan(valueRefEdgesIdx);
  });

  it('runAfterIndexAll outcome ordering preserves the flat registered order', async () => {
    // The grouped runner preserves declared hook order whether a group
    // runs concurrently or sequentially, so outcome names must match
    // getRegisteredHooks().
    const outcomes = await withFakeIndexHookContext((ctx) => runAfterIndexAll(ctx));
    const registered = getRegisteredHooks().filter((h) => h.afterIndexAll);
    expect(outcomes.length).toBe(registered.length);
    for (let i = 0; i < outcomes.length; i++) {
      expect(outcomes[i]!.name).toBe(registered[i]!.name);
      expect(outcomes[i]!.phase).toBe('indexAll');
      expect(typeof outcomes[i]!.durationMs).toBe('number');
    }
  });

  it('runAfterSync outcome ordering preserves the flat registered order', async () => {
    const outcomes = await withFakeIndexHookContext((ctx) => runAfterSync(ctx, fakeSyncResult));
    const registered = getRegisteredHooks().filter((h) => h.afterSync);
    expect(outcomes.length).toBe(registered.length);
    for (let i = 0; i < outcomes.length; i++) {
      expect(outcomes[i]!.name).toBe(registered[i]!.name);
      expect(outcomes[i]!.phase).toBe('sync');
    }
  });
});
