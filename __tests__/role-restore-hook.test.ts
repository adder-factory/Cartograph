import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as errorModule from '../src/errors.js';
import type { IndexHookContext } from '../src/index-hooks/registry.js';

const state = {
  hasTable: false,
  changes: 0,
  throwOnTableCheck: false,
  calls: [] as string[],
};

vi.spyOn(errorModule, 'logDebug').mockImplementation(((message: string) => state.calls.push(message)) as never);

const { HOOK } = await import('../src/index-hooks/role-restore.js');

function ctx(): IndexHookContext {
  return {
    db: {
      getDb: () => ({
        prepare: (sql: string) => {
          if (sql.includes('sqlite_master')) {
            return {
              get: () => {
                if (state.throwOnTableCheck) throw new Error('schema unavailable');
                return state.hasTable ? { ok: 1 } : null;
              },
            };
          }
          return {
            run: () => {
              state.calls.push('restore-query');
              return { changes: state.changes };
            },
          };
        },
      }),
    },
  } as IndexHookContext;
}

beforeEach(() => {
  state.hasTable = false;
  state.changes = 0;
  state.throwOnTableCheck = false;
  state.calls = [];
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('role-restore hook', () => {
  it('skips restore when the role_assignments table is absent', () => {
    HOOK.afterIndexAll(ctx());
    expect(state.calls).toEqual([]);
  });

  it('runs the restore query and logs when rows are restored', () => {
    state.hasTable = true;
    state.changes = 3;

    HOOK.afterSync(ctx());

    expect(state.calls).toEqual(['restore-query', 'role-restore hook: restored 3 role assignments']);
  });

  it('swallows schema/query failures as best-effort hook failures', () => {
    state.throwOnTableCheck = true;

    HOOK.afterIndexAll(ctx());

    expect(state.calls).toEqual(['role-restore hook failed: schema unavailable']);
  });
});
