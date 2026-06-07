#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

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
