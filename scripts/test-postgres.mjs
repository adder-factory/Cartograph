#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

if (!process.env.CARTOGRAPH_TEST_POSTGRES_URL && process.env.CARTOGRAPH_TEST_POSTGRES_OPTIONAL !== '1') {
  console.error(
    'test-postgres: CARTOGRAPH_TEST_POSTGRES_URL is required. Set CARTOGRAPH_TEST_POSTGRES_OPTIONAL=1 to allow a skip.',
  );
  process.exit(1);
}

const result = spawnSync(
  'bun',
  ['test', '--timeout', '30000', '__tests__/postgres-database.test.ts', '__tests__/storage-backend-parity.test.ts'],
  {
    env: process.env,
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
