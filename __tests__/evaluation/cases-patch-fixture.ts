import { PatchTaskCaseSchema, type PatchTaskCase } from './patch-types.js';

export const patchFixtureCases: PatchTaskCase[] = [
  {
    id: 'watcher-empty-path',
    task: 'Fix the watcher event gate so an empty file path never triggers incremental sync',
    expectedSymbols: ['watcherHandleFileEvent'],
    expectedEditFiles: ['src/watcher.ts'],
    expectedTestFiles: ['tests/watcher.test.ts'],
  },
  {
    id: 'auth-malformed-token',
    task: 'Reject a malformed authentication token before creating an AuthSession',
    expectedSymbols: ['validateToken', 'authenticateUser'],
    expectedEditFiles: ['src/auth.ts'],
    expectedTestFiles: ['tests/auth.test.ts'],
  },
  {
    id: 'refund-negative-input',
    task: 'Fix refund processing so a negative refund input is normalized before charging',
    expectedSymbols: ['refundPayment', 'processPayment'],
    expectedEditFiles: ['src/payment.ts'],
    expectedTestFiles: ['tests/payment.test.ts'],
  },
  {
    id: 'postgres-noop-maintenance',
    task: 'When incremental indexing makes no writes, avoid refreshing PostgreSQL planner statistics',
    expectedSymbols: ['syncPostgresGraph', 'cgSyncHasDatabaseWrites'],
    expectedEditFiles: ['src/postgres-maintenance.ts'],
    expectedTestFiles: ['tests/postgres-maintenance.test.ts'],
  },
  {
    id: 'absent-mobile-push',
    task: 'Change the mobile push-notification retry backoff and APNS delivery policy',
    expectedSymbols: [],
    expectedEditFiles: [],
    expectedTestFiles: [],
    shouldAbstain: true,
  },
].map((testCase) => PatchTaskCaseSchema.parse(testCase));
