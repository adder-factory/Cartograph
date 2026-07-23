/**
 * Small patch-task corpus with source→test dependency edges and deliberate
 * shape-symbol distractors. It is separate from the ranking fixture because
 * this suite scores edit files and affected tests, not only symbol order.
 */
export const PATCH_FIXTURE_FILES: Readonly<Record<string, string>> = {
  'src/sync.ts': `export interface SyncResult { changed: number; }

/** Re-index the files supplied by the watcher. */
export function runSync(files: string[]): SyncResult {
  return { changed: files.length };
}
`,
  'src/watcher.ts': `import { runSync } from './sync.js';

export interface WatcherOptions { debounceMs: number; }
export interface WatcherState { pending: string[]; running: boolean; }

/** Gate filesystem events before an incremental sync is triggered. */
export function watcherHandleFileEvent(state: WatcherState, filePath: string): void {
  if (filePath.length === 0) return;
  state.pending.push(filePath);
  runSync(state.pending);
}

export class FileWatcher {
  private state: WatcherState = { pending: [], running: false };
  constructor(private readonly options: WatcherOptions) {}
  onEvent(filePath: string): void { watcherHandleFileEvent(this.state, filePath); }
}
`,
  'src/auth.ts': `export interface AuthSession { userId: string; token: string; }

/** Reject malformed authentication tokens before session creation. */
export function validateToken(token: string): boolean {
  return token.startsWith('token:');
}

export function authenticateUser(userId: string, token: string): AuthSession | null {
  if (!validateToken(token)) return null;
  return { userId, token };
}
`,
  'src/payment.ts': `export interface PaymentResult { ok: boolean; amount: number; }

export function processPayment(amount: number): PaymentResult {
  return { ok: amount > 0, amount };
}

/** Reverse a charge without accepting a negative refund input. */
export function refundPayment(amount: number): PaymentResult {
  return processPayment(Math.abs(amount));
}
`,
  'src/postgres-maintenance.ts': `export const POSTGRES_ANALYZE_CURRENT_SCHEMA_SQL = 'ANALYZE';
export interface SyncWriteResult { filesModified: number; hookWrites: number; }
export interface MaintenanceDb { exec(sql: string): void; }

/** Decide whether incremental indexing wrote enough to refresh planner statistics. */
export function cgSyncHasDatabaseWrites(result: SyncWriteResult): boolean {
  return result.filesModified > 0 || result.hookWrites > 0;
}

export function dbRunMaintenance(db: MaintenanceDb): void {
  db.exec(POSTGRES_ANALYZE_CURRENT_SCHEMA_SQL);
}

/** Skip PostgreSQL ANALYZE when sync made no database writes. */
export function syncPostgresGraph(result: SyncWriteResult, db: MaintenanceDb): void {
  if (cgSyncHasDatabaseWrites(result)) dbRunMaintenance(db);
}
`,
  'tests/watcher.test.ts': `import { describe, expect, it } from 'vitest';
import { watcherHandleFileEvent, type WatcherState } from '../src/watcher.js';

describe('watcher event gate', () => {
  it('ignores an empty path', () => {
    const state: WatcherState = { pending: [], running: true };
    watcherHandleFileEvent(state, '');
    expect(state.pending).toEqual([]);
  });
});
`,
  'tests/auth.test.ts': `import { describe, expect, it } from 'vitest';
import { authenticateUser, validateToken } from '../src/auth.js';

describe('authentication tokens', () => {
  it('rejects malformed tokens', () => {
    expect(validateToken('bad')).toBe(false);
    expect(authenticateUser('u1', 'bad')).toBeNull();
  });
});
`,
  'tests/payment.test.ts': `import { describe, expect, it } from 'vitest';
import { refundPayment } from '../src/payment.js';

describe('refunds', () => {
  it('normalizes the amount', () => {
    expect(refundPayment(-2).amount).toBe(2);
  });
});
`,
  'tests/postgres-maintenance.test.ts': `import { describe, expect, it, vi } from 'vitest';
import { syncPostgresGraph } from '../src/postgres-maintenance.js';

describe('PostgreSQL maintenance', () => {
  it('skips planner refresh after a no-op sync', () => {
    const exec = vi.fn();
    syncPostgresGraph({ filesModified: 0, hookWrites: 0 }, { exec });
    expect(exec).not.toHaveBeenCalled();
  });
});
`,
};
