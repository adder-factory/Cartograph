/**
 * Unit tests for `labelSymbol` / `labelMethodWithParent` — the
 * Snorkel-style weak labelers in `src/llm/role-labeler.ts`.
 *
 * Focuses on the rule cascade ordering and the new business-name
 * prefix rule (friction F-J / F-L closure). The other rules are
 * indirectly exercised by the universal-role-head training script
 * but had no dedicated unit coverage before this file.
 */

import { describe, it, expect } from 'vitest';
import { labelSymbol } from '../src/llm/role-labeler.js';
import type { LabelerInput } from '../src/llm/role-labeler.js';

/** Build a minimal `LabelerInput` with sensible defaults. Each test
 *  overrides only the fields it cares about. */
function input(overrides: Partial<LabelerInput> = {}): LabelerInput {
  return {
    nodeId: 'n_test',
    kind: 'function',
    filePath: 'src/foo.ts',
    name: 'foo',
    signature: null,
    decorators: [],
    fileImports: [],
    ...overrides,
  };
}

describe('labelSymbol — business-name prefix rule (F-J / F-L)', () => {
  it('classifies `applyExtractionLogicVersionHeal` as business_logic via the prefix rule', () => {
    const result = labelSymbol(input({ name: 'applyExtractionLogicVersionHeal', kind: 'function' }));
    expect(result).not.toBeNull();
    expect(result?.role).toBe('business_logic');
    expect(result?.source).toBe('name');
    expect(result?.rule).toBe('business name prefix');
    // Confidence should be medium — the rule is project-style, not
    // an extractor-deterministic structural signal.
    expect(result?.confidence).toBe('medium');
  });

  it('classifies `eoRunParseOrCached` as business_logic via the prefix rule', () => {
    const result = labelSymbol(input({ name: 'eoRunParseOrCached', kind: 'function' }));
    expect(result?.role).toBe('business_logic');
    expect(result?.source).toBe('name');
    expect(result?.rule).toBe('business name prefix');
  });

  it('fires on every documented business-name prefix', () => {
    const cases = [
      'applyRoleHeadHeal',
      'healStaleArtifacts',
      'migrateRoleAssignments',
      'restoreRolesFromAssignments',
      'cgRunIndexUnderLock',
      'eoProcessOneFile',
    ];
    for (const name of cases) {
      const result = labelSymbol(input({ name, kind: 'function' }));
      expect(result?.role, `prefix rule should fire on ${name}`).toBe('business_logic');
      expect(result?.rule).toBe('business name prefix');
    }
  });

  it('fires on `method` kind, not only `function`', () => {
    // Class methods can carry the same prefixes (e.g. an internal
    // helper named `applyMigration` on an Indexer class).
    const result = labelSymbol(input({ name: 'applyMigration', kind: 'method' }));
    expect(result?.role).toBe('business_logic');
    expect(result?.rule).toBe('business name prefix');
  });

  it('does NOT fire on substring collisions like `videoEncoder` or `applesAndOranges`', () => {
    // The `[A-Z]` anchor after the prefix enforces camelCase boundary —
    // these must NOT be tagged business_logic via the prefix rule.
    const videoRes = labelSymbol(input({ name: 'videoEncoder', kind: 'function' }));
    // `videoEncoder` should fall through to the residue rule (low
    // business_logic) — what matters is it's NOT tagged via the
    // 'business name prefix' rule.
    expect(videoRes?.rule).not.toBe('business name prefix');

    const applesRes = labelSymbol(input({ name: 'applesAndOranges', kind: 'function' }));
    expect(applesRes?.rule).not.toBe('business name prefix');
  });

  it('does NOT fire on getter-like names (`getFoo`, `isReady`, `hasItems`)', () => {
    // Negative case from the F-J brief: `getFoo` and similar verbs
    // must continue through the original cascade, not get short-
    // circuited by the new prefix rule.
    for (const name of ['getFoo', 'isReady', 'hasItems', 'parseInt', 'formatDate']) {
      const result = labelSymbol(input({ name, kind: 'function' }));
      expect(result?.rule, `prefix rule should not fire on ${name}`).not.toBe('business name prefix');
    }
  });

  it('the prefix rule beats framework-import-glue for business-named functions in framework-importing files', () => {
    // Without the new rule, this function would fall into rule 9
    // ('framework-import-bearing file' → framework_glue). With the
    // new rule, business-named functions stay in business_logic.
    const result = labelSymbol(
      input({
        name: 'applyMigration',
        kind: 'function',
        fileImports: ['express'],
      }),
    );
    expect(result?.role).toBe('business_logic');
    expect(result?.rule).toBe('business name prefix');
  });
});

describe('labelSymbol — cascade ordering (regression guard)', () => {
  it('test-file path still wins over the new business-prefix rule', () => {
    // `applyMigration` in a __tests__/ file is still a test_helper —
    // the structural pre-filter (rule 1) runs first.
    const result = labelSymbol(
      input({
        name: 'applyMigration',
        kind: 'function',
        filePath: '__tests__/migrations.test.ts',
      }),
    );
    expect(result?.role).toBe('test_helper');
  });

  it('interface kind still wins over the new business-prefix rule', () => {
    // An interface named `applyFoo` would be data_model via rule 1.
    const result = labelSymbol(input({ name: 'applyFoo', kind: 'interface' }));
    expect(result?.role).toBe('data_model');
  });
});
