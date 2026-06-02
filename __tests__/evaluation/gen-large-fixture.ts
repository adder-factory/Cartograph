#!/usr/bin/env tsx
/**
 * Synthesise + index a 1000-file TypeScript fixture for the B7
 * large-scale eval cases. Idempotent: skips generation when the
 * fixture exists. Re-run with `--force` to regenerate.
 *
 * Each file `mod-N.ts` exports:
 *   - `funcN()` — calls 2-3 peers from neighbouring files
 *   - `ClassN` with one method `methodN()`
 *   - `IfaceN` (consumed via type-of edges from the function signature)
 *
 * Cross-file calls give the graph realistic edge density without
 * blowing up the synthesis cost (uniform call patterns aren't
 * representative of real codebases but they're enough to stress-
 * test the ranking + traversal pipelines).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Cartograph } from '../../src/index.js';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'large');
const FILE_COUNT = 1000;
const PEERS_PER_FUNC = 3;

function generateFile(i: number): string {
  // Each function calls 3 peers picked deterministically from the
  // remainder of the corpus. Wrap-around with `% FILE_COUNT` so
  // index 998 calls 1, 4, 7 (not negative offsets).
  const peers: number[] = [];
  for (let p = 1; p <= PEERS_PER_FUNC; p++) {
    peers.push((i + p * 37) % FILE_COUNT); // 37 = arbitrary stride for spread
  }
  const peerImports = peers.map((j) => `import { func${j} } from './mod-${j}.js';`).join('\n');
  const peerCalls = peers.map((j) => `func${j}()`).join(' + ');
  return `${peerImports}

export interface Iface${i} { value: number; }

export function func${i}(): number {
  return ${peerCalls};
}

export class Class${i} {
  method${i}(): number { return func${i}(); }
}
`;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const dbPath = path.join(FIXTURE_DIR, '.cartograph', 'cartograph.db');
  if (fs.existsSync(dbPath) && !force) {
    console.log(`Fixture exists at ${FIXTURE_DIR} (use --force to regenerate).`);
    return;
  }
  if (force && fs.existsSync(FIXTURE_DIR)) {
    console.log(`Removing existing fixture (--force) ...`);
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }

  console.log(`Generating ${FILE_COUNT} TypeScript files at ${FIXTURE_DIR} ...`);
  const srcDir = path.join(FIXTURE_DIR, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) {
    fs.writeFileSync(path.join(srcDir, `mod-${i}.ts`), generateFile(i));
  }

  console.log(`Indexing ${FIXTURE_DIR} ...`);
  const t0 = Date.now();
  const cg = await Cartograph.init(FIXTURE_DIR, { index: true });
  const stats = cg.stats.getStats();
  cg.close();
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done. Files=${stats.fileCount} Nodes=${stats.nodeCount} Edges=${stats.edgeCount} (indexed in ${dur}s).`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
