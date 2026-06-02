/**
 * G20 probe — measures bun:sqlite + sqlite-vec init cost under
 * concurrent worker_threads spawns. Tests the "connection-init mutex"
 * theory from the 2026-05-24 value-ref-edges partial-data rabbit hole.
 *
 * Hypothesis: with N workers all racing through `createDatabase` +
 * `loadExtension('sqlite-vec')` simultaneously, libsqlite3's
 * process-level init / dlopen mutex serializes the opens, and 2 of N
 * workers consistently end up at the tail of the queue. If the
 * per-worker `dbOpenMs` grows roughly linearly with N (or the tail
 * workers' times are 10× the median), contention is confirmed.
 *
 * If the per-worker init time is flat regardless of N, the theory is
 * WRONG and we need a deeper diagnostic before committing to a
 * persistent-worker-pool refactor.
 *
 * Run with: bun bench/probe-worker-db-init.mts
 *   PROBE_DB_PATH=/path/to/real/cartograph.db bun bench/probe-worker-db-init.mts
 *
 * Defaults to a fresh empty bun:sqlite DB in tmpdir if PROBE_DB_PATH
 * unset. A real .cartograph/cartograph.db will exercise the actual schema
 * (vec0 virtual tables, FTS5 tables) but the init cost is dominated by
 * the libsqlite3/sqlite-vec load itself — schema cost should be small.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

interface ProbeReply {
  workerId: number;
  importsMs: number;
  dbOpenMs: number;
  vecLoaded: boolean;
  totalMs: number;
}

const dbPath =
  process.env['PROBE_DB_PATH'] ??
  (() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'g20-probe-'));
    const p = path.join(dir, 'probe.db');
    writeFileSync(p, ''); // empty file; bun:sqlite will populate
    return p;
  })();

const workerPath = fileURLToPath(new URL('./probe-worker-db-init-worker.ts', import.meta.url));

async function runRound(n: number): Promise<ProbeReply[]> {
  const replies: ProbeReply[] = [];
  const promises: Promise<ProbeReply>[] = [];
  for (let i = 0; i < n; i++) {
    promises.push(
      new Promise<ProbeReply>((resolve, reject) => {
        const w = new Worker(workerPath, {
          workerData: { dbPath, workerId: i },
        });
        w.once('message', (m: ProbeReply) => resolve(m));
        w.once('error', (e) => reject(e));
        w.once('exit', (code) => {
          if (code !== 0) reject(new Error(`worker ${i} exited with code ${code}`));
        });
      }),
    );
  }
  for (const p of promises) replies.push(await p);
  return replies;
}

function summarise(label: string, replies: ProbeReply[]): void {
  const importsMs = replies.map((r) => r.importsMs).sort((a, b) => a - b);
  const dbOpenMs = replies.map((r) => r.dbOpenMs).sort((a, b) => a - b);
  const totalMs = replies.map((r) => r.totalMs).sort((a, b) => a - b);
  const median = (arr: number[]): number => arr[Math.floor(arr.length / 2)] ?? 0;
  const min = (arr: number[]): number => arr[0] ?? 0;
  const max = (arr: number[]): number => arr.at(-1) ?? 0;
  console.log(`\n[${label}] N=${replies.length}`);
  console.log(`  imports ms  min=${min(importsMs)}  median=${median(importsMs)}  max=${max(importsMs)}`);
  console.log(`  db-open ms  min=${min(dbOpenMs)}  median=${median(dbOpenMs)}  max=${max(dbOpenMs)}`);
  console.log(`  total   ms  min=${min(totalMs)}  median=${median(totalMs)}  max=${max(totalMs)}`);
  console.log(`  vec loaded:  ${replies.filter((r) => r.vecLoaded).length} / ${replies.length}`);
  console.log(`  per-worker total ms (sorted): ${totalMs.join(' ')}`);
}

async function main(): Promise<void> {
  console.log(`G20 probe — dbPath=${dbPath}`);
  console.log('Hypothesis: per-worker init cost grows with N if init-mutex contention is real.');
  for (const n of [1, 2, 4, 8]) {
    const replies = await runRound(n);
    summarise(`N=${n}`, replies);
  }
}

await main();
