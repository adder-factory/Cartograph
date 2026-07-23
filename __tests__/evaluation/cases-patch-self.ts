import { PatchTaskCaseSchema, type PatchTaskCase } from './patch-types.js';

/** Patch tasks grounded in Cartograph's own current source/test graph. */
export const patchSelfCases: PatchTaskCase[] = [
  {
    id: 'self-pgvector-dimension-retirement',
    task: 'Fix obsolete pgvector dimension tables left behind after an embedding model migration',
    expectedSymbols: ['reconcilePgvectorStoreTables'],
    expectedEditFiles: ['src/db/pgvector-helpers.ts'],
    expectedTestFiles: ['__tests__/pgvector-helpers.test.ts'],
  },
  {
    id: 'self-protected-legacy-embedding-refs',
    task: 'Preserve legacy embedding refs when a node has no stored active-model replacement during cleanup',
    expectedSymbols: ['protectedLegacyStoreRowsQuery', 'cleanupObsoleteEmbeddings', 'collectCleanupProjection'],
    expectedEditFiles: ['src/features/embedding-maintenance/runtime.ts'],
    expectedTestFiles: ['__tests__/embedding-maintenance-feature.test.ts'],
  },
  {
    id: 'self-force-hybrid-patch-context',
    task: 'Allow patch context to force hybrid retrieval even when the task is not phrased as a behavior question',
    expectedSymbols: ['prepareBehaviorRetrieval'],
    expectedEditFiles: ['src/context/behavior-retrieval.ts'],
    expectedTestFiles: ['__tests__/context-behavior-retrieval.test.ts'],
  },
  {
    id: 'self-affected-test-tiers',
    task: 'Rank direct and likely tests for changed files in affected-test selection',
    expectedSymbols: ['findAffectedTests', 'candidateForDistance'],
    expectedEditFiles: ['src/features/affected/affected-core.ts'],
    expectedTestFiles: ['__tests__/affected-core-v2.test.ts'],
  },
  {
    id: 'self-unified-verification-plan',
    task: 'Build one verification workflow that selects affected tests and the project quality gates',
    expectedSymbols: ['buildVerificationPlan', 'buildVerificationCommands'],
    expectedEditFiles: ['src/features/verification/runtime.ts'],
    expectedTestFiles: ['__tests__/verification-feature.test.ts'],
  },
  {
    id: 'self-absent-mobile-push',
    task: 'Change mobile push-notification APNS retry backoff and delivery receipts',
    expectedSymbols: [],
    expectedEditFiles: [],
    expectedTestFiles: [],
    shouldAbstain: true,
  },
].map((testCase) => PatchTaskCaseSchema.parse(testCase));
