#!/usr/bin/env node

import { runWithPostgresTestEnv } from './with-postgres-test-env.mjs';

const status = await runWithPostgresTestEnv('bun', [
  'test',
  '--timeout',
  '30000',
  '__tests__/postgres-database.test.ts',
  '__tests__/storage-backend-parity.test.ts',
  '__tests__/postgres-clear-structural.test.ts',
]);

process.exit(status);
